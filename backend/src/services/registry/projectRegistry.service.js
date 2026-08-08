// Le registre des projets — docs/architecture/02_PROJECT_REGISTRY.md.
// Catégorie 3 : cette donnée n'existe que dans le Panel et ne transite jamais
// vers un projet.
import config from '../../config/env.js';
import { deriveLiveness, LIVENESS, secondsSinceLastHeartbeat } from '../supervision/liveness.service.js';
import { buildProjectHealth } from '../supervision/health.service.js';
import { newBridgeId, nowIso } from '../../bridge/bridgeContract.js';
import ApiError from '../../utils/ApiError.js';
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
 * L'ENVIRONNEMENT D'UNE FICHE — DÉCLARÉ PAR LE PROJET, ou inconnu.
 *
 * ══ CE QUI A CHANGÉ, ET POURQUOI ════════════════════════════════════════════
 *
 * Cette fonction rendait `runtime.environment` puis, à défaut,
 * `declaredEnvironment` — l'intention saisie au moment de la déclaration. Une
 * fiche jamais appairée affichait donc « TEST » ou « PROD » avec la même
 * assurance qu'une fiche vivante, alors que RIEN ne le prouvait : personne
 * n'avait encore parlé. L'écran présentait une intention comme un constat.
 *
 * ══ LA RÈGLE ════════════════════════════════════════════════════════════════
 *
 * Avant appairage : `null`. Il n'y a pas d'environnement « supposé » — pas de
 * repli sur le nom, sur le domaine, sur le manifeste ni sur l'intention.
 * Après appairage : la valeur que le PROJET a annoncée à son bootstrap et
 * réaffirme à chaque battement, et elle seule.
 *
 * `declaredEnvironment` reste en base : il est écrit à la déclaration et sert
 * UNIQUEMENT à départager deux clés techniques identiques (anti-collision).
 * Il ne pilote plus aucun affichage, aucun regroupement, aucun périmètre.
 */
export function declaredEnvironmentOf(record) {
  if (record?.pairing?.status !== 'PAIRED') return null;
  return normalizeEnvironment(record?.runtime?.environment);
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

  const env = normalizeEnvironment(environment);

  /**
   * ── ANTI-DOUBLONS — UNE ADRESSE, UNE FICHE ───────────────────────────────
   *
   * Une même ADRESSE ne peut entrer qu'une fois : deux fiches pointant le même
   * backend décriraient la même instance deux fois.
   *
   * ══ CE QUI A ÉTÉ RETIRÉ ICI, ET POURQUOI ═════════════════════════════════
   *
   * Ce bloc portait tout un appareil de regroupement logique : recherche de
   * « sœurs » partageant `logicalProjectKey`, rattachement automatique des
   * fiches antérieures, refus d'une seconde fiche du même projet dans le même
   * environnement. Il servait une doctrine abandonnée — une carte d'écran
   * portant la recette ET la production d'un même client.
   *
   * Cette doctrine était de surcroît IRRÉALISABLE dans une instance de Panel :
   * `pairing.service` refuse tout appairage dont l'environnement ne concorde
   * pas avec celui du Panel (fail closed, et c'est une protection qu'on garde).
   * Un Panel de recette ne peut donc JAMAIS héberger une instance de
   * production appairée. Le groupe TEST+PROD ne pouvait, au mieux, contenir
   * qu'une fiche vivante et une fiche fantôme.
   *
   * Reste ce qui protège réellement : une adresse, une fiche ; une clé
   * technique, une fiche.
   */
  const surLaMemeAdresse = await registryStore.getByBackendUrl(normalizedUrl);
  if (surLaMemeAdresse) throw dejaDeclare(surLaMemeAdresse);

  /**
   * LA CLÉ TECHNIQUE RESTE UNIQUE PAR FICHE — anti-collision, rien de plus.
   *
   * `projectKey` identifie une FICHE, et son index est unique. Deux projets
   * voisins peuvent dériver la même valeur ; on la qualifie alors par
   * l'environnement DÉCLARÉ à la saisie — `<cle>-prod` — ce qui reste
   * déterministe : mêmes entrées, même clé, un double clic reste inoffensif.
   *
   * C'est le SEUL emploi survivant de `declaredEnvironment`, et il est
   * purement technique : cette valeur ne s'affiche nulle part et ne détermine
   * ni l'environnement de la fiche, ni sa destination, ni son périmètre métier.
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
    /**
     * L'IDENTITÉ LOGIQUE N'EST PLUS ÉCRITE.
     *
     * Le champ demeure dans le schéma, nullable, pour ne rien détruire des
     * fiches historiques qui le portent. Aucune écriture neuve ne le
     * renseigne, et plus aucune lecture ne s'en sert : ni pour regrouper, ni
     * pour résoudre une donnée métier, ni pour construire un écran.
     */
    projectName: resolvedName,
    /**
     * L'ENVIRONNEMENT SAISI — anti-collision de clé technique, et rien d'autre.
     *
     * Il ne s'affiche nulle part : `declaredEnvironmentOf` ne le lit plus.
     * Tant que le projet n'a pas parlé, l'environnement de la fiche est
     * INCONNU, et c'est ce que l'API rend.
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
     * L'ENVIRONNEMENT DE CETTE INSTANCE — déclaré par le projet, ou `null`.
     *
     * `logicalProjectKey` NE FIGURE PLUS dans la projection publique : une
     * fiche du Panel décrit UNE instance appairée, et plus rien à l'écran ne
     * regroupe deux fiches. Le champ reste en base pour les fiches
     * historiques ; il ne franchit plus l'API.
     */
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
    /**
     * LA PLUS RÉCENTE DES PHOTOGRAPHIES ENCORE STOCKÉES — c'est un âge de
     * SNAPSHOT, et il se recalcule à chaque lecture.
     *
     * Ne pas le confondre avec `lastBusinessSyncAt` : celui-ci recule quand
     * une projection est supprimée, ignore les membres d'équipe, et ne dit
     * rien d'une réception qui n'a rien changé. Il répond à « de quand date
     * ce que j'affiche », pas à « quand l'ai-je reçu ».
     */
    lastSyncAt: recues.length > 0 ? recues[recues.length - 1] : null,
    /**
     * LA RÉCEPTION OBSERVÉE — la source canonique, persistée par le noyau de
     * synchronisation à l'instant où une entité métier a été appliquée.
     */
    lastBusinessSyncAt: record.runtime?.lastBusinessSyncAt ?? null,
    /** `false` = jamais rien reçu. À ne jamais afficher comme « à jour ». */
    businessDataEverReceived: Boolean(record.runtime?.lastBusinessSyncAt),
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
  /**
   * La photographie POUSSÉE par le projet, attachée par `registryStore` — le
   * seul point de chargement, donc le seul résolveur. Voir son commentaire.
   */
  const presentation = record.activePresentation ?? null;
  const runtime = record.runtime ?? {};
  /**
   * UNE FICHE NON APPAIRÉE NE DÉCLARE RIEN — ni environnement, ni destination.
   *
   * ══ CE QU'ON MONTRAIT, ET POURQUOI C'ÉTAIT FAUX ═════════════════════════
   *
   * Une fiche tout juste déclarée affichait un environnement (l'intention
   * saisie, ou celle du manifeste de secours) et une destination (l'adresse
   * qu'on venait de taper, promue « destination active »). Les deux se
   * présentaient exactement comme les valeurs d'une instance vivante — même
   * champ, même mise en forme, aucune réserve.
   *
   * Or personne n'avait encore parlé. L'environnement et la destination d'un
   * projet sont DÉCLARÉS PAR LUI, à l'appairage puis à chaque échange. Avant,
   * la seule réponse honnête est « inconnu ».
   *
   * ══ CE QUI N'EST PAS DÉTRUIT POUR AUTANT ═════════════════════════════════
   *
   * La destination technique reste enregistrée (c'est elle qui permet de
   * sonder l'adresse saisie), et `runtime.publicBackendUrl` — une donnée
   * ADMINISTRATIVE, réellement connue localement puisqu'on l'a saisie — reste
   * exposée telle quelle. Ce qui disparaît est la PRÉTENTION : rien de dérivé
   * du futur projet n'est présenté comme un fait.
   */
  const paired = record.pairing?.status === 'PAIRED';
  const network = paired ? (record.activeNetwork ?? null) : null;
  return {
    slug: record.projectKey,
    /**
     * ── LE NOM VIENT DE LA PROJECTION POUSSÉE, PAS DU MANIFESTE ────────────
     *
     * Il se lisait dans `manifest.presentation.companyName`. Un manifeste est
     * une photographie prise à l'APPAIRAGE, relue seulement sur action d'un
     * opérateur : renommer l'entreprise dans le Manager ne le touche jamais.
     * Le projet poussait pourtant sa nouvelle présentation en moins d'une
     * seconde, le Panel la persistait — et personne ne la lisait. La fiche
     * affichait indéfiniment l'ancien nom, sans que rien ne le signale.
     *
     * C'est le défaut déjà corrigé sur les URLs, un champ plus loin. La
     * correction est la même : la PROJECTION fait autorité, le manifeste n'est
     * plus qu'un repli pour un projet qui n'en pousse pas encore.
     */
    name: presentation?.companyName
      ?? manifest?.presentation?.companyName
      ?? manifest?.descriptor?.name
      ?? manifest?.project?.name
      ?? record.projectName,
    presentation: presentation ?? manifest?.presentation ?? null,
    /**
     * D'OÙ VIENT CE QU'ON AFFICHE — dit, jamais deviné.
     *
     * `PROJECTION` : poussé par le projet, vivant. `MANIFEST` : figé à
     * l'appairage. `REGISTRY` : le nom saisi à la déclaration, dernier repli.
     */
    presentationSource: presentation?.companyName ? 'PROJECTION'
      : (manifest?.presentation?.companyName || manifest?.descriptor?.name
        || manifest?.project?.name) ? 'MANIFEST' : 'REGISTRY',
    /** Quand le PROJET a produit cette photographie. */
    presentationModifiedAt: presentation?.modifiedAt ?? null,
    /**
     * `type` ET `layout` N'ONT PAS DE PROJECTION — le manifeste est leur seule
     * source, et c'est légitime : ils décrivent la COMPOSITION du projet, qui
     * ne change qu'entre deux versions du logiciel. On le dit quand même
     * (`descriptorSource`), pour qu'aucun écran n'ait à le supposer.
     */
    type: manifest?.descriptor?.type ?? null,
    layout: manifest?.descriptor?.layout ?? null,
    /**
     * ── LA DESCRIPTION, ELLE, EST POUSSÉE ─────────────────────────────────
     *
     * Le projet la publie dans sa présentation (`project.description`), et le
     * Panel la persiste. Elle se lisait pourtant dans le manifeste — même
     * défaut que le nom, un champ plus loin : une valeur figée à l'appairage
     * affichée comme si elle était courante.
     */
    description: presentation?.description
      ?? manifest?.descriptor?.description
      ?? null,
    descriptorSource: presentation?.description ? 'PROJECTION'
      : manifest?.descriptor?.description ? 'MANIFEST' : 'NONE',
    /**
     * L'ENVIRONNEMENT — DÉCLARÉ, jamais déduit d'un manifeste de secours.
     *
     * Le repli `manifest.project.environment` a disparu : un manifeste est une
     * photographie, parfois SAISIE À LA MAIN (`manifestSource: 'MANUAL'`).
     * S'en servir revenait à laisser un opérateur décider de l'environnement
     * d'une instance qui n'avait jamais parlé.
     */
    environment: paired ? (runtime.environment ?? null) : null,
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
     * Constaté sur un projet du parc : manifeste et runtime sur
     * `demo.exemple-a.com`, présentation sur `demo.exemple-b.com`.
     *
     * `null` quand aucune destination active n'est connue. « Inconnu » est une
     * réponse ; une adresse périmée présentée comme actuelle n'en est pas une.
     */
    primaryDomain: network?.host ?? null,
    urls: network?.resolved
      ? { website: network.website, manager: network.manager, backend: network.backend }
      : null,
    /**
     * D'où vient cette adresse — pour que la déduction ne soit jamais magique.
     * `NON_APPAIRE` dit franchement pourquoi il n'y en a pas : ce n'est pas un
     * échec de résolution, c'est une absence de déclaration.
     */
    networkSource: paired ? (network?.reason ?? 'NON_RESOLU') : 'NON_APPAIRE',
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
      /**
       * DEUX FAITS, JAMAIS CONFONDUS.
       *
       * `lastHeartbeatAt` : « cette instance répond-elle ? »
       * `lastBusinessSyncAt` : « quand le Panel a-t-il reçu son état métier ? »
       *
       * `null` se lit « jamais reçu » — ce qui n'est pas « ancien », et
       * surtout pas « à jour ». Un projet peut battre depuis trois jours sans
       * avoir jamais rien projeté.
       */
      lastBusinessSyncAt: runtime.lastBusinessSyncAt ?? null,
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
