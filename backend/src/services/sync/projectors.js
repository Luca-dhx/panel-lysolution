/**
 * PROJECTEURS — une entrée par type d'entité appliqué, et rien d'autre.
 *
 * ── POURQUOI CETTE TABLE EXISTE ─────────────────────────────────────────────
 * Le moteur de synchronisation se terminait par une ligne spécifique :
 * `PanelDiagnostic.create(...)`. Tout le reste — déduplication, LWW, anti-écho,
 * accusés, journal — était pourtant parfaitement générique. Ajouter un type
 * métier obligeait donc à toucher le cœur, c'est-à-dire à risquer la mécanique
 * de livraison pour une raison d'affichage.
 *
 * Le cœur ne connaît plus que cette table. Ajouter INVOICE, PAYMENT, EVENT,
 * MEETING ou TEAM_MEMBER demandera un schéma et une fonction ici — pas une
 * ligne de plus dans `syncCore`.
 *
 * ── CONTRAT D'UN PROJECTEUR ─────────────────────────────────────────────────
 * Il reçoit `{ projectId, change }` et projette. Il ne décide ni de l'ordre ni
 * de l'idempotence : le cœur les a déjà tranchés. S'il lève, l'écriture est
 * REJETÉE — jamais appliquée à moitié.
 */
import {
  BRIDGE_ERROR_CODES,
  BridgeError,
  contractPayloadSchema,
  nowIso,
  projectPresentationPayloadSchema,
} from '../../bridge/bridgeContract.js';
import { PanelDiagnostic } from '../../models/PanelSyncState.model.js';
import {
  PanelProjectContract,
  PanelProjectPresentation,
} from '../../models/PanelProjectProjection.model.js';

/** Code d'accusé d'un payload non conforme — stable, lisible par le projet. */
export const ENTITY_PAYLOAD_INVALID = 'ENTITY_PAYLOAD_INVALID';

/**
 * Valide un payload, ou lève une BridgeError exploitable. Les chemins fautifs
 * voyagent avec l'erreur ; aucune valeur ne l'accompagne — un payload peut
 * contenir des coordonnées, un message d'erreur ne doit pas les répandre.
 */
function parsePayload(schema, payload, label) {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new BridgeError(
    BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
    `Payload ${label} non conforme.`,
    {
      code: ENTITY_PAYLOAD_INVALID,
      issues: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    },
  );
}

/** DIAGNOSTIC — échange de test, conservé tel quel (journal d'écritures). */
async function applyDiagnostic({ projectId, change }) {
  await PanelDiagnostic.create({ projectId, change, receivedAt: nowIso() });
}

/**
 * PROJECT_PRESENTATION — l'identité commerciale du projet.
 *
 * Un seul enregistrement par projet : chaque réception REMPLACE la
 * photographie précédente. C'est un état, pas un historique — et le cœur a
 * déjà écarté les écritures plus anciennes (LWW).
 */
async function applyProjectPresentation({ projectId, change }) {
  if (change.deleted) {
    await PanelProjectPresentation.deleteOne({ projectId });
    return;
  }
  const p = parsePayload(projectPresentationPayloadSchema, change.payload, 'PROJECT_PRESENTATION');
  await PanelProjectPresentation.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        companyName: p.companyName ?? null,
        tagline: p.tagline ?? null,
        logoUrl: p.logoUrl ?? null,
        faviconUrl: p.faviconUrl ?? null,
        contacts: {
          email: p.contacts?.email ?? null,
          phone: p.contacts?.phone ?? null,
          website: p.contacts?.website ?? null,
        },
        projectName: p.project?.name ?? null,
        description: p.project?.description ?? null,
        network: {
          website: p.network?.website ?? null,
          manager: p.network?.manager ?? null,
          backend: p.network?.backend ?? null,
        },
        sourceModifiedAt: change.modifiedAt,
        receivedAt: nowIso(),
      },
    },
    { upsert: true },
  );
}

/**
 * CONTRACT — le contrat COURANT du projet, tel que lui-même le désigne.
 *
 * Un tombstone (`deleted`) signifie « plus aucun contrat pertinent » : on
 * efface la projection plutôt que de laisser un contrat périmé à l'écran.
 */
async function applyContract({ projectId, change }) {
  if (change.deleted) {
    await PanelProjectContract.deleteOne({ projectId });
    return;
  }
  const c = parsePayload(contractPayloadSchema, change.payload, 'CONTRACT');
  await PanelProjectContract.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        sourceContractId: c.sourceContractId,
        status: c.status,
        reference: c.reference ?? null,
        createdAt: c.createdAt ?? null,
        activatedAt: c.activatedAt ?? null,
        pricing: {
          subscription: c.pricing?.subscription ?? null,
          launchFee: c.pricing?.launchFee ?? null,
        },
        sourceModifiedAt: change.modifiedAt,
        receivedAt: nowIso(),
      },
    },
    { upsert: true },
  );
}

/** Table FERMÉE — le cœur n'applique que ce qui y figure. */
export const PROJECTORS = Object.freeze({
  DIAGNOSTIC: applyDiagnostic,
  PROJECT_PRESENTATION: applyProjectPresentation,
  CONTRACT: applyContract,
});

/** Types réellement appliqués — dérivés de la table, jamais réécrits à côté. */
export const PROJECTED_ENTITY_TYPES = Object.freeze(Object.keys(PROJECTORS));

export default { PROJECTORS, PROJECTED_ENTITY_TYPES, ENTITY_PAYLOAD_INVALID };
