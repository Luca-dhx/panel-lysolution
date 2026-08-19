/**
 * LES SECRETS QU'AUCUN PROJET NE DOIT PLUS PORTER — liste NOIRE (LOT 2C).
 *
 * ══ CE FICHIER CONTIENT DES MOTS DE PASSE, ET C'EST SA RAISON D'ÊTRE ════════
 *
 * `123dev` et `123admin` ont été, pendant toute la vie du parc, les
 * identifiants d'administration de CHAQUE projet dupliqué. Ils sont donc
 * connus — de tout lecteur d'un ancien README, de toute copie de dépôt, de
 * toute capture d'écran de démonstration.
 *
 * Ce module ne les UTILISE jamais : il les REFUSE. La distinction est
 * vérifiable et vérifiée — le scan de sécurité du lot classe ce fichier en
 * DENYLIST, et un test interdit qu'une de ces valeurs serve ailleurs à écrire
 * un mot de passe.
 *
 * ══ POURQUOI UNE LISTE, ET NON UNE RÈGLE DE COMPLEXITÉ ══════════════════════
 *
 * Une règle de complexité ne verrait rien à redire à `123admin` mieux
 * maquillé. Ce qui rend ces valeurs dangereuses n'est pas leur forme, c'est
 * leur DIFFUSION. On ne peut donc que les nommer.
 *
 * La comparaison est insensible à la casse et aux espaces de bordure : «
 * 123Admin » n'est pas un autre secret, c'est le même mal recopié.
 */
export const UNIVERSAL_SECRETS = Object.freeze([
  '123dev',
  '123admin',
  'admin',
  'password',
  'motdepasse',
  'changeme',
  'azerty',
  'qwerty',
]);

const normalise = (valeur) => String(valeur ?? '').trim().toLowerCase();

/** Ce mot de passe est-il l'un des secrets diffusés du parc ? */
export function isUniversalSecret(candidat) {
  return UNIVERSAL_SECRETS.includes(normalise(candidat));
}

/**
 * Le mot de passe se déduit-il de l'adresse ? `camille@garage.fr` /
 * « camille » est deviné au premier essai par quiconque connaît le compte —
 * et l'adresse d'un administrateur n'est pas un secret.
 */
export function isDerivedFromEmail(candidat, email) {
  const mdp = normalise(candidat);
  const partieLocale = normalise(email).split('@')[0];
  if (!mdp || !partieLocale) return false;
  return mdp === partieLocale || mdp === normalise(email);
}

export default { UNIVERSAL_SECRETS, isUniversalSecret, isDerivedFromEmail };
