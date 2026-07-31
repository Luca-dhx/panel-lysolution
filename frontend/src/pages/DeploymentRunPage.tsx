// SUIVI D'UNE EXÉCUTION — Phase 4.
//
// ── POURQUOI DU SONDAGE, ET PAS UN FLUX TEMPS RÉEL ──────────────────────────
// Un flux HTTP ouvert (SSE, NDJSON) serait plus élégant. Il serait aussi
// FAUX ici : quand le Panel se déploie lui-même, son backend redémarre, et le
// flux se coupe au moment le plus intéressant — l'opérateur verrait une
// erreur réseau alors que sa mise en ligne se termine normalement.
//
// L'exécution vit dans un processus détaché qui écrit son avancement en base.
// Cet écran interroge donc ce document en boucle. Quand le backend redémarre,
// une requête échoue, la suivante réussit, et l'affichage reprend là où il en
// était. C'est ce que le sondage donne gratuitement et qu'un flux ne donne
// pas.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import { DetailList } from '@/components/supervision';
import { deployment as api, errorMessage } from '@/lib/api';
import type { DeploymentRun } from '@/types.deployment';
import { RunBadge, operationLabel } from '@/pages/DeploymentPage';

/** Cadence de sondage pendant qu'une opération tourne. */
const POLL_MS = 2000;

/** Marqueur d'étape — table exhaustive, repli explicite pour « en attente ». */
const STEP_MARKS: Record<string, string> = {
  pending: '·', running: '…', ok: '✓', warning: '!', error: '✗', skipped: '–',
};
const stepMark = (status: string) => STEP_MARKS[status] ?? '·';

export function DeploymentRunPage() {
  const { runId = '' } = useParams();
  const [run, setRun] = useState<DeploymentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Une coupure momentanée n'est PAS une erreur quand le Panel se déploie
  // lui-même : c'est le symptôme attendu. On la distingue d'un vrai échec.
  const [unreachable, setUnreachable] = useState(false);
  const logEnd = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.run(runId);
      setRun(data);
      setUnreachable(false);
      setError(null);
      return data;
    } catch (err) {
      // 404 = le run n'existe pas : c'est une vraie erreur.
      // Réseau = le backend redémarre probablement : on patiente.
      const message = errorMessage(err, '');
      if (/introuvable|inconnue/i.test(message)) setError(message);
      else setUnreachable(true);
      return null;
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

  // Le journal suit l'avancement : on reste en bas tant que ça défile.
  useEffect(() => {
    if (run?.status === 'running') logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [run?.log.length, run?.status]);

  if (error) {
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
          <span className={`badge badge-${run.environment === 'PROD' ? 'danger' : 'neutral'}`}>{run.environment}</span>
          {run.selfDeployment ? <span className="badge badge-warn">auto-déploiement</span> : null}
          {running ? <span className="muted">actualisation automatique…</span> : null}
        </div>
      </header>

      {/* Le backend est absent : on rassure au lieu d'alarmer. */}
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

      {/* — Le dénouement, en haut : c'est ce qu'on vient chercher ————— */}
      <Card title="Résultat">
        {running ? (
          <p className="muted">Opération en cours…</p>
        ) : (
          <>
            <p className={`mode-notice ${run.status === 'ok' ? 'mode-simulation' : 'mode-execution'}`}>
              {run.summary ?? 'Aucun résumé.'}
            </p>
            {run.error ? (
              <p className="muted">Code : <code>{run.error.code}</code>{run.error.step ? ` · étape « ${run.error.step} »` : ''}</p>
            ) : null}
          </>
        )}
        <DetailList
          items={[
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
        {run.status === 'ok' && run.deployedUrl ? (
          <p>
            <a href={run.deployedUrl} target="_blank" rel="noreferrer" className="btn btn-small">
              Ouvrir {run.deployedUrl} ↗
            </a>
          </p>
        ) : null}
      </Card>

      {/* — Les étapes ——————————————————————————————————— */}
      <Card title={`Étapes (${run.steps.length})`}>
        {run.steps.length === 0 ? (
          <p className="muted">Aucune étape encore enregistrée.</p>
        ) : (
          <ol className="deploy-steps">
            {run.steps.map((step) => (
              <li key={step.id} className={`deploy-step deploy-${step.status}`}>
                <span className="deploy-step-mark" aria-hidden>{stepMark(step.status)}</span>
                <span className="deploy-step-label">{step.label}</span>
                <span className="deploy-step-message">{step.message ?? ''}</span>
                <span className="deploy-step-duration muted">
                  {step.durationMs !== null ? `${(step.durationMs / 1000).toFixed(1)} s` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* — Le journal ———————————————————————————————————— */}
      <Card title={`Journal (${run.log.length} lignes)`}>
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
            <div ref={logEnd} />
          </div>
        )}
        <p className="muted read-only-note">
          Ce journal est écrit en base par le processus de déploiement, pas
          diffusé par une connexion ouverte : il survit au redémarrage du
          Panel, et reste consultable des semaines plus tard.
        </p>
      </Card>
    </div>
  );
}
