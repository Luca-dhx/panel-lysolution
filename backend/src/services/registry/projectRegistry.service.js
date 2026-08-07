// Le registre des projets — docs/architecture/02_PROJECT_REGISTRY.md.
// Catégorie 3 : cette donnée n'existe que dans le Panel et ne transite jamais
// vers un projet.
import config from '../../config/env.js';
import { deriveLiveness, LIVENESS, secondsSinceLastHeartbeat } from '../supervision/liveness.service.js';
import { buildProjectHealth } from '../supervision/health.service.js';
import { newBridgeId, nowIso } from '../../bridge/bridgeContract.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import registryStore from './registryStore.js';
import { issuePairingCode } from '../pairing/pairing.service.js';
import { validateManifest } from '../manifest/manifest.schema.js';
import { interpretCapabilities } from '../manifest/capabilities.service.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import { currentGeneration, generationsDiverge } from '../sync/projectGeneration.js';
import {
  generateProjectKey,
  normalizeBackendUrl,
  resolveProjectName,
  slugify,
} from './projectIdentity.js';

// La vivacité et la santé vivent dans les services de supervision : le
// registre les EXPOSE, il ne les recalcule pas (une seule implémentation).
export { LIVENESS, deriveLiveness };

function assertValidManifestOrThrow(manifestInput) {
  const validation = validateManifest(manifestInput);
  if (!validation.valid) {
    throw ApiError.badRequest(
      'PANEL_MANIFEST_INVALID',
      'Manifest non conforme au Manager Standard.',
      validation.errors,
    );
  }
  return validation;
}

/**
 * LE refus de doublon — un seul fait, donc un seul message.
 *
 * Même adresse, même clé dérivée, même identité annoncée, ou collision d'index
 * entre deux requêtes simultanées : ce sont cinq chemins vers la même
 * situation. Cinq messages différents feraient croire à cinq problèmes.
 */
/** `TEST` / `PROD`, ou `null` — jamais une valeur d'ambiance. */
export function normalizeEnvironment(valeur) {
  const brut = String(valeur ?? '').trim().toUpperCase();
  return brut === 'TEST' || brut === 'PROD' ? brut : null;
}

/**
 * L'ENVIRONNEMENT D'UNE FICHE — le CONSTAT d'abord, l'intention à défaut.
 *
 * Le projet est l'autorité de son propre environnement : ce qu'il annonce au
 * battement prime toujours. `declaredEnvironment` ne sert qu'avant le premier
 * contact — sans quoi une fiche tout juste déclarée n'aurait aucun
 * environnement, et deux instances d'un même projet seraient indiscernables
 * jusqu'à leur premier battement.
 */
export function declaredEnvironmentOf(record) {
  return normalizeEnvironment(record?.runtime?.environment)
    ?? normalizeEnvironment(record?.declaredEnvironment);
}

/** Les autres instances du MÊME projet logique — jamais la fiche elle-même. */
export async function listSiblings(logicalProjectKey, exceptProjectId = null) {
  const cle = String(logicalProjectKey ?? '').trim();
  if (!cle) return [];
  const toutes = await registryStore.list();
  return toutes.filter(
    (r) => r.logicalProjectKey === cle && r.projectId !== exceptProjectId,
  );
}

function dejaDeclare(existant) {
  return ApiError.conflict(
    'PANEL_PROJECT_ALREADY_DECLARED',
    'Ce projet est déjà déclaré dans le Panel.',
    { projectId: existant?.projectId ?? null, projectName: existant?.projectName ?? null },
  );
}

/**
 * DÉCLARE un projet dans le registre.
 *
 * La CLÉ N'EST PAS UN PARAMÈTRE : elle est générée ici, jamais reçue. Le
 * frontend n'a donc aucun moyen de décider d'un identifiant, et l'utilisateur
 * n'a plus rien à deviner. Voir projectIdentity.js pour l'ordre de préférence.
 *
 * @param {object}  input
 * @param {string}  input.publicBackendUrl  Adresse du projet — la seule saisie obligatoire.
 * @param {string} [input.projectName]      Nom lisible ; à défaut, celui que le projet s'est donné.
 * @param {object} [input.bridgeIdentity]   Identité annoncée au ping (contrat >= 1.4.0).
 * @param {object} [input.manifest]         Manifest de secours (projets sans transport de Manifest).
 */
export async function declareProject({
  publicBackendUrl,
  projectName = null,
  bridgeIdentity = null,
  manifest = null,
  /**
   * ENVIRONNEMENT VISÉ par cette instance — `TEST` ou `PROD`.
   *
   * ── POURQUOI IL FAUT LE DIRE À LA DÉCLARATION ─────────────────────────────
   * Une fiche est une INSTANCE. Deux instances d'un même projet client — sa
   * recette et sa production — sont deux fiches, et rien ne permettait de les
   * déclarer toutes les deux : la seconde annonçant la même clé de pont était
   * refusée comme doublon. Le Panel ne pouvait donc PAS enregistrer un projet
   * en TEST et en PROD, et l'écran n'avait rien à regrouper.
   *
   * `runtime.environment` ne peut pas servir ici : il n'est renseigné qu'au
   * PREMIER BATTEMENT, c'est-à-dire longtemps après. On déclare donc
   * l'intention ; le battement la confirmera ou la corrigera.
   *
   * `null` reste le comportement d'avant : une fiche sans environnement
   * déclaré, seule de son groupe.
   */
  environment = null,
} = {}) {
  const normalizedUrl = normalizeBackendUrl(publicBackendUrl);
  if (!normalizedUrl) {
    throw ApiError.badRequest(
      'PANEL_PROJECT_URL_INVALID',
      'URL du backend invalide : une adresse http(s) est requise.',
    );
  }

  const generated = generateProjectKey({
    bridgeIdentity,
    projectName,
    publicBackendUrl: normalizedUrl,
  });
  if (!generated) {
    throw ApiError.badRequest(
      'PANEL_PROJECT_KEY_UNRESOLVABLE',
      'Impossible de dériver une clé technique : donnez un nom de projet.',
    );
  }

  const resolvedName = resolveProjectName({ bridgeIdentity, projectName, publicBackendUrl: normalizedUrl });
  if (!resolvedName) {
    throw ApiError.badRequest('PANEL_PROJECT_NAME_REQUIRED', 'projectName est requis.');
  }

  /**
   * L'IDENTITÉ LOGIQUE — la clé que le PROJET annonce, telle quelle.
   *
   * Elle n'est ni saisie, ni devinée : c'est la valeur que le pont transporte
   * (>= 1.4.0), la même que le Panel tient déjà pour la plus autoritaire. Deux
   * instances d'un même projet la produisent identique, puisque le déploiement
   * embarque le `.env` du projet verbatim. Sans annonce, pas d'identité
   * logique — et la fiche reste seule de son groupe, comme avant.
   */
  const logicalProjectKey = slugify(bridgeIdentity?.projectKey) || null;
  const env = normalizeEnvironment(environment);

  /**
   * ── ANTI-DOUBLONS, DÉSORMAIS PAR INSTANCE ────────────────────────────────
   *
   * Une même ADRESSE ne peut entrer qu'une fois : deux fiches pointant le même
   * backend décriraient la même instance deux fois. Cela ne change pas.
   *
   * En revanche, la même IDENTITÉ LOGIQUE dans un AUTRE environnement n'est
   * pas un doublon : c'est la recette et la production du même projet. Les
   * refuser — ce que faisait la comparaison de clé annoncée — rendait
   * simplement impossible d'enregistrer un projet en TEST et en PROD.
   *
   * Ce qui reste interdit, et le sera explicitement : DEUX fiches du même
   * projet logique dans le MÊME environnement. Un projet n'a qu'une recette.
   */
  const surLaMemeAdresse = await registryStore.getByBackendUrl(normalizedUrl);
  if (surLaMemeAdresse) throw dejaDeclare(surLaMemeAdresse);

  /**
   * UN PROJET N'A QU'UNE RECETTE ET QU'UNE PRODUCTION.
   *
   * C'est l'invariant métier que remplace l'ancien refus « même clé annoncée ».
   * Le message nomme l'instance fautive : « déjà déclaré » sans dire laquelle
   * obligeait à parcourir le parc pour comprendre.
   */
  /**
   * RATTACHEMENT DES FICHES ANTÉRIEURES — sans les toucher autrement.
   *
   * ══ LE CAS RÉEL ══════════════════════════════════════════════════════════
   * SB Auto TEST existe depuis avant l'identité logique : son champ vaut
   * `null`. On déclare sa production, qui annonce la clé `K`. Sans ce
   * rattachement, la recette resterait éternellement seule de sa carte, et il
   * faudrait la RÉAPPAIRER pour la rejoindre — c'est-à-dire lui faire perdre
   * son jeton pour un problème d'affichage.
   *
   * ══ CE QUI PERMET DE RATTACHER, ET RIEN D'AUTRE ══════════════════════════
   * La clé TECHNIQUE de la fiche antérieure vaut `K`. Ce n'est pas une
   * ressemblance : c'est la valeur que le projet lui-même a annoncée à son
   * appairage et que le Panel a adoptée (`projectKeySource` BRIDGE_KEY ou
   * RECONCILED). Deux instances d'un même projet annoncent la même.
   *
   * Toute autre provenance — un nom, un domaine, un slug dérivé — est écartée :
   * `NAME` et `URL` sont des dérivations locales, et deux projets voisins
   * peuvent les produire identiques. Fail closed : deux cartes séparées valent
   * mieux qu'un faux regroupement.
   *
   * ══ CE QUE CE RATTACHEMENT NE FAIT PAS ═══════════════════════════════════
   * Il écrit UN champ. Ni jeton, ni appairage, ni environnement, ni
   * destination, ni projection, ni génération. La fiche rattachée continue
   * exactement sa vie.
   */
  let soeurs = logicalProjectKey ? await listSiblings(logicalProjectKey) : [];

  if (logicalProjectKey) {
    const PROVENANCES_FIABLES = new Set(['BRIDGE_KEY', 'RECONCILED']);
    const aRattacher = (await registryStore.list()).filter(
      (r) => !r.logicalProjectKey
        && r.projectKey === logicalProjectKey
        && PROVENANCES_FIABLES.has(r.projectKeySource),
    );
    for (const ancienne of aRattacher) {
      ancienne.logicalProjectKey = logicalProjectKey;
      ancienne.updatedAt = nowIso();
      await registryStore.save(ancienne);
      logger.info(
        `Fiche « ${ancienne.projectKey} » rattachée au projet logique « ${logicalProjectKey} » : `
        + 'son appairage, ses projections et ses destinations sont inchangés.',
      );
      soeurs = [...soeurs, ancienne];
    }
  }

  const collision = logicalProjectKey
    ? soeurs.find((s) => declaredEnvironmentOf(s) === env)
    : null;
  if (collision) {
    /**
     * SANS ENVIRONNEMENT DÉCLARÉ, RIEN N'A CHANGÉ.
     *
     * Deux fiches du même projet dont aucune ne dit à quoi elle sert restent
     * ce qu'elles ont toujours été : un doublon. Le message et le code le
     * disent comme avant — la nouveauté ne s'applique qu'à qui déclare son
     * environnement, c'est-à-dire à qui sait ce qu'il fait.
     */
    if (!env) throw dejaDeclare(collision);

    throw ApiError.conflict(
      'PANEL_PROJECT_ENVIRONMENT_ALREADY_DECLARED',
      `Ce projet a déjà une instance ${env} dans le Panel.`,
      {
        projectId: collision.projectId,
        projectName: collision.projectName,
        environment: env,
        logicalProjectKey,
      },
    );
  }

  /**
   * LA CLÉ TECHNIQUE RESTE UNIQUE PAR FICHE — et le reste sans arbitrage.
   *
   * Deux instances d'un même projet annoncent la MÊME clé : c'est justement ce
   * qui les regroupe. Mais `projectKey` identifie une FICHE et son index est
   * unique. On la qualifie donc par l'environnement — `sb-auto-06-prod` — ce
   * qui reste déterministe : mêmes entrées, même clé, un double clic reste
   * inoffensif. L'identité logique, elle, demeure identique de part et d'autre.
   */
  let projectKey = generated.projectKey;
  if (await registryStore.getByKey(projectKey)) {
    const qualifiee = env ? `${projectKey}-${env.toLowerCase()}` : null;
    const libre = qualifiee && !(await registryStore.getByKey(qualifiee));
    if (!libre) throw dejaDeclare(await registryStore.getByKey(projectKey));
    projectKey = qualifiee;
  }

  let validatedManifest = null;
  if (manifest !== null && manifest !== undefined) {
    validatedManifest = assertValidManifestOrThrow(manifest).manifest;
  }

  const now = nowIso();
  const manifestSource = validatedManifest ? 'MANUAL' : null;
  const record = {
    projectId: newBridgeId(),
    projectKey,
    projectKeySource: generated.source,
    logicalProjectKey,
    projectName: resolvedName,
    /**
     * L'ENVIRONNEMENT DÉCLARÉ — l'intention, distincte du constat.
     *
     * `runtime.environment` reste ce que le projet AFFIRME à chaque battement,
     * et lui seul entre dans la génération. Celui-ci dit ce que la fiche est
     * censée être, avant le premier contact. Les confondre reviendrait à
     * décider de l'environnement d'un projet depuis le Panel, ce qu'il ne fait
     * pas.
     */
    declaredEnvironment: env,
    createdAt: now,
    updatedAt: now,
    pairing: {
      status: 'DECLARED',
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
      bridgeTokenHash: null,
      bridgeTokenEncrypted: null,
      pairedAt: null,
      revokedAt: null,
    },
    runtime: {
      environment: null,
      softwareVersion: null,
      // Ce que la sonde a constaté : l'adresse est connue DÈS la déclaration
      // (c'est elle qu'on a saisie), plus seulement après l'appairage. C'est
      // ce qui rend la détection de doublons possible avant tout appairage.
      contractVersion: null,
      publicBackendUrl: normalizedUrl,
      lastHeartbeatAt: null,
      lastHealth: null,
      bridgeStats: null,
    },
    manifest: validatedManifest,
    manifestSource,
  };

  // ── LA COURSE ────────────────────────────────────────────────────────────
  // La relecture ci-dessus ne protège que d'un doublon DÉJÀ écrit : lire puis
  // écrire, ce sont deux temps. Deux requêtes lancées ensemble — un double
  // clic, deux onglets — lisaient toutes les deux « rien », et toutes les deux
  // inséraient.
  //
  // Ce qui les départage est déjà là : la clé technique est DÉTERMINISTE (même
  // adresse et même identité annoncée donnent la même clé) et son index est
  // unique. La base refuse donc la seconde insertion d'elle-même. Il ne restait
  // qu'à traduire ce refus dans le langage du métier — sans quoi le second
  // appelant recevait une erreur brute de base de données là où le premier
  // arrivé une seconde plus tard lisait une phrase claire.
  //
  // On ne pose PAS d'index unique sur l'adresse : elle est aussi réécrite au
  // bootstrap, où deux fiches distinctes peuvent légitimement annoncer la même
  // valeur. Une contrainte de base y transformerait un appairage en panne.
  try {
    await registryStore.insert(record);
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const gagnant =
      (await registryStore.getByBackendUrl(normalizedUrl))
      ?? (await registryStore.getByKey(generated.projectKey));
    throw dejaDeclare(gagnant ?? { projectId: null, projectName: resolvedName });
  }

  /**
   * LA DÉCLARATION EST DÉJÀ UNE ANNONCE DE DESTINATION.
   *
   * L'adresse saisie, et le manifeste s'il a été sondé, disent où le projet
   * vit. Attendre l'appairage priverait la fiche de toute adresse entre-temps
   * — et l'écran retomberait sur le manifeste, c'est-à-dire sur la seconde
   * source qu'on vient de supprimer.
   *
   * L'environnement vient du manifeste tant que le projet n'a pas parlé :
   * c'est lui qui le déclare, le Panel ne le devine pas.
   */
  /**
   * Seule l'adresse SAISIE est annoncée — celle où la sonde a répondu. Les
   * URLs du manifeste sont descriptives : elles peuvent nommer le domaine visé
   * alors que le service répond ailleurs. Le site et le Manager arriveront
   * avec la projection poussée, qui porte la photographie réseau complète.
   */
  try {
    const { announceDestination } = await import('./projectDestination.service.js');
    await announceDestination({ record, urls: { backend: normalizedUrl }, source: 'MANIFEST' });
  } catch {
    // La déclaration a réussi ; l'annonce se rattrapera au bootstrap.
  }

  await recordEvent({
    projectId: record.projectId,
    type: EVENT_TYPES.PROJECT_DECLARED,
    source: 'PANEL_OBSERVATION',
    summary: `Projet « ${record.projectName} » déclaré dans le registre.`,
    occurredAt: now,
  });

  const { code, expiresAt } = await issuePairingCode(record);
  return { record, pairingCode: code, pairingCodeExpiresAt: expiresAt };
}

export async function getProjectOrThrow(projectId) {
  const record = await registryStore.getById(projectId);
  if (!record) {
    throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', 'Projet inconnu du registre.');
  }
  return record;
}

export function listProjects() {
  return registryStore.list();
}

// Saisie manuelle d'un Manifest — CANAL DE SECOURS uniquement (projet parlant
// encore un contrat 1.0.x, sans transport de Manifest). Dès qu'un Manifest a
// été reçu via le pont (bootstrap 1.1+), il fait foi : la saisie manuelle est
// refusée pour qu'elle ne puisse jamais contredire ce que le projet déclare.
export async function updateManifest(projectId, manifestInput) {
  const record = await getProjectOrThrow(projectId);
  if (record.manifestSource === 'BRIDGE') {
    throw ApiError.conflict(
      'PANEL_MANIFEST_BRIDGE_AUTHORITATIVE',
      'Ce projet transmet son Manifest via le pont : la saisie manuelle est désactivée.',
    );
  }
  const validation = assertValidManifestOrThrow(manifestInput);
  assertManifestIdentityMatches(record, validation.manifest);
  record.manifest = validation.manifest;
  record.manifestSource = 'MANUAL';
  await registryStore.save(record);
  return { record, unknownFeatures: validation.unknownFeatures };
}

// Une identité de Manifest qui ne correspond pas à la fiche est une erreur —
// jamais un écrasement silencieux.
function assertManifestIdentityMatches(record, manifest) {
  if (manifest.project.key !== record.projectKey) {
    throw ApiError.badRequest(
      'PANEL_MANIFEST_IDENTITY_MISMATCH',
      `Le Manifest déclare project.key « ${manifest.project.key} » mais la fiche est « ${record.projectKey} ».`,
    );
  }
}

// Manifest reçu par le PONT (bootstrap ≥ 1.1.0) — canal officiel, prioritaire
// et définitif : il remplace toute saisie manuelle antérieure.
export async function setManifestFromBridge(record, manifest) {
  record.manifest = manifest;
  record.manifestSource = 'BRIDGE';
  await registryStore.save(record);
  return record;
}

/**
 * CONVERGENCE (Phase 4, contrat >= 1.3.0) — ce que le projet déclare avoir
 * réellement appliqué.
 *
 * C'est la seule information de tout le registre que le Panel ne peut pas
 * déduire : il sait ce qu'il a ÉMIS, il ne saurait pas ce qui a PRIS EFFET.
 * Sans ce constat, « configuration publiée » et « configuration appliquée »
 * seraient confondues, et un projet resté en retard passerait inaperçu.
 */
export async function recordAppliedConfiguration(record, applied) {
  record.appliedConfiguration = {
    companyId: applied.companyId ?? null,
    companySlug: applied.companySlug ?? null,
    companyVersion: applied.companyVersion ?? null,
    companyAppliedAt: applied.companyAppliedAt ?? null,
    integratedApiCount: applied.integratedApiCount ?? 0,
    integratedApiKeys: applied.integratedApiKeys ?? [],
    lastSyncAt: applied.lastSyncAt ?? null,
    observedAt: nowIso(),
  };
  await registryStore.save(record);
  return record;
}

export async function removeProject(projectId) {
  const record = await getProjectOrThrow(projectId);
  if (record.pairing.status === 'PAIRED') {
    throw ApiError.conflict(
      'PANEL_PROJECT_STILL_PAIRED',
      'Ce projet est encore appairé : révoquez l’appairage avant de le retirer du parc.',
    );
  }
  await registryStore.remove(projectId);
  return { removed: true };
}

// Enregistre un heartbeat (fiche déjà authentifiée par le middleware de pont).
export async function recordHeartbeat(record, heartbeat) {
  record.runtime.environment = heartbeat.environment;
  record.runtime.softwareVersion = heartbeat.softwareVersion;
  record.runtime.lastHeartbeatAt = nowIso();
  record.runtime.lastHealth = {
    status: heartbeat.health.status,
    details: heartbeat.health.details ?? null,
  };
  record.runtime.bridgeStats = heartbeat.bridgeStats ?? null;
  // Contrat >= 1.2.0 — supervision. Absent ⇒ on n'écrase pas ce qu'on savait
  // déjà : un projet peut publier ces champs par intermittence.
  if (heartbeat.runtime?.uptimeSeconds !== undefined) {
    record.runtime.uptimeSeconds = heartbeat.runtime.uptimeSeconds;
  }
  if (heartbeat.runtime?.startedAt !== undefined) {
    record.runtime.startedAt = heartbeat.runtime.startedAt;
  }
  if (heartbeat.runtime?.load !== undefined) record.runtime.load = heartbeat.runtime.load;
  if (heartbeat.runtime?.components !== undefined) {
    record.runtime.components = heartbeat.runtime.components;
  }
  if (heartbeat.engines !== undefined) record.runtime.engines = heartbeat.engines;
  await registryStore.save(record);
}


/**
 * Projection publique d'une fiche : jamais un hash, jamais un secret chiffré.
 *
 * ── `destinationHost`, ET POURQUOI IL N'A PAS DE DÉFAUT ─────────────────────
 * L'hôte de la destination ACTIVE entre dans la génération du projet. Cette
 * fonction est SYNCHRONE — elle ne peut pas aller le chercher — et le déduire
 * d'un champ de la fiche a produit exactement le défaut qu'on ferme ici : un
 * hôte inventé, une génération qui ne coïncidait avec aucune projection, et
 * tout un parc déclaré périmé.
 *
 * L'appelant le charge donc en lot (`loadActiveDestinationHosts`) et le passe.
 * S'il ne le passe pas, la génération le DIT (`DESTINATION-INCONNUE`) et la
 * comparaison s'abstient — une ignorance ne périme rien.
 *
 * @param {string|null|undefined} destinationHost hôte actif, `null` si l'on
 *        sait qu'il n'y en a aucun, omis si l'on ne sait pas.
 */
export function toPublicProject(record, now = Date.now(), projections = {}, destinationHost) {
  const capabilities = interpretCapabilities(record.manifest);
  return {
    projectId: record.projectId,
    projectKey: record.projectKey,
    /**
     * L'identité LOGIQUE et l'environnement de cette instance — de quoi
     * regrouper les fiches d'un même projet client SANS que l'écran ait à
     * deviner quoi que ce soit. `null` = fiche seule de son groupe.
     */
    logicalProjectKey: record.logicalProjectKey ?? null,
    environment: declaredEnvironmentOf(record),
    projectName: record.projectName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pairing: {
      status: record.pairing.status,
      pairedAt: record.pairing.pairedAt,
      revokedAt: record.pairing.revokedAt,
      pairingCodeExpiresAt: record.pairing.pairingCodeExpiresAt,
    },
    runtime: { ...record.runtime },
    liveness: deriveLiveness(record, now),
    secondsSinceLastHeartbeat: secondsSinceLastHeartbeat(record, now),
    // Identité de supervision : entièrement DÉRIVÉE du Manifest publié par le
    // projet. Rien n'est ressaisi côté Panel (20_MANAGER_STANDARD §4).
    descriptor: describeProject(record),
    capabilities: {
      enabled: capabilities.enabled,
      reserved: capabilities.reserved,
      unknown: capabilities.unknown,
      panelModules: capabilities.panelModules,
    },
    manifest: record.manifest,
    manifestSource: record.manifestSource ?? null,
    manifestUpdatedAt: record.manifestUpdatedAt ?? null,
    // CONVERGENCE (Phase 4) — relevée lors d'une découverte. `null` signifie
    // « jamais constatée », ce qui n'est pas « rien appliqué ».
    appliedConfiguration: record.appliedConfiguration ?? null,
    note: record.note ?? null,
    // PROJECTIONS MÉTIER (Lot 1b) — poussées par le projet, rafraîchies à
    // chaque modification. `null` = jamais reçue, ce qui n'est pas « vide ».
    business: {
      presentation: projections.presentation ?? null,
      contract: projections.contract ?? null,
      /**
       * FRAÎCHEUR — d'où viennent ces projections, et sont-elles encore de ce
       * monde ? Un projet redéployé de PROD vers TEST garde son `projectId`,
       * mais tout le reste a changé : les données reçues sous PROD ne
       * décrivent plus rien. L'écran doit pouvoir le dire, et pour cela il
       * lui faut la génération de la source à côté de la génération courante.
       */
      freshness: describeFreshness(record, projections, destinationHost),
    },
  };
}

/**
 * Ce que le frontend a besoin de savoir pour ne JAMAIS présenter une ancienne
 * photographie comme l'état actuel. Aucune décision d'affichage ici : on
 * fournit les faits, l'écran les met en forme (voir `getProjectDataFreshness`).
 */
function describeFreshness(record, projections, destinationHost) {
  const { environment, generation, destinationKnown } = currentGeneration(record, destinationHost);
  // La photographie la plus récemment reçue, quelle que soit l'entité : c'est
  // elle qui date la dernière synchronisation complète du projet.
  const recues = [projections.presentation, projections.contract]
    .filter(Boolean)
    .map((p) => p.receivedAt)
    .filter(Boolean)
    .sort();
  const source = projections.contract ?? projections.presentation ?? null;
  const projectionEnvironment = source?.sourceEnvironment ?? null;
  const projectionGeneration = source?.sourceGeneration ?? null;

  return {
    runtimeEnvironment: environment,
    runtimeGeneration: generation,
    projectionEnvironment,
    projectionGeneration,
    /**
     * LE VERDICT EST RENDU ICI, où le modèle est connu.
     *
     * L'écran comparait les deux clés par inégalité de chaînes. Il ne pouvait
     * pas savoir qu'une case peut valoir « je ne sais pas », et concluait au
     * désaccord. La règle appartient au backend ; l'écran la met en forme.
     */
    generationMismatch: generationsDiverge(projectionGeneration, generation),
    /**
     * Deux instances SUCCESSIVES du même environnement ne sont pas deux
     * environnements. L'écran doit pouvoir dire laquelle des deux ruptures il
     * décrit, sans la déduire d'une comparaison qu'il referait à sa façon.
     */
    environmentMismatch: Boolean(
      projectionEnvironment && environment && projectionEnvironment !== environment,
    ),
    /** L'appelant a-t-il pu se prononcer sur la destination active ? */
    destinationKnown,
    lastSyncAt: recues.length > 0 ? recues[recues.length - 1] : null,
  };
}

/**
 * Charge les projections métier d'un LOT de projets en deux requêtes, puis les
 * distribue. Une requête par projet ferait N+1 sur la page « Projets clients ».
 */
/**
 * ÉQUIPE d'un projet — lue seulement sur la FICHE.
 *
 * Pas dans la liste : charger l'équipe de tout le parc pour afficher des
 * cartes qui ne la montrent pas serait payer un coût sans contrepartie.
 */
export async function loadProjectTeam(projectId) {
  const { PanelProjectMember } = await import('../../models/PanelProjectProjection.model.js');
  return PanelProjectMember.find({ projectId }).sort({ role: 1, email: 1 }).lean();
}

export async function loadBusinessProjections(projectIds) {
  const { PanelProjectContract, PanelProjectPresentation } = await import(
    '../../models/PanelProjectProjection.model.js'
  );
  const [presentations, contracts] = await Promise.all([
    PanelProjectPresentation.find({ projectId: { $in: projectIds } }).lean(),
    PanelProjectContract.find({ projectId: { $in: projectIds } }).lean(),
  ]);
  const byId = new Map(projectIds.map((id) => [id, { presentation: null, contract: null }]));
  for (const p of presentations) if (byId.has(p.projectId)) byId.get(p.projectId).presentation = p;
  for (const c of contracts) if (byId.has(c.projectId)) byId.get(c.projectId).contract = c;
  return byId;
}

/**
 * DESCRIPTEUR de supervision — la carte de visite d'un projet, telle que le
 * Panel peut l'afficher.
 *
 * Toutes les valeurs viennent du Manifest ou des heartbeats. Aucune n'est
 * saisie : c'est la règle « le Manifest reste l'autorité ». Ce que le projet
 * ne publie pas vaut `null`, et l'interface affiche « inconnu ».
 */
export function describeProject(record) {
  const manifest = record.manifest ?? null;
  const runtime = record.runtime ?? {};
  /**
   * LE RÉSEAU EST DÉJÀ RÉSOLU quand la fiche arrive ici.
   *
   * `registryStore` — le seul point de chargement — attache `activeNetwork` à
   * toute fiche qu'il rend. Le descripteur n'a donc rien à choisir : il n'y a
   * plus qu'une source, et elle est déjà là. C'est ce qui rend le résolveur
   * unique par CONSTRUCTION plutôt que par discipline.
   */
  const network = record.activeNetwork ?? null;
  return {
    slug: record.projectKey,
    // PRÉSENTATION (contrat >= 1.4.x) — le nom COMMERCIAL prime sur le nom
    // technique dès que le projet le publie : c'est celui sous lequel
    // l'équipe connaît le client.
    name: manifest?.presentation?.companyName
      ?? manifest?.descriptor?.name
      ?? manifest?.project?.name
      ?? record.projectName,
    presentation: manifest?.presentation ?? null,
    type: manifest?.descriptor?.type ?? null,
    description: manifest?.descriptor?.description ?? null,
    layout: manifest?.descriptor?.layout ?? null,
    environment: runtime.environment ?? manifest?.project?.environment ?? null,
    /**
     * ── LES URLs VIENNENT DE LA DESTINATION ACTIVE, ET DE NULLE PART AILLEURS ──
     *
     * Elles lisaient `manifest.network` puis, à défaut, `runtime.publicBackendUrl`.
     * Les deux sont des photographies prises à l'APPAIRAGE : le battement de
     * cœur ne porte pas d'URL, et le manifeste n'est relu que sur action
     * manuelle. Un projet qui change de domaine sans se réappairer les laissait
     * donc figées sur l'ancien hôte, pendant que la projection poussée suivait
     * le nouveau. Le Panel affichait deux vérités — et appelait l'ancienne.
     *
     * Constaté sur « Demo SB Auto » : manifeste et runtime sur
     * `demo-sbauto.lycarz.com`, présentation sur `demo-sbauto06.ly-solution.com`.
     *
     * `null` quand aucune destination active n'est connue. « Inconnu » est une
     * réponse ; une adresse périmée présentée comme actuelle n'en est pas une.
     */
    primaryDomain: network?.host ?? null,
    urls: network?.resolved
      ? { website: network.website, manager: network.manager, backend: network.backend }
      : null,
    /** D'où vient cette adresse — pour que la déduction ne soit jamais magique. */
    networkSource: network?.reason ?? 'NON_RESOLU',
    destinationId: network?.destinationId ?? null,
    versions: {
      software: runtime.softwareVersion ?? manifest?.project?.softwareVersion ?? null,
      contract: runtime.contractVersion ?? manifest?.bridge?.contractVersion ?? null,
      manifestFormat: manifest?.manifestVersion ?? null,
      deploymentEngine: runtime.engines?.deployment ?? manifest?.engines?.deployment ?? null,
      duplicationEngine: runtime.engines?.duplication ?? manifest?.engines?.duplication ?? null,
    },
    dates: {
      createdAt: record.createdAt,
      pairedAt: record.pairing?.pairedAt ?? null,
      lastHeartbeatAt: runtime.lastHeartbeatAt ?? null,
      lastActivityAt: runtime.lastHeartbeatAt ?? record.updatedAt,
      manifestUpdatedAt: record.manifestUpdatedAt ?? null,
    },
  };
}

/**
 * ── `domainFromUrl` A DISPARU ───────────────────────────────────────────────
 *
 * Elle dérivait le domaine principal de `runtime.publicBackendUrl`. Cette
 * adresse est figée au bootstrap : après un changement de domaine sans
 * réappairage, elle désignait l'ancien hôte, et le « domaine principal »
 * affiché était donc faux tout en paraissant certain.
 *
 * Le domaine vient désormais de la destination ACTIVE, ou vaut `null`.
 */

/** Santé détaillée d'un projet — déléguée au service de supervision. */
export function projectHealth(record, context = {}) {
  return buildProjectHealth(record, context);
}

// Checklist de conformité Manager Standard (20_MANAGER_STANDARD §5) — états
// observables depuis le Panel ; le reste (Standalone, surface locale) relève
// de la recette du projet lui-même.
export function describeConformity(record) {
  const manifestValid = record.manifest !== null;
  const identityConsistent =
    !manifestValid || record.manifest.project.key === record.projectKey;
  return {
    declared: true,
    hasManifest: manifestValid,
    identityConsistent,
    paired: record.pairing.status === 'PAIRED',
    seenAlive: record.runtime.lastHeartbeatAt !== null,
  };
}
