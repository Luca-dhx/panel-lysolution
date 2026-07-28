// Fiche du registre des projets — docs/architecture/02_PROJECT_REGISTRY.md.
// Le document reflète EXACTEMENT la fiche manipulée par les services : les
// horodatages restent des chaînes ISO gérées par la couche service (nowIso),
// comme dans le reste du contrat.
// Sécurité : jamais un secret en clair — pairingCode et bridgeToken en hash
// SHA-256 ; copie du bridgeToken chiffrée AES-256-GCM (panelCrypto) réservée
// aux appels sortants.
import mongoose from 'mongoose';

const pairingSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['DECLARED', 'PAIRED', 'REVOKED'], required: true },
    pairingCodeHash: { type: String, default: null },
    pairingCodeExpiresAt: { type: String, default: null },
    bridgeTokenHash: { type: String, default: null },
    bridgeTokenEncrypted: { type: String, default: null },
    pairedAt: { type: String, default: null },
    revokedAt: { type: String, default: null },
  },
  { _id: false },
);

const runtimeSchema = new mongoose.Schema(
  {
    environment: { type: String, enum: ['TEST', 'PROD', null], default: null },
    softwareVersion: { type: String, default: null },
    contractVersion: { type: String, default: null },
    publicBackendUrl: { type: String, default: null },
    lastHeartbeatAt: { type: String, default: null },
    lastHealth: { type: mongoose.Schema.Types.Mixed, default: null },
    bridgeStats: { type: mongoose.Schema.Types.Mixed, default: null },
    // Supervision (contrat >= 1.2.0) — dernier état publié par le projet.
    // Tout est nullable : un projet parlant un contrat antérieur reste
    // pleinement conforme, et le Panel affiche « inconnu » sans le pénaliser.
    uptimeSeconds: { type: Number, default: null },
    startedAt: { type: String, default: null },
    load: { type: mongoose.Schema.Types.Mixed, default: null },
    components: { type: mongoose.Schema.Types.Mixed, default: null },
    engines: { type: mongoose.Schema.Types.Mixed, default: null },
    certificate: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const panelProjectSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, unique: true },
    projectKey: { type: String, required: true, unique: true },
    projectName: { type: String, required: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    pairing: { type: pairingSchema, required: true },
    runtime: { type: runtimeSchema, required: true },
    manifest: { type: mongoose.Schema.Types.Mixed, default: null },
    manifestSource: { type: String, enum: ['BRIDGE', 'MANUAL', null], default: null },
    manifestUpdatedAt: { type: String, default: null },
    // Note de supervision libre, saisie côté Panel. C'est la SEULE donnée du
    // registre qui n'est pas dérivée du projet — elle ne lui est jamais
    // transmise et n'influence aucun calcul.
    note: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

export default mongoose.model('PanelProject', panelProjectSchema);
