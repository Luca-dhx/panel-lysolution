import { useState } from 'react';
import type { FormEvent } from 'react';
import { Card, CopyField, EmptyState, StatusBadge } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useProjects } from '@/lib/useProjects';
import type { PublicProject } from '@/types';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface CreatedCode {
  projectName: string;
  pairingCode: string;
  expiresAt: string;
}

interface ManifestEditorState {
  projectId: string;
  projectName: string;
  text: string;
}

export function ProjectsPage() {
  const { projects, loading, error, reload } = useProjects();

  // Déclaration d'un projet
  const [projectKey, setProjectKey] = useState('');
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedCode | null>(null);

  // Actions par ligne
  const [actionError, setActionError] = useState<string | null>(null);

  // Éditeur de manifest
  const [editor, setEditor] = useState<ManifestEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorDetails, setEditorDetails] = useState<string | null>(null);
  const [unknownCaps, setUnknownCaps] = useState<string[] | null>(null);
  const [manifestSaved, setManifestSaved] = useState(false);
  const [savingManifest, setSavingManifest] = useState(false);

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError(null);
    const key = projectKey.trim();
    const name = projectName.trim();
    if (!KEBAB_CASE.test(key)) {
      setCreateError('La clé du projet doit être en kebab-case (ex. : mon-projet-01).');
      return;
    }
    setCreating(true);
    try {
      const res = await api.createProject({ projectKey: key, projectName: name });
      setCreated({
        projectName: res.project.projectName,
        pairingCode: res.pairingCode,
        expiresAt: res.pairingCodeExpiresAt,
      });
      setProjectKey('');
      setProjectName('');
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err, 'Impossible de déclarer le projet.'));
    } finally {
      setCreating(false);
    }
  };

  const removeProject = async (project: PublicProject) => {
    if (!window.confirm(`Retirer « ${project.projectName} » du parc ?`)) {
      return;
    }
    setActionError(null);
    try {
      await api.removeProject(project.projectId);
      if (editor?.projectId === project.projectId) {
        closeEditor();
      }
      await reload();
    } catch (err) {
      setActionError(errorMessage(err, 'Impossible de retirer le projet du parc.'));
    }
  };

  const openEditor = (project: PublicProject) => {
    setEditor({
      projectId: project.projectId,
      projectName: project.projectName,
      text:
        project.manifest !== null && project.manifest !== undefined
          ? JSON.stringify(project.manifest, null, 2)
          : '{\n}',
    });
    setEditorError(null);
    setEditorDetails(null);
    setUnknownCaps(null);
    setManifestSaved(false);
  };

  const closeEditor = () => {
    setEditor(null);
    setEditorError(null);
    setEditorDetails(null);
    setUnknownCaps(null);
    setManifestSaved(false);
  };

  const saveManifest = async () => {
    if (!editor) return;
    setEditorError(null);
    setEditorDetails(null);
    setUnknownCaps(null);
    setManifestSaved(false);

    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.text);
    } catch {
      setEditorError('JSON invalide : corrigez la syntaxe avant d’envoyer.');
      return;
    }

    setSavingManifest(true);
    try {
      const res = await api.updateManifest(editor.projectId, parsed);
      setUnknownCaps(res.unknownFeatures);
      setManifestSaved(true);
      await reload();
    } catch (err) {
      setEditorError(errorMessage(err, 'Impossible d’enregistrer le manifest.'));
      if (err instanceof ApiError && err.details !== undefined) {
        setEditorDetails(JSON.stringify(err.details, null, 2));
      }
    } finally {
      setSavingManifest(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Projets</h1>
        <p className="page-description">Parc des projets clients déclarés dans le Panel.</p>
      </header>

      <Card title="Déclarer un projet">
        <form className="inline-form" onSubmit={(e) => void submitCreate(e)}>
          <label className="field">
            <span className="field-label">Clé du projet (kebab-case)</span>
            <input
              type="text"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              placeholder="mon-projet-01"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Lettres minuscules et chiffres séparés par des tirets."
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Nom du projet</span>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Nom lisible du projet"
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Déclaration…' : 'Déclarer'}
          </button>
        </form>
        {createError ? <div className="alert alert-error">{createError}</div> : null}
      </Card>

      {created ? (
        <div className="alert alert-warning code-reveal">
          <strong>Code d’appairage pour « {created.projectName} »</strong>
          <CopyField value={created.pairingCode} label="Code" />
          <p>
            Ce code ne sera plus jamais affiché. Expire le {formatDateTime(created.expiresAt)}.
          </p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setCreated(null)}>
            J’ai noté le code
          </button>
        </div>
      ) : null}

      {error ? <div className="alert alert-error">{error}</div> : null}
      {actionError ? <div className="alert alert-error">{actionError}</div> : null}

      {loading ? (
        <p className="muted">Chargement des projets…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Aucun projet dans le parc"
          hint="Utilisez le formulaire ci-dessus pour déclarer votre premier projet."
        />
      ) : (
        <Card>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Clé</th>
                  <th>Nom</th>
                  <th>Appairage</th>
                  <th>Vivacité</th>
                  <th>Version logicielle</th>
                  <th>Capacités actives</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const isPaired = project.pairing.status === 'PAIRED';
                  return (
                    <tr key={project.projectId}>
                      <td>
                        <code className="inline-code">{project.projectKey}</code>
                      </td>
                      <td>{project.projectName}</td>
                      <td>
                        <StatusBadge kind="pairing" value={project.pairing.status} />
                      </td>
                      <td>
                        <StatusBadge kind="liveness" value={project.liveness} />
                      </td>
                      <td>
                        {project.runtime.softwareVersion ?? <span className="muted">—</span>}
                      </td>
                      <td>
                        {project.capabilities.enabled.length > 0 ? (
                          <span className="badge-list">
                            {project.capabilities.enabled.map((cap) => (
                              <span key={cap} className="badge badge-neutral">
                                {cap}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-small btn-secondary"
                            onClick={() => openEditor(project)}
                          >
                            Éditer le Manifest
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-danger"
                            disabled={isPaired}
                            title={
                              isPaired
                                ? 'Révoquez d’abord l’appairage'
                                : 'Retirer ce projet du parc'
                            }
                            onClick={() => void removeProject(project)}
                          >
                            Retirer du parc
                          </button>
                        </div>
                        {isPaired ? (
                          <span className="cell-secondary">Révoquez d’abord l’appairage</span>
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

      {editor ? (
        <Card title={`Manifest — ${editor.projectName}`} className="manifest-editor">
          <p className="muted">
            Collez ou modifiez le manifest JSON du projet, puis enregistrez pour le valider côté
            Panel.
          </p>
          <textarea
            className="manifest-textarea"
            value={editor.text}
            onChange={(e) => setEditor({ ...editor, text: e.target.value })}
            rows={14}
            spellCheck={false}
          />
          {editorError ? <div className="alert alert-error">{editorError}</div> : null}
          {editorDetails ? <pre className="error-details">{editorDetails}</pre> : null}
          {manifestSaved ? (
            <div className="alert alert-success">Manifest enregistré.</div>
          ) : null}
          {unknownCaps && unknownCaps.length > 0 ? (
            <div className="alert alert-warning">
              Capacités inconnues du Panel :{' '}
              <span className="badge-list">
                {unknownCaps.map((cap) => (
                  <span key={cap} className="badge badge-warn">
                    {cap}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={savingManifest}
              onClick={() => void saveManifest()}
            >
              {savingManifest ? 'Enregistrement…' : 'Enregistrer le manifest'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={closeEditor}>
              Fermer
            </button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
