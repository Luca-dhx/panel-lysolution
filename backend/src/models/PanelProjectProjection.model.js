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

const contractSchema = new mongoose.Schema(
  {
    // UN contrat courant par projet. Le projet choisit lequel il publie (règle
    // déterministe côté projet) : le Panel n'arbitre pas entre plusieurs
    // contrats, il reçoit celui qui fait foi.
    projectId: { type: String, required: true, unique: true, index: true },
    sourceContractId: { type: String, required: true },
    status: { type: String, required: true },
    reference: { type: String, default: null },
    createdAt: { type: String, default: null },
    activatedAt: { type: String, default: null },
    pricing: {
      subscription: { type: amountSchema, default: null },
      launchFee: { type: amountSchema, default: null },
    },
    sourceModifiedAt: { type: String, required: true },
    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

export const PanelProjectPresentation = mongoose.model(
  'PanelProjectPresentation',
  presentationSchema,
);
export const PanelProjectContract = mongoose.model('PanelProjectContract', contractSchema);

export default { PanelProjectPresentation, PanelProjectContract };
