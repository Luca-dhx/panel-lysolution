// DESTINATION DE DÉPLOIEMENT DU PANEL — Phase 4.
//
// Une destination = un endroit où CE Panel peut être mis en ligne, identifié
// par son URL complète. Le moteur en déduit hôte, type et domaine : ils ne
// sont jamais saisis séparément, ce qui évite qu'une saisie contredise une
// autre.
//
// ── AUCUN SECRET ICI ────────────────────────────────────────────────────────
// Le mot de passe SSH n'est PAS un champ de ce document, et ne le sera
// jamais. Il n'existe qu'en RAM, dans le coffre du moteur (`passwordVault`),
// le temps d'une session. Même règle que SB Auto 06 — un secret
// d'infrastructure en base est un secret compromis le jour où la base fuit.
import mongoose from 'mongoose';

/** Une étape telle qu'archivée dans l'historique de la destination. */
const historyStepSchema = new mongoose.Schema(
  {
    step: String,
    label: String,
    status: { type: String, default: 'ok' },
    durationMs: Number,
  },
  { _id: false },
);

/** Un déploiement passé — succès comme échec. */
const historyEntrySchema = new mongoose.Schema(
  {
    at: { type: String, required: true },
    operationType: { type: String, default: 'DEPLOYMENT' },
    version: { type: String, default: null },
    user: { type: String, default: null },
    durationMs: { type: Number, default: null },
    success: { type: Boolean, default: false },
    failedStep: { type: String, default: null },
    error: { type: String, default: null },
    steps: { type: [historyStepSchema], default: [] },
  },
  { _id: false },
);

const targetSchema = new mongoose.Schema(
  {
    targetId: { type: String, required: true, unique: true },

    name: { type: String, required: true, trim: true },
    // URL COMPLÈTE — la seule saisie de domaine. Tout le reste en découle.
    url: { type: String, required: true, trim: true },

    /**
     * QUEL PROJET vit ici — déclaré, jamais deviné.
     *
     * Deux destinations partagent une identité UNIQUEMENT si un opérateur
     * l'a dit. Ni la base, ni le domaine, ni le serveur ne créent cette
     * parenté : deux projets distincts peuvent partager les trois.
     *
     * C'est ce lien, et lui seul, qui autorise une migration de médias.
     */
    projectIdentityId: { type: String, default: null, index: true },

    /**
     * Cycle de vie de la DESTINATION, distinct de l'état du dernier
     * déploiement. `EMPTY` : les fichiers ont été retirés du serveur, la
     * fiche subsiste.
     */
    lifecycleStatus: {
      type: String,
      enum: ['ACTIVE', 'DEPROVISIONING', 'EMPTY', 'DEPROVISION_FAILED'],
      default: 'ACTIVE',
    },
    // Dernier run réellement validé : ce qui fait d'un emplacement une source sûre.
    lastHealthyDeploymentRunId: { type: String, default: null },
    // Emplacement courant sur le serveur, tel que déployé.
    currentSiteRoot: { type: String, default: null },
    // Destination que celle-ci remplace, quand elle a été créée comme suite.
    previousTargetId: { type: String, default: null },

    // Déductions de `parseTargetUrl`, recalculées à chaque enregistrement.
    // Stockées pour être filtrables et affichables sans relancer le moteur.
    host: { type: String, required: true, lowercase: true, unique: true },
    type: { type: String, enum: ['subdomain', 'domain'], required: true },
    registrableDomain: { type: String, default: null },
    subdomain: { type: String, default: null },
    wildcardBase: { type: String, default: null },

    // ENVIRONNEMENT DÉPLOYÉ. Décide de la base (DB_TEST/DB_PROD) écrite dans
    // le .env distant. Une destination TEST et une destination PROD sur le
    // même serveur restent donc étanches.
    environment: { type: String, enum: ['TEST', 'PROD'], required: true },

    // Serveur. Le mot de passe n'y figure pas — voir l'en-tête.
    sshHost: { type: String, default: null },
    sshUser: { type: String, default: 'root' },
    sshPort: { type: Number, default: 22 },

    // Port local d'écoute du backend (PM2 + proxy nginx).
    backendPort: { type: Number, required: true },
    // Racine des déploiements sur le serveur.
    remoteRoot: { type: String, default: '/var/www' },
    // Base MongoDB de la destination (sauvegardes, diagnostic).
    dbName: { type: String, default: null },

    // Variables ajoutées au `.env` distant, en plus de celles que le moteur
    // dérive. JAMAIS de secret : le profil impose déjà les obligatoires, et
    // ceux-là sont fournis au moment du déploiement.
    extraEnv: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Contact Let's Encrypt pour l'émission du certificat.
    certbotEmail: { type: String, default: null },

    // ── AUTO-DÉPLOIEMENT ────────────────────────────────────────────────
    // Vrai quand cette destination héberge le Panel qui pilote. Le
    // déploiement y coupe la main qui le tient : il DOIT passer par le
    // processus détaché. Déduit de l'URL publique du Panel, jamais saisi.
    selfHosted: { type: Boolean, default: false },

    state: {
      type: String,
      enum: ['NEW', 'DEPLOYING', 'DEPLOYED', 'FAILED'],
      default: 'NEW',
    },
    currentVersion: { type: String, default: null },
    currentReleaseId: { type: String, default: null },
    lastDeployedAt: { type: String, default: null },
    lastRunId: { type: String, default: null },

    history: { type: [historyEntrySchema], default: [] },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

targetSchema.index({ environment: 1 });

/** Historique borné — il ne doit pas croître sans fin. */
targetSchema.methods.pushHistory = function pushHistory(entry, max = 50) {
  this.history.unshift(entry);
  if (this.history.length > max) this.history = this.history.slice(0, max);
};

export default mongoose.model('PanelDeploymentTarget', targetSchema);
