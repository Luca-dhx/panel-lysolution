// VALIDATION DE L'ENTREPRISE CLIENTE — la dernière barrière avant la facture.
//
// ══ CE QUE CETTE VALIDATION PROTÈGE, CONCRÈTEMENT ═══════════════════════════
//
// Ce qui est accepté ici finit sur une facture Stripe, dans un contrat signé,
// et — à compter du 1er septembre 2026 — dans une facture électronique
// transmise à l'administration. Un SIREN de huit chiffres n'est pas « une
// coquille » : c'est une mention obligatoire fausse sur un document fiscal.
//
// ══ CE QU'ELLE NE FAIT PAS, ET C'EST DÉLIBÉRÉ ═══════════════════════════════
//
// Elle ne VÉRIFIE RIEN AUPRÈS DE PERSONNE. Ni INSEE, ni VIES, ni annuaire des
// entreprises. Le Panel n'a aujourd'hui aucun fournisseur de ce type déclaré
// dans son plan de contrôle, et en inventer un ici créerait :
//
//   · une dépendance réseau sur un simple enregistrement de fiche ;
//   · un mode dégradé (« le service est en panne, j'accepte quand même »)
//     qui deviendrait le chemin normal au premier incident ;
//   · une promesse d'exactitude que le code ne tiendrait pas.
//
// On valide donc la FORME — longueur, alphabet, cohérence interne — et rien de
// plus. Le jour où un fournisseur d'annuaire entrera dans le plan de contrôle,
// il s'ajoutera comme une capacité, à côté de ceci, jamais à la place.
//
// ══ LA CLÉ DE LUHN DU SIREN : POURQUOI ELLE EST VÉRIFIÉE ════════════════════
//
// Elle ne coûte rien, elle ne dépend de personne, et elle attrape la faute la
// plus fréquente — l'inversion de deux chiffres — que ni la longueur ni
// l'alphabet ne voient. C'est le seul contrôle « sémantique » possible hors
// ligne, et il serait absurde de s'en priver.
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  BRIQUES                                                                   */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * UNE CHAÎNE FACULTATIVE — et l'effacement y est une INTENTION.
 *
 * `''` devient `null`, jamais une erreur de format : vider un champ qu'on
 * n'aurait pas dû remplir est un geste normal, et le refuser obligerait à
 * inventer un bouton « effacer » à côté de chaque zone de saisie.
 */
const nullableString = (max, label) =>
  z.union([z.string().trim().max(max, `${label} : ${max} caractères au maximum.`), z.null()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v));

/** Une adresse e-mail plausible — la FORME, jamais l'existence. */
const email = (label) =>
  z.union([
    z.literal(''),
    z.null(),
    z.string().trim().toLowerCase().regex(EMAIL_RE, `${label} : adresse e-mail attendue.`),
  ])
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v));

/**
 * URL — https exigé hors boucle locale.
 *
 * Même règle que pour l'entreprise développeur : un lien en http affiché
 * depuis une page https est bloqué par le navigateur, et l'erreur ne remonte
 * jamais jusqu'ici. Autant refuser à la saisie.
 */
const url = (label) =>
  z.union([
    z.literal(''),
    z.null(),
    z.string().trim().refine((value) => {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol === 'https:') return true;
      return parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
    }, `${label} : URL absolue en https attendue.`),
  ])
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v));

/**
 * LA CLÉ DE LUHN — le seul contrôle de VRAISEMBLANCE disponible hors ligne.
 *
 * Un SIREN valide satisfait Luhn ; un SIREN dont deux chiffres ont été
 * intervertis ne le satisfait presque jamais. Ce n'est pas une preuve
 * d'existence — `000000000` passe la longueur mais échoue ici, et un SIREN
 * radié reste parfaitement conforme —, c'est un filtre à fautes de frappe.
 *
 * ── L'EXCEPTION QUI DOIT ÊTRE ÉCRITE ────────────────────────────────────────
 *
 * La Poste porte le SIREN `356000000`, qui NE satisfait PAS Luhn. C'est une
 * exception historique documentée par l'INSEE, pas une erreur de notre part.
 * Elle est donc admise nommément — l'omettre rendrait impossible d'enregistrer
 * un client qui existe.
 */
export function satisfiesLuhn(digits) {
  if (digits === '356000000') return true;
  let somme = 0;
  for (let i = 0; i < digits.length; i += 1) {
    // On double un chiffre sur deux EN PARTANT DE LA DROITE : la parité dépend
    // donc de la longueur, et l'écrire ainsi vaut pour 9 comme pour 14 chiffres.
    const depuisLaDroite = digits.length - 1 - i;
    let chiffre = Number(digits[i]);
    if (depuisLaDroite % 2 === 1) {
      chiffre *= 2;
      if (chiffre > 9) chiffre -= 9;
    }
    somme += chiffre;
  }
  return somme % 10 === 0;
}

const siren = z.union([
  z.literal(''),
  z.null(),
  z.string().trim()
    // Les espaces de groupement (« 123 456 789 ») sont retirés AVANT contrôle :
    // c'est la forme sous laquelle un SIREN est imprimé partout, et la refuser
    // ferait échouer un copier-coller parfaitement correct.
    .transform((v) => v.replace(/[\s. ]/g, ''))
    .refine((v) => /^\d{9}$/.test(v), 'siren : 9 chiffres attendus.')
    .refine(satisfiesLuhn, 'siren : la clé de contrôle est fausse — vérifiez la saisie.'),
])
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v));

const siret = z.union([
  z.literal(''),
  z.null(),
  z.string().trim()
    .transform((v) => v.replace(/[\s. ]/g, ''))
    .refine((v) => /^\d{14}$/.test(v), 'siret : 14 chiffres attendus.')
    .refine(satisfiesLuhn, 'siret : la clé de contrôle est fausse — vérifiez la saisie.'),
])
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v));

/**
 * NUMÉRO DE TVA INTRACOMMUNAUTAIRE — forme générique, contrôle renforcé pour FR.
 *
 * ── POURQUOI DEUX NIVEAUX ───────────────────────────────────────────────────
 *
 * Chaque État membre a son gabarit, et les recopier tous ici produirait une
 * table de vingt-sept lignes que personne ne maintiendrait. On vérifie donc
 * partout la forme commune — deux lettres de pays, puis 2 à 13 caractères
 * alphanumériques — et, pour la France seule (le cas réel de ce parc), la
 * règle exacte : `FR` + deux caractères de clé + les 9 chiffres du SIREN.
 *
 * La COHÉRENCE avec le SIREN saisi est vérifiée plus bas, au niveau de la
 * fiche : elle a besoin des deux champs, ce qu'une règle de champ ne voit pas.
 */
const vatNumber = z.union([
  z.literal(''),
  z.null(),
  z.string().trim().toUpperCase()
    .transform((v) => v.replace(/[\s. ]/g, ''))
    .refine(
      (v) => /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(v),
      'vatNumber : numéro de TVA intracommunautaire attendu (ex. FR40303265045).',
    )
    .refine(
      (v) => !v.startsWith('FR') || /^FR[0-9A-Z]{2}\d{9}$/.test(v),
      'vatNumber : un numéro français s’écrit FR + 2 caractères de clé + les 9 chiffres du SIREN.',
    ),
])
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v));

/**
 * PAYS — code ISO 3166-1 alpha-2, et rien d'autre.
 *
 * « France », « FRA » et « fr » désignent la même chose pour un humain et trois
 * choses différentes pour Stripe, qui refuse tout ce qui n'est pas deux lettres
 * majuscules. Normaliser à l'entrée évite un refus fournisseur au moment du
 * paiement — c'est-à-dire devant un client.
 */
const country = z.union([
  z.literal(''),
  z.null(),
  z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'country : code pays ISO à 2 lettres attendu (ex. FR).'),
])
  .optional()
  .transform((v) => (v === undefined || v === '' ? 'FR' : v));

/**
 * UNE ADRESSE — les champs sont facultatifs INDIVIDUELLEMENT.
 *
 * La complétude est jugée par la READINESS, pas par la validation : on doit
 * pouvoir enregistrer une fiche à moitié saisie et y revenir. Ce qu'on ne doit
 * pas pouvoir faire, c'est FACTURER avec elle — et c'est exactement la
 * frontière que `resolveClientCompanyReadiness` trace.
 */
const address = (label) => z.object({
  line1: nullableString(200, `${label}.line1`),
  line2: nullableString(200, `${label}.line2`),
  postalCode: nullableString(20, `${label}.postalCode`),
  city: nullableString(120, `${label}.city`),
  country,
}).partial().default({});

const contractualSigner = z.union([
  z.null(),
  z.object({
    firstName: nullableString(80, 'contractualSigner.firstName'),
    lastName: nullableString(80, 'contractualSigner.lastName'),
    jobTitle: nullableString(120, 'contractualSigner.jobTitle'),
    email: email('contractualSigner.email'),
    phone: nullableString(40, 'contractualSigner.phone'),
  }).partial(),
]).optional().transform((v) => (v === undefined ? null : v));

/* -------------------------------------------------------------------------- */
/*  LA FICHE                                                                  */
/* -------------------------------------------------------------------------- */

const clientCompanySchema = z.object({
  /**
   * LE SEUL CHAMP OBLIGATOIRE. Une entreprise sans raison sociale n'est pas
   * une fiche incomplète : c'est une fiche qui ne désigne personne.
   */
  legalName: z.string().trim().min(2, 'legalName : raison sociale attendue.').max(200),
  tradingName: nullableString(200, 'tradingName'),
  legalForm: nullableString(80, 'legalForm'),
  siren,
  siret,
  vatNumber,
  registrationCity: nullableString(120, 'registrationCity'),

  registeredOffice: address('registeredOffice'),
  /**
   * `null` se lit « identique au siège », jamais « inconnue ». Voir le modèle.
   */
  billingAddress: z.union([z.null(), address('billingAddress')])
    .optional()
    .transform((v) => (v === undefined ? null : v)),

  billingEmail: email('billingEmail'),
  phone: nullableString(40, 'phone'),
  website: url('website'),
  administrativeContact: z.object({
    name: nullableString(160, 'administrativeContact.name'),
    email: email('administrativeContact.email'),
    phone: nullableString(40, 'administrativeContact.phone'),
  }).partial().default({}),

  contractualSigner,

  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  notes: nullableString(4000, 'notes'),
})
  /**
   * ── LES DEUX COHÉRENCES QU'UNE RÈGLE DE CHAMP NE PEUT PAS VOIR ────────────
   *
   * Elles portent sur DEUX champs à la fois, et c'est pour cela qu'elles vivent
   * ici plutôt que dans les briques ci-dessus.
   */
  .superRefine((value, ctx) => {
    /**
     * SIRET ⊃ SIREN. Un SIRET commence TOUJOURS par le SIREN de son entreprise ;
     * c'est la définition même du numéro, pas une convention.
     *
     * Sans ce contrôle, une fiche pouvait porter le SIREN d'une société et le
     * SIRET d'une autre — et la facture aurait été juste sur une mention,
     * fausse sur l'autre, sans qu'aucun écran ne s'en aperçoive.
     */
    if (value.siren && value.siret && !value.siret.startsWith(value.siren)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['siret'],
        message: 'siret : les 9 premiers chiffres doivent être le SIREN de l’entreprise.',
      });
    }
    /**
     * TVA FR ⊃ SIREN. Un numéro français se termine par le SIREN. Même
     * raisonnement, et même conséquence sur la facture.
     */
    if (value.siren && value.vatNumber?.startsWith('FR') && !value.vatNumber.endsWith(value.siren)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vatNumber'],
        message: 'vatNumber : un numéro français se termine par les 9 chiffres du SIREN.',
      });
    }
  });

/**
 * Valide une fiche d'entreprise cliente.
 *
 * Rend la même forme que `validateCompanyInput` — `{ valid, value, errors }` —
 * pour que les contrôleurs n'aient rien de nouveau à apprendre.
 */
export function validateClientCompanyInput(input) {
  const parsed = clientCompanySchema.safeParse(input ?? {});
  if (parsed.success) return { valid: true, value: parsed.data, errors: [], issues: [] };

  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return issue.message.includes(path) || path === '' ? issue.message : `${path} : ${issue.message}`;
  });

  /**
   * ── LE MÊME REFUS, MAIS ATTRIBUABLE ────────────────────────────────────
   *
   * ══ CE QUE `errors` NE PERMETTAIT PAS ════════════════════════════════
   *
   * Des PHRASES. « siren : SIREN : 9 chiffres attendus. » se lit très bien
   * dans une notification, et ne permet à aucun écran de savoir SOUS QUEL
   * CHAMP la poser. L’interface n’avait donc qu’un choix : tout empiler en
   * haut du formulaire, et laisser l’opérateur chercher lequel de ses
   * trente champs est en cause.
   *
   * Le découper côté écran aurait voulu dire deviner le chemin en coupant
   * la chaîne au premier « : » — c’est-à-dire faire dépendre l’affichage
   * d’un détail de formulation, qui change au premier message réécrit.
   *
   * ══ `errors` EST CONSERVÉ, ET DÉLIBÉRÉMENT ═══════════════════════════
   *
   * Il porte le message d’ensemble, et des appelants le lisent déjà. On
   * AJOUTE le chemin à côté ; on ne remplace rien, donc rien ne casse.
   */
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  return { valid: false, value: null, errors, issues };
}

/* -------------------------------------------------------------------------- */
/*  DOCUMENTS                                                                 */
/* -------------------------------------------------------------------------- */

const documentMetaSchema = z.object({
  label: z.string().trim().min(1, 'label : un nom de document est attendu.').max(160),
  /**
   * La catégorie est LIBRE — voir le modèle. Elle est seulement normalisée :
   * majuscules, alphabet restreint, 40 caractères. Ce qui l'empêche de devenir
   * un champ de texte libre déguisé où l'on rangerait une phrase.
   */
  type: z.union([
    z.literal(''),
    z.null(),
    z.string().trim().toUpperCase().regex(
      /^[A-Z0-9][A-Z0-9_-]{0,39}$/,
      'type : catégorie courte attendue (lettres, chiffres, tiret ou souligné).',
    ),
  ]).optional().transform((v) => (v === undefined || v === '' ? null : v)),
  /**
   * La date DU DOCUMENT — un Kbis de mars reste un Kbis de mars, même déposé
   * en août. Format ISO court : c'est une date, jamais un instant.
   */
  documentDate: z.union([
    z.literal(''),
    z.null(),
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'documentDate : date AAAA-MM-JJ attendue.'),
  ]).optional().transform((v) => (v === undefined || v === '' ? null : v)),
});

export function validateClientDocumentInput(input) {
  const parsed = documentMetaSchema.safeParse(input ?? {});
  if (parsed.success) return { valid: true, value: parsed.data, errors: [] };
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return issue.message.includes(path) || path === '' ? issue.message : `${path} : ${issue.message}`;
  });
  return { valid: false, value: null, errors };
}

export default {
  satisfiesLuhn,
  validateClientCompanyInput,
  validateClientDocumentInput,
};
