/**
 * LE MENU « ⋮ » D'UNE LIGNE — pour les actions SECONDAIRES, jamais les autres.
 *
 * ══ CE QU'IL RÉSOUT ═════════════════════════════════════════════════════════
 *
 * Une ligne du livret portait jusqu'à cinq boutons côte à côte : Télécharger,
 * Remplacer, Retirer, Rembourser, Voir les détails. Sur un écran étroit, cette
 * file poussait la ligne bien au-delà de la vue, et la colonne suivante n'avait
 * plus de place. Le tableau devenait illisible non pas parce qu'il contenait
 * trop d'INFORMATION, mais trop de COMMANDES.
 *
 * ══ CE QU'IL NE FAIT PAS ════════════════════════════════════════════════════
 *
 * Il ne range pas une action importante hors de vue. « Rembourser » — le geste
 * qui déplace de l'argent — et « Voir les détails » — la seule porte vers le
 * reste — restent des boutons visibles. Ce menu ne reçoit que ce qui se fait
 * rarement : remplacer un justificatif, le retirer.
 *
 * ══ AU CLAVIER ══════════════════════════════════════════════════════════════
 *
 * `aria-haspopup` et `aria-expanded` disent l'état ; `Escape` referme et rend
 * le focus au déclencheur — sans quoi la tabulation repartirait du début du
 * document, et l'utilisateur perdrait sa ligne.
 */
import { useEffect, useRef, useState } from 'react';

export interface RowMenuAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  /** Un retrait n'a pas la même couleur qu'un remplacement, même dans un menu. */
  danger?: boolean;
}

export function RowMenu({ label, actions }: { label: string; actions: RowMenuAction[] }) {
  const [ouvert, setOuvert] = useState(false);
  const declencheur = useRef<HTMLButtonElement>(null);
  const liste = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ouvert) return undefined;
    // Le premier élément reçoit le focus : un menu ouvert au clavier qui
    // laisserait le focus sur son déclencheur obligerait à tabuler à l'aveugle.
    liste.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const auClavier = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOuvert(false);
      declencheur.current?.focus();
    };
    window.addEventListener('keydown', auClavier, true);
    return () => window.removeEventListener('keydown', auClavier, true);
  }, [ouvert]);

  if (actions.length === 0) return null;

  return (
    <div className="conn-menu">
      <button
        ref={declencheur}
        type="button"
        className="btn btn-small conn-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        aria-label={label}
        title={label}
        onClick={() => setOuvert((o) => !o)}
      >
        <span aria-hidden="true">⋮</span>
      </button>

      {ouvert ? (
        <>
          {/* Un voile transparent capte le clic extérieur sans piéger le focus. */}
          <div className="conn-menu-veil" onClick={() => setOuvert(false)} role="presentation" />
          <div className="conn-menu-list" role="menu" ref={liste}>
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className={a.danger ? 'conn-menu-item conn-menu-item-danger' : 'conn-menu-item'}
                disabled={a.disabled}
                title={a.title}
                onClick={() => { setOuvert(false); a.onSelect(); }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default RowMenu;
