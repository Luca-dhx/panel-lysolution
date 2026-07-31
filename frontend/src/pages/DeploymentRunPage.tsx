// SUIVI D'UN DÉPLOIEMENT — Phase 4.
//
// L'écran que l'opérateur regarde pendant que ça se passe, puis relit après.
// Trois choses, dans cet ordre : où on en est, ce qui a été fait, le rapport.
//
// ── POURQUOI DU SONDAGE, ET PAS UN FLUX ─────────────────────────────────────
// SB Auto 06 diffuse ses étapes en NDJSON sur une connexion ouverte. C'est
// plus élégant, et ce serait FAUX ici : le Panel peut se déployer LUI-MÊME,
// et le flux se couperait au moment précis où il redémarre — c'est-à-dire
// juste avant le contrôle de santé et la vérification publique, les deux
// étapes qu'on attend le plus.
//
// L'exécution vit donc dans un processus détaché qui écrit son avancement en
// base ; cet écran relit ce document. Une requête échoue pendant le
// redémarrage, la suivante réussit, l'affichage reprend. C'est ce que le
// sondage donne gratuitement et qu'un flux ne donne pas.
//
// Divergence assumée avec SB Auto 06, et documentée en 60_PANEL_DEPLOYMENT.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { deployment as api, errorMessage } from '@/lib/api';
import type { DeploymentRun, RunStep } from '@/types.deployment';
import { RunBadge, operationLabel } from '@/pages/DeploymentPage';

/** Cadence de sondage pendant qu'une opération tourne. */
const POLL_MS = 2000;

const STEP_MARKS: Record<string, string> = {
  pending: '·', running: '⟳', ok: '✓', warning: '!', error: '✗', skipped: '–',
};
const stepMark = (status: string) => STEP_MARKS[status] ?? '·';

export function DeploymentRunPage() {
  const { runId = '' } = useParams();
  const [run, setRun] = useState<DeploymentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Une coupure momentanée n'est PAS une erreur quand le Panel se déploie
  // lui-même : c'est le symptôme attendu. On la distingue d'un vrai échec.
  const [unreachable, setUnreachable] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const currentRef = useRef<HTMLLIElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.run(runId);
      setRun(data);
      setUnreachable(false);
      setError(null);
    } catch (err) {
      const message = errorMessage(err, '');
      if (/introuvable|inconnue/i.test(message)) setError(message);
      else setUnreachable(true);
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  // Sondage tant que l'opération tourne — ou tant que le backend est absent,
  // précisément parce qu'il est peut-être en train de redémarrer.
  useEffect(() => {
    const active = run === null || run.status === 'running' || unreachable;
    if (!active) return undefined;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [run, unreachable, load]);

  // L'étape en cours reste visible : sur dix-huit lignes, elle sortirait de
  // l'écran au bout de quelques minutes.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [run?.steps.filter((s) => s.status === 'running')[0]?.id]);

  const copyReport = async () => {
    if (!run?.markdownReport) return;
    try {
      await navigator.clipboard.writeText(run.markdownReport);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Presse-papiers refusé (contexte non sécurisé) : le rapport reste
      // affiché et sélectionnable à la main.
      setError('Copie automatique refusée par le navigateur. Le rapport reste sélectionnable ci-dessous.');
    }
  };

  if (error && !run) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
        <p><Link to="/deployment">← Déploiement</Link></p>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <p className="muted">Chargement de l’exécution…</p>
        {unreachable ? (
          <p className="mode-notice mode-execution">
            Le backend du Panel ne répond pas. S’il s’agit d’un déploiement du
            Panel lui-même, c’est attendu : il redémarre. Cette page se
            reconnectera seule.
          </p>
        ) : null}
      </div>
    );
  }

  const running = run.status === 'running';
  const current = run.steps.find((s) => s.status === 'running') ?? null;

  return (
    <div className="page">
      <p className="breadcrumb">
        <Link to="/deployment">← Déploiement</Link>
        {' · '}
        <Link to={`/deployment/${run.targetId}`}>{run.targetName}</Link>
      </p>

      <header className="page-head">
        <h1>{operationLabel(run.operationType)}</h1>
        <div className="execution-head">
          <RunBadge status={run.status} />
          <span className={`badge badge-${run.environment === 'PROD' ? 'danger' : 'neutral'}`}>
            {run.environment}
          </span>
          {run.selfDeployment ? <span className="badge badge-warn">auto-déploiement</span> : null}
        </div>
      </header>

      {unreachable ? (
        <p className="mode-notice mode-execution">
          Le backend ne répond pas actuellement.{' '}
          {run.selfDeployment
            ? 'C’est attendu : ce déploiement redémarre le Panel. L’opération se poursuit dans son processus séparé.'
            : 'La page se reconnectera automatiquement.'}
        </p>
      ) : null}

      {run.selfDeployment && running ? (
        <p className="mode-notice mode-execution">
          <strong>Ce déploiement met à jour le Panel que vous utilisez.</strong>{' '}
          Son backend va redémarrer. Vous pouvez fermer cette page : l’opération
          continue, et son issue sera ici à votre retour.
        </p>
      ) : null}

      {/* — OÙ ON EN EST ————————————————————————————————— */}
      <Card title={running ? 'Déploiement en cours' : 'Résultat'}>
        <div className="deploy-progress">
          <div className="deploy-progress-bar" role="img"
            aria-label={`Avancement : ${run.progress.percent} %`}>
            <div
              className={`deploy-progress-fill deploy-fill-${run.status}`}
              style={{ width: `${Math.max(2, run.progress.percent)}%` }}
            />
          </div>
          <p className="deploy-progress-label">
            {running ? (
              <>
                <span className="deploy-spinner" aria-hidden>⟳</span>{' '}
                {current ? current.label : 'Préparation…'}
                <span className="muted"> — {run.progress.done}/{run.progress.total} étapes</span>
              </>
            ) : (
              <>{run.progress.done}/{run.progress.total} étapes · {run.progress.percent} %</>
            )}
          </p>
        </div>

        {!running ? (
          <>
            <p className={`mode-notice ${run.status === 'ok' ? 'mode-simulation' : 'mode-execution'}`}>
              {run.summary ?? 'Aucun résumé.'}
            </p>
            {run.status === 'ok' && run.deployedUrl ? (
              <p>
                <a href={run.deployedUrl} target="_blank" rel="noreferrer" className="btn">
                  Ouvrir {run.deployedUrl} ↗
                </a>
              </p>
            ) : null}
          </>
        ) : null}
      </Card>

      {/* — LA CHECKLIST ————————————————————————————————— */}
      <Card title={`Étapes (${run.steps.length})`}>
        <ol className="deploy-steps">
          {run.steps.map((step) => (
            <li
              key={step.id}
              ref={step.status === 'running' ? currentRef : null}
              className={`deploy-step deploy-${step.status}`}
            >
              <span className={`deploy-step-mark${step.status === 'running' ? ' deploy-spinner' : ''}`} aria-hidden>
                {stepMark(step.status)}
              </span>
              <span className="deploy-step-label">{step.label}</span>
              <span className="deploy-step-message">{step.message ?? ''}</span>
              <span className="deploy-step-duration muted">
                {step.durationMs !== null ? `${(step.durationMs / 1000).toFixed(1)} s` : ''}
              </span>
            </li>
          ))}
        </ol>
        <p className="muted read-only-note">
          Ces étapes sont celles du moteur de déploiement — les mêmes que pour
          un projet vitrine. Aucune n’est déclenchée à la main : le déploiement
          les enchaîne.
        </p>
      </Card>

      {/* — LE RAPPORT ————————————————————————————————— */}
      {run.markdownReport ? (
        <Card title="Rapport complet">
          <p className="muted">
            Identité, configuration déduite, checklist détaillée, journaux,
            validations finales et verdict. Les secrets y sont masqués : il
            peut être transmis tel quel.
          </p>
          <div className="action-buttons">
            <button type="button" className="btn" onClick={() => void copyReport()}>
              {copied ? 'Rapport copié ✓' : 'Copier le rapport complet'}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? 'Masquer le rapport' : 'Afficher le rapport'}
            </button>
          </div>
          {error ? <div className="alert alert-warning">{error}</div> : null}
          {showDetails ? (
            <pre className="deploy-report">{run.markdownReport}</pre>
          ) : null}
        </Card>
      ) : running ? null : (
        <Card title="Rapport complet">
          <p className="muted">
            Aucun rapport : cette opération n’en produit pas, ou s’est
            interrompue avant sa génération. Le journal ci-dessous reste
            disponible.
          </p>
        </Card>
      )}

      {/* — LE DÉTAIL, replié ——————————————————————————— */}
      <Disclosure title="Détails de l’exécution">
        <DetailList
          items={[
            ['Identifiant', <code key="id">{run.runId}</code>],
            ['Destination', run.targetName ?? '—'],
            ['URL', run.deployedUrl ?? run.url ?? '—'],
            ['Version', run.version ?? <span className="muted">—</span>],
            ['Release', run.releaseId ?? <span className="muted">—</span>],
            ['Démarrée', run.startedAt],
            ['Terminée', run.finishedAt ?? <span className="muted">en cours</span>],
            ['Durée', run.durationMs !== null ? `${Math.round(run.durationMs / 1000)} s` : <span className="muted">—</span>],
            ['Lancée par', run.user ?? '—'],
          ]}
        />
        {run.error ? (
          <>
            <div className="alert alert-error">{run.error.message}</div>
            <p className="muted">
              Code : <code>{run.error.code}</code>
              {run.error.step ? ` · étape « ${stepLabel(run.steps, run.error.step)} »` : ''}
            </p>
          </>
        ) : null}
      </Disclosure>

      <Disclosure title={`Journal technique (${run.log.length} lignes)`}>
        {run.log.length === 0 ? (
          <p className="muted">Aucune ligne de journal.</p>
        ) : (
          <div className="deploy-log">
            {run.log.map((entry, index) => (
              <div key={index} className={`log-${entry.level.toLowerCase()}`}>
                <time className="log-at">{entry.at.slice(11, 19)}</time>
                <span className="log-message">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
        <p className="muted read-only-note">
          Ce journal est écrit en base par le processus de déploiement, pas
          diffusé par une connexion ouverte : il survit au redémarrage du
          Panel et reste consultable des semaines plus tard.
        </p>
      </Disclosure>
    </div>
  );
}

/** Libellé métier d'une étape à partir de son identifiant. */
function stepLabel(steps: RunStep[], id: string): string {
  return steps.find((s) => s.id === id)?.label ?? id;
}
