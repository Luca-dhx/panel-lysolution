// Collections de SUPERVISION — Phase 3A.
//
// Discipline de la phase : le Panel OBSERVE. Ces documents ne décrivent que
// ce que les projets ont publié (heartbeats) ou ce que le Panel a constaté
// de leur publication (événements de chronologie). Aucun n'est une intention,
// aucun n'induit une action distante.
import mongoose from 'mongoose';

/**
 * Historique des heartbeats reçus, par projet.
 *
 * Conservé pour lire une TENDANCE (le projet redémarre-t-il en boucle ? sa
 * mémoire dérive-t-elle ?), pas seulement le dernier état. La rétention est
 * bornée par `HEARTBEAT_HISTORY_SIZE`.
 */
const heartbeatSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    receivedAt: { type: String, required: true },
    sentAt: { type: String, required: true },
    softwareVersion: { type: String, default: null },
    environment: { type: String, enum: ['TEST', 'PROD', null], default: null },
    healthStatus: { type: String, enum: ['OK', 'DEGRADED', null], default: null },
    healthDetails: { type: String, default: null },
    // Contrat ≥ 1.2.0, tout optionnel : un projet plus ancien n'en publie pas.
    uptimeSeconds: { type: Number, default: null },
    load: { type: mongoose.Schema.Types.Mixed, default: null },
    components: { type: mongoose.Schema.Types.Mixed, default: null },
    engines: { type: mongoose.Schema.Types.Mixed, default: null },
    bridgeStats: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { minimize: false, versionKey: false },
);
heartbeatSchema.index({ projectId: 1, receivedAt: -1 });

/**
 * Chronologie — le Panel n'INVENTE aucun événement.
 *
 * Chaque entrée est soit une déclaration du projet (heartbeat, bootstrap),
 * soit un CONSTAT de changement entre deux publications successives
 * (« la version a changé », « le projet est réapparu »). L'origine est
 * toujours explicite.
 */
const eventSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    occurredAt: { type: String, required: true },
    type: { type: String, required: true },
    // PROJECT : le projet l'a déclaré · PANEL_OBSERVATION : constat du Panel
    // en comparant deux publications. Jamais « PANEL_ACTION » : le Panel
    // n'agit pas sur les projets dans cette phase.
    source: { type: String, enum: ['PROJECT', 'PANEL_OBSERVATION'], required: true },
    severity: { type: String, enum: ['INFO', 'WARNING', 'ERROR'], default: 'INFO' },
    summary: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { minimize: false, versionKey: false },
);
eventSchema.index({ projectId: 1, occurredAt: -1 });

export const PanelHeartbeat = mongoose.model('PanelHeartbeat', heartbeatSchema);
export const PanelEvent = mongoose.model('PanelEvent', eventSchema);

/** Types d'événements de chronologie — catalogue fermé, additif. */
export const EVENT_TYPES = Object.freeze({
  PROJECT_DECLARED: 'PROJECT_DECLARED',
  PROJECT_PAIRED: 'PROJECT_PAIRED',
  PROJECT_UNPAIRED: 'PROJECT_UNPAIRED',
  HEARTBEAT_RECEIVED: 'HEARTBEAT_RECEIVED',
  VERSION_CHANGED: 'VERSION_CHANGED',
  ENGINE_VERSION_CHANGED: 'ENGINE_VERSION_CHANGED',
  DEPLOYMENT_DETECTED: 'DEPLOYMENT_DETECTED',
  BRIDGE_RECONNECTED: 'BRIDGE_RECONNECTED',
  HEALTH_CHANGED: 'HEALTH_CHANGED',
  MANIFEST_UPDATED: 'MANIFEST_UPDATED',
  ENVIRONMENT_CHANGED: 'ENVIRONMENT_CHANGED',
});

export default { PanelHeartbeat, PanelEvent, EVENT_TYPES };
