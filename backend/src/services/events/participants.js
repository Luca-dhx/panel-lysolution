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
 * ── DEUX RÈGLES, TENUES ICI ET NULLE PART AILLEURS ──────────────────────────
 * 1. AUCUN participant vide n'est persisté. Une ligne ouverte puis abandonnée
 *    dans le formulaire ne doit pas devenir une personne fantôme dans
 *    l'historique.
 * 2. AUCUNE valeur ne contient de séparateur. Une virgule ou un point-virgule
 *    dans un nom signale qu'on est en train de refabriquer l'ancienne chaîne :
 *    c'est REFUSÉ, avec un message qui dit quoi faire. La migration, elle, fait
 *    l'inverse — elle DÉCOUPE — parce qu'une ancienne valeur « A, B » voulait
 *    bien dire deux personnes.
 */
import crypto from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import { PARTICIPANT_TYPES } from '../../models/PanelMeeting.model.js';

/** Ce qui trahit une liste déguisée en chaîne. */
const SEPARATEURS = /[,;]/;

const newId = () => crypto.randomUUID();

const texte = (valeur) => (valeur === null || valeur === undefined ? '' : String(valeur).trim());

function refuseSeparateur(valeur, champ) {
  if (SEPARATEURS.test(valeur)) {
    throw ApiError.badRequest(
      'PANEL_PARTICIPANT_SEPARATOR',
      `Le champ « ${champ} » contient un séparateur : ajoutez un participant par personne.`,
    );
  }
  return valeur;
}

/**
 * NORMALISE ce que l'API reçoit. Strict, parce que c'est la frontière.
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

    const name = refuseSeparateur(texte(brut.name), 'nom');
    const email = refuseSeparateur(texte(brut.email), 'courriel').toLowerCase();
    const phone = refuseSeparateur(texte(brut.phone), 'téléphone');

    // RÈGLE 1 — une ligne sans la moindre information n'est pas une personne.
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

/**
 * CONVERTIT l'ancien format — et DÉCOUPE là où l'API refuse.
 *
 * Une ancienne valeur « Jean, Marie » voulait dire deux personnes : la scinder
 * restitue l'intention. C'est exactement l'inverse de la règle appliquée aux
 * saisies neuves, et c'est voulu : ici on lit un héritage, là on empêche d'en
 * fabriquer un nouveau.
 *
 * Rien n'est perdu : une valeur qui ressemble à un courriel devient le courriel
 * ET le nom affiché, faute de mieux — c'est tout ce que l'ancienne donnée
 * disait de cette personne.
 *
 * @param {object} doc un document BRUT, tel qu'il est en base
 * @returns {object[]} les participants reconstruits
 */
export function participantsFromLegacy(doc = {}) {
  const morceaux = (valeur) => texte(valeur).split(SEPARATEURS).map((p) => p.trim()).filter(Boolean);
  const construits = [];

  for (const brut of doc.internalParticipants ?? []) {
    if (!brut) continue;
    if (typeof brut === 'string') {
      for (const nom of morceaux(brut)) construits.push({ type: 'INTERNAL', name: nom });
      continue;
    }
    const email = texte(brut.email).toLowerCase();
    const noms = morceaux(brut.name);
    if (noms.length === 0 && email) {
      construits.push({ type: 'INTERNAL', name: email, email });
    } else if (noms.length === 1) {
      construits.push({ type: 'INTERNAL', name: noms[0], ...(email ? { email } : {}) });
    } else {
      // Plusieurs noms sur une ligne : le courriel n'appartient à personne en
      // particulier, on ne l'attribue donc à aucun d'eux plutôt qu'à tous.
      for (const nom of noms) construits.push({ type: 'INTERNAL', name: nom });
    }
  }

  for (const brut of doc.externalParticipants ?? []) {
    if (!brut) continue;
    if (typeof brut === 'object') {
      const email = texte(brut.email).toLowerCase();
      for (const nom of morceaux(brut.name)) {
        construits.push({ type: 'EXTERNAL', name: nom, ...(email ? { email } : {}) });
      }
      if (morceaux(brut.name).length === 0 && email) {
        construits.push({ type: 'EXTERNAL', name: email, email });
      }
      continue;
    }
    for (const valeur of morceaux(brut)) {
      const estCourriel = valeur.includes('@');
      construits.push({
        type: 'EXTERNAL',
        name: valeur,
        ...(estCourriel ? { email: valeur.toLowerCase() } : {}),
      });
    }
  }

  return construits.map((p) => ({ id: newId(), ...p }));
}

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
  participantsFromLegacy,
  mergeParticipants,
  participantKey,
};
