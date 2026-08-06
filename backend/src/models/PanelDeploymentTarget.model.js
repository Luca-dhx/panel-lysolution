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
     * CYCLE DE VIE DE LA DESTINATION, distinct de l'état du dernier
     * déploiement.
     *
     * ── LE DÉFAUT CORRIGÉ ────────────────────────────────────────────────
     * Supprimer une fiche ne retirait rien du serveur : process PM2 en ligne
     * détenant le port, configuration Nginx active, 49 Mo de fichiers. La
     * fiche disparue, plus personne ne savait qu'il restait quelque chose à
     * nettoyer — et l'allocation de port a recyclé un numéro encore détenu.
     *
     * Une destination ACTIVE ne peut donc plus être supprimée. Elle doit
     * d'abord être VIDÉE :
     *
     *   ACTIVE → DEPROVISIONING → EMPTY → DELETED
     *                  ↓
     *          DEPROVISION_FAILED  (reprenable)
     *
     * `EMPTY` : les fichiers ont été retirés du serveur, la fiche subsiste.
     * `DELETED` : suppression LOGIQUE — la fiche sort des listes actives,
     * son audit et son historique restent lisibles.
     */
    lifecycleStatus: {
      type: String,
      enum: ['ACTIVE', 'DEPROVISIONING', 'EMPTY', 'DEPROVISION_FAILED', 'DELETED'],
      default: 'ACTIVE',
      index: true,
    },
    // ── HORODATAGE DU RETRAIT ───────────────────────────────────────────
    // Chaque transition laisse sa date. Un retrait qui a échoué garde la
    // date de son échec ET celle de son démarrage : reprendre n'efface pas
    // la trace de la tentative précédente.
    deprovisionStartedAt: { type: String, default: null },
    deprovisionCompletedAt: { type: String, default: null },
    deprovisionFailedAt: { type: String, default: null },
    lastDeprovisionRunId: { type: String, default: null },
    emptiedAt: { type: String, default: null },
    deletedAt: { type: String, default: null },
    // Dernière erreur connue sur cette destination (retrait ou déploiement).
    lastError: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * Une quarantaine Nginx (410 Gone) est-elle installée sur ce domaine ?
     *
     * Posée pendant le retrait, AVANT la suppression des fichiers : sans
     * elle, le domaine retomberait sur le `default_server` du serveur et
     * servirait le site d'un AUTRE projet. Elle n'est levée qu'à la
     * suppression définitive de la fiche.
     */
    quarantineEnabled: { type: Boolean, default: false },

    /**
     * Run de déploiement actuellement en cours sur cette destination.
     *
     * C'est le verrou lisible : tant qu'il est posé, aucun retrait ne peut
     * démarrer. Effacé par la conclusion du run, quelle qu'elle soit.
     */
    activeDeploymentRunId: { type: String, default: null },

    // Dernier run réellement validé : ce qui fait d'un emplacement une source sûre.
    lastHealthyDeploymentRunId: { type: String, default: null },
    // Emplacement courant sur le serveur, tel que déployé.
    currentSiteRoot: { type: String, default: null },
    // Destination que celle-ci remplace, quand elle a été créée comme suite.
    previousTargetId: { type: String, default: null },

    // Déductions de `parseTargetUrl`, recalculées à chaque enregistrement.
    // Stockées pour être filtrables et affichables sans relancer le moteur.
    /**
     * L'hôte est UNIQUE parmi les destinations VIVANTES, pas dans l'absolu.
     *
     * L'unicité absolue interdisait de recréer une destination sur un domaine
     * dont la fiche avait été supprimée — alors que c'est précisément le
     * scénario normal après un retrait : on vide, on supprime, et le domaine
     * redevient disponible. L'index partiel (voir plus bas) exprime cette
     * règle sans obliger le service à être le seul garde-fou.
     */
    host: { type: String, required: true, lowercase: true },
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

/**
 * Unicité de l'hôte parmi les destinations VIVANTES.
 *
 * Une fiche `DELETED` conserve son hôte — c'est ce qui rend son audit
 * relisible — mais ne réserve plus le domaine. L'index PARTIEL dit exactement
 * cela ; un index unique classique disait autre chose et interdisait de
 * redéployer un domaine qu'on venait de libérer.
 */
targetSchema.index(
  { host: 1 },
  { unique: true, partialFilterExpression: { lifecycleStatus: { $ne: 'DELETED' } } },
);

/** Historique borné — il ne doit pas croître sans fin. */
targetSchema.methods.pushHistory = function pushHistory(entry, max = 50) {
  this.history.unshift(entry);
  if (this.history.length > max) this.history = this.history.slice(0, max);
};

export default mongoose.model('PanelDeploymentTarget', targetSchema);
