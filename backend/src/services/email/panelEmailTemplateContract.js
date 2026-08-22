// LE CONTRAT DE VARIABLES D'UN MODÈLE, ET SON EMPREINTE.
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Templates » / §« Compatibilité ».
//
// ── LE PROBLÈME QUE CE FICHIER RÈGLE ────────────────────────────────────────
//
// Le Panel est la seule autorité du vocabulaire d'un modèle : quelles variables
// existent, lesquelles sont obligatoires, de quel type. Le projet, lui, est
// autorité de la FAÇON de produire les valeurs. Deux autorités distinctes sur
// un même contrat : il faut donc un moyen de savoir si elles parlent encore de
// la même chose.
//
// Sans ce moyen, la panne est silencieuse et différée : quelqu'un ajoute une
// variable obligatoire au registre, personne ne s'en aperçoit, et le prochain
// e-mail d'un projet déployé il y a trois mois échoue en
// MISSING_REQUIRED_VARIABLE — au pire moment, sur un impayé ou une
// réinitialisation de mot de passe.
//
// ── POURQUOI UNE EMPREINTE, ET PAS UNE NÉGOCIATION ──────────────────────────
//
// Une négociation de protocole (le projet annonce ce qu'il sait faire, le Panel
// répond ce qu'il exige, on converge) suppose que les deux côtés puissent
// s'accorder à l'exécution. Ils ne le peuvent pas : le projet ne peut pas
// inventer une variable qu'il ne sait pas résoudre, et le Panel ne peut pas
// renoncer à une variable que son contenu utilise. Il n'y a donc RIEN à
// négocier — seulement un désaccord à CONSTATER, le plus tôt possible.
//
// Une empreinte suffit exactement à cela. Le projet déclare celle qu'il a
// consommée ; le Panel compare à la sienne ; toute différence est un écart, et
// l'écart est visible avant qu'un e-mail ne soit demandé.
//
// ── CE QUI ENTRE DANS L'EMPREINTE, ET CE QUI N'Y ENTRE PAS ──────────────────
//
// DEDANS   : la clé, le type, le caractère obligatoire. Ce sont les trois
//            seules choses qu'un producteur de valeurs doit connaître pour
//            réussir un rendu. Changer l'une des trois PEUT casser un projet.
//
// DEHORS   : le libellé, la description, l'ordre de déclaration, le contenu
//            HTML, le sujet. Les réécrire n'a jamais empêché un rendu — les
//            inclure ferait clignoter l'alerte à chaque correction de faute
//            d'orthographe, et une alerte qui clignote sans raison finit par
//            n'être plus lue.
//
// L'ordre est normalisé (tri sur la clé) pour que réordonner une déclaration
// ne produise pas un faux écart.

import crypto from 'node:crypto';

import { EMAIL_TEMPLATE_IDS, isKnownTemplateId, variablesFor } from './panelEmailTemplateRegistry.js';

/** Longueur retenue de l'empreinte : 32 hex = 128 bits, très au-delà du besoin. */
const FINGERPRINT_LENGTH = 32;

/**
 * La forme canonique du contrat — le texte exact dont on prend l'empreinte.
 *
 * Exposée (et pas seulement l'empreinte) parce qu'un écart doit pouvoir être
 * EXPLIQUÉ : « l'empreinte diffère » n'aide personne, « `invoice.url` est
 * devenue obligatoire » se corrige.
 */
export function canonicalVariableContract(templateCode) {
  if (!isKnownTemplateId(templateCode)) return [];
  return variablesFor(templateCode)
    .map((variable) => ({
      key: String(variable.key),
      type: String(variable.type),
      required: variable.required === true,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function variableContractFingerprint(templateCode) {
  const canonical = canonicalVariableContract(templateCode);
  if (!canonical.length) return '';
  const payload = canonical.map((v) => `${v.key}:${v.type}:${v.required ? 'R' : 'O'}`).join('\n');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/** Toutes les empreintes du registre, `{ [code]: fingerprint }`. */
export function allVariableContractFingerprints() {
  const out = {};
  for (const code of EMAIL_TEMPLATE_IDS) out[code] = variableContractFingerprint(code);
  return out;
}

/**
 * L'écart entre ce qu'un projet a consommé et ce que le registre exige AUJOURD'HUI.
 *
 * `declared` vient du projet (ce qu'il a lu la dernière fois qu'il a synchronisé
 * son contrat) ; le courant vient du code. Un `declared` absent n'est pas un
 * écart : c'est un projet qui n'a pas encore annoncé de contrat — le cas d'un
 * parc en cours de migration. On le dit (`UNDECLARED`) sans crier à la panne.
 */
export const CONTRACT_COMPATIBILITY = Object.freeze({
  MATCH: 'MATCH',
  STALE: 'STALE',
  UNDECLARED: 'UNDECLARED',
  UNKNOWN_TEMPLATE: 'UNKNOWN_TEMPLATE',
});

export function compareContractFingerprint(templateCode, declaredFingerprint) {
  if (!isKnownTemplateId(templateCode)) {
    return { templateCode, status: CONTRACT_COMPATIBILITY.UNKNOWN_TEMPLATE, current: '', declared: declaredFingerprint ?? '' };
  }
  const current = variableContractFingerprint(templateCode);
  const declared = String(declaredFingerprint ?? '').trim();
  if (!declared) {
    return { templateCode, status: CONTRACT_COMPATIBILITY.UNDECLARED, current, declared: '' };
  }
  return {
    templateCode,
    status: declared === current ? CONTRACT_COMPATIBILITY.MATCH : CONTRACT_COMPATIBILITY.STALE,
    current,
    declared,
  };
}

/**
 * Le verdict de compatibilité d'un projet entier.
 *
 * `stale` est la seule liste qui doit réveiller quelqu'un : le projet produit
 * ses valeurs d'après un contrat qui n'est plus celui du registre. Les envois
 * ne sont PAS bloqués pour autant — c'est le rendu qui tranche, et lui seul
 * sait si les valeurs réellement fournies suffisent. Bloquer sur l'empreinte
 * interdirait des envois parfaitement rendables au motif qu'un libellé a bougé.
 */
export function describeContractCompatibility(declaredFingerprints = {}, templateCodes = []) {
  const rows = templateCodes.map((code) => compareContractFingerprint(code, declaredFingerprints?.[code]));
  return {
    checkedAt: null,
    rows,
    match: rows.filter((r) => r.status === CONTRACT_COMPATIBILITY.MATCH).map((r) => r.templateCode),
    stale: rows.filter((r) => r.status === CONTRACT_COMPATIBILITY.STALE).map((r) => r.templateCode),
    undeclared: rows.filter((r) => r.status === CONTRACT_COMPATIBILITY.UNDECLARED).map((r) => r.templateCode),
    compatible: rows.every((r) => r.status !== CONTRACT_COMPATIBILITY.STALE),
  };
}

export default {
  CONTRACT_COMPATIBILITY,
  allVariableContractFingerprints,
  canonicalVariableContract,
  compareContractFingerprint,
  describeContractCompatibility,
  variableContractFingerprint,
};
