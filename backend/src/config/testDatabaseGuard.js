/**
 * ISOLATION DES BASES DE TEST — une suite automatisée n'écrit pas dans une base partagée.
 *
 * ══ L'INCIDENT QUI A RENDU CE GARDE NÉCESSAIRE ══════════════════════════════
 *
 * Sept projets de recette ont été retrouvés dans la base Atlas `panel_test`,
 * créés en quelques secondes par trois suites : `garage-ui.test`,
 * `jamais.test`, `projet-a` à `projet-revoque`, et un « Garage Fédéré » pointant
 * un port éphémère depuis longtemps mort. Ils n'étaient rattachés à aucun
 * déploiement — leurs adresses utilisent le TLD `.test`, réservé par la
 * RFC 6761, qui ne peut désigner aucune machine réelle.
 *
 * Ils sont restés visibles dans le registre du Panel comme des projets
 * ordinaires. Un opérateur ne pouvait pas les distinguer d'un vrai client.
 *
 * ══ POURQUOI LE VERROU EXISTANT N'A PAS SUFFI ═══════════════════════════════
 *
 * Le harnais posait `PANEL_SKIP_DOTENV=1`, ce qui empêche bien la lecture du
 * FICHIER `.env`. Mais il conservait ensuite une `MONGODB_URI` déjà présente
 * dans l'environnement — en substance :
 *
 *     MONGODB_URI ← (valeur déjà exportée) ?? 'mongodb://127.0.0.1:27017'
 *     DB_TEST     ← 'panel_test'   ◄── le nom de la base PARTAGÉE, en dur
 *
 * Or une variable exportée par le shell, ou héritée d'un processus parent qui
 * avait chargé le `.env`, survit à cette précaution. Le nom de base, lui, était
 * écrit en dur : `panel_test` — exactement celui de la base partagée. Il
 * suffisait donc que l'URI fuite pour que la suite écrive chez tout le monde.
 *
 * ══ LA RÈGLE, ET POURQUOI ELLE EST GÉOGRAPHIQUE ET NON NOMINATIVE ═══════════
 *
 * On n'interdit pas UNE adresse : on interdit une CLASSE d'adresses. Un
 * processus de test ne peut joindre qu'une base de BOUCLE LOCALE — serveur en
 * mémoire, mongod de poste. Tout le reste, Atlas comme n'importe quel cluster
 * distant, est hors d'atteinte.
 *
 * Interdire nommément le cluster d'aujourd'hui laisserait passer celui de
 * demain. La règle géographique, elle, couvre les clusters qui n'existent pas
 * encore.
 *
 * ══ LA RECETTE LIVE, ET POURQUOI SON OPT-IN EST LAID ════════════════════════
 *
 * Certaines recettes doivent VRAIMENT écrire dans l'environnement partagé :
 * c'est leur objet. Elles restent possibles, mais l'autorisation est une
 * phrase qu'on ne tape pas par distraction et qu'on ne laisse pas traîner dans
 * un script sans s'en apercevoir.
 *
 * Et quel que soit l'opt-in, PROD reste hors de portée d'une recette
 * automatisée. Il n'existe aucune combinaison de variables qui l'autorise.
 */

/** L'autorisation d'écrire dans une base partagée. Volontairement encombrante. */
export const LIVE_RECIPE_VARIABLE = 'PANEL_LIVE_RECIPE';
export const LIVE_RECIPE_TOKEN = 'ECRITURE-ASSUMEE-SUR-BASE-PARTAGEE';

/** Marque héritée par les processus enfants d'une suite (serveurs de recette). */
export const TEST_PROCESS_VARIABLE = 'PANEL_TEST_PROCESS';

export const GUARD_CODES = Object.freeze({
  SHARED_DATABASE_FORBIDDEN_IN_TESTS: 'SHARED_DATABASE_FORBIDDEN_IN_TESTS',
  LIVE_RECIPE_FORBIDDEN_IN_PROD: 'LIVE_RECIPE_FORBIDDEN_IN_PROD',
});

/**
 * Ce processus est-il une suite automatisée ?
 *
 * Trois signaux, dont aucun n'est indispensable seul :
 *   · le script d'entrée est un fichier de test ou de contrôle ;
 *   · il vit dans un répertoire `tests/` ;
 *   · un parent l'a marqué (les serveurs qu'une recette démarre en enfant
 *     doivent hériter de l'interdit, sinon on la contourne d'un `spawn`).
 *
 * `src/scripts/` n'est PAS un critère : on y trouve aussi bien des suites que
 * des migrations et des amorçages, qui ont légitimement besoin de la vraie
 * base. C'est le SUFFIXE du fichier qui tranche, pas son dossier.
 *
 * ══ POURQUOI CETTE FONCTION NE LIT RIEN ELLE-MÊME ═══════════════════════════
 *
 * Le Panel n'a qu'UNE porte vers l'environnement : `config/env.js`. Un module
 * qui lirait `process.env` de son côté rouvrirait une seconde porte, et la
 * configuration cesserait d'être vérifiable en un seul endroit. Les trois
 * signaux sont donc PASSÉS, pas lus — ce qui rend aussi la fonction éprouvable
 * sans manipuler l'environnement du processus de test.
 *
 * @param {{ entryPath?: string, testProcessFlag?: string, nodeEnv?: string }} signaux
 */
export function isAutomatedTestProcess({ entryPath = '', testProcessFlag = '', nodeEnv = '' } = {}) {
  if (testProcessFlag === '1') return true;
  if (nodeEnv === 'test') return true;
  const entree = String(entryPath ?? '').replace(/\\/g, '/');
  if (!entree) return false;
  if (/\.(test|check|spec)\.(js|mjs|cjs)$/i.test(entree)) return true;
  if (/(^|\/)tests?\//i.test(entree)) return true;
  return false;
}

/**
 * L'hôte est-il une base de boucle locale — donc isolée de tout le monde ?
 *
 * Un serveur en mémoire écoute sur un port éphémère de `127.0.0.1` : il est
 * couvert par cette règle sans qu'on ait à le reconnaître spécifiquement.
 */
export function isLoopbackHost(hote) {
  const h = String(hote ?? '').trim().toLowerCase();
  if (!h) return false;
  /**
   * LE PORT SE RETIRE UNE FOIS, PAS DEUX. Une IPv6 est pleine de deux-points :
   * débracketer `[::1]:27017` puis retirer « le port » de `::1` laisserait
   * `:` — et la boucle locale IPv6 passerait pour une adresse distante.
   */
  const bracketee = h.match(/^\[([^\]]+)\](?::\d+)?$/);
  const sansPort = bracketee
    ? bracketee[1]
    : (h.split(':').length > 2 ? h : h.replace(/:\d+$/, ''));
  return sansPort === 'localhost'
    || sansPort === '127.0.0.1'
    || sansPort === '::1'
    || sansPort === '0:0:0:0:0:0:0:1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(sansPort);
}

/**
 * La recette live est-elle explicitement demandée ?
 *
 * On compare la VALEUR, transmise par l'appelant — voir plus haut : ce module
 * ne lit pas l'environnement. La comparaison est stricte, casse comprise : une
 * valeur approchante (`1`, `true`, `oui`, le jeton en minuscules) ne vaut pas
 * autorisation, sans quoi l'opt-in redeviendrait quelque chose qu'on active
 * par distraction.
 */
export function liveRecipeRequested(valeur) {
  return valeur === LIVE_RECIPE_TOKEN;
}

/**
 * LE VERROU. Lève si ce processus n'a pas le droit de joindre cette base.
 *
 * Tout lui est passé : la cible ET la nature du processus. C'est
 * `config/env.js`, porte unique de l'environnement, qui établit les seconds.
 *
 * @param {{ mongoHost: string, dbName: string, env: string, isProd: boolean,
 *           isTestProcess: boolean, liveRecipe: boolean }} cible
 */
export function assertDatabaseAllowedForThisProcess(cible) {
  const {
    mongoHost, dbName, env: environnement, isProd,
    isTestProcess: estTest, liveRecipe: recetteLive,
  } = cible ?? {};

  /**
   * PROD D'ABORD, ET SANS CONDITION. Une recette qui se déclare live n'obtient
   * jamais la production — pas même en environnement de test mal étiqueté.
   * Ce contrôle précède tous les autres : aucune branche ne peut le contourner.
   */
  if (recetteLive && (isProd || String(environnement).toUpperCase() === 'PROD')) {
    const erreur = new Error(
      'Recette live REFUSÉE : la production n’est jamais une cible de recette automatisée. '
      + `(base « ${dbName} » sur ${mongoHost}, ENV=${environnement})`,
    );
    erreur.code = GUARD_CODES.LIVE_RECIPE_FORBIDDEN_IN_PROD;
    throw erreur;
  }

  /** Le runtime réel n'est pas concerné : il EST censé joindre sa base. */
  if (!estTest) return { allowed: true, reason: 'RUNTIME' };

  if (isLoopbackHost(mongoHost)) return { allowed: true, reason: 'BASE_ISOLEE' };

  if (recetteLive) return { allowed: true, reason: 'RECETTE_LIVE_EXPLICITE' };

  const erreur = new Error(
    `Base PARTAGÉE interdite aux suites automatisées : ${mongoHost} (base « ${dbName} »).\n`
    + '  · une suite doit utiliser un serveur en mémoire ou un mongod local ;\n'
    + `  · une recette qui doit VRAIMENT écrire ici pose ${LIVE_RECIPE_VARIABLE}=${LIVE_RECIPE_TOKEN} ;\n`
    + '  · la production n’est jamais une cible, quelle que soit la variable.',
  );
  erreur.code = GUARD_CODES.SHARED_DATABASE_FORBIDDEN_IN_TESTS;
  throw erreur;
}
