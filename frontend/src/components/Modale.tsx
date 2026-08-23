// LA MODALE DU PANEL — une seule implémentation, pour tout le Panel.
//
// ── POURQUOI ELLE A QUITTÉ `ConnectionActions` ──────────────────────────────
//
// Elle y était locale, et une deuxième surface avait besoin d'une confirmation
// bloquante. Recopier trente lignes aurait produit deux modales qui divergent :
// l'une piège le focus, l'autre non ; l'une ferme sur `Escape`, l'autre l'oublie.
// Ces écarts-là ne se voient pas à la relecture, seulement au clavier.
//
// `Escape` ferme, le focus entre dedans à l'ouverture et revient d'où il venait
// à la fermeture, le fond ne défile pas derrière. Ces quatre comportements sont
// la raison d'être du composant — pas la boîte grise.
import { useEffect, useRef } from 'react';

export function Modale({
  titre,
  children,
  onClose,
}: {
  titre: string;
  children: React.ReactNode;
  onClose: () => void;
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
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-titre"
        tabIndex={-1}
        ref={boite}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title" id="modal-titre">{titre}</h2>
        {children}
      </div>
    </div>
  );
}
