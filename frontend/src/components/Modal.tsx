/**
 * LA COQUILLE DE MODALE DU PANEL — clavier, focus, défilement.
 *
 * `Escape` ferme, le focus entre à l'ouverture et retourne d'où il venait, le
 * fond ne défile pas. Rien de tout cela n'est décoratif : sans le retour de
 * focus, un utilisateur au clavier se retrouve en haut de page après chaque
 * fermeture ; sans le verrou de défilement, le fond glisse sous les doigts sur
 * mobile pendant qu'on lit une confirmation destructive.
 *
 * ── POURQUOI UN TROISIÈME EXEMPLAIRE, ET POURQUOI C'EST ASSUMÉ ──────────────
 *
 * Les écrans « connexions » et « finances » portent chacun leur copie, privée
 * à leur fichier. Les fondre serait juste — et toucherait deux surfaces hors
 * du périmètre de ce lot, dont les fichiers portent le travail en cours
 * d'autres chantiers. Celui-ci est donc écrit pour être LA coquille commune :
 * il vit dans `components/`, il n'a aucune dépendance métier, et les deux
 * autres peuvent le rejoindre quand leur écran sera ouvert de toute façon.
 */
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

export function Modal({
  title,
  hint,
  danger = false,
  onClose,
  children,
}: {
  title: string;
  hint?: ReactNode;
  /** La bordure dit la nature de l'action avant qu'on ait lu le titre. */
  danger?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const boite = useRef<HTMLDivElement>(null);
  const rendreLeFocus = useRef<HTMLElement | null>(null);
  const titreId = useId();

  useEffect(() => {
    rendreLeFocus.current = document.activeElement as HTMLElement | null;
    boite.current?.focus();
    document.body.classList.add('no-scroll');
    const auClavier = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', auClavier);
    return () => {
      window.removeEventListener('keydown', auClavier);
      document.body.classList.remove('no-scroll');
      rendreLeFocus.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className={danger ? 'modal modal-danger' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titreId}
        tabIndex={-1}
        ref={boite}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titreId}>{title}</h2>
          {hint ? <p className="muted">{hint}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export default Modal;
