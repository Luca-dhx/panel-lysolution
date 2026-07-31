// SURFACE DE DÉPLOIEMENT DU PANEL — Phase 4.
//
// Le Panel se déploie lui-même, par le même moteur que SB Auto 06. Ce fichier
// vérifie la couche APPLICATION de ce déploiement — destinations, runs,
// worker détaché, API, interface.
//
// ── CE QUI N'EST PAS TESTÉ ICI, ET POURQUOI ─────────────────────────────────
// Aucun serveur n'est contacté. Le moteur lui-même est déjà couvert par
// `deploy.test.js` et `deployment-rollback.test.js`, avec un transport
// simulé. Ce qui reste à prouver, c'est que le Panel appelle correctement ce
// moteur, et surtout qu'un déploiement SURVIT au redémarrage du backend —
// le cas de l'auto-déploiement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'backend', 'src');
const read = (...parts) => fs.readFileSync(path.join(src, ...parts), 'utf8');

const targets = await import('../backend/src/services/deployment/deploymentTarget.service.js');
const runs = await import('../backend/src/services/deployment/deploymentRun.service.js');
const worker = await import('../backend/src/services/deployment/deploymentWorker.service.js');
const executor = await import('../backend/src/services/deployment/deploymentExecutor.service.js');
const profile = await import('../backend/src/deployment-engine/config/project.profile.js');
const PanelDeploymentRun = (await import('../backend/src/models/PanelDeploymentRun.model.js')).default;
const PanelDeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le Panel possède un profil de déploiement complet');
{
  check('un slug de projet est déclaré', profile.PROJECT_SLUG === 'panel');
  check('…et un identifiant de build', typeof profile.PROJECT_ID === 'string');

  const ids = profile.APPS.map((a) => a.id);
  check('deux composants déclarés : frontend et backend',
    ids.includes('frontend') && ids.includes('backend') && profile.APPS.length === 2);

  const frontend = profile.APPS.find((a) => a.id === 'frontend');
  const backend = profile.APPS.find((a) => a.id === 'backend');
  check('le frontend est servi en statique à la racine',
    frontend.role === 'web' && frontend.nginxRole === 'web');
  check('…avec ses phases d’installation et de build',
    Boolean(frontend.installPhase && frontend.buildPhase));
  check('le backend est un service, jamais buildé ni servi en statique',
    backend.role === 'server' && backend.nginxRole === 'server' && !backend.buildPhase);

  check('aucun sous-domaine Manager n’est dérivé (le Panel n’en a pas)',
    !profile.APPS.some((a) => a.role === 'web-sub'));

  check('les variables obligatoires du serveur sont déclarées',
    profile.REQUIRED_REMOTE_ENV.includes('BRIDGE_ENCRYPTION_KEY')
    && profile.REQUIRED_REMOTE_ENV.includes('JWT_SECRET')
    && profile.REQUIRED_REMOTE_ENV.includes('__DB_FOR_ENV__'));
  check('le nom de service PM2 est dérivé de l’hôte',
    profile.serviceName('panel.exemple.com') === 'panel-panel.exemple.com');

  // Le moteur doit savoir tout faire : ce sont les capacités annoncées.
  const manifest = JSON.parse(read('deployment-engine', 'engine.manifest.json'));
  for (const capability of ['nginx', 'https-certbot', 'pm2', 'health-check', 'rollback', 'releases']) {
    check(`le moteur embarqué déclare « ${capability} »`, manifest.capabilities.includes(capability));
  }
  check('…et supporte le profil du Panel', manifest.supportedProfiles.includes('panel'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Destinations : l’INTENTION est saisie, la CONFIGURATION est déduite');
{
  await PanelDeploymentTarget.deleteMany({});

  // Ce que l'écran envoie réellement : quatre champs. Rien de technique.
  const created = await targets.createTarget({
    name: 'Recette',
    url: 'https://panel-test.exemple.com',
    environment: 'TEST',
    sshHost: '203.0.113.10',
  }, { userId: 'u-1' });

  check('une destination se crée avec la seule INTENTION', created.targetId !== undefined);

  // ── LES DÉDUCTIONS ────────────────────────────────────────────────────
  check('le port du backend est ATTRIBUÉ, pas demandé',
    Number.isInteger(created.backendPort) && created.backendPort >= 5100);
  check('la racine distante vient du profil',
    created.remoteRoot === profile.DEFAULT_REMOTE_ROOT);
  check('le port SSH est la convention standard', created.sshPort === 22);
  check('l’utilisateur du serveur est pré-rempli', created.sshUser === 'root');

  // Deuxième destination : le port suivant, jamais le même.
  const second = await targets.createTarget({
    name: 'Production', url: 'https://panel.exemple.com', environment: 'PROD',
    sshHost: '203.0.113.11',
  });
  check('deux destinations n’ont JAMAIS le même port',
    second.backendPort === created.backendPort + 1);

  // L'origine de chaque valeur est affichable : la déduction n'est pas magique.
  const labels = created.derived.map((d) => d.label);
  for (const label of ['Port local du backend', 'Service PM2', 'Chemin sur le serveur', 'Certificat TLS']) {
    check(`la déduction « ${label} » est expliquée`, labels.includes(label));
  }
  check('…chaque valeur déduite nomme son ORIGINE',
    created.derived.every((d) => typeof d.from === 'string' && d.from.length > 0));
  check('le service PM2 suit la convention du profil',
    created.derived.find((d) => d.label === 'Service PM2').value === profile.serviceName(created.host));

  // ── CE QUE LE FRONTEND NE PEUT PLUS IMPOSER ──────────────────────────
  const forced = await targets.createTarget({
    name: 'Tentative', url: 'https://tentative.exemple.com', environment: 'TEST',
    sshHost: '203.0.113.12',
    // Un frontend obsolète (ou malveillant) enverrait ceci :
    backendPort: 9999, sshPort: 2222, remoteRoot: '/tmp/ailleurs',
    certbotEmail: 'injecte@exemple.com', extraEnv: { INJECTE: 'oui' },
  });
  check('un port imposé par le frontend est IGNORÉ', forced.backendPort !== 9999);
  check('…un port SSH imposé aussi', forced.sshPort === 22);
  check('…une racine imposée aussi', forced.remoteRoot === profile.DEFAULT_REMOTE_ROOT);
  check('…et aucune variable technique ne passe',
    Object.keys(forced.extraEnv ?? {}).length === 0);

  await targets.deleteTarget(second.targetId);
  await targets.deleteTarget(forced.targetId);
}

section('Destinations : l’URL fait autorité, rien n’est saisi deux fois');
{
  const created = (await targets.listTargets())[0];
  check('…l’hôte est DÉDUIT de l’URL, pas saisi', created.host === 'panel-test.exemple.com');
  check('…le type aussi', created.type === 'subdomain' || created.type === 'domain');
  check('…et elle naît « jamais déployée »', created.state === 'NEW');
  check('les variables exigées sont annoncées avec DB_TEST résolue',
    created.requiredRemoteEnv.includes('DB_TEST')
    && !created.requiredRemoteEnv.includes('__DB_FOR_ENV__'));

  const prodEnv = targets.requiredEnvFor('PROD');
  check('…et DB_PROD pour une destination de production', prodEnv.includes('DB_PROD'));

  // Le mot de passe n'a même pas de champ pour exister.
  const raw = await PanelDeploymentTarget.findOne({ targetId: created.targetId }).lean();
  check('AUCUN champ de mot de passe n’existe au modèle',
    !JSON.stringify(raw).toLowerCase().includes('password'));

  check('un hôte déjà déclaré est refusé',
    await rejects(() => targets.createTarget({
      name: 'Doublon', url: 'https://panel-test.exemple.com', environment: 'TEST',
      sshHost: '203.0.113.11', backendPort: 4200,
    }), 'PANEL_TARGET_HOST_TAKEN'));

  const bad = await captureError(() => targets.createTarget({
    name: 'x', url: 'pas une url', environment: 'RECETTE', sshHost: '',
  }));
  check('une saisie invalide est refusée', bad?.code === 'PANEL_TARGET_INVALID');
  // Seuls les champs RÉELLEMENT saisis peuvent être fautifs. Un port ou une
  // racine ne figurent plus ici : ils ne sont plus demandés.
  check('…en NOMMANT chaque champ fautif',
    ['name', 'environment', 'sshHost'].every(
      (field) => bad.details.errors.some((e) => e.startsWith(field))));
  check('…et aucun champ technique n’apparaît dans les refus',
    !bad.details.errors.some((e) => /backendPort|remoteRoot|sshPort|certbot/.test(e)));

  const updated = await targets.updateTarget(created.targetId, { name: 'Recette renommée' });
  check('une destination se modifie', updated.name === 'Recette renommée');
  // Le port survit à une modification : le changer casserait le service PM2
  // et la configuration nginx déjà en place sur le serveur.
  check('…sans que son port attribué ne change',
    updated.backendPort === created.backendPort);

  await targets.deleteTarget(created.targetId);
  check('…et se supprime', (await targets.listTargets()).length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Runs : écrits par DEUX processus, donc jamais par save()');
{
  await PanelDeploymentTarget.deleteMany({});
  await PanelDeploymentRun.deleteMany({});

  const target = await targets.createTarget({
    name: 'Recette', url: 'https://panel-test.exemple.com', environment: 'TEST',
    sshHost: '203.0.113.10', backendPort: 4100,
  });

  const runId = await runs.createRun({
    target, operationType: 'PRECHECK', user: 'dev@panel.test',
  });
  check('un run se crée en état « en cours »',
    (await runs.getRunOrThrow(runId)).status === 'running');

  await runs.recordStep(runId, { id: 'preflight', label: 'Prérequis', status: 'running' });
  await runs.recordStep(runId, { id: 'preflight', label: 'Prérequis', status: 'ok', message: '12 contrôles' });
  const afterStep = await runs.getRunOrThrow(runId);
  check('ré-émettre une étape la MODIFIE au lieu de la dupliquer',
    afterStep.steps.length === 1 && afterStep.steps[0].status === 'ok');
  check('…et sa durée est calculée', typeof afterStep.steps[0].durationMs === 'number');

  await runs.appendLog(runId, 'première ligne');
  await runs.appendLog(runId, 'seconde ligne', 'WARNING');
  const logged = await runs.getRunOrThrow(runId);
  check('le journal s’accumule', logged.log.length === 2);
  check('…avec ses niveaux', logged.log[1].level === 'WARNING');

  await runs.finalizeRun(runId, { status: 'ok', summary: 'Prérequis satisfaits.' });
  const done = await runs.getRunOrThrow(runId);
  check('un run se conclut', done.status === 'ok' && done.finishedAt !== null);
  check('…avec sa durée totale', typeof done.durationMs === 'number');

  // Le service est écrit par deux processus : un save() sur document chargé
  // ferait perdre les écritures concurrentes de l'autre.
  const source = read('services', 'deployment', 'deploymentRun.service.js');
  check('aucune écriture par save() sur un document chargé',
    !/\.save\(\)/.test(source));
  check('…toutes les écritures sont des mises à jour ciblées',
    (source.match(/updateOne\(/g) ?? []).length >= 5);

  void target;
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUTO-DÉPLOIEMENT : un run survit à la mort de son processus');
{
  await PanelDeploymentRun.deleteMany({});
  const target = (await targets.listTargets())[0];

  const runId = await runs.createRun({
    target, operationType: 'DEPLOYMENT', user: 'dev@panel.test', selfDeployment: true,
  });
  await runs.attachWorker(runId, 424242);

  const attached = await runs.getRunOrThrow(runId);
  check('le worker s’annonce et bat la mesure',
    attached.workerHeartbeatAt !== null && attached.selfDeployment === true);

  // On simule un worker mort : son dernier battement remonte à longtemps.
  const ancient = new Date(Date.now() - runs.HEARTBEAT_TIMEOUT_MS - 60_000).toISOString();
  await PanelDeploymentRun.updateOne({ runId }, { $set: { workerHeartbeatAt: ancient } });

  const stale = await runs.getRunOrThrow(runId);
  check('un run dont le worker se tait est présenté INTERROMPU',
    stale.status === 'interrupted' && stale.staleWorker === true);
  check('…et son résumé dit que l’issue est INCONNUE',
    /INCONNUE/i.test(stale.summary ?? ''));

  // La LECTURE ne doit pas modifier la base : un worker lent ne doit pas être
  // condamné par une consultation d'écran.
  const untouched = await PanelDeploymentRun.findOne({ runId }).lean();
  check('la lecture n’a RIEN modifié en base', untouched.status === 'running');

  // C'est le démarrage du backend qui tranche — le cas exact de
  // l'auto-déploiement, où le Panel redémarre pendant son propre run.
  const finalized = await runs.finalizeOrphanRuns();
  check('le démarrage du backend finalise les runs orphelins', finalized === 1);
  const closed = await PanelDeploymentRun.findOne({ runId }).lean();
  check('…en « interrompu », ni réussi ni échoué', closed.status === 'interrupted');
  check('…et il n’est plus compté comme actif',
    (await runs.activeRunFor(target.targetId)) === null);

  check('un second appel ne refinalise rien', (await runs.finalizeOrphanRuns()) === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le worker est DÉTACHÉ — c’est ce qui le rend survivant');
{
  check('le script du worker existe', fs.existsSync(worker.workerPath));

  const launcher = read('services', 'deployment', 'deploymentWorker.service.js');
  check('lancé détaché du backend', /detached:\s*true/.test(launcher));
  check('…sans tube vers le parent (qui le tuerait par EPIPE)', /stdio:\s*'ignore'/.test(launcher));
  check('…et déréférencé pour ne pas retenir le backend', /child\.unref\(\)/.test(launcher));

  // Un secret passé en argv est lisible par `ps aux` ; l'environnement d'un
  // processus ne l'est que par son propriétaire. On vérifie donc le TABLEAU
  // D'ARGUMENTS précisément, pas « quelque part dans l'appel à spawn » — ce
  // qui attraperait aussi le bloc `env` et rendrait l'assertion inutile.
  const argv = launcher.match(/spawn\(\s*process\.execPath\s*,\s*(\[[^\]]*\])/)?.[1] ?? '';
  check('le mot de passe voyage par l’ENVIRONNEMENT', /PANEL_DEPLOY_SSH_PASSWORD:/.test(launcher));
  check('…et jamais par argv, lisible par `ps aux`',
    argv.length > 0 && !/password|sshPassword/i.test(argv));

  const workerSource = fs.readFileSync(worker.workerPath, 'utf8');
  check('le worker efface le secret de son propre environnement',
    /delete process\.env\.PANEL_DEPLOY_SSH_PASSWORD/.test(workerSource));
  check('…ouvre sa PROPRE connexion à la base', /connectDatabase/.test(workerSource));
  check('…et conclut le run même en cas d’erreur inattendue',
    /finally\s*\{/.test(workerSource) && /finalizeRun/.test(workerSource));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’exécuteur DÉLÈGUE au moteur, il ne réimplémente rien');
{
  const source = read('services', 'deployment', 'deploymentExecutor.service.js');

  check('les cinq opérations du parcours existent',
    ['CONNECTION_TEST', 'PRECHECK', 'SIMULATION', 'DEPLOYMENT', 'ROLLBACK']
      .every((op) => executor.OPERATIONS[op] === op));

  check('il utilise le moteur standard', /new DeploymentEngine\(/.test(source));
  check('…son coffre en mémoire pour le mot de passe', /openSession/.test(source) && /closeSession/.test(source));
  check('aucune commande SSH n’est écrite ici',
    !/ssh |scp |exec\(/.test(source.replace(/\/\/.*$/gm, '')));
  check('aucune configuration nginx n’est fabriquée ici',
    !/server\s*\{|listen 443/.test(source));
  check('le secret est détruit quoi qu’il arrive',
    /finally\s*\{[\s\S]{0,200}closeSession/.test(source));

  // La simulation ne doit rien modifier : elle ne peut pas appeler deploy().
  const simulation = source.slice(source.indexOf('async function simulation'), source.indexOf('async function deployment'));
  check('la simulation n’appelle jamais deploy()', !/engine\.deploy\(/.test(simulation));
  check('…elle fait un préflight réel puis rend le plan',
    /precheck\(/.test(simulation) && /PIPELINE_STEPS/.test(simulation));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Surface /api/deployment');
{
  const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
  await seedFromEnv();
  const { createApp } = await import('../backend/src/app.js');
  const { call, close } = await startServer(createApp());

  check('la surface est fermée sans jeton', (await call('GET', '/api/deployment')).status === 401);

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'dev@panel.test', password: 'motdepasse-test' },
  });
  const auth = { authorization: `Bearer ${login.json.data.token}` };

  const overview = await call('GET', '/api/deployment', { headers: auth });
  check('GET / rend destinations, compteurs et exécutions récentes',
    overview.status === 200
    && Array.isArray(overview.json.data.targets)
    && overview.json.data.summary !== undefined);

  const self = await call('GET', '/api/deployment/self', { headers: auth });
  check('GET /self décrit le Panel lui-même',
    self.status === 200 && self.json.data.projectSlug === 'panel');
  check('…avec ses deux composants', self.json.data.apps.length === 2);

  const created = await call('POST', '/api/deployment/targets', {
    headers: auth,
    body: {
      name: 'Recette HTTP', url: 'https://panel-http.exemple.com', environment: 'TEST',
      sshHost: '203.0.113.20', backendPort: 4300,
    },
  });
  check('POST /targets crée une destination', created.status === 201);
  const targetId = created.json.data.targetId;

  const noPassword = await call('POST', `/api/deployment/targets/${targetId}/deploy`, {
    headers: auth, body: {},
  });
  check('une opération sans mot de passe est refusée',
    noPassword.status === 400 && noPassword.json.code === 'PANEL_DEPLOY_PASSWORD_REQUIRED');
  check('…en expliquant que le Panel n’en conserve aucun',
    /n’en conserve aucun/.test(noPassword.json.message));

  // Production : la confirmation explicite est exigée.
  const prod = await call('POST', '/api/deployment/targets', {
    headers: auth,
    body: {
      name: 'Production', url: 'https://panel.exemple.com', environment: 'PROD',
      sshHost: '203.0.113.30', backendPort: 4400,
    },
  });
  const unconfirmed = await call('POST', `/api/deployment/targets/${prod.json.data.targetId}/deploy`, {
    headers: auth, body: { sshPassword: 'x' },
  });
  check('un déploiement PROD sans confirmation est refusé',
    unconfirmed.status === 400 && unconfirmed.json.code === 'PANEL_DEPLOY_CONFIRMATION_REQUIRED');

  // Une opération déjà en cours verrouille la destination.
  await runs.createRun({
    target: await targets.getTargetOrThrow(targetId),
    operationType: 'DEPLOYMENT', user: 'dev@panel.test',
  });
  const busy = await call('POST', `/api/deployment/targets/${targetId}/preflight`, {
    headers: auth, body: { sshPassword: 'x' },
  });
  check('une seconde opération concurrente est refusée',
    busy.status === 409 && busy.json.code === 'PANEL_DEPLOY_ALREADY_RUNNING');

  const unknownRun = await call('GET', '/api/deployment/runs/inexistant', { headers: auth });
  check('un run inconnu → 404 propre', unknownRun.status === 404);

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’interface ne contourne rien et n’expose aucun secret');
{
  const front = path.join(root, 'frontend', 'src');
  const apiClient = fs.readFileSync(path.join(front, 'lib', 'api.ts'), 'utf8');

  for (const page of ['DeploymentPage.tsx', 'DeploymentTargetPage.tsx', 'DeploymentRunPage.tsx']) {
    check(`${page} existe`, fs.existsSync(path.join(front, 'pages', page)));
  }

  // On retire les commentaires avant de chercher : ils PARLENT du mot de
  // passe, ce qui est souhaitable. Ce qu'on interdit, c'est un CHAMP.
  const types = fs.readFileSync(path.join(front, 'types.deployment.ts'), 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  check('aucun type de RÉPONSE ne déclare de champ mot de passe',
    !/sshPassword\s*[?:]/.test(types));

  const targetPage = fs.readFileSync(path.join(front, 'pages', 'DeploymentTargetPage.tsx'), 'utf8');
  check('le mot de passe est effacé du navigateur dès qu’il a servi',
    /setPassword\(''\)/.test(targetPage));
  check('…et n’est jamais rangé dans localStorage',
    !/localStorage|sessionStorage/.test(targetPage));

  // ── LE FORMULAIRE NE DOIT PAS REDEVENIR TECHNIQUE ────────────────────
  // C'est la régression qu'on empêche de revenir : un champ technique
  // ajouté « pour être complet » ferait porter à l'opérateur une décision
  // qui appartient au moteur.
  const listPage = fs.readFileSync(path.join(front, 'pages', 'DeploymentPage.tsx'), 'utf8');
  const form = listPage.slice(listPage.indexOf('function TargetForm'));
  const inputs = [...form.matchAll(/set\('(\w+)'/g)].map((m) => m[1]);
  const allowed = ['name', 'url', 'environment', 'sshHost', 'sshUser', 'dbName'];
  const technical = inputs.filter((field) => !allowed.includes(field));
  check(`le formulaire ne demande QUE l’intention${technical.length ? ` — ${[...new Set(technical)]}` : ''}`,
    technical.length === 0);

  for (const field of ['backendPort', 'remoteRoot', 'sshPort', 'certbotEmail', 'extraEnv']) {
    check(`« ${field} » n’est plus un champ de saisie`, !new RegExp(`set\\('${field}'`).test(form));
  }

  const targetPageSource = fs.readFileSync(path.join(front, 'pages', 'DeploymentTargetPage.tsx'), 'utf8');
  check('la configuration déduite est MONTRÉE, avec l’origine de chaque valeur',
    /derived\.map/.test(targetPageSource) && /derived-from/.test(targetPageSource));

  const runPage = fs.readFileSync(path.join(front, 'pages', 'DeploymentRunPage.tsx'), 'utf8');
  check('le suivi SONDE au lieu d’ouvrir un flux',
    /setInterval/.test(runPage) && !/EventSource|WebSocket/.test(runPage));
  check('…et distingue « backend absent » d’une vraie erreur',
    /unreachable/.test(runPage));
  check('…en expliquant que c’est attendu pendant un auto-déploiement',
    /redémarre/.test(runPage));

  const routes = [...apiClient.matchAll(/['"`](\/api\/deployment[^'"`\n]*)/g)]
    .map((m) => m[1].replace(/\$\{[^}$]*\}/g, ':id').split(/[?$]/)[0]);
  const known = [
    '/api/deployment', '/api/deployment/self', '/api/deployment/runs',
    '/api/deployment/runs/:id', '/api/deployment/targets', '/api/deployment/targets/:id',
    '/api/deployment/targets/:id/test-connection', '/api/deployment/targets/:id/preflight',
    '/api/deployment/targets/:id/simulate', '/api/deployment/targets/:id/deploy',
    '/api/deployment/targets/:id/rollback', '/api/deployment/targets/:id/releases',
  ];
  const unknown = routes.filter((r) => !known.includes(r));
  check(`le client n’appelle que les routes du moteur${unknown.length ? ` — ${unknown}` : ''}`,
    unknown.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function rejects(fn, code) {
  try {
    await fn();
    return false;
  } catch (err) {
    return err?.code === code;
  }
}

async function captureError(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

await stopMemoryMongo();
finish();
