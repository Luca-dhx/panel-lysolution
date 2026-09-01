/**
 * Génération & application de la configuration Nginx d'une cible.
 *
 * ── ENTIÈREMENT PILOTÉ PAR LE PROFIL (Phase 2E) ────────────────────────────
 * Ce fichier ne connaît AUCUN nom d'application : ni « vitrine », ni
 * une application nommée. Il ne connaît que `APPS` et le
 * `nginxRole` que chaque application déclare dans
 * `config/project.profile.js`.
 *
 * Rôles reconnus :
 *   web            application statique servie sur l'hôte PRINCIPAL
 *   web-subdomain  application statique servie sur `<subdomain>.<host>`
 *   api            reverse proxy PUR vers le backend, sur un hôte dédié
 *   static         contenu statique seul (aucun proxy backend)
 *   proxy          reverse proxy seul, sans racine statique
 *   server         backend Node : fournit le port ; N'A PAS de bloc serveur
 *
 * Un projet à 3 applications et un projet à 2 produisent donc la même
 * configuration par le même code : seule la liste `APPS` change.
 *
 * Le certificat TLS est référencé selon le cas (wildcard partagé pour un
 * sous-domaine géré, ou certificat dédié Let's Encrypt) — voir certbot.js.
 */
import { API_SUBDOMAIN, APPS, HTTP_MAX_BODY_MB } from './config/project.profile.js';
import { COMMAND_CLASS, TIMEOUTS, runRemoteCommand } from './remoteCommand.js';

/** Chemin du fichier de conf sites-available pour un hôte. */
export function nginxConfigPath(host) {
  return `/etc/nginx/sites-available/${host}.conf`;
}

/** Chemin du lien sites-enabled. */
export function nginxEnabledPath(host) {
  return `/etc/nginx/sites-enabled/${host}.conf`;
}

/**
 * Emplacement du certificat selon le type de cible.
 * - subdomain (wildcard) : certificat *.base partagé.
 * - domain (client)      : certificat dédié Let's Encrypt au nom de l'hôte.
 */
export function certPaths(target) {
  /**
   * UN CERTIFICAT PAR HÔTE — sans exception, y compris l'hôte principal.
   *
   * ── L'HYPOTHÈSE SUPPRIMÉE ─────────────────────────────────────────────────
   * Un hôte reconnu comme sous-domaine d'une base gérée pointait ici vers le
   * certificat `*.base`, supposé déjà émis. Cette hypothèse rendait un domaine
   * VIERGE indéployable : le préflight exigeait un fichier que seul un
   * déploiement antérieur aurait pu créer, et certbot refusait de l'émettre.
   *
   * Elle était de toute façon fausse pour la moitié des hôtes : un wildcard ne
   * couvrant qu'un seul niveau, `manager.demo.base` et `api.demo.base`
   * recevaient déjà un certificat dédié. Deux régimes coexistaient donc pour
   * une même destination.
   *
   * Désormais : un certificat par hôte, émis par HTTP-01, sans prérequis. Le
   * wildcard DNS suffit à résoudre tous les niveaux ; TLS n'en dépend plus.
   */
  return {
    fullchain: `/etc/letsencrypt/live/${target.host}/fullchain.pem`,
    privkey: `/etc/letsencrypt/live/${target.host}/privkey.pem`,
    certName: target.host,
    shared: false,
  };
}

/**
 * Emplacement d'un certificat DÉDIÉ pour un hôte dérivé.
 * Un wildcard `*.base` ne couvrant qu'UN niveau, tout hôte dérivé
 * (`<sub>.<host>`) exige son propre certificat.
 */
export function dedicatedCertPaths(host) {
  return {
    fullchain: `/etc/letsencrypt/live/${host}/fullchain.pem`,
    privkey: `/etc/letsencrypt/live/${host}/privkey.pem`,
    certName: host,
    shared: false,
  };
}

/**
 * Alias de compatibilité — ancien nom de `dedicatedCertPaths`, conservé pour
 * les appelants antérieurs à la Phase 2E. Ne PAS utiliser dans du code neuf.
 */
export const legacyDedicatedCertPaths = dedicatedCertPaths;

/**
 * Bloc proxy commun (API + PONT + uploads + health) vers le backend PM2.
 *
 * `/bridge/` est la surface que les PROJETS appellent (bootstrap d'appairage,
 * heartbeats, synchronisation) : elle n'est pas sous `/api/`, et sans son
 * propre bloc elle retombait dans le repli SPA `try_files … /index.html`.
 * nginx la servait alors par son module statique, qui accepte GET/HEAD et
 * refuse le reste — un `POST /bridge/v1/pairings` recevait donc un
 * 405 Not Allowed d'nginx sans jamais atteindre Express.
 */
function backendProxy(backendPort) {
  return `    location /api/ {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /bridge/ {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /uploads/ { proxy_pass http://127.0.0.1:${backendPort}; }
    location = /health { proxy_pass http://127.0.0.1:${backendPort}; }`;
}

/**
 * Bloc proxy PUR (tout `/`) vers le backend — pour le domaine API dédié.
 *
 * `noindex` : un hôte d'API n'a rien à faire dans un moteur de recherche. Ses
 * réponses sont du JSON, mais ses pages d'erreur ne le sont pas toujours, et
 * une adresse d'API indexée est une invitation à la sonder.
 */
function apiProxyAll(backendPort, { noindex = false } = {}) {
  return `${noindex ? `${sitemapAbsent()}\n${robotsInterdit()}\n` : ''}    location / {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;${noindex ? '\n        add_header X-Robots-Tag "noindex, nofollow" always;' : ''}
    }`;
}

/**
 * Blocs `location` d'un site statique (SPA) avec politique de cache CORRECTE.
 *
 * Sans cela, `index.html` serait servi SANS `Cache-Control` : le navigateur lui
 * appliquerait un cache heuristique et continuerait d'afficher un ANCIEN
 * index.html (pointant vers d'anciens hash d'assets) même après un déploiement
 * réussi.
 *
 * Règles :
 *  - `index.html` + manifestes de version → `no-cache` : TOUJOURS revalider, donc
 *    le nouveau build est pris en compte immédiatement (les assets étant
 *    fingerprintés, aucun risque de mélange de versions).
 *  - `/assets/*` (nom = hash du contenu) → `immutable`, cache 1 an, et `=404` si
 *    absent (ne PAS retomber sur index.html : évite de servir du HTML pour un .js).
 */
function staticSiteLocations({ noindex = false, backendPort = null } = {}) {
  const entete = noindex ? '\n        add_header X-Robots-Tag "noindex, nofollow" always;' : '';
  return `    location = /index.html { add_header Cache-Control "no-cache";${entete} }
    location = /version.json { add_header Cache-Control "no-cache"; }
    location = /build-manifest.json { add_header Cache-Control "no-cache"; }
${noindex ? `\n${sitemapAbsent()}\n${robotsInterdit()}\n` : ''}${backendPort !== null ? `\n${sitemapLocation(backendPort)}\n` : ''}
${moduleScriptLocation()}

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;${entete}
    }`;
}

/**
 * LE PLAN DU SITE — un `location` EXACT, sinon le repli d'application le mange.
 *
 * ══ L'INCIDENT QUI A PRODUIT CE BLOC ════════════════════════════════════════
 *
 * Google Search Console a refusé le plan du site de la vitrine :
 *
 *     « Le sitemap peut être lu, mais contient des erreurs.
 *       Le sitemap est un fichier HTML. »
 *
 * Le plan existait, mais sous `/api/public/sitemap.xml`. À `/sitemap.xml` —
 * l'adresse que tout moteur essaie, et la seule qu'on pense à soumettre —
 * aucun fichier ne correspondait dans la racine statique, donc `try_files …
 * /index.html` rendait la page d'accueil en `text/html`, avec un code 200.
 *
 * C'est exactement le défaut déjà rencontré sur `/bridge/` : un chemin sans
 * bloc dédié retombe dans le repli d'application à page unique. La leçon vaut
 * pour toute adresse de PROTOCOLE servie par le backend.
 *
 * ══ POURQUOI UN 200 EST PIRE QU'UN 404 ══════════════════════════════════════
 *
 * Un 404 dit au moteur « réessaie plus tard ». Un 200 porteur de HTML lui dit
 * « voici ton plan », et il conclut que le plan est invalide. L'erreur ne se
 * voit alors que dans sa console, des jours après la mise en ligne.
 *
 * ══ POURQUOI CE BLOC EST GÉNÉRIQUE ═════════════════════════════════════════
 *
 * Il est posé sur TOUT site public dont le backend est branché, sans condition
 * sur le projet. Un projet dont le backend n'expose pas la route rendra un 404
 * honnête, ce qui est le comportement correct : mieux vaut « pas de plan » que
 * « un plan qui est du HTML ».
 */
function sitemapLocation(backendPort) {
  return `    location = /sitemap.xml {
        proxy_pass http://127.0.0.1:${backendPort}/sitemap.xml;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;
}

/**
 * UN `robots.txt` QUI INTERDIT TOUT — pour les hôtes qui ne sont pas la vitrine.
 *
 * ══ CE QUE L'ABSENCE DU SITEMAP NE PROTÈGE PAS ══════════════════════════════
 *
 * Le Manager, le Panel et l'hôte d'API ne figurent dans aucun plan de site, et
 * l'on pourrait croire cela suffisant. Ce n'est pas le cas : un moteur indexe
 * ce qu'il DÉCOUVRE, et il découvre par les liens, les certificats — les
 * journaux de transparence publient chaque nom émis —, les barres d'adresse et
 * les référents. Le plan du site ne fait qu'ACCÉLÉRER, il n'autorise rien.
 *
 * Il faut donc une interdiction EXPLICITE, et elle est double : ce `robots.txt`
 * pour la découverte, et l'en-tête `X-Robots-Tag` pour ce qui serait tout de
 * même exploré. Aucun des deux ne change le fonctionnement de l'application :
 * ce sont des directives destinées aux robots, que les navigateurs ignorent.
 */
/**
 * ROBOTS.TXT D'UN HOTE PRIVE — interdiction totale, servie en texte brut.
 *
 * Deux precisions valent d'etre ecrites, parce que l'une a deja mordu :
 *
 * 1. `default_type`, PAS `add_header Content-Type`. Un `return 200 "..."` pose
 *    deja un type sur la reponse ; un `add_header` ne le REMPLACE pas, il en
 *    AJOUTE un second. nginx emettait alors, mesure en production :
 *
 *        Content-Type: text/plain, text/plain; charset=utf-8
 *
 *    Deux valeurs jointes par une virgule ne sont pas un type de contenu.
 *
 * 2. Ce bloc et l'en-tete `X-Robots-Tag` sont COMPLEMENTAIRES, pas redondants.
 *    Ce fichier demande de ne pas EXPLORER, ce qui n'empeche pas d'indexer une
 *    adresse connue par ailleurs ; l'en-tete interdit d'INDEXER, mais n'est lu
 *    que si la page est exploree. Retirer l'un ouvre une porte.
 */
/**
 * UN HÔTE PRIVÉ NE PUBLIE AUCUN PLAN DU SITE — 404, franchement.
 *
 * ══ CE QUI ÉTAIT SERVI AVANT, ET MESURÉ EN PRODUCTION ══════════════════════
 *
 *   api.ly-solution.com/sitemap.xml       200 · application/xml   ← le VRAI plan
 *   manager.ly-solution.com/sitemap.xml   200 · text/html         ← la page du Manager
 *
 * Deux causes, un seul symptôme. L'hôte API proxifie TOUT vers le backend, qui
 * sert désormais `/sitemap.xml` à sa racine : le plan du site public se
 * retrouvait donc publié sous un second domaine, non canonique. Et l'hôte du
 * Manager appliquait son repli d'application à page unique — le « 200 qui
 * ment » que ce moteur existe précisément pour interdire.
 *
 * Ni l'un ni l'autre n'était indexable (les deux portent `noindex` et un
 * robots.txt fermé), et ce n'est pas une raison de les laisser : une défense
 * ne dispense pas d'être exact. Un plan du site appartient à UN hôte, le
 * public. Partout ailleurs, l'adresse n'existe pas — et le dire est plus
 * honnête que de rendre autre chose.
 */
function sitemapAbsent() {
  return `    location = /sitemap.xml {
        add_header X-Robots-Tag "noindex, nofollow" always;
        return 404;
    }`;
}

function robotsInterdit() {
  return `    location = /robots.txt {
        default_type text/plain;
        charset utf-8;
        add_header X-Robots-Tag "noindex, nofollow" always;
        return 200 "User-agent: *\\nDisallow: /\\n";
    }`;
}

/**
 * LES MODULES `.mjs` SONT DU JAVASCRIPT — et nginx ne le sait pas tout seul.
 *
 * ══ LE DÉFAUT QUE CE BLOC FERME ═════════════════════════════════════════════
 *
 * La table `mime.types` livrée avec nginx ne connaît pas l'extension `.mjs` sur
 * les versions encore largement déployées. Un module servi depuis `/assets/`
 * repartait donc en `application/octet-stream`.
 *
 * Le navigateur applique aux scripts de MODULE un contrôle de type STRICT
 * (spécification HTML) : il refuse d'exécuter ce qui n'est pas annoncé comme du
 * JavaScript. Constaté en recette réelle sur le Manager, au clic « Configurer
 * les zones » :
 *
 *     Failed to load module script: The server responded with a
 *     non-JavaScript MIME type of "application/octet-stream".
 *
 * PDF.js, dont le worker est un `.mjs`, basculait alors sur un « fake worker »,
 * qui échouait à son tour — et l'écran restait en chargement, sans fin.
 *
 * ══ POURQUOI UN `location` DÉDIÉ, ET PAS UN `types` DANS `/assets/` ═════════
 *
 * Un bloc `types { … }` ne COMPLÈTE pas la table héritée : il la REMPLACE pour
 * la portée où il apparaît. Le poser dans `/assets/` pour y ajouter une seule
 * extension ferait perdre toutes les autres — CSS, polices, images repartiraient
 * en type par défaut. Le remède serait pire que le mal, et invisible jusqu'au
 * premier écran mal rendu.
 *
 * On isole donc l'extension dans son propre `location` avec une table VIDE et
 * un `default_type` explicite : c'est l'idiome nginx pour forcer un type sans
 * toucher au reste. Une expression régulière l'emporte sur le préfixe
 * `/assets/`, ce bloc doit donc reporter la même politique de cache — les noms
 * restent empreintés par le contenu.
 *
 * ══ GÉNÉRIQUE, ET C'EST LE POINT ═══════════════════════════════════════════
 *
 * La règle porte sur l'EXTENSION, jamais sur un nom de fichier ni sur un hash.
 * Tout module d'un build futur en bénéficie sans qu'on y revienne.
 */
function moduleScriptLocation() {
  return `    location ~* \\.mjs$ {
        types { }
        default_type application/javascript;
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }`;
}

/** Hostname API dédié dérivé de l'hôte du site (sauf fourni explicitement). */
export function deriveApiHost(host, apiHost) {
  return (apiHost || `${API_SUBDOMAIN}.${host}`).toLowerCase();
}

/**
 * Rôle Nginx d'une application, dérivé du profil.
 * `nginxRole` explicite s'il est déclaré ; sinon déduit de `role` (les profils
 * antérieurs à la Phase 2E ne déclarent que `role`).
 */
function nginxRoleOf(app) {
  if (app.nginxRole) return app.nginxRole;
  if (app.role === 'web') return 'web';
  if (app.role === 'web-sub') return 'web-subdomain';
  return 'server';
}

/**
 * PLAN DES SITES à servir, dérivé du profil et de la cible.
 *
 * Retourne une liste de descripteurs, dans l'ordre de rendu :
 *   { id, host, kind: 'static'|'proxy', root|null, withBackendProxy, cert, dedicatedCert }
 *
 * C'est LA fonction qui remplace les anciens blocs codés en dur. Elle est
 * exportée : les tests la vérifient directement, sans lire du texte Nginx.
 *
 * @param {object} target  Résultat de parseTargetUrl.
 * @param {object} opts
 * @param {Record<string,string>} [opts.roots]  racine statique par identifiant d'application
 * @param {string} [opts.webRoot]     compat : racine de l'application `web`
 * @param {string} [opts.subRoot]     compat : racine de la première `web-subdomain`
 * @param {string} [opts.apiHost]     hôte API explicite
 * @param {Record<string,string>} [opts.hosts] hôte explicite par identifiant d'application
 */
export function planSites(target, opts = {}) {
  const host = target.host;
  const roots = { ...(opts.roots ?? {}) };
  const sites = [];
  // La composition vient du profil — injectable pour vérifier des topologies
  // arbitraires sans toucher au profil du dépôt.
  const APP_LIST = Array.isArray(opts.profile) ? opts.profile : (opts.profile?.APPS ?? APPS);

  const webApps = APP_LIST.filter((app) => nginxRoleOf(app) === 'web');
  const subApps = APP_LIST.filter((app) => nginxRoleOf(app) === 'web-subdomain');

  // `webRoot` / `subRoot` : raccourcis positionnels (première application `web`,
  // première `web-subdomain`) pour les appels qui ne construisent pas `roots`.
  if (opts.webRoot && webApps[0] && roots[webApps[0].id] === undefined) roots[webApps[0].id] = opts.webRoot;
  if (opts.subRoot && subApps[0] && roots[subApps[0].id] === undefined) roots[subApps[0].id] = opts.subRoot;

  for (const app of APP_LIST) {
    const role = nginxRoleOf(app);
    if (role === 'server') continue; // le backend ne produit pas de bloc serveur

    const explicitHost = opts.hosts?.[app.id];
    if (role === 'web') {
      sites.push({
        id: app.id,
        host: explicitHost ?? host,
        kind: 'static',
        root: roots[app.id] ?? null,
        withBackendProxy: app.backendProxy !== false,
        /**
         * L'HÔTE PUBLIC du projet — celui que les moteurs doivent indexer, et
         * le seul. Tous les autres reçoivent une interdiction explicite.
         *
         * ══ POURQUOI LE PROFIL PEUT DIRE NON ═══════════════════════════════
         *
         * Le rôle « web » décrit une FORME — une application front servie sur
         * l'hôte principal — pas une DESTINATION. Le Panel a exactement cette
         * forme : son frontend est un « web » posé sur panel.ly-solution.com.
         * Il ne doit pourtant jamais paraître dans un moteur de recherche.
         *
         * Déduire la publicité du seul rôle rendrait donc indexable tout plan
         * de contrôle, tout espace interne, toute console d'exploitation bâtis
         * sur cette forme — en silence, et sans que personne ne l'ait demandé.
         *
         * Le défaut reste « public » : c'est le cas de toute vitrine, et un
         * projet vitrine qui oublierait de se déclarer resterait indexable,
         * ce qui est l'erreur la moins grave des deux.
         */
        public: app.public !== false,
        cert: certPaths(target),
      });
    } else if (role === 'web-subdomain') {
      const subHost = (explicitHost ?? `${app.subdomain}.${host}`).toLowerCase();
      sites.push({
        id: app.id,
        host: subHost,
        kind: 'static',
        root: roots[app.id] ?? null,
        withBackendProxy: app.backendProxy !== false,
        public: false,
        // Un hôte dérivé n'est jamais couvert par un wildcard à un niveau.
        cert: dedicatedCertPaths(subHost),
      });
    } else if (role === 'static') {
      const subHost = (explicitHost ?? (app.subdomain ? `${app.subdomain}.${host}` : host)).toLowerCase();
      sites.push({
        id: app.id,
        host: subHost,
        kind: 'static',
        root: roots[app.id] ?? null,
        withBackendProxy: false,
        // Un site statique auxiliaire (démonstration, page d'attente) n'est
        // public que s'il occupe l'hôte principal du projet — et que si son
        // profil ne s'y oppose pas.
        public: app.public !== false && subHost === host,
        cert: subHost === host ? certPaths(target) : dedicatedCertPaths(subHost),
      });
    } else if (role === 'proxy') {
      const subHost = (explicitHost ?? `${app.subdomain}.${host}`).toLowerCase();
      sites.push({
        id: app.id, host: subHost, kind: 'proxy', root: null,
        withBackendProxy: true, public: false, cert: dedicatedCertPaths(subHost),
      });
    }
  }

  // Hôte API dédié : déclaré par une application de rôle `api`, sinon dérivé
  // du sous-domaine d'API du profil (comportement historique).
  const apiApp = APP_LIST.find((app) => nginxRoleOf(app) === 'api');
  const apiHost = deriveApiHost(host, opts.apiHost ?? (apiApp?.subdomain ? `${apiApp.subdomain}.${host}` : undefined));
  sites.push({
    id: apiApp?.id ?? 'api',
    host: apiHost,
    kind: 'proxy',
    root: null,
    withBackendProxy: true,
    cert: dedicatedCertPaths(apiHost),
  });

  return sites;
}

/** Tous les hostnames servis par la configuration (ordre stable). */
export function servedHosts(target, opts = {}) {
  return [...new Set(planSites(target, opts).map((site) => site.host))];
}

/**
 * Rend la configuration Nginx HTTPS complète — un bloc serveur par site du
 * plan, plus la redirection HTTP → HTTPS commune.
 *
 * @param {object} target Résultat de parseTargetUrl.
 * @param {object} opts   Voir planSites().
 */
export function renderNginxConfig(target, opts) {
  const { backendPort } = opts;
  const sites = planSites(target, opts);
  const proxy = backendProxy(backendPort);
  const hosts = sites.map((site) => site.host);

  const blocks = sites.map((site) => {
    const header = `server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${site.host};

    ssl_certificate ${site.cert.fullchain};
    ssl_certificate_key ${site.cert.privkey};

    # TAILLE MAXIMALE D'UN ENVOI — sans cette ligne, Nginx applique 1 Mo.
    # L'application en accepte davantage : un import de logo repartait donc en
    # 413 sans jamais atteindre le backend, donc sans code metier ni message.
    # La valeur vient du profil ; un test de derive la compare a la politique.
    client_max_body_size ${HTTP_MAX_BODY_MB}m;`;

    if (site.kind === 'proxy') {
      return `# --- ${site.id} (reverse proxy pur vers le backend interne) ---
${header}

${apiProxyAll(backendPort, { noindex: site.public !== true })}
}`;
    }
    // Les blocs PROXY sont écrits AVANT le repli SPA. nginx choisit le préfixe
    // le plus LONG, pas le premier : l'ordre ne décide de rien pour lui. Il
    // décide en revanche de ce qu'on lit — voir d'abord ce qui part au backend,
    // puis le repli, est la seule lecture qui ne laisse pas croire que `/`
    // capture tout.
    /*
      LE PLAN DU SITE N'EST POSÉ QUE SUR L'HÔTE PUBLIC, et seulement s'il a un
      backend pour le produire. Le Manager n'a pas de plan à publier ; lui en
      servir un ferait apparaître dans son domaine des adresses qui n'y sont
      pas, et l'inviterait à l'indexation qu'on lui refuse par ailleurs.
    */
    return `# --- ${site.id}${site.public ? ' (hôte PUBLIC : indexable)' : ' (non indexable)'} ---
${header}

    root ${site.root};
    index index.html;
${site.withBackendProxy ? `\n${proxy}\n` : ''}
${staticSiteLocations({
    noindex: site.public !== true,
    backendPort: site.public === true && site.withBackendProxy ? backendPort : null,
  })}
}`;
  });

  return `# Généré par DeploymentEngine — cible ${target.host}
# Sites servis : ${hosts.join(', ')}
# NE PAS éditer à la main : régénéré à chaque déploiement.
#
# HTTP/2 activé SUR la directive listen (« listen … ssl http2 ») : compatible de
# nginx 1.9.5 à aujourd'hui. La directive autonome « http2 on; » n'existe qu'à
# partir de nginx 1.25.1 et fait échouer les serveurs plus anciens (Ubuntu 20.04/
# 22.04 → nginx 1.18) avec [emerg] unknown directive "http2". Sur 1.25.1+, la
# forme « listen … http2 » n'émet qu'un [warn] (nginx -t reste « successful »).
server {
    listen 80;
    listen [::]:80;
    server_name ${hosts.join(' ')};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

${blocks.join('\n\n')}
`;
}

/**
 * Rend une configuration HTTP-ONLY (PHASE 1, AVANT certbot).
 *
 * Indispensable : la config HTTPS complète référence des `ssl_certificate` qui
 * N'EXISTENT PAS encore au premier déploiement (émis par certbot juste après).
 * Appliquer d'emblée la config HTTPS ferait échouer `nginx -t` (« cannot load
 * certificate »), et le challenge ACME HTTP-01 ne serait jamais servi (Nginx ne
 * démarrant pas). On sert donc d'abord les sites + le challenge en HTTP, on émet
 * les certificats, PUIS on bascule sur la config HTTPS complète.
 */
export function renderNginxHttpOnly(target, opts) {
  const { backendPort } = opts;
  const sites = planSites(target, opts);
  const proxy = backendProxy(backendPort);

  const blocks = sites.map((site) => {
    const header = `server {
    listen 80;
    listen [::]:80;
    server_name ${site.host};

    # Meme plafond qu'en HTTPS : ce vhost sert AVANT le certificat, et il
    # proxifie deja /api. Une limite differente ferait dependre l'acceptation
    # d'un import de l'avancement du certificat.
    client_max_body_size ${HTTP_MAX_BODY_MB}m;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }`;

    if (site.kind === 'proxy') {
      return `# --- ${site.id} (HTTP, pré-certificat) ---
${header}

${apiProxyAll(backendPort)}
}`;
    }
    return `# --- ${site.id} (HTTP, pré-certificat) ---
${header}

    root ${site.root};
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
${site.withBackendProxy ? `\n${proxy}\n` : ''}}`;
  });

  return `# Généré par DeploymentEngine — cible ${target.host} — PHASE HTTP (pré-certificat)
# Sites servis : ${sites.map((s) => s.host).join(', ')}
# NE PAS éditer à la main : régénéré à chaque déploiement.
# Temporaire : sert le challenge ACME (HTTP-01) et les sites en HTTP le temps de
# l'émission des certificats. Remplacée juste après par la config HTTPS complète.
${blocks.join('\n\n')}
`;
}

/** Écrit + active + teste une configuration ; nettoie le lien si invalide. */
async function installConfig(transport, target, content) {
  const configPath = nginxConfigPath(target.host);
  const enabledPath = nginxEnabledPath(target.host);

  // Écriture dans un fichier temporaire puis déplacement en sudo (droits root).
  const tmp = `/tmp/${target.host}.nginx.conf`;
  await transport.writeFile(tmp, content);
  /**
   * CRITIQUES : sans elles, `nginx -t` validerait la configuration PRÉCÉDENTE.
   *
   * Les deux codes de sortie n'étaient pas lus. Un `mv` refusé (droits, disque)
   * laissait l'ancien fichier en place ; le test qui suit passait donc au vert
   * — sur l'ancienne configuration — et le déploiement se poursuivait en
   * croyant avoir publié la nouvelle.
   */
  await runRemoteCommand(transport, {
    commandId: 'nginx.install_config',
    command: `sudo mv ${tmp} ${configPath}`,
    commandClass: COMMAND_CLASS.CRITICAL,
    timeoutMs: TIMEOUTS.FILESYSTEM,
    step: 'nginx',
  });
  await runRemoteCommand(transport, {
    commandId: 'nginx.enable_site',
    command: `sudo ln -sf ${configPath} ${enabledPath}`,
    commandClass: COMMAND_CLASS.CRITICAL,
    timeoutMs: TIMEOUTS.FILESYSTEM,
    step: 'nginx',
  });

  /**
   * SONDE : `nginx -t` RÉPOND. Un code non nul dit « la configuration est
   * invalide », ce qui est une réponse — c'est la lecture de sa sortie, juste
   * en dessous, qui en fait un échec avec son diagnostic.
   */
  const test = await runRemoteCommand(transport, {
    commandId: 'nginx.test',
    command: 'sudo nginx -t 2>&1',
    commandClass: COMMAND_CLASS.PROBE,
    timeoutMs: TIMEOUTS.QUICK,
    step: 'nginx',
  });
  const ok = /syntax is ok/i.test(test.stdout + test.stderr) && /test is successful/i.test(test.stdout + test.stderr);
  if (!ok) {
    // Atomicité : une conf invalide vient d'être ACTIVÉE (symlink sites-enabled).
    // Si on la laisse, le prochain « reload » de Nginx échoue et met à terre TOUS
    // les sites du serveur. On désactive donc immédiatement le lien : la conf
    // fautive reste dans sites-available (pour diagnostic) mais Nginx redevient
    // rechargeable. On ne recharge pas : l'ancienne conf active reste en place.
    /**
     * NETTOYAGE : on désactive la configuration fautive pour que Nginx reste
     * rechargeable. Son échec ne doit pas remplacer le diagnostic de
     * configuration invalide, qui est l'information utile.
     */
    await runRemoteCommand(transport, {
      commandId: 'nginx.disable_invalid_site',
      command: `sudo rm -f ${enabledPath}`,
      commandClass: COMMAND_CLASS.CLEANUP,
      timeoutMs: TIMEOUTS.QUICK,
      step: 'nginx',
    }).catch(() => {});
    const { DeploymentError } = await import('./errors.js');
    throw new DeploymentError('NGINX_CONFIG_INVALID', 'La configuration Nginx générée est invalide.', {
      step: 'nginx',
      details: { output: (test.stdout + test.stderr).slice(0, 500), disabledSymlink: enabledPath },
    });
  }
  return configPath;
}

/**
 * RECHARGEMENT — CRITIQUE, et son code de sortie n'était pas lu.
 *
 * ══ POURQUOI LE `||` NE SUFFISAIT PAS ══════════════════════════════════════
 *
 * `systemctl reload nginx || sudo nginx -s reload` a un repli légitime : les
 * deux mécanismes coexistent selon les installations. Mais la chaîne rend le
 * code du SECOND si le premier échoue — et personne ne le lisait. Les deux
 * pouvaient donc échouer : la configuration validée n'était jamais appliquée,
 * et le déploiement continuait en croyant le site publié.
 *
 * Le repli reste ; c'est son résultat qui est désormais exigé.
 */
async function reloadNginx(transport) {
  await runRemoteCommand(transport, {
    commandId: 'nginx.reload',
    command: 'sudo systemctl reload nginx || sudo nginx -s reload',
    commandClass: COMMAND_CLASS.CRITICAL,
    timeoutMs: TIMEOUTS.SERVICE,
    step: 'nginx',
  });
}

/**
 * PHASE 1 — applique la config HTTP-only (avant certbot), teste et recharge.
 * Écrase toute config précédente (y compris une config invalide laissée par un
 * déploiement interrompu). @returns {Promise<{configPath:string, mode:string, reloaded:boolean}>}
 */
export async function applyNginxHttpOnly(transport, target, opts) {
  const configPath = await installConfig(transport, target, renderNginxHttpOnly(target, opts));
  await reloadNginx(transport);
  return { configPath, mode: 'http', reloaded: true };
}

/**
 * PHASE 2 — applique la config HTTPS COMPLÈTE (certificats désormais présents),
 * teste puis recharge Nginx. @returns {Promise<{configPath:string, mode:string, reloaded:boolean}>}
 */
export async function applyNginxConfig(transport, target, opts) {
  const configPath = await installConfig(transport, target, renderNginxConfig(target, opts));
  await reloadNginx(transport);
  return { configPath, mode: 'https', reloaded: true };
}

export default {
  renderNginxConfig,
  renderNginxHttpOnly,
  applyNginxConfig,
  applyNginxHttpOnly,
  nginxConfigPath,
  certPaths,
  dedicatedCertPaths,
  planSites,
  servedHosts,
};
