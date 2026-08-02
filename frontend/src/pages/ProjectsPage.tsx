import { useState } from 'react';
import type { FormEvent } from 'react';
import { Card, CopyField, EmptyState, StatusBadge } from '@/components/ui';
import { ApiError, api, errorMessage, probeProject } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useProjects } from '@/lib/useProjects';
import type { ProbeResult } from '@/types.company';
import type { PublicProject } from '@/types';

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

  // Déclaration d'un projet — adresse + nom, jamais de clé : elle est générée
  // par le serveur à partir de l'identité que le projet annonce lui-même.
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedCode | null>(null);

  // Sonde d'URL, AVANT tout appairage
  const [probeUrl, setProbeUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Actions par ligne
  const [actionError, setActionError] = useState<string | null>(null);

  // Éditeur de manifest
  const [editor, setEditor] = useState<ManifestEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorDetails, setEditorDetails] = useState<string | null>(null);
  const [unknownCaps, setUnknownCaps] = useState<string[] | null>(null);
  const [manifestSaved, setManifestSaved] = useState(false);
  const [savingManifest, setSavingManifest] = useState(false);

  const submitCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const name = projectName.trim();
      const res = await api.createProject({
        url: probeUrl.trim(),
        ...(name.length > 0 ? { projectName: name } : {}),
      });
      setCreated({
        projectName: res.project.projectName,
        pairingCode: res.pairingCode,
        expiresAt: res.pairingCodeExpiresAt,
      });
      setProjectName('');
      setProbeUrl('');
      setProbeResult(null);
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err, 'Impossible de déclarer le projet.'));
    } finally {
      setCreating(false);
    }
  };

  /**
   * SONDE — le seul appel sortant possible AVANT l'appairage : les autres
   * routes du ProjectBridge exigent un bridgeToken qui n'existe pas encore.
   * Elle ne crée rien et ne modifie rien : on constate, on n'engage pas.
   */
  const submitProbe = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProbeError(null);
    setProbeResult(null);
    setProbing(true);
    try {
      const result = await probeProject(probeUrl.trim());
      setProbeResult(result);
      // Le projet se nomme lui-même : on pré-remplit avec CE nom plutôt que
      // d'en faire inventer un. L'utilisateur reste libre de le remplacer.
      const announced = result.bridgeIdentity?.projectName;
      if (announced && projectName.trim().length === 0) setProjectName(announced);
    } catch (err) {
      setProbeError(errorMessage(err, 'Impossible de sonder cette adresse.'));
    } finally {
      setProbing(false);
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
        <p className="muted">
          Renseignez l’adresse du backend, testez le pont, puis déclarez. La clé technique du
          projet est générée automatiquement à partir de l’identité qu’il annonce lui-même : elle
          ne se saisit pas.
        </p>
        <form className="inline-form" onSubmit={(e) => void submitProbe(e)}>
          <label className="field">
            <span className="field-label">URL publique du backend du projet</span>
            <input
              type="url"
              value={probeUrl}
              onChange={(e) => setProbeUrl(e.target.value)}
              placeholder="https://api.mon-projet.exemple.com"
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={probing}>
            {probing ? 'Test en cours…' : 'Tester le bridge'}
          </button>
        </form>

        {probeError ? <div className="alert alert-error">{probeError}</div> : null}

        {probeResult ? (
          <div
            className={
              probeResult.compatible && probeResult.alreadyPaired !== true
                ? 'alert alert-success'
                : probeResult.reachable
                  ? 'alert alert-warning'
                  : 'alert alert-error'
            }
          >
            <strong>{probeResult.reason}</strong>
            <dl className="detail-list">
              <div>
                <dt>Adresse joignable</dt>
                <dd>{probeResult.reachable ? 'oui' : 'non'}</dd>
              </div>
              <div>
                <dt>ProjectBridge reconnu</dt>
                <dd>{probeResult.isProjectBridge ? 'oui' : 'non'}</dd>
              </div>
              <div>
                <dt>Contrat du projet</dt>
                <dd>
                  {probeResult.contractVersion ? (
                    <code className="inline-code">{probeResult.contractVersion}</code>
                  ) : (
                    <span className="muted">non annoncé</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Contrat du Panel</dt>
                <dd>
                  <code className="inline-code">{probeResult.panelContractVersion ?? '—'}</code>
                </dd>
              </div>
              <div>
                <dt>Compatibles</dt>
                <dd>{probeResult.compatible ? 'oui' : 'non'}</dd>
              </div>
              <div>
                <dt>Déjà appairé</dt>
                <dd>
                  {probeResult.alreadyPaired === null
                    ? <span className="muted">inconnu</span>
                    : probeResult.alreadyPaired ? 'oui' : 'non'}
                </dd>
              </div>
              <div>
                <dt>Testé le</dt>
                <dd>{formatDateTime(probeResult.checkedAt)}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {/* La déclaration ne s'ouvre qu'une fois le pont constaté valide : on
            n'inscrit pas au registre une adresse dont on ignore ce qu'elle
            répond. Un projet déjà appairé ailleurs reste barré. */}
        {probeResult?.compatible && probeResult.alreadyPaired !== true ? (
          <div className="inline-form">
            <label className="field">
              <span className="field-label">
                Nom du projet <span className="muted">(pré-rempli, modifiable)</span>
              </span>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Nom lisible du projet"
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={creating}
              onClick={() => void submitCreate()}
            >
              {creating ? 'Déclaration…' : 'Déclarer ce projet'}
            </button>
          </div>
        ) : null}

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
                  <th>Nom</th>
                  <th>Adresse</th>
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
                      <td>{project.projectName}</td>
                      <td>
                        {project.runtime.publicBackendUrl ? (
                          <code className="inline-code">{project.runtime.publicBackendUrl}</code>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
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
