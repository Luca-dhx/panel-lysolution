/**
 * APPAIRAGES — « quels projets sont connectés, et où ? »
 *
 * ══ CE QUE CETTE PAGE MONTRAIT, ET POURQUOI C'ÉTAIT ILLISIBLE ═══════════════
 *
 * Une table d'appairages techniques : une ligne par fiche, colonnes « Appairé
 * le », « Révoqué le », « Code expire », deux gros boutons concurrents. Deux
 * instances d'un même client — sa recette et sa production — y figuraient comme
 * deux projets sans rapport, et rien ne disait laquelle servait quoi. Pour
 * répondre à « la production de SB Auto est-elle branchée ? », il fallait
 * connaître par cœur le nom de la fiche.
 *
 * ══ CE QU'ELLE MONTRE MAINTENANT ════════════════════════════════════════════
 *
 * Un projet par carte, ses environnements dessous :
 *
 *     PROJET
 *     ├── TEST  ● Connecté · demo-sbauto06.ly-solution.com
 *     └── PROD  ○ Non appairé
 *
 * Le regroupement ne devine rien : il lit l'identité logique que le projet
 * annonce lui-même. Une fiche qui n'en a pas reste seule de sa carte — le
 * comportement exact d'avant.
 *
 * ══ CE QUI A QUITTÉ CETTE PAGE ══════════════════════════════════════════════
 *
 * Identifiants, clés techniques, dates d'appairage et de révocation, expiration
 * de code. Rien n'est perdu : tout est dans l'onglet Développeur de la fiche,
 * à un clic. Cette page répond à quatre questions, pas à quarante.
 */
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui';
import { ProjectConnectionsCard } from '@/components/connections';
import { useProjects } from '@/lib/useProjects';
import {
  filterCounts, groupProjectsByLogicalProject, matchesFilter, matchesSearch,
  type ConnectionFilter,
} from '@/lib/projectConnections';

const FILTRES: { id: ConnectionFilter; label: string }[] = [
  { id: 'all', label: 'Tous' },
  { id: 'online', label: 'Connectés' },
  { id: 'todo', label: 'À configurer' },
  { id: 'attention', label: 'À vérifier' },
];

export function PairingsPage() {
  const { projects, isInitialLoading, error } = useProjects();
  const [recherche, setRecherche] = useState('');
  const [filtre, setFiltre] = useState<ConnectionFilter>('all');

  // Le regroupement est une fonction PURE : il se teste sans monter React, et
  // ne se recalcule qu'au changement du parc.
  const groupes = useMemo(() => groupProjectsByLogicalProject(projects), [projects]);
  const compteurs = useMemo(() => filterCounts(groupes), [groupes]);
  const visibles = useMemo(
    () => groupes.filter((g) => matchesFilter(g, filtre) && matchesSearch(g, recherche)),
    [groupes, filtre, recherche],
  );

  return (
    <div className="page">
      <header className="page-header">
        <h1>Appairages</h1>
        <p className="page-description">
          Les projets du parc et leurs connexions au Panel, par environnement.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {isInitialLoading ? (
        <p className="muted">Chargement des projets…</p>
      ) : groupes.length === 0 ? (
        <EmptyState
          title="Aucun projet dans le parc"
          hint="Déclarez un projet depuis la page Projets pour gérer ses connexions ici."
        />
      ) : (
        <>
          <div className="conn-toolbar">
            <div className="conn-search">
              <label className="sr-only" htmlFor="conn-search">
                Rechercher un projet ou un domaine
              </label>
              <input
                id="conn-search"
                type="search"
                className="input"
                placeholder="Rechercher un projet ou un domaine…"
                value={recherche}
                onChange={(e) => setRecherche(e.target.value)}
              />
            </div>

            {/* Quatre filtres, pas une barre d'outils. Chacun porte son
                compteur : un filtre qui ne ramène rien se voit AVANT le clic. */}
            <div className="conn-filters" role="group" aria-label="Filtrer les projets">
              {FILTRES.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={filtre === f.id ? 'conn-filter conn-filter-active' : 'conn-filter'}
                  aria-pressed={filtre === f.id}
                  onClick={() => setFiltre(f.id)}
                >
                  {f.label}
                  <span className="conn-filter-count">{compteurs[f.id]}</span>
                </button>
              ))}
            </div>
          </div>

          {visibles.length === 0 ? (
            <EmptyState
              title="Aucun projet ne correspond"
              hint="Modifiez la recherche ou revenez au filtre « Tous »."
            />
          ) : (
            <div className="conn-grid">
              {visibles.map((g) => (
                <ProjectConnectionsCard key={g.key} group={g} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default PairingsPage;
