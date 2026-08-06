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
  check, connectTestDatabase, finish, rejectsWith, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'backend', 'src');
const read = (...parts) => fs.readFileSync(path.join(src, ...parts), 'utf8');

const targets = await import('../backend/src/services/deployment/deploymentTarget.service.js');
const lifecycle = await import('../backend/src/services/deployment/destinationLifecycle.service.js');
const runs = await import('../backend/src/services/deployment/deploymentRun.service.js');
const worker = await import('../backend/src/services/deployment/deploymentWorker.service.js');
const executor = await import('../backend/src/services/deployment/deploymentExecutor.service.js');
const profile = await import('../backend/src/deployment-engine/config/project.profile.js');
const { CANONICAL_STEPS } = await import('../backend/src/deployment-engine/steps.js');
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

  // ── LA PORTÉE D'UN PORT EST LE SERVEUR (LOT 9) ────────────────────────
  // Deux destinations sur le MÊME serveur ne partagent jamais un port. Sur
  // deux serveurs différents, en revanche, le même numéro est parfaitement
  // sain : un port est une ressource de la machine, pas du Panel. L'ancienne
  // règle « le plus haut attribué + 1 », globale, interdisait des
  // configurations correctes tout en ne protégeant de rien — elle ne
  // regardait ni PM2 ni les sockets réelles.
  const memeServeur = await targets.createTarget({
    name: 'Voisine', url: 'https://voisine.exemple.com', environment: 'TEST',
    sshHost: '203.0.113.10',
  });
  check('deux destinations d’un MÊME serveur n’ont jamais le même port',
    memeServeur.backendPort !== created.backendPort);

  const second = await targets.createTarget({
    name: 'Production', url: 'https://panel.exemple.com', environment: 'PROD',
    sshHost: '203.0.113.11',
  });
  check('…et un autre serveur peut réutiliser le même numéro sans conflit',
    second.backendPort === created.backendPort);

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

  // ── LA SUPPRESSION N'EST PLUS UN NETTOYAGE (LOT 8) ────────────────────
  // Une destination ACTIVE ne se supprime plus : supprimer sa fiche laissait
  // sur le serveur son service PM2 — qui détenait toujours son port —, sa
  // configuration Nginx et ses fichiers, sans plus rien pour le signaler.
  const refus = await rejectsWith(() => targets.deleteTarget(second.targetId),
    'PANEL_TARGET_NOT_EMPTY');
  check('supprimer une destination ACTIVE est REFUSÉ', refus);

  // Nettoyage du jeu d'essai : on passe par le modèle, pas par le service —
  // c'est un ménage de test, pas une opération du Panel.
  await PanelDeploymentTarget.deleteMany({
    targetId: { $in: [second.targetId, forced.targetId, memeServeur.targetId] },
  });
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

  // Une destination JAMAIS mise en ligne se supprime tout de même — mais
  // seulement après être passée par l'état « vidée ». C'est la même règle
  // pour tout le monde : on ne supprime pas ce qu'on n'a pas constaté vide.
  await lifecycle.beginDeprovision(created.targetId, { runId: 'run-menage' });
  await lifecycle.markEmpty(created.targetId, { runId: 'run-menage', quarantine: false });
  await targets.deleteTarget(created.targetId);
  check('…et se supprime une fois VIDÉE', (await targets.listTargets()).length === 0);
  check('…sa fiche restant lisible pour l’audit',
    (await targets.listDeletedTargets()).length === 1);
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

  // ── LE PAYLOAD EXACT DU FORMULAIRE, EN HTTP RÉEL ─────────────────────
  // Quatre champs, rien d'autre. C'est ce que l'écran envoie réellement, et
  // c'est ce qui doit suffire.
  const created = await call('POST', '/api/deployment/targets', {
    headers: auth,
    body: {
      name: 'Recette HTTP',
      url: 'https://panel-http.exemple.com',
      environment: 'TEST',
      sshHost: '203.0.113.20',
    },
  });
  check('POST /targets avec le payload MINIMAL du formulaire → 201', created.status === 201);
  const targetId = created.json.data.targetId;

  check('…la destination est persistée',
    (await PanelDeploymentTarget.findOne({ targetId }).lean()) !== null);
  check('…un port lui est attribué automatiquement',
    Number.isInteger(created.json.data.backendPort) && created.json.data.backendPort >= 5100);
  check('…les valeurs techniques sont déduites',
    created.json.data.remoteRoot === profile.DEFAULT_REMOTE_ROOT
    && created.json.data.sshPort === 22
    && created.json.data.sshUser === 'root');
  check('…l’hôte est extrait de l’URL',
    created.json.data.host === 'panel-http.exemple.com');
  check('…la base est déduite de l’environnement',
    created.json.data.requiredRemoteEnv.includes('DB_TEST'));
  check('…et l’origine de chaque déduction est fournie',
    created.json.data.derived.length >= 8);

  // Elle doit apparaître dans la liste que charge l'interface.
  const listed = await call('GET', '/api/deployment', { headers: auth });
  check('…elle est visible dans la vue d’ensemble',
    listed.json.data.targets.some((t) => t.targetId === targetId));

  // Et sur sa propre fiche, avec sa configuration déduite.
  const fiche = await call('GET', `/api/deployment/targets/${targetId}`, { headers: auth });
  check('…et sur sa fiche, avec sa configuration déduite',
    fiche.status === 200 && fiche.json.data.target.derived.length >= 8);

  // ── AUCUNE SAISIE INVALIDE NE DOIT PRODUIRE UN 500 ───────────────────
  // Une URL sans schéma est le cas le plus courant de saisie humaine : elle
  // doit être ACCEPTÉE, le moteur la complète. La refuser serait une rigidité
  // gratuite envers un utilisateur non technique.
  const sansSchema = await call('POST', '/api/deployment/targets', {
    headers: auth,
    body: { name: 'Sans schéma', url: 'panel-brut.exemple.com', environment: 'TEST', sshHost: '1.2.3.4' },
  });
  check('une URL sans « https:// » est acceptée et complétée',
    sansSchema.status === 201 && sansSchema.json.data.host === 'panel-brut.exemple.com');

  const invalides = [
    ['corps vide', {}],
    ['url avec port explicite', { name: 'Avec port', url: 'https://x.exemple.fr:8443', environment: 'TEST', sshHost: '1.2.3.4' }],
    ['url illisible', { name: 'Illisible', url: 'pas une url du tout', environment: 'TEST', sshHost: '1.2.3.4' }],
    ['environnement inventé', { name: 'Env', url: 'https://env.exemple.fr', environment: 'RECETTE', sshHost: '1.2.3.4' }],
    ['serveur manquant', { name: 'Sans serveur', url: 'https://ss.exemple.fr', environment: 'TEST' }],
    ['champs null', { name: null, url: null, environment: null, sshHost: null }],
    ['types inattendus', { name: 12, url: { a: 1 }, environment: ['TEST'], sshHost: true }],
  ];
  for (const [label, body] of invalides) {
    const res = await call('POST', '/api/deployment/targets', { headers: auth, body });
    check(`« ${label} » → 4xx, jamais 500`, res.status >= 400 && res.status < 500);
  }
  // Une URL sans schéma est ACCEPTÉE (le moteur la complète) : on nettoie.
  const extra = await call('GET', '/api/deployment', { headers: auth });
  for (const t of extra.json.data.targets) {
    if (t.targetId !== targetId) await call('DELETE', `/api/deployment/targets/${t.targetId}`, { headers: auth });
  }

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

  // ── LA ROUTE UNIQUE : 202 + executionId ─────────────────────────────
  const solo = await call('POST', '/api/deployment/targets', {
    headers: auth,
    body: {
      name: 'Route unique', url: 'https://unique.exemple.com',
      environment: 'TEST', sshHost: '203.0.113.50',
    },
  });
  const soloId = solo.json.data.targetId;

  const launched = await call('POST', `/api/deployment/targets/${soloId}/deploy`, {
    headers: auth, body: { sshPassword: 'x' },
  });
  check('POST /deploy répond 202 ACCEPTED, pas 201', launched.status === 202);
  check('…avec un executionId', typeof launched.json.data.executionId === 'string');
  check('…et un statut « queued »', launched.json.data.status === 'queued');
  check('…sans attendre le résultat (rien n’est encore conclu)',
    launched.json.data.summary === undefined);

  // IDEMPOTENCE : un double clic ne lance pas deux déploiements.
  const doubleClick = await call('POST', `/api/deployment/targets/${soloId}/deploy`, {
    headers: auth, body: { sshPassword: 'x' },
  });
  check('un second clic est REFUSÉ, pas mis en file',
    doubleClick.status === 409 && doubleClick.json.code === 'PANEL_DEPLOY_ALREADY_RUNNING');
  check('…en nommant l’exécution qui occupe la place',
    typeof doubleClick.json.details?.runId === 'string');

  // La checklist est consultable IMMÉDIATEMENT, avant tout avancement.
  const immediate = await call('GET', `/api/deployment/runs/${launched.json.data.executionId}`, { headers: auth });
  check('la checklist est lisible dès le lancement',
    immediate.status === 200 && immediate.json.data.steps.length === CANONICAL_STEPS.length);
  check('…avec l’avancement à 0', immediate.json.data.progress.percent === 0);

  // REPRISE : une exécution en cours est retrouvée depuis la fiche.
  const reprise = await call('GET', `/api/deployment/targets/${soloId}`, { headers: auth });
  check('un rechargement retrouve l’exécution en cours',
    reprise.json.data.activeRun?.runId === launched.json.data.executionId);

  // HISTORIQUE : l'exécution y figure.
  const historique = await call('GET', `/api/deployment/runs?targetId=${soloId}`, { headers: auth });
  check('l’exécution apparaît à l’historique de la destination',
    historique.json.data.items.some((r) => r.runId === launched.json.data.executionId));

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE INTENTION, PAS UN PARCOURS — l’orchestration est au backend');
{
  await PanelDeploymentTarget.deleteMany({});
  await PanelDeploymentRun.deleteMany({});
  const target = await targets.createTarget({
    name: 'Orchestration', url: 'https://orch.exemple.com', environment: 'TEST',
    sshHost: '203.0.113.40',
  });

  // ── LA CHECKLIST EXISTE AVANT QUE RIEN NE COMMENCE ──────────────────
  // L'écran doit montrer d'emblée ce qui va se passer, pas une page vide
  // qui se remplit et laisse croire que rien ne démarre.
  const runId = await runs.createRun({
    target, operationType: 'DEPLOYMENT', user: 'dev@panel.test',
  });
  const fresh = await runs.getRunOrThrow(runId);
  check('la checklist est posée DÈS la création', fresh.steps.length === CANONICAL_STEPS.length);
  check('…toutes les étapes en attente', fresh.steps.every((s) => s.status === 'pending'));
  check('…dans l’ordre du moteur',
    fresh.steps.map((s) => s.id).join() === CANONICAL_STEPS.map((s) => s.id).join());
  check('…avec des libellés MÉTIER, jamais des identifiants bruts',
    fresh.steps.every((s) => s.label && s.label !== s.id && !/\./.test(s.label)));
  check('l’avancement démarre à 0 %', fresh.progress.percent === 0);

  // ── LA CHECKLIST AVANCE ──────────────────────────────────────────────
  await runs.recordStep(runId, { id: 'deployment.initialize', status: 'ok', message: 'Prêt.' });
  await runs.recordStep(runId, { id: 'ssh.connect', status: 'running' });
  const midway = await runs.getRunOrThrow(runId);
  check('une étape terminée fait progresser l’avancement', midway.progress.done === 1);
  check('…et l’étape en cours est identifiable',
    midway.steps.find((s) => s.status === 'running')?.id === 'ssh.connect');
  check('…sans jamais dupliquer une étape', midway.steps.length === CANONICAL_STEPS.length);

  // ── ÉCHEC : LA SUITE EST « IGNORÉE », PAS « EN ATTENTE » ────────────
  await runs.recordStep(runId, { id: 'ssh.connect', status: 'error', errorCode: 'SSH_FAILED' });
  await runs.finalizeRun(runId, {
    status: 'error',
    summary: 'Déploiement échoué à l’étape « Connexion sécurisée au serveur ».',
    error: { code: 'SSH_FAILED', message: 'Authentification refusée.', step: 'ssh.connect' },
    markdownReport: '# Rapport\n\nVERDICT : ÉCHEC',
    structuredReport: { verdict: 'ÉCHEC' },
  });
  const failed = await runs.getRunOrThrow(runId);
  check('l’étape fautive reste en échec',
    failed.steps.find((s) => s.id === 'ssh.connect').status === 'error');
  check('les étapes jamais exécutées passent en IGNORÉES, pas en attente',
    failed.steps.filter((s) => s.status === 'pending').length === 0
    && failed.steps.filter((s) => s.status === 'skipped').length > 10);
  check('un rapport est produit MÊME en échec', failed.markdownReport.includes('VERDICT'));
  check('…et l’avancement est complet (plus rien n’adviendra)',
    failed.progress.percent === 100);

  await PanelDeploymentTarget.deleteMany({});
  await PanelDeploymentRun.deleteMany({});
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le rapport vient du MOTEUR, et les secrets du Panel y sont masqués');
{
  const source = read('services', 'deployment', 'deploymentExecutor.service.js');

  check('le déploiement passe par deployWithReport du moteur',
    /engine\.deployWithReport\(/.test(source));
  check('…et non par une orchestration réécrite dans le Panel',
    !/await engine\.preflight\([\s\S]{0,200}await engine\.deploy\(/.test(source));
  check('les événements du moteur alimentent la checklist',
    /onEvent:/.test(source) && /evt\.stepId/.test(source));
  check('les libellés d’étape viennent du catalogue canonique',
    /canonicalStep\(/.test(source));

  // Le redacteur du moteur amorce sur les secrets d'un projet vitrine. Le
  // Panel en a un de plus : BRIDGE_ENCRYPTION_KEY.
  check('un masquage complémentaire couvre les secrets propres au Panel',
    /buildPanelRedactor/.test(source) && /bridgeEncryptionKey/.test(source));
  check('…appliqué au markdown ET au rapport structuré',
    /redactPanelSecrets\(result\.markdownReport/.test(source)
    && /redactStructured\(/.test(source));
  check('…sans forker le cœur du moteur',
    /29_ENGINE_GOVERNANCE|identique dans les deux dépôts/.test(source));

  // Vérification EFFECTIVE du masquage, pas seulement de sa présence.
  const executor = await import('../backend/src/services/deployment/deploymentExecutor.service.js');
  const cfg = (await import('../backend/src/config/env.js')).default;
  const fakeEngine = {
    parseUrl: (url) => ({ host: new URL(url).hostname, canonicalUrl: url }),
    deployWithReport: async ({ onEvent }) => {
      onEvent({ type: 'step.started', stepId: 'artifact.build', label: 'Préparation', status: 'running' });
      onEvent({ type: 'step.succeeded', stepId: 'artifact.build', label: 'Préparation', status: 'ok' });
      return {
        ok: true, status: 'ok', version: 'abc1234',
        markdownReport: `# Rapport\nclé=${cfg.bridgeEncryptionKey}\nuri=${cfg.mongoUri}\n`,
        structuredReport: { secret: cfg.bridgeEncryptionKey, mongo: cfg.mongoUri },
      };
    },
  };

  const captured = [];
  const outcome = await executor.executeOperation({
    operationType: 'DEPLOYMENT',
    target: {
      targetId: 't', name: 'T', url: 'https://masquage.exemple.com', host: 'masquage.exemple.com',
      environment: 'TEST', sshHost: '1.2.3.4', sshUser: 'root', backendPort: 5100,
      remoteRoot: '/var/www', extraEnv: {},
    },
    sshPassword: 'secret-ssh',
    user: 'dev@panel.test',
    engine: fakeEngine,
    onStep: (s) => captured.push(s),
  });

  check('les étapes du moteur sont transcrites', captured.length === 2);
  check('la clé de chiffrement du pont est MASQUÉE dans le markdown',
    !outcome.markdownReport.includes(cfg.bridgeEncryptionKey));
  check('…et dans le rapport structuré',
    !JSON.stringify(outcome.structuredReport).includes(cfg.bridgeEncryptionKey));
  check('l’URI Mongo est masquée aussi',
    !outcome.markdownReport.includes(cfg.mongoUri));
  check('…et le mot de passe SSH n’apparaît nulle part',
    !JSON.stringify(outcome).includes('secret-ssh'));
  check('le rapport reste lisible après masquage',
    outcome.markdownReport.includes('# Rapport') && outcome.markdownReport.includes('«redacted»'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Base injoignable : un 503 qui EXPLIQUE, jamais un 500 opaque');
{
  // Le défaut réellement rencontré : MongoDB tombe pendant que le serveur
  // tourne. Mongoose met l'opération en tampon, elle expire au bout de dix
  // secondes, et l'opérateur voyait « Erreur interne » — indiscernable d'un
  // bogue applicatif, sans aucune piste pour corriger.
  const middleware = read('middlewares', 'error.middleware.js');

  check('une panne de base est reconnue et distinguée',
    /PANEL_DATABASE_UNAVAILABLE/.test(middleware));
  check('…rendue en 503, pas en 500', /status\(503\)/.test(middleware));
  check('…le tampon expiré de Mongoose est reconnu',
    /buffering timed out/i.test(middleware));
  check('…la sélection de serveur aussi',
    /ServerSelectionError/.test(middleware));
  check('…comme le refus de connexion', /ECONNREFUSED/.test(middleware));
  check('le message dit à l’opérateur QUOI vérifier',
    /MONGODB_URI/.test(middleware) && /MongoDB est démarré/.test(middleware));
  check('…et qu’il n’a rien fait de mal',
    /saisie n’est pas en cause/.test(middleware));
  check('la stack complète part dans les JOURNAUX, jamais dans la réponse',
    /logger\.error\(err\.stack\)/.test(middleware)
    && !/stack/.test(middleware.slice(middleware.indexOf('status(500)'))));

  // /health doit permettre de diagnostiquer sans deviner.
  const healthService = read('services', 'health', 'health.service.js');
  check('/health rapporte l’état de la base',
    /database: dbReady \? 'connected' : 'disconnected'/.test(healthService));
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

  // ── UN SEUL BOUTON DANS LE PARCOURS ─────────────────────────────────
  // C'est l'exigence centrale : l'opérateur exprime une intention, il ne
  // pilote pas le moteur étape par étape.
  const deployCard = targetPageSource.slice(
    targetPageSource.indexOf('<Card title="Déployer">'),
    targetPageSource.indexOf('Outils de diagnostic'),
  );
  // On COMPTE les boutons plutôt que d'extraire leurs libellés : un
  // gestionnaire `onClick` contient des accolades et des flèches qui rendent
  // toute extraction de texte fragile. Le nombre, lui, est sans ambiguïté.
  const buttonCount = (deployCard.match(/<button/g) ?? []).length;
  check(`le parcours principal n’expose qu’UN bouton (${buttonCount} trouvé(s))`,
    buttonCount === 1);
  // Le libellé dit l'INTENTION. Sur une destination vidée, cette intention
  // s'écrit « Redéployer » : c'est le seul chemin de retour depuis EMPTY, et
  // le nommer autrement laisserait croire à une première mise en ligne.
  check('…et ce bouton dit « Déployer » (ou « Redéployer » sur une destination vidée)',
    /'Redéployer' : 'Déployer'/.test(deployCard) || />\s*Déployer\s*</.test(deployCard));

  // ── LE RETRAIT (LOT 8) ──────────────────────────────────────────────
  // Deux actions, dans cet ordre. La seconde n'est active qu'après la
  // première : c'est la traduction visible de la règle « une destination
  // ACTIVE ne se supprime pas ».
  check('l’écran propose « Retirer le déploiement »',
    /Retirer le déploiement/.test(targetPageSource));
  check('…et « Supprimer la destination »',
    /Supprimer la destination/.test(targetPageSource));
  check('…la suppression n’est active QUE sur une destination vidée',
    /disabled=\{busy \|\| locked \|\| !t\.canDelete\}/.test(targetPageSource));
  check('…et le déploiement est bloqué pendant un retrait',
    /!t\.canDeploy/.test(targetPageSource));

  // La confirmation n'est PAS un `confirm()` : elle doit montrer ce qui sera
  // détruit — port, service, dossier, taille, médias — avant de demander.
  // Le motif exclut les mentions entre accents graves : le fichier EXPLIQUE
  // pourquoi il n'utilise pas `confirm()`, et cette explication ne doit pas
  // être confondue avec un appel.
  check('la confirmation passe par une fenêtre dédiée, jamais confirm()',
    /modal-backdrop/.test(targetPageSource)
    && !/window\.confirm\(/.test(targetPageSource)
    && !/[^A-Za-z0-9_.`]confirm\(/.test(targetPageSource));
  for (const champ of ['Nom d’hôte', 'Environnement', 'Serveur', 'Port applicatif',
    'Service PM2', 'Dossier', 'Taille', 'Fichiers', 'shared/uploads', 'shared/storage']) {
    check(`la fenêtre annonce « ${champ} »`, targetPageSource.includes(champ));
  }
  check('…et dit que l’opération est irréversible',
    /irréversible/.test(targetPageSource));
  check('la saisie EXACTE du nom d’hôte est exigée',
    /hostname\.trim\(\)\.toLowerCase\(\) === target\.host\.toLowerCase\(\)/.test(targetPageSource));
  check('…et le bouton reste inerte tant qu’elle ne correspond pas',
    /!hostOk/.test(targetPageSource));
  check('la perte de données persistantes exige une confirmation séparée',
    /persistentFiles/.test(targetPageSource) && /dropData/.test(targetPageSource));
  check('un lien symbolique sortant bloque le retrait à l’écran',
    /outboundSymlinks/.test(targetPageSource));
  check('l’état du cycle de vie est affiché', /LifecycleBadge/.test(targetPageSource));
  check('…et l’état « vidée » explique ce qu’il reste possible',
    /410 Gone|410/.test(targetPageSource) && /redéployée/.test(targetPageSource));

  check('les opérations techniques sont hors du parcours, repliées',
    /Disclosure title="Outils de diagnostic"/.test(targetPageSource));
  check('…et présentées comme facultatives',
    /le déploiement fait déjà tout cela/.test(targetPageSource));
  check('l’écran annonce que le déploiement enchaîne les étapes lui-même',
    /enchaîne automatiquement/.test(targetPageSource));

  const runPage = fs.readFileSync(path.join(front, 'pages', 'DeploymentRunPage.tsx'), 'utf8');

  // ── CHECKLIST, PROGRESSION, RAPPORT ─────────────────────────────────
  check('la checklist affiche chaque étape avec son état',
    /deploy-step deploy-\$\{step\.status\}/.test(runPage));
  check('…et distingue les six états',
    ['pending', 'running', 'ok', 'warning', 'error', 'skipped']
      .every((s) => new RegExp(`${s}:`).test(runPage)));
  check('une barre de progression est affichée', /deploy-progress-fill/.test(runPage));
  check('…animée tant que ça tourne', /deploy-spinner/.test(runPage));
  check('l’étape en cours reste visible à l’écran', /scrollIntoView/.test(runPage));

  check('un bouton copie le rapport COMPLET',
    /Copier le rapport complet/.test(runPage) && /clipboard\.writeText\(run\.markdownReport\)/.test(runPage));
  check('…et l’échec de copie ne perd pas le rapport',
    /sélectionnable/.test(runPage));

  const styles = fs.readFileSync(path.join(front, 'styles.css'), 'utf8');
  check('l’animation respecte prefers-reduced-motion',
    /prefers-reduced-motion[\s\S]{0,200}deploy-spinner/.test(styles));

  // Le suivi consomme un FLUX REPRENABLE : ni sondage, ni flux « à la SB Auto »
  // (qui mourrait au redémarrage du backend en auto-déploiement).
  check('le suivi n’effectue plus AUCUN sondage',
    !/setInterval/.test(runPage));
  check('…il ouvre un flux reprenable',
    /streamRun\(/.test(runPage) && /for await/.test(runPage));
  check('…avec un curseur de reprise (dernier seq traité)',
    /lastSeqRef/.test(runPage) && /evt\.seq/.test(runPage));
  check('…et se reconnecte après coupure sans repartir de zéro',
    /RECONNECT_MS/.test(runPage) && /AbortController/.test(runPage));
  check('…en ne créant JAMAIS de ligne absente de la checklist',
    /n’en crée jamais|ne crée jamais/.test(runPage) || /i === -1\) return prev/.test(runPage));
  check('…et sans repeindre quand rien n’a changé',
    /return prev;/.test(runPage));
  check('…la divergence avec SB Auto 06 est JUSTIFIÉE dans le code',
    /auto-déploiement/.test(runPage) && /NDJSON/.test(runPage));
  check('…et distingue « backend absent » d’une vraie erreur',
    /unreachable/.test(runPage));
  check('…en expliquant que c’est attendu pendant un auto-déploiement',
    /redémarre/.test(runPage));

  const routes = [...apiClient.matchAll(/['"`](\/api\/deployment[^'"`\n]*)/g)]
    .map((m) => m[1].replace(/\$\{[^}$]*\}/g, ':id').split(/[?$]/)[0]);
  const known = [
    '/api/deployment', '/api/deployment/self', '/api/deployment/runs',
    '/api/deployment/runs/:id', '/api/deployment/runs/:id/stream',
    '/api/deployment/targets', '/api/deployment/targets/:id',
    '/api/deployment/targets/:id/test-connection', '/api/deployment/targets/:id/preflight',
    '/api/deployment/targets/:id/simulate', '/api/deployment/targets/:id/deploy',
    '/api/deployment/targets/:id/rollback', '/api/deployment/targets/:id/releases',
    // Cycle de vie de la destination (LOT 8) : inventaire avant retrait,
    // retrait, suppression définitive de la fiche.
    '/api/deployment/targets/:id/inspect', '/api/deployment/targets/:id/deprovision',
    '/api/deployment/targets/:id/delete',
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
