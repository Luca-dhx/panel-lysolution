/**
 * ENREGISTREUR d'exécution (RunRecorder).
 *
 * Accumule tout ce qui se passe pendant un déploiement — identification,
 * contexte local, DNS, SSH, prérequis, commandes distantes (avec exit code /
 * stdout / stderr), Nginx, HTTPS, services, tests publics, diagnostic — puis
 * produit un rapport structuré (JSON) exploitable pour générer du Markdown.
 *
 * Toutes les valeurs passent par le redacteur (aucun secret) et sont bornées en
 * taille (aucun risque de dépasser la limite BSON de MongoDB).
 */
import { canonicalStep, CANONICAL_ORDER } from '../steps.js';

const REPORT_VERSION = '1.0';

const DEFAULT_LIMITS = {
  maxStdout: 3000,
  maxStderr: 3000,
  maxCommand: 600,
  maxExecs: 250,
  maxWarnings: 100,
};

export class RunRecorder {
  /**
   * @param {object} args
   * @param {import('./sanitize.js').createRedactor} args.redactor
   * @param {object} args.identification
   * @param {object} [args.limits]
   */
  constructor({ redactor, identification, limits = {} }) {
    this.redactor = redactor;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.id = { reportVersion: REPORT_VERSION, ...identification };
    this.steps = new Map(); // canonicalId -> step record
    this.looseExecs = [];
    this.execCount = 0;
    this.currentStep = null;
    this.warnings = [];
    this.sections = {
      context: {},
      dns: null,
      ssh: null,
      prereqs: [],
      hostinger: null,
      nginx: {},
      https: {},
      services: {},
      publicTests: {},
      remoteState: { created: [], modified: [], started: [], rollback: null, notes: [] },
      diagnosis: {},
    };
    this.finalStatus = 'running';
    this.finalStepId = null;
    this.errorSummary = null;
    this.finishedAt = null;
  }

  /* ------------------------------ Étapes ------------------------------ */

  setCurrentStep(canonicalId) {
    this.currentStep = canonicalId;
    return canonicalId;
  }

  _ensureStep(canonicalId) {
    let s = this.steps.get(canonicalId);
    if (!s) {
      const meta = canonicalStep(canonicalId);
      s = {
        id: canonicalId,
        label: meta.label,
        order: CANONICAL_ORDER.indexOf(canonicalId),
        critical: meta.critical,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        publicMessage: null,
        technicalMessage: null,
        errorCode: null,
        retryable: null,
        execs: [],
        warnings: [],
      };
      this.steps.set(canonicalId, s);
    }
    return s;
  }

  markStep(canonicalId, patch = {}) {
    const s = this._ensureStep(canonicalId);
    if (patch.status === 'running' && !s.startedAt) s.startedAt = iso();
    if (['ok', 'error', 'warning', 'skipped', 'cancelled'].includes(patch.status)) {
      s.finishedAt = iso();
      if (s.startedAt) s.durationMs = new Date(s.finishedAt) - new Date(s.startedAt);
    }
    if (patch.durationMs != null) s.durationMs = patch.durationMs;
    if (patch.publicMessage !== undefined) s.publicMessage = this.redactor.redactString(patch.publicMessage);
    if (patch.technicalMessage !== undefined) s.technicalMessage = this.redactor.redactString(patch.technicalMessage);
    if (patch.errorCode !== undefined) s.errorCode = patch.errorCode;
    if (patch.retryable !== undefined) s.retryable = patch.retryable;
    if (patch.status) s.status = patch.status;
    return s;
  }

  /* --------------------------- Commandes distantes --------------------------- */

  recordExec(command, res) {
    if (this.execCount >= this.limits.maxExecs) return;
    this.execCount += 1;
    const entry = {
      step: this.currentStep,
      command: this.redactor.redactCommand(truncate(command, this.limits.maxCommand)),
      code: res?.code ?? null,
      stdout: truncate(this.redactor.redactString(res?.stdout || ''), this.limits.maxStdout),
      stderr: truncate(this.redactor.redactString(res?.stderr || ''), this.limits.maxStderr),
      at: iso(),
    };
    const step = this.currentStep && this.steps.get(this.currentStep);
    if (step) step.execs.push(entry);
    else this.looseExecs.push(entry);
  }

  recordFileWrite(remotePath) {
    this.sections.remoteState.modified.push(this.redactor.redactString(String(remotePath)));
  }

  /* ------------------------------ Sections ------------------------------ */

  setContext(ctx) {
    this.sections.context = this.redactor.redactValue(ctx);
  }
  setDns(dns) {
    this.sections.dns = this.redactor.redactValue(dns);
  }
  setSsh(ssh) {
    // Jamais de mot de passe : on ne stocke que hôte/port/utilisateur/méthode/durée/résultat.
    const { password, ...safe } = ssh || {};
    void password;
    this.sections.ssh = this.redactor.redactValue({ authMethod: 'password', ...safe });
  }
  setPrereqs(checks) {
    this.sections.prereqs = (checks || []).map((c) => this.redactor.redactValue(c));
  }
  /** Section fournisseur DNS (Hostinger…) — sans secret (redigée). */
  setHostinger(info) {
    this.sections.hostinger = this.redactor.redactValue(info);
  }
  setNginx(info) {
    this.sections.nginx = this.redactor.redactValue(info);
  }
  setHttps(info) {
    this.sections.https = this.redactor.redactValue(info);
  }
  setServices(info) {
    this.sections.services = this.redactor.redactValue(info);
  }
  setPublicTests(info) {
    this.sections.publicTests = this.redactor.redactValue(info);
  }
  noteRemote(kind, value) {
    if (this.sections.remoteState[kind]) this.sections.remoteState[kind].push(this.redactor.redactString(String(value)));
  }
  setRollback(info) {
    this.sections.remoteState.rollback = this.redactor.redactValue(info);
  }
  addWarning(message, stepId = this.currentStep) {
    if (this.warnings.length >= this.limits.maxWarnings) return;
    const w = { step: stepId, message: this.redactor.redactString(message), at: iso() };
    this.warnings.push(w);
    const s = stepId && this.steps.get(stepId);
    if (s) s.warnings.push(w.message);
  }
  setDiagnosis(diag) {
    this.sections.diagnosis = this.redactor.redactValue(diag);
  }

  /* ------------------------------ Finalisation ------------------------------ */

  finalize({ status, finalStepId, errorSummary } = {}) {
    this.finalStatus = status || this.finalStatus;
    this.finalStepId = finalStepId ?? this.finalStepId;
    this.finishedAt = iso();
    if (errorSummary) this.errorSummary = this.redactor.redactValue(errorSummary);
    // Toute étape restée "running" à la fin d'un échec est marquée en conséquence.
    for (const s of this.steps.values()) {
      if (s.status === 'running') {
        s.status = status === 'ok' ? 'ok' : 'error';
        s.finishedAt = s.finishedAt || iso();
      }
    }
    return this;
  }

  orderedSteps() {
    return [...this.steps.values()].sort((a, b) => {
      const oa = a.order < 0 ? 999 : a.order;
      const ob = b.order < 0 ? 999 : b.order;
      return oa - ob;
    });
  }

  durationMs() {
    if (!this.id.startedAt || !this.finishedAt) return null;
    return new Date(this.finishedAt) - new Date(this.id.startedAt);
  }

  /** Rapport structuré (JSON) borné et sans secret. */
  toStructured() {
    return {
      reportVersion: REPORT_VERSION,
      identification: {
        ...this.id,
        finishedAt: this.finishedAt,
        durationMs: this.durationMs(),
        result: this.finalStatus,
        finalStepId: this.finalStepId,
      },
      context: this.sections.context,
      dns: this.sections.dns,
      ssh: this.sections.ssh,
      prereqs: this.sections.prereqs,
      hostinger: this.sections.hostinger,
      steps: this.orderedSteps(),
      looseExecs: this.looseExecs,
      nginx: this.sections.nginx,
      https: this.sections.https,
      services: this.sections.services,
      publicTests: this.sections.publicTests,
      remoteState: this.sections.remoteState,
      warnings: this.warnings,
      diagnosis: this.sections.diagnosis,
      errorSummary: this.errorSummary,
    };
  }
}

function iso() {
  return new Date().toISOString();
}

export function truncate(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  const tail = Math.floor(max * 0.3);
  return `${s.slice(0, head)}\n…[${s.length - head - tail} caractères tronqués]…\n${s.slice(-tail)}`;
}

export default RunRecorder;
