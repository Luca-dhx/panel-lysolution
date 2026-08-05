// L'ENTREPRISE — Phase 4, LOT 2.
//
// C'est le premier objet « métier » du Panel : jusqu'ici il ne connaissait
// que des projets et lui-même. L'entreprise est le TENANT — le propriétaire
// des projets, la source de son identité publique, et l'origine de la
// configuration que les projets reçoivent.
//
// ── PENSÉ MULTI-TENANT, EXPLOITÉ MONO-TENANT ────────────────────────────────
// Une seule entreprise suffit à cette phase. Le modèle n'en fait pas pour
// autant un singleton : `companyId` et `slug` sont des identifiants de
// premier ordre, et rien dans le schéma ne suppose qu'il n'y en a qu'une.
// Ce qui reste mono-tenant, c'est la RÉSOLUTION (`getActiveCompany()`), pas
// la donnée. Le jour où un second tenant apparaît, c'est le résolveur qui
// change — pas le modèle, pas les projections, pas le pont.
//
// C'est le même raisonnement que pour les moteurs : la divergence doit
// passer par un point unique et nommé.
import mongoose from 'mongoose';

/** Identité — ce qui nomme l'entreprise. */
const identitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    legalName: { type: String, default: null },
    tagline: { type: String, default: null },
    description: { type: String, default: null },
  },
  { _id: false },
);

/**
 * Marque — ce que les projets reprennent pour se peindre à ses couleurs.
 *
 * Les couleurs sont stockées en hexadécimal vérifié : un projet qui les
 * injecte dans sa feuille de style ne doit pas hériter d'une chaîne
 * arbitraire venue du Panel.
 */
const brandingSchema = new mongoose.Schema(
  {
    logoUrl: { type: String, default: null },
    logoDarkUrl: { type: String, default: null },
    faviconUrl: { type: String, default: null },
    primaryColor: { type: String, default: null },
    secondaryColor: { type: String, default: null },
    accentColor: { type: String, default: null },
    fontFamily: { type: String, default: null },
  },
  { _id: false },
);

/**
 * SIGNATAIRE CONTRACTUEL — la personne physique qui engage l'entreprise.
 *
 * Jamais déduit d'un compte utilisateur : un compte sert à se connecter, pas à
 * signer. Reste vide tant qu'il n'est pas renseigné — un projet refusera alors
 * explicitement de valider un contrat, ce qui vaut mieux qu'un signataire
 * deviné.
 */
const signerSchema = new mongoose.Schema(
  {
    firstName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    jobTitle: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
  },
  { _id: false },
);

/**
 * RÉFÉRENCES — liens et informations affichés par les projets.
 *
 * `type` distingue une valeur cliquable d'un simple texte ; `icon` reprend la
 * nomenclature Bootstrap Icons déjà utilisée par les projets.
 */
const referenceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['TEXT', 'LINK'], default: 'TEXT' },
    icon: { type: String, default: 'bi-star' },
    name: { type: String, default: '' },
    value: { type: String, default: '' },
    order: { type: Number, default: 0 },
  },
  { _id: false },
);

/** Domaines — le domaine principal sert de base aux domaines des projets. */
const domainsSchema = new mongoose.Schema(
  {
    primaryDomain: { type: String, default: null },
    websiteUrl: { type: String, default: null },
    // Bases wildcard gérées, reprises par le moteur de déploiement pour
    // décider s'il faut émettre un certificat dédié.
    wildcardBases: { type: [String], default: [] },
  },
  { _id: false },
);

/** Contacts — publics par nature : ils figurent sur les sites des projets. */
const contactsSchema = new mongoose.Schema(
  {
    email: { type: String, default: null },
    phone: { type: String, default: null },
    supportEmail: { type: String, default: null },
    address: {
      line1: { type: String, default: null },
      line2: { type: String, default: null },
      postalCode: { type: String, default: null },
      city: { type: String, default: null },
      country: { type: String, default: null },
    },
  },
  { _id: false },
);

/** Mentions légales — obligatoires sur un site vitrine français. */
const legalSchema = new mongoose.Schema(
  {
    legalForm: { type: String, default: null },
    siret: { type: String, default: null },
    vatNumber: { type: String, default: null },
    rcs: { type: String, default: null },
    shareCapital: { type: String, default: null },
    legalRepresentative: { type: String, default: null },
    hostingProvider: { type: String, default: null },
    privacyPolicyUrl: { type: String, default: null },
    termsUrl: { type: String, default: null },
  },
  { _id: false },
);

/** Paramètres généraux — préférences transverses, non secrètes. */
const settingsSchema = new mongoose.Schema(
  {
    locale: { type: String, default: 'fr-FR' },
    timezone: { type: String, default: 'Europe/Paris' },
    currency: { type: String, default: 'EUR' },
  },
  { _id: false },
);

const companySchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true },
    // Identifiant lisible et stable — sert de clé dans les payloads de
    // synchronisation, où un UUID ne dirait rien à la lecture d'un journal.
    slug: { type: String, required: true, unique: true },

    identity: { type: identitySchema, required: true },
    branding: { type: brandingSchema, default: () => ({}) },
    domains: { type: domainsSchema, default: () => ({}) },
    contacts: { type: contactsSchema, default: () => ({}) },
    legal: { type: legalSchema, default: () => ({}) },
    settings: { type: settingsSchema, default: () => ({}) },
    // Repris de la page « Entreprise développeur » des projets, dont le Panel
    // devient l'autorité : ces deux blocs n'existaient que localement.
    signer: { type: signerSchema, default: null },
    references: { type: [referenceSchema], default: [] },

    // TEST ou PROD : une entreprise de recette et une entreprise de
    // production ne doivent jamais être confondues, même si elles portent le
    // même nom.
    environment: { type: String, enum: ['TEST', 'PROD'], required: true },

    // Une seule entreprise est ACTIVE à la fois dans cette phase. Le champ
    // existe pour que la bascule mono → multi soit une question de
    // résolution, pas de migration.
    active: { type: Boolean, default: true },

    // Version de configuration PUBLIÉE — celle que les projets reçoivent.
    // `null` tant que rien n'a été publié : une entreprise saisie n'est pas
    // encore une entreprise diffusée.
    publishedVersion: { type: Number, default: null },
    publishedAt: { type: String, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

companySchema.index({ active: 1, environment: 1 });

export default mongoose.model('PanelCompany', companySchema);
