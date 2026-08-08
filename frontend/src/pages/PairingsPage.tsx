/**
 * APPAIRAGES — « quelles fiches sont appairées, et à quoi ? »
 *
 * ══ CE QUE CETTE PAGE MONTRAIT, ET POURQUOI C'ÉTAIT FAUX ════════════════════
 *
 * Une carte par « projet client », portant deux lignes : TEST et PROD. Le
 * regroupement lisait `logicalProjectKey`, la clé que le projet annonce.
 * L'intention était bonne ; le modèle ne l'était pas :
 *
 *   · une instance de Panel ne sert QU'UN environnement — l'appairage refuse
 *     l'autre. La seconde ligne ne pouvait jamais se remplir, et son bouton
 *     « Appairer la production » menait à une impasse ;
 *   · une fiche non appairée affichait quand même un environnement et une
 *     destination, tirés de la saisie locale. Le Panel présentait comme un
 *     constat ce qui n'était qu'une intention.
 *
 * ══ CE QU'ELLE MONTRE MAINTENANT ════════════════════════════════════════════
 *
 * Une liste verticale. Une ligne pleine largeur par fiche du Panel :
 *
 *     SB Auto 06                      ● Connecté
 *     Environnement  TEST
 *     Destination    demo-sbauto06.ly-solution.com
 *     Dernier contact / Données métier reçues        [ Gérer ]
 *
 * Et pour une fiche qui n'a pas encore parlé :
 *
 *     Garage du Nord                  ○ Non appairé
 *     Environnement  — non connu —
 *     Destination    — non connue —                 [ Appairer ]
 *
 * ══ CE QUI A QUITTÉ CETTE PAGE ══════════════════════════════════════════════
 *
 * Le regroupement, les segments TEST/PROD, les cases vides, les clés
 * techniques, les dates d'appairage et de révocation. Rien n'est perdu : le
 * technique est dans l'onglet Développeur de la fiche, à un clic.
 */
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui';
import { SearchField } from '@/components/SearchField';
import { PairingRowItem } from '@/components/connections';
import { useProjects } from '@/lib/useProjects';
import {
  filterCounts, matchesFilter, matchesSearch, toPairingRows,
  type ConnectionFilter,
} from '@/lib/projectConnections';

/**
 * LES FILTRES PORTENT SUR LE LIEN, PAS SUR L'ENVIRONNEMENT.
 *
 * `TEST` et `PROD` ont disparu : dans un Panel qui n'en sert qu'un, l'un des
 * deux boutons rendait toujours une liste vide.
 */
const FILTRES: { id: ConnectionFilter; label: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: 'paired', label: 'Appairées' },
  { id: 'unpaired', label: 'À appairer' },
  { id: 'attention', label: 'Problème' },
];

export function PairingsPage() {
  const { projects, isInitialLoading, error, reload } = useProjects();
  const [recherche, setRecherche] = useState('');
  const [filtre, setFiltre] = useState<ConnectionFilter>('all');

  // La traduction fiche → ligne est une fonction PURE : elle se teste sans
  // monter React, et ne se recalcule qu'au changement du parc.
  const lignes = useMemo(() => toPairingRows(projects), [projects]);
  const compteurs = useMemo(() => filterCounts(lignes), [lignes]);
  const visibles = useMemo(
    () => lignes.filter((l) => matchesFilter(l, filtre) && matchesSearch(l, recherche)),
    [lignes, filtre, recherche],
  );

  return (
    <div className="page">
      <header className="page-header">
        <h1>Appairages</h1>
        <p className="page-description">
          Une fiche, un appairage, une instance. L’environnement et la destination
          viennent du projet lui-même — ils restent inconnus tant qu’il n’a pas parlé.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {isInitialLoading ? (
        <p className="muted">Chargement des projets…</p>
      ) : lignes.length === 0 ? (
        <EmptyState
          title="Aucune fiche dans le parc"
          hint="Déclarez un projet depuis la page Projets pour gérer son appairage ici."
        />
      ) : (
        <>
          <div className="conn-toolbar">
            <div className="conn-search">
              <SearchField
                id="conn-search"
                label="Rechercher une fiche ou une destination"
                placeholder="Rechercher une fiche, une destination…"
                value={recherche}
                onChange={setRecherche}
              />
            </div>

            {/* Quatre filtres, pas une barre d'outils. Chacun porte son
                compteur : un filtre qui ne ramène rien se voit AVANT le clic. */}
            <div className="conn-filters" role="group" aria-label="Filtrer les fiches">
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
              title="Aucune fiche ne correspond"
              hint="Modifiez la recherche ou revenez au filtre « Toutes »."
            />
          ) : (
            <div className="pairing-list">
              {visibles.map((l) => (
                <PairingRowItem key={l.projectId} row={l} onChanged={reload} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default PairingsPage;
