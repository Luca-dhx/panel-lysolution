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

const amountSchema = new mongoose.Schema(
  {
    amountIncludingTax: { type: Number, default: null },
    currency: { type: String, default: null },
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

export const PanelProjectMember = mongoose.model('PanelProjectMember', memberSchema);

export const PanelProjectPresentation = mongoose.model(
  'PanelProjectPresentation',
  presentationSchema,
);
export const PanelProjectContract = mongoose.model('PanelProjectContract', contractSchema);

export default { PanelProjectPresentation, PanelProjectContract, PanelProjectMember };
