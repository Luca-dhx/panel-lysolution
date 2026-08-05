/**
 * PARENTÉ DES DESTINATIONS — la seule autorité qui dit « c'est le même projet ».
 *
 * ── LA RÈGLE, ET RIEN D'AUTRE ───────────────────────────────────────────────
 * Deux destinations appartiennent au même projet UNIQUEMENT si quelqu'un l'a
 * déclaré. Ce module ne rapproche jamais deux cibles par leur base, leur
 * domaine, leur serveur, leur environnement ni leur nom : deux projets
 * distincts peuvent partager les cinq, et le jour où l'un d'eux serait
 * rapproché à tort, ce sont les médias d'un client qui atterriraient chez un
 * autre.
 *
 * C'est ici, et seulement ici, que naît le droit de migrer des fichiers.
 *
 * ── À NE PAS CONFONDRE ──────────────────────────────────────────────────────
 * `services/registry/projectIdentity.js` porte un tout autre sujet : la clé
 * technique d'un projet dans le REGISTRE du Panel (dérivée de son adresse, pour
 * l'appairage). Ce module-ci ne parle que de PARENTÉ ENTRE DESTINATIONS de
 * déploiement. Les deux ne se rencontrent jamais.
 */
import ApiError from '../../utils/ApiError.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelProjectIdentity from '../../models/PanelProjectIdentity.model.js';
import PanelDeploymentLocation from '../../models/PanelDeploymentLocation.model.js';
import PanelDeploymentTarget from '../../models/PanelDeploymentTarget.model.js';

/**
 * Garantit qu'une destination porte une identité, en lui en donnant une PROPRE
 * si elle n'en a pas.
 *
 * Jamais de fusion : une destination sans identité devient son propre projet.
 * C'est le choix conservateur — il ne crée aucun droit de migration qui
 * n'existait pas. Rapprocher deux destinations reste un acte déclaré.
 */
export async function ensureOwnIdentity(target, { origin = 'MIGRATION', actor = null, reason = null } = {}) {
  if (target.projectIdentityId) {
    const existante = await PanelProjectIdentity.findOne({ identityId: target.projectIdentityId });
    // L'identité référencée a disparu : on ne devine pas laquelle c'était, et on
    // n'en recrée surtout pas une — la destination perdrait sa parenté, donc
    // l'accès aux médias de ses emplacements antérieurs, en silence.
    if (!existante) throw ApiError.conflict(`Identité de projet introuvable pour la destination ${target.host}.`);
    return existante;
  }

  const at = nowIso();
  const identite = await PanelProjectIdentity.create({
    label: target.name ?? target.host,
    links: [{ targetId: target.targetId, host: target.host, origin, actor, reason, at }],
    createdAt: at,
    updatedAt: at,
  });
  await PanelDeploymentTarget.updateOne(
    { targetId: target.targetId },
    { $set: { projectIdentityId: identite.identityId, updatedAt: at } },
  );
  return identite;
}

/**
 * Rattache une destination à une identité EXISTANTE — la déclaration de parenté.
 *
 * Refuse si la destination appartient déjà à un AUTRE projet : un changement de
 * parent réécrirait l'histoire et ouvrirait un droit de copie entre deux projets
 * qui n'en ont jamais partagé. Rejouable sans effet si le lien existe déjà.
 */
export async function attachTargetToIdentity(target, identityId, { origin = 'DECLARED', actor = null, reason = null } = {}) {
  const identite = await PanelProjectIdentity.findOne({ identityId });
  if (!identite) throw ApiError.notFound('Projet parent introuvable.');

  if (target.projectIdentityId && target.projectIdentityId !== identityId) {
    throw ApiError.conflict(
      `La destination ${target.host} appartient déjà à un autre projet. Un rattachement ne peut pas être réécrit automatiquement.`,
    );
  }
  if (target.projectIdentityId === identityId) return { identity: identite, alreadyLinked: true };

  const at = nowIso();
  await PanelDeploymentTarget.updateOne(
    { targetId: target.targetId },
    { $set: { projectIdentityId: identityId, updatedAt: at } },
  );
  if (!(identite.links ?? []).some((l) => l.targetId === target.targetId)) {
    identite.links.push({ targetId: target.targetId, host: target.host, origin, actor, reason, at });
    identite.updatedAt = at;
    await identite.save();
  }
  return { identity: identite, alreadyLinked: false };
}

/**
 * Enregistre l'emplacement d'un déploiement en cours.
 * Idempotent sur le couple (destination, run) : un rejeu ne duplique rien.
 */
export async function recordLocation({
  projectIdentityId, targetId, host, siteRoot, sharedUploadsPath, sharedStoragePath = null,
  sshHost = null, environment, deploymentRunId = null, commit = null,
}) {
  return PanelDeploymentLocation.findOneAndUpdate(
    { targetId, deploymentRunId },
    {
      $set: {
        projectIdentityId, host, siteRoot, sharedUploadsPath, sharedStoragePath,
        sshHost, environment, commit, status: 'DEPLOYING',
      },
      $setOnInsert: { deployedAt: nowIso() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * Promeut un emplacement en `HEALTHY` — après vérification publique, jamais avant.
 *
 * Seul un emplacement sain sert de SOURCE à une migration future : un
 * déploiement qui a échoué avant le transfert n'a peut-être reçu aucun fichier,
 * et en faire une source reviendrait à migrer du vide en croyant migrer des
 * médias.
 */
export async function markLocationHealthy(locationId, { deploymentRunId = null } = {}) {
  const doc = await PanelDeploymentLocation.findById(locationId);
  if (!doc) return null;
  doc.status = 'HEALTHY';
  if (deploymentRunId) doc.deploymentRunId = deploymentRunId;
  await doc.save();

  await PanelDeploymentTarget.updateOne(
    { targetId: doc.targetId },
    { $set: { currentSiteRoot: doc.siteRoot, lastHealthyDeploymentRunId: doc.deploymentRunId ?? null, updatedAt: nowIso() } },
  );
  return doc;
}

export async function markLocationFailed(locationId) {
  if (!locationId) return null;
  return PanelDeploymentLocation.findByIdAndUpdate(locationId, { $set: { status: 'FAILED' } }, { new: true });
}

/**
 * Emplacements depuis lesquels une destination a le DROIT de récupérer des médias.
 *
 * Trois filtres, tous nécessaires :
 *   - même identité DÉCLARÉE (le droit lui-même) ;
 *   - `HEALTHY` (l'emplacement a réellement servi, ses fichiers sont crédibles) ;
 *   - un autre chemin que la destination (on ne se copie pas sur soi-même).
 *
 * Le tri du plus récent au plus ancien n'est pas cosmétique : en cas de doublon
 * de nom, c'est la version la plus récemment servie qui est retenue en premier.
 */
export async function resolveUploadsSources({ projectIdentityId, targetId, sharedUploadsPath }) {
  if (!projectIdentityId) return { identityId: null, sources: [] };

  const emplacements = await PanelDeploymentLocation
    .find({ projectIdentityId, status: 'HEALTHY' })
    .sort({ deployedAt: -1 })
    .lean();

  const vus = new Set();
  const sources = [];
  for (const e of emplacements) {
    if (e.targetId === targetId) continue;
    if (e.sharedUploadsPath === sharedUploadsPath) continue;
    if (vus.has(e.sharedUploadsPath)) continue;
    vus.add(e.sharedUploadsPath);
    sources.push({
      host: e.host,
      sharedUploadsPath: e.sharedUploadsPath,
      projectIdentityId: e.projectIdentityId,
      deployedAt: e.deployedAt,
    });
  }
  return { identityId: projectIdentityId, sources };
}

/** Liste les destinations d'un projet — l'écran « ce projet vit à ces adresses ». */
export async function listTargetsOfIdentity(identityId) {
  return PanelDeploymentTarget.find({ projectIdentityId: identityId }).sort({ createdAt: 1 }).lean();
}

export default {
  ensureOwnIdentity,
  attachTargetToIdentity,
  recordLocation,
  markLocationHealthy,
  markLocationFailed,
  resolveUploadsSources,
  listTargetsOfIdentity,
};
