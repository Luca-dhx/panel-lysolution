// ADAPTATEURS HOSTINGER — où l'appartenance est réellement vérifiée (L9).
//
// docs/architecture/HOSTINGER_CONTROL_PLANE.md §« Adaptateurs ».
//
// ── L'ORDRE DE CHAQUE ADAPTATEUR ────────────────────────────────────────────
//
//   1. prouver l'appartenance du nom d'hôte  → refus AVANT tout appel réseau
//   2. résoudre la zone
//   3. appeler Hostinger
//   4. réduire la réponse à ce que le demandeur a le droit de savoir
//
// L'étape 1 d'abord, toujours : un refus d'appartenance ne doit consommer ni
// quota fournisseur, ni temps de réponse, et surtout ne rien révéler. Un
// attaquant qui mesurerait la latence de son refus apprendrait si le domaine
// existe au portefeuille — et c'est déjà trop.
//
// ── CE QUI NE SORT JAMAIS ───────────────────────────────────────────────────
//
// Le portefeuille du compte. Il liste les domaines de TOUS les clients ; il
// sert ici à savoir si une zone est gérée, et cette réponse-là se réduit à un
// booléen déguisé en `source: 'managed' | 'psl'`.
import { findBestManagedZone, relativeName, resolveZone } from '../../../deployment-engine/dns/zoneResolver.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
} from '../../capabilities/capabilityErrors.js';
import {
  OWNERSHIP_CODES,
  describeHostnameOwnership,
  filterRecordsForProject,
} from '../../capabilities/resourceOwnership.js';
import {
  listDomains,
  listZoneRecords,
  upsertZoneRecord,
  HostingerTransportError,
  TRANSPORT_CODES,
  OUTCOMES,
} from './hostingerTransport.js';

/* -------------------------------------------------------------------------- */
/*  REFUS                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Refus d'appartenance.
 *
 * Le message NOMME l'hôte demandé — que le demandeur connaît déjà — et jamais
 * ceux qu'il ne possède pas. Lui répondre « vous possédez a.example.com » lui
 * apprendrait le parc d'un autre.
 *
 * ── LE CODE A ÉTÉ CORRIGÉ EN MÊME TEMPS QUE LES OCTROIS ONT DISPARU ─────────
 *
 * Ce refus rendait `CAPABILITY_NOT_GRANTED`, ce qui était déjà faux avant la
 * simplification : il ne parlait pas du droit d'invoquer `dns.record.ensure` —
 * le projet l'avait — mais de l'appartenance du NOM D'HÔTE visé. Un opérateur
 * lisant ce code partait chercher une case à cocher qui ne manquait pas.
 *
 * `RESOURCE_NOT_OWNED` dit ce qui se passe réellement. Même statut HTTP (403)
 * et même issue journalisée (`BLOCKED`) : la correction porte sur le
 * diagnostic, pas sur la décision.
 */
function ownershipRefusal(verdict, capability) {
  const message = verdict.code === OWNERSHIP_CODES.NO_DESTINATION
    ? `Refusé : aucune destination active n’est enregistrée pour ce projet, donc aucun nom ne lui appartient.`
    : verdict.code === OWNERSHIP_CODES.INVALID_HOSTNAME
      ? 'Refusé : nom d’hôte inexploitable.'
      : `Refusé : « ${verdict.hostname} » ne relève pas de ce projet.`;
  return new CapabilityError(CAPABILITY_ERROR_CODES.RESOURCE_NOT_OWNED, message, {
    capability: capability.code,
    reason: verdict.code,
  });
}

/**
 * Traduit un refus de transport en refus de passerelle.
 *
 * `TIMEOUT` ne devient PAS `PROVIDER_UNAVAILABLE` : sur une écriture DNS, le
 * silence laisse l'enregistrement dans un état indécidable, et un appelant qui
 * rejoue peut écraser une correction humaine survenue entre-temps.
 */
export function translateTransportError(error, capability, operation = null) {
  if (!(error instanceof HostingerTransportError)) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `L’exécution de « ${capability.code} »${operation ? ` (${operation})` : ''} a échoué chez le fournisseur.`,
    );
  }
  if (error.code === TRANSPORT_CODES.TIMEOUT || error.outcome === OUTCOMES.UNKNOWN) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Le fournisseur n’a pas répondu pour « ${capability.code} » : l’issue est indéterminée.`,
      { httpStatus: error.httpStatus ?? null, correlationId: error.correlationId ?? null, replaySafe: false },
    );
  }
  if (error.code === TRANSPORT_CODES.MISSING_CREDENTIALS) {
    return new CapabilityError(CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING, 'Identifiants Hostinger incomplets.');
  }
  if (error.code === TRANSPORT_CODES.INPUT_INVALID) {
    return new CapabilityError(CAPABILITY_ERROR_CODES.INPUT_INVALID, `Entrée refusée par l’adaptateur de « ${capability.code} ».`);
  }
  return new CapabilityError(
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    `Le fournisseur a refusé « ${capability.code} ».`,
    { httpStatus: error.httpStatus ?? null, correlationId: error.correlationId ?? null },
  );
}

/**
 * CHAQUE ADAPTATEUR TRADUIT SES PROPRES ERREURS — et c'est structurel.
 *
 * La passerelle générique (L3) possède bien un traducteur, mais il ne connaît
 * que les erreurs de Brevo : une `HostingerTransportError` y tomberait dans la
 * branche « erreur non typée » et ressortirait en `PROVIDER_UNAVAILABLE`,
 * c'est-à-dire en « rien ne s'est passé ». Sur une écriture DNS interrompue,
 * c'est faux — et c'est exactement l'affirmation qui pousse à rejouer.
 *
 * La connaissance d'un fournisseur reste donc chez son adaptateur. Le
 * traducteur générique demeure un filet pour l'inattendu, pas une autorité.
 */
function guard(operation) {
  return async (fn, definition) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CapabilityError) throw err;
      throw translateTransportError(err, definition, operation);
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION DE ZONE                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Quelle zone gère cet hôte ?
 *
 * On croise le portefeuille du compte avec la liste publique des suffixes
 * (PSL) en repli. Le repli compte : un domaine peut être servi par le compte
 * sans figurer au portefeuille (délégation, transfert en cours), et refuser
 * dans ce cas bloquerait un déploiement légitime. `source` dit lequel des deux
 * a tranché — c'est une information de diagnostic, pas un secret.
 */
async function resolveZoneFor(hostname, { credentials, definition, fetchImpl }) {
  const portfolio = await listDomains({ credentials, timeoutMs: definition.timeoutMs, fetchImpl });
  const managed = findBestManagedZone(hostname, portfolio.domains);
  if (managed) return { zone: managed.zone, relativeName: managed.relativeName, source: 'managed' };
  const psl = resolveZone(hostname);
  return { zone: psl.zone, relativeName: psl.relativeName, source: 'psl' };
}

/* -------------------------------------------------------------------------- */
/*  ADAPTATEURS                                                               */
/* -------------------------------------------------------------------------- */

/** `dns.zone.resolve` — LECTURE. Rend la zone, jamais le portefeuille. */
async function dnsZoneResolve({ definition, context, credentials, input, fetchImpl }) {
  const verdict = await describeHostnameOwnership(context.projectId, input.hostname);
  if (!verdict.allowed) throw ownershipRefusal(verdict, definition);

  const zone = await guard('zone')(
    () => resolveZoneFor(verdict.hostname, { credentials, definition, fetchImpl }),
    definition,
  );
  return {
    hostname: verdict.hostname,
    zone: zone.zone,
    relativeName: zone.relativeName,
    source: zone.source,
  };
}

/** `dns.records.read` — LECTURE, réduite aux hôtes du demandeur. */
async function dnsRecordsRead({ definition, context, credentials, input, fetchImpl }) {
  const verdict = await describeHostnameOwnership(context.projectId, input.hostname);
  if (!verdict.allowed) throw ownershipRefusal(verdict, definition);

  const run = guard('read');
  const zone = await run(() => resolveZoneFor(verdict.hostname, { credentials, definition, fetchImpl }), definition);
  const read = await run(
    () => listZoneRecords({ credentials, zone: zone.zone, timeoutMs: definition.timeoutMs, fetchImpl }),
    definition,
  );

  return {
    zone: zone.zone,
    records: filterRecordsForProject(read.records, zone.zone, verdict.ownedHosts),
  };
}

/**
 * `dns.record.ensure` — LA SEULE ÉCRITURE.
 *
 * ── CE QU'ELLE NE FAIT PAS ──────────────────────────────────────────────────
 *
 * Elle ne planifie pas, ne compare pas, ne décide pas s'il fallait écrire.
 * C'est une PRIMITIVE : le moteur de déploiement reste l'autorité de
 * l'orchestration (§« Frontière »). Lui déléguer la décision créerait un second
 * chemin de déploiement, avec sa propre idée de ce qu'est un conflit.
 *
 * Elle n'envoie qu'UN enregistrement : la portée de l'`overwrite` d'Hostinger
 * se limite aux couples (nom, type) transmis, et envoyer la zone entière
 * effacerait tout ce qu'on n'aurait pas relu.
 */
async function dnsRecordEnsure({ definition, context, credentials, input, fetchImpl }) {
  const verdict = await describeHostnameOwnership(context.projectId, input.hostname);
  if (!verdict.allowed) throw ownershipRefusal(verdict, definition);

  const run = guard('ensure');
  const zone = await run(() => resolveZoneFor(verdict.hostname, { credentials, definition, fetchImpl }), definition);

  /**
   * DERNIER GARDE-FOU, APRÈS la résolution de zone.
   *
   * L'appartenance a été prouvée sur le nom d'hôte ; on vérifie ici que le nom
   * RELATIF calculé retombe bien dans la zone résolue. Sans ce contrôle, un
   * hôte dont la zone serait mal déduite écrirait à la racine d'un domaine
   * qu'il ne possède pas — le pire résultat possible d'une erreur de calcul.
   */
  const name = relativeName(verdict.hostname, zone.zone);
  if (!name) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `Nom relatif indéterminable pour « ${verdict.hostname} » dans « ${zone.zone} ».`,
    );
  }

  const written = await run(() => upsertZoneRecord({
    credentials,
    zone: zone.zone,
    name,
    type: input.type,
    content: input.content,
    ttl: input.ttl,
    timeoutMs: definition.timeoutMs,
    fetchImpl,
  }), definition);

  return {
    hostname: verdict.hostname,
    zone: zone.zone,
    name,
    type: input.type,
    written: written.outcome === OUTCOMES.DONE,
    correlationId: written.correlationId ?? null,
  };
}

/**
 * Table capacité → exécutant. Fermée.
 *
 * Destinée à être fusionnée dans `providerAdapters.ADAPTERS` par le câblage
 * décrit au §« Câblage » du document — comme le catalogue de capacités l'est
 * dans le registre.
 */
export const HOSTINGER_ADAPTERS = Object.freeze({
  'dns.zone.resolve': dnsZoneResolve,
  'dns.records.read': dnsRecordsRead,
  'dns.record.ensure': dnsRecordEnsure,
});

export default { HOSTINGER_ADAPTERS, translateTransportError };
