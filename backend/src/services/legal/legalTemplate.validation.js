// LA VALIDATION D'UN CONTENU LÉGAL — la seule porte d'entrée du texte.
//
// ══ CE QU'ELLE GARANTIT, ET CE SUR QUOI ELLE NE REPOSE PAS ══════════════════
//
// Elle garantit qu'un document enregistré ne contient QUE :
//
//   · du texte brut, sans balise ni entité HTML active ;
//   · des `{{cle}}` dont la clé existe au registre.
//
// Elle ne repose pas sur un échappement au rendu. C'est délibéré : un
// échappement protège le lecteur qui l'applique, et il suffit d'un lecteur qui
// l'oublie — une page, un e-mail, un export PDF — pour que la faille
// réapparaisse. Ici la donnée est propre EN BASE, et le rendu n'a rien à
// défaire.
//
// ══ POURQUOI ELLE REFUSE AU LIEU DE NETTOYER ════════════════════════════════
//
// Un nettoyage silencieux enregistrerait un document que personne n'a écrit :
// l'opérateur relirait son texte à l'écran, y verrait ce qu'il a tapé, et la
// base contiendrait autre chose. Le refus, lui, nomme le bloc fautif et rend
// la main.
//
// La seule exception est la NORMALISATION D'ESPACES — retirer un blanc final,
// unifier les fins de ligne. Elle ne change pas le sens, et refuser un
// paragraphe pour une espace en trop serait une brimade.
import { randomUUID } from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import {
  LEGAL_BLOCK_TYPES,
  LEGAL_BLOCK_TYPE_VALUES,
  LEGAL_DOCUMENT_TYPE_VALUES,
} from '../../models/PanelLegalTemplate.model.js';
import { isKnownVariable, referencedKeys, suspiciousTokens } from './legalVariableRegistry.js';

/** Bornes — larges, mais fermées. Un document sans borne est un vecteur. */
export const LIMITS = Object.freeze({
  TITLE: 160,
  HEADING: 200,
  TEXT: 6000,
  LIST_ITEM: 2000,
  FIELD_LABEL: 120,
  FIELD_VALUE: 600,
  SECTIONS: 40,
  BLOCKS_PER_SECTION: 40,
  ITEMS_PER_BLOCK: 60,
});

/**
 * LES MOTIFS INTERDITS — ce qui n'a rien à faire dans un texte juridique.
 *
 * `<` et `>` d'abord : ils suffisent à ouvrir une balise, et un document légal
 * n'en a jamais besoin. Interdire le CARACTÈRE plutôt que la liste des balises
 * dangereuses évite la course sans fin entre une liste noire et l'imagination
 * d'un attaquant — ou, bien plus probable ici, un copier-coller depuis une page
 * web qui embarquerait du balisage sans qu'on le voie.
 *
 * `&…;` ensuite : une entité HTML est du balisage déguisé. `&lt;script&gt;`
 * traverserait un contrôle qui ne regarde que `<`.
 */
const FORBIDDEN = [
  { pattern: /[<>]/, code: 'LEGAL_CONTENT_MARKUP', message: 'Les caractères « < » et « > » ne sont pas autorisés.' },
  { pattern: /&[a-zA-Z#][a-zA-Z0-9]{1,10};/, code: 'LEGAL_CONTENT_ENTITY', message: 'Les entités HTML ne sont pas autorisées.' },
  // eslint-disable-next-line no-control-regex
  { pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, code: 'LEGAL_CONTENT_CONTROL', message: 'Le texte contient des caractères de contrôle.' },
];

/**
 * NORMALISATION — fins de ligne unifiées, blancs de bord retirés.
 *
 * `\r\n` vient de tous les copier-coller Windows. Le conserver ferait diverger
 * deux textes rigoureusement identiques à l'œil, et rendrait la comparaison de
 * deux versions inutilisable.
 */
function normalize(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function assertClean(value, { field, max }) {
  const text = normalize(value);
  if (text.length > max) {
    throw ApiError.badRequest(
      'LEGAL_CONTENT_TOO_LONG',
      `${field} dépasse ${max} caractères.`,
      { field, max, length: text.length },
    );
  }
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) {
      throw ApiError.badRequest(rule.code, `${field} : ${rule.message}`, { field });
    }
  }
  /**
   * LES VARIABLES SONT VÉRIFIÉES ICI, PAS AU RENDU.
   *
   * Une clé inconnue découverte au rendu produirait, au mieux, un trou sur la
   * page publique d'un client ; au pire, la chaîne `{{client.sirett}}` telle
   * quelle. Le seul moment où quelqu'un peut la corriger est celui où il
   * l'écrit.
   *
   * Le balayage est LARGE (`suspiciousTokens`) : il attrape aussi les `{{`
   * mal fermés, que la syntaxe stricte ignorerait en silence.
   */
  const bad = suspiciousTokens(text);
  if (bad.length > 0) {
    throw ApiError.badRequest(
      'LEGAL_CONTENT_UNKNOWN_VARIABLE',
      `${field} : donnée inconnue ${bad[0]}. Utilisez « + Insérer une donnée ».`,
      { field, tokens: bad.slice(0, 5) },
    );
  }
  return text;
}

function newId(prefix) {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Valide et normalise un bloc. Rend un objet PROPRE, prêt pour la base :
 * seuls les champs du type retenu sont peuplés, les autres sont vides.
 *
 * Laisser traîner un `items[]` sur un PARAGRAPH ne casserait rien aujourd'hui,
 * et ferait exactement un dégât demain : un rendu qui, ayant changé d'ordre de
 * lecture, afficherait une liste que l'éditeur n'avait jamais montrée.
 */
function validateBlock(raw, path) {
  const type = String(raw?.type ?? '').toUpperCase();
  if (!LEGAL_BLOCK_TYPE_VALUES.includes(type)) {
    throw ApiError.badRequest(
      'LEGAL_CONTENT_BLOCK_TYPE',
      `${path} : type de bloc inconnu « ${type || '—'} ».`,
      { path, allowed: LEGAL_BLOCK_TYPE_VALUES },
    );
  }

  const blockId = typeof raw.blockId === 'string' && raw.blockId.trim()
    ? raw.blockId.trim().slice(0, 40)
    : newId('blk');

  if (type === LEGAL_BLOCK_TYPES.PARAGRAPH) {
    return {
      blockId,
      type,
      text: assertClean(raw.text, { field: `${path} (paragraphe)`, max: LIMITS.TEXT }),
      items: [],
      fields: [],
    };
  }

  if (type === LEGAL_BLOCK_TYPES.LIST) {
    const source = Array.isArray(raw.items) ? raw.items : [];
    if (source.length > LIMITS.ITEMS_PER_BLOCK) {
      throw ApiError.badRequest(
        'LEGAL_CONTENT_TOO_MANY_ITEMS',
        `${path} : ${LIMITS.ITEMS_PER_BLOCK} puces au maximum.`,
        { path },
      );
    }
    const items = source
      .map((item, i) => assertClean(item, { field: `${path} · puce ${i + 1}`, max: LIMITS.LIST_ITEM }))
      // Une puce vide n'est pas une erreur de saisie à signaler : c'est une
      // ligne qu'on vient d'ajouter et qu'on n'a pas remplie. On la retire.
      .filter((item) => item.length > 0);
    return { blockId, type, text: '', items, fields: [] };
  }

  const source = Array.isArray(raw.fields) ? raw.fields : [];
  if (source.length > LIMITS.ITEMS_PER_BLOCK) {
    throw ApiError.badRequest(
      'LEGAL_CONTENT_TOO_MANY_ITEMS',
      `${path} : ${LIMITS.ITEMS_PER_BLOCK} lignes au maximum.`,
      { path },
    );
  }
  const fields = source
    .map((item, i) => ({
      label: assertClean(item?.label, { field: `${path} · libellé ${i + 1}`, max: LIMITS.FIELD_LABEL }),
      value: assertClean(item?.value, { field: `${path} · valeur ${i + 1}`, max: LIMITS.FIELD_VALUE }),
    }))
    .filter((item) => item.label.length > 0 || item.value.length > 0);
  return { blockId, type, text: '', items: [], fields };
}

function validateSection(raw, index) {
  const path = `Section ${index + 1}`;
  const sectionId = typeof raw?.sectionId === 'string' && raw.sectionId.trim()
    ? raw.sectionId.trim().slice(0, 40)
    : newId('sec');

  const blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
  if (blocks.length > LIMITS.BLOCKS_PER_SECTION) {
    throw ApiError.badRequest(
      'LEGAL_CONTENT_TOO_MANY_BLOCKS',
      `${path} : ${LIMITS.BLOCKS_PER_SECTION} blocs au maximum.`,
      { path },
    );
  }

  return {
    sectionId,
    heading: assertClean(raw?.heading, { field: `${path} · titre`, max: LIMITS.HEADING }),
    blocks: blocks.map((block, i) => validateBlock(block, `${path} · bloc ${i + 1}`)),
  };
}

/** Valide un document COMPLET. Lève une `ApiError` nommant le premier défaut. */
export function validateContent(raw) {
  const sections = Array.isArray(raw?.sections) ? raw.sections : [];
  if (sections.length > LIMITS.SECTIONS) {
    throw ApiError.badRequest(
      'LEGAL_CONTENT_TOO_MANY_SECTIONS',
      `${LIMITS.SECTIONS} sections au maximum.`,
      {},
    );
  }
  return {
    title: assertClean(raw?.title, { field: 'Titre du document', max: LIMITS.TITLE }),
    sections: sections.map(validateSection),
  };
}

/** Le type demandé existe-t-il ? Seule autorité sur cette question. */
export function assertKnownType(type) {
  const value = String(type ?? '').toUpperCase();
  if (!LEGAL_DOCUMENT_TYPE_VALUES.includes(value)) {
    throw ApiError.badRequest(
      'LEGAL_TEMPLATE_TYPE_UNKNOWN',
      `Type de document inconnu « ${type} ».`,
      { allowed: LEGAL_DOCUMENT_TYPE_VALUES },
    );
  }
  return value;
}

/**
 * Toutes les clés référencées par un document, dans l'ordre de lecture.
 *
 * Sert à deux écrans : la complétude d'un projet (« ce template utilise 9
 * données, 8 sont disponibles ») et l'avertissement de la fiche projet. Elle
 * ne rend QUE des clés du registre — le validateur a déjà refusé les autres,
 * mais un document amorcé avant une évolution du registre pourrait en porter
 * une devenue inconnue, et une clé fantôme dans un décompte fausserait le
 * verdict sans qu'on sache pourquoi.
 */
export function contentVariableKeys(content) {
  const keys = [];
  const push = (text) => {
    for (const key of referencedKeys(text)) {
      if (isKnownVariable(key) && !keys.includes(key)) keys.push(key);
    }
  };
  push(content?.title);
  for (const section of content?.sections ?? []) {
    push(section.heading);
    for (const block of section.blocks ?? []) {
      push(block.text);
      for (const item of block.items ?? []) push(item);
      for (const field of block.fields ?? []) {
        push(field.label);
        push(field.value);
      }
    }
  }
  return keys;
}

export default { validateContent, assertKnownType, contentVariableKeys, LIMITS };
