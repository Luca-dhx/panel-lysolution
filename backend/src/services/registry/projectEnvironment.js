/**
 * L'ENVIRONNEMENT D'UN PROJET — QUI LE DIT, ET QUI EST CRU.
 *
 * ══ DEUX DIMENSIONS INDÉPENDANTES ══════════════════════════════════════════
 *
 *   PANEL_ENV    le monde où tourne le PLAN DE CONTRÔLE (`config.env`)
 *   PROJECT_ENV  le monde où tourne le PROJET administré
 *
 * Elles étaient liées par une égalité imposée à l'appairage. Cette égalité
 * empêchait un Panel de recette d'administrer une production — c'est-à-dire
 * qu'elle interdisait au plan de contrôle son métier, pour se protéger d'un
 * accident qui se traite autrement.
 *
 * ══ CE MODULE EST L'AUTRE FAÇON ════════════════════════════════════════════
 *
 * L'environnement d'un projet est ÉPINGLÉ SUR SA FICHE :
 *
 *   · l'opérateur le déclare en créant le projet dans le Panel ;
 *   · à défaut, il est fixé à l'appairage — le seul instant où le projet prouve
 *     son identité, par un code à usage unique émis pour cette fiche ;
 *   · ensuite il ne bouge plus. Aucun battement ne le déplace.
 *
 * ══ POURQUOI L'ÉPINGLE, ET PAS L'OBSERVATION ═══════════════════════════════
 *
 * `runtime.environment` porte ce que le projet a annoncé à son dernier
 * battement. C'est une OBSERVATION : elle vient du projet, sur un chemin que le
 * projet contrôle. Tant que l'appairage exigeait l'égalité avec `config.env`,
 * s'y fier était sans conséquence — un projet ne pouvait de toute façon être
 * appairé que dans le monde du Panel.
 *
 * Cette contrainte levée, la même observation devient un chemin d'ÉLÉVATION :
 * un projet enregistré en recette annoncerait `PROD` à son battement suivant,
 * et repartirait avec les identifiants Stripe, Brevo et OpenSign du monde réel.
 * Il n'aurait eu à forger qu'un champ.
 *
 * D'où la séparation stricte, et le nom des deux fonctions ci-dessous : ce que
 * le Panel A ÉCRIT fait autorité ; ce que le projet DIT est un constat, utile à
 * l'affichage et au diagnostic, et sans pouvoir.
 */

/** `TEST` / `PROD`, ou `null` — jamais une valeur d'ambiance. */
export function normalizeEnvironment(valeur) {
  const brut = String(valeur ?? '').trim().toUpperCase();
  return brut === 'TEST' || brut === 'PROD' ? brut : null;
}

/**
 * L'ENVIRONNEMENT QUI FAIT AUTORITÉ pour cette fiche.
 *
 * C'est celui-ci — et lui seul — qui doit entrer dans la résolution d'une
 * capacité fournisseur. `null` signifie « pas encore connu » : une fiche
 * déclarée que personne n'a encore appairée.
 *
 * Le repli sur l'observation ne sert que les fiches ANTÉRIEURES à l'épinglage,
 * appairées quand la seule garantie était l'égalité avec le monde du Panel.
 * Pour elles, l'observation valait déjà preuve : elles n'auraient pas pu être
 * appairées en annonçant autre chose. Aucune fiche neuve n'emprunte ce chemin.
 */
export function authoritativeEnvironmentOf(record) {
  return normalizeEnvironment(record?.declaredEnvironment)
    ?? normalizeEnvironment(record?.runtime?.environment);
}

/** Ce que le projet a annoncé en dernier. Un constat, sans pouvoir. */
export function observedEnvironmentOf(record) {
  return normalizeEnvironment(record?.runtime?.environment);
}

/**
 * Le projet annonce-t-il un autre monde que celui épinglé sur sa fiche ?
 *
 * Un `true` ici n'est pas une panne du projet : c'est soit une promotion
 * TEST → PROD faite sans déclarer une seconde fiche, soit une tentative
 * d'élévation. Dans les deux cas l'épingle tient, et le Panel a de quoi le
 * dire à l'écran plutôt que de laisser la contradiction muette.
 */
export function environmentContradicted(record) {
  const epingle = normalizeEnvironment(record?.declaredEnvironment);
  const observe = observedEnvironmentOf(record);
  return Boolean(epingle && observe && epingle !== observe);
}

export default {
  normalizeEnvironment,
  authoritativeEnvironmentOf,
  observedEnvironmentOf,
  environmentContradicted,
};
