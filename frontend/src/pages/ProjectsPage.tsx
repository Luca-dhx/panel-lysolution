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
import { Link, useSearchParams } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { ProjectWizard } from '@/components/ProjectWizard';
import { LinkChip, sansProtocole } from '@/components/Links';
import { useProjects } from '@/lib/useProjects';
import { useSustained } from '@/lib/useLiveQuery';
import { useIsDev } from '@/auth/RequireDev';
import {
  contractState,
  isBusinessSynchronized,
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

  /**
   * LE RACCOURCI D'APPAIRAGE ARRIVE PAR L'ADRESSE.
   *
   * ── POURQUOI ─────────────────────────────────────────────────────────────
   * « Appairer la production » depuis une carte de la page Appairages sait
   * déjà tout : le projet, et l'environnement à créer. Renvoyer l'utilisateur
   * vers le bouton de création puis lui faire re-sélectionner ce qu'on tenait
   * déjà, c'est lui demander de ressaisir un contexte connu.
   *
   * ── FAIL SAFE ────────────────────────────────────────────────────────────
   * Un `env` absent ou fantaisiste n'invente RIEN — surtout pas PROD. On
   * retombe sur le parcours normal, choix libre : se tromper d'environnement
   * de production sur la foi d'un paramètre d'URL mal formé serait la pire
   * façon d'échouer.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get('env');
  const envRaccourci = envParam === 'TEST' || envParam === 'PROD' ? envParam : null;
  const nomRaccourci = searchParams.get('name');
  const ouvertParRaccourci = searchParams.get('declare') === '1';

  // L'assistant vit DANS cette page : la liste n'est jamais démontée, donc
  // jamais rechargée depuis zéro, et son défilement ne bouge pas.
  const [assistantManuel, setAssistantManuel] = useState(false);
  const assistant = assistantManuel || ouvertParRaccourci;

  /**
   * Fermer l'assistant NETTOIE l'adresse : sans cela, un rafraîchissement ou
   * un retour arrière le rouvrirait indéfiniment.
   */
  const fermerAssistant = () => {
    setAssistantManuel(false);
    if (ouvertParRaccourci) {
      const next = new URLSearchParams(searchParams);
      for (const cle of ['declare', 'env', 'name', 'logical']) next.delete(cle);
      setSearchParams(next, { replace: true });
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

      {/* ── UN SEUL POINT D'ENTRÉE — réservé aux comptes DEV ───────────────── */}
      {isDev ? (
        <div className="contract-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAssistantManuel(true)}>
            Créer un projet
          </button>
        </div>
      ) : null}

      {assistant ? (
        <ProjectWizard
          projects={projects}
          onCreated={reload}
          onClose={fermerAssistant}
          environment={ouvertParRaccourci ? envRaccourci : null}
          contextProjectName={ouvertParRaccourci ? nomRaccourci : null}
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
          {/* ── LA CARTE DIT PEU, ET C'EST LE POINT ───────────────────────────
              Elle portait l'état du site, l'état du lien avec le Panel, la date
              du dernier contact, le statut du contrat, le montant de
              l'abonnement, sa périodicité et la note interne. Sept informations
              pour répondre à une question — « de qui s'agit-il, et est-ce que ça
              va ? » —, et un empilement de pastilles où plus rien ne ressort.

              Ne reste que ce qui aide à CHOISIR sur quelle fiche cliquer :
              l'identité, l'état du site, l'état du contrat, l'adresse. Le reste
              appartient à la fiche, où il est lisible. */}
          {projects.map((project) => {
            const site = siteState(project);
            const url = projectSiteUrl(project);
            const domain = projectDomain(project);
            const logoUrl = projectLogoUrl(project);
            const contract = project.business?.contract ?? null;
            const description = projectDescription(project);
            return (
              <Card key={project.projectId} className="project-card">
                <div className="project-card-head">
                  {/* Le logo vient du projet, en URL absolue ; à défaut, les
                      initiales — jamais une image manquante. */}
                  {logoUrl ? (
                    <img className="project-avatar" src={logoUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="project-avatar">{projectInitials(project)}</span>
                  )}
                  <div className="project-card-identity">
                    <p className="project-row-title">{projectDisplayName(project)}</p>
                    {description ? <p className="muted project-card-tagline">{description}</p> : null}
                  </div>
                </div>

                <div className="project-card-meta">
                  <span className={toneBadgeClass(site.tone)}>{site.label}</span>
                  {/* Sans contrat EN COURS, la liste ne montre aucune pastille
                      contractuelle : afficher l'état d'un contrat terminé
                      laisserait croire à un engagement encore en vigueur. */}
                  {contract?.status && contract.hasCurrent !== false ? (
                    <span className={toneBadgeClass(contractState(contract.status).tone)}>
                      {contractState(contract.status).label}
                    </span>
                  ) : null}
                  {/* Un projet relié qui n'a jamais rien poussé affiche son
                      manifeste : on le DIT, sinon une panne de synchronisation
                      ressemble à une donnée à jour. */}
                  {project.pairing.status === 'PAIRED' && !isBusinessSynchronized(project) ? (
                    <span className={toneBadgeClass('warn')}>Identité non synchronisée</span>
                  ) : null}
                </div>

                <div className="project-card-foot">
                  {url ? (
                    <LinkChip icon="globe" href={url} external title={url}>
                      {sansProtocole(url)}
                    </LinkChip>
                  ) : domain ? (
                    <span className="muted">{domain}</span>
                  ) : <span />}
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
