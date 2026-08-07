/**
 * PIPELINE UNIQUE de déploiement.
 *
 * Build → Upload → Création dossiers → Nginx → Let's Encrypt → Reload → PM2 →
 * Health Check → Validation.
 *
 * Une seule implémentation, aucun doublon (cahier des charges §6). Chaque étape
 * est chronométrée et émet un évènement via `onStep`, ce qui alimente
 * l'historique et les logs de la cible. À la moindre erreur bloquante, le
 * pipeline s'arrête (pas de demi-déploiement) et rapporte l'étape fautive.
 *
 * Le pipeline ne dépend QUE du Transport : il est testable de bout en bout avec
 * un FakeTransport, sans VPS.
 */
import { applyNginxConfig, applyNginxHttpOnly, deriveApiHost } from './nginx.js';
import { ensureCertificate } from './certbot.js';
import { pm2AppName, restartBackend } from './pm2.js';
import { checkLocalHealth, checkPublicHealth, collectBackendDiagnostics, checkPublicMedia, checkApiHealth, checkWebsiteArtifact } from './health.js';
import { deriveNetworkUrls, describeRuntimeConfig } from './runtimeConfig.js';
import { migrateUploads } from './uploads.js';
import { planTopology } from './topology.js';
import { DeploymentError } from './errors.js';
import { REQUIRED_REMOTE_ENV } from './config/project.profile.js';

/** Étapes ordonnées du pipeline (identité stable pour l'UI et l'historique). */
export const PIPELINE_STEPS = [
  'upload',
  'dirs',
  'uploads_migrate',
  // La reprise des médias EXISTANTS suit immédiatement leur migration : c'est
  // le premier instant où les octets sont tous réunis sur la destination.
  'project_media_adopt',
  'nginx',
  'certbot',
  'reload',
  'pm2',
  'health',
  'media_publish',
  // L'ordre de cette liste est celui de l'EXÉCUTION : elle alimente l'affichage
  // et l'historique. `runtime_config` publie, `validate` constate — publier ne
  // peut pas précéder constater, ici comme dans le corps du pipeline.
  'validate',
  'runtime_config',
];

/**
 * @param {object} args
 * @param {import('./transport/Transport.js').Transport} args.transport
 * @param {object} args.target        Résultat de parseTargetUrl.
 * @param {object} args.artifact      { vitrineDist, managerDist, backendDir } (chemins locaux).
 * @param {object} args.options
 * @param {string} args.options.remoteRoot     Racine de déploiement sur le VPS (déf. /var/www).
 * @param {number} args.options.backendPort    Port local d'écoute du backend.
 * @param {'PROD'|'TEST'} [args.options.env]   ENV applicatif (déf. PROD).
 * @param {string} [args.options.email]         Email Let's Encrypt.
 * @param {Object<string,string>} [args.options.remoteEnv] Variables à écrire dans backend/.env (jamais le mot de passe VPS).
 * @param {string} args.version       Version déployée (SHA).
 * @param {(evt:object)=>void} [args.onStep]
 * @returns {Promise<{ok:boolean, steps:object[], version:string, durationMs:number, failedStep:string|null}>}
 */
export async function runPipeline({ transport, target, artifact, options, version, onStep = () => {} }) {
  const {
    remoteRoot = '/var/www',
    backendPort,
    env = 'PROD',
    email,
    remoteEnv,
    health = {},
  } = options || {};
  const healthLocalOpts = { retries: health.localRetries, delayMs: health.localDelayMs };
  const healthPublicOpts = { retries: health.publicRetries, delayMs: health.publicDelayMs };

  // TOPOLOGIE : tout ce qui suit (racines distantes, hôtes, certificats,
  // healthchecks) est dérivé du PROFIL. Le pipeline ne nomme aucune application.
  const topo = planTopology({ host: target.host, remoteRoot, profile: options?.profile });
  const host = topo.host;
  const apiHost = deriveApiHost(host, topo.apiHost);
  const siteRoot = topo.siteRoot;
  const backendDir = topo.backendDir;

  const steps = [];
  const pipelineStart = clock();
  let failedStep = null;

  /** Exécute une étape chronométrée ; propage l'échec en arrêtant le pipeline. */
  const step = async (name, label, fn) => {
    const started = clock();
    const evt = { step: name, label, status: 'running', startedAt: new Date().toISOString() };
    onStep({ ...evt });
    try {
      const detail = await fn();
      const durationMs = clock() - started;
      const done = { step: name, label, status: 'ok', durationMs, detail: detail ?? null };
      steps.push(done);
      onStep({ ...done });
      return detail;
    } catch (err) {
      const durationMs = clock() - started;
      const failed = {
        step: name,
        label,
        status: 'error',
        durationMs,
        error: { code: err.code || 'ERROR', message: err.message },
      };
      steps.push(failed);
      onStep({ ...failed });
      failedStep = name;
      throw err;
    }
  };

  try {
    // Répertoire PARTAGÉ PERSISTANT (survit aux redéploiements) : médias + PDF.
    const sharedRoot = topo.sharedRoot;
    const sharedUploads = topo.sharedUploads;

    // 1. Upload de l'artefact (dist vitrine, dist manager, backend) + médias runtime.
    //
    // Les DEUX SPA statiques sont publiés de façon ATOMIQUE : upload vers un
    // dossier NEUF (`.next`) puis bascule par `mv`. Deux garanties :
    //   - PURGE : plus d'accumulation d'anciens /assets/*.js (servis « immutable »)
    //     qui maintenaient en vie un index.html périmé mis en cache ;
    //   - pas de fenêtre où l'ancien index.html côtoie les nouveaux assets
    //     (uploadDir SFTP écrase fichier par fichier, sans jamais supprimer).
    // L'ancienne version reste disponible en `.prev` (filet de retour arrière).
    await step('upload', 'Upload de l’artefact', async () => {
      // Une entrée par application PUBLIÉE du profil — jamais deux slots figés.
      // Chaque application doit avoir un dist construit : sinon le profil et
      // l'artefact sont incohérents, et on le dit ici plutôt que d'uploader du vide.
      const publications = topo.publishable.map((app) => {
        const localDir = artifact.dists?.[app.id];
        if (!localDir) {
          throw new DeploymentError('ARTIFACT_APP_MISSING', `Aucun artefact construit pour l’application « ${app.id} » déclarée au profil.`, {
            step: 'upload', details: { appId: app.id, role: app.role, built: Object.keys(artifact.dists || {}) },
          });
        }
        return { app, localDir, target: app.remoteRoot, next: `${app.remoteRoot}.next`, prev: `${app.remoteRoot}.prev` };
      });

      const nextDirs = publications.map((p) => p.next).join(' ');
      await transport.exec(`rm -rf ${nextDirs} && mkdir -p ${nextDirs} ${backendDir} ${sharedUploads} ${sharedRoot}/storage/contracts /var/www/certbot`);

      const filesByApp = {};
      for (const p of publications) {
        const r = await transport.uploadDir(p.localDir, p.next);
        filesByApp[p.app.id] = r.files;
      }
      const b = await transport.uploadDir(artifact.backendDir, backendDir);

      // Bascule ATOMIQUE application par application : purge des anciens assets
      // (plus d'index.html périmé servi en cache) et `.prev` de secours.
      const swap = [
        `rm -rf ${publications.map((p) => p.prev).join(' ')}`,
        ...publications.flatMap((p) => [
          `if [ -d ${p.target} ]; then mv ${p.target} ${p.prev}; fi`,
          `mv ${p.next} ${p.target}`,
        ]),
      ].join(' && ');
      await transport.exec(swap);

      // Synchronise les médias vers le PARTAGÉ persistant (noms uniques → aucun
      // écrasement de contenu uploadé sur le site déployé).
      let uploadsFiles = 0;
      if (artifact.uploadsDir) {
        const u = await transport.uploadDir(artifact.uploadsDir, sharedUploads).catch(() => ({ files: 0 }));
        uploadsFiles = u.files || 0;
      }
      return { filesByApp, backendFiles: b.files, uploadsFiles };
    });

    // 2. Liaison des dossiers runtime du backend vers le PARTAGÉ + .env (sans secret VPS).
    await step('dirs', 'Préparation des dossiers & configuration', async () => {
      // Le backend sert /uploads et écrit ses PDF : ses dossiers pointent vers le
      // partagé persistant (symlink), de sorte que les médias survivent aux
      // redéploiements et restent servis par express.static.
      await transport.exec(`rm -rf ${backendDir}/uploads ${backendDir}/storage && ln -sfn ${sharedUploads} ${backendDir}/uploads && ln -sfn ${sharedRoot}/storage ${backendDir}/storage`);
      await transport.exec(`mkdir -p ${sharedRoot}/storage/contracts /var/www/certbot`);

      // SANS .env complet, le backend SORT au démarrage (« Missing MONGODB_URI »)
      // et l'échec n'apparaît que 2 étapes plus loin (health). Quand une config
      // distante est fournie (toujours le cas en production), on l'écrit PUIS on la
      // RELIT depuis le disque du VPS (source de vérité) pour VÉRIFIER que les clés
      // critiques ont atterri — échec explicite et localisé ici, jamais un health
      // mystérieux.
      let envKeys = null;
      if (remoteEnv && Object.keys(remoteEnv).length) {
        const envContent = Object.entries(remoteEnv)
          .map(([k, val]) => `${k}=${val}`)
          .join('\n');
        await transport.writeFile(`${backendDir}/.env`, `${envContent}\n`);

        // Relecture : ce qui est RÉELLEMENT sur le disque (NOMS de clés seulement,
        // jamais les valeurs). Confirme MONGODB_URI & co présents ET non vides.
        const readback = await transport.readFile(`${backendDir}/.env`).catch(() => '');
        const parsed = {};
        for (const line of readback.split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
          if (m) parsed[m[1]] = m[2];
        }
        envKeys = Object.keys(parsed);
        // LA LISTE VIENT DU PROFIL — comme dans `deployEnv.js`. Elle était codée
        // en dur sur les besoins d'un projet vitrine (INTEGRATED_API_ENCRYPTION_KEY),
        // que le Panel n'a pas et n'aura jamais : il exige BRIDGE_ENCRYPTION_KEY.
        // `__DB_FOR_ENV__` est le marqueur du profil pour « la base de cet ENV ».
        const dbKey = String(env).toUpperCase() === 'PROD' ? 'DB_PROD' : 'DB_TEST';
        const required = REQUIRED_REMOTE_ENV.map((k) => (k === '__DB_FOR_ENV__' ? dbKey : k));
        const emptyOrMissing = required.filter((k) => !parsed[k] || !String(parsed[k]).trim());
        if (emptyOrMissing.length) {
          const { DeploymentError } = await import('./errors.js');
          throw new DeploymentError('ENV_WRITE_INCOMPLETE', `Le .env distant est incomplet après écriture : ${emptyOrMissing.join(', ')} absent(s) ou vide(s).`, {
            step: 'dirs',
            details: { present: envKeys, emptyOrMissing, bytes: readback.length },
          });
        }
      }

      // VÉRIFICATION DE VERSION (LOT 5) : le manifeste RÉELLEMENT uploadé doit
      // correspondre au commit construit localement — sinon on a envoyé une autre
      // photographie que celle annoncée. Refus explicite avant tout démarrage.
      if (artifact.manifest?.commitHash) {
        const remoteManifestRaw = await transport.readFile(`${backendDir}/build-manifest.json`).catch(() => '');
        let remoteCommit = null;
        try { remoteCommit = JSON.parse(remoteManifestRaw)?.commitHash || null; } catch { /* absent/illisible */ }
        if (remoteCommit !== artifact.manifest.commitHash) {
          const { DeploymentError } = await import('./errors.js');
          throw new DeploymentError('DEPLOY_ARTIFACT_VERSION_MISMATCH', `Manifeste distant (${remoteCommit ? remoteCommit.slice(0, 7) : 'absent'}) ≠ commit construit (${artifact.manifest.shortCommit}).`, {
            step: 'dirs', details: { local: artifact.manifest.shortCommit, remote: remoteCommit ? remoteCommit.slice(0, 7) : null },
          });
        }
      }

      // Dépendances backend de production.
      await transport.exec(`cd ${backendDir} && npm ci --omit=dev`, { timeoutMs: 300_000 });
      return { backendDir, envKeys, commit: artifact.manifest?.shortCommit || null, branch: artifact.manifest?.branch || null };
    });

    /**
     * 3. MÉDIAS PERSISTANTS D'UN EMPLACEMENT ANTÉRIEUR — avant toute validation.
     *
     * ── LE DÉFAUT CORRIGÉ ─────────────────────────────────────────────────
     * Quand un projet change de domaine, sa base le suit mais ses médias
     * restent sur le disque de l'ancienne destination. La nouvelle vitrine
     * référençait des fichiers absents et répondait 404 sur chacun.
     *
     * La source n'est PAS cherchée ici : elle est fournie par l'appelant, qui
     * la tire de l'historique des emplacements du projet. Le moteur ne scanne
     * jamais `/var/www/*` et ne rapproche jamais deux destinations par leur
     * nom de domaine, leur base ou leur serveur — deux projets distincts
     * peuvent partager les trois.
     *
     * Placée AVANT `validate` : le contrôle des médias publics doit constater
     * l'état final, migration comprise. En l'absence de capacité injectée
     * (façade, test), l'étape est neutre.
     */
    await step('uploads_migrate', 'Migration des médias persistants', async () => {
      if (typeof options.resolveUploadsSources !== 'function') {
        return { skipped: true, reason: 'non configuré (façade/test)' };
      }
      const plan = await options.resolveUploadsSources({ host, siteRoot, sharedUploads });
      if (!plan || !plan.identityId) {
        return { skipped: true, reason: 'aucune identité de projet déclarée' };
      }
      return migrateUploads(transport, {
        destination: sharedUploads,
        identityId: plan.identityId,
        sources: plan.sources || [],
        remoteRoot,
      });
    });

    /**
     * 3bis. REPRISE DES MÉDIAS EXISTANTS DE L'APPLICATION — sur la destination.
     *
     * ── LE CAS RÉEL, ET IL EST LE PLUS FRÉQUENT ───────────────────────────
     * Un projet en service depuis des mois n'a AUCUN descripteur : ses fiches
     * ne portent qu'un chemin (`/uploads/img-1783953966067-898120780.webp`),
     * et les octets correspondants ne vivent nulle part ailleurs que dans le
     * `shared/uploads` de la destination. Le poste qui déploie, lui, n'a qu'un
     * `.gitkeep`. Toute reprise conduite depuis ce poste inventorierait donc
     * du vide, et conclurait qu'il n'y a rien à reprendre.
     *
     * L'étape s'exécute là où sont les FICHIERS. Le moteur ne sait pas les
     * reconnaître — quel champ les référence, sous quel type métier — et cette
     * connaissance appartient à l'application : d'où une capacité injectée.
     * Le moteur n'importe aucun modèle de média, ici comme ailleurs.
     *
     * ── PLACÉE ICI, ET NULLE PART AILLEURS ────────────────────────────────
     * APRÈS `uploads_migrate` : les médias d'un emplacement antérieur viennent
     * d'arriver, et une reprise qui les manquerait devrait être rejouée.
     * AVANT `media_publish` : la publication ne voit que ce qui est décrit.
     * AVANT `validate` : le contrôle public constate l'état FINAL.
     *
     * En l'absence de capacité injectée (façade, test, application sans
     * médias), l'étape est neutre — jamais bloquante.
     */
    await step('project_media_adopt', 'Reprise des médias existants', async () => {
      if (typeof options.adoptApplicationMedia !== 'function') {
        return { skipped: true, reason: 'non configuré (façade/test)' };
      }
      return options.adoptApplicationMedia({
        transport, backendDir, sharedUploads, siteRoot, host, env,
      });
    });

    // 4. Configuration Nginx PHASE HTTP — sert le challenge ACME (HTTP-01) et le
    //    site en HTTP. Écrase toute config précédente (même invalide). Indispensable
    //    AVANT certbot : la config HTTPS référence des certificats pas encore émis.
    // Racines et hôtes servis : une entrée par application du profil.
    const nginxOpts = { roots: topo.roots, hosts: topo.hosts, backendPort, apiHost, profile: options?.profile };
    let nginxResult;
    await step('nginx', 'Configuration du routage web', async () => {
      nginxResult = await applyNginxHttpOnly(transport, target, nginxOpts);
      return { ...nginxResult, siteServerName: host, servedHosts: topo.servedHosts, apiServerName: apiHost };
    });

    // 5. Certificat TLS : hôte principal (wildcard ou dédié) + CHAQUE hôte dérivé
    //    du profil (jamais couvert par un wildcard à un niveau) via HTTP-01.
    //    Nginx sert déjà le challenge sur le port 80 (phase HTTP ci-dessus).
    await step('certbot', 'Certificat HTTPS', async () =>
      ensureCertificate(transport, target, { email, dedicatedHosts: topo.dedicatedCertHosts })
    );

    // 6. Configuration Nginx PHASE HTTPS complète — les certificats existent
    //    désormais : `nginx -t` passe, on bascule le site en HTTPS puis on recharge.
    await step('reload', 'Activation HTTPS', async () => applyNginxConfig(transport, target, nginxOpts));

    /**
     * 7. (Re)démarrage backend via PM2.
     *
     * ── DEUX CAPACITÉS INJECTÉES, ET POURQUOI ─────────────────────────────
     * Le moteur sait ce que le SERVEUR dit d'un port (sockets, process PM2).
     * Il ne sait rien du REGISTRE de l'application qui l'embarque : quelle
     * autre destination a réservé ce port, depuis quand, pour quel projet.
     * Or c'est cette information-là qui manquait le jour où un port a été
     * réattribué alors qu'un ancien service le détenait encore.
     *
     * `beforeServiceStart` laisse donc l'appelant opposer son registre juste
     * avant le démarrage — le seul moment où la question a un sens, puisque
     * le serveur a pu changer depuis la réservation. `afterServiceStarted`
     * lui rend la preuve (PID, statut, propriété de la socket) pour qu'il
     * n'inscrive « actif » qu'après constat.
     *
     * En l'absence de ces capacités (façade, test, projet qui n'a pas de
     * registre), l'étape est strictement celle d'avant.
     */
    let pm2Info;
    await step('pm2', 'Redémarrage du backend (PM2)', async () => {
      const pm2Name = pm2AppName(host);
      if (typeof options.beforeServiceStart === 'function') {
        await options.beforeServiceStart({ transport, host, port: backendPort, pm2Name });
      }
      pm2Info = await restartBackend(transport, { host, backendDir, port: backendPort, env, health: options.health });
      if (typeof options.afterServiceStarted === 'function') {
        await options.afterServiceStarted({ ...pm2Info, host, port: backendPort });
      }
      return pm2Info;
    });

    // 8. Health check LOCAL (le backend PM2 répond sur son port).
    let health = {};
    await step('health', 'Health check', async () => {
      const local = await checkLocalHealth(transport, backendPort, healthLocalOpts);
      if (!local.ok) {
        // Le backend a démarré (PM2) mais ne répond pas : on capture SA cause
        // (statut PM2 + logs) pour que le rapport montre POURQUOI (Mongo/env/exit).
        const diag = await collectBackendDiagnostics(transport, { name: pm2Info?.name });
        const { DeploymentError } = await import('./errors.js');
        throw new DeploymentError('HEALTH_LOCAL_FAILED', 'Le backend ne répond pas en local après démarrage.', {
          step: 'health',
          details: { pm2Status: diag.status, restarts: diag.restarts, logTail: diag.logTail },
        });
      }
      health.local = local;
      return { local };
    });

    /**
     * 8bis. PUBLICATION DES MÉDIAS DE L'APPLICATION — avant la validation.
     *
     * ── LE PROBLÈME QU'ELLE FERME ─────────────────────────────────────────
     * Une instance se configure AVANT d'être déployée : on y importe un logo,
     * des portraits, alors qu'aucune destination ne les sert encore. Ces
     * médias existent en local et nulle part ailleurs. Sans cette étape, le
     * premier déploiement rendait le site en ligne avec des images absentes —
     * et il fallait tout réimporter depuis l'interface déployée.
     *
     * Ce que le moteur peut faire seul, il l'a déjà fait : les fichiers sont
     * transférés à l'étape `uploads`. Ce qu'il ne peut PAS savoir, c'est
     * QUELS médias la fiche métier référence, ni sous quelle empreinte. Cette
     * connaissance appartient à l'application — d'où une capacité injectée.
     *
     * Placée AVANT `validate` : la validation contrôle les médias publics et
     * doit constater l'état FINAL. Placée APRÈS `health` : la vérification
     * lit le disque distant, ce qui n'a de sens qu'une fois le déploiement
     * matériellement en place.
     *
     * En l'absence de capacité injectée (façade, test, projet sans médias),
     * l'étape est neutre — jamais bloquante.
     */
    await step('media_publish', 'Publication des médias de la fiche', async () => {
      if (typeof options.publishApplicationMedia !== 'function') {
        return { skipped: true, reason: 'non configuré (façade/test)' };
      }
      return options.publishApplicationMedia({ transport, sharedUploads, host, env });
    });

    // 9. Validation finale : CHAQUE application publiée répond en HTTPS + bon ENV.
    await step('validate', 'Validation', async () => {
      const pub = await checkPublicHealth(transport, host, healthPublicOpts);
      health.public = pub;
      // Santé publique de chaque hôte dérivé du profil (hors hôte principal,
      // déjà couvert par `pub`).
      health.appPublic = {};
      for (const app of topo.publishable.filter((a) => !a.isPrimaryHost)) {
        health.appPublic[app.id] = await checkPublicHealth(transport, app.host, healthPublicOpts);
      }
      if (!pub?.ok) {
        const { DeploymentError } = await import('./errors.js');
        throw new DeploymentError('HEALTH_PUBLIC_FAILED', 'Le site ne répond pas en HTTPS après déploiement.', {
          step: 'validate',
        });
      }
      if (pub.env && pub.env !== env) {
        const { DeploymentError } = await import('./errors.js');
        throw new DeploymentError('ENV_MISMATCH', `ENV publié (${pub.env}) ≠ attendu (${env}).`, { step: 'validate' });
      }
      // Test FONCTIONNEL des médias : une ressource publique ne doit contenir
      // AUCUNE URL d'upload locale/non sûre — sinon les images sont cassées en
      // HTTPS. Un tel état ne doit PAS être déclaré « Healthy ».
      // Les médias sont vérifiés depuis CHAQUE origine servie : un front charge
      // ses médias relativement à sa propre origine.
      const media = await checkPublicMedia(transport, host, { origins: topo.publishable.map((a) => ({ label: a.id, host: a.host })) });
      health.media = media;
      if (media.reachable && !media.ok) {
        const { DeploymentError } = await import('./errors.js');
        if (media.localHits.length) {
          throw new DeploymentError('MEDIA_STILL_LOCAL', 'Des médias pointent encore vers une URL locale/non sécurisée (Mixed Content).', {
            step: 'validate', details: { sample: media.localHits },
          });
        }
        const broken = (media.checked || []).filter((c) => !c.ok).map((c) => {
          const per = Object.entries(c.origins || {}).map(([label, r]) => `${label}=${r.code}/${r.mime || '-'}`).join(', ');
          return `${c.path} (${per})`;
        });
        throw new DeploymentError('MEDIA_UNREACHABLE', `Des médias essentiels ne se téléchargent pas (HTTP/MIME) : ${broken.slice(0, 4).join(' · ')}.`, {
          step: 'validate', details: { broken: broken.slice(0, 8), brokenCount: media.brokenCount },
        });
      }
      // Healthcheck du domaine API dédié. Un 502/504 (proxy cassé) ou un ENV
      // divergent est bloquant ; simplement injoignable (DNS/cert pas encore
      // propagés) est NON bloquant — le site fonctionne en même origine.
      const api = await checkApiHealth(transport, apiHost, { expectedEnv: env });
      health.api = api;
      if (api.reachable && api.proxyError) {
        const { DeploymentError } = await import('./errors.js');
        throw new DeploymentError('API_PROXY_FAILED', `Le domaine API répond ${api.code} (proxy vers le backend cassé).`, { step: 'validate', details: { apiHost, code: api.code } });
      }
      if (api.envMismatch) {
        const { DeploymentError } = await import('./errors.js');
        throw new DeploymentError('API_ENVIRONMENT_MISMATCH', `ENV du domaine API (${api.env}) ≠ attendu (${env}).`, { step: 'validate', details: { apiHost } });
      }

      // Contrôle d'ARTEFACT WEB : le SPA réellement servi (index.html + JS d'entrée
      // + commit de /version.json) doit correspondre BIT POUR BIT à l'artefact
      // construit. Attrape le cas « le serveur renvoie encore une ancienne
      // version » avant de valider.
      //
      // FAIL-CLOSED en PROD : une empreinte manquante neutraliserait le contrôle
      // (skipped) — on refuse donc de déclarer un déploiement PROD réussi sans
      // avoir PU prouver que CHAQUE front servi est bien celui construit. La
      // liste des fronts à prouver vient du profil, pas de deux noms figés.
      const fingerprinted = topo.publishable.map((app) => ({ app, fp: artifact.web?.[app.id] }));
      const unproven = fingerprinted.filter(({ fp }) => !fp?.indexHash).map(({ app }) => app.id);
      if (String(env).toUpperCase() === 'PROD' && unproven.length) {
        const { DeploymentError } = await import('./errors.js');
        throw new DeploymentError('WEBSITE_FINGERPRINT_MISSING', `Empreinte web absente de l’artefact pour : ${unproven.join(', ')} (index.html non fingerprinté) : impossible de PROUVER que le site servi correspond au build. Déploiement PROD refusé.`, {
          step: 'validate',
          details: { unproven, fingerprinted: fingerprinted.filter(({ fp }) => fp?.indexHash).map(({ app }) => app.id) },
        });
      }
      const expectedCommit = artifact.manifest?.commitHash || null;
      const withCommit = (fp) => (fp && expectedCommit ? { ...fp, commitHash: expectedCommit } : fp);
      health.webArtifact = {};
      for (const { app, fp } of fingerprinted) {
        const w = await checkWebsiteArtifact(transport, app.host, withCommit(fp), { label: app.id });
        health.webArtifact[app.id] = w;
        if (w.reachable && !w.ok && !w.skipped) {
          const { DeploymentError } = await import('./errors.js');
          throw new DeploymentError('WEBSITE_ARTIFACT_MISMATCH', `Le front « ${app.id} » servi ne correspond pas à l'artefact construit (index ${w.indexMatch ? 'ok' : 'divergent'}, JS ${w.jsMatch ? 'ok' : 'divergent'}, version ${w.versionMatch ? 'ok' : 'divergente'}) — probable cache/ancienne version.`, {
            step: 'validate',
            details: { appId: app.id, host: app.host, expectedIndex: w.expectedIndexHash?.slice(0, 12), remoteIndex: w.remoteIndexHash?.slice(0, 12), expectedJs: w.expectedJs, expectedCommit: w.expectedCommit?.slice(0, 12), remoteCommit: w.remoteCommit?.slice(0, 12) },
          });
        }
      }

      return {
        url: target.canonicalUrl,
        apiUrl: `https://${apiHost}`,
        env: pub.env,
        siteHttp: pub.httpCode,
        // Une entrée par application publiée — le rapport suit le profil.
        apps: Object.fromEntries(topo.publishable.map((app) => [app.id, {
          url: `https://${app.host}`,
          http: app.isPrimaryHost ? pub.httpCode : (health.appPublic?.[app.id]?.httpCode ?? null),
          reachable: app.isPrimaryHost ? pub.ok === true : health.appPublic?.[app.id]?.ok === true,
        }])),
        // « ok » ne vaut que si une sonde a RÉELLEMENT été exécutée.
        mediaOk: media.probed && media.reachable ? media.ok : null,
        mediaProbe: !media.probed ? 'aucune sonde déclarée au profil' : (media.reachable ? 'vérifiée' : 'sonde injoignable'),
        apiReachable: api.reachable,
        apiHttp: api.code,
      };
    });

    /**
     * 10. CONFIGURATION RÉSEAU CANONIQUE — APRÈS la validation, jamais avant.
     *
     * ── LE DÉFAUT CORRIGÉ ─────────────────────────────────────────────────
     * Cette étape s'exécutait AVANT les healthchecks publics. Un déploiement
     * qui échouait ensuite avait donc déjà réécrit la configuration réseau
     * partagée : l'ANCIENNE destination, restée saine, se mettait à pointer
     * vers le nouveau backend en échec. Une vitrine qui fonctionnait était
     * cassée par un déploiement qui, lui, n'a jamais abouti.
     *
     * Écrire une configuration canonique est un acte de PUBLICATION : il ne
     * peut venir qu'après avoir constaté que la nouvelle destination est
     * saine. Rien, dans les contrôles publics, n'en dépend — ils interrogent
     * les hôtes de la topologie, pas la configuration en base.
     *
     * Écrite dans la base de la DESTINATION (jamais celle du moteur). Capacité
     * injectée par le contrôleur ; en son absence, l'étape est neutre.
     */
    await step('runtime_config', 'Synchronisation de la configuration réseau', async () => {
      if (typeof options.runtimeConfigSync !== 'function') return { skipped: true, reason: 'non configuré (façade/test)' };
      const dbName = String(env).toUpperCase() === 'PROD' ? remoteEnv?.DB_PROD : remoteEnv?.DB_TEST;
      // backendUrl = URL API CANONIQUE (https://api.<host>) — le domaine API
      // dédié a été configuré, certifié ET validé plus haut.
      const urls = deriveNetworkUrls({ siteHost: host, apiHost, topology: topo });
      const res = await options.runtimeConfigSync({ mongoUri: remoteEnv?.MONGODB_URI, dbName, urls, requirePublic: true });
      return describeRuntimeConfig(res);
    });

    return { ok: true, steps, version, durationMs: clock() - pipelineStart, failedStep: null };
  } catch (err) {
    return {
      ok: false,
      steps,
      version,
      durationMs: clock() - pipelineStart,
      failedStep,
      error: { code: err.code || 'ERROR', message: err.message },
    };
  }
}

function clock() {
  // process.hrtime.bigint est monotone et disponible partout ; pas Date.now.
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export default runPipeline;
