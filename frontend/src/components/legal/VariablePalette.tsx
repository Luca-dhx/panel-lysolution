import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import type { LegalVariable, LegalVariableSource } from '@/types.legal';

/**
 * LA PALETTE « + Insérer une donnée ».
 *
 * ══ POURQUOI ELLE EST GROUPÉE PAR AUTORITÉ ════════════════════════════════
 *
 * Parce que la question qu'on se pose en écrivant n'est pas « quel est le nom
 * du champ ? » mais « de qui je parle ici ? ». Une liste alphabétique de
 * trente et une clés — `client.siren` juste après `client.siret`, puis
 * `developer.siren` — obligerait à lire le préfixe de chaque ligne pour éviter
 * d'écrire le SIRET de L.Y Solution dans la section « Éditeur du site ». Le
 * groupement rend cette confusion visible avant qu'elle n'arrive.
 *
 * Les trois groupes portent les trois autorités du résolveur, dans le même
 * ordre et sous les mêmes noms. Ce n'est pas cosmétique : c'est ce qui rend la
 * séparation multi-tenant lisible par quelqu'un qui n'ouvrira jamais le code.
 *
 * ══ CE QU'ELLE MONTRE D'UNE VARIABLE ══════════════════════════════════════
 *
 * Son libellé, sa description, et si elle est FACULTATIVE. Ce dernier point
 * est le plus utile à l'écriture : une variable facultative fait disparaître
 * son bloc quand la donnée manque — c'est ainsi qu'un entrepreneur individuel
 * n'affiche pas « Capital social : N/A ». Le savoir en écrivant change la
 * façon de découper les phrases.
 */

const ORDER: LegalVariableSource[] = ['CLIENT', 'DEVELOPER', 'HOST'];

const ICONS: Record<LegalVariableSource, string> = {
  CLIENT: 'building',
  DEVELOPER: 'code-slash',
  HOST: 'hdd-network',
};

interface VariablePaletteProps {
  variables: LegalVariable[];
  sources: Record<string, string>;
  onInsert: (key: string) => void;
  /** Les valeurs disponibles du projet d'aperçu — pour signaler les manquantes. */
  availability?: Record<string, boolean> | null;
}

export function VariablePalette({
  variables, sources, onInsert, availability = null,
}: VariablePaletteProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return ORDER.map((source) => ({
      source,
      label: sources[source] ?? source,
      items: variables.filter(
        (v) => v.source === source
          && (!needle
            || v.label.toLowerCase().includes(needle)
            || v.key.toLowerCase().includes(needle)),
      ),
    })).filter((g) => g.items.length > 0);
  }, [variables, sources, filter]);

  if (!open) {
    return (
      <button type="button" className="btn btn-small legal-insert-btn" onClick={() => setOpen(true)}>
        <Icon name="plus-lg" /> Insérer une donnée
      </button>
    );
  }

  return (
    <div className="legal-palette">
      <div className="legal-palette-head">
        <input
          type="text"
          autoFocus
          value={filter}
          placeholder="Rechercher une donnée…"
          aria-label="Rechercher une donnée"
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(false)}>
          Fermer
        </button>
      </div>

      <div className="legal-palette-body">
        {groups.length === 0 && <p className="muted">Aucune donnée ne correspond.</p>}
        {groups.map((group) => (
          <div key={group.source} className="legal-palette-group">
            <p className="legal-palette-group-title">
              <Icon name={ICONS[group.source]} /> {group.label}
            </p>
            <ul>
              {group.items.map((variable) => {
                /**
                 * `availability` vient du projet choisi pour l'aperçu. Une
                 * donnée manquante n'est PAS grisée : on doit pouvoir
                 * l'insérer — le template ne s'écrit pas pour un seul client.
                 * Elle est simplement signalée, pour qu'on sache que le bloc
                 * disparaîtra sur CE projet-là.
                 */
                const missing = availability ? availability[variable.key] === false : false;
                return (
                  <li key={variable.key}>
                    <button
                      type="button"
                      className="legal-palette-item"
                      onClick={() => { onInsert(variable.key); setOpen(false); setFilter(''); }}
                    >
                      <span className="legal-palette-item-head">
                        <strong>{variable.label}</strong>
                        {!variable.required && <span className="legal-chip">facultative</span>}
                        {missing && (
                          <span className="legal-chip is-warn" title="Non renseignée pour le projet d'aperçu">
                            non renseignée
                          </span>
                        )}
                      </span>
                      <span className="muted legal-palette-item-desc">{variable.description}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export default VariablePalette;
