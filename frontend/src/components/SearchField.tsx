/**
 * CHAMP DE RECHERCHE — une primitive, pas un `<input>` posé là.
 *
 * ── CE QU'IL Y AVAIT ────────────────────────────────────────────────────────
 * Trois recherches, trois apparences. Deux `type="search"` bruts — avec la
 * croix native de WebKit, qui n'obéit à aucun thème et n'existe pas ailleurs —
 * et un `type="text"` dans le sélecteur d'icônes. Aucune n'avait d'icône, de
 * bouton d'effacement cohérent, ni la même hauteur que les autres contrôles.
 *
 * ── CE QUE CE COMPOSANT GARANTIT ────────────────────────────────────────────
 *   · une loupe intégrée, décorative (le champ a déjà un libellé accessible) ;
 *   · un bouton d'effacement RÉEL, visible seulement quand il sert, et qui
 *     rend le focus au champ — sinon on efface et on ne peut plus taper ;
 *   · Échap efface aussi : c'est le geste attendu d'un champ de recherche ;
 *   · la décoration native de WebKit neutralisée (voir `components.css`), pour
 *     qu'il n'y ait jamais deux croix superposées ;
 *   · un libellé toujours associé, visible ou non.
 */
import { useId, useRef } from 'react';

export function SearchField({
  value,
  onChange,
  placeholder = 'Rechercher…',
  label,
  id,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Toujours fourni : un champ sans libellé n'est pas annonçable. */
  label: string;
  id?: string;
  autoFocus?: boolean;
}) {
  const genere = useId();
  const champId = id ?? `search-${genere}`;
  const champ = useRef<HTMLInputElement>(null);

  const effacer = () => {
    onChange('');
    // Rendre le focus : effacer pour devoir re-cliquer serait un geste pour rien.
    champ.current?.focus();
  };

  return (
    <div className="search-field">
      <label className="sr-only" htmlFor={champId}>{label}</label>
      <span className="search-field-icon" aria-hidden="true">⌕</span>
      <input
        id={champId}
        ref={champ}
        type="search"
        className="search-field-input"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); effacer(); } }}
      />
      {value ? (
        <button
          type="button"
          className="search-field-clear"
          aria-label={`Effacer la recherche : ${label}`}
          onClick={effacer}
        >
          <span aria-hidden="true">✕</span>
        </button>
      ) : null}
    </div>
  );
}

export default SearchField;
