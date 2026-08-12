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
    // `null` depuis la Phase 4 : un événement peut concerner le Panel
    // lui-même (publication d'une configuration d'entreprise) et non un
    // projet. Le distinguer d'un projet inconnu importe — d'où null plutôt
    // qu'une valeur sentinelle.
    projectId: { type: String, default: null },
    occurredAt: { type: String, required: true },
    type: { type: String, required: true },
    // PROJECT : le projet l'a déclaré · PANEL_OBSERVATION : constat du Panel
    // en comparant deux publications · PANEL : acte délibéré d'un opérateur
    // du Panel (Phase 4 — le Panel agit désormais).
    source: { type: String, enum: ['PROJECT', 'PANEL_OBSERVATION', 'PANEL'], required: true },
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
  // Phase 4 — l'entreprise et sa configuration.
  COMPANY_CREATED: 'COMPANY_CREATED',
  COMPANY_PUBLISHED: 'COMPANY_PUBLISHED',
  INTEGRATED_API_GRANTED: 'INTEGRATED_API_GRANTED',
  INTEGRATED_API_REVOKED: 'INTEGRATED_API_REVOKED',
  /**
   * RETIRÉ EN L4 — plus aucune écriture ne l'émet.
   *
   * Il datait de l'époque où enregistrer une clé la rediffusait aux projets.
   * Cette diffusion n'existe plus. Le type reste au catalogue parce que des
   * chronologies en production le portent : le retirer rendrait illisibles des
   * événements déjà écrits, pour un gain nul.
   */
  INTEGRATED_API_PUBLISHED: 'INTEGRATED_API_PUBLISHED',
  PROJECT_DISCOVERED: 'PROJECT_DISCOVERED',
  // L1 — plan de contrôle IntegratedAPI. Ces événements ne concernent aucun
  // projet (`projectId: null`) : ils décrivent le Panel administrant son
  // propre coffre. Leur `data` ne porte QUE des noms de rôles et des codes.
  INTEGRATED_API_CREDENTIALS_UPDATED: 'INTEGRATED_API_CREDENTIALS_UPDATED',
  INTEGRATED_API_VALIDATION_SUCCEEDED: 'INTEGRATED_API_VALIDATION_SUCCEEDED',
  INTEGRATED_API_VALIDATION_FAILED: 'INTEGRATED_API_VALIDATION_FAILED',
  /**
   * L3 — passerelle de capacités. Trois types, et la séparation compte.
   *
   * Un OCTROI est une décision d'opérateur ; une INVOCATION est un fait
   * d'exploitation ; un REFUS est un fait aussi, mais c'est celui qu'on relit
   * quand quelque chose ne marche pas. Les fondre en un seul type obligerait à
   * filtrer sur `data` pour répondre à « pourquoi ce projet n'arrive-t-il pas
   * à envoyer ? » — la question la plus fréquente qu'on posera à ce journal.
   *
   * Aucun de leurs `data` ne porte de secret : provider, environnement, code
   * de capacité, issue, durée. Jamais de clé, jamais d'entrée métier, jamais
   * d'adresse.
   */
  CAPABILITY_GRANTS_UPDATED: 'CAPABILITY_GRANTS_UPDATED',
  CAPABILITY_INVOKED: 'CAPABILITY_INVOKED',
  CAPABILITY_REFUSED: 'CAPABILITY_REFUSED',
  /**
   * L3.1 — l'ouverture commerciale d'une instance.
   *
   * Ce sont les deux seuls événements du catalogue qui autorisent, ou
   * retirent, le droit de dépenser de l'argent réel. Ils portent l'acteur et
   * le motif : une ouverture doit rester imputable longtemps après.
   */
  COMMERCIAL_OPENED: 'COMMERCIAL_OPENED',
  COMMERCIAL_CLOSED: 'COMMERCIAL_CLOSED',
  /**
   * L10.1 — le registre financier.
   *
   * Trois types, parce que les trois questions qu'on posera à ce journal sont
   * distinctes : « qui a saisi cette ligne ? », « qui l'a corrigée, et
   * qu'y avait-il avant ? », « qui l'a retirée du bénéfice, et pourquoi ? ».
   * Un type unique obligerait à filtrer sur `data` pour répondre à la
   * troisième — celle qui compte le jour où un total change sans explication.
   *
   * `projectId` vaut `null` pour un mouvement propre à L.Y Solution : c'est le
   * même nul que le modèle, et il se lit pareil.
   *
   * Leur `data` porte l'identifiant du mouvement, sa taxonomie, son montant en
   * centimes et son origine. JAMAIS de charge utile fournisseur, jamais de
   * secret : un journal de chronologie se lit à plusieurs, un secret ne se
   * lit pas.
   */
  FINANCIAL_TRANSACTION_CREATED: 'FINANCIAL_TRANSACTION_CREATED',
  FINANCIAL_TRANSACTION_UPDATED: 'FINANCIAL_TRANSACTION_UPDATED',
  FINANCIAL_TRANSACTION_DELETED: 'FINANCIAL_TRANSACTION_DELETED',
});

export default { PanelHeartbeat, PanelEvent, EVENT_TYPES };
