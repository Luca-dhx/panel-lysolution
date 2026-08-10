// OCTROIS — quel projet a le droit de demander quoi (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Octrois ».
//
// ── CE QUI CHANGE PAR RAPPORT À L'ANCIEN MODÈLE ─────────────────────────────
//
//   AVANT   projet  →  accès à des CLÉS de fournisseur   (PanelIntegratedApi.grants[])
//   APRÈS   projet  →  droit d'invoquer une CAPACITÉ      (PanelProject.capabilityGrants[])
//
// La différence n'est pas de vocabulaire. Un octroi de clé donne un pouvoir
// illimité sur un fournisseur : qui détient la clé Stripe peut rembourser,
// facturer, lire tous les clients. Un octroi de capacité donne un verbe, et
// rien d'autre. C'est la seule granularité qui permette d'accorder « lister les
// factures » sans accorder « rembourser ».
//
// ── UN SEUL SYSTÈME, PAS DEUX ───────────────────────────────────────────────
//
// `PanelIntegratedApi.grants[]` n'est PAS lu ici, pas même en repli. Deux
// autorisations dont l'une est plus permissive sont interrogées, un jour, dans
// le mauvais ordre — et c'est toujours la permissive qui gagne. L'ancien
// tableau reste en base parce que l'effacer détruirait une saisie manuelle
// pour un gain nul, mais il ne gouverne plus rien.
//
// ── FERMÉ PAR DÉFAUT ────────────────────────────────────────────────────────
//
// Un projet fraîchement appairé n'a AUCUN octroi. C'est délibéré : le bon
// défaut d'une autorisation est le refus, et un opérateur qui doit accorder
// explicitement sait ce qu'il accorde.
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import registryStore from '../registry/registryStore.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import { isKnownCapability, describeCapability, listCapabilityDefinitions } from './capabilityRegistry.js';
import { capabilityNotGranted } from './capabilityErrors.js';

/** Les codes accordés à un projet, dédoublonnés et ordonnés. */
export function grantedCodes(panelProject) {
  const stored = Array.isArray(panelProject?.capabilityGrants) ? panelProject.capabilityGrants : [];
  return [...new Set(stored.map(String))].sort();
}

/** Ce projet peut-il invoquer cette capacité ? */
export function isGranted(panelProject, code) {
  return grantedCodes(panelProject).includes(String(code));
}

/**
 * Refuse si l'octroi manque. Le message NOMME le projet et la capacité : c'est
 * une erreur de configuration, et l'opérateur doit savoir quoi accorder sans
 * relire un journal.
 */
export function assertGranted(context, capability) {
  if (!isGranted(context.panelProject, capability.code)) {
    throw capabilityNotGranted(capability.code, context.projectId);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  ADMINISTRATION                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Remplace la liste des octrois d'un projet.
 *
 * Remplacement et non fusion : une liste d'autorisations doit se lire d'un coup
 * d'œil à l'écran qui l'édite. Un `add`/`remove` incrémental oblige à
 * reconstruire mentalement l'état courant avant d'agir — c'est ainsi qu'on
 * laisse un droit en place sans s'en apercevoir.
 *
 * Chaque code est validé contre le registre CODE-FIRST : une capacité inconnue
 * ne peut pas être stockée, donc l'écran ne peut pas afficher un octroi qui ne
 * correspond à rien.
 */
export async function setCapabilityGrants(projectId, codes, actor = {}) {
  const record = await registryStore.getById(projectId);
  if (!record) {
    throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', `Projet inconnu : ${projectId}.`);
  }

  const requested = Array.isArray(codes) ? [...new Set(codes.map((c) => String(c).trim()))] : null;
  if (requested === null) {
    throw ApiError.badRequest(
      'PANEL_CAPABILITY_GRANTS_INVALID',
      'Le corps doit porter un tableau « capabilities ».',
    );
  }

  const unknown = requested.filter((code) => !isKnownCapability(code));
  if (unknown.length > 0) {
    throw ApiError.badRequest(
      'PANEL_CAPABILITY_UNKNOWN',
      `Capacité(s) inconnue(s) : ${unknown.join(', ')}. Le registre est code-first.`,
      { unknown },
    );
  }

  const before = grantedCodes(record);
  record.capabilityGrants = requested.sort();
  await registryStore.save(record);

  const added = requested.filter((c) => !before.includes(c));
  const removed = before.filter((c) => !requested.includes(c));

  // On NOMME les capacités, jamais un fournisseur ni une clé : un octroi est
  // une décision d'autorisation, et son journal doit se lire tel quel.
  logger.info(
    `[capabilities] octrois de ${projectId} : ${requested.length} accordée(s)`
    + `${added.length ? ` [+${added.join(', ')}]` : ''}`
    + `${removed.length ? ` [-${removed.join(', ')}]` : ''}.`,
  );

  await recordEvent({
    projectId,
    type: EVENT_TYPES.CAPABILITY_GRANTS_UPDATED,
    source: 'PANEL',
    summary: `Capacités accordées mises à jour — ${requested.length} au total`
      + `${added.length ? `, ${added.length} ajoutée(s)` : ''}`
      + `${removed.length ? `, ${removed.length} retirée(s)` : ''}.`,
    data: { granted: requested, added, removed, actor: actor.userId ?? null },
  }).catch(() => {});

  return describeGrants(record);
}

/**
 * Vue d'administration : TOUTES les capacités, avec leur état d'octroi.
 *
 * On rend le catalogue complet plutôt que les seuls octrois : un écran qui
 * n'affiche que ce qui est accordé ne permet pas d'accorder le reste, et
 * oblige à connaître les codes par cœur.
 */
export function describeGrants(panelProject) {
  const granted = grantedCodes(panelProject);
  return {
    projectId: panelProject.projectId,
    granted,
    capabilities: listCapabilityDefinitions().map((capability) => ({
      ...describeCapability(capability.code),
      granted: granted.includes(capability.code),
      /**
       * Accordée mais pas encore servie : l'écran doit le dire, sinon un
       * opérateur croira avoir ouvert un chemin qui refusera quand même.
       */
      effective: granted.includes(capability.code) && capability.migrated,
    })),
  };
}

/** Les octrois d'un projet, chargés depuis le registre. */
export async function getCapabilityGrants(projectId) {
  const record = await registryStore.getById(projectId);
  if (!record) {
    throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', `Projet inconnu : ${projectId}.`);
  }
  return describeGrants(record);
}

export default {
  grantedCodes,
  isGranted,
  assertGranted,
  setCapabilityGrants,
  getCapabilityGrants,
  describeGrants,
};
