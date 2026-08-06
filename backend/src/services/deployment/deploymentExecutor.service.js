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
import * as identity from './projectIdentity.service.js';

/** Opérations que le Panel sait exécuter sur une destination. */
export const OPERATIONS = Object.freeze({
  CONNECTION_TEST: 'CONNECTION_TEST',
  PRECHECK: 'PRECHECK',
  SIMULATION: 'SIMULATION',
  DEPLOYMENT: 'DEPLOYMENT',
  ROLLBACK: 'ROLLBACK',
  /**
   * RETRAIT — l'opération inverse du déploiement. Elle vide la destination du
   * serveur : service arrêté et supprimé, port libéré, routage retiré,
   * quarantaine 410 posée, fichiers effacés, le tout vérifié.
   */
  DEPROVISION: 'DEPROVISION',
  /**
   * SUPPRESSION DÉFINITIVE de la fiche — lève la quarantaine et marque la
   * destination `DELETED`. N'existe que parce que lever la quarantaine exige
   * une connexion au serveur : sans elle, une simple écriture en base
   * suffirait.
   */
  DESTINATION_DELETE: 'DESTINATION_DELETE',
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
  operationType, target, sshPassword, releaseId = null, user = null, runId = null,
  options = {},
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
        return await deployWithFullReport({ engine, target, sessionId, step, log, user, runId });
      case OPERATIONS.ROLLBACK:
        return await rollback({ engine, target, sessionId, releaseId, step, log });
      case OPERATIONS.DEPROVISION:
        return await deprovision({ engine, target, sessionId, step, log, runId, options });
      case OPERATIONS.DESTINATION_DELETE:
        return await destinationDelete({ engine, target, sessionId, step, log, user });
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
async function deployWithFullReport({ engine, target, sessionId, step, log, user, runId = null }) {
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

  /**
   * IDENTITÉ DU PROJET DÉPLOYÉ — et, par elle, le droit de récupérer les
   * médias persistants de ses emplacements antérieurs.
   *
   * Une destination sans parenté déclarée reçoit ici sa PROPRE identité :
   * elle devient son propre projet et n'hérite de rien. C'est volontairement
   * le choix conservateur — rapprocher deux destinations reste un acte
   * déclaré, jamais une déduction depuis la base, le domaine ou le serveur.
   */
  let projectIdentityId = null;
  try {
    const ident = await identity.ensureOwnIdentity(target, { actor: user ?? null, reason: 'déploiement' });
    projectIdentityId = ident.identityId;
  } catch (err) {
    log(`Identité de projet indisponible (${err.message}) — aucune migration de médias ne sera tentée.`, 'WARNING');
  }

  /**
   * Emplacement de CE déploiement, enregistré au moment où le moteur en
   * connaît les chemins réels. Il ne deviendra une source de migration
   * qu'une fois le déploiement vérifié (`HEALTHY`) : un emplacement qui a
   * échoué avant le transfert n'a peut-être reçu aucun fichier, et en faire
   * une source reviendrait à migrer du vide en croyant migrer des médias.
   */
  let locationId = null;
  const resolveUploadsSources = async ({ host, siteRoot, sharedUploads }) => {
    if (!projectIdentityId) return null;
    const loc = await identity.recordLocation({
      projectIdentityId,
      targetId: target.targetId,
      host,
      siteRoot,
      sharedUploadsPath: sharedUploads,
      sharedStoragePath: `${siteRoot}/shared/storage`,
      sshHost: target.sshHost ?? null,
      environment: target.environment,
      deploymentRunId: runId ?? null,
    });
    locationId = loc?._id ?? null;
    return identity.resolveUploadsSources({
      projectIdentityId,
      targetId: target.targetId,
      sharedUploadsPath: sharedUploads,
    });
  };

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
      // Le moteur ne cherche JAMAIS de source de médias : elle lui est
      // fournie, tirée de l'historique des emplacements de CE projet.
      resolveUploadsSources,
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

  // EMPLACEMENT DU PROJET — n'est promu en source de migration que si le
  // déploiement a été VÉRIFIÉ. Sinon il reste marqué en échec et ne servira
  // jamais de référence à une copie de médias.
  if (locationId) {
    try {
      if (result.ok) await identity.markLocationHealthy(locationId, { deploymentRunId: runId ?? null });
      else await identity.markLocationFailed(locationId);
    } catch { /* la trace d'emplacement ne doit jamais casser un déploiement */ }
  }

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
/*  RETRAIT                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * RETRAIT D'UNE DESTINATION — l'opération inverse du déploiement.
 *
 * ── CE QUE CET ADAPTATEUR FAIT, ET CE QU'IL NE FAIT PAS ─────────────────────
 * Il ne contient AUCUNE commande distante : ni PM2, ni Nginx, ni `rm`. Tout
 * cela vit dans `deployment-engine/deprovision.js`, identique dans les deux
 * dépôts. Ici, on traduit une destination du Panel en arguments du moteur, et
 * l'issue du moteur en TRANSITION DE CYCLE DE VIE — la seule chose que le
 * moteur ne peut pas décider, parce qu'elle appartient à la base du Panel.
 *
 * Les transitions sont écrites même si le worker meurt ensuite : `EMPTY` n'est
 * posé qu'après la vérification finale du moteur, et `DEPROVISION_FAILED`
 * conserve la cause. Une destination laissée en `DEPROVISIONING` par un
 * processus mort est reprenable — les étapes du moteur sont idempotentes.
 */
async function deprovision({ engine, target, sessionId, step, log, runId, options = {} }) {
  const lifecycle = await import('./destinationLifecycle.service.js');

  log(`Retrait de ${target.url} (port ${target.backendPort}, serveur ${target.sshHost}).`);
  if (options.removePersistentData === true) {
    log('Suppression des données persistantes CONFIRMÉE par l’opérateur : '
      + 'shared/uploads et shared/storage seront effacés.', 'WARNING');
  }

  const result = await engine.deprovision({
    url: target.url,
    sessionId,
    options: {
      remoteRoot: target.remoteRoot,
      backendPort: target.backendPort,
      removePersistentData: options.removePersistentData === true,
      // Les autres destinations connues du Panel sont protégées explicitement :
      // aucun retrait ne doit pouvoir toucher au dossier d'un autre projet,
      // même si une fiche porte une valeur incohérente.
      protectedPaths: options.protectedPaths ?? [],
    },
    onStep: (evt) => {
      step({
        id: evt.step,
        label: evt.label ?? evt.step,
        status: evt.status,
        message: evt.detail ? describeDeprovisionDetail(evt.step, evt.detail) : null,
        errorCode: evt.error?.code ?? null,
      });
      if (evt.status === 'error') log(`[${evt.step}] ${evt.error?.message ?? 'échec'}`, 'ERROR');
      else if (evt.status === 'ok' && evt.detail) {
        const ligne = describeDeprovisionDetail(evt.step, evt.detail);
        if (ligne) log(`[${evt.step}] ${ligne}`);
      }
    },
  });

  if (!result.ok) {
    await lifecycle.markDeprovisionFailed(target.targetId, {
      runId,
      error: { code: result.error?.code, message: result.error?.message, step: result.failedStep },
    });
    return {
      status: 'error',
      summary: `Retrait interrompu à l’étape « ${result.failedStep ?? 'inconnue'} » : ${result.error?.message ?? 'échec.'} `
        + 'La destination reste connue du Panel — rien n’a été supprimé de sa fiche.',
      error: {
        code: result.error?.code ?? 'DEPROVISION_FAILED',
        message: result.error?.message ?? 'Échec du retrait.',
        step: result.failedStep ?? null,
      },
      inventory: result.inventory ?? null,
    };
  }

  await lifecycle.markEmpty(target.targetId, { runId, quarantine: true });

  const inv = result.inventory ?? {};
  return {
    status: 'ok',
    summary: `Destination vidée : service arrêté, port ${target.backendPort} libéré, routage retiré, `
      + `quarantaine 410 posée sur ${inv.servedHosts?.length ?? 1} hôte(s), `
      + `${inv.files ?? 0} fichier(s) supprimé(s)${inv.size ? ` (${inv.size})` : ''}. `
      + 'Sa fiche peut maintenant être supprimée.',
    error: null,
    inventory: result.inventory ?? null,
  };
}

/** Une ligne lisible pour l'étape courante — jamais un objet brut à l'écran. */
function describeDeprovisionDetail(stepId, detail) {
  if (!detail || typeof detail !== 'object') return null;
  switch (stepId) {
    case 'deprovision.lock':
      return `Chemin validé : ${detail.siteRoot}`;
    case 'deprovision.inventory':
      return detail.exists
        ? `${detail.files} fichier(s)${detail.size ? `, ${detail.size}` : ''} — `
          + `persistants : ${detail.persistentFiles ?? 0}`
        : 'Aucun fichier sur le serveur.';
    case 'deprovision.services.stop':
      return `Process « ${detail.pm2Name} » arrêté et supprimé.`;
    case 'deprovision.services.verify':
      return 'Le process a bien disparu de PM2.';
    case 'deprovision.port.release':
      return detail.skipped ? 'Aucun port applicatif déclaré.' : `Port ${detail.port} libéré.`;
    case 'deprovision.nginx.remove':
      return 'Configuration applicative retirée.';
    case 'deprovision.quarantine':
      return `410 Gone servi sur : ${(detail.hosts ?? []).join(', ')}`;
    case 'deprovision.files.remove':
      return detail.alreadyAbsent ? 'Dossier déjà absent.' : `Dossier ${detail.siteRoot} supprimé.`;
    case 'deprovision.verify':
      return 'Plus de fichiers, plus de process, plus de routage applicatif.';
    case 'deprovision.finalize':
      return 'Destination vidée.';
    default:
      return null;
  }
}

/**
 * SUPPRESSION DÉFINITIVE de la fiche.
 *
 * Elle lève la quarantaine — le domaine cesse alors d'être servi du tout — puis
 * marque la destination `DELETED`. L'ordre compte : marquer d'abord laisserait
 * une quarantaine sans propriétaire sur le serveur, que plus aucun écran ne
 * saurait désigner.
 */
async function destinationDelete({ engine, target, sessionId, step, log, user }) {
  const lifecycle = await import('./destinationLifecycle.service.js');

  step({ id: 'quarantine.release', label: 'Levée de la quarantaine', status: 'running' });
  await engine.releaseQuarantine({ url: target.url, sessionId });
  await lifecycle.setQuarantine(target.targetId, false);
  step({
    id: 'quarantine.release',
    label: 'Levée de la quarantaine',
    status: 'ok',
    message: `Le domaine ${target.host} n’est plus servi par ce serveur.`,
  });
  log(`Quarantaine levée sur ${target.host}.`);

  step({ id: 'destination.delete', label: 'Suppression de la fiche', status: 'running' });
  await lifecycle.softDelete(target.targetId, { actor: { userEmail: user } });
  step({
    id: 'destination.delete',
    label: 'Suppression de la fiche',
    status: 'ok',
    message: 'Historique et audit conservés.',
  });

  return {
    status: 'ok',
    summary: `Destination « ${target.name} » supprimée. Son historique et son audit restent consultables ; `
      + `le domaine ${target.host} n’est plus servi par ce serveur.`,
    error: null,
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
