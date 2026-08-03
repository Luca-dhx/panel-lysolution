import { useState } from 'react';
import { Card, CopyField, EmptyState, StatusBadge } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useProjects } from '@/lib/useProjects';
import type { PublicProject } from '@/types';

interface GeneratedCode {
  projectId: string;
  projectName: string;
  pairingCode: string;
  expiresAt: string;
}

export function PairingsPage() {
  const { projects, isInitialLoading, error, reload } = useProjects();
  const [generated, setGenerated] = useState<GeneratedCode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

  const generateCode = async (project: PublicProject) => {
    setActionError(null);
    setBusyProjectId(project.projectId);
    try {
      const res = await api.generatePairingCode(project.projectId);
      setGenerated({
        projectId: project.projectId,
        projectName: project.projectName,
        pairingCode: res.pairingCode,
        expiresAt: res.pairingCodeExpiresAt,
      });
      await reload();
    } catch (err) {
      setActionError(errorMessage(err, 'Impossible de générer un code d’appairage.'));
    } finally {
      setBusyProjectId(null);
    }
  };

  const revokePairing = async (project: PublicProject) => {
    const confirmed = window.confirm(
      `Révoquer l’appairage de « ${project.projectName} » ?\n` +
        'Le projet passera en mode Standalone, sans perte de données.',
    );
    if (!confirmed) {
      return;
    }
    setActionError(null);
    setBusyProjectId(project.projectId);
    try {
      await api.revokePairing(project.projectId);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err, 'Impossible de révoquer l’appairage.'));
    } finally {
      setBusyProjectId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Appairages</h1>
        <p className="page-description">Cycle d’appairage des projets du parc.</p>
      </header>

      {generated ? (
        <div className="alert alert-warning code-reveal">
          <strong>Nouveau code d’appairage pour « {generated.projectName} »</strong>
          <CopyField value={generated.pairingCode} label="Code" />
          <p>
            Ce code ne sera plus jamais affiché. Expire le {formatDateTime(generated.expiresAt)}.
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setGenerated(null)}
          >
            J’ai noté le code
          </button>
        </div>
      ) : null}

      {error ? <div className="alert alert-error">{error}</div> : null}
      {actionError ? <div className="alert alert-error">{actionError}</div> : null}

      {isInitialLoading ? (
        <p className="muted">Chargement des projets…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Aucun projet dans le parc"
          hint="Déclarez un projet depuis la page Projets pour gérer son appairage ici."
        />
      ) : (
        <Card>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Projet</th>
                  <th>Statut</th>
                  <th>Appairé le</th>
                  <th>Révoqué le</th>
                  <th>Code expire</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const status = project.pairing.status;
                  const canGenerate = status === 'DECLARED' || status === 'REVOKED';
                  const canRevoke = status === 'PAIRED';
                  const busy = busyProjectId === project.projectId;
                  return (
                    <tr key={project.projectId}>
                      <td>
                        <span className="cell-primary">{project.projectName}</span>
                        <span className="cell-secondary">{project.projectKey}</span>
                      </td>
                      <td>
                        <StatusBadge kind="pairing" value={status} />
                      </td>
                      <td>{formatDateTime(project.pairing.pairedAt)}</td>
                      <td>{formatDateTime(project.pairing.revokedAt)}</td>
                      <td>{formatDateTime(project.pairing.pairingCodeExpiresAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-small btn-secondary"
                            disabled={!canGenerate || busy}
                            title={
                              canGenerate
                                ? 'Générer un nouveau code d’appairage (affiché une seule fois)'
                                : 'Projet déjà appairé : révoquez d’abord l’appairage.'
                            }
                            onClick={() => void generateCode(project)}
                          >
                            Générer un nouveau code
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-danger"
                            disabled={!canRevoke || busy}
                            title={
                              canRevoke
                                ? 'Révoquer l’appairage de ce projet'
                                : 'Aucun appairage actif à révoquer.'
                            }
                            onClick={() => void revokePairing(project)}
                          >
                            Révoquer l’appairage
                          </button>
                        </div>
                        {!canGenerate ? (
                          <span className="cell-secondary">
                            Génération possible uniquement pour un projet déclaré ou révoqué.
                          </span>
                        ) : null}
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
