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
    /**
     * QUAND LE PANEL A RÉELLEMENT REÇU ET APPLIQUÉ UN ÉTAT MÉTIER.
     *
     * ── POURQUOI CE CHAMP EXISTE, À CÔTÉ DU BATTEMENT DE CŒUR ──────────────
     * `lastHeartbeatAt` répond à « cette instance répond-elle ? ». Il ne dit
     * RIEN de ses données : un projet peut battre toutes les trente secondes
     * pendant des jours sans jamais rien projeter — c'est même le cas normal
     * d'un projet dont l'entreprise ne change pas. Présenter le battement
     * comme une preuve de fraîcheur métier était le raccourci qui faisait
     * afficher « à jour » à une fiche qui n'avait jamais rien reçu.
     *
     * ── POURQUOI IL EST PERSISTÉ, ET NON DÉDUIT ───────────────────────────
     * On savait le déduire : `max(receivedAt)` sur les projections stockées.
     * Mais cette déduction ment dans trois cas — un tombstone efface la
     * projection et fait RECULER la date ; un `TEAM_MEMBER` reçu ne compte
     * pas ; et une réception qui n'a rien changé n'y laisse aucune trace.
     * Une observation ne se recalcule pas : on l'inscrit à l'instant où elle
     * a lieu, une seule fois, là où l'application réussit.
     *
     * Écrit UNIQUEMENT par le noyau de synchronisation, après application
     * effective d'une entité métier. Ni le heartbeat, ni une lecture, ni le
     * manifeste, ni une découverte ne l'avancent.
     */
    lastBusinessSyncAt: { type: String, default: null },
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
    // D'OÙ vient la clé — jamais d'une saisie. `BRIDGE_KEY` signifie que le
    // projet l'a annoncée lui-même (contrat >= 1.4.0) : c'est la seule source
    // vraie par construction. Les autres sont des dérivations, réconciliées
    // avec la valeur du projet au bootstrap. `null` = fiche antérieure à la
    // génération automatique, laissée intacte.
    projectKeySource: {
      type: String,
      enum: ['BRIDGE_KEY', 'BRIDGE_NAME', 'NAME', 'URL', 'RECONCILED', null],
      default: null,
    },
    /**
     * IDENTITÉ LOGIQUE — « ces deux fiches sont le même projet client ».
     *
     * ══ CE QUE CE CHAMP FERME ═══════════════════════════════════════════════
     *
     * Une fiche du registre est UNE INSTANCE appairée : un appairage, un jeton,
     * un environnement. C'est volontaire et ce champ n'y touche pas. Mais un
     * même projet client vit en TEST *et* en PROD — deux bases, deux jetons,
     * donc deux fiches — et RIEN ne disait qu'elles se rapportaient au même
     * client. L'écran ne pouvait qu'aligner des appairages techniques
     * indépendants, et l'opérateur devait faire le rapprochement de tête.
     *
     * ══ D'OÙ ELLE VIENT, ET POURQUOI PAS D'UNE RESSEMBLANCE ═════════════════
     *
     * De la CLÉ QUE LE PROJET ANNONCE lui-même au pont (`bridgeIdentity
     * .projectKey`, contrat >= 1.4.0) — la même source que le Panel tient déjà
     * pour la plus autoritaire (`projectKeySource: 'BRIDGE_KEY'`). Deux
     * instances d'un même projet la produisent identique par construction : le
     * déploiement embarque le `.env` du projet VERBATIM et ne réécrit que ce
     * qui est propre à l'hôte (ENV, PORT, CORS, PUBLIC_URL).
     *
     * Ce n'est donc ni une saisie, ni une similarité de nom ou de domaine :
     * c'est une égalité exacte entre deux valeurs déclarées.
     *
     * ══ CE QU'ELLE N'EST PAS ════════════════════════════════════════════════
     *
     * Ni une identité d'appairage, ni une clé technique de fiche
     * (`projectKey` reste unique et propre à l'instance), ni une donnée que le
     * Panel transmet. Elle n'entre dans AUCUN calcul de génération, de
     * fraîcheur, de heartbeat ni de snapshot.
     *
     * `null` est une valeur normale : les fiches antérieures — et celles dont
     * le projet ne déclare aucune clé — n'en ont pas, et se comportent
     * exactement comme avant, chacune seule de son groupe.
     */
    logicalProjectKey: { type: String, default: null },
    /**
     * L'ENVIRONNEMENT QUE CETTE FICHE EST CENSÉE SERVIR — l'intention.
     *
     * `runtime.environment` est le CONSTAT : ce que le projet affirme à chaque
     * battement, et la seule valeur qui entre dans la génération. Elle n'existe
     * qu'après le premier contact. Il fallait pourtant pouvoir dire, dès la
     * déclaration, « celle-ci sera la production » — sinon deux fiches d'un
     * même projet ne peuvent pas être distinguées avant leur premier battement.
     *
     * Les deux ne fusionnent jamais : le Panel ne décide pas de
     * l'environnement d'un projet, il enregistre une intention que le projet
     * confirmera.
     */
    declaredEnvironment: { type: String, enum: ['TEST', 'PROD', null], default: null },
    projectName: { type: String, required: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    pairing: { type: pairingSchema, required: true },
    runtime: { type: runtimeSchema, required: true },
    manifest: { type: mongoose.Schema.Types.Mixed, default: null },
    manifestSource: { type: String, enum: ['BRIDGE', 'MANUAL', null], default: null },
    manifestUpdatedAt: { type: String, default: null },
    // CONVERGENCE (Phase 4) — ce que le projet déclare avoir APPLIQUÉ de ce
    // que le Panel lui a envoyé. Relevé lors d'une découverte, jamais déduit.
    // `null` tant qu'aucune découverte n'a eu lieu : « inconnu » et « rien
    // appliqué » ne doivent pas se confondre.
    appliedConfiguration: { type: mongoose.Schema.Types.Mixed, default: null },

    // Note de supervision libre, saisie côté Panel. C'est la SEULE donnée du
    // registre qui n'est pas dérivée du projet — elle ne lui est jamais
    // transmise et n'influence aucun calcul.
    note: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * Le regroupement se lit, il ne se cherche pas. Index NON unique : plusieurs
 * fiches partagent volontairement la même identité logique — c'est tout
 * l'objet du champ. L'unicité qui compte (une fiche par environnement dans un
 * groupe) est un invariant MÉTIER, vérifié à la déclaration : l'imposer par un
 * index partiel sur deux champs dont l'un est renseigné après coup (le
 * `runtime.environment` vient du premier battement) ferait échouer des
 * écritures parfaitement légitimes.
 */
panelProjectSchema.index({ logicalProjectKey: 1 });

export default mongoose.model('PanelProject', panelProjectSchema);
