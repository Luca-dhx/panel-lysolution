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
 * ══ CE QUE LA REFONTE A CHANGÉ ══════════════════════════════════════════════
 *
 * La liste était une grille de CARTES. Une carte présente bien UN objet ; elle
 * compare mal TRENTE objets — rien ne s'aligne d'une carte à l'autre, et pour
 * trouver quel site est hors ligne il fallait lire les trente accroches.
 *
 * Elle est devenue un TABLEAU trié, avec une recherche et un filtre d'état. Les
 * informations montrées sont exactement les mêmes : la retenue de la carte a
 * été gardée, sa mise en page a changé.
 *
 * Elle tenait auparavant un bloc technique PERMANENT au-dessus de la liste :
 * champ d'adresse, bouton de test, verdict brut, champ de nom, déclaration.
 * Tout était offert en même temps, à tout le monde, sans ordre. Il ne reste
 * qu'un bouton ; le reste se déroule dans l'assistant, étape par étape.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ProjectWizard } from '@/components/ProjectWizard';
import { ProjectsTable } from '@/components/projects/ProjectsTable';
import { SearchField } from '@/components/SearchField';
import { ThemedFilter } from '@/components/ThemedSelect';
import { PageHeader, SkeletonRows } from '@/components/ui-kit';
import { useProjects } from '@/lib/useProjects';
import { useSustained } from '@/lib/useLiveQuery';
import { useIsDev } from '@/auth/RequireDev';
import {
  projectDescription,
  projectDisplayName,
  projectDomain,
  projectSiteUrl,
  vitrineState,
} from '@/lib/projectPresentation';

/**
 * LES ÉTATS DE VITRINE FILTRABLES.
 *
 * La liste est CLOSE et tirée de ce que `vitrineState` sait rendre : un filtre
 * qui proposerait un état que le lecteur ne produit jamais afficherait
 * invariablement zéro résultat, et ferait douter du filtre entier.
 */
const ETATS = [
  { value: '', label: 'Tous les états' },
  { value: 'ok', label: 'En ligne' },
  { value: 'warn', label: 'À surveiller' },
  { value: 'error', label: 'Hors ligne' },
  { value: 'neutral', label: 'Non appairé' },
];

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

  /* ── RECHERCHE ET FILTRE — locaux, sur une liste déjà en main ──────────
     Le parc se compte en dizaines. Un aller-retour réseau par frappe aurait
     rendu la recherche poussive, et la lecture vivante aurait remis la liste
     dans l'ordre du serveur entre deux caractères. */
  const [recherche, setRecherche] = useState('');
  const [etat, setEtat] = useState('');

  const filtres = useMemo(() => {
    const terme = recherche.trim().toLowerCase();
    return projects.filter((projet) => {
      if (etat && vitrineState(projet).tone !== etat) return false;
      if (!terme) return true;
      /* On cherche sur ce qu'on a EN TÊTE : le nom, le domaine, l'accroche.
         Pas sur la clé technique — personne ne la retient, et elle ferait
         remonter des résultats que le lecteur ne reconnaîtrait pas. */
      return [
        projectDisplayName(projet),
        projectDomain(projet) ?? '',
        projectSiteUrl(projet) ?? '',
        projectDescription(projet) ?? '',
      ].some((champ) => champ.toLowerCase().includes(terme));
    });
  }, [projects, recherche, etat]);

  const boutonCreer = isDev ? (
    <button type="button" className="btn btn-primary btn-small" onClick={() => setAssistantManuel(true)}>
      Créer un projet
    </button>
  ) : null;

  return (
    <div className="page">
      <PageHeader
        title="Projets clients"
        description="Les sites que nous gérons et leur état du jour."
        badges={showRefreshHint ? (
          <span className="text-xs text-quaternary" role="status">Mise à jour…</span>
        ) : null}
        actions={boutonCreer}
      />

      {error ? <div className="alert alert-error">{error}</div> : null}

      {assistant ? (
        <ProjectWizard
          projects={projects}
          onCreated={reload}
          onClose={fermerAssistant}
          environment={ouvertParRaccourci ? envRaccourci : null}
          contextProjectName={ouvertParRaccourci ? nomRaccourci : null}
        />
      ) : null}

      {isInitialLoading ? (
        <div className="uui overflow-hidden rounded-xl ring-1 ring-secondary">
          <SkeletonRows rows={6} columns={4} />
        </div>
      ) : (
        <ProjectsTable
          projects={filtres}
          title={etat ? (ETATS.find((e) => e.value === etat)?.label ?? 'Projets') : 'Tous les projets'}
          description="Le nom mène à la fiche ; le menu ouvre les finances ou le site."
          emptyTitle={
            projects.length === 0 ? 'Aucun projet client' : 'Aucun projet ne correspond'
          }
          emptyHint={
            projects.length === 0
              ? (isDev
                ? 'Créez un premier projet à partir de son adresse : l’assistant vous guide.'
                : 'Aucun projet n’a encore été déclaré dans le Panel.')
              : 'Élargissez la recherche, ou changez de filtre d’état.'
          }
          emptyAction={projects.length === 0 ? boutonCreer : null}
          contentTrailing={(
            <div className="flex w-full flex-wrap items-end gap-3 lg:w-auto lg:justify-end">
              <ThemedFilter
                label="État du site"
                value={etat}
                options={ETATS}
                placeholder="Tous les états"
                onChange={setEtat}
              />
              <div className="min-w-0 flex-1 lg:w-64 lg:flex-none">
                <SearchField
                  label="Rechercher un projet"
                  placeholder="Nom, domaine, accroche…"
                  value={recherche}
                  onChange={setRecherche}
                />
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}

export default ProjectsPage;
