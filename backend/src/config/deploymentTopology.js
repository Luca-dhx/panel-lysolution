/**
 * TOPOLOGIE RÉSEAU DU PANEL — une seule entrée, tout le reste en découle.
 *
 * ── LE DÉFAUT QUE CE MODULE SUPPRIME ────────────────────────────────────────
 * Le Panel calculait ses URLs à deux endroits qui ne se parlaient pas : le
 * script de déploiement (`deriveUrls`) rendait la MÊME adresse pour le
 * frontend et le backend, tandis que SB Auto, lui, dérive depuis toujours un
 * sous-domaine `api.` dédié. Deux philosophies pour un même écosystème, et
 * autant d'endroits où un domaine pouvait diverger.
 *
 * Le frontend devient l'unique source de vérité. Le backend est TOUJOURS
 * `api.<frontendHost>`, sans exception et sans réglage : webhooks, pont,
 * bootstrap, médias, santé, appairage — tout est dérivé ici, et nulle part
 * ailleurs.
 *
 * ── POURQUOI UN SEUL WILDCARD DNS SUFFIT ────────────────────────────────────
 * Un wildcard `*.exemple.com` résout à TOUTE profondeur (RFC 4592 §2.1.1) :
 * `panel.exemple.com` comme `api.panel.exemple.com` répondent sans qu'aucun
 * enregistrement leur soit dédié. Le seul prérequis est donc `A * → IP`.
 *
 * Attention, et c'est la seule chose à ne pas faire : créer un enregistrement
 * EXPLICITE pour `panel.exemple.com` ferait de ce nom un nœud de la zone, et
 * `api.panel.exemple.com` cesserait alors d'être couvert par le wildcard. Le
 * moteur ne crée jamais un tel enregistrement quand un wildcard couvre déjà
 * l'adresse (cf. `deployment-engine/dns/ensureDns.js`).
 *
 * TLS ne pose pas ce problème : les certificats sont émis par HTTP-01, un par
 * hôte, sans jamais dépendre d'un wildcard — un wildcard TLS ne couvrant qu'un
 * seul niveau, il ne pourrait de toute façon pas servir `api.panel.…`.
 *
 * Module PUR : aucune dépendance, aucun accès réseau, aucune lecture
 * d'environnement. Importable aussi bien par le backend que par les scripts de
 * déploiement.
 */

/** Sous-domaine du backend — identique à `API_SUBDOMAIN` de SB Auto. */
export const API_SUBDOMAIN = 'api';

/** Chemins servis par le backend, relatifs à son origine. */
export const BACKEND_PATHS = Object.freeze({
  api: '/api',
  bridge: '/bridge/v1',
  health: '/health',
  uploads: '/uploads',
});

/**
 * Normalise une entrée en hôte exploitable.
 *
 * Accepte une URL complète comme un hôte nu : c'est la même information, et
 * exiger l'une des deux formes ne ferait que déplacer l'erreur.
 */
export function normalizeHost(input) {
  const brut = String(input ?? '').trim().toLowerCase();
  if (!brut) return null;
  const sansProtocole = brut.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const sansChemin = sansProtocole.split('/')[0].split('?')[0].split('#')[0];
  // Le port est conservé : en développement, `localhost:5173` EST l'hôte.
  return sansChemin.replace(/\.+$/, '') || null;
}

/**
 * Un hôte peut-il porter un sous-domaine `api.` ?
 *
 * Trois cas ne le peuvent pas, et il vaut mieux les nommer que les découvrir :
 *   · une adresse IP — `api.195.35.0.211` ne veut rien dire ;
 *   · `localhost`, avec ou sans port — rien ne résoudrait `api.localhost` ;
 *   · un hôte déjà porteur d'un port — le développement sert tout sur une
 *     seule origine.
 *
 * Dans ces cas, backend et frontend partagent l'origine : c'est exactement le
 * comportement historique, donc aucune régression en local.
 */
export function supportsApiSubdomain(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (h.includes(':')) return false;                    // port explicite
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;  // IPv4
  if (h.startsWith('[') || h.includes('::')) return false; // IPv6
  if (!h.includes('.')) return false;                   // hôte sans domaine
  return true;
}

/**
 * LA fonction centrale. Tout le réseau du Panel en sort.
 *
 * @param {string} frontendHost  hôte public du frontend (ou URL complète)
 * @param {object} [opts]
 * @param {string} [opts.protocol]  `https` par défaut ; `http` en local
 * @returns {object|null} topologie complète, ou `null` si l'hôte est vide
 */
export function deriveDeploymentTopology(frontendHost, opts = {}) {
  const frontend = normalizeHost(frontendHost);
  if (!frontend) return null;

  // En local on ne force pas HTTPS : un certificat n'y existe pas, et
  // annoncer une adresse qui ne répond pas serait pire que rien.
  const local = !supportsApiSubdomain(frontend);
  const protocol = opts.protocol || (local ? 'http' : 'https');

  // Le backend est TOUJOURS `api.<frontend>` — sauf là où ce nom ne peut pas
  // exister, auquel cas les deux partagent l'origine (comportement historique).
  const backend = local ? frontend : `${API_SUBDOMAIN}.${frontend}`;

  const frontendUrl = `${protocol}://${frontend}`;
  const backendUrl = `${protocol}://${backend}`;

  return {
    frontendHost: frontend,
    backendHost: backend,
    frontendUrl,
    backendUrl,
    /** Le backend a-t-il sa propre origine ? Faux en local. */
    hasDedicatedBackendHost: backend !== frontend,
    /** Hôtes à servir et à certifier — dans cet ordre. */
    hosts: backend === frontend ? [frontend] : [frontend, backend],

    apiBaseUrl: `${backendUrl}${BACKEND_PATHS.api}`,
    bridgeBaseUrl: `${backendUrl}${BACKEND_PATHS.bridge}`,
    uploadsBaseUrl: `${backendUrl}${BACKEND_PATHS.uploads}`,
    healthUrl: `${backendUrl}${BACKEND_PATHS.health}`,
    /** Racine des médias publiés aux projets — même origine que le backend. */
    publicMediaBaseUrl: `${backendUrl}${BACKEND_PATHS.uploads}`,
    /** Adresse d'appairage : celle que les projets appellent en premier. */
    pairingUrl: `${backendUrl}${BACKEND_PATHS.bridge}/pairings`,
  };
}

/**
 * LES ADRESSES DU PONT — celles qu'un projet appelle.
 *
 * ── POURQUOI UN HELPER PLUTÔT QU'UNE CONCATÉNATION ──────────────────────────
 * Un projet qui construit ces adresses à la main fige le domaine du Panel dans
 * sa configuration. Le jour d'une migration, il continue d'appeler l'ancienne —
 * et l'appairage se rompt sans qu'aucun code n'ait changé. Elles dérivent donc
 * toutes de `backendUrl`, qui dérive lui-même du frontend.
 *
 * @param {string} backendUrl  origine du backend (déjà résolue)
 */
export function derivePairingEndpoints(backendUrl) {
  const base = String(backendUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  const bridge = `${base}${BACKEND_PATHS.bridge}`;

  return {
    baseUrl: base,
    bridgeBaseUrl: bridge,
    /** Vivacité du pont, sans jeton — le premier appel d'un projet. */
    pingUrl: `${bridge}/ping`,
    /** Consommation d'un code d'appairage : rend le bridgeToken. */
    pairingUrl: `${bridge}/pairings`,
    /** État de l'appairage courant (et sa révocation). */
    pairingStatusUrl: `${bridge}/pairings/current`,
    /** Découverte jointe à l'appairage — entreprise, APIs, curseur. */
    bootstrapUrl: `${bridge}/pairings`,
    heartbeatUrl: `${bridge}/heartbeats`,
    /** Projections montantes : ce que le projet publie au Panel. */
    projectionUrl: `${bridge}/sync/push`,
    /** Descendantes : ce que le Panel a pour le projet. */
    syncPullUrl: `${bridge}/sync/pull`,
  };
}

export default deriveDeploymentTopology;
