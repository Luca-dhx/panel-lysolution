// Fiche du registre des projets — docs/architecture/02_PROJECT_REGISTRY.md.
// Le document reflète EXACTEMENT la fiche manipulée par les services : les
// horodatages restent des chaînes ISO gérées par la couche service (nowIso),
// comme dans le reste du contrat.
// Sécurité : jamais un secret en clair — pairingCode et bridgeToken en hash
// SHA-256 ; copie du bridgeToken chiffrée AES-256-GCM (panelCrypto) réservée
// aux appels sortants.
import mongoose from 'mongoose';

import { COMMERCIAL_STATE_VALUES } from '../services/integratedApi/commercialReadiness.js';

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
     * IDENTITÉ LOGIQUE — CHAMP GELÉ, conservé pour les fiches historiques.
     *
     * ══ CE QU'IL FAISAIT ════════════════════════════════════════════════════
     *
     * Il portait la clé que le projet annonce au pont (`bridgeIdentity
     * .projectKey`), identique pour toutes ses instances, et permettait
     * d'afficher la recette et la production d'un même client sous une seule
     * carte.
     *
     * ══ POURQUOI IL NE PILOTE PLUS RIEN ═════════════════════════════════════
     *
     * Une INSTANCE de Panel ne sert qu'un environnement : `pairing.bootstrap`
     * refuse tout projet dont l'environnement ne concorde pas avec le sien
     * (fail closed, et c'est une protection qu'on garde). Une carte « recette +
     * production » ne pouvait donc jamais porter deux fiches VIVANTES : la
     * seconde était toujours une fiche jamais appairée, présentée comme un
     * constat, avec un bouton d'appairage qui menait à une impasse.
     *
     * La doctrine est désormais : 1 fiche = 1 appairage = 1 instance = 1
     * environnement = 1 destination = 1 état métier.
     *
     * ══ POURQUOI LE CHAMP RESTE ═════════════════════════════════════════════
     *
     * Des fiches en production le portent. Le retirer du schéma serait
     * détruire une donnée historique pour un gain nul. Il reste donc nullable
     * et inerte : plus AUCUNE écriture ne le renseigne, plus aucune lecture ne
     * s'en sert, et l'API publique ne le transporte plus.
     */
    logicalProjectKey: { type: String, default: null },
    /**
     * L'ENVIRONNEMENT SAISI À LA DÉCLARATION — anti-collision, et rien d'autre.
     *
     * ══ CE QU'IL N'EST PLUS ═════════════════════════════════════════════════
     *
     * Il servait à afficher un environnement avant le premier contact. C'était
     * présenter une INTENTION comme un CONSTAT : une fiche jamais appairée
     * annonçait « TEST » ou « PROD » avec la même assurance qu'une instance
     * vivante, alors que personne n'avait encore parlé.
     *
     * `declaredEnvironmentOf` ne le lit plus. Avant appairage, l'environnement
     * d'une fiche est `null` — « non connu », et l'écran le dit.
     *
     * ══ SON SEUL EMPLOI SURVIVANT ═══════════════════════════════════════════
     *
     * Départager deux clés techniques identiques (`<cle>-prod`). C'est
     * purement technique : cette valeur ne s'affiche nulle part et ne
     * détermine ni périmètre métier, ni destination.
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

    /**
     * OUVERTURE COMMERCIALE — « cette instance a-t-elle le droit d'agir pour de
     * vrai ? ». Vocabulaire et politique : `integratedApi/commercialReadiness.js`.
     *
     * ══ POURQUOI ICI, ET NON SUR LE CONTRAT ═════════════════════════════════
     *
     * L1.75 a livré la primitive sans persistance, en désignant la passerelle
     * de capacités comme son seul lecteur prévu. C'est L3 qui la lit, donc L3
     * qui devait choisir où elle vit. La fiche de projet est le bon endroit :
     * l'ouverture qualifie une INSTANCE — celle qui invoque — et non un contrat,
     * qui peut manquer, être multiple, ou être précisément ce qu'on cherche à
     * signer.
     *
     * ══ POURQUOI NULLABLE, ET NON `PREOPENING` PAR DÉFAUT ═══════════════════
     *
     * `null` se lit « jamais renseigné », et la passerelle le résout vers
     * `DEFAULT_COMMERCIAL_STATE` (= PREOPENING), donc vers le refus. Écrire la
     * valeur par défaut en base ferait croire à une décision prise ; le nul dit
     * la vérité, et le comportement reste fermé.
     *
     * JAMAIS transmis au projet : c'est une décision du Panel sur le projet, pas
     * une donnée du projet.
     */
    commercialState: {
      type: String,
      // Vocabulaire IMPORTÉ, jamais recopié : une liste écrite à la main ici
      // accepterait un jour une valeur que la politique ne reconnaît pas, et
      // le projet retomberait silencieusement sur le défaut fermé — un refus
      // parfaitement inexplicable depuis l'écran qui vient de saisir « ouvert ».
      enum: [...COMMERCIAL_STATE_VALUES, null],
      default: null,
    },

    /**
     * CAPACITÉS ACCORDÉES À CE PROJET — l'unique autorité d'autorisation (L3).
     *
     * ══ CE QUI REMPLACE QUOI ════════════════════════════════════════════════
     *
     * `PanelIntegratedApi.grants[]` (modèle legacy) disait « ce projet reçoit
     * ces CLÉS ». L4 a supprimé la diffusion, donc l'octroi ne gouvernait plus
     * rien. Ici, l'octroi porte sur une INTENTION MÉTIER : le projet ne reçoit
     * jamais de clé, il obtient le droit de demander une action.
     *
     * L'ancien tableau n'est PAS lu par la passerelle — pas même en repli. Deux
     * systèmes d'autorisation dont l'un est plus permissif finissent toujours
     * par être interrogés dans le mauvais ordre.
     *
     * Vide par défaut : un projet appairé ne peut RIEN tant qu'on ne lui a rien
     * accordé. Chaque valeur est validée contre le registre code-first à
     * l'écriture — un code inconnu ne peut pas être stocké.
     */
    capabilityGrants: { type: [String], default: [] },
  },
  { minimize: false, versionKey: false },
);

/**
 * INDEX CONSERVÉ AVEC LE CHAMP — non unique, et désormais sans lecteur.
 *
 * Plus aucune requête n'interroge `logicalProjectKey` : l'index ne sert plus
 * rien. Il est laissé en place parce que le supprimer déclencherait, au
 * premier démarrage suivant, une opération de schéma sur une base de
 * production — pour économiser quelques kilo-octets sur un parc qui compte
 * une poignée de fiches. Le retirer relèvera d'une migration décidée, pas
 * d'un effet de bord de nettoyage.
 */
panelProjectSchema.index({ logicalProjectKey: 1 });

export default mongoose.model('PanelProject', panelProjectSchema);
