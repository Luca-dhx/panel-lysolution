/**
 * SÉLECTEUR THÉMÉ — le filtre, enfin dans le thème du Panel.
 *
 * ── CE QU'IL REMPLACE ───────────────────────────────────────────────────────
 * Un `<select>` natif. Sa liste déroulante est dessinée par le système
 * d'exploitation : elle ignore le thème éditable du Panel, ses polices, ses
 * rayons et ses couleurs. Sur un thème sombre, le menu s'ouvrait en blanc. Rien
 * ne peut être fait en CSS pour cela — c'est la limite du composant natif, pas
 * un oubli de mise en forme.
 *
 * ── CE QU'IL NE REMPLACE PAS ────────────────────────────────────────────────
 * Les `<select>` de FORMULAIRE (choisir un projet, une police, un
 * environnement). Un champ de saisie natif reste le meilleur choix sur mobile —
 * le système propose sa roulette — et il porte la validation du formulaire. On
 * remplace les FILTRES, qui sont des commandes d'affichage, pas des saisies.
 *
 * ── ANIMATION DE SORTIE ─────────────────────────────────────────────────────
 * Un menu qui disparaît d'un coup donne l'impression d'un écran qui saute. Il
 * reste donc monté le temps de son animation de fermeture, puis se retire. Sous
 * `prefers-reduced-motion`, ce délai tombe à zéro : personne n'attend une
 * animation qu'il a demandé de ne pas voir.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';

export interface ThemedOption {
  value: string;
  label: string;
}

/** Durée de l'animation de fermeture — la même valeur que le token CSS. */
const SORTIE_MS = 120;

const mouvementReduit = () =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ThemedSelect({
  value,
  options,
  onChange,
  placeholder = 'Choisir…',
  disabled = false,
  ariaLabel,
}: {
  value: string;
  options: ThemedOption[];
  onChange: (value: string) => void;
  /** Ce qui s'affiche quand rien n'est choisi — souvent « Tous ». */
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [ouvert, setOuvert] = useState(false);
  const [ferme, setFerme] = useState(false);
  const [survole, setSurvole] = useState(0);
  const [versLeHaut, setVersLeHaut] = useState(false);
  const racine = useRef<HTMLDivElement | null>(null);
  const declencheur = useRef<HTMLButtonElement | null>(null);
  const idMenu = useId();

  const choisie = options.find((o) => o.value === value) ?? null;
  const visible = ouvert || ferme;

  const fermer = (rendreLeFocus = false) => {
    if (!ouvert) return;
    setOuvert(false);
    if (rendreLeFocus) declencheur.current?.focus();
    if (mouvementReduit()) return;
    // Le menu survit à sa fermeture, le temps de s'effacer.
    setFerme(true);
    window.setTimeout(() => setFerme(false), SORTIE_MS);
  };

  const ouvrir = () => {
    if (disabled) return;
    // Le menu doit rester DANS l'écran : s'il n'y a pas la place dessous, il
    // s'ouvre vers le haut plutôt que de déborder sous la ligne de flottaison.
    const cadre = declencheur.current?.getBoundingClientRect();
    if (cadre) setVersLeHaut(window.innerHeight - cadre.bottom < 240 && cadre.top > 240);
    setFerme(false);
    setOuvert(true);
    setSurvole(Math.max(0, options.findIndex((o) => o.value === value)));
  };

  // Clic à côté : on referme. Sur `mousedown`, pas sur `click` — sinon un clic
  // qui commence dans le menu et finit dehors refermerait sans rien choisir.
  useEffect(() => {
    if (!ouvert) return undefined;
    const dehors = (e: MouseEvent) => {
      if (racine.current && !racine.current.contains(e.target as Node)) fermer();
    };
    document.addEventListener('mousedown', dehors);
    return () => document.removeEventListener('mousedown', dehors);
  });

  const choisir = (option: ThemedOption) => {
    onChange(option.value);
    fermer(true);
  };

  const auClavier = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      fermer(true);
      return;
    }
    if (!ouvert) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        ouvrir();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSurvole((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSurvole((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSurvole(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSurvole(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const option = options[survole];
      if (option) choisir(option);
    } else if (e.key === 'Tab') {
      fermer();
    }
  };

  return (
    <div className="tselect" ref={racine}>
      <button
        type="button"
        ref={declencheur}
        className={ouvert ? 'tselect-trigger tselect-open' : 'tselect-trigger'}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={ouvert}
        aria-controls={ouvert ? idMenu : undefined}
        aria-label={ariaLabel}
        onClick={() => (ouvert ? fermer() : ouvrir())}
        onKeyDown={auClavier}
      >
        <span className={choisie ? 'tselect-value' : 'tselect-value tselect-placeholder'}>
          {choisie ? choisie.label : placeholder}
        </span>
        <Icon name="chevron-down" className="tselect-chevron" />
      </button>

      {visible ? (
        <ul
          className={[
            'tselect-menu',
            versLeHaut ? 'tselect-menu-up' : '',
            ferme ? 'tselect-menu-closing' : '',
          ].filter(Boolean).join(' ')}
          id={idMenu}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={[
                'tselect-option',
                option.value === value ? 'tselect-option-selected' : '',
                index === survole ? 'tselect-option-active' : '',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => setSurvole(index)}
              onMouseDown={(e) => { e.preventDefault(); choisir(option); }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Un filtre complet : son intitulé et son sélecteur. */
export function ThemedFilter({
  label,
  ...props
}: { label: string } & Parameters<typeof ThemedSelect>[0]) {
  return (
    <div className="filter">
      <span className="filter-label">{label}</span>
      <ThemedSelect ariaLabel={label} {...props} />
    </div>
  );
}

export default ThemedSelect;
