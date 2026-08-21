// VALIDATION DU CONTENU D’UN TEMPLATE — l’autorité du Panel (L8.3).
//
// ══ CE FICHIER EST UN DÉPLACEMENT D'AUTORITÉ, PAS UNE COPIE ══════════════════
//
// L8 a tranché : `TEMPLATE_AUTHORITIES.PANEL`. Le contenu des e-mails vit
// désormais ICI — versionné, validé, rendu par le Panel — et le corps envoyé à
// Brevo porte `subject` + `htmlContent`, jamais un `templateId` du fournisseur
// qui ferait sortir le contenu de nos versions.
//
// Ce module vient du dépôt PROJET (`backend/src/services/email/emailTemplateValidator.js`). Il n'est PAS
// dupliqué pour le plaisir : l'autorité change de côté, et le moteur suit le
// contenu qu'il rend. Le jour où l'envoi projet sera retiré (L10), l'exemplaire
// d'origine partira avec lui — c'est le sens du déplacement.
//
// Aucune règle n'a été assouplie au passage. Ce qui suit est le module éprouvé
// du projet, à l'identique sauf ses imports.

import {
  EMAIL_TEMPLATE_ERROR_CODES as E,
  FORBIDDEN_TAGS,
  FORBIDDEN_ATTRIBUTES,
  FORBIDDEN_ATTRIBUTE_PATTERNS,
  URL_ATTRIBUTES,
  DANGEROUS_URL_SCHEMES,
  DATA_IMAGE_RE,
  PLACEHOLDER_RE,
  ANY_MUSTACHE_RE,
  BLOCK_OPEN_RE,
  BLOCK_CLOSE_RE,
  MAX_SUBJECT_LENGTH,
  MAX_HTML_LENGTH,
} from '../../utils/panelEmailTemplateConstants.js';
import { allowedVariableKeys, variablesFor, isKnownTemplateId } from './panelEmailTemplateRegistry.js';

/**
 * Validation d'un template e-mail — module PUR (aucun DOM, aucun import runtime,
 * aucun accès base), donc testable directement sous Node.
 *
 * ─── IL REJETTE, IL NE NETTOIE PAS ───────────────────────────────────────────
 *
 * Aucune tentative d'assainissement : un template dangereux est REFUSÉ, avec la
 * raison. Nettoyer silencieusement produirait un contenu que son auteur n'a pas
 * écrit et ne peut pas relire — et une passe de nettoyage ratée est une faille,
 * là qu'un refus raté n'est qu'un faux positif.
 *
 * Conséquence assumée : l'analyse est faite au motif, pas par un parseur HTML
 * (il n'y en a pas dans ce projet, et en ajouter un pour valider ce que l'on
 * refuse de toute façon serait disproportionné). Elle est donc VOLONTAIREMENT
 * trop stricte par endroits — `<script` dans un commentaire HTML est refusé.
 * C'est le bon sens du compromis : le DEV réécrit sa ligne, personne n'est exposé.
 *
 * ─── CE QU'IL NE FAIT PAS ────────────────────────────────────────────────────
 *
 * Il ne connaît AUCUNE valeur de variable : il valide la FORME du template, pas
 * son rendu. Les valeurs sont l'affaire du renderer, qui les échappe.
 */

/** Numéro de ligne (1-indexé) d'une position dans un texte. */
function lineAt(text, index) {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Décode les entités HTML d'une valeur d'attribut AVANT d'en analyser le schéma.
 *
 * Sans cela, `href="java&#115;cript:alert(1)"` passerait : le navigateur décode
 * l'entité, notre `includes('javascript:')` non. C'est un contournement classique
 * — le décodage doit précéder la décision, jamais l'inverse.
 *
 * On ne gère que ce qui sert à ce contrôle (numérique décimal/hexa + quelques
 * entités nommées) : ce n'est pas un décodeur HTML général et il ne prétend pas
 * l'être.
 */
export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&colon;/gi, ':')
    .replace(/&amp;/gi, '&');
}

function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Normalise une URL pour l'analyse de schéma : entités décodées, espaces et
 * caractères de contrôle retirés, casse abaissée.
 *
 * `java\tscript:` et `  javascript:` sont interprétés comme `javascript:` par les
 * navigateurs — les retirer AVANT la comparaison est indispensable.
 */
function normalizeUrl(value) {
  return decodeEntities(value)
    // Caracteres de controle (dont tab/newline), espace, espace insecable.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020\u00a0\u2028\u2029]/g, '')
    .toLowerCase();
}

/** L'URL porte-t-elle un schéma interdit ? */
export function isDangerousUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return false;
  // Un placeholder seul est légitime : c'est le renderer qui validera la valeur.
  if (/^\{\{[a-z0-9_.]+\}\}$/i.test(url)) return false;
  if (DANGEROUS_URL_SCHEMES.some((scheme) => url.startsWith(scheme))) return true;
  // `data:` n'est toléré que pour une image bitmap — `data:text/html` est un
  // contournement direct de l'interdiction d'iframe.
  if (url.startsWith('data:') && !DATA_IMAGE_RE.test(decodeEntities(value).trim())) return true;
  return false;
}

/** Toutes les balises ouvrantes rencontrées, avec leur position. */
function scanTags(html) {
  const found = [];
  const re = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    found.push({ tag: m[1].toLowerCase(), index: m.index });
  }
  return found;
}

/** Tous les attributs rencontrés (`nom="valeur"`, `nom='valeur'`, `nom=valeur`). */
function scanAttributes(html) {
  const found = [];
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    found.push({
      name: m[1].toLowerCase(),
      value: m[3] ?? m[4] ?? m[5] ?? '',
      index: m.index,
    });
  }
  return found;
}

/** Placeholders SYNTAXIQUEMENT VALIDES d'un texte (dédupliqués, ordre conservé). */
export function extractPlaceholders(text) {
  const keys = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/**
 * `{{ … }}` qui n'est PAS un placeholder valide.
 *
 * C'est le point qui rend l'interdiction réelle : sans lui, `{{a["b"]}}` ou
 * `{{__proto__}}` seraient simplement laissés en texte brut dans l'e-mail. Le DEV
 * croirait avoir écrit une variable, et le destinataire lirait des accolades.
 * On préfère refuser.
 */
export function extractInvalidPlaceholders(text) {
  const source = String(text ?? '');
  const valid = new Set();
  const validRe = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m;
  while ((m = validRe.exec(source)) !== null) valid.add(m[0]);

  /**
   * ── LES MARQUEURS DE BLOC SONT VALIDES, EUX AUSSI ──────────────────────
   *
   * `{{#if contact.pageUrl}}` et `{{/if}}` ne matchent pas
   * `PLACEHOLDER_RE` — ils ne sont pas des variables. Sans cette ligne, ils
   * seraient donc dénoncés comme « placeholders invalides » et aucun
   * template ne pourrait plus porter de bloc facultatif.
   *
   * Ils restent soumis à la MÊME grammaire de clé : `{{#if a["b"]}}` ou
   * `{{#if __proto__}}` ne matchent pas non plus, et sont donc refusés.
   */
  for (const re of [BLOCK_OPEN_RE, BLOCK_CLOSE_RE]) {
    const blockRe = new RegExp(re.source, re.flags);
    while ((m = blockRe.exec(source)) !== null) valid.add(m[0]);
  }

  const invalid = [];
  const anyRe = new RegExp(ANY_MUSTACHE_RE.source, 'g');
  while ((m = anyRe.exec(source)) !== null) {
    if (!valid.has(m[0])) invalid.push({ raw: m[0], inner: m[1].trim(), index: m.index });
  }
  return invalid;
}

/**
 * Valide un template contre sa définition du registre.
 *
 * @param {object} input
 * @param {string} input.templateId
 * @param {string} input.subject
 * @param {string} input.html
 * @returns {{valid:boolean, errors:{code:string,message:string,line?:number,variable?:string}[]}}
 */
export function validateTemplate({ templateId, subject, html }) {
  const errors = [];
  const push = (code, message, extra = {}) => errors.push({ code, message, ...extra });

  if (!isKnownTemplateId(templateId)) {
    push(E.UNKNOWN_TEMPLATE, `Template inconnu : « ${templateId} ». Les identifiants sont définis dans le code.`);
    // Sans définition, on ne peut rien valider d'autre : les variables autorisées
    // sont inconnues. Poursuivre produirait un flot d'erreurs trompeuses.
    return { valid: false, errors };
  }

  const subjectText = String(subject ?? '');
  const htmlText = String(html ?? '');

  // --- Sujet -----------------------------------------------------------------
  if (!subjectText.trim()) {
    push(E.SUBJECT_EMPTY, 'Le sujet est obligatoire : un e-mail sans sujet est traité comme du spam.');
  }
  if (subjectText.length > MAX_SUBJECT_LENGTH) {
    push(
      E.SUBJECT_TOO_LONG,
      `Sujet trop long (${subjectText.length} caractères, maximum ${MAX_SUBJECT_LENGTH}).`
    );
  }

  // --- HTML : taille ---------------------------------------------------------
  if (!htmlText.trim()) {
    push(E.HTML_EMPTY, 'Le contenu HTML est obligatoire.');
  }
  if (htmlText.length > MAX_HTML_LENGTH) {
    push(
      E.HTML_TOO_LONG,
      `Contenu trop volumineux (${htmlText.length} caractères, maximum ${MAX_HTML_LENGTH}). ` +
        'Au-delà, Gmail tronque le message et affiche « [Message tronqué] ».'
    );
  }

  // --- HTML : balises interdites ---------------------------------------------
  for (const { tag, index } of scanTags(htmlText)) {
    if (FORBIDDEN_TAGS.includes(tag)) {
      push(E.FORBIDDEN_TAG, `Balise interdite : <${tag}>. Un e-mail ne peut pas contenir de contenu actif.`, {
        line: lineAt(htmlText, index),
      });
    }
  }

  // --- HTML : attributs interdits --------------------------------------------
  for (const { name, value, index } of scanAttributes(htmlText)) {
    const forbiddenByPattern = FORBIDDEN_ATTRIBUTE_PATTERNS.some((re) => re.test(name));
    if (forbiddenByPattern || FORBIDDEN_ATTRIBUTES.includes(name)) {
      push(
        E.FORBIDDEN_ATTRIBUTE,
        `Attribut interdit : « ${name} ». Les gestionnaires d'événements et le contenu embarqué sont refusés.`,
        { line: lineAt(htmlText, index) }
      );
      continue;
    }
    // Le schéma est contrôlé sur TOUT attribut, pas seulement sur href/src :
    // `style="background:url(javascript:…)"` en est un vecteur.
    const suspectValue = URL_ATTRIBUTES.includes(name) ? value : extractUrlFromCss(value);
    if (suspectValue && isDangerousUrl(suspectValue)) {
      push(E.DANGEROUS_URL, `URL interdite dans « ${name} » : seuls http, https, mailto, tel et data:image sont acceptés.`, {
        line: lineAt(htmlText, index),
      });
    }
  }

  // --- Placeholders ----------------------------------------------------------
  const allowed = allowedVariableKeys(templateId);
  const content = `${subjectText}\n${htmlText}`;

  for (const { raw, index } of extractInvalidPlaceholders(content)) {
    push(
      E.INVALID_PLACEHOLDER,
      `Placeholder invalide : « ${raw} ». La seule syntaxe acceptée est {{groupe.cle}} — ` +
        'aucune expression, aucune condition, aucune boucle, aucun appel de fonction.',
      { line: lineAt(content, index) }
    );
  }

  for (const key of extractPlaceholders(content)) {
    if (!allowed.has(key)) {
      push(E.UNKNOWN_VARIABLE, `Variable inconnue : « ${key} ». Les variables sont définies dans le code.`, {
        variable: key,
      });
    }
  }

  // Une variable requise absente du contenu : le rendu produirait un e-mail
  // amputé d'une information que le métier juge indispensable.
  /**
   * ── LES BLOCS FACULTATIFS ──────────────────────────────────────────────
   *
   * Deux contrôles, et les deux comptent :
   *
   *   LA CLÉ    un bloc qui teste une variable inexistante ne s’afficherait
   *             JAMAIS. Le rédacteur croirait avoir écrit une condition ;
   *             le destinataire ne verrait jamais le contenu. Un silence
   *             est plus coûteux qu’un refus.
   *
   *   L’APPARIEMENT  une ouverture sans fermeture laisse le marqueur en
   *             clair dans l’e-mail — « {{#if contact.pageUrl}} » lisible
   *             par le client. Le rendu échouerait plus loin, mais le refus
   *             doit tomber ICI, à l’enregistrement, devant celui qui écrit.
   */
  const ouvertures = [...content.matchAll(new RegExp(BLOCK_OPEN_RE.source, BLOCK_OPEN_RE.flags))];
  const fermetures = [...content.matchAll(new RegExp(BLOCK_CLOSE_RE.source, BLOCK_CLOSE_RE.flags))];
  for (const ouverture of ouvertures) {
    const cle = ouverture[1];
    if (!allowed.has(cle)) {
      push(
        E.UNKNOWN_VARIABLE,
        `Bloc conditionnel sur une variable inconnue : « ${cle} ». Le bloc ne s’afficherait jamais.`,
        { variable: cle, line: lineAt(content, ouverture.index) },
      );
    }
  }
  if (ouvertures.length !== fermetures.length) {
    push(
      E.INVALID_PLACEHOLDER,
      `Bloc conditionnel déséquilibré : ${ouvertures.length} ouverture(s) « {{#if …}} » pour `
      + `${fermetures.length} fermeture(s) « {{/if}} ». Chaque bloc doit être refermé.`,
    );
  }

  // Une variable requise absente du contenu : le rendu produirait un e-mail
  // amputé d'une information que le métier juge indispensable.
  /**
   * ── UNE VARIABLE OBLIGATOIRE HORS DES BLOCS ────────────────────────────
   *
   * Le contrôle de présence lit le contenu DÉBARRASSÉ de ses blocs
   * facultatifs. Sans cela, on pourrait satisfaire « la variable obligatoire
   * figure bien dans le template » en la plaçant à l’intérieur d’un bloc
   * qui, par définition, peut ne pas s’afficher — et l’e-mail partirait sans
   * l’information que le métier juge indispensable.
   *
   * Le retrait est brutal et c’est voulu : on ne cherche pas à savoir si le
   * bloc s’afficherait, on refuse la possibilité qu’il ne s’affiche pas.
   */
  const contenuHorsBlocs = content.replace(
    new RegExp(`${BLOCK_OPEN_RE.source}[\\s\\S]*?${BLOCK_CLOSE_RE.source}`, 'g'),
    '',
  );
  const used = new Set(extractPlaceholders(contenuHorsBlocs));
  for (const v of variablesFor(templateId).filter((x) => x.required)) {
    if (!used.has(v.key)) {
      push(
        E.MISSING_REQUIRED_VARIABLE,
        `Variable obligatoire absente : « ${v.key} » (${v.label}). Elle doit figurer dans le sujet ou dans le contenu.`,
        { variable: v.key }
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extrait l'URL d'une déclaration CSS `url(…)`, ou `''`.
 *
 * Sert à contrôler `style="background:url(javascript:alert(1))"` : la valeur de
 * `style` n'est pas une URL, mais elle peut en CONTENIR une.
 */
function extractUrlFromCss(value) {
  const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(String(value ?? ''));
  return m ? m[2] : '';
}

export default { validateTemplate, extractPlaceholders, extractInvalidPlaceholders, isDangerousUrl, decodeEntities };
