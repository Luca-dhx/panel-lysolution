// VALIDATION DE L'ENTREPRISE — Phase 4, LOT 2.
//
// Ce que le Panel accepte ici finit sur les sites publics des projets : une
// couleur mal formée casse une feuille de style, une URL non https fait
// tomber un cadenas, un slug fantaisiste devient une clé de synchronisation
// illisible. La validation n'est donc pas une formalité de saisie — c'est la
// dernière barrière avant diffusion au parc.
//
// Comme partout depuis la Phase 3B : on refuse en NOMMANT le champ et la
// valeur constatée, jamais « données invalides ».
import { z } from 'zod';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

const nullableString = (max = 500) =>
  z.union([z.string().trim().max(max), z.null()]).optional().transform((v) => (v === undefined || v === '' ? null : v));

const color = (label) =>
  z.union([z.string().regex(HEX_COLOR_RE, `${label} : couleur hexadécimale attendue (ex. #1b4dff).`), z.null()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v));

/**
 * URL — https exigé hors localhost.
 *
 * Un logo servi en http sur une page https est bloqué par le navigateur : le
 * site perdrait son image sans qu'aucune erreur ne remonte au Panel. Autant
 * refuser à la saisie.
 */
const url = (label) =>
  z.union([
    z.string().trim().refine((value) => {
      if (value === '') return true;
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol === 'https:') return true;
      return parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
    }, `${label} : URL absolue en https attendue (http toléré uniquement sur localhost).`),
    z.null(),
  ]).optional().transform((v) => (v === undefined || v === '' ? null : v));

const domain = (label) =>
  z.union([z.string().trim().toLowerCase().regex(DOMAIN_RE, `${label} : nom de domaine attendu (ex. exemple.fr).`), z.null()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v));

const email = (label) =>
  z.union([z.string().trim().toLowerCase().email(`${label} : adresse e-mail attendue.`), z.null()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v));

const identitySchema = z.object({
  name: z.string().trim().min(2, 'identity.name : au moins 2 caractères.').max(120),
  legalName: nullableString(160),
  tagline: nullableString(200),
  description: nullableString(2000),
});

const brandingSchema = z.object({
  logoUrl: url('branding.logoUrl'),
  logoDarkUrl: url('branding.logoDarkUrl'),
  faviconUrl: url('branding.faviconUrl'),
  primaryColor: color('branding.primaryColor'),
  secondaryColor: color('branding.secondaryColor'),
  accentColor: color('branding.accentColor'),
  fontFamily: nullableString(120),
}).partial().default({});

/**
 * SIGNATAIRE — tout est facultatif, mais un e-mail renseigné doit être un
 * e-mail. Un signataire à moitié rempli est refusé par le projet au moment de
 * valider un contrat : c'est là que la règle a du sens, pas ici.
 */
const signerSchema = z.object({
  firstName: nullableString(120),
  lastName: nullableString(120),
  jobTitle: nullableString(120),
  email: email('signer.email'),
}).partial().nullable().default(null);

const referencesSchema = z.array(z.object({
  type: z.enum(['TEXT', 'LINK']).default('TEXT'),
  icon: nullableString(60),
  name: nullableString(120),
  value: nullableString(500),
  order: z.number().int().min(0).default(0),
})).default([]);

const domainsSchema = z.object({
  primaryDomain: domain('domains.primaryDomain'),
  websiteUrl: url('domains.websiteUrl'),
  wildcardBases: z.array(z.string().trim().toLowerCase().regex(DOMAIN_RE, 'domains.wildcardBases : nom de domaine attendu.')).default([]),
}).partial().default({});

const contactsSchema = z.object({
  email: email('contacts.email'),
  phone: nullableString(40),
  supportEmail: email('contacts.supportEmail'),
  address: z.object({
    line1: nullableString(200),
    line2: nullableString(200),
    postalCode: nullableString(20),
    city: nullableString(120),
    country: nullableString(120),
  }).partial().default({}),
}).partial().default({});

const legalSchema = z.object({
  legalForm: nullableString(80),
  // SIRET : 14 chiffres. Vérifié dans sa forme, pas auprès de l'INSEE — le
  // Panel n'a pas à interroger un service tiers pour enregistrer une fiche.
  siret: z.union([z.string().trim().regex(/^\d{14}$/, 'legal.siret : 14 chiffres attendus.'), z.null()])
    .optional().transform((v) => (v === undefined || v === '' ? null : v)),
  vatNumber: z.union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}[0-9A-Z]{2,13}$/, 'legal.vatNumber : numéro de TVA intracommunautaire attendu (ex. FR12345678901).'), z.null()])
    .optional().transform((v) => (v === undefined || v === '' ? null : v)),
  rcs: nullableString(120),
  shareCapital: nullableString(60),
  legalRepresentative: nullableString(160),
  hostingProvider: nullableString(200),
  privacyPolicyUrl: url('legal.privacyPolicyUrl'),
  termsUrl: url('legal.termsUrl'),
}).partial().default({});

const settingsSchema = z.object({
  locale: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'settings.locale : code de langue attendu (ex. fr-FR).').default('fr-FR'),
  timezone: z.string().trim().min(3).max(60).default('Europe/Paris'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'settings.currency : code ISO 4217 attendu (ex. EUR).').default('EUR'),
// Pas de `.partial()` ici, contrairement aux autres blocs : ces trois
// paramètres ont des valeurs par défaut qui DOIVENT s'appliquer. Un projet
// qui recevrait `settings: {}` ne saurait ni dans quelle langue ni dans
// quelle devise s'afficher.
}).default({});

const companySchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_RE,
    'slug : minuscules, chiffres et tirets uniquement (ex. ly-solution).').min(2).max(60),
  identity: identitySchema,
  branding: brandingSchema,
  domains: domainsSchema,
  contacts: contactsSchema,
  legal: legalSchema,
  settings: settingsSchema,
  signer: signerSchema,
  references: referencesSchema,
  environment: z.enum(['TEST', 'PROD'], {
    errorMap: () => ({ message: 'environment : TEST ou PROD attendu.' }),
  }),
  active: z.boolean().optional(),
});

/**
 * Valide une entreprise complète.
 *
 * @param {boolean} creating  à la création, tout est exigé ; à la mise à
 *   jour, l'appelant a déjà fusionné le patch sur l'existant — donc le
 *   document est complet dans les deux cas. Le drapeau ne sert qu'à formuler
 *   le refus dans les bons termes.
 */
export function validateCompanyInput(input, { creating = false } = {}) {
  const parsed = companySchema.safeParse(input ?? {});
  if (parsed.success) {
    return { valid: true, value: parsed.data, errors: [] };
  }
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.join('.');
    // Les messages personnalisés nomment déjà leur champ ; les messages zod
    // par défaut, non — on préfixe alors le chemin pour que le refus reste
    // exploitable.
    return issue.message.includes(path) || path === '' ? issue.message : `${path} : ${issue.message}`;
  });
  return { valid: false, value: null, errors, creating };
}

export default { validateCompanyInput };
