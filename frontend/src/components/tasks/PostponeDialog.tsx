/**
 * REPORTER UNE TÂCHE.
 *
 * ══ POURQUOI CE GESTE A SON PROPRE DIALOGUE ═════════════════════════════════
 *
 * Parce qu'il n'est pas le même que « corriger la date ». Corriger une saisie
 * fautive ne raconte rien ; décaler une tâche parce qu'on n'a pas eu le temps
 * raconte quelque chose — et une tâche reportée quatre fois raconte qu'elle
 * résiste. Le serveur consigne donc les reports, et seulement eux.
 *
 * Le dialogue rappelle l'échéance actuelle et le nombre de reports déjà faits :
 * c'est au moment de reporter une cinquième fois qu'il faut se demander si la
 * tâche est bien formulée.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { DueAtPicker } from '@/components/tasks/DueAtPicker';
import { formatDueAt } from '@/lib/taskTime';
import type { Task } from '@/types.tasks';

export function PostponeDialog({
  task, onClose, onConfirm,
}: {
  task: Task | null;
  onClose: () => void;
  onConfirm: (dueAt: string) => Promise<void> | void;
}) {
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  /*
    LA PROPOSITION PAR DÉFAUT EST « DEMAIN », PAS L'ÉCHÉANCE ACTUELLE.
    Reproposer la date qu'on vient de manquer obligerait à la changer à coup
    sûr ; reproposer demain est juste dans la majorité des cas, et se corrige
    d'un clic dans le cas contraire.
  */
  useEffect(() => {
    if (!task) return;
    const demain = new Date();
    demain.setDate(demain.getDate() + 1);
    demain.setHours(9, 0, 0, 0);
    setDueAt(demain.toISOString());
  }, [task]);

  if (!task) return null;

  return (
    <ModalOverlay isOpen onOpenChange={(v) => { if (!v) onClose(); }} isDismissable>
      <Modal className="w-full max-w-lg">
        <Dialog>
          <div className="uui flex flex-col gap-4 p-5 sm:p-6">
            <header>
              <h2 className="text-lg font-semibold text-primary">Reporter « {task.name} »</h2>
              <p className="mt-1 text-sm text-tertiary">
                Échéance actuelle : {formatDueAt(task.dueAt)}.
                {task.postponements.length > 0 ? (
                  <> Déjà reportée {task.postponements.length} fois.</>
                ) : null}
              </p>
            </header>

            <DueAtPicker value={dueAt} onChange={setDueAt} label="Nouvelle échéance" />

            <footer className="flex flex-wrap justify-end gap-2 border-t border-secondary pt-4">
              <Button color="secondary" onClick={onClose} isDisabled={enCours}>Annuler</Button>
              <Button
                color="primary"
                /* REPORTER SANS DATE N'A PAS DE SENS : ce serait retirer
                   l'échéance, ce qui est une autre décision et passe par la
                   modification. */
                isDisabled={!dueAt}
                isLoading={enCours}
                onClick={async () => {
                  if (!dueAt) return;
                  setEnCours(true);
                  try { await onConfirm(dueAt); } finally { setEnCours(false); }
                }}
              >
                Reporter
              </Button>
            </footer>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export default PostponeDialog;
