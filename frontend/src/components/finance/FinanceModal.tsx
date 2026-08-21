/**
 * MODALE DES FINANCES — la coquille partagée du formulaire, du détail et de la
 * confirmation de suppression.
 *
 * ══ ELLE TIENT DANS LA VUE, QUOI QU'ELLE CONTIENNE ══════════════════════════
 *
 * Le détail d'un mouvement Stripe fait deux mètres de haut : période, origine,
 * état de remboursement, historique des demandes, panneau du fournisseur.
 * L'ancienne coquille ne bornait pas sa hauteur — elle laissait le FOND
 * défiler. Un enfant centré (`align-items: center`) qui dépasse son conteneur
 * défilant voit son haut sortir par le dessus, et cette partie-là devient
 * INATTEIGNABLE : aucun défilement ne remonte au-dessus du point d'origine.
 * Le titre du mouvement était donc invisible sur TOUTES les tailles d'écran
 * mesurées, jusqu'au bureau en 1280×900.
 *
 * La boîte est désormais bornée à la vue, et c'est ELLE qui défile — à
 * l'intérieur. Le fond ne défile plus du tout.
 *
 * ══ TROIS ZONES, PARCE QUE DEUX NE SUFFISENT PAS ════════════════════════════
 *
 * L'en-tête reste, pour qu'on sache toujours de quel mouvement on parle. Le
 * pied reste, pour que « Fermer » et « Supprimer » n'exigent pas de dérouler
 * deux mètres. Seul le contenu défile. Le pied n'est pas déplacé dans une
 * propriété dédiée : il est déjà, dans les onze appelants, le dernier bloc
 * `.action-buttons` — une position collante suffit, et aucun appel n'a besoin
 * d'être réécrit.
 *
 * Même comportement que la modale des connexions : `Escape` ferme, le focus
 * entre à l'ouverture et retourne d'où il venait, le fond ne défile pas. C'est
 * recopié plutôt qu'importé parce que celle des connexions est privée à son
 * fichier ; l'extraire aurait touché un écran hors du périmètre de ce lot.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** Ce qui peut recevoir le focus dans une fenêtre — l'ordre du DOM fait foi. */
const FOCUSABLES = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

    /**
     * LE FOCUS NE SORT PAS DE LA FENÊTRE.
     *
     * `aria-modal` annonce l'isolement aux technologies d'assistance ; il ne
     * la produit pas. Sans piège, la tabulation quittait la fenêtre dès le
     * dernier bouton et parcourait la page derrière — une page que
     * l'utilisateur ne voit pas et ne peut pas quitter, puisque la fenêtre est
     * toujours ouverte.
     */
    const auClavier = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !boite.current) return;

      const cibles = [...boite.current.querySelectorAll<HTMLElement>(FOCUSABLES)]
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (cibles.length === 0) { e.preventDefault(); boite.current.focus(); return; }

      const premier = cibles[0];
      const dernier = cibles[cibles.length - 1];
      const actif = document.activeElement;

      if (!e.shiftKey && (actif === dernier || actif === boite.current)) {
        e.preventDefault();
        premier.focus();
      } else if (e.shiftKey && (actif === premier || actif === boite.current)) {
        e.preventDefault();
        dernier.focus();
      }
    };

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
          <div className="modal-head-text">
            <h2 id="finance-modal-titre">{title}</h2>
            {hint ? <p className="muted">{hint}</p> : null}
          </div>
          {/*
            UNE CROIX, PARCE QUE « ÉCHAP » NE SE VOIT PAS.

            Sur un téléphone il n'y a pas de touche d'échappement, et toucher
            le fond pour fermer n'est ni annoncé ni découvrable. Le bouton est
            au même endroit dans les onze fenêtres, et il porte un nom : une
            croix sans `aria-label` s'annonce « bouton », rien de plus.
          */}
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Fermer la fenêtre"
            title="Fermer"
          >
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export default FinanceModal;
