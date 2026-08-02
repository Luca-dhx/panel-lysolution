/**
 * FAÇADE du moteur de déploiement — point d'entrée unique, UI-AGNOSTIC.
 *
 * Toute la logique métier (duplication, préflight, déploiement, changement de
 * domaine, backup, restauration) est centralisée ici et dans les sous-modules.
 * Cette façade NE contient aucune logique React, aucun composant, aucun écran.
 * Le Manager et les routes API ne font que l'appeler ; demain une CLI ou un
 * panel multi-sites appelleront exactement les mêmes méthodes.
 *
 * Le mot de passe VPS n'est jamais reçu en clair par la façade : elle reçoit un
 * `sessionId` opaque et demande au coffre-fort mémoire (passwordVault) de
 * fabriquer le transport SSH au dernier moment.
 */
import { parseTargetUrl, wildcardBasesFromEnv } from './url.js';
import { runPreflight } from './preflight.js';
import { runPipeline } from './pipeline.js';
import { getProjectVersion, buildArtifact, localExec } from './build.js';
import { duplicateProject } from '../duplication-engine/duplication.js';
import { createBackup, restoreBackup, listBackups } from './backup.js';
import { SshTransport } from './transport/SshTransport.js';
import { RecordingTransport } from './transport/RecordingTransport.js';
import { getSession } from './passwordVault.js';
import { DeploymentError, PreflightError, ValidationError } from './errors.js';
import { RunRecorder } from './report/RunRecorder.js';
import { createRedactor } from './report/sanitize.js';
import { renderMarkdown } from './report/markdown.js';
import { toCanonical, canonicalStep, CANONICAL_ORDER } from './steps.js';
import { derivePrimarySubHost, derivePrimarySubUrl, isCoveredByWildcard } from './hostnames.js';
import { resolveVpsIp, checkDomainPointsToVps } from './dns.js';
import { dnsPlanPhase, dnsMutationPhase } from './dns/dnsPhase.js';
import { rollbackToRelease, listReleases, currentRelease, verifyReleaseIntegrity } from './rollback.js';

/**
 * Regroupement des contrôles préflight en étapes canoniques. La vérification DNS
 * (dns.*) n'est PLUS ici : elle est portée par la phase DNS dédiée (fournisseur
 * Hostinger ou repli), avant/après le préflight selon l'ordre sûr.
 */
const PREFLIGHT_CANONICAL = {
  'ssh.connect': ['ssh'],
  'server.preflight': ['nginx', 'node', 'pm2', 'nginx-config', 'permissions', 'disk', 'mongo', 'certbot', 'wildcard-cert'],
  'remote.safety': ['occupied'],
};

export class DeploymentEngine {
  /**
   * @param {object} [deps]
   * @param {(sessionId:string)=>import('./transport/Transport.js').Transport} [deps.transportFactory]
   *        Fabrique de transport (injectable pour les tests / dry-run).
   * @param {string} [deps.mongoUri]      URI Mongo (duplication/backup).
   * @param {string[]} [deps.wildcardBases]
   */
  constructor(deps = {}) {
    this.transportFactory = deps.transportFactory || defaultTransportFactory;
    this.mongoUri = deps.mongoUri || process.env.MONGODB_URI;
    this.wildcardBases = deps.wildcardBases || wildcardBasesFromEnv();
  }

  /**
   * RELEASES présentes sur une cible, de la plus récente à la plus ancienne.
   * @param {{url:string, sessionId:string, remoteRoot?:string, transport?:object}} args
   */
  async listReleases({ url, sessionId, remoteRoot, transport }) {
    const { tx, ephemeral } = this._transport(transport, sessionId);
    try {
      const target = this.parseUrl(url);
      const releases = await listReleases(tx, { host: target.host, remoteRoot });
      const current = await currentRelease(tx, { host: target.host, remoteRoot });
      return { host: target.host, current, releases };
    } finally {
      if (ephemeral) await tx.close?.();
    }
  }

  /**
   * INTÉGRITÉ d'une release, sans rien modifier — utile avant de décider.
   */
  async verifyRelease({ url, sessionId, releaseId, remoteRoot, transport }) {
    const { tx, ephemeral } = this._transport(transport, sessionId);
    try {
      const target = this.parseUrl(url);
      return await verifyReleaseIntegrity(tx, { host: target.host, remoteRoot, releaseId });
    } finally {
      if (ephemeral) await tx.close?.();
    }
  }

  /**
   * ROLLBACK vers une release précédente.
   *
   * Toute la logique appartient au moteur (`rollback.js`) : vérification
   * d'intégrité AVANT bascule, repointage atomique de `current`, relance du
   * service, contrôle de santé, et restauration automatique de la release
   * d'origine si la bascule échoue.
   *
   * @param {object} args
   * @param {string} args.url
   * @param {string} args.sessionId
   * @param {string} [args.releaseId]  cible ; par défaut la release précédente
   * @param {object} [args.options]    { remoteRoot, backendPort, env }
   * @param {(evt:object)=>void} [args.onStep]
   */
  async rollback({ url, sessionId, releaseId, options = {}, onStep = () => {}, transport }) {
    const { tx, ephemeral } = this._transport(transport, sessionId);
    try {
      const target = this.parseUrl(url);
      return await rollbackToRelease({
        transport: tx,
        host: target.host,
        backendPort: options.backendPort,
        releaseId,
        remoteRoot: options.remoteRoot,
        env: options.env || 'PROD',
        onStep,
      });
    } finally {
      if (ephemeral) await tx.close?.();
    }
  }

  /** Analyse une URL de cible (déduction sous-domaine / domaine, wildcard…). */
  parseUrl(url) {
    return parseTargetUrl(url, { wildcardBases: this.wildcardBases });
  }

  /** Version courante du projet (SHA git court). */
  async getVersion(now = new Date()) {
    return getProjectVersion(undefined, now);
  }

  /**
   * PRÉFLIGHT sur une cible via une session VPS.
   * @param {{url:string, sessionId:string, remoteRoot?:string, transport?:object}} args
   */
  async preflight({ url, sessionId, remoteRoot, transport }) {
    const { tx, session, ephemeral } = this._transport(transport, sessionId);
    try {
      return await runPreflight({
        transport: tx,
        url,
        sshHost: session?.host,
        remoteRoot,
        wildcardBases: this.wildcardBases,
      });
    } finally {
      if (ephemeral) await tx.close?.();
    }
  }

  /**
   * DÉPLOIEMENT complet : préflight → build → pipeline. Refuse tout demi-déploiement.
   * @param {object} args
   * @param {string} args.url
   * @param {string} args.sessionId
   * @param {object} [args.options]  { remoteRoot, backendPort, env, email, remoteEnv, skipBuild, artifact }
   * @param {(evt:object)=>void} [args.onStep]
   * @param {boolean} [args.skipPreflight]
   * @param {object} [args.transport] Transport injecté (tests/dry-run).
   * @returns {Promise<{ok:boolean, version:string, target:object, preflight?:object, pipeline?:object}>}
   */
  async deploy({ url, sessionId, options = {}, onStep = () => {}, skipPreflight = false, transport }) {
    const { tx, session, ephemeral } = this._transport(transport, sessionId);
    let artifactCleanup = null;
    try {
      const target = this.parseUrl(url);

      // 1. Préflight (bloquant).
      let preflight = null;
      if (!skipPreflight) {
        preflight = await runPreflight({
          transport: tx,
          url,
          sshHost: session?.host,
          remoteRoot: options.remoteRoot,
          wildcardBases: this.wildcardBases,
        });
        if (!preflight.ok) {
          throw new PreflightError('Préflight en échec — déploiement refusé.', preflight.failedChecks);
        }
      }

      // 2. Version + build local (sauf si artefact fourni).
      const version = options.version || (await this.getVersion());
      let artifact = options.artifact;
      if (!artifact && !options.skipBuild) {
        onStep({ step: 'build', label: 'Build local', status: 'running' });
        artifact = await buildArtifact({ exec: options.buildExec, profile: options.profile, onLog: (m) => onStep({ step: 'build', label: m, status: 'running' }) });
        artifactCleanup = artifact.cleanup;
        onStep({ step: 'build', label: 'Build local', status: 'ok' });
      }
      if (!artifact) throw new ValidationError('Aucun artefact à déployer (build ignoré sans artefact fourni).');

      // 3. Pipeline.
      const pipeline = await runPipeline({ transport: tx, target, artifact, options, version, onStep });
      if (!pipeline.ok) {
        return { ok: false, version, target, preflight, pipeline };
      }
      return { ok: true, version, target, preflight, pipeline };
    } finally {
      // On ferme la CONNEXION SSH (transport) mais PAS la session VPS : celle-ci
      // appartient au frontend (bannière « Serveur connecté » / Déconnecter) et au
      // TTL. Elle est PARTAGÉE entre préflight, déploiement et redéploiement — une
      // opération ne doit jamais laisser la suivante sans session.
      if (ephemeral) await tx?.close?.();
      if (artifactCleanup) await artifactCleanup().catch(() => {});
    }
  }

  /**
   * DÉPLOIEMENT INSTRUMENTÉ : checklist canonique en direct + rapport technique.
   *
   * Émet des évènements structurés via `onEvent` (deployment.started,
   * step.started/succeeded/failed/warning/skipped, deployment.succeeded/failed)
   * et produit TOUJOURS un rapport (succès ou échec), redigé et borné.
   *
   * @returns {Promise<{ok:boolean, status:string, finalStepId:string|null,
   *   version:string, target:object, managerHost:string, managerUrl:string,
   *   steps:object[], structuredReport:object, markdownReport:string, errorSummary:object|null}>}
   */
  async deployWithReport({ url, sessionId, options = {}, onEvent = () => {}, user, deploymentRunId, transport }) {
    const target = this.parseUrl(url);
    // Hôte/URL du premier front sur sous-domaine, s'il en existe un au profil.
    //  sur un projet à front unique : c'est une information, pas un manque.
    const managerHost = derivePrimarySubHost(target.host, options.profile);
    const managerUrl = derivePrimarySubUrl(target.host, options.profile);
    const version = options.version || (await this.getVersion());

    // Redacteur : secrets d'environnement connus (le mot de passe VPS est ajouté
    // dès la résolution de la session).
    const redactor = createRedactor([
      process.env.JWT_SECRET,
      process.env.MONGODB_URI,
      process.env.INTEGRATED_API_ENCRYPTION_KEY,
    ].filter(Boolean));
    // Défense en profondeur : les secrets du .env DISTANT (générés par cible)
    // diffèrent de ceux du process de contrôle — on les enregistre aussi pour
    // qu'ils soient effacés partout (au-delà de la redaction par motif).
    for (const k of ['JWT_SECRET', 'INTEGRATED_API_ENCRYPTION_KEY', 'MONGODB_URI']) {
      if (options.remoteEnv?.[k]) redactor.addSecret(options.remoteEnv[k]);
    }

    const startedAt = new Date().toISOString();
    const recorder = new RunRecorder({
      redactor,
      identification: {
        deploymentRunId: deploymentRunId || null,
        deploymentTargetId: options.targetId || null,
        targetName: options.targetName || null,
        operationType: options.operationType || (options.preflightOnly ? 'PRECHECK' : 'DEPLOYMENT'),
        siteUrl: target.canonicalUrl,
        siteHost: target.host,
        managerUrl,
        managerHost,
        sshHost: options.sshHost || null,
        sshUser: options.sshUser || 'root',
        env: options.env || 'PROD',
        branch: options.branch || null,
        commit: version,
        version,
        user: user || null,
        startedAt,
      },
    });

    let baseTx = null;
    let ephemeral = false;
    let tx = null;
    let artifactCleanup = null; // nettoyage du staging de build (temp local)
    let seq = 0;
    const emit = (type, payload = {}) => {
      seq += 1;
      onEvent({ type, sequenceNumber: seq, timestamp: new Date().toISOString(), deploymentRunId: deploymentRunId || null, ...payload });
    };
    const emitStep = (stepId, status, extra = {}) => {
      const meta = canonicalStep(stepId);
      recorder.markStep(stepId, { status, ...extra });
      if (status === 'running') recorder.setCurrentStep(stepId);
      const typeMap = { running: 'step.started', ok: 'step.succeeded', warning: 'step.warning', error: 'step.failed', skipped: 'step.skipped' };
      emit(typeMap[status] || 'step.progress', {
        stepId,
        label: meta.label,
        status,
        publicMessage: extra.publicMessage || null,
        technicalMessage: extra.technicalMessage || null,
        errorCode: extra.errorCode || null,
        durationMs: extra.durationMs ?? null,
      });
    };

    let finalStatus = 'error';
    let finalStepId = null;
    let errorSummary = null;

    const finish = () => {
      recorder.finalize({ status: finalStatus, finalStepId, errorSummary });
      const structuredReport = recorder.toStructured();
      const markdownReport = redactor.truncate(renderMarkdown(structuredReport), 200_000);
      return {
        ok: finalStatus === 'ok',
        status: finalStatus,
        finalStepId,
        version,
        target,
        managerHost,
        managerUrl,
        steps: recorder.orderedSteps(),
        structuredReport,
        markdownReport,
        errorSummary,
      };
    };

    try {
      emit('deployment.started', { siteUrl: target.canonicalUrl, managerUrl, version });
      emitStep('deployment.initialize', 'running');
      // Résolution du transport (peut échouer : session absente/expirée).
      const resolved = this._transport(transport, sessionId);
      baseTx = resolved.tx;
      ephemeral = resolved.ephemeral;
      const session = resolved.session;
      if (session?.password) redactor.addSecret(session.password);
      if (session?.host) recorder.id.sshHost = session.host;
      if (session?.username) recorder.id.sshUser = session.username;
      tx = new RecordingTransport(baseTx, recorder);
      recorder.setContext(await this._localContext(options));
      emitStep('deployment.initialize', 'ok', { publicMessage: 'Déploiement initialisé.' });

      // IP attendue du VPS (pour la préparation DNS). Résolue depuis l'hôte SSH.
      const expectedIp = options.dnsExpectedIp || (session?.host ? await resolveVpsIp(session.host).catch(() => session.host) : null);
      if (options.dnsSecret) redactor.addSecret(options.dnsSecret);
      const useProvider = Boolean(options.dnsProvider);

      // -------------------- Phase DNS — PLANIFICATION (avant SSH) --------------------
      let dnsPlan = null;
      if (useProvider) {
        dnsPlan = await dnsPlanPhase({ provider: options.dnsProvider, siteHost: target.host, expectedIp, ttl: options.dnsTtl, emitStep, recorder, profile: options.profile });
        if (!dnsPlan.ok) {
          finalStepId = dnsPlan.failedStep;
          errorSummary = { code: dnsPlan.errorCode || 'DNS_FAILED', step: finalStepId, message: dnsPlan.section?.error?.message || 'Préparation du domaine impossible.', needsConfirmation: Boolean(dnsPlan.needsConfirmation), conflict: dnsPlan.conflict || null };
          recorder.setDiagnosis(this._diagnose(errorSummary.code, finalStepId, null, recorder));
          emit('deployment.failed', { status: 'error', finalStepId, errorCode: errorSummary.code });
          return finish();
        }
      } else {
        // Gestion DNS automatique non configurée : on n'écrit rien, on prévient
        // clairement, et on retombe sur le contrôle DNS manuel/wildcard.
        emitStep('dns.zone', 'skipped');
        emitStep('dns.provider', 'warning', { publicMessage: 'Gestion automatique du domaine non configurée.', technicalMessage: options.dnsNotConfiguredReason || 'Fournisseur DNS non configuré (IntegratedAPI).' });
        emitStep('dns.read', 'skipped');
        recorder.addWarning('Gestion DNS automatique non configurée — vérification DNS manuelle appliquée.', 'dns.provider');
        recorder.setHostinger({ configured: false, reason: options.dnsNotConfiguredReason || 'not_configured' });
      }

      // -------------------- Préflight (canonique) — DNS sauté (phase dédiée) --------------------
      recorder.setCurrentStep('server.preflight');
      const preflight = await runPreflight({
        transport: tx,
        url,
        sshHost: session?.host,
        remoteRoot: options.remoteRoot,
        wildcardBases: this.wildcardBases,
        skipDnsCheck: true,
      });
      recorder.setPrereqs(preflight.checks);
      recorder.setSsh({ host: session?.host, port: 22, user: session?.username || 'root', result: preflight.checks.find((c) => c.id === 'ssh')?.ok ? 'connected' : 'failed' });
      recorder.setDns(this._dnsSection(target, preflight, options.profile));

      let preflightFailed = false;
      for (const [stepId, ids] of Object.entries(PREFLIGHT_CANONICAL)) {
        const applicable = preflight.checks.filter((c) => ids.includes(c.id));
        if (applicable.length === 0) {
          continue;
        }
        emitStep(stepId, 'running');
        const requiredFail = applicable.find((c) => c.required && !c.ok);
        const softFail = applicable.find((c) => !c.required && !c.ok);
        if (requiredFail) {
          preflightFailed = true;
          const publicMessage = stepId === 'ssh.connect' ? 'Connexion au serveur impossible.' : requiredFail.label;
          emitStep(stepId, 'error', { errorCode: 'PREFLIGHT_FAILED', publicMessage, technicalMessage: requiredFail.detail || requiredFail.label });
          finalStepId = stepId;
          break;
        }
        emitStep(stepId, softFail ? 'warning' : 'ok', softFail ? { publicMessage: softFail.label } : {});
        if (softFail) recorder.addWarning(`${softFail.label}${softFail.detail ? ` — ${softFail.detail}` : ''}`, stepId);
      }
      if (preflightFailed || !preflight.ok) {
        const refusedMsg = options.preflightOnly
          ? 'Une vérification préalable a échoué.'
          : 'Le serveur n’est pas prêt — déploiement refusé.';
        errorSummary = { code: 'PREFLIGHT_FAILED', step: finalStepId, message: refusedMsg, failedChecks: preflight.failedChecks };
        recorder.setDiagnosis(this._diagnose('PREFLIGHT_FAILED', finalStepId, preflight, recorder));
        emit('deployment.failed', { status: 'error', finalStepId, errorCode: 'PREFLIGHT_FAILED' });
        return finish();
      }

      // -------------------- Phase DNS — MUTATION (après SSH OK) --------------------
      // Aucune mutation DNS n'a lieu avant que la connexion serveur soit validée.
      if (useProvider && dnsPlan?.ok) {
        await dnsMutationPhase({ provider: options.dnsProvider, plan: dnsPlan, expectedIp, ttl: options.dnsTtl, emitStep, recorder, resolutionOpts: options.dnsResolutionOpts });
      } else if (!useProvider) {
        // Repli manuel/wildcard : pas de création. On vérifie la résolution.
        emitStep('dns.site', 'skipped');
        emitStep('dns.apps', 'skipped');
        emitStep('dns.verify', 'running');
        const dnsResult = await this._fallbackDnsVerify(target, expectedIp);
        if (dnsResult.blocking) {
          finalStepId = 'dns.verify';
          errorSummary = { code: 'DNS_NOT_RESOLVED', step: finalStepId, message: dnsResult.message };
          recorder.setDiagnosis(this._diagnose('DNS_NOT_RESOLVED', finalStepId, preflight, recorder));
          emitStep('dns.verify', 'error', { errorCode: 'DNS_NOT_RESOLVED', publicMessage: 'L’adresse ne pointe pas encore vers le serveur.', technicalMessage: dnsResult.message });
          emit('deployment.failed', { status: 'error', finalStepId, errorCode: 'DNS_NOT_RESOLVED' });
          return finish();
        }
        emitStep('dns.verify', dnsResult.warning ? 'warning' : 'ok', dnsResult.warning ? { publicMessage: dnsResult.message } : {});
      }

      // -------------------- Préflight seul (PRECHECK) : on s'arrête ici --------------------
      if (options.preflightOnly) {
        emitStep('deployment.finalize', 'running');
        emitStep('deployment.finalize', 'ok', { publicMessage: 'Toutes les vérifications sont OK.' });
        finalStatus = 'ok';
        finalStepId = 'deployment.finalize';
        emit('deployment.succeeded', { status: 'ok', siteUrl: target.canonicalUrl, managerUrl, version });
        return finish();
      }

      // -------------------- Build local (staging isolé) --------------------
      emitStep('artifact.build', 'running', { publicMessage: 'Préparation de la nouvelle version…' });
      recorder.setCurrentStep('artifact.build');
      let artifact = options.artifact;
      if (!artifact && !options.skipBuild) {
        try {
          // Chaque sous-commande (install/build vitrine & Manager) est enregistrée
          // dans le rapport : commande, cwd, code, stdout/stderr (redigés/bornés).
          const built = await buildArtifact({
            exec: options.buildExec,
            profile: options.profile, // topologie du projet (injectable pour les tests) // injectable pour les tests ; localExec par défaut
            root: options.buildRoot, // idem (défaut : racine du monorepo)
            stagingBase: options.buildStagingBase,
            // PROD : refuse une source Git non commitée (déploie exactement le commit annoncé).
            requireCleanSource: options.requireCleanSource ?? (String(options.env || 'PROD').toUpperCase() === 'PROD'),
            builtAt: startedAt,
            onPhase: (rec) => {
              recorder.recordExec(`[${rec.phase}] ${rec.command} ${rec.args.join(' ')}  (cwd=${rec.cwd})`, {
                code: rec.code,
                stdout: rec.stdout,
                stderr: rec.error ? `${rec.stderr}\n${rec.error}` : rec.stderr,
              });
            },
          });
          artifact = built;
          artifactCleanup = built.cleanup;
        } catch (err) {
          // Sortie non nulle d'un processus enfant ATTENDU : ce n'est pas une
          // « exception non prévue » — on la présente comme un échec de build
          // structuré, avec la phase fautive et son code de sortie.
          if (typeof err?.code === 'string' && (err.code.startsWith('ARTIFACT_') || err.code.startsWith('DEPLOY_SOURCE_'))) {
            finalStepId = 'artifact.build';
            const d = err.details || {};
            errorSummary = { code: err.code, step: finalStepId, message: err.message };
            recorder.setDiagnosis(this._diagnose(err.code, finalStepId, preflight, recorder));
            emitStep('artifact.build', 'error', {
              errorCode: err.code,
              publicMessage: 'La préparation de la nouvelle version a échoué.',
              technicalMessage: d.phase ? `${d.phase} — code ${d.code ?? 'n/a'}${d.signal ? ` (${d.signal})` : ''}` : err.message,
            });
            emit('deployment.failed', { status: 'error', finalStepId, errorCode: err.code });
            return finish();
          }
          throw err;
        }
      }
      if (!artifact) {
        finalStepId = 'artifact.build';
        errorSummary = { code: 'NO_ARTIFACT', step: finalStepId, message: 'Aucun artefact à déployer.' };
        emitStep('artifact.build', 'error', { errorCode: 'NO_ARTIFACT', publicMessage: 'Préparation impossible.' });
        emit('deployment.failed', { status: 'error', finalStepId, errorCode: 'NO_ARTIFACT' });
        return finish();
      }
      const apiMode = artifact.frontendEnv?.VITE_API_URL ? artifact.frontendEnv.VITE_API_URL : 'relatif (/api → Nginx)';
      const builtList = Object.entries(artifact.dists ?? {}).map(([id, dir]) => `${id}=${dir}`).join(' ');
      recorder.markStep('artifact.build', { technicalMessage: `${builtList} · API front=${apiMode}` });
      emitStep('artifact.build', 'ok', { publicMessage: 'Version prête.' });

      // -------------------- Pipeline distant --------------------
      const running = new Set();
      const pipeline = await runPipeline({
        transport: tx,
        target,
        artifact,
        options,
        version,
        onStep: (raw) => {
          const canon = toCanonical(raw.step);
          if (raw.status === 'running') {
            if (!running.has(canon)) {
              running.add(canon);
              emitStep(canon, 'running');
            }
          } else if (raw.status === 'ok') {
            this._captureSection(recorder, raw);
            emitStep(canon, 'ok', { durationMs: raw.durationMs, technicalMessage: raw.detail ? JSON.stringify(raw.detail).slice(0, 500) : null });
          } else if (raw.status === 'error') {
            emitStep(canon, 'error', { durationMs: raw.durationMs, errorCode: raw.error?.code, technicalMessage: raw.error?.message });
            finalStepId = canon;
          }
        },
      });

      if (!pipeline.ok) {
        finalStepId = finalStepId || toCanonical(pipeline.failedStep);
        errorSummary = { code: pipeline.error?.code || 'DEPLOY_FAILED', step: finalStepId, message: pipeline.error?.message || 'Échec du déploiement.' };
        recorder.setDiagnosis(this._diagnose(errorSummary.code, finalStepId, preflight, recorder, pipeline));
        emit('deployment.failed', { status: 'error', finalStepId, errorCode: errorSummary.code });
        return finish();
      }

      emitStep('deployment.finalize', 'running');
      recorder.noteRemote('started', `PM2 backend + Nginx (${[target.host, managerHost].filter(Boolean).join(', ')})`);
      emitStep('deployment.finalize', 'ok', { publicMessage: 'Site publié.' });
      finalStatus = 'ok';
      finalStepId = 'deployment.finalize';
      emit('deployment.succeeded', { status: 'ok', siteUrl: target.canonicalUrl, managerUrl, version });
      return finish();
    } catch (err) {
      // Garde-fou ultime : toute exception produit un rapport partiel exploitable.
      finalStatus = 'error';
      finalStepId = finalStepId || recorder.currentStep || 'deployment.initialize';
      errorSummary = { code: err.code || 'UNEXPECTED', step: finalStepId, message: err.message };
      recorder.addWarning(`Exception non prévue : ${err.message}`, finalStepId);
      recorder.setDiagnosis(this._diagnose(errorSummary.code, finalStepId, null, recorder));
      emit('deployment.failed', { status: 'error', finalStepId, errorCode: errorSummary.code });
      return finish();
    } finally {
      // On ferme la CONNEXION SSH (transport) mais PAS la session VPS : elle est
      // partagée entre le préflight et le déploiement (et le redéploiement). La
      // session appartient au frontend (bannière/Déconnecter) + TTL. Un préflight
      // ne doit JAMAIS laisser le déploiement suivant sans session (NO_VPS_SESSION).
      if (ephemeral) await baseTx?.close?.();
      // Le staging de build est un temporaire local : on le nettoie après l'upload
      // (succès) comme après un échec — l'artefact a déjà été consommé par le pipeline.
      if (artifactCleanup) await artifactCleanup().catch(() => {});
    }
  }

  /** Contexte local (versions Node/npm, OS, env) — best-effort. */
  async _localContext(options) {
    const ctx = { os: `${process.platform} ${process.arch}`, node: process.version, env: options.env || 'PROD' };
    try {
      const npm = await localExec('npm', ['--version'], { timeoutMs: 8000 });
      if (npm.code === 0) ctx.npm = npm.stdout.trim();
    } catch {
      /* ignore */
    }
    return ctx;
  }

  /**
   * Vérification DNS de repli (sans fournisseur géré) : on ne crée rien, on
   * mesure la résolution publique. Bloque un domaine client qui ne pointe pas ;
   * avertit sans bloquer pour un sous-domaine wildcard.
   */
  async _fallbackDnsVerify(target, expectedIp) {
    const res = await checkDomainPointsToVps(target.host, expectedIp).catch(() => ({ resolves: false, pointsToVps: false, addresses: [] }));
    if (res.pointsToVps) return { blocking: false, warning: false, message: 'Adresse disponible.' };
    if (target.type === 'subdomain') {
      return { blocking: false, warning: true, message: 'Couvert par le wildcard — résolution en cours de propagation.' };
    }
    if (!res.resolves) return { blocking: true, warning: false, message: `Le domaine ${target.host} ne résout pas. Configurez le DNS ou activez la gestion automatique (Hostinger).` };
    return { blocking: true, warning: false, message: `${target.host} pointe vers ${res.addresses.join(', ') || '?'} au lieu de ${expectedIp || 'l’IP du VPS'}.` };
  }

  /** Section DNS du rapport selon le type de cible. */
  _dnsSection(target, preflight, profile) {
    if (target.type === 'subdomain') {
      return {
        mode: 'wildcard',
        wildcardBase: target.wildcardBase,
        note: `Couvert par le wildcard *.${target.wildcardBase} — aucun enregistrement DNS par site.`,
        derivedHostsCoveredByWildcard: isCoveredByWildcard(derivePrimarySubHost(target.host, profile), target.wildcardBase),
      };
    }
    const resolves = preflight?.checks?.find((c) => c.id === 'dns-resolves');
    const points = preflight?.checks?.find((c) => c.id === 'dns-points');
    return { mode: 'dedicated', host: target.host, resolves: resolves?.ok ?? null, resolvesDetail: resolves?.detail, pointsToVps: points?.ok ?? null, pointsDetail: points?.detail };
  }

  /** Capture les détails de section (nginx/https/services/public) depuis un step ok. */
  _captureSection(recorder, raw) {
    const d = raw.detail || {};
    if (raw.step === 'nginx') recorder.setNginx({ ...d, note: `server_name : ${(d.servedHosts ?? []).join(', ') || 'hôtes du profil'}` });
    if (raw.step === 'certbot') recorder.setHttps(d);
    if (raw.step === 'pm2') recorder.setServices(d);
    if (raw.step === 'health') recorder.setPublicTests(d);
    if (raw.step === 'validate') recorder.setPublicTests({ ...(recorder.sections.publicTests || {}), ...d });
  }

  /** Diagnostic structuré sur échec. */
  _diagnose(code, stepId, preflight, recorder, pipeline) {
    // On considère aussi les commandes en erreur de TRANSPORT (code null, ex.
    // connexion SSH perdue) et les commandes hors étape (sonde SSH du préflight).
    const allExecs = [...recorder.steps.values()].flatMap((s) => s.execs).concat(recorder.looseExecs || []);
    const failing = allExecs.filter((e) => e.code === null || (typeof e.code === 'number' && e.code !== 0));
    const lastExec = failing[failing.length - 1];
    const failedCheck = preflight?.failedChecks?.[0];
    const checks = [];
    if (stepId === 'ssh.connect') {
      // Conseil CIBLÉ selon le mode d'échec : une authentification refusée n'a
      // rien à voir avec le port/pare-feu (la connexion a réussi).
      const d = `${failedCheck?.detail || ''} ${lastExec?.stderr || ''}`.toLowerCase();
      if (/authentication|permission denied|methods failed/.test(d)) {
        checks.push(
          'La connexion au serveur a réussi mais l’AUTHENTIFICATION a été refusée : vérifiez d’abord le mot de passe root.',
          'Sur Ubuntu, la connexion root par MOT DE PASSE est souvent désactivée par défaut (PermitRootLogin prohibit-password). Dans /etc/ssh/sshd_config, mettez « PermitRootLogin yes » et « PasswordAuthentication yes », puis « sudo systemctl restart ssh ».'
        );
      } else if (/refus|refused|timeout|délai|unreach|injoignable|dns|introuvable|econnrefused|etimedout/.test(d)) {
        checks.push(
          'Le serveur n’a pas répondu : vérifiez l’adresse IP et le port SSH (22).',
          'Vérifiez que le pare-feu (hébergeur + ufw) autorise le port 22 depuis votre réseau.'
        );
      } else {
        checks.push('Vérifiez l’adresse IP, le port SSH (22), le mot de passe root et le pare-feu.');
      }
    } else if (stepId === 'dns.verify' || code === 'DNS_NOT_RESOLVED') {
      checks.push('Vérifiez que le domaine résout vers l’IP du VPS, ou activez la gestion automatique du domaine (Hostinger) dans DEV → Intégrations API.');
    } else if (stepId === 'dns.zone') {
      checks.push('Ce domaine n’est pas géré par le compte configuré. Vérifiez qu’il figure dans le portefeuille Hostinger, ou gérez le DNS manuellement.');
    } else if (stepId === 'dns.provider' || (code || '').startsWith('HOSTINGER_')) {
      checks.push('Vérifiez la clé API Hostinger (DEV → Intégrations API) et ses permissions DNS.');
    } else if (stepId === 'dns.read' && code === 'HOSTINGER_RECORD_CONFLICT') {
      checks.push('Un enregistrement existant entre en conflit. Comparez l’ancienne et la nouvelle valeur, puis confirmez la correction ou ajustez le DNS manuellement.');
    } else if (code === 'PREFLIGHT_FAILED') {
      checks.push('Vérifiez que le serveur dispose de Nginx, Node, PM2, Certbot et du certificat wildcard.');
    } else if ((code || '').startsWith('ARTIFACT_')) {
      // Échec de la construction LOCALE de l'artefact (vitrine/Manager).
      if (code === 'ARTIFACT_PATH_INVALID') {
        checks.push('Un projet local est introuvable ou incomplet (package.json / package-lock.json). Vérifiez la racine du dépôt et la présence des lockfiles.');
      } else {
        checks.push('La construction locale de l’artefact a échoué. Consultez la commande, le code de sortie et stderr dans la section « Pipeline → Préparation de la nouvelle version ».');
        checks.push('Le build s’exécute dans un staging isolé (npm ci + npm run build) ; un échec vient en général d’une dépendance manquante dans le lockfile ou d’une erreur TypeScript. Corrigez la source puis relancez.');
      }
    }
    if (code === 'HEALTH_PUBLIC_FAILED') checks.push('Vérifiez le DNS, le certificat HTTPS et que le port 443 est ouvert.');
    if (code === 'HEALTH_LOCAL_FAILED') {
      checks.push(
        'Le backend a démarré (PM2) puis n’a pas répondu : consultez ses logs PM2 dans la section « Vérification des services » (cause exacte de la sortie du process).',
        'Cause la plus fréquente : la base MongoDB est injoignable depuis le VPS. Si vous utilisez MongoDB Atlas, autorisez l’adresse IP publique du VPS dans « Network Access » (ou 0.0.0.0/0), puis relancez.',
        'Vérifiez aussi que le .env déployé est complet (MONGODB_URI, base, JWT_SECRET, clé de chiffrement) et que l’ENV est correct.'
      );
    }
    if (code === 'WILDCARD_CERT_MISSING') checks.push('Émettez une fois le certificat wildcard (challenge DNS-01) dans la zone du domaine.');
    return {
      code,
      failedStep: stepId,
      // Cause probable : le détail précis du contrôle échoué (ex. message SSH) ou
      // l'erreur du pipeline.
      probableCause: pipeline?.error?.message || failedCheck?.detail || failedCheck?.label || lastExec?.stderr || null,
      failingCommand: lastExec?.command || null,
      exitCode: lastExec?.code ?? null,
      stderr: lastExec?.stderr || null,
      thingsToCheck: checks,
      retryable: code !== 'UNSAFE_INPUT',
      remoteStateLeft: recorder.sections.remoteState,
      rollbackPerformed: false,
    };
  }

  /** DUPLICATION du projet courant. */
  async duplicate(input, { onLog, onPhase, stamp, destParent, runSeed } = {}) {
    return duplicateProject(input, {
      mongoUri: this.mongoUri,
      onLog,
      onPhase,
      stamp,
      destParent,
      runSeed,
    });
  }

  /** BACKUP d'une cible déployée. */
  async backup({ url, sessionId, dbName, version, stamp, remoteRoot, transport }) {
    const { tx, ephemeral } = this._transport(transport, sessionId);
    try {
      const target = this.parseUrl(url);
      return await createBackup({
        transport: tx,
        host: target.host,
        dbName,
        mongoUri: this.mongoUri,
        version,
        stamp,
        remoteRoot,
      });
    } finally {
      // On ferme la CONNEXION SSH (transport) mais PAS la session VPS : celle-ci
      // appartient au frontend (bannière « Serveur connecté » / Déconnecter) et au
      // TTL. Elle est PARTAGÉE entre préflight, déploiement et redéploiement — une
      // opération ne doit jamais laisser la suivante sans session.
      if (ephemeral) await tx?.close?.();
    }
  }

  /** RESTAURATION d'une cible depuis une archive. */
  async restore({ url, sessionId, dbName, archive, remoteRoot, transport }) {
    const { tx, ephemeral } = this._transport(transport, sessionId);
    try {
      const target = this.parseUrl(url);
      return await restoreBackup({
        transport: tx,
        host: target.host,
        dbName,
        mongoUri: this.mongoUri,
        archive,
        remoteRoot,
      });
    } finally {
      // On ferme la CONNEXION SSH (transport) mais PAS la session VPS : celle-ci
      // appartient au frontend (bannière « Serveur connecté » / Déconnecter) et au
      // TTL. Elle est PARTAGÉE entre préflight, déploiement et redéploiement — une
      // opération ne doit jamais laisser la suivante sans session.
      if (ephemeral) await tx?.close?.();
    }
  }

  /** Liste des archives de backup d'une cible. */
  async listBackups({ url, sessionId, transport }) {
    const { tx, ephemeral } = this._transport(transport, sessionId);
    try {
      const target = this.parseUrl(url);
      return await listBackups(tx, target.host);
    } finally {
      if (ephemeral) await tx.close?.();
    }
  }

  /**
   * Résout le transport à utiliser : soit celui injecté (tests/dry-run), soit
   * un transport SSH fabriqué depuis la session VPS en mémoire.
   * @returns {{tx:object, session:object|null, ephemeral:boolean}}
   */
  _transport(injected, sessionId) {
    if (injected) return { tx: injected, session: null, ephemeral: false };
    const session = sessionId ? getSession(sessionId) : null;
    if (!session) {
      throw new DeploymentError('NO_VPS_SESSION', 'Session VPS absente ou expirée.');
    }
    const tx = this.transportFactory(session);
    return { tx, session, ephemeral: true };
  }
}

/** Fabrique par défaut : transport SSH réel depuis les identifiants de session. */
function defaultTransportFactory(session) {
  return new SshTransport({
    host: session.host,
    username: session.username,
    password: session.password,
  });
}

export default DeploymentEngine;
