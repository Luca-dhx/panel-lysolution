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
 * La CRÉATION d'un projet reste réservée aux comptes DEV : elle exige de
 * sonder une adresse de backend et de transmettre un code d'appairage — une
 * opération d'infrastructure, pas de gestion.
 *
 * Elle tenait auparavant un bloc technique PERMANENT au-dessus de la liste :
 * champ d'adresse, bouton de test, verdict brut, champ de nom, déclaration.
 * Tout était offert en même temps, à tout le monde, sans ordre. Il ne reste
 * qu'un bouton ; le reste se déroule dans l'assistant, étape par étape.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { ProjectWizard } from '@/components/ProjectWizard';
import { LinkChip, sansProtocole } from '@/components/Links';
import { useProjects } from '@/lib/useProjects';
import { useSustained } from '@/lib/useLiveQuery';
import { useIsDev } from '@/auth/RequireDev';
import {
  connectionState,
  contractState,
  formatAmount,
  formatInterval,
  isBusinessSynchronized,
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

export function ProjectsPage() {
  const { projects, isInitialLoading, isRefreshing, error, reload } = useProjects();
  const isDev = useIsDev();
  const showRefreshHint = useSustained(isRefreshing, 500);

  // L'assistant vit DANS cette page : la liste n'est jamais démontée, donc
  // jamais rechargée depuis zéro, et son défilement ne bouge pas.
  const [assistant, setAssistant] = useState(false);

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

      {/* ── UN SEUL POINT D'ENTRÉE — réservé aux comptes DEV ───────────────── */}
      {isDev ? (
        <div className="contract-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAssistant(true)}>
            Créer un projet
          </button>
        </div>
      ) : null}

      {assistant ? (
        <ProjectWizard
          projects={projects}
          onCreated={reload}
          onClose={() => setAssistant(false)}
        />
      ) : null}

      {/* ── LISTE MÉTIER ──────────────────────────────────────────────────── */}
      {isInitialLoading ? (
        <p className="muted">Chargement des projets…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Aucun projet client"
          hint={
            isDev
              ? 'Créez un premier projet à partir de son adresse : l’assistant vous guide.'
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
                      {/* Un projet relié qui n'a jamais rien poussé affiche son
                          manifeste : on le DIT, sinon une panne de
                          synchronisation ressemble à une donnée à jour. */}
                      {project.pairing.status === 'PAIRED' && !isBusinessSynchronized(project) ? (
                        <span className={toneBadgeClass('warn')}>Identité non synchronisée</span>
                      ) : null}
                      {since ? <span>Dernier contact {since}</span> : null}
                      {url ? (
                        <LinkChip icon="globe" href={url} external title={url}>
                          {sansProtocole(url)}
                        </LinkChip>
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
