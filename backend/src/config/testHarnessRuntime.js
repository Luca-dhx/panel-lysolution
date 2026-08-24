/**
 * LE RUNTIME DE HARNAIS — et pourquoi ce n'est PAS un assouplissement.
 *
 * ══ LE CONFLIT ═════════════════════════════════════════════════════════════
 *
 * Une destination de projet doit être JOIGNABLE DEPUIS L'EXTÉRIEUR. Un Panel
 * qui accepterait `http://127.0.0.1:4000` comme adresse publique enregistrerait
 * une adresse qui ne désigne rien hors de la machine où elle a été saisie :
 * plus de battement utile, plus de déploiement, plus de supervision. La garde
 * est un vrai invariant produit, et elle reste entière.
 *
 * Mais les recettes de bout en bout du Panel démarrent de VRAIS projets, sur
 * des ports éphémères de la boucle locale — c'est précisément ce qui fait
 * qu'elles éprouvent le produit et non une maquette. La garde les a donc
 * cassées en bloc : onze suites rouges, et un lot certifié malgré elles.
 *
 * ══ LES DEUX RÉPONSES QU'ON NE VOULAIT PAS ═════════════════════════════════
 *
 * Rendre `127.0.0.1` acceptable en production : c'est retirer la garde.
 * Sauter les recettes : c'est cesser d'éprouver le chemin le plus fragile.
 *
 * ══ CE QU'ON DISTINGUE À LA PLACE ══════════════════════════════════════════
 *
 *   DESTINATION PUBLIQUE D'UN PROJET   toujours joignable de l'extérieur
 *   POINT DE TERMINAISON DE HARNAIS    boucle locale admise, et seulement là
 *
 * La différence n'est pas dans l'adresse : elle est dans le RUNTIME qui la
 * reçoit. Un Panel lancé par une suite de test n'est pas le même programme
 * qu'un Panel de production, et il n'a pas à faire semblant.
 *
 * ══ POURQUOI CETTE MARQUE EST INFORGEABLE ══════════════════════════════════
 *
 * Elle ne vient QUE de l'environnement du PROCESSUS. Aucun corps de requête,
 * aucun en-tête, aucun paramètre d'écran ne peut la poser : il faudrait déjà
 * pouvoir choisir l'environnement du processus, c'est-à-dire être celui qui le
 * démarre. Les fonctions ci-dessous ne prennent d'ailleurs aucun argument par
 * lequel un appelant pourrait les faire mentir — il n'y a pas d'entrée à valider.
 *
 * C'est la même marque que celle qui interdit à une suite d'écrire dans une
 * base partagée (`testDatabaseGuard.js`), lue au même endroit que tout le reste
 * de la configuration (`config/env.js`) — un seul marqueur, un seul lecteur,
 * deux invariants qui s'en servent. Les enfants qu'une suite lance en héritent,
 * ce qui est exactement ce qu'il faut : le projet démarré par la recette doit
 * être reconnu comme faisant partie du harnais.
 *
 * ══ ET LA PRODUCTION RESTE HORS D'ATTEINTE ═════════════════════════════════
 *
 * Même marqué, un Panel en `ENV=PROD` refuse. Il n'existe aucune combinaison de
 * variables qui autorise une adresse de boucle locale sur une instance de
 * production — pas plus ici que pour les bases.
 */
import { testHarnessRuntimeRequested } from './env.js';

/** Hôtes de boucle locale — la SEULE classe d'adresses que le harnais ajoute. */
const BOUCLE_LOCALE = [
  /^127\./,
  /^localhost$/i,
  /^::1$/,
  /^\[::1\]$/,
];

/**
 * Ce processus est-il un runtime de harnais de test ?
 *
 * La LECTURE elle-même vit dans `config/env.js`, seul lecteur autorisé de
 * l'environnement du processus — un second lecteur rouvrirait la porte que
 * cette centralisation ferme. Ce module porte la RÈGLE ; celui-là porte l'accès.
 */
export function isTestHarnessRuntime() {
  return testHarnessRuntimeRequested();
}

/** L'hôte de cette URL est-il sur la boucle locale ? */
export function isLoopbackUrl(value) {
  let hote;
  try { hote = new URL(String(value)).hostname; } catch { return false; }
  return BOUCLE_LOCALE.some((re) => re.test(hote));
}

/**
 * Cette adresse est-elle admissible comme point de terminaison de harnais ?
 *
 * `false` partout ailleurs qu'en test — c'est la conjonction qui compte, et
 * elle est écrite ici pour n'exister qu'à un seul endroit.
 */
export function isTestHarnessEndpoint(value) {
  return isTestHarnessRuntime() && isLoopbackUrl(value);
}

export default { isTestHarnessRuntime, isLoopbackUrl, isTestHarnessEndpoint };
