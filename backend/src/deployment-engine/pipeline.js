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
import { restartBackend } from './pm2.js';
import { checkLocalHealth, checkPublicHealth, collectBackendDiagnostics, checkPublicMedia, checkApiHealth, checkWebsiteArtifact } from './health.js';
import { deriveNetworkUrls, describeRuntimeConfig } from './runtimeConfig.js';
import { deriveManagerHost } from './hostnames.js';

/** Étapes ordonnées du pipeline (identité stable pour l'UI et l'historique). */
export const PIPELINE_STEPS = [
  'upload',
  'dirs',
  'nginx',
  'certbot',
  'reload',
  'pm2',
  'health',
  'runtime_config',
  'validate',
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

  const host = target.host;
  const managerHost = deriveManagerHost(host);
  const apiHost = deriveApiHost(host);
  const siteRoot = `${remoteRoot}/${host}`;
  const webRoot = `${siteRoot}/vitrine`;
  const managerRoot = `${siteRoot}/manager`;
  const backendDir = `${siteRoot}/backend`;

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
    const sharedRoot = `${siteRoot}/shared`;
    const sharedUploads = `${sharedRoot}/uploads`;

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
      const webNext = `${webRoot}.next`;
      const managerNext = `${managerRoot}.next`;
      await transport.exec(`rm -rf ${webNext} ${managerNext} && mkdir -p ${webNext} ${managerNext} ${backendDir} ${sharedUploads} ${sharedRoot}/storage/contracts /var/www/certbot`);
      const v = await transport.uploadDir(artifact.vitrineDist, webNext);
      const m = await transport.uploadDir(artifact.managerDist, managerNext);
      const b = await transport.uploadDir(artifact.backendDir, backendDir);
      await transport.exec(
        `rm -rf ${webRoot}.prev ${managerRoot}.prev` +
        ` && if [ -d ${webRoot} ]; then mv ${webRoot} ${webRoot}.prev; fi` +
        ` && mv ${webNext} ${webRoot}` +
        ` && if [ -d ${managerRoot} ]; then mv ${managerRoot} ${managerRoot}.prev; fi` +
        ` && mv ${managerNext} ${managerRoot}`
      );
      // Synchronise les médias vers le PARTAGÉ persistant (noms uniques → aucun
      // écrasement de contenu uploadé sur le site déployé).
      let uploadsFiles = 0;
      if (artifact.uploadsDir) {
        const u = await transport.uploadDir(artifact.uploadsDir, sharedUploads).catch(() => ({ files: 0 }));
        uploadsFiles = u.files || 0;
      }
      return { vitrineFiles: v.files, managerFiles: m.files, backendFiles: b.files, uploadsFiles };
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
        const dbKey = String(env).toUpperCase() === 'PROD' ? 'DB_PROD' : 'DB_TEST';
        const required = ['ENV', 'MONGODB_URI', dbKey, 'JWT_SECRET', 'INTEGRATED_API_ENCRYPTION_KEY'];
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

    // 3. Configuration Nginx PHASE HTTP — sert le challenge ACME (HTTP-01) et le
    //    site en HTTP. Écrase toute config précédente (même invalide). Indispensable
    //    AVANT certbot : la config HTTPS référence des certificats pas encore émis.
    let nginxResult;
    await step('nginx', 'Configuration du routage web', async () => {
      nginxResult = await applyNginxHttpOnly(transport, target, { webRoot, managerRoot, backendPort, managerHost, apiHost });
      return { ...nginxResult, siteServerName: host, managerServerName: managerHost, apiServerName: apiHost };
    });

    // 4. Certificat TLS : vitrine (wildcard ou dédié) + Manager + API (dédiés) via HTTP-01.
    //    Nginx sert déjà le challenge sur le port 80 (phase HTTP ci-dessus).
    await step('certbot', 'Certificat HTTPS', async () => ensureCertificate(transport, target, { email, managerHost, apiHost }));

    // 5. Configuration Nginx PHASE HTTPS complète — les certificats existent
    //    désormais : `nginx -t` passe, on bascule le site en HTTPS puis on recharge.
    await step('reload', 'Activation HTTPS', async () =>
      applyNginxConfig(transport, target, { webRoot, managerRoot, backendPort, managerHost, apiHost })
    );

    // 6. (Re)démarrage backend via PM2.
    let pm2Info;
    await step('pm2', 'Redémarrage du backend (PM2)', async () => {
      pm2Info = await restartBackend(transport, { host, backendDir, port: backendPort, env });
      return pm2Info;
    });

    // 7. Health check LOCAL (le backend PM2 répond sur son port).
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

    // 7bis. Synchronisation de la configuration réseau — APRÈS disponibilité du
    //       backend, AVANT les healthchecks publics. Écrite dans la base de la
    //       DESTINATION (jamais la base locale du moteur). Capacité injectée par
    //       le contrôleur ; en son absence (tests/façade), l'étape est neutre.
    await step('runtime_config', 'Synchronisation de la configuration réseau', async () => {
      if (typeof options.runtimeConfigSync !== 'function') return { skipped: true, reason: 'non configuré (façade/test)' };
      const dbName = String(env).toUpperCase() === 'PROD' ? remoteEnv?.DB_PROD : remoteEnv?.DB_TEST;
      // backendUrl = URL API CANONIQUE (https://api.<host>) — le domaine API dédié
      // vient d'être configuré (Nginx + certificat) juste au-dessus.
      const urls = deriveNetworkUrls({ siteHost: host, managerHost, apiHost });
      const res = await options.runtimeConfigSync({ mongoUri: remoteEnv?.MONGODB_URI, dbName, urls, requirePublic: true });
      return describeRuntimeConfig(res);
    });

    // 8. Validation finale : vitrine ET Manager répondent en HTTPS + bon ENV.
    await step('validate', 'Validation', async () => {
      const pub = await checkPublicHealth(transport, host, healthPublicOpts);
      const managerPub = await checkPublicHealth(transport, managerHost, healthPublicOpts);
      health.public = pub;
      health.managerPublic = managerPub;
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
      const media = await checkPublicMedia(transport, host, { managerHost });
      health.media = media;
      if (media.reachable && !media.ok) {
        const { DeploymentError } = await import('./errors.js');
        if (media.localHits.length) {
          throw new DeploymentError('MEDIA_STILL_LOCAL', 'Des médias pointent encore vers une URL locale/non sécurisée (Mixed Content).', {
            step: 'validate', details: { sample: media.localHits },
          });
        }
        const broken = (media.checked || []).filter((c) => !c.ok).map((c) => `${c.path} (site=${c.site?.code}/${c.site?.mime || '-'}${c.manager ? `, manager=${c.manager.code}/${c.manager.mime || '-'}` : ''})`);
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
      // avoir PU prouver que la vitrine servie est la bonne.
      if (String(env).toUpperCase() === 'PROD' && (!artifact.web?.vitrine?.indexHash || !artifact.web?.manager?.indexHash)) {
        const { DeploymentError } = await import('./errors.js');
        throw new DeploymentError('WEBSITE_FINGERPRINT_MISSING', 'Empreinte web absente de l’artefact (index.html non fingerprinté) : impossible de PROUVER que le site servi correspond au build. Déploiement PROD refusé.', {
          step: 'validate',
          details: { vitrine: Boolean(artifact.web?.vitrine?.indexHash), manager: Boolean(artifact.web?.manager?.indexHash) },
        });
      }
      const expectedCommit = artifact.manifest?.commitHash || null;
      const withCommit = (fp) => (fp && expectedCommit ? { ...fp, commitHash: expectedCommit } : fp);
      const webVitrine = await checkWebsiteArtifact(transport, host, withCommit(artifact.web?.vitrine), { label: 'vitrine' });
      const webManager = await checkWebsiteArtifact(transport, managerHost, withCommit(artifact.web?.manager), { label: 'manager' });
      health.webArtifact = { vitrine: webVitrine, manager: webManager };
      for (const w of [webVitrine, webManager]) {
        if (w.reachable && !w.ok && !w.skipped) {
          const { DeploymentError } = await import('./errors.js');
          throw new DeploymentError('WEBSITE_ARTIFACT_MISMATCH', `Le ${w.label} servi ne correspond pas à l'artefact construit (index ${w.indexMatch ? 'ok' : 'divergent'}, JS ${w.jsMatch ? 'ok' : 'divergent'}, version ${w.versionMatch ? 'ok' : 'divergente'}) — probable cache/ancienne version.`, {
            step: 'validate',
            details: { host: w.label === 'manager' ? managerHost : host, expectedIndex: w.expectedIndexHash?.slice(0, 12), remoteIndex: w.remoteIndexHash?.slice(0, 12), expectedJs: w.expectedJs, expectedCommit: w.expectedCommit?.slice(0, 12), remoteCommit: w.remoteCommit?.slice(0, 12) },
          });
        }
      }

      const managerOk = health?.managerPublic?.ok === true;
      return {
        url: target.canonicalUrl,
        managerUrl: `https://${managerHost}`,
        apiUrl: `https://${apiHost}`,
        env: pub.env,
        siteHttp: pub.httpCode,
        managerHttp: health?.managerPublic?.httpCode ?? null,
        managerReachable: managerOk,
        mediaOk: media.ok,
        apiReachable: api.reachable,
        apiHttp: api.code,
      };
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
