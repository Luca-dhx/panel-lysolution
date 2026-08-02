// EXÉCUTION D'UNE OPÉRATION DE DÉPLOIEMENT — Phase 4.
//
// ── CE MODULE NE DÉPLOIE RIEN LUI-MÊME ──────────────────────────────────────
// Il ne contient AUCUNE logique de déploiement : ni commande SSH, ni
// configuration nginx, ni gestion de release. Tout cela vit dans
// `deployment-engine/`, dont le cœur est identique dans tous les projets de
// l'écosystème.
//
// Son rôle est celui d'un adaptateur : traduire une DESTINATION du Panel en
// arguments du moteur, et traduire les événements du moteur en étapes de run.
// Dupliquer la logique ici la ferait diverger de SB Auto 06 dès la première
// correction — c'est exactement ce que la Phase 2D interdit.
import { DeploymentEngine } from '../../deployment-engine/DeploymentEngine.js';
import { openSession, closeSession } from '../../deployment-engine/passwordVault.js';
import { buildRemoteEnv } from '../../deployment-engine/deployEnv.js';
import { canonicalStep } from '../../deployment-engine/steps.js';
import { syncRuntimeNetworkConfiguration } from '../../deployment-engine/runtimeConfig.js';
import config from '../../config/env.js';

/** Opérations que le Panel sait exécuter sur une destination. */
export const OPERATIONS = Object.freeze({
  CONNECTION_TEST: 'CONNECTION_TEST',
  PRECHECK: 'PRECHECK',
  SIMULATION: 'SIMULATION',
  DEPLOYMENT: 'DEPLOYMENT',
  ROLLBACK: 'ROLLBACK',
});

/**
 * Exécute une opération et rend son issue.
 *
 * @param {object} args
 * @param {string} args.operationType  une valeur d'OPERATIONS
 * @param {object} args.target         destination (projection `describeTarget`)
 * @param {string} args.sshPassword    mot de passe — jamais persisté, jamais journalisé
 * @param {string} args.user           qui a lancé — figure au rapport
 * @param {Function} args.onStep       (step) => void — appelé à chaque étape
 * @param {Function} args.onLog        (message, level) => void
 * @returns {Promise<{status, summary, error, version?, releaseId?, deployedUrl?, steps?}>}
 */
export async function executeOperation({
  operationType, target, sshPassword, releaseId = null, user = null,
  onStep = () => {}, onLog = () => {}, engine: injectedEngine = null,
}) {
  const engine = injectedEngine ?? new DeploymentEngine({ mongoUri: config.mongoUri });
  const steps = [];

  // On enveloppe les rappels : le run doit garder la trace des étapes même
  // quand l'opération échoue en cours de route.
  const step = (payload) => {
    steps.push(payload);
    onStep(payload);
  };
  const log = (message, level = 'INFO') => onLog(message, level);

  let sessionId = null;
  try {
    log(`Ouverture d’une session vers ${target.sshUser}@${target.sshHost}…`);
    const session = openSession({
      host: target.sshHost,
      username: target.sshUser,
      password: sshPassword,
      keep: false,
    });
    sessionId = session.sessionId;

    switch (operationType) {
      case OPERATIONS.CONNECTION_TEST:
        return await connectionTest({ engine, target, sessionId, step, log });
      case OPERATIONS.PRECHECK:
        return await precheck({ engine, target, sessionId, step, log });
      case OPERATIONS.SIMULATION:
        return await simulation({ engine, target, sessionId, step, log });
      case OPERATIONS.DEPLOYMENT:
        return await deployWithFullReport({ engine, target, sessionId, step, log, user });
      case OPERATIONS.ROLLBACK:
        return await rollback({ engine, target, sessionId, releaseId, step, log });
      default:
        return {
          status: 'error',
          summary: `Opération « ${operationType} » inconnue.`,
          error: { code: 'UNKNOWN_OPERATION', message: `Opération inconnue : ${operationType}.` },
          steps,
        };
    }
  } catch (err) {
    log(`Échec : ${err.message}`, 'ERROR');
    return {
      status: 'error',
      summary: describeFailure(err),
      error: { code: err.code ?? 'DEPLOYMENT_FAILED', message: err.message, step: err.step ?? null },
      steps,
    };
  } finally {
    // Le secret meurt ici, quoi qu'il arrive.
    if (sessionId) closeSession(sessionId);
  }
}

/* -------------------------------------------------------------------------- */
/*  OPÉRATIONS                                                                */
/* -------------------------------------------------------------------------- */

/** Le serveur répond-il, et pouvons-nous nous y authentifier ? */
async function connectionTest({ engine, target, sessionId, step, log }) {
  step({ id: 'connect', label: 'Connexion SSH', status: 'running' });
  const releases = await engine.listReleases({
    url: target.url,
    sessionId,
    remoteRoot: target.remoteRoot,
  });
  step({ id: 'connect', label: 'Connexion SSH', status: 'ok', message: 'Authentification réussie.' });

  log(`${releases.releases.length} release(s) trouvée(s) sur ${releases.host}.`);
  step({
    id: 'releases',
    label: 'Lecture des releases',
    status: 'ok',
    message: releases.current ? `Release active : ${releases.current}` : 'Aucune release active.',
  });

  return {
    status: 'ok',
    summary: `Connexion établie avec ${target.sshUser}@${target.sshHost}. `
      + `${releases.releases.length} release(s), active : ${releases.current ?? 'aucune'}.`,
    error: null,
    releases: releases.releases,
    currentRelease: releases.current,
  };
}

/** Le serveur est-il en état de recevoir un déploiement ? */
async function precheck({ engine, target, sessionId, step, log }) {
  step({ id: 'preflight', label: 'Vérification des prérequis', status: 'running' });
  const result = await engine.preflight({
    url: target.url,
    sessionId,
    remoteRoot: target.remoteRoot,
  });

  for (const check of result.checks ?? []) {
    log(`${check.ok ? '✓' : '✗'} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`,
      check.ok ? 'INFO' : (check.required === false ? 'WARNING' : 'ERROR'));
  }

  const failed = result.failedChecks ?? [];
  step({
    id: 'preflight',
    label: 'Vérification des prérequis',
    status: result.ok ? 'ok' : 'error',
    message: result.ok
      ? `${(result.checks ?? []).length} contrôle(s) satisfait(s).`
      : `${failed.length} prérequis manquant(s) : ${failed.map((c) => c.label).join(', ')}`,
  });

  return {
    status: result.ok ? 'ok' : 'error',
    summary: result.ok
      ? 'Le serveur remplit tous les prérequis : le déploiement peut avoir lieu.'
      : `Déploiement impossible parce que ${failed.length} prérequis ne sont pas remplis : ${failed.map((c) => c.label).join(', ')}.`,
    error: result.ok ? null : { code: 'PREFLIGHT_FAILED', message: 'Prérequis non remplis.' },
    checks: result.checks ?? [],
  };
}

/**
 * SIMULATION — préflight complet et plan, sans rien modifier.
 *
 * Ce n'est pas un déploiement « à blanc » qui écrirait puis annulerait :
 * c'est un préflight réel suivi du plan que le moteur exécuterait. Rien
 * n'est téléversé, rien n'est redémarré.
 */
async function simulation({ engine, target, sessionId, step, log }) {
  const pre = await precheck({ engine, target, sessionId, step, log });

  step({ id: 'plan', label: 'Construction du plan', status: 'running' });
  const { PIPELINE_STEPS } = await import('../../deployment-engine/pipeline.js');
  const version = await engine.getVersion();
  const plan = ['build', ...PIPELINE_STEPS];

  for (const name of plan) log(`· ${name}`);
  step({
    id: 'plan',
    label: 'Construction du plan',
    status: 'ok',
    message: `${plan.length} étapes seraient exécutées.`,
  });

  return {
    status: pre.status === 'ok' ? 'ok' : 'warning',
    summary: pre.status === 'ok'
      ? `Simulation réussie : ${plan.length} étapes seraient exécutées pour publier la version ${version} sur ${target.url}. Rien n’a été modifié.`
      : `Simulation effectuée, mais le déploiement serait REFUSÉ : ${pre.summary}`,
    error: null,
    version,
    plan,
    checks: pre.checks,
  };
}

/**
 * LE DÉPLOIEMENT — une seule opération, orchestrée par le MOTEUR.
 *
 * ── POURQUOI `deployWithReport` ET PAS `deploy` ─────────────────────────────
 * Le moteur possède déjà l'orchestration complète : préflight, sécurité de la
 * destination, build, transfert, nginx, TLS, PM2, contrôle de santé,
 * vérification publique — le tout émettant des étapes CANONIQUES et
 * produisant un rapport structuré + markdown, secrets masqués.
 *
 * Composer nous-mêmes ces appels reviendrait à réécrire l'orchestration du
 * moteur dans le Panel : elle divergerait de SB Auto 06 à la première
 * correction. L'orchestrateur du Panel ne fait donc que **déclencher** et
 * **transcrire**.
 *
 * C'est aussi ce qui supprime les boutons intermédiaires : la connexion et
 * les prérequis ne sont plus des actions de l'opérateur, ce sont des étapes
 * de CETTE opération.
 */
async function deployWithFullReport({ engine, target, sessionId, step, log, user }) {
  const parsedTarget = engine.parseUrl(target.url);
  // `buildRemoteEnv` retourne une ENVELOPPE { remoteEnv, dbName, env, sourcePath } :
  // seul `.remoteEnv` porte les variables. Étaler l'enveloppe n'envoyait aucune
  // variable sur le VPS — uniquement `remoteEnv=[object Object]`.
  const remoteEnv = {
    ...buildRemoteEnv(parsedTarget, { env: target.environment }).remoteEnv,
    PORT: String(target.backendPort),
    ...(target.extraEnv ?? {}),
  };

  log(`Déploiement de ${target.url} en ${target.environment} (port ${target.backendPort}).`);

  const result = await engine.deployWithReport({
    url: target.url,
    sessionId,
    user,
    options: {
      remoteRoot: target.remoteRoot,
      backendPort: target.backendPort,
      env: target.environment,
      email: target.certbotEmail ?? undefined,
      remoteEnv,
      targetId: target.targetId,
      targetName: target.name,
      sshHost: target.sshHost,
      sshUser: target.sshUser,
      operationType: 'DEPLOYMENT',
      // Écrit les URLs publiques dans le SystemConfiguration de la DESTINATION
      // (comme SB Auto). Sans cette capacité, l'étape `runtime.sync` se déclarait
      // réussie sans rien faire — une étape verte sans action.
      runtimeConfigSync: syncRuntimeNetworkConfiguration,
    },
    // Le moteur émet un évènement par transition d'étape. On le transcrit
    // dans le run persisté — c'est ce que l'interface relit.
    onEvent: (evt) => {
      if (evt.stepId && evt.status) {
        step({
          id: evt.stepId,
          label: evt.label ?? evt.stepId,
          status: evt.status,
          message: evt.publicMessage ?? null,
          errorCode: evt.errorCode ?? null,
        });
      }
      const line = evt.publicMessage ?? evt.technicalMessage ?? null;
      if (line) {
        log(`[${evt.stepId ?? evt.type}] ${line}`,
          evt.status === 'error' ? 'ERROR' : evt.status === 'warning' ? 'WARNING' : 'INFO');
      }
    },
  });

  // MASQUAGE COMPLÉMENTAIRE. Le redacteur du moteur amorce sur JWT_SECRET,
  // MONGODB_URI et INTEGRATED_API_ENCRYPTION_KEY — les secrets d'un projet
  // vitrine. Le Panel en a un de plus, BRIDGE_ENCRYPTION_KEY, que le moteur
  // ne connaît pas.
  //
  // On ne modifie pas le moteur pour autant : son cœur doit rester identique
  // dans les deux dépôts (29_ENGINE_GOVERNANCE). On repasse donc une couche
  // côté Panel — défense en profondeur, et aucun fork.
  const redactPanelSecrets = buildPanelRedactor();

  return {
    status: result.ok ? 'ok' : (result.status === 'warning' ? 'warning' : 'error'),
    summary: result.ok
      ? `Version ${result.version} déployée sur ${target.url}.`
      : `Déploiement échoué à l’étape « ${describeStep(result.finalStepId)} ».`,
    error: result.ok ? null : {
      code: result.errorSummary?.code ?? 'DEPLOYMENT_FAILED',
      message: redactPanelSecrets(result.errorSummary?.message ?? 'Échec du déploiement.'),
      step: result.finalStepId ?? null,
    },
    version: result.version ?? null,
    releaseId: result.releaseId ?? result.version ?? null,
    deployedUrl: result.ok ? target.url : null,
    structuredReport: redactStructured(result.structuredReport, redactPanelSecrets),
    markdownReport: redactPanelSecrets(result.markdownReport ?? ''),
  };
}

/** Libellé métier d'une étape canonique — jamais son identifiant brut. */
function describeStep(stepId) {
  if (!stepId) return 'inconnue';
  return canonicalStep(stepId).label ?? stepId;
}

/**
 * Masque les secrets propres au PANEL, que le moteur ne connaît pas.
 * Construit à l'appel : une clé tournée entre deux déploiements doit être
 * masquée dans le second.
 */
function buildPanelRedactor() {
  const secrets = [config.bridgeEncryptionKey, config.jwt?.secret, config.mongoUri]
    .filter((s) => typeof s === 'string' && s.length >= 8);

  return (text) => {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('«redacted»');
    // Une URI Mongo complète peut apparaître sous une forme reconstruite :
    // on masque aussi le motif, pas seulement la valeur exacte connue.
    out = out.replace(/mongodb(\+srv)?:\/\/[^\s"'`]*@[^\s"'`]*/gi, 'mongodb://«redacted»');
    return out;
  };
}

/** Applique le masquage à toutes les chaînes d'un rapport structuré. */
function redactStructured(report, redact) {
  if (report === null || report === undefined) return null;
  return JSON.parse(redact(JSON.stringify(report)));
}

/** @deprecated Chemin historique — conservé pour le rollback et les tests. */
async function deployment({ engine, target, sessionId, step, log, steps }) {
  // Le `.env` distant est construit par le MOTEUR à partir du `.env` local du
  // Panel : c'est lui qui sait quelles variables sont obligatoires (le profil
  // les déclare) et lesquelles ne doivent jamais partir. On lui donne la
  // cible analysée, pas notre projection — il attend sa propre forme.
  const parsedTarget = engine.parseUrl(target.url);
  const remoteEnv = {
    // `.remoteEnv` : la valeur utile de l'enveloppe retournée par le moteur.
    ...buildRemoteEnv(parsedTarget, { env: target.environment }).remoteEnv,
    // Le port d'écoute vient de la destination : deux destinations sur un
    // même serveur ne doivent pas se disputer le port.
    PORT: String(target.backendPort),
    ...(target.extraEnv ?? {}),
  };

  log(`Déploiement de ${target.url} en ${target.environment} (port ${target.backendPort}).`);

  const result = await engine.deploy({
    url: target.url,
    sessionId,
    options: {
      remoteRoot: target.remoteRoot,
      backendPort: target.backendPort,
      env: target.environment,
      email: target.certbotEmail ?? undefined,
      remoteEnv,
    },
    onStep: (evt) => {
      step({
        id: evt.step,
        label: evt.label ?? evt.step,
        status: evt.status === 'done' ? 'ok' : evt.status,
        message: evt.message ?? null,
      });
      if (evt.message) log(`[${evt.step}] ${evt.message}`);
    },
  });

  if (!result.ok) {
    return {
      status: 'error',
      summary: `Déploiement échoué à l’étape « ${result.failedStep ?? 'inconnue'} ».`,
      error: { code: 'DEPLOYMENT_FAILED', message: result.error ?? 'Échec du pipeline.', step: result.failedStep ?? null },
      version: result.version ?? null,
      steps,
    };
  }

  return {
    status: 'ok',
    summary: `Version ${result.version} déployée sur ${target.url}.`,
    error: null,
    version: result.version ?? null,
    releaseId: result.releaseId ?? result.version ?? null,
    deployedUrl: target.url,
    steps,
  };
}

/** Retour à une release antérieure — logique entièrement dans le moteur. */
async function rollback({ engine, target, sessionId, releaseId, step, log }) {
  if (!releaseId) {
    return {
      status: 'error',
      summary: 'Retour arrière impossible parce qu’aucune release cible n’a été indiquée.',
      error: { code: 'ROLLBACK_NO_RELEASE', message: 'releaseId requis.' },
    };
  }

  log(`Retour vers la release ${releaseId}…`);
  const result = await engine.rollback({
    url: target.url,
    sessionId,
    releaseId,
    options: { remoteRoot: target.remoteRoot, backendPort: target.backendPort, env: target.environment },
    onStep: (evt) => {
      step({
        id: evt.step,
        label: evt.label ?? evt.step,
        status: evt.status === 'done' ? 'ok' : evt.status,
        message: evt.message ?? null,
      });
    },
  });

  return {
    status: result.ok ? 'ok' : 'error',
    summary: result.ok
      ? `Retour effectué : ${result.from ?? 'inconnue'} → ${result.to}. Service sain.`
      : 'Retour arrière échoué.',
    error: result.ok ? null : { code: 'ROLLBACK_FAILED', message: 'Le retour arrière a échoué.' },
    releaseId: result.to ?? releaseId,
    deployedUrl: target.url,
  };
}

/* -------------------------------------------------------------------------- */

/** Message d'échec lisible, sans jargon ni fuite. */
function describeFailure(err) {
  if (err.code === 'PREFLIGHT_FAILED') {
    return 'Déploiement refusé parce que le serveur ne remplit pas les prérequis. Consultez le journal.';
  }
  if (err.name === 'PreflightError') {
    return 'Déploiement refusé par le préflight : le serveur n’est pas prêt.';
  }
  // Un échec d'authentification est le cas le plus fréquent : on le nomme.
  if (/authentication|permission denied|auth/i.test(err.message)) {
    return 'Connexion au serveur refusée : vérifiez l’utilisateur SSH et le mot de passe.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/i.test(err.message)) {
    return 'Serveur injoignable : vérifiez l’adresse, le port SSH et le pare-feu.';
  }
  return `Échec : ${err.message}`;
}

export default { OPERATIONS, executeOperation };
