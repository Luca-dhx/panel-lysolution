/**
 * PROJECTIONS MÉTIER D'UN PROJET — ce que le Panel AFFICHE, jamais ce qu'il
 * possède.
 *
 * ── RÈGLE DE PROPRIÉTÉ ──────────────────────────────────────────────────────
 * Le projet reste la source de vérité de son identité et de son contrat. Ces
 * collections n'en sont qu'une photographie, reçue par le pont et rafraîchie à
 * chaque modification. Le Panel ne les modifie jamais de lui-même : un écran
 * qui écrirait ici ferait diverger les deux systèmes en silence.
 *
 * ── POURQUOI DES COLLECTIONS DÉDIÉES ────────────────────────────────────────
 * Le registre (`PanelProject`) porte l'état TECHNIQUE : appairage, versions,
 * santé. Y mélanger l'identité commerciale et le contrat rendrait impossible
 * de distinguer ce que le Panel constate de ce que le projet lui déclare.
 *
 * `sourceModifiedAt` est l'horodatage posé par l'ÉMETTEUR : c'est lui qui
 * arbitre (dernier écrit gagne), jamais l'heure de réception.
 */
import mongoose from 'mongoose';

/**
 * D'OÙ vient cette photographie — l'environnement et la génération du projet
 * au moment où elle a été reçue. Sans cela, une projection PROD conservée
 * après un redéploiement en TEST se présentait comme l'état courant.
 */
const SOURCE_FIELDS = {
  sourceEnvironment: { type: String, default: null },
  sourceGeneration: { type: String, default: null },
  sourceSoftwareVersion: { type: String, default: null },
};

const contactsSchema = new mongoose.Schema(
  {
    email: { type: String, default: null },
    phone: { type: String, default: null },
    website: { type: String, default: null },
  },
  { _id: false },
);

const networkSchema = new mongoose.Schema(
  {
    website: { type: String, default: null },
    manager: { type: String, default: null },
    backend: { type: String, default: null },
  },
  { _id: false },
);

const presentationSchema = new mongoose.Schema(
  {
    // UN enregistrement par projet : l'identité est un état, pas un journal.
    projectId: { type: String, required: true, unique: true, index: true },
    companyName: { type: String, default: null },
    tagline: { type: String, default: null },
    logoUrl: { type: String, default: null },
    faviconUrl: { type: String, default: null },
    /**
     * LE DESCRIPTEUR COMPLET DU MÉDIA — l'adresse seule ne suffit pas.
     *
     * Elle ne dit ni si l'image a changé (aucune empreinte), ni son type, ni
     * ses dimensions, ni qui la détient. `Mixed` volontairement : le
     * descripteur est un objet de CONTRAT, validé par
     * `mediaDescriptorSchema` à l'entrée. Le redéclarer champ par champ ici
     * créerait une seconde définition à maintenir — et c'est exactement le
     * genre de divergence qui a produit le refus que ce champ répare.
     *
     * `null` est SIGNIFIANT : le projet publie la suppression de son média.
     */
    logo: { type: mongoose.Schema.Types.Mixed, default: null },
    favicon: { type: mongoose.Schema.Types.Mixed, default: null },
    contacts: { type: contactsSchema, default: () => ({}) },
    projectName: { type: String, default: null },
    description: { type: String, default: null },
    network: { type: networkSchema, default: () => ({}) },
    sourceModifiedAt: { type: String, required: true },
    ...SOURCE_FIELDS,
    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * ÉTAT D'ACCESSIBILITÉ DU SITE — un enregistrement par instance.
 *
 * ── CE QUE SA SEULE EXISTENCE CHANGE ────────────────────────────────────────
 * Cet état n'était persisté NULLE PART côté Panel : la carte l'obtenait en
 * interrogeant le projet en direct, à chaque affichage. Un projet éteint
 * rendait donc l'information « inconnue », alors que la dernière valeur reçue
 * — datée — aurait parfaitement répondu à la question posée.
 *
 * AGRÉGAT SÉPARÉ de `PanelProjectContract`, et il doit le rester : une
 * suspension technique n'est pas un fait contractuel.
 */
const siteStatusSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, unique: true, index: true },
    /** Le verdict, tel que le projet le rend. Jamais recalculé ici. */
    accessible: { type: Boolean, default: true },
    status: { type: String, default: 'ACTIVE' },
    /** NONE · TECHNICAL · CONTRACT — la cause, nommée par sa source. */
    suspensionSource: { type: String, default: 'NONE' },
    reason: { type: String, default: null },
    suspendedAt: { type: String, default: null },
    /** Le RÉGLAGE, vrai même lorsqu'il ne produit aucun effet. */
    contractProtectionEnabled: { type: Boolean, default: false },
    technicalSuspension: { type: Boolean, default: false },
    /**
     * L'INSTANTANÉ DES CAUSES (L10.6A) — la preuve autoritative dont le Panel a
     * besoin pour confirmer sa cause financière sans la confondre avec la cause
     * DOMINANTE. `null` se lit « projet antérieur au lot », pas « aucune cause ».
     */
    causes: {
      technical: { type: Boolean, default: null },
      contract: { type: Boolean, default: null },
      paymentDefault: { type: Boolean, default: null },
    },
    sourceModifiedAt: { type: String, required: true },
    ...SOURCE_FIELDS,
    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * LA RÉCURRENCE PROJETÉE — « tous les <interval> <unit> », telle que le projet
 * la dit. Jamais recalculée ici : le Panel reflète un engagement contractuel,
 * il ne l'interprète pas.
 *
 * `null` se lit « projection antérieure au lot récurrence », et surtout pas
 * « tous les mois » — c'est `interval` (hérité) qui répond alors. Voir
 * `lib/contractRecurrence` côté écran et `stripePriceAuthority` côté tarif.
 */
const recurrenceSchema = new mongoose.Schema(
  {
    unit: { type: String, default: null },
    interval: { type: Number, default: null },
  },
  { _id: false },
);

const amountSchema = new mongoose.Schema(
  {
    amountIncludingTax: { type: Number, default: null },
    /**
     * LA VENTILATION FISCALE DE LA LIGNE — reçue, jamais recalculée.
     *
     * ══ POURQUOI ELLE EST PERSISTÉE, ALORS QU'ON POURRAIT LA DÉDUIRE ═══════
     *
     * Parce que la déduction ne rend pas toujours le même centime que le
     * contrat. Le projet part du HT et arrondit la TVA ; une déduction part du
     * TTC et arrondit le HT. L'écart d'un centime entre le contrat SIGNÉ et la
     * facture ÉMISE est la plus indéfendable des incohérences.
     *
     * `null` se lit « projection antérieure au contrat de pont 1.10.0 », et
     * surtout pas « zéro ». La facturation REFUSE alors de ventiler plutôt que
     * de supposer un taux — voir `contractFiscalLine.js`.
     */
    amountExcludingTax: { type: Number, default: null },
    taxAmount: { type: Number, default: null },
    /** Le taux de CETTE ligne, en POURCENTAGE. Prime sur celui du contrat. */
    taxRate: { type: Number, default: null },
    currency: { type: String, default: null },
    recurrence: { type: recurrenceSchema, default: null },
    /** Libellé prêt à l'affichage, publié par le projet. Jamais la source. */
    recurrenceLabel: { type: String, default: null },
    /** HÉRITAGE : l'UNITÉ seule (`MONTH`/`YEAR`), sous son ancien nom. */
    interval: { type: String, default: null },
  },
  { _id: false },
);

const documentSchema = new mongoose.Schema(
  {
    available: { type: Boolean, default: false },
    status: { type: String, default: 'NONE' },
    downloadAvailable: { type: Boolean, default: false },
    filename: { type: String, default: null },
    pages: { type: Number, default: 0 },
    sha256: { type: String, default: null },
    version: { type: Number, default: 0 },
    /** Le parcours EXIGE-t-il une signature ? `null` = projection antérieure. */
    signatureRequired: { type: Boolean, default: null },
    signatureStatus: { type: String, default: null },
    signedAt: { type: String, default: null },
    generatedAt: { type: String, default: null },
    downloadPath: { type: String, default: null },
  },
  { _id: false },
);

/** Un contrat PASSÉ : tout ce qu'il faut pour le consulter, rien de plus. */
const previousContractSchema = new mongoose.Schema(
  {
    sourceContractId: { type: String, required: true },
    status: { type: String, required: true },
    reference: { type: String, default: null },
    createdAt: { type: String, default: null },
    activatedAt: { type: String, default: null },
    endedAt: { type: String, default: null },
    cancellationReason: { type: String, default: null },
    document: { type: documentSchema, default: () => ({}) },
    pricing: {
      subscription: { type: amountSchema, default: null },
      launchFee: { type: amountSchema, default: null },
    },
  },
  { _id: false },
);

const contractSchema = new mongoose.Schema(
  {
    // UN contrat courant par projet. Le projet choisit lequel il publie (règle
    // déterministe côté projet) : le Panel n'arbitre pas entre plusieurs
    // contrats, il reçoit celui qui fait foi.
    projectId: { type: String, required: true, unique: true, index: true },
    /**
     * Y A-T-IL UN CONTRAT ACTUEL ?
     *
     * `sourceContractId` et `status` n'étaient pas facultatifs : il fallait
     * donc TOUJOURS un contrat à projeter, et un projet qui venait de résilier
     * se voyait attribuer son dernier contrat terminé — affiché comme
     * l'engagement du moment. « Aucun contrat en cours » est un état, il doit
     * pouvoir s'écrire.
     */
    hasCurrent: { type: Boolean, default: true },
    sourceContractId: { type: String, default: null },
    status: { type: String, default: null },
    reference: { type: String, default: null },
    /**
     * Le document contractuel n'est jamais STOCKÉ ici, seulement DÉCRIT.
     * `downloadPath` est une route du projet — le Panel va y chercher le PDF
     * quand un humain le demande, avec son jeton de pont. Aucun chemin disque
     * n'entre dans cette collection.
     */
    document: {
      available: { type: Boolean, default: false },
      status: { type: String, default: 'NONE' },
      downloadAvailable: { type: Boolean, default: false },
      filename: { type: String, default: null },
      pages: { type: Number, default: 0 },
      sha256: { type: String, default: null },
      version: { type: Number, default: 0 },
      signatureRequired: { type: Boolean, default: null },
      signatureStatus: { type: String, default: null },
      signedAt: { type: String, default: null },
      generatedAt: { type: String, default: null },
      downloadPath: { type: String, default: null },
    },
    createdAt: { type: String, default: null },
    activatedAt: { type: String, default: null },
    pricing: {
      subscription: { type: amountSchema, default: null },
      launchFee: { type: amountSchema, default: null },
    },
    /**
     * LE TAUX DE TVA EFFECTIF DU CONTRAT, EN POURCENTAGE (L10.5).
     *
     * `null` se lit « inconnu », jamais « zéro » et surtout jamais « 20 ». La
     * facturation d'une prestation le REFUSE plutôt que d'en supposer un —
     * voir `resolveTaxRate()` dans le service des prestations.
     */
    taxRate: { type: Number, default: null },
    /**
     * LE DÉLAI DE GRÂCE DU CONTRAT, EN JOURS (L10.6B-1).
     *
     * `null` se lit « non configuré », jamais « zéro ». La distinction décide
     * de la fermeture d'un site : voir `resolveGraceDays`.
     */
    paymentGraceDays: { type: Number, default: null },
    /**
     * L'HISTOIRE — les contrats terminés, du plus récent au plus ancien.
     * Rien n'y est effacé : un contrat résilié reste entièrement consultable,
     * simplement plus jamais présenté comme celui du moment.
     */
    previousContracts: { type: [previousContractSchema], default: [] },
    sourceModifiedAt: { type: String, required: true },
    ...SOURCE_FIELDS,
    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * MEMBRE de l'équipe d'un projet — projection en LECTURE SEULE.
 *
 * Le Panel ne crée, ne modifie et ne supprime aucun compte : ces lignes sont
 * le reflet de ce que le projet publie. Clé (projectId, entityId) : deux
 * projets peuvent avoir des membres homonymes, ils ne se mélangent pas.
 */
const memberSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, index: true },
    entityId: { type: String, required: true },
    sourceUserId: { type: String, required: true },
    email: { type: String, required: true },
    name: { type: String, default: null },
    role: { type: String, required: true },
    createdAt: { type: String, default: null },
    sourceModifiedAt: { type: String, required: true },
    ...SOURCE_FIELDS,
    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);
memberSchema.index({ projectId: 1, entityId: 1 }, { unique: true });

/**
 * CE QU'UN PROJET DÉCLARE UTILISER COMME MODÈLES D'E-MAIL — projection.
 *
 * ══ POURQUOI CETTE COLLECTION EST L'AUTORITÉ DE L'USAGE ════════════════════
 *
 * Le Panel possédait jusqu'ici deux réponses à « quels modèles ce projet
 * utilise-t-il ? », et aucune n'était juste : le drapeau global
 * `provisionForProjects` (une décision de plateforme sur un besoin qu'elle ne
 * connaît pas) et la simple existence d'une instance (une conséquence, prise
 * pour une cause).
 *
 * La bonne réponse est celle du projet, et il la donne. Cette collection la
 * conserve : c'est l'ÉTAT DÉSIRÉ, reçu par le pont, et le Panel s'y conforme.
 *
 * ══ ELLE NE PORTE PAS LE CONTENU, ET N'EN PORTERA JAMAIS ═══════════════════
 *
 * Ni sujet, ni HTML, ni version : le contenu vit dans `PanelEmailTemplate`,
 * par portée, et son autorité reste le Panel. Ici on ne trouve QUE des codes.
 * C'est la séparation qui permet à un projet de cesser d'utiliser un modèle
 * sans que personne ne perde le texte qu'il avait écrit.
 *
 * ══ UNE LIGNE PAR PROJET ═══════════════════════════════════════════════════
 *
 * C'est un état, pas une collection d'objets : `PROJECT_PRESENTATION` et
 * `PROJECT_SITE_STATUS` suivent la même règle.
 */
const emailTemplateUsageSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, unique: true },

    /** Les codes que le projet déclare consommer. Triés par l'émetteur. */
    templateCodes: { type: [String], default: [] },

    /**
     * L'EMPREINTE DE LA LISTE, telle que le projet l'a calculée.
     *
     * C'est elle qui décide s'il y a quelque chose à faire : révision
     * identique ⇒ aucune écriture, aucun journal, aucune réconciliation. Sans
     * elle, chaque démarrage d'un projet produirait du bruit dans lequel un
     * vrai changement finirait par se perdre.
     */
    revision: { type: String, required: true },

    /** Quand le projet l'a annoncé (son horloge). Informatif. */
    declaredAt: { type: String, default: null },

    /**
     * L'EMPREINTE DU CONTRAT DE VARIABLES QUE LE PROJET SAIT SERVIR (L12.1).
     *
     * `{ [templateCode]: fingerprint }`. Le projet n'invente rien : il renvoie
     * l'empreinte que le Panel lui a SERVIE la dernière fois qu'il a lu son
     * contrat. Elle dit donc exactement une chose — « voici la version du
     * vocabulaire d'après laquelle mes résolveurs produisent des valeurs ».
     *
     * Comparée à celle du registre, elle rend un écart DÉTECTABLE AVANT le
     * premier envoi raté : ajouter une variable obligatoire, en retirer une ou
     * en changer le type se voit ici, et non trois semaines plus tard dans un
     * MISSING_REQUIRED_VARIABLE sur une réinitialisation de mot de passe.
     *
     * Vide pour un projet antérieur au lot : c'est `UNDECLARED`, pas une panne.
     */
    contractFingerprints: { type: Map, of: String, default: () => new Map() },

    /**
     * CE QUE LE PANEL EN A FAIT — le compte rendu de la dernière
     * réconciliation. Un exploitant doit pouvoir répondre à « pourquoi ce
     * projet n'a-t-il que huit modèles alors qu'il en déclare neuf ? » sans
     * relire un journal.
     *
     * `unknown` est le signal le plus utile du lot : il nomme un projet
     * déployé AVANT le Panel qui connaît son nouveau code.
     */
    lastReconciliation: {
      at: { type: String, default: null },
      provisioned: { type: [String], default: [] },
      existing: { type: [String], default: [] },
      unknown: { type: [String], default: [] },
      forbidden: { type: [String], default: [] },
      /**
       * `archived` a remplacé `removed` (L12.1). L'ancien nom décrivait un
       * constat sans acte : il listait des instances que rien ne retirait, et
       * qui restaient donc actives. Le nouveau nomme ce qui a réellement eu
       * lieu — l'instance est archivée, son historique conservé, l'envoi la
       * refuse.
       */
      archived: { type: [String], default: [] },
      restored: { type: [String], default: [] },
      /** Codes dont l'empreinte de contrat déclarée n'est plus celle du registre. */
      staleContracts: { type: [String], default: [] },
    },

    sourceModifiedAt: { type: String, required: true },
    ...SOURCE_FIELDS,
    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

export const PanelProjectEmailTemplateUsage = mongoose.model(
  'PanelProjectEmailTemplateUsage',
  emailTemplateUsageSchema,
);

export const PanelProjectMember = mongoose.model('PanelProjectMember', memberSchema);

export const PanelProjectSiteStatus = mongoose.model(
  'PanelProjectSiteStatus',
  siteStatusSchema,
);

export const PanelProjectPresentation = mongoose.model(
  'PanelProjectPresentation',
  presentationSchema,
);
export const PanelProjectContract = mongoose.model('PanelProjectContract', contractSchema);

export default {
  PanelProjectPresentation,
  PanelProjectContract,
  PanelProjectMember,
  PanelProjectEmailTemplateUsage,
  PanelProjectSiteStatus,
};
