/**
 * RÉSILIENCE DE SESSION — QUI a le droit de déconnecter, et qui ne l'a pas.
 *
 * ══ LE DÉFAUT QUE CETTE SUITE FERME ═════════════════════════════════════════
 *
 * Le client HTTP du Panel effaçait le jeton sur TOUTE réponse 401, sans vérifier
 * que ce 401 parlait bien de la session courante. Et `AuthContext` vidait
 * l'identité sur N'IMPORTE QUEL échec de `/api/auth/me` — un 500, un 503, un
 * 502 d'nginx pendant un redémarrage, un `fetch` qui rejette.
 *
 * Conséquence observée : on lançait un déploiement, il échouait, on rechargeait
 * la page pendant que le backend redémarrait, et l'écran de connexion
 * apparaissait. Le jeton n'avait pourtant jamais été effacé — d'où le fait qu'un
 * second rechargement, quelques secondes plus tard, ramenait dans l'application
 * sans ressaisir quoi que ce soit.
 *
 * ══ L'INVARIANT ÉPROUVÉ ICI ═════════════════════════════════════════════════
 *
 *   Une session locale n'est effacée QUE s'il existe une preuve explicite que
 *   l'authentification est invalide.
 *
 * Une panne n'est pas une preuve : elle n'a aucune opinion sur une identité,
 * elle n'a simplement pas pu la vérifier. La suite éprouve chaque famille
 * d'échec séparément, parce que c'est leur CONFUSION qui était le bogue.
 */
import { register } from 'node:module';
import { check, finish, section } from './helpers/harness.js';

/**
 * L'ALIAS `@/` EST RÉSOLU ICI, PAS PAR UN DRAPEAU DE LIGNE DE COMMANDE.
 *
 * Le lanceur de la suite exécute chaque fichier par un `node <fichier>` nu :
 * une suite qui dépendrait d'un `--import` passé à la main s'exécuterait
 * parfaitement seule et pas du tout dans la suite complète — c'est-à-dire
 * qu'elle serait verte là où personne ne regarde et absente là où l'on compte
 * sur elle. L'enregistrement vit donc dans le fichier, comme pour les autres
 * suites qui lisent le frontend.
 */
register('./helpers/frontendLoader.mjs', import.meta.url);

/* ── Le navigateur, réduit à ce que le client HTTP en utilise ─────────────── */

const CLEF = 'panel_token';
let magasin = new Map();
let redirections = [];

globalThis.localStorage = {
  getItem: (k) => (magasin.has(k) ? magasin.get(k) : null),
  setItem: (k, v) => { magasin.set(k, String(v)); },
  removeItem: (k) => { magasin.delete(k); },
};
globalThis.window = {
  location: {
    pathname: '/deployment',
    assign: (url) => { redirections.push(url); },
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};

/**
 * Le serveur, réduit à un scénario par appel.
 *
 * `reponses` associe un chemin à ce qu'il doit rendre. Tout ce qui n'y figure
 * pas rejette — ce qui simule une panne réseau, et rend visible tout appel
 * qu'on n'avait pas prévu.
 */
let reponses = new Map();
let appels = [];

function reponse(status, corps) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corps,
  };
}

globalThis.fetch = async (url, options = {}) => {
  const chemin = String(url).split('?')[0];
  appels.push({ chemin, method: options.method ?? 'GET' });
  const scenario = reponses.get(chemin);
  if (!scenario) throw new TypeError('Failed to fetch');
  return typeof scenario === 'function' ? scenario() : scenario;
};

function reinitialiser({ token = 'jeton-valide' } = {}) {
  magasin = new Map();
  if (token) magasin.set(CLEF, token);
  redirections = [];
  appels = [];
  reponses = new Map();
}

const { request, tokenStore, provesSessionInvalid, ApiError } = await import('@/lib/api');

/** Le jeton est-il TOUJOURS là ? C'est la seule question qui compte. */
const sessionIntacte = () => tokenStore.get() === 'jeton-valide';

async function echec(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LES PANNES — aucune ne peut déconnecter
   ═══════════════════════════════════════════════════════════════════════════ */

section('HTTP 500 — le serveur a répondu, et sa réponse est un bogue');
{
  reinitialiser();
  reponses.set('/api/deployment', reponse(500, {
    success: false, code: 'PANEL_INTERNAL', message: 'Erreur interne.',
  }));

  const err = await echec(() => request('/api/deployment', { retries: 0 }));
  check('un 500 lève une ApiError', err instanceof ApiError);
  check('un 500 est classé SERVER_ERROR', err?.kind === 'SERVER_ERROR');
  check('un 500 NE DÉCONNECTE PAS', sessionIntacte());
  check('un 500 ne prouve rien sur la session', provesSessionInvalid(err) === false);
  check('un 500 ne redirige pas vers /login', redirections.length === 0);
  check('un 500 n’est pas réessayable à l’identique', err?.retryable === false);
}

section('HTTP 503 — le service démarre, s’arrête, ou sa base manque');
{
  reinitialiser();
  reponses.set('/api/deployment', reponse(503, {
    success: false,
    code: 'PANEL_SERVICE_STARTING',
    message: 'Le service démarre.',
    details: { retryable: true, sessionValid: true },
  }));

  const err = await echec(() => request('/api/deployment', { retries: 0 }));
  check('un 503 est classé SERVICE_UNAVAILABLE', err?.kind === 'SERVICE_UNAVAILABLE');
  check('un 503 NE DÉCONNECTE PAS', sessionIntacte());
  check('un 503 ne redirige pas vers /login', redirections.length === 0);
  check('un 503 est réessayable', err?.retryable === true);
  check('un 503 ne prouve rien sur la session', provesSessionInvalid(err) === false);
}

section('HTTP 502 — nginx sans amont, corps HTML illisible');
{
  reinitialiser();
  // Le corps n'est PAS du JSON : c'est la signature exacte d'une page d'erreur
  // de proxy. C'est ce cas-là qui arrivait « sans code ni message ».
  reponses.set('/api/auth/me', {
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token <'); },
  });

  const err = await echec(() => request('/api/auth/me', { retries: 0 }));
  check('un 502 sans corps JSON est classé SERVICE_UNAVAILABLE',
    err?.kind === 'SERVICE_UNAVAILABLE');
  check('un 502 NE DÉCONNECTE PAS', sessionIntacte());
  check('un 502 ne redirige pas vers /login', redirections.length === 0);
  /**
   * Le message de repli compte autant que le classement : c'est lui que
   * l'opérateur lit. Il doit parler d'INDISPONIBILITÉ et rassurer sur la
   * session — jamais suggérer une reconnexion, qui est la mauvaise action.
   */
  check('un 502 sans corps annonce une indisponibilité',
    /indisponible/i.test(err?.message ?? ''));
  check('… et affirme que la session reste valide',
    /session reste valide/i.test(err?.message ?? ''));
}

section('Panne réseau — aucune réponse n’est jamais arrivée');
{
  reinitialiser();
  // Aucun scénario enregistré : le `fetch` truqué rejette, comme un vrai.
  const err = await echec(() => request('/api/deployment', { retries: 0 }));
  check('un rejet de fetch est classé NETWORK_ERROR', err?.kind === 'NETWORK_ERROR');
  check('un rejet de fetch NE DÉCONNECTE PAS', sessionIntacte());
  check('un rejet de fetch ne redirige pas vers /login', redirections.length === 0);
  check('un rejet de fetch est réessayable', err?.retryable === true);
}

section('Redémarrage backend — la séquence complète, sans déconnexion');
{
  reinitialiser();
  /**
   * LA SÉQUENCE EXACTE DU SYMPTÔME RAPPORTÉ.
   *
   * Le déploiement échoue (le backend redémarre), puis `/api/auth/me` est
   * injoignable, puis indisponible, puis revient. À aucun moment le jeton ne
   * doit disparaître — sans quoi l'utilisateur se retrouve au login.
   */
  reponses.set('/api/deployment/targets/t1/deploy', reponse(502, {}));
  const e1 = await echec(() => request('/api/deployment/targets/t1/deploy', {
    method: 'POST', body: { sshPassword: 'x' },
  }));
  check('l’échec du déploiement pendant un redémarrage ne déconnecte pas', sessionIntacte());
  check('… et il est classé indisponibilité', e1?.kind === 'SERVICE_UNAVAILABLE');

  reponses = new Map(); // plus rien ne répond : le backend redémarre
  const e2 = await echec(() => request('/api/auth/me', { retries: 0 }));
  check('/me injoignable pendant le redémarrage ne déconnecte pas', sessionIntacte());
  check('… et il est classé panne réseau', e2?.kind === 'NETWORK_ERROR');

  reponses.set('/api/auth/me', reponse(503, {
    success: false, code: 'PANEL_SERVICE_STARTING', message: 'Le service démarre.',
  }));
  const e3 = await echec(() => request('/api/auth/me', { retries: 0 }));
  check('/me pendant l’amorçage ne déconnecte pas', sessionIntacte());
  check('… et il est classé indisponibilité', e3?.kind === 'SERVICE_UNAVAILABLE');

  reponses.set('/api/auth/me', reponse(200, {
    success: true, data: { user: { email: 'dev@panel.test' } },
  }));
  const retour = await request('/api/auth/me');
  check('le service revenu, /me réussit SANS reconnexion',
    retour?.user?.email === 'dev@panel.test');
  check('… avec le MÊME jeton qu’au départ', sessionIntacte());
  check('… et sans qu’aucune redirection n’ait eu lieu', redirections.length === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   LE SEUL CAS QUI DÉCONNECTE — et sa confirmation obligatoire
   ═══════════════════════════════════════════════════════════════════════════ */

section('401 confirmé par l’autorité — LÀ, et seulement là, on déconnecte');
{
  reinitialiser();
  reponses.set('/api/deployment', reponse(401, {
    success: false, code: 'PANEL_UNAUTHORIZED', message: 'Authentification requise.',
  }));
  reponses.set('/api/auth/me', reponse(401, {
    success: false, code: 'PANEL_UNAUTHORIZED', message: 'Authentification requise.',
  }));

  const err = await echec(() => request('/api/deployment', { retries: 0 }));
  check('un 401 confirmé est classé AUTH_INVALID', err?.kind === 'AUTH_INVALID');
  check('un 401 confirmé EFFACE le jeton', tokenStore.get() === null);
  check('un 401 confirmé prouve l’invalidité', provesSessionInvalid(err) === true);
  check('un 401 confirmé redirige vers /login', redirections.includes('/login'));
  check('l’autorité /api/auth/me a bien été consultée',
    appels.some((a) => a.chemin === '/api/auth/me'));
}

section('401 NON confirmé — la session est saine, on ne touche à rien');
{
  reinitialiser();
  /**
   * Un 401 peut parler d'autre chose que de notre session : le contrat du pont
   * refuse un code d'appairage invalide avec ce même statut. Croire ce 401 sur
   * parole déconnectait l'utilisateur sur une faute de frappe.
   */
  reponses.set('/api/projects/probe', reponse(401, {
    success: false, code: 'BRIDGE_PAIRING_CODE_INVALID', message: 'Code invalide.',
  }));
  reponses.set('/api/auth/me', reponse(200, {
    success: true, data: { user: { email: 'dev@panel.test' } },
  }));

  const err = await echec(() => request('/api/projects/probe', {
    method: 'POST', body: { url: 'x' },
  }));
  check('un 401 non confirmé N’EST PAS AUTH_INVALID', err?.kind !== 'AUTH_INVALID');
  check('un 401 non confirmé NE DÉCONNECTE PAS', sessionIntacte());
  check('un 401 non confirmé ne redirige pas', redirections.length === 0);
  check('le code métier du pont est préservé', err?.code === 'BRIDGE_PAIRING_CODE_INVALID');
}

section('401 pendant une panne de l’autorité — le doute ne déconnecte pas');
{
  reinitialiser();
  reponses.set('/api/deployment', reponse(401, {
    success: false, code: 'PANEL_UNAUTHORIZED', message: 'Authentification requise.',
  }));
  // `/api/auth/me` n'est PAS enregistré : la vérification elle-même échoue.

  const err = await echec(() => request('/api/deployment', { retries: 0 }));
  check('un 401 invérifiable NE DÉCONNECTE PAS', sessionIntacte());
  check('… et n’est pas classé AUTH_INVALID', err?.kind !== 'AUTH_INVALID');
  check('… et ne redirige pas', redirections.length === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   RÉESSAI — borné, et sur les seules erreurs transitoires
   ═══════════════════════════════════════════════════════════════════════════ */

section('Réessai — les lectures transitoires seulement');
{
  reinitialiser();
  let tentatives = 0;
  reponses.set('/api/deployment', () => {
    tentatives += 1;
    // Indisponible deux fois, puis le service revient : c'est exactement le
    // profil d'un backend qui finit de démarrer.
    if (tentatives < 3) return reponse(503, { success: false, code: 'PANEL_SERVICE_STARTING' });
    return reponse(200, { success: true, data: { ok: true } });
  });

  const data = await request('/api/deployment');
  check('une lecture transitoire est réessayée jusqu’au succès', data?.ok === true);
  check('… et il a bien fallu trois tentatives', tentatives === 3);
  check('… sans jamais toucher à la session', sessionIntacte());
}

section('Réessai — jamais une écriture, jamais un refus définitif');
{
  reinitialiser();
  let envois = 0;
  reponses.set('/api/deployment/targets/t1/deploy', () => {
    envois += 1;
    return reponse(503, { success: false, code: 'PANEL_SERVICE_STARTING' });
  });
  await echec(() => request('/api/deployment/targets/t1/deploy', {
    method: 'POST', body: { sshPassword: 'x' },
  }));
  check('un POST n’est JAMAIS rejoué par défaut (pas de double déploiement)',
    envois === 1);

  reinitialiser();
  let refus = 0;
  reponses.set('/api/deployment', () => {
    refus += 1;
    return reponse(400, { success: false, code: 'PANEL_DEPLOY_PASSWORD_REQUIRED' });
  });
  await echec(() => request('/api/deployment'));
  check('un refus définitif (400) n’est jamais réessayé', refus === 1);
}

finish();
