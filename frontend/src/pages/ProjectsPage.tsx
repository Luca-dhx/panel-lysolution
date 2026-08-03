/**
 * PROJETS CLIENTS — la page que consulte l'équipe, pas l'inventaire du parc.
 *
 * Elle affichait une table d'infrastructure : clé technique, état d'appairage,
 * version logicielle, capacités, éditeur de Manifest. Autant d'informations
 * qu'un commercial ne peut ni lire ni utiliser. La liste répond désormais aux
 * questions qu'on se pose sur un client : de qui s'agit-il, son site
 * fonctionne-t-il, quand a-t-on eu de ses nouvelles.
 *
 * Ce qui a disparu d'ici n'a pas été supprimé : la clé technique, le Manifest,
 * les versions et les actions techniques vivent dans l'onglet Développeur de
 * la fiche projet.
 *
 * La DÉCLARATION d'un projet reste réservée aux comptes DEV : elle exige de
 * sonder une adresse de backend et de transmettre un code d'appairage — une
 * opération d'infrastructure, pas de gestion.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CopyField, EmptyState } from '@/components/ui';
import { api, errorMessage, probeProject } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useProjects } from '@/lib/useProjects';
import { useSustained } from '@/lib/useLiveQuery';
import { useIsDev } from '@/auth/RequireDev';
import type { ProbeResult } from '@/types.company';
import {
  connectionState,
  contractState,
  formatAmount,
  formatInterval,
  lastContact,
  projectDescription,
  projectDisplayName,
  projectInitials,
  projectLogoUrl,
  projectDomain,
  projectSiteUrl,
  siteState,
  toneBadgeClass,
} from '@/lib/projectPresentation';

interface CreatedCode {
  projectName: string;
  pairingCode: string;
  expiresAt: string;
}

export function ProjectsPage() {
  const { projects, isInitialLoading, isRefreshing, error, reload } = useProjects();
  const isDev = useIsDev();
  const showRefreshHint = useSustained(isRefreshing, 500);

  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedCode | null>(null);

  const [probeUrl, setProbeUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const testConnection = async () => {
    setProbeError(null);
    setProbeResult(null);
    setProbing(true);
    try {
      const result = await probeProject(probeUrl.trim());
      setProbeResult(result);
      const announced = result.bridgeIdentity?.projectName;
      if (announced && projectName.trim().length === 0) setProjectName(announced);
    } catch (err) {
      setProbeError(errorMessage(err, 'Impossible de joindre cette adresse.'));
    } finally {
      setProbing(false);
    }
  };

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

  return (
    <div className="page">
      <header className="page-header">
        <h1>Projets clients</h1>
        <p className="page-description">
          Les sites que nous gérons et leur état du jour.
          {/* Mention placée EN FIN de ligne existante : elle ne pousse rien et
              ne change aucune hauteur. Silencieuse sous une demi-seconde. */}
          {showRefreshHint ? <span className="live-hint">Mise à jour…</span> : null}
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {/* ── DÉCLARATION — réservée aux comptes DEV ─────────────────────────── */}
      {isDev ? (
        <Card title="Déclarer un projet">
          <p className="muted">
            Renseignez l’adresse du backend, testez la connexion, puis déclarez. L’identifiant
            technique est généré automatiquement : il ne se saisit pas.
          </p>
          <div className="inline-form">
            <label className="field">
              <span className="field-label">Adresse du backend</span>
              <input
                type="url"
                value={probeUrl}
                onChange={(e) => setProbeUrl(e.target.value)}
                placeholder="https://api.mon-projet.exemple.com"
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={probing || probeUrl.trim().length === 0}
              onClick={() => void testConnection()}
            >
              {probing ? 'Test en cours…' : 'Tester la connexion'}
            </button>
          </div>

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
              {probeResult.reason}
            </div>
          ) : null}

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
                {creating ? 'Déclaration…' : 'Déclarer le projet'}
              </button>
            </div>
          ) : null}

          {createError ? <div className="alert alert-error">{createError}</div> : null}
        </Card>
      ) : null}

      {created ? (
        <div className="alert alert-warning code-reveal">
          <strong>Code de connexion pour « {created.projectName} »</strong>
          <CopyField value={created.pairingCode} label="Code" />
          <p>Ce code ne sera plus jamais affiché. Expire le {formatDateTime(created.expiresAt)}.</p>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setCreated(null)}
          >
            J’ai noté le code
          </button>
        </div>
      ) : null}

      {/* ── LISTE MÉTIER ──────────────────────────────────────────────────── */}
      {isInitialLoading ? (
        <p className="muted">Chargement des projets…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Aucun projet client"
          hint={
            isDev
              ? 'Déclarez un premier projet à partir de l’adresse de son backend.'
              : 'Aucun projet n’a encore été déclaré dans le Panel.'
          }
        />
      ) : (
        <div className="grid-cards">
          {projects.map((project) => {
            const site = siteState(project);
            const link = connectionState(project);
            const since = lastContact(project);
            const url = projectSiteUrl(project);
            const domain = projectDomain(project);
            const logoUrl = projectLogoUrl(project);
            const contract = project.business?.contract ?? null;
            const abonnement = formatAmount(contract?.pricing?.subscription ?? null);
            const description = projectDescription(project);
            return (
              <Card key={project.projectId}>
                <div className="project-row">
                  {/* Le logo vient du projet, en URL absolue ; à défaut, les
                      initiales — jamais une image manquante. */}
                  {logoUrl ? (
                    <img className="project-avatar" src={logoUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="project-avatar">{projectInitials(project)}</span>
                  )}

                  <div className="project-row-main">
                    <p className="project-row-title">{projectDisplayName(project)}</p>
                    {description ? <p className="muted">{description}</p> : null}

                    <div className="project-row-meta">
                      <span className={toneBadgeClass(site.tone)}>{site.label}</span>
                      <span className={toneBadgeClass(link.tone)}>{link.label}</span>
                      {since ? <span>Dernier contact {since}</span> : null}
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          {url.replace(/^[a-z]+:\/\//, '')}
                        </a>
                      ) : domain ? (
                        <span>{domain}</span>
                      ) : null}
                    </div>

                    {contract ? (
                      <div className="project-row-meta">
                        <span className={toneBadgeClass(contractState(contract.status).tone)}>
                          {contractState(contract.status).label}
                        </span>
                        {abonnement ? (
                          <span>
                            {abonnement}
                            {formatInterval(contract.pricing.subscription?.interval)
                              ? ` ${formatInterval(contract.pricing.subscription?.interval)}`
                              : ''}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    {project.note ? <p className="cell-secondary">{project.note}</p> : null}
                  </div>

                  <Link className="btn btn-secondary btn-small" to={`/projects/${project.projectId}`}>
                    Voir
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ProjectsPage;
