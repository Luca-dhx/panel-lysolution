// TOPOLOGIE RÉSEAU — une seule entrée, tout le reste dérivé.
//
// ── LE DÉFAUT QUE CES CONTRÔLES VERROUILLENT ────────────────────────────────
// Le Panel calculait ses URLs à deux endroits qui ne se parlaient pas : le
// script de déploiement rendait la MÊME adresse pour le frontend et le backend,
// là où SB Auto dérive depuis toujours un sous-domaine `api.` dédié. Deux
// philosophies pour un même écosystème, et autant d'endroits où un domaine
// pouvait diverger.
//
// Le frontend est désormais l'unique source de vérité. Ces contrôles prouvent
// que TOUT en découle — Nginx, certificats, webhooks, pont, médias — et qu'un
// seul wildcard DNS suffit.
import { check, finish, section, setTestEnv } from './helpers/harness.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

setTestEnv();

const {
  deriveDeploymentTopology,
  derivePairingEndpoints,
  normalizeHost,
  supportsApiSubdomain,
  API_SUBDOMAIN,
} = await import('../backend/src/config/deploymentTopology.js');

const { deriveUrls } = await import('../deploy/lib/config.mjs');
const { renderNginxConfig, renderNginxHttpOnly, certPaths } = await import('../deploy/lib/nginx.mjs');
const { buildPlan } = await import('../deploy/lib/plan.mjs');

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Le cas visé — panel.ly-solution.com');
{
  const t = deriveDeploymentTopology('panel.ly-solution.com');

  check('frontend', t.frontendHost === 'panel.ly-solution.com');
  check('backend dérivé, jamais configuré', t.backendHost === 'api.panel.ly-solution.com');
  check('URL frontend', t.frontendUrl === 'https://panel.ly-solution.com');
  check('URL backend', t.backendUrl === 'https://api.panel.ly-solution.com');
  check('API', t.apiBaseUrl === 'https://api.panel.ly-solution.com/api');
  check('pont', t.bridgeBaseUrl === 'https://api.panel.ly-solution.com/bridge/v1');
  check('médias', t.uploadsBaseUrl === 'https://api.panel.ly-solution.com/uploads');
  check('santé', t.healthUrl === 'https://api.panel.ly-solution.com/health');
  check('appairage', t.pairingUrl === 'https://api.panel.ly-solution.com/bridge/v1/pairings');
  check('médias publiés', t.publicMediaBaseUrl === 'https://api.panel.ly-solution.com/uploads');
  check('deux hôtes à servir et certifier', t.hosts.join(',') === 'panel.ly-solution.com,api.panel.ly-solution.com');
  check('le backend a bien sa propre origine', t.hasDedicatedBackendHost === true);

  // TOUT dérive du frontend : aucune adresse ne contient autre chose.
  const toutes = [t.backendUrl, t.apiBaseUrl, t.bridgeBaseUrl, t.uploadsBaseUrl, t.healthUrl, t.pairingUrl];
  check('aucune adresse ne s’écarte du domaine d’entrée',
    toutes.every((u) => u.startsWith('https://api.panel.ly-solution.com')));
}

section('1 bis. La règle est SANS exception sur un vrai domaine');
{
  for (const h of ['panel.exemple.fr', 'admin.client.co.uk', 'p.a.b.c.exemple.com']) {
    const t = deriveDeploymentTopology(h);
    check(`${h} → api.${h}`, t.backendHost === `${API_SUBDOMAIN}.${h}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Développement et cas particuliers — même origine, sans régression');
{
  // `api.localhost` ne résout nulle part : forcer un sous-domaine casserait le
  // développement pour une règle qui n'a de sens qu'en production.
  const local = deriveDeploymentTopology('localhost:4100');
  check('localhost:port → même origine', local.backendHost === local.frontendHost);
  check('…en http, pas en https', local.backendUrl.startsWith('http://'));
  check('…un seul hôte', local.hosts.length === 1);
  check('…et c’est dit explicitement', local.hasDedicatedBackendHost === false);

  check('localhost nu', deriveDeploymentTopology('localhost').backendHost === 'localhost');
  check('IPv4 directe', deriveDeploymentTopology('195.35.0.211').backendHost === '195.35.0.211');
  check('…sans sous-domaine absurde', !deriveDeploymentTopology('195.35.0.211').backendHost.startsWith('api.'));
  check('hôte sans domaine', deriveDeploymentTopology('monserveur').backendHost === 'monserveur');

  check('supportsApiSubdomain distingue les deux mondes',
    supportsApiSubdomain('panel.ly-solution.com') === true
    && supportsApiSubdomain('localhost') === false
    && supportsApiSubdomain('10.0.0.1') === false);
}

section('2 bis. Une URL complète vaut un hôte');
{
  check('protocole ignoré', normalizeHost('https://panel.ly-solution.com') === 'panel.ly-solution.com');
  check('chemin ignoré', normalizeHost('https://panel.ly-solution.com/api/x?a=1') === 'panel.ly-solution.com');
  check('casse normalisée', normalizeHost('PANEL.Ly-Solution.COM') === 'panel.ly-solution.com');
  check('point final retiré', normalizeHost('panel.ly-solution.com.') === 'panel.ly-solution.com');
  check('vide → null', normalizeHost('   ') === null);
  check('topologie vide → null', deriveDeploymentTopology('') === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Le déploiement consomme CETTE fonction, et pas une autre');
{
  const cfg = lire('deploy/lib/config.mjs');
  check('deriveUrls délègue à la topologie canonique',
    /deriveDeploymentTopology\(host\)/.test(cfg));
  check('…et ne calcule plus aucun domaine elle-même',
    !/backendUrl: `https:\/\/\$\{host\}`/.test(cfg));
  check('l’hôte backend est exposé à la configuration', /backendHost: deriveUrls\(merged\.host\)\.backendHost/.test(cfg));

  const u = deriveUrls('panel.ly-solution.com');
  check('le script rend la même chose que la topologie',
    u.backendUrl === deriveDeploymentTopology('panel.ly-solution.com').backendUrl);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Nginx sert les DEUX hôtes');
{
  const conf = renderNginxConfig({
    host: 'panel.ly-solution.com',
    backendHost: 'api.panel.ly-solution.com',
    backendPort: 4100,
    paths: { currentLink: '/srv/panel/current' },
  });

  const noms = conf.match(/server_name .*/g) || [];
  check('trois blocs : redirection, frontend, backend', noms.length === 3);
  check('la redirection HTTP couvre les deux',
    noms[0] === 'server_name panel.ly-solution.com api.panel.ly-solution.com;');
  check('le frontend a son bloc', noms[1] === 'server_name panel.ly-solution.com;');
  check('le backend a le sien', noms[2] === 'server_name api.panel.ly-solution.com;');

  // Le frontend garde ses proxys : aucune ligne de React à changer, aucun CORS.
  check('/api reste proxifié sur le frontend', /location \/api\/ \{/.test(conf));
  check('/bridge aussi', /location \/bridge\/ \{/.test(conf));
  check('/health aussi', /location = \/health \{/.test(conf));
  check('le bloc api proxifie TOUTE sa surface',
    /server_name api\.panel\.ly-solution\.com;[\s\S]*?location \/ \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:4100;/.test(conf));

  // Deux certificats distincts, chacun sur son hôte.
  check('certificat du frontend', conf.includes(certPaths('panel.ly-solution.com').fullchain));
  check('certificat du backend', conf.includes(certPaths('api.panel.ly-solution.com').fullchain));
  check('AUCUN wildcard TLS', !/\*\./.test(conf));

  // Le challenge ACME doit répondre sur les deux noms, sinon le second
  // certificat ne peut pas être émis.
  const http = renderNginxHttpOnly({
    host: 'panel.ly-solution.com',
    backendHost: 'api.panel.ly-solution.com',
    paths: { currentLink: '/srv/panel/current' },
  });
  check('le challenge ACME couvre les deux hôtes',
    /server_name panel\.ly-solution\.com api\.panel\.ly-solution\.com;/.test(http));
  check('…sur le webroot certbot', /root \/var\/www\/certbot;/.test(http));

  // Rétrocompatibilité : un Panel mono-hôte reste rendu correctement.
  const mono = renderNginxConfig({ host: 'panel.local', backendPort: 4100, paths: { currentLink: '/x' } });
  check('sans hôte backend, un seul bloc HTTPS', (mono.match(/listen 443 ssl/g) || []).length === 1);
  check('…et ses proxys restent en place', /location \/api\/ \{/.test(mono));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Certificats — un par hôte, HTTP-01, aucun wildcard');
{
  const urls = deriveUrls('panel.ly-solution.com');
  const cfg = {
    host: urls.frontendHost,
    backendHost: urls.backendHost,
    backendPort: 4100,
    environment: 'PROD',
    serviceName: 'panel',
    keepReleases: 5,
    paths: {
      siteRoot: '/srv/p', releasesDir: '/srv/p/releases', currentLink: '/srv/p/current',
      sharedDir: '/srv/p/shared', envFile: '/srv/p/shared/.env', sharedUploads: '/srv/p/shared/uploads',
    },
    urls,
  };
  const plan = buildPlan(cfg, { releaseId: 'r1' });
  // `certonly`, pas `certbot` : `mkdir -p /var/www/certbot` contient le mot.
  const certbot = plan.find((s) => s.step === 'https.certificate').commands.filter((c) => c.includes('certonly'));

  check('deux émissions, une par hôte', certbot.length === 2);
  check('…le frontend', certbot[0].includes('-d panel.ly-solution.com'));
  check('…le backend', certbot[1].includes('-d api.panel.ly-solution.com'));
  check('challenge HTTP-01 sur webroot', certbot.every((c) => c.includes('--webroot -w /var/www/certbot')));
  check('AUCUN wildcard demandé', certbot.every((c) => !c.includes('*')));
  check('…ni challenge DNS', certbot.every((c) => !c.includes('dns-')));
  check('renouvellement idempotent', certbot.every((c) => c.includes('--keep-until-expiring')));

  // La configuration réseau reçoit l'origine CANONIQUE.
  const reseau = plan.find((s) => s.step === 'runtime.network').commands.join(' ');
  check('backendUrl = https://api.<frontend>', reseau.includes('--backend-url https://api.panel.ly-solution.com'));
  check('frontendUrl inchangé', reseau.includes('--frontend-url https://panel.ly-solution.com'));

  // La vérification publique porte sur le backend canonique.
  const publique = plan.find((s) => s.step === 'health.public');
  check('la santé publique interroge le backend canonique',
    publique.healthCheck.url === 'https://api.panel.ly-solution.com/health');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. DNS — un seul wildcard, et rien d’autre');
{
  const topo = lire('backend/src/config/deploymentTopology.js');
  const ensure = lire('backend/src/deployment-engine/dns/ensureDns.js');
  const plan = lire('deploy/lib/plan.mjs');
  const nginx = lire('deploy/lib/nginx.mjs');

  // Aucun enregistrement dédié n'est demandé nulle part.
  for (const [nom, src] of [['plan', plan], ['nginx', nginx]]) {
    check(`${nom} : aucun enregistrement *.panel`, !/\*\.panel/.test(src));
    check(`${nom} : aucune création d’enregistrement api.`, !/ensureRecord|createRecord/.test(src));
  }

  // Le moteur refuse de créer un enregistrement quand un wildcard couvre déjà :
  // c'est CE choix qui préserve la résolution multi-niveaux.
  check('un wildcard couvrant évite toute création',
    /action: 'wildcard_covers'/.test(ensure));
  check('…et ce test précède la création',
    ensure.indexOf("action: 'wildcard_covers'") < ensure.indexOf("action: 'create'"));

  // La documentation du module dit la règle, et le piège.
  check('la règle multi-niveaux est documentée', /RFC 4592/.test(topo));
  check('…ainsi que le piège de l’enregistrement explicite',
    /cesserait alors d’être couvert|cesserait alors d'être couvert/.test(topo));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Pont et appairage — aucune URL construite à la main');
{
  const e = derivePairingEndpoints('https://api.panel.ly-solution.com');

  check('base', e.baseUrl === 'https://api.panel.ly-solution.com');
  check('pont', e.bridgeBaseUrl === 'https://api.panel.ly-solution.com/bridge/v1');
  check('ping', e.pingUrl.endsWith('/bridge/v1/ping'));
  check('appairage', e.pairingUrl.endsWith('/bridge/v1/pairings'));
  check('état de l’appairage', e.pairingStatusUrl.endsWith('/bridge/v1/pairings/current'));
  check('bootstrap', e.bootstrapUrl.endsWith('/bridge/v1/pairings'));
  check('battement', e.heartbeatUrl.endsWith('/bridge/v1/heartbeats'));
  check('projection montante', e.projectionUrl.endsWith('/bridge/v1/sync/push'));
  check('descendante', e.syncPullUrl.endsWith('/bridge/v1/sync/pull'));

  check('toutes dérivent de la MÊME origine',
    Object.values(e).every((u) => u.startsWith('https://api.panel.ly-solution.com')));

  // Une migration de domaine emporte toutes les adresses d'un coup.
  const apres = derivePairingEndpoints('https://api.panel.autre-domaine.fr');
  check('changer de domaine change TOUT',
    Object.keys(e).every((k) => e[k] !== apres[k]));

  // On n'annonce jamais une adresse qu'on ne sait pas publique.
  check('sans origine résolue, aucune adresse', derivePairingEndpoints(null) === null);
  check('…ni sur une valeur non absolue', derivePairingEndpoints('panel.ly-solution.com') === null);

  // Les routes réelles du pont correspondent aux adresses annoncées.
  const routes = lire('backend/src/routes/bridge.routes.js');
  for (const chemin of ['/ping', '/pairings', '/pairings/current', '/heartbeats', '/sync/push', '/sync/pull']) {
    check(`la route ${chemin} existe vraiment`, routes.includes(`'${chemin}'`));
  }
  check('…montées sous /bridge/v1', /app\.use\('\/bridge\/v1', bridgeRoutes\)/.test(lire('backend/src/app.js')));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. Médias, PUBLIC_URL et webhooks — une seule origine');
{
  const upload = lire('backend/src/services/upload/upload.service.js');
  const network = lire('backend/src/services/network/networkConfig.service.js');

  check('les médias publiés dérivent du résolveur',
    /const \{ url \} = await resolveBackendUrl\(\);/.test(upload));
  check('…jamais d’une variable dédiée', !/config\.publicUrl/.test(upload));
  check('les adresses d’appairage aussi', /export async function resolvePairingEndpoints/.test(network));
  check('…via le helper unique', /derivePairingEndpoints\(url\)/.test(network));

  // PUBLIC_URL n'est qu'un repli d'amorçage, jamais l'autorité.
  check('la configuration système prime sur PUBLIC_URL',
    network.indexOf('URL_SOURCE.SYSTEM_CONFIGURATION') < network.indexOf('URL_SOURCE.ENVIRONMENT'));
  check('CORS dérive des deux URLs résolues',
    /const derived = \[frontend\.url, backend\.url\]/.test(network));

  // Aucun module ne recalcule un domaine dans son coin.
  const suspects = [
    'backend/src/services/upload/upload.service.js',
    'backend/src/services/company/company.service.js',
    'backend/src/controllers/network.controller.js',
  ];
  for (const f of suspects) {
    const src = lire(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(`${path.basename(f)} : aucun domaine concaténé à la main`,
      !/https:\/\/\$\{[^}]*host/.test(src) && !/`api\.\$\{/.test(src));
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('9. Compatibilité — un Panel déjà déployé continue de fonctionner');
{
  const conf = renderNginxConfig({
    host: 'panel.lycarz.com',
    backendHost: 'api.panel.lycarz.com',
    backendPort: 4100,
    paths: { currentLink: '/srv/p/current' },
  });

  // Les DEUX chemins répondent : l'ancien (même origine) et le nouveau.
  check('l’ancien chemin /api reste servi par le frontend',
    /server_name panel\.lycarz\.com;[\s\S]*?location \/api\/ \{/.test(conf));
  check('…et le nouveau par le backend canonique',
    /server_name api\.panel\.lycarz\.com;[\s\S]*?location \/ \{/.test(conf));

  // Le frontend n'a rien à changer.
  const api = lire('frontend/src/lib/api.ts');
  check('le client appelle toujours des chemins relatifs',
    /fetch\(`?\/api\//.test(api) || /fetch\(path/.test(api));
  check('…sans base d’URL absolue', !/https:\/\/api\./.test(api));
}

finish();
