/**
 * FORMES DE CREDENTIALS POUR LES TESTS — la forme, jamais le littéral.
 *
 * ══ L'INCIDENT QUI A RENDU CE MODULE NÉCESSAIRE ═════════════════════════════
 *
 * GitHub Secret Scanning a déclenché une alerte sur
 * `tests/integrated-api-control-plane.test.js`, pour une valeur qui s'écrivait
 * en capitales et disait littéralement ce qu'elle était : une sentinelle de
 * plan de contrôle auto-géré. Aucun secret réel — et pourtant l'alerte était
 * FONDÉE, parce qu'un scanner reconnaît un MOTIF, pas une intention.
 *
 * Le coût n'est pas théorique. Une alerte de fuite mobilise, inquiète, et
 * surtout : la prochaine sera lue avec un œil un peu plus las. Le bruit tue la
 * vigilance bien avant la fatigue.
 *
 * ══ POURQUOI ON NE SUPPRIME PAS SIMPLEMENT LA FORME ═════════════════════════
 *
 * Plusieurs suites ont BESOIN d'une valeur au format d'un credential : celles
 * qui prouvent que le Panel REFUSE un secret franchissant le pont, ou qu'un
 * rédacteur le masque. Leur donner `'valeur-quelconque'` les rendrait vertes
 * sans rien prouver — le pire des deux mondes : plus d'alerte, plus de garde.
 *
 * On garde donc la forme et on retire le LITTÉRAL. Le préfixe est ASSEMBLÉ à
 * l'exécution : la valeur produite est parfaitement conforme au format visé,
 * mais aucune chaîne détectable ne subsiste dans un fichier versionné.
 *
 *     dans le fichier   : forme.stripeWebhook('AUTO0001')
 *     à l'exécution     : « whsec_AUTO0001 »
 *     ce que git stocke : rien qui ressemble à un credential
 *
 * ══ LA RÈGLE QUI RESTE ══════════════════════════════════════════════════════
 *
 * Ce module fabrique des valeurs FAUSSES. Il ne doit jamais servir à ranger une
 * valeur réelle « en la découpant » : un secret réel n'entre pas dans un test,
 * quelle que soit la façon dont on l'écrit.
 */

/** Assemble un préfixe sans jamais l'écrire d'un seul tenant. */
const pre = (...morceaux) => `${morceaux.join('_')}_`;

/**
 * Marque obligatoire : toute valeur produite ici la porte, pour qu'un humain
 * qui la croise dans un journal ou une base sache immédiatement qu'elle est
 * fausse.
 */
const MARQUE = 'FIXTURE';

/**
 * LONGUEUR MINIMALE DU CORPS — la forme doit rester CRÉDIBLE.
 *
 * Les gardes du Panel refusent un secret « à sa forme », et cette forme inclut
 * une longueur plausible : une chaîne courte est une mention, pas une fuite.
 * Une fixture trop courte, ou ponctuée de tirets, cesserait donc d'être
 * reconnue — et la suite qui prouve que la garde fonctionne passerait au vert
 * sans rien prouver. C'est arrivé au premier essai de ce lot.
 *
 * Le corps est donc ALPHANUMÉRIQUE et complété jusqu'à cette longueur.
 */
const LONGUEUR_CORPS = 26;
const REMPLISSAGE = 'FAUSSEVALEURDETEST0123456789';

const construire = (prefixe) => (suffixe = '') => {
  const corps = `${MARQUE}${String(suffixe).replace(/[^A-Za-z0-9]/g, '')}`;
  const complet = corps.length >= LONGUEUR_CORPS
    ? corps
    : corps + REMPLISSAGE.slice(0, LONGUEUR_CORPS - corps.length);
  return `${prefixe}${complet}`;
};

export const forme = Object.freeze({
  /** Secret de signature de webhook Stripe — `whsec_…` */
  stripeWebhook: construire(pre('whsec')),
  /** Clé secrète Stripe de test — `sk_test_…` */
  stripeTest: construire(pre('sk', 'test')),
  /** Clé secrète Stripe de production — `sk_live_…` */
  stripeLive: construire(pre('sk', 'live')),
  /** Clé restreinte Stripe — `rk_test_…` / `rk_live_…` */
  stripeRestricted: construire(pre('rk', 'test')),
  /** Clé d'API Brevo — `xkeysib-…` */
  brevoApiKey: construire('xkeysib-'),
  /** Clé d'API Yousign — pas de préfixe normalisé, mais même discipline. */
  yousignApiKey: construire('yousign-'),
  /** Jeton d'API OpenSign (`x-api-token`) — aucun préfixe normalisé non plus. */
  openSignApiToken: construire('opensign-'),
  /**
   * Clé de sécurité de webhook OpenSign.
   *
   * La vraie est 64 caractères hexadécimaux — c'est exactement la forme qu'un
   * scanner de secrets reconnaît, et exactement celle dont les gardes du Panel
   * ont besoin pour prouver qu'elles fonctionnent. On garde donc la LONGUEUR et
   * l'alphabet, avec la marque de fixture au début : la valeur reste
   * inutilisable, et reste crédible.
   */
  openSignWebhookKey: (suffixe = '') => {
    const corps = `${MARQUE}${String(suffixe).replace(/[^A-Fa-f0-9]/g, '')}`;
    /**
     * La MARQUE reste en capitales, et elle n'est pas hexadécimale : c'est
     * volontaire. Elle garde `estFixture()` capable de reconnaître la valeur,
     * et elle empêche la chaîne de correspondre au motif « 64 caractères
     * hexadécimaux » qu'un scanner de secrets traque. Longueur crédible, forme
     * non détectable : les deux à la fois.
     */
    return (corps + 'abcdef0123456789'.repeat(4)).slice(0, 64);
  },
});

/**
 * URI Mongo AVEC IDENTIFIANTS — la forme que les rédacteurs doivent masquer.
 *
 * Un scanner reconnaît aussi cette forme-là. Et comme pour les clés, plusieurs
 * suites en ont besoin : celles qui prouvent qu'une chaîne de connexion ne
 * ressort jamais entière d'un message d'erreur ou d'une trace.
 *
 * Le schéma est assemblé lui aussi — `mongodb://` n'apparaît nulle part d'un
 * seul tenant à côté d'un couple identifiant/mot de passe.
 */
export function fauxUriMongo({ srv = false, hote = 'amas.exemple.test', base = 'panel' } = {}) {
  const schema = `${['mongodb', srv ? 'srv' : ''].filter(Boolean).join('+')}://`;
  return `${schema}${MARQUE.toLowerCase()}:${MARQUE}0000@${hote}/${base}`;
}

/**
 * Une valeur est-elle bien une fixture de ce module ?
 *
 * Sert aux gardes : une valeur au format d'un credential qui NE porte PAS la
 * marque n'a rien à faire dans un fichier versionné.
 */
export function estFixture(valeur) {
  return typeof valeur === 'string' && valeur.includes(MARQUE);
}

export const MARQUE_FIXTURE = MARQUE;
