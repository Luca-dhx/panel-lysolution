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
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';

export interface ThemedOption {
  value: string;
  label: string;
  /**
   * LA SECONDE LIGNE — le contexte, pas le nom.
   *
   * « Demo SB Auto » ne suffit pas à choisir quand deux instances portent le
   * même nom sur deux environnements. Le libellé nomme, l’indice DISTINGUE.
   * Facultatif : une liste de filtres n’en a pas besoin.
   */
  hint?: string;
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
  searchable = false,
  searchPlaceholder = 'Rechercher…',
  emptyLabel = 'Aucun résultat.',
}: {
  value: string;
  options: ThemedOption[];
  onChange: (value: string) => void;
  /** Ce qui s'affiche quand rien n'est choisi — souvent « Tous ». */
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /**
   * ── POURQUOI LA RECHERCHE VIT ICI, ET NON DANS UN SECOND COMPOSANT ─────
   *
   * Parce qu’un menu déroulant cherchable n’est pas un AUTRE contrôle : ce
   * sont les mêmes règles de clavier, la même fermeture au clic extérieur,
   * le même retournement quand il n’y a pas la place dessous, la même
   * animation de sortie. Un « ProjectPicker » parallèle aurait recopié tout
   * cela — et aurait fini par diverger sur la seule chose qui compte ici :
   * l’accessibilité, qui se dégrade toujours dans la copie.
   *
   * Ce qui change vraiment tient en trois choses : un champ de filtre, une
   * seconde ligne par option, et un état « aucun résultat ».
   */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
}) {
  const [ouvert, setOuvert] = useState(false);
  const [ferme, setFerme] = useState(false);
  const [survole, setSurvole] = useState(0);
  const [versLeHaut, setVersLeHaut] = useState(false);
  const [filtre, setFiltre] = useState('');
  const racine = useRef<HTMLDivElement | null>(null);
  const declencheur = useRef<HTMLButtonElement | null>(null);
  const champ = useRef<HTMLInputElement | null>(null);
  const idMenu = useId();

  const choisie = options.find((o) => o.value === value) ?? null;
  const visible = ouvert || ferme;

  /**
   * LA RECHERCHE PORTE SUR LE LIBELLÉ **ET** SUR L’INDICE.
   *
   * Taper « PROD » doit trouver un projet dont seul l’environnement le dit.
   * Chercher sur le seul nom aurait rendu la seconde ligne décorative.
   */
  const listees = useMemo(() => {
    const q = filtre.trim().toLowerCase();
    if (!searchable || !q) return options;
    return options.filter(
      (o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q),
    );
  }, [options, filtre, searchable]);

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
    /**
     * LE FILTRE REPART À VIDE À CHAQUE OUVERTURE.
     *
     * Le garder d’une fois sur l’autre ferait rouvrir un menu qui masque la
     * plupart de ses options, sans que rien à l’écran n’explique pourquoi.
     */
    setFiltre('');
    setSurvole(Math.max(0, options.findIndex((o) => o.value === value)));
  };

  /** Le focus va au champ dès l’ouverture : on ouvre pour chercher. */
  useEffect(() => {
    if (ouvert && searchable) champ.current?.focus();
  }, [ouvert, searchable]);

  /**
   * Le survol ne doit jamais désigner une option que le filtre vient de
   * retirer — sinon Entrée choisit un élément invisible.
   */
  useEffect(() => {
    setSurvole((i) => (i < listees.length ? i : 0));
  }, [listees.length]);

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
      if (listees.length > 0) setSurvole((i) => (i + 1) % listees.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (listees.length > 0) setSurvole((i) => (i - 1 + listees.length) % listees.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSurvole(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSurvole(Math.max(0, listees.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = listees[survole];
      if (option) choisir(option);
    } else if (e.key === ' ' && !searchable) {
      /**
       * L’ESPACE CHOISIT — SAUF QUAND ON PEUT TAPER.
       *
       * Dans un menu cherchable, l’espace appartient à la saisie : le
       * détourner rendrait impossible de chercher « Demo SB Auto ».
       */
      e.preventDefault();
      const option = listees[survole];
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
          {searchable ? (
            /*
              LE CHAMP VIT DANS LE MENU, et sa touche est traitée par le MÊME
              gestionnaire que le déclencheur : flèches, Entrée et Échap se
              comportent pareil qu’on ait la main sur le bouton ou sur la
              saisie. Deux jeux de règles auraient produit deux menus.
            */
            <li className="tselect-search" role="presentation">
              <Icon name="search" size={13} className="tselect-search-icon" />
              <input
                ref={champ}
                className="tselect-search-input"
                type="text"
                value={filtre}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                onChange={(e) => { setFiltre(e.target.value); setSurvole(0); }}
                onKeyDown={auClavier}
              />
            </li>
          ) : null}

          {listees.length === 0 ? (
            <li className="tselect-empty" role="presentation">{emptyLabel}</li>
          ) : null}

          {listees.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={[
                'tselect-option',
                option.hint ? 'tselect-option-rich' : '',
                option.value === value ? 'tselect-option-selected' : '',
                index === survole ? 'tselect-option-active' : '',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => setSurvole(index)}
              onMouseDown={(e) => { e.preventDefault(); choisir(option); }}
            >
              <span className="tselect-option-label">{option.label}</span>
              {option.hint ? <span className="tselect-option-hint">{option.hint}</span> : null}
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
