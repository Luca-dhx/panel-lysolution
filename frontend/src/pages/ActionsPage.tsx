// VUE ACTIONS — Phase 3C, LOT 8.
//
// Divulgation progressive, comme partout dans le Panel :
//   niveau 0 — quelques compteurs ;
//   niveau 1 — ce qui tourne, puis l'historique ;
//   niveau 2 — la fiche d'une exécution (page dédiée) ;
//   niveau 3 — son journal complet, déplié à la demande.
//
// Aucun bouton de lancement ici : une action se prépare depuis un projet,
// jamais depuis une liste. Cette page OBSERVE le pilotage, elle ne le
// déclenche pas.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { Metric } from '@/components/supervision';
import { ModeBadge, StateBadge, duration } from '@/components/execution';
import { executions as api, errorMessage } from '@/lib/api';
import type { ExecutionRow, ExecutionStats } from '@/types.execution';

const STATES = [
  'WAITING_CONFIRMATION', 'QUEUED', 'RUNNING',
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'ROLLED_BACK',
];

export function ActionsPage() {
  const [search, setSearch] = useSearchParams();
  const [stats, setStats] = useState<ExecutionStats | null>(null);
  const [queue, setQueue] = useState<ExecutionRow[]>([]);
  const [history, setHistory] = useState<ExecutionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const projectId = search.get('projectId') ?? '';
  const state = search.get('state') ?? '';
  const mode = search.get('mode') ?? '';

  const load = useCallback(async () => {
    try {
      const [s, q, h] = await Promise.all([
        api.stats(),
        api.queue(),
        api.history({ projectId, state, mode }),
      ]);
      setStats(s);
      setQueue(q.items);
      setHistory(h.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Historique des exécutions indisponible.'));
    }
  }, [projectId, state, mode]);

  useEffect(() => { void load(); }, [load]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearch(next);
  };

  if (error) return <div className="page"><div className="alert alert-error">{error}</div></div>;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Actions</h1>
        <p className="muted">
          Toute opération pilotée par le Panel apparaît ici, du premier contrôle
          à son dénouement. Une action se lance depuis la fiche d’un projet.
        </p>
      </header>

      {/* — Niveau 0 ————————————————————————————————————— */}
      {stats ? (
        <div className="metric-row">
          <Metric value={stats.total} label="exécutions" />
          <Metric value={stats.active} label="en cours ou en attente" tone={stats.active > 0 ? 'warn' : undefined} />
          <Metric value={stats.byState.SUCCEEDED} label="réussies" tone="ok" />
          <Metric
            value={stats.byState.FAILED + stats.byState.TIMEOUT}
            label="en échec"
            tone={stats.byState.FAILED + stats.byState.TIMEOUT > 0 ? 'danger' : undefined}
          />
        </div>
      ) : null}

      {/* — Niveau 1a : ce qui tourne ————————————————————————— */}
      <Card title={`En cours et en attente${queue.length ? ` (${queue.length})` : ''}`}>
        {queue.length === 0 ? (
          <p className="muted">Rien en cours. Le parc est au repos.</p>
        ) : (
          <ExecutionTable rows={queue} />
        )}
      </Card>

      {/* — Niveau 1b : l'historique ——————————————————————— */}
      <Card title="Historique">
        <div className="filter-row">
          <label className="filter">
            <span className="filter-label">État</span>
            <select value={state} onChange={(e) => setFilter('state', e.target.value)}>
              <option value="">tous</option>
              {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="filter">
            <span className="filter-label">Mode</span>
            <select value={mode} onChange={(e) => setFilter('mode', e.target.value)}>
              <option value="">tous</option>
              <option value="SIMULATION">Simulation</option>
              <option value="EXECUTION">Exécution réelle</option>
            </select>
          </label>
          {projectId ? (
            <button type="button" className="btn btn-small" onClick={() => setFilter('projectId', '')}>
              Retirer le filtre projet
            </button>
          ) : null}
        </div>

        {history.length === 0 ? (
          <EmptyState
            title="Aucune exécution"
            hint="Les actions se préparent depuis la fiche d’un projet, onglet « Piloter »."
          />
        ) : (
          <ExecutionTable rows={history} />
        )}
      </Card>
    </div>
  );
}

/** Ligne d'exécution — pauvre à dessein : de quoi lister, trier, cliquer. */
function ExecutionTable({ rows }: { rows: ExecutionRow[] }) {
  return (
    <div className="table-scroll">
    <table className="data-table">
      <thead>
        <tr>
          <th>Action</th>
          <th>Projet</th>
          <th>Mode</th>
          <th>État</th>
          <th>Confirmations</th>
          <th>Durée</th>
          <th>Demandée par</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.executionId}>
            <td>{row.type}</td>
            <td>
              {row.projectId
                ? <Link to={`/supervision/${row.projectId}`}>{row.projectName}</Link>
                : <span className="muted">Panel</span>}
            </td>
            <td><ModeBadge value={row.mode} /></td>
            <td><StateBadge value={row.state} /></td>
            <td>{row.confirmations}</td>
            <td>{duration(row.durationMs)}</td>
            <td className="muted">{row.initiator ?? '—'}</td>
            <td><Link to={`/actions/${row.executionId}`}>Détail →</Link></td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
