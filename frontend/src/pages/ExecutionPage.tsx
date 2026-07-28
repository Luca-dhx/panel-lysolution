// FICHE D'UNE EXÉCUTION — Phase 3C, niveaux 2 et 3.
//
// C'est l'écran d'AUDIT : qui a demandé quoi, quand, validé comment,
// confirmé par qui, avec quel résultat. Tout ce qui s'y affiche vient du
// document persisté — rien n'est reconstitué côté navigateur.
//
// C'est aussi le seul endroit où l'on confirme. La confirmation est un acte
// distinct de la demande : elle a sa page, son commentaire, sa trace.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import {
  CheckList, DenialList, LogView, ModeBadge, ModeNotice, PlanList, StateBadge, duration,
} from '@/components/execution';
import { executions as api, errorMessage } from '@/lib/api';
import type { Execution } from '@/types.execution';

export function ExecutionPage() {
  const { executionId = '' } = useParams();
  const [execution, setExecution] = useState<Execution | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setExecution(await api.detail(executionId));
    } catch (err) {
      setError(errorMessage(err, 'Exécution introuvable.'));
    }
  }, [executionId]);

  useEffect(() => { void load(); }, [load]);

  const act = (fn: () => Promise<Execution>) => {
    setBusy(true);
    setError(null);
    fn()
      .then(setExecution)
      .catch((err) => setError(errorMessage(err, 'Opération refusée.')))
      .finally(() => setBusy(false));
  };

  if (error && !execution) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
        <p><Link to="/actions">← Retour aux actions</Link></p>
      </div>
    );
  }
  if (!execution) return <div className="page"><p className="muted">Chargement…</p></div>;

  const approvals = execution.confirmations.filter((c) => c.decision === 'APPROVED').length;
  const awaiting = execution.state === 'WAITING_CONFIRMATION';
  const cancellable = ['CREATED', 'WAITING_CONFIRMATION', 'QUEUED', 'RUNNING'].includes(execution.state);

  return (
    <div className="page">
      <header className="page-head">
        <h1>{execution.type}</h1>
        <div className="execution-head">
          <StateBadge value={execution.state} />
          <ModeBadge value={execution.mode} />
          <span className="muted">{duration(execution.durationMs)}</span>
        </div>
        <p>
          <Link to="/actions">← Actions</Link>
          {execution.projectId ? (
            <>
              {' · '}
              <Link to={`/supervision/${execution.projectId}`}>{execution.projectName}</Link>
            </>
          ) : null}
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}
      <ModeNotice mode={execution.mode} />

      {/* — Ce qui a été demandé ————————————————————————— */}
      <Card title="Demande">
        <DetailList
          items={[
            ['Demandée par', execution.initiator.userEmail ?? execution.initiator.userId],
            ['Rôle', execution.initiator.role ?? '—'],
            ['Cible', execution.projectName ?? 'Panel'],
            ['Environnement', execution.environment ?? '—'],
            ['Créée le', execution.createdAt],
            ['Démarrée le', execution.startedAt ?? '—'],
            ['Terminée le', execution.finishedAt ?? '—'],
            ['Délai maximal', execution.timeoutMs ? `${Math.round(execution.timeoutMs / 1000)} s` : '—'],
            ['Paramètres', Object.keys(execution.parameters).length
              ? <code>{JSON.stringify(execution.parameters)}</code>
              : <span className="muted">aucun</span>],
          ]}
        />
      </Card>

      {/* — Ce que la validation a conclu ————————————————— */}
      {execution.validation ? (
        <Card title="Validation">
          {execution.validation.ok ? (
            <p className="alert alert-success">{execution.validation.summary}</p>
          ) : (
            <DenialList denials={execution.validation.denials} />
          )}
          <Disclosure title={`Détail des contrôles (${execution.validation.checks.length})`}>
            <CheckList checks={execution.validation.checks} />
          </Disclosure>
        </Card>
      ) : null}

      {/* — Confirmation ————————————————————————————————— */}
      {execution.confirmationsRequired > 0 ? (
        <Card title={`Confirmation (${approvals}/${execution.confirmationsRequired})`}>
          {execution.confirmations.length > 0 ? (
            <ul className="confirmation-list">
              {execution.confirmations.map((c, index) => (
                <li key={index}>
                  <span className={`badge badge-${c.decision === 'APPROVED' ? 'ok' : 'danger'}`}>
                    {c.decision === 'APPROVED' ? 'Approuvée' : 'Refusée'}
                  </span>
                  <span>{c.userEmail ?? c.userId}</span>
                  <span className="muted">{c.at}</span>
                  {c.comment ? <span className="confirmation-comment">« {c.comment} »</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Aucune décision enregistrée pour l’instant.</p>
          )}

          {awaiting ? (
            <>
              <label className="field">
                <span className="field-label">Commentaire (conservé dans l’audit)</span>
                <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
              </label>
              <div className="action-buttons">
                <button
                  type="button" className="btn btn-danger" disabled={busy}
                  onClick={() => act(() => api.confirm(executionId, 'APPROVED', comment || undefined))}
                >
                  Approuver et lancer
                </button>
                <button
                  type="button" className="btn" disabled={busy}
                  onClick={() => act(() => api.confirm(executionId, 'REJECTED', comment || undefined))}
                >
                  Refuser
                </button>
              </div>
            </>
          ) : null}
        </Card>
      ) : null}

      {/* — Résultat ————————————————————————————————————— */}
      <Card title="Résultat">
        {execution.error ? (
          <>
            <div className="alert alert-error">{execution.error.message}</div>
            <p className="muted">Code : <code>{execution.error.code}</code></p>
          </>
        ) : execution.result ? (
          <p>{execution.result.summary}</p>
        ) : (
          <p className="muted">Aucun résultat : l’exécution n’est pas allée jusque-là.</p>
        )}

        {execution.result?.consequences ? (
          <div className="denial-block">
            <p className="denial-title">Conséquences déclarées</p>
            <ul className="denial-list">
              {execution.result.consequences.map((c) => (
                <li key={c.secret}>
                  <span className="denial-message"><strong>{c.secret}</strong> — {c.consequence}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {execution.result?.plan?.length ? (
          <Disclosure title={`Plan (${execution.result.plan.length} étapes)`}>
            <PlanList steps={execution.result.plan} />
          </Disclosure>
        ) : null}

        {cancellable ? (
          <div className="action-buttons">
            <button
              type="button" className="btn btn-small" disabled={busy}
              onClick={() => act(() => api.cancel(executionId))}
            >
              {execution.state === 'RUNNING' ? 'Demander l’annulation' : 'Annuler'}
            </button>
            {execution.state === 'RUNNING' ? (
              <span className="muted">
                Une exécution en cours n’est jamais interrompue brutalement :
                l’annulation prend effet à la prochaine étape.
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* — Niveau 3 : la trace complète ———————————————————— */}
      <Disclosure title={`Parcours d’états (${execution.stateHistory.length})`}>
        <ol className="state-history">
          {execution.stateHistory.map((step, index) => (
            <li key={index}>
              <span className="state-transition">
                {step.from ? `${step.from} → ` : ''}{step.to}
              </span>
              <span className="muted">{step.at}</span>
              <span className="state-reason">{step.reason}</span>
            </li>
          ))}
        </ol>
      </Disclosure>

      <Disclosure title={`Journal d’exécution (${execution.log.length} entrées)`}>
        <LogView entries={execution.log} />
        <p className="muted read-only-note">
          Les secrets sont masqués à l’écriture : ce journal peut être exporté tel quel.
        </p>
      </Disclosure>
    </div>
  );
}
