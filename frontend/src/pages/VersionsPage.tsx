import { Card, EmptyState } from '@/components/ui';
import { majorVersion } from '@/lib/format';
import { usePanelVersion } from '@/lib/usePanelVersion';
import { useProjects } from '@/lib/useProjects';
import type { PublicProject } from '@/types';

type RowState = 'ok' | 'never-seen' | 'contract-mismatch';

function rowState(project: PublicProject, panelMajor: number | null): RowState {
  const projectMajor = majorVersion(project.runtime.contractVersion);
  if (projectMajor === null) {
    return 'never-seen';
  }
  if (panelMajor !== null && projectMajor !== panelMajor) {
    return 'contract-mismatch';
  }
  return 'ok';
}

export function VersionsPage() {
  const { projects, loading, error } = useProjects();
  const { version, loading: versionLoading } = usePanelVersion();

  const panelMajor = majorVersion(version?.contractVersion);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Versions</h1>
        <p className="page-description">Versions logicielles et de contrat du parc.</p>
      </header>

      <Card title="Contrat parlé par le Panel">
        {versionLoading ? (
          <p className="muted">Chargement…</p>
        ) : version ? (
          <p>
            Le Panel parle la version de contrat{' '}
            <code className="inline-code">{version.contractVersion}</code>. Les projets dont la
            version majeure diffère sont surlignés en avertissement.
          </p>
        ) : (
          <p className="muted">Version du Panel indisponible.</p>
        )}
      </Card>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {loading ? (
        <p className="muted">Chargement des projets…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Aucun projet dans le parc"
          hint="Déclarez un projet depuis la page Projets pour suivre ses versions ici."
        />
      ) : (
        <Card>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Projet</th>
                  <th>Version logicielle</th>
                  <th>Version de contrat</th>
                  <th>Environnement</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const state = rowState(project, panelMajor);
                  return (
                    <tr
                      key={project.projectId}
                      className={state !== 'ok' ? 'row-warning' : undefined}
                    >
                      <td>
                        <span className="cell-primary">{project.projectName}</span>
                        <span className="cell-secondary">{project.projectKey}</span>
                      </td>
                      <td>
                        {project.runtime.softwareVersion ?? <span className="muted">—</span>}
                      </td>
                      <td>
                        {project.runtime.contractVersion ?? <span className="muted">—</span>}
                      </td>
                      <td>{project.runtime.environment ?? <span className="muted">—</span>}</td>
                      <td>
                        {state === 'never-seen' ? (
                          <span className="badge badge-muted">Jamais vu</span>
                        ) : state === 'contract-mismatch' ? (
                          <span className="badge badge-warn">Écart de contrat majeur</span>
                        ) : (
                          <span className="badge badge-ok">Compatible</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
