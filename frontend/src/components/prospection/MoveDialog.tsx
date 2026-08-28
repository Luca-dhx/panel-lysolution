/**
 * DÉPLACER — vers un dossier, ou hors de tout dossier.
 *
 * ══ UN SEUL DIALOGUE POUR UNE FICHE OU POUR VINGT ═══════════════════════════
 *
 * Le geste est le même, et la question aussi : « où ça va ? ». Deux dialogues
 * auraient produit deux libellés à maintenir, et l'un des deux aurait fini par
 * oublier « Sans dossier ».
 *
 * ══ « SANS DOSSIER » EST UNE DESTINATION ═══════════════════════════════════
 *
 * Sortir une fiche d'un dossier est un geste courant — on range, puis on
 * s'aperçoit qu'on s'est trompé de rayon. Sans cette entrée, il faudrait
 * supprimer le dossier pour en extraire son contenu.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Icon } from '@/components/Icon';
import type { FolderNode } from '@/components/prospection/FolderTree';

/** Les dossiers, à plat et indentés — ce qu'une liste de choix peut montrer. */
function aplatir(noeuds: FolderNode[], profondeur = 0): { id: string; label: string; profondeur: number }[] {
  return noeuds.flatMap((n) => [
    { id: n.id, label: n.name, profondeur },
    ...aplatir(n.children, profondeur + 1),
  ]);
}

export function MoveDialog({
  open, onClose, onConfirm, racines, nombre, nomUnique, destinationActuelle,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (folderId: string | null) => Promise<void>;
  racines: FolderNode[];
  /** Combien de fiches sont concernées. */
  nombre: number;
  /** Le nom, quand il n'y en a qu'une : « Déplacer « Chez Marcel » ». */
  nomUnique?: string | null;
  /** Le dossier d'origine, grisé : y « déplacer » ne ferait rien. */
  destinationActuelle?: string | null;
}) {
  const [choisi, setChoisi] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChoisi(destinationActuelle ?? null);
    setErreur(null);
  }, [open, destinationActuelle]);

  const options = aplatir(racines);

  const valider = async () => {
    setEnCours(true);
    setErreur(null);
    try {
      await onConfirm(choisi);
      onClose();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Déplacement impossible.');
    } finally {
      setEnCours(false);
    }
  };

  const ligne = (id: string | null, label: string, profondeur: number, icone: 'archive' | 'stack') => (
    <li key={id ?? '__racine__'}>
      <button
        type="button"
        onClick={() => setChoisi(id)}
        aria-pressed={choisi === id}
        className={[
          'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
          choisi === id ? 'bg-secondary font-medium text-primary' : 'text-secondary hover:bg-secondary',
        ].join(' ')}
        style={{ paddingLeft: `${0.5 + profondeur * 1.25}rem` }}
      >
        <Icon name={icone} size={14} className="shrink-0 text-tertiary" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {/* L'origine est DITE, pas interdite : rien ne casse à confirmer un
            déplacement sur place, et l'expliquer coûte moins qu'un bouton
            désactivé sans raison visible. */}
        {destinationActuelle === id ? (
          <span className="shrink-0 text-xs text-quaternary">actuel</span>
        ) : null}
      </button>
    </li>
  );

  return (
    <ModalOverlay isOpen={open} onOpenChange={(v) => { if (!v) onClose(); }} isDismissable>
      <Modal className="w-full max-w-md">
        <Dialog>
          <div className="uui flex max-h-[80vh] flex-col p-5 sm:p-6">
            <header className="shrink-0">
              <h2 className="text-lg font-semibold text-primary">
                {nomUnique
                  ? `Déplacer « ${nomUnique} »`
                  : `Déplacer ${nombre} prospect${nombre > 1 ? 's' : ''}`}
              </h2>
              <p className="mt-1 text-sm text-tertiary">Choisissez la destination.</p>
            </header>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-lg border border-secondary p-1">
              <ul>
                {ligne(null, 'Sans dossier', 0, 'archive')}
                {options.map((o) => ligne(o.id, o.label, o.profondeur, 'stack'))}
              </ul>
            </div>

            {erreur ? <p role="alert" className="mt-3 text-sm text-error-primary">{erreur}</p> : null}

            <footer className="mt-4 flex shrink-0 flex-wrap justify-end gap-2 border-t border-secondary pt-4">
              <Button color="secondary" onClick={onClose} isDisabled={enCours}>Annuler</Button>
              <Button color="primary" isLoading={enCours} onClick={() => void valider()}>
                Déplacer
              </Button>
            </footer>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export default MoveDialog;
