/**
 * PARTICIPANTS — des PERSONNES, pas une chaîne de caractères.
 *
 * ── CE QUI EXISTAIT, ET POURQUOI C'ÉTAIT INSUFFISANT ────────────────────────
 * Une réunion portait deux champs : `internalParticipants` (des objets à moitié
 * vides : un nom, un courriel, rien d'autre) et `externalParticipants`, un
 * simple tableau de chaînes que l'interface remplissait en découpant un champ
 * texte sur les virgules.
 *
 * Le séparateur manuel est le défaut de fond : il n'existe que dans la tête de
 * celui qui saisit. « Jean Dupont, Garage du Centre » vaut deux participants
 * pour l'un, un seul pour l'autre. On ne peut ni corriger un participant sans
 * réécrire toute la ligne, ni en retirer un sans risquer d'en couper un autre,
 * ni retrouver un numéro de téléphone qui n'avait nulle part où être écrit.
 *
 * ── CE QUE C'EST DEVENU ─────────────────────────────────────────────────────
 * Une LISTE d'éléments identifiés :
 *
 *   { id, type: 'INTERNAL' | 'EXTERNAL', name, email?, phone? }
 *
 * `id` rend chaque participant modifiable et supprimable INDIVIDUELLEMENT :
 * sans lui, l'interface ne pourrait désigner une ligne que par sa position, et
 * une suppression décalerait tout ce qui suit.
 *
 * `type` remplace les deux anciens champs. Interne ou externe est une PROPRIÉTÉ
 * de la personne, pas deux listes à tenir en parallèle : deux listes obligent à
 * déplacer un élément d'un tableau à l'autre pour corriger une erreur de
 * saisie, alors qu'il suffit ici de changer une valeur.
 *
 * ── LA VIRGULE N'A PLUS COURS ICI ───────────────────────────────────────────
 * Ce service a un temps REFUSÉ toute valeur contenant une virgule, pour
 * empêcher qu'on refabrique l'ancienne chaîne. Cette garde a été retirée : elle
 * prolongeait dans le code vivant un problème qui n'appartient plus qu'à
 * l'histoire, et refusait au passage des noms parfaitement légitimes —
 * « Atelier Dupont, SARL » n'a rien d'une liste déguisée.
 *
 * Une fois la migration passée, il n'y a plus de séparateur à surveiller parce
 * qu'il n'y a plus de champ où il servirait : chaque personne a sa ligne, et une
 * virgule dans un nom n'est qu'un caractère de plus. La seule connaissance de la
 * virgule qui subsiste vit dans `eventsMigration.js` — du code de reprise, qui
 * ne trouve plus rien à faire une fois la base convertie.
 *
 * ── LA RÈGLE QUI RESTE ──────────────────────────────────────────────────────
 * AUCUN participant vide n'est persisté. Une ligne ouverte puis abandonnée dans
 * le formulaire ne doit pas devenir une personne fantôme dans l'historique.
 */
import crypto from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import { PARTICIPANT_TYPES } from '../../models/PanelMeeting.model.js';

const newId = () => crypto.randomUUID();

const texte = (valeur) => (valeur === null || valeur === undefined ? '' : String(valeur).trim());

/**
 * NORMALISE ce que l'API reçoit.
 *
 * @param {unknown} entree la valeur reçue
 * @returns {object[]} des participants propres, chacun avec un identifiant
 */
export function normalizeParticipants(entree) {
  if (entree === null || entree === undefined) return [];
  if (!Array.isArray(entree)) {
    throw ApiError.badRequest(
      'PANEL_PARTICIPANTS_FORMAT',
      'Les participants se transmettent en liste d’éléments, pas en texte.',
    );
  }

  const vus = new Set();
  const propres = [];

  for (const brut of entree) {
    // Une chaîne, c'est l'ancien monde qui revient par la fenêtre.
    if (typeof brut === 'string') {
      throw ApiError.badRequest(
        'PANEL_PARTICIPANTS_FORMAT',
        'Un participant est un élément structuré (nom, courriel, téléphone), pas une chaîne.',
      );
    }
    if (!brut || typeof brut !== 'object') continue;

    const type = texte(brut.type) || 'EXTERNAL';
    if (!PARTICIPANT_TYPES.includes(type)) {
      throw ApiError.badRequest(
        'PANEL_PARTICIPANT_TYPE_UNKNOWN',
        'Un participant est interne ou externe.',
      );
    }

    const name = texte(brut.name);
    const email = texte(brut.email).toLowerCase();
    const phone = texte(brut.phone);

    // La seule règle : une ligne sans la moindre information n'est pas une
    // personne.
    if (!name && !email && !phone) continue;

    // Un identifiant absent ou déjà pris est REMPLACÉ : deux participants qui
    // partagent une identité ne seraient plus modifiables séparément.
    let id = texte(brut.id);
    if (!id || vus.has(id)) id = newId();
    vus.add(id);

    propres.push({
      id,
      type,
      // Un participant connu par son seul courriel garde ce courriel pour nom :
      // c'est ce qu'on sait de lui, et l'inventer serait pire.
      name: name || email || phone,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    });
  }

  return propres;
}

/**
 * REFUSE les anciens champs.
 *
 * Un client resté sur l'ancienne version enverrait ses virgules sans que rien
 * ne proteste : les participants disparaîtraient silencieusement de la réunion
 * qu'il vient d'enregistrer. Mieux vaut une erreur lisible.
 */
export function refuseLegacyParticipants(data = {}) {
  if (data.internalParticipants !== undefined || data.externalParticipants !== undefined) {
    throw ApiError.badRequest(
      'PANEL_PARTICIPANTS_LEGACY',
      'Les participants se transmettent dans une seule liste structurée `participants`.',
    );
  }
}

/** Un identifiant neuf, pour un participant qui n'en a pas encore. */
export const nouvelIdentifiant = newId;

/** Deux participants sont le MÊME dès qu'ils disent la même chose. */
export function participantKey(p) {
  return [p.type, texte(p.name).toLowerCase(), texte(p.email).toLowerCase(), texte(p.phone)].join('|');
}

/**
 * Fusionne sans doublon — ce qui rend la migration rejouable sans gonfler la
 * liste à chaque passage.
 */
export function mergeParticipants(...listes) {
  const vus = new Set();
  const fusion = [];
  for (const participant of listes.flat()) {
    if (!participant) continue;
    const cle = participantKey(participant);
    if (vus.has(cle)) continue;
    vus.add(cle);
    // L'identifiant déjà attribué est CONSERVÉ : le régénérer ferait d'un
    // second passage de migration une modification, alors qu'il ne doit rien
    // changer du tout.
    fusion.push({ ...participant, id: texte(participant.id) || newId() });
  }
  return fusion;
}

export default {
  normalizeParticipants,
  refuseLegacyParticipants,
  mergeParticipants,
  participantKey,
  nouvelIdentifiant,
};
