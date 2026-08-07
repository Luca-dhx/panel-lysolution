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

/**
 * ADRESSE D'UN MÉDIA DU PANEL — absolue OU chemin de stockage.
 *
 * ── CE QUI EST ASSOUPLI, ET CE QUI NE L'EST PAS ─────────────────────────────
 * La règle de sécurité sur une URL ABSOLUE ne bouge pas : https exigé hors
 * boucle locale. Ce qui change, c'est qu'un CHEMIN DE STOCKAGE
 * (`/uploads/<clé>`) est désormais accepté.
 *
 * Il le faut : un Panel de recette non encore déployé n'a aucune adresse
 * publique, et exiger l'absolu revenait à interdire de le configurer avant sa
 * première mise en ligne. Le chemin relatif n'est pas une URL publique — c'est
 * une référence interne, résolue à la lecture contre la destination active.
 *
 * Rien d'autre n'est toléré : ni chemin arbitraire, ni remontée de répertoire.
 */
const mediaRef = (label) =>
  z.union([
    z.string().trim().refine((value) => {
      if (value === '') return true;
      // Référence interne au stockage du Panel : une clé d'objet, et rien d'autre.
      if (value.startsWith('/uploads/')) {
        const cle = value.slice('/uploads/'.length);
        return cle.length > 0 && !cle.includes('/') && !cle.includes('..');
      }
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol === 'https:') return true;
      return parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
    }, `${label} : chemin de média (/uploads/…) ou URL absolue en https attendu.`),
    z.null(),
  ]).optional().transform((v) => (v === undefined || v === '' ? null : v));

/**
 * DESCRIPTEUR DE MÉDIA — la source de vérité d'une image.
 *
 * `passthrough` : le descripteur peut gagner des champs (rôle, état de
 * publication) sans qu'une fiche déjà enregistrée devienne invalide. Ce qui
 * est vérifié, c'est ce dont la résolution d'adresse a besoin — une clé
 * d'objet exploitable et un environnement cohérent.
 */
const mediaDescriptor = (label) =>
  z.union([
    z.object({
      mediaId: z.string().nullable().optional(),
      objectKey: z.string().trim().min(1).refine(
        (v) => !v.includes('/') && !v.includes('..'),
        `${label}.objectKey : clé d’objet attendue, sans séparateur.`,
      ),
      environment: z.enum(['TEST', 'PROD']).nullable().optional(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/i, `${label}.sha256 : empreinte SHA-256 attendue.`).nullable().optional(),
      mime: z.string().nullable().optional(),
      size: z.number().int().nonnegative().nullable().optional(),
      width: z.number().int().positive().nullable().optional(),
      height: z.number().int().positive().nullable().optional(),
      version: z.number().int().positive().nullable().optional(),
    }).passthrough(),
    z.null(),
  ]).optional().transform((v) => (v === undefined ? null : v));

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

/**
 * Deux médias de marque : le logo et le favicon.
 *
 * Le « logo sombre » a été retiré du produit. Le schéma ne le déclare plus, et
 * comme il n'est pas `passthrough`, une charge utile qui le porterait encore le
 * verrait simplement ignoré — pas rejeté : un client resté sur une version
 * antérieure de l'écran ne doit pas voir son enregistrement échouer.
 */
const brandingSchema = z.object({
  logoUrl: mediaRef('branding.logoUrl'),
  faviconUrl: mediaRef('branding.faviconUrl'),
  logo: mediaDescriptor('branding.logo'),
  favicon: mediaDescriptor('branding.favicon'),
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

/**
 * ÉQUIPE — les personnes qu’un client verra sur sa page Support.
 *
 * Tout est facultatif sauf la cohérence de ce qui est saisi : un e-mail
 * renseigné doit être un e-mail, une photo doit être une adresse. Exiger
 * davantage empêcherait d’enregistrer une fiche en cours de constitution,
 * pour un bénéfice nul — c’est l’affichage qui décide quoi montrer.
 */
const teamSchema = z.array(z.object({
  firstName: nullableString(120),
  lastName: nullableString(120),
  role: nullableString(120),
  email: email('team.email'),
  phone: nullableString(40),
  photoUrl: mediaRef('team.photoUrl'),
  photo: mediaDescriptor('team.photo'),
  active: z.boolean().default(true),
  references: referencesSchema,
  order: z.number().int().min(0).default(0),
}).partial({
  // `active` et `order` gardent leur défaut ; les autres peuvent manquer.
  firstName: true, lastName: true, role: true, email: true, phone: true, photoUrl: true, photo: true,
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
  team: teamSchema,
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
