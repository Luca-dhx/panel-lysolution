/**
 * MODALE DES FINANCES — la coquille partagée du formulaire, du détail et de la
 * confirmation de suppression.
 *
 * Même comportement que la modale des connexions : `Escape` ferme, le focus
 * entre à l'ouverture et retourne d'où il venait, le fond ne défile pas. C'est
 * recopié plutôt qu'importé parce que celle des connexions est privée à son
 * fichier ; l'extraire aurait touché un écran hors du périmètre de ce lot.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function FinanceModal({
  title,
  hint,
  danger = false,
  onClose,
  children,
}: {
  title: string;
  hint?: string;
  /** La bordure dit la nature de l'action avant qu'on ait lu le titre. */
  danger?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const boite = useRef<HTMLDivElement>(null);
  const rendreLeFocus = useRef<HTMLElement | null>(null);

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
        aria-labelledby="finance-modal-titre"
        tabIndex={-1}
        ref={boite}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="finance-modal-titre">{title}</h2>
          {hint ? <p className="muted">{hint}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export default FinanceModal;
