// MOTEUR DE RENDU DES TEMPLATES — l’autorité du Panel (L8.3).
//
// ══ CE FICHIER EST UN DÉPLACEMENT D'AUTORITÉ, PAS UNE COPIE ══════════════════
//
// L8 a tranché : `TEMPLATE_AUTHORITIES.PANEL`. Le contenu des e-mails vit
// désormais ICI — versionné, validé, rendu par le Panel — et le corps envoyé à
// Brevo porte `subject` + `htmlContent`, jamais un `templateId` du fournisseur
// qui ferait sortir le contenu de nos versions.
//
// Ce module vient de `SB Auto 06/backend/src/services/email/emailTemplateRenderer.js`. Il n'est PAS
// dupliqué pour le plaisir : l'autorité change de côté, et le moteur suit le
// contenu qu'il rend. Le jour où l'envoi projet sera retiré (L10), l'exemplaire
// d'origine partira avec lui — c'est le sens du déplacement.
//
// Aucune règle n'a été assouplie au passage. Ce qui suit est le module éprouvé
// du projet, à l'identique sauf ses imports.

import {
  VARIABLE_TYPE,
  EMAIL_TEMPLATE_ERROR_CODES as E,
  PLACEHOLDER_RE,
  CURRENCY_SYMBOL,
  DISPLAY_TIME_ZONE,
} from '../../utils/panelEmailTemplateConstants.js';
import { getTemplateDefinition, variableDefinition } from './panelEmailTemplateRegistry.js';
import { validateTemplate, isDangerousUrl } from './panelEmailTemplateValidator.js';

/**
 * Moteur de rendu des templates e-mail — module PUR (aucun DOM, aucune base,
 * aucun réseau), donc testable directement sous Node.
 *
 * ─── CE MOTEUR N'ÉVALUE RIEN ─────────────────────────────────────────────────
 *
 * Il n'y a NI `eval`, NI `new Function`, NI expression, NI condition, NI boucle,
 * NI helper, NI accès dynamique à un objet. La seule opération est : « remplacer
 * `{{cle}}` par la valeur associée à `cle` dans une Map fournie ».
 *
 * C'est volontairement pauvre. Un moteur qui évalue est un moteur qu'on finit par
 * détourner, et un template est édité depuis une interface web : le pire scénario
 * n'est pas qu'il manque une boucle, c'est qu'un template devienne exécutable.
 *
 * ─── LES TROIS PROPRIÉTÉS QUI TIENNENT LA SÉCURITÉ ───────────────────────────
 *
 *  1. UNE SEULE PASSE. La substitution est un unique `String.replace` : une valeur
 *     qui CONTIENT `{{autre.cle}}` n'est jamais réinterprétée. Sans cela, le
 *     message d'un visiteur pourrait faire afficher une variable qu'il n'a pas le
 *     droit de lire — une injection de gabarit classique.
 *
 *  2. UNE `Map`, JAMAIS UN OBJET. `map.get('__proto__')` renvoie `undefined` ;
 *     `obj['__proto__']` renvoie un objet natif. La `Map` n'a pas de chaîne de
 *     prototype à remonter, donc rien à polluer.
 *
 *  3. ÉCHAPPEMENT PAR DÉFAUT. Toute valeur est échappée sauf `SAFE_HTML`, type
 *     qui doit être déclaré explicitement dans le registre. On ne peut pas
 *     produire du HTML par accident.
 */

/** Erreur de rendu. `code` est stable, `details` liste ce qui cloche. */
export class EmailRenderError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'EmailRenderError';
    this.code = code;
    this.details = details;
  }
}

// --- Échappement -------------------------------------------------------------

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Échappe une valeur pour un contexte HTML.
 *
 * Les cinq caractères, pas trois : `"` et `'` sont indispensables dès qu'une
 * valeur atterrit dans un attribut (`href="{{manager.contractUrl}}"`). Ne traiter
 * que `& < >` laisserait `" onmouseover="…` s'échapper de l'attribut.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Nettoie une valeur destinée au SUJET.
 *
 * Le sujet est un EN-TÊTE, pas du HTML : l'échapper afficherait « Jean &amp;
 * Marie » chez le destinataire. En revanche les retours à la ligne doivent
 * disparaître — un `\r\n` dans un en-tête est le vecteur historique d'injection
 * d'en-têtes SMTP. Brevo reçoit du JSON et ne construit pas l'en-tête par
 * concaténation, mais on ne s'appuie pas sur l'implémentation d'un tiers pour une
 * garantie de sécurité.
 */
export function sanitizeSubjectValue(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Retire les balises d'une valeur SAFE_HTML placée dans un sujet. */
function stripTags(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '');
}

// --- Formatage par type ------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Formate un montant en CENTIMES. Déterministe et sans ICU.
 *
 * `Intl.NumberFormat` produirait un résultat dépendant de la version d'ICU du
 * runtime : le même code afficherait une espace fine insécable ici et une espace
 * insécable là, et les tests deviendraient sensibles à la version de Node. Un
 * formateur explicite vaut mieux qu'un formateur intelligent qu'on ne contrôle
 * pas.
 */
export function formatMoney(cents, currency = 'EUR') {
  const n = Math.round(Number(cents));
  if (!Number.isFinite(n)) throw new Error('montant non numérique');
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const units = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const decimals = String(abs % 100).padStart(2, '0');
  const symbol = CURRENCY_SYMBOL[currency] || currency;
  return `${sign}${units},${decimals} ${symbol}`;
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error('date invalide');
  return d;
}

/**
 * Extrait les composantes d'une date dans le fuseau d'affichage.
 *
 * Passe par `Intl.DateTimeFormat` pour la CONVERSION de fuseau uniquement (c'est
 * la seule façon correcte de gérer l'heure d'été sans table de règles), mais
 * l'ASSEMBLAGE de la chaîne est fait ici : le format ne dépend donc pas de la
 * locale du runtime.
 */
function zonedParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) parts[type] = value;
  return parts;
}

export function formatDate(value) {
  const p = zonedParts(toDate(value));
  return `${p.day}/${p.month}/${p.year}`;
}

export function formatDateTime(value) {
  const p = zonedParts(toDate(value));
  return `${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}`;
}

/**
 * Convertit une valeur selon son type déclaré. Renvoie une chaîne NON échappée —
 * l'échappement dépend du contexte (HTML ou sujet) et appartient à l'appelant.
 *
 * Lève si la valeur ne correspond pas au type : une adresse e-mail qui n'en est
 * pas une, une URL en `javascript:`, une date illisible doivent bloquer l'envoi.
 * Rendre « Invalid Date » dans un e-mail client serait pire qu'un échec.
 */
export function formatValue(value, type, key = '') {
  const fail = (reason) => {
    throw new EmailRenderError(E.INVALID_VARIABLE_VALUE, `Valeur invalide pour « ${key} » : ${reason}.`, [
      { code: E.INVALID_VARIABLE_VALUE, variable: key, message: reason },
    ]);
  };

  switch (type) {
    case VARIABLE_TYPE.EMAIL: {
      const s = String(value ?? '').trim();
      if (!EMAIL_RE.test(s)) fail('ce n’est pas une adresse e-mail');
      return s;
    }
    case VARIABLE_TYPE.URL: {
      const s = String(value ?? '').trim();
      if (isDangerousUrl(s)) fail('schéma d’URL interdit');
      if (!/^(https?:|mailto:|tel:)/i.test(s)) fail('une URL doit commencer par http://, https://, mailto: ou tel:');
      return s;
    }
    case VARIABLE_TYPE.DATE:
      try {
        return formatDate(value);
      } catch {
        return fail('date illisible');
      }
    case VARIABLE_TYPE.DATETIME:
      try {
        return formatDateTime(value);
      } catch {
        return fail('date illisible');
      }
    case VARIABLE_TYPE.MONEY: {
      // Deux formes acceptées : un entier de centimes, ou { amount, currency }.
      // La seconde permet de porter la devise avec le montant — sans quoi un
      // montant en USD s'afficherait avec « € ».
      const isObject = value !== null && typeof value === 'object';
      const cents = isObject ? value.amount : value;
      const currency = isObject ? value.currency || 'EUR' : 'EUR';
      if (!Number.isFinite(Number(cents))) fail('montant non numérique (attendu : des centimes)');
      try {
        return formatMoney(cents, currency);
      } catch {
        return fail('montant illisible');
      }
      break;
    }
    case VARIABLE_TYPE.BOOLEAN: {
      if (typeof value !== 'boolean') fail('attendu : vrai ou faux');
      return value ? 'Oui' : 'Non';
    }
    case VARIABLE_TYPE.SAFE_HTML: {
      const s = String(value ?? '');
      // SAFE_HTML n'est pas « HTML de confiance » : c'est « HTML dont on accepte
      // les balises ». Il reste soumis au même refus des balises actives — sinon
      // le type deviendrait une porte dérobée contournant tout le validator.
      if (/<\s*\/?\s*(script|iframe|object|embed|applet|svg|math|form|link|base)\b/i.test(s)) {
        fail('contient une balise active interdite');
      }
      if (/\son[a-z]+\s*=/i.test(s)) fail('contient un gestionnaire d’événement inline');
      if (isDangerousUrl(s)) fail('contient une URL interdite');
      return s;
    }
    case VARIABLE_TYPE.PHONE:
    case VARIABLE_TYPE.TEXT:
    default: {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') fail('attendu : une valeur simple, pas un objet');
      return String(value);
    }
  }
}

// --- Rendu -------------------------------------------------------------------

/**
 * Normalise l'entrée en `Map`, en n'acceptant QUE les propriétés propres.
 *
 * `Object.entries` ignore la chaîne de prototype : une valeur héritée ne peut pas
 * se faufiler. Une `Map` fournie est recopiée pour que l'appelant ne puisse pas
 * la muter pendant le rendu.
 */
function toVariableMap(variables) {
  if (variables instanceof Map) return new Map(variables);
  if (variables && typeof variables === 'object') return new Map(Object.entries(variables));
  return new Map();
}

/**
 * Substitue les placeholders en UNE SEULE PASSE.
 *
 * @param {(key: string) => {ok: boolean, value: string}} resolve
 * @returns {{output: string, used: string[], unresolved: string[]}}
 */
function substitute(text, resolve) {
  const used = [];
  const unresolved = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  const output = String(text ?? '').replace(re, (raw, key) => {
    const r = resolve(key);
    if (!r.ok) {
      if (!unresolved.includes(key)) unresolved.push(key);
      return raw; // laissé tel quel : l'appelant lèvera, on ne masque rien
    }
    if (!used.includes(key)) used.push(key);
    return r.value;
  });
  return { output, used, unresolved };
}

/**
 * Rend un template.
 *
 * @param {object} input
 * @param {string} input.templateId          Doit exister dans le registre.
 * @param {object} input.template            Template PERSISTÉ { subject, html }.
 * @param {Map|object} input.variables       Valeurs fournies par le métier.
 * @param {boolean} [input.skipTemplateValidation] Réservé aux tests du renderer.
 * @returns {{subject:string, html:string, usedVariables:string[]}}
 */
export function renderTemplate({ templateId, template, variables, skipTemplateValidation = false }) {
  const definition = getTemplateDefinition(templateId);
  if (!definition) {
    throw new EmailRenderError(E.UNKNOWN_TEMPLATE, `Template inconnu : « ${templateId} ».`);
  }

  const subjectSource = String(template?.subject ?? '');
  const htmlSource = String(template?.html ?? '');

  // Le template persisté est revalidé À CHAQUE RENDU. Il a été validé à la
  // sauvegarde, mais le registre a pu changer depuis (variable retirée du code) :
  // un template valide hier peut être invalide aujourd'hui sans que personne ne
  // l'ait touché.
  if (!skipTemplateValidation) {
    const validation = validateTemplate({ templateId, subject: subjectSource, html: htmlSource });
    if (!validation.valid) {
      throw new EmailRenderError(
        E.TEMPLATE_INVALID,
        `Le template « ${templateId} » est invalide : aucun rendu possible.`,
        validation.errors
      );
    }
  }

  const values = toVariableMap(variables);
  const allowed = new Set(definition.variables.map((v) => v.key));

  // 1. Aucune variable INCONNUE. Une valeur fournie pour une clé qui n'existe pas
  //    signale une désynchronisation entre le métier et le registre : la taire
  //    laisserait le template s'afficher amputé, sans que personne ne le sache.
  const unknown = [...values.keys()].filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new EmailRenderError(
      E.UNKNOWN_VARIABLE,
      `Variable(s) inconnue(s) pour « ${templateId} » : ${unknown.join(', ')}.`,
      unknown.map((k) => ({ code: E.UNKNOWN_VARIABLE, variable: k, message: 'Variable absente du registre.' }))
    );
  }

  // 2. Toutes les variables REQUISES sont présentes et non vides.
  const missing = definition.variables
    .filter((v) => v.required)
    .filter((v) => {
      if (!values.has(v.key)) return true;
      const raw = values.get(v.key);
      return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    })
    .map((v) => v.key);
  if (missing.length) {
    throw new EmailRenderError(
      E.MISSING_REQUIRED_VARIABLE,
      `Variable(s) obligatoire(s) manquante(s) pour « ${templateId} » : ${missing.join(', ')}.`,
      missing.map((k) => ({ code: E.MISSING_REQUIRED_VARIABLE, variable: k, message: 'Valeur requise absente.' }))
    );
  }

  // 3. Formatage. Fait UNE FOIS par clé, avant substitution : une variable
  //    utilisée deux fois ne doit pas être formatée deux fois (ni pouvoir donner
  //    deux résultats différents).
  const formatted = new Map();
  for (const [key, raw] of values) {
    const def = variableDefinition(templateId, key);
    formatted.set(key, { text: formatValue(raw, def.type, key), type: def.type });
  }

  // Une variable FACULTATIVE non fournie vaut la chaîne vide — pas `{{cle}}`
  // laissé en clair dans l'e-mail du destinataire.
  const resolveFor = (context) => (key) => {
    if (!allowed.has(key)) return { ok: false, value: '' };
    if (!formatted.has(key)) return { ok: true, value: '' };
    const { text, type } = formatted.get(key);
    if (context === 'subject') {
      return { ok: true, value: sanitizeSubjectValue(type === VARIABLE_TYPE.SAFE_HTML ? stripTags(text) : text) };
    }
    return { ok: true, value: type === VARIABLE_TYPE.SAFE_HTML ? text : escapeHtml(text) };
  };

  const subjectResult = substitute(subjectSource, resolveFor('subject'));
  const htmlResult = substitute(htmlSource, resolveFor('html'));

  // 4. Placeholder non résolu = clé absente du registre restée dans le template
  //    (variable retirée du code depuis la dernière sauvegarde). On refuse plutôt
  //    que d'envoyer un e-mail où le destinataire lirait « {{contact.oldField}} ».
  const unresolved = [...new Set([...subjectResult.unresolved, ...htmlResult.unresolved])];
  if (unresolved.length) {
    throw new EmailRenderError(
      E.UNRESOLVED_PLACEHOLDER,
      `Placeholder(s) non résolu(s) dans « ${templateId} » : ${unresolved.join(', ')}.`,
      unresolved.map((k) => ({
        code: E.UNRESOLVED_PLACEHOLDER,
        variable: k,
        message: 'Ce placeholder ne correspond à aucune variable du registre.',
      }))
    );
  }

  const subject = sanitizeSubjectValue(subjectResult.output);
  if (!subject) {
    throw new EmailRenderError(E.SUBJECT_EMPTY, 'Le sujet rendu est vide.');
  }

  return {
    subject,
    html: htmlResult.output,
    usedVariables: [...new Set([...subjectResult.used, ...htmlResult.used])],
  };
}

export default { renderTemplate, escapeHtml, formatValue, formatMoney, formatDate, formatDateTime, EmailRenderError };
