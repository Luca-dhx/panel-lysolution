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
    /**
     * QUI PARLE — la lignée de runtime retenue, et celle qu'on a écartée.
     *
     * `Mixed` parce que ce sont des constats d'observation, pas un modèle
     * métier : trois champs plats, remplacés en bloc à chaque battement.
     */
    lineage: { type: mongoose.Schema.Types.Mixed, default: null },
    lineageSetAside: { type: mongoose.Schema.Types.Mixed, default: null },
    /**
     * DEUX RUNTIMES POUR UN SEUL PROJET — non nul = constat POSÉ.
     *
     * Le Panel n'en élit aucun : le jeton de pont est la seule identité, et
     * deux détenteurs légitimes sont indiscernables. Il nomme, un humain
     * tranche — même doctrine que l'enlisement d'un rejeu.
     */
    rivalRuntime: { type: mongoose.Schema.Types.Mixed, default: null },
    /**
     * L'ADRESSE PUBLIQUE DE L'API — VIVANTE depuis le contrat 1.9.0.
     *
     * ══ CE QU'ELLE ÉTAIT, ET POURQUOI C'ÉTAIT FAUX ═══════════════════════════
     *
     * Elle était écrite au BOOTSTRAP et plus jamais relue. Un projet redéployé
     * ailleurs gardait donc ici l'adresse du jour de son appairage — un ancien
     * domaine que plus rien ne servait, présenté comme courant. La seule façon
     * de la corriger était de réappairer : détruire une relation de confiance
     * pour rafraîchir une donnée d'exploitation.
     *
     * ══ L'INVARIANT QUI LA GOUVERNE DÉSORMAIS ═══════════════════════════════
     *
     *     l'appairage est une relation d'IDENTITÉ et de CONFIANCE
     *     l'URL publique est un ÉTAT COURANT du projet
     *
     * Les deux n'ont pas le même cycle de vie, et rien ne justifie que le
     * second soit figé par le premier. Une adresse n'est jamais immuable parce
     * qu'elle existait au moment de l'appairage.
     *
     * Elle est donc RAFRAÎCHIE par tout ce que le projet déclare — battement
     * (>= 1.9.0) et projection de présentation (>= 1.4.x) — et le bootstrap
     * n'est plus qu'un premier contact. Voir `applyDeclaredNetwork()`.
     */
    publicBackendUrl: { type: String, default: null },
    /**
     * QUAND CETTE ADRESSE A ÉTÉ DÉCLARÉE, et PAR QUEL CANAL.
     *
     * Sans eux, un écran ne peut pas distinguer « confirmée il y a trente
     * secondes » de « jamais revue depuis l'appairage » — et c'est exactement
     * la différence que ce lot existe pour rendre visible. Une adresse dont on
     * ignore l'âge est une adresse qu'on ne peut pas mettre en doute.
     */
    publicBackendUrlUpdatedAt: { type: String, default: null },
    /** `BOOTSTRAP` | `HEARTBEAT` | `PRESENTATION` — jamais deviné. */
    publicBackendUrlSource: { type: String, default: null },
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
    /**
     * L'ÉTAT D'ALERTE DU PONT — la MÉMOIRE qui empêche de crier en boucle.
     *
     * ══ POURQUOI IL EST PERSISTÉ, ET NON GARDÉ EN MÉMOIRE ═══════════════════
     *
     * Le battement arrive toutes les minutes. Sans mémoire durable, chaque
     * redémarrage du Panel rouvrirait toutes les alertes du parc et
     * réexpédierait tout — c'est-à-dire précisément la panne d'alerting que ce
     * lot existe pour éviter. Une mémoire de processus n'aurait tenu que le
     * temps d'une release.
     *
     * ══ CE QU'IL PORTE ═════════════════════════════════════════════════════
     *
     *   since           quand la dégradation a COMMENCÉ. Ne bouge pas tant
     *                   qu'elle dure : c'est ce qui rend l'identité d'un envoi
     *                   reproductible sans horloge.
     *   state           `DEGRADED`, ou le champ vaut `null` — il n'y a pas
     *                   d'état « sain » à écrire, l'absence le dit déjà.
     *   reasons         les motifs constatés, pour la chronologie.
     *   lastNotifiedAt  le dernier envoi RÉEL. C'est lui qui gouverne le
     *                   refroidissement.
     *   notifiedCount   combien de rappels sont partis. À zéro, un
     *                   rétablissement ne s'annonce pas : personne n'a jamais
     *                   appris la panne.
     *
     * `Mixed` volontairement, comme `bridgeStats` : ce bloc décrit un état
     * d'exploitation, pas un objet de contrat. Le figer champ par champ
     * obligerait à une migration au premier motif qui s'ajoute.
     */
    bridgeAlert: { type: mongoose.Schema.Types.Mixed, default: null },
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
     * L'ENTREPRISE CLIENTE À QUI CE PROJET APPARTIENT — un lien, jamais une copie.
     *
     * ══ POURQUOI UN IDENTIFIANT SEUL, ET SURTOUT PAS UN INSTANTANÉ ══════════
     *
     * La tentation était d'y recopier la raison sociale « pour éviter une
     * jointure ». Ce serait installer une seconde vérité : le jour d'un
     * changement de dénomination, la fiche du registre annoncerait l'ancienne
     * pendant que l'écran Clients annoncerait la nouvelle, et rien ne dirait
     * laquelle a servi à facturer.
     *
     * L'AUTORITÉ est `PanelClientCompany`. Ici il n'y a qu'un renvoi.
     *
     * ══ ET L'HISTOIRE, ALORS ? ══════════════════════════════════════════════
     *
     * Elle ne passe pas par ce champ. Les factures, contrats et demandes de
     * signature portent chacun l'INSTANTANÉ légal utilisé au moment de l'acte
     * (`clientLegalSnapshot.js`). Changer ce lien n'en réécrit aucun : il
     * décide des opérations À VENIR, et d'elles seules.
     *
     * ══ POURQUOI IL VIT SUR LE PROJET ET NON SUR L'ENTREPRISE ═══════════════
     *
     * Parce que la cardinalité est 1 → N : une entreprise possède plusieurs
     * projets, un projet appartient à au plus une entreprise. Porter une liste
     * du côté de l'entreprise autoriserait deux entreprises à revendiquer le
     * même projet, et il faudrait alors arbitrer. Un champ unique du côté
     * « plusieurs » rend la contradiction inexprimable.
     *
     * `null` — ou champ absent — se lit « aucun client légal rattaché ». Ce
     * n'est pas un état transitoire à combler par un défaut : c'est l'état
     * d'un projet qui NE PEUT NI PAYER NI SIGNER, et les gardes s'y fient.
     */
    clientCompanyId: { type: String, default: null, index: true },

    /**
     * ── CINQ CHAMPS ONT ÉTÉ RETIRÉS DE CE SCHÉMA ──────────────────────────────
     *
     *   commercialState             l'ouverture commerciale (PREOPENING | LIVE)
     *   commercialStateUpdatedAt    qui l'a décidée, quand, et pourquoi
     *   commercialStateUpdatedBy
     *   commercialStateReason
     *   capabilityGrants            les capacités cochées projet par projet
     *
     * Ils ne sont pas seulement devenus inertes : ils ont été SUPPRIMÉS du
     * schéma, et une migration les efface des fiches existantes
     * (`scripts/migrations/2026-08-15-drop-capability-grants-and-commercial-state.js`).
     *
     * ══ POURQUOI SUPPRIMER PLUTÔT QUE CONSERVER « POUR COMPATIBILITÉ » ═══════
     *
     * Un champ d'autorisation laissé en base est un champ qu'on relira. Il n'a
     * pas besoin d'être branché pour nuire : il suffit qu'il apparaisse dans un
     * document pour qu'un lecteur suppose qu'il gouverne quelque chose, et
     * qu'une garde soit réécrite « pour le respecter ». C'est exactement
     * l'histoire de `PanelIntegratedApi.grants[]`, conservé pour ne pas
     * détruire une saisie manuelle, et qu'il a fallu documenter pendant des
     * lots entiers comme « présent mais sans lecteur ».
     *
     * ══ CE QUI AUTORISE UNE INVOCATION DÉSORMAIS ════════════════════════════
     *
     * Le jeton de pont établit QUI parle ; le runtime établit QUEL MONDE ; le
     * schéma d'entrée établit CE QUI est demandé ; et l'adaptateur établit À QUI
     * appartient la ressource visée. Aucune de ces quatre réponses ne se coche
     * à la main, et c'est ce qui les rend fiables.
     */
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
