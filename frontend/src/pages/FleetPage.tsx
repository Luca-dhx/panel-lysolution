// NIVEAU 1 de la divulgation progressive — le parc, une ligne par projet.
//
// Une ligne porte le strict nécessaire pour décider où cliquer : identité,
// état, versions. Aucun manifeste, aucun composant de santé, aucun
// historique. Le tri place d'office en tête ce qui va mal.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { HealthBadge, LivenessBadge, formatDuration, orUnknown } from '@/components/supervision';
import { errorMessage, supervision } from '@/lib/api';
import type { FleetResult, SearchFacets } from '@/types.supervision';

const FILTERS: Array<{ key: string; label: string; facet: keyof SearchFacets }> = [
  { key: 'environment', label: 'Environnement', facet: 'environments' },
  { key: 'liveness', label: 'Vivacité', facet: 'liveness' },
  { key: 'health', label: 'Santé', facet: 'health' },
  { key: 'type', label: 'Type', facet: 'types' },
  { key: 'contractVersion', label: 'Contrat', facet: 'contractVersions' },
  { key: 'deploymentEngine', label: 'Moteur déploiement', facet: 'deploymentEngineVersions' },
  { key: 'module', label: 'Module', facet: 'modules' },
  { key: 'feature', label: 'Fonctionnalité', facet: 'features' },
];

export function FleetPage() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [result, setResult] = useState<FleetResult | null>(null);
  const [facets, setFacets] = useState<SearchFacets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const criteria = useMemo(
    () => ({ ...filters, ...(query.trim() ? { q: query.trim() } : {}) }),
    [filters, query],
  );

  useEffect(() => {
    supervision.facets().then(setFacets).catch(() => setFacets(null));
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    // Recherche différée : on ne relance pas une requête à chaque frappe.
    const timer = window.setTimeout(() => {
      supervision
        .fleet(criteria)
        .then((r) => { if (active) { setResult(r); setError(null); } })
        .catch((err) => { if (active) setError(errorMessage(err, 'Recherche indisponible.')); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [criteria]);

  const setFilter = (key: string, value: string) => {
    setFilters((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  const activeFilters = Object.keys(filters).length + (query.trim() ? 1 : 0);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Parc</h1>
        <p className="page-description">
          Recherche et filtres sur l’ensemble des projets. Cliquez un projet pour sa fiche.
        </p>
      </header>

      <Card>
        <input
          type="search"
          className="search-input"
          placeholder="Rechercher : nom, slug, domaine, type, version…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="filter-row">
          {FILTERS.map(({ key, label, facet }) => {
            const options = facets?.[facet] ?? [];
            if (options.length === 0) return null;
            return (
              <label key={key} className="filter">
                <span className="filter-label">{label}</span>
                <select value={filters[key] ?? ''} onChange={(e) => setFilter(key, e.target.value)}>
                  <option value="">Tous</option>
                  {options.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
            );
          })}
          {activeFilters > 0 ? (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => { setFilters({}); setQuery(''); }}
            >
              Réinitialiser
            </button>
          ) : null}
        </div>
      </Card>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <Card
        title={
          result
            ? `${result.total} projet${result.total > 1 ? 's' : ''}${
              result.returned < result.total ? ` (${result.returned} affichés)` : ''}`
            : 'Parc'
        }
      >
        {loading ? (
          <p className="muted">Chargement…</p>
        ) : !result || result.items.length === 0 ? (
          <EmptyState
            title="Aucun projet ne correspond"
            hint={activeFilters > 0 ? 'Essayez d’élargir les critères.' : 'Le registre est vide.'}
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Projet</th>
                  <th>Env.</th>
                  <th>Vivacité</th>
                  <th>Santé</th>
                  <th>Version</th>
                  <th>Contrat</th>
                  <th>Dernier signal</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((row) => (
                  <tr key={row.projectId} className={row.issues > 0 ? 'row-attention' : undefined}>
                    <td>
                      <Link to={`/supervision/${row.projectId}`} className="project-link">
                        {row.name}
                      </Link>
                      <span className="muted project-slug">{row.slug}</span>
                    </td>
                    <td>{orUnknown(row.environment)}</td>
                    <td><LivenessBadge value={row.liveness} /></td>
                    <td><HealthBadge value={row.health} /></td>
                    <td>{orUnknown(row.softwareVersion)}</td>
                    <td>{orUnknown(row.contractVersion)}</td>
                    <td>
                      {row.secondsSinceLastHeartbeat === null
                        ? <span className="muted">jamais</span>
                        : `il y a ${formatDuration(row.secondsSinceLastHeartbeat)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
