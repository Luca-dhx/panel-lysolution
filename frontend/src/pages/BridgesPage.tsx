import { Card, EmptyState, StatusBadge } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { useProjects } from '@/lib/useProjects';

export function BridgesPage() {
  const { projects, loading, error } = useProjects();

  return (
    <div className="page">
      <header className="page-header">
        <h1>Bridges</h1>
        <p className="page-description">État des ponts entre le Panel et les backends clients.</p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {loading ? (
        <p className="muted">Chargement des projets…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Aucun projet dans le parc"
          hint="Déclarez un projet depuis la page Projets pour suivre son pont ici."
        />
      ) : (
        <Card>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Projet</th>
                  <th>Vivacité</th>
                  <th>Dernier heartbeat</th>
                  <th>Santé</th>
                  <th>Outbox</th>
                  <th>URL backend</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.projectId}>
                    <td>
                      <span className="cell-primary">{project.projectName}</span>
                      <span className="cell-secondary">{project.projectKey}</span>
                    </td>
                    <td>
                      <StatusBadge kind="liveness" value={project.liveness} />
                    </td>
                    <td>{formatRelative(project.runtime.lastHeartbeatAt)}</td>
                    <td>
                      {project.runtime.lastHealth ? (
                        <>
                          <StatusBadge kind="health" value={project.runtime.lastHealth.status} />
                          {project.runtime.lastHealth.details ? (
                            <span className="cell-secondary">
                              {project.runtime.lastHealth.details}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {project.runtime.bridgeStats?.outboxSize !== undefined ? (
                        project.runtime.bridgeStats.outboxSize
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {project.runtime.publicBackendUrl ? (
                        <code className="inline-code">{project.runtime.publicBackendUrl}</code>
                      ) : (
                        <span className="muted">pull-only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
