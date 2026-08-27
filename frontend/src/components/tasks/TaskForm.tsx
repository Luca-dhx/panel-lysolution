/**
 * CRÉER OU MODIFIER UNE TÂCHE.
 *
 * ══ L'ORDRE DES CHAMPS EST L'ORDRE DE LA PENSÉE ═════════════════════════════
 *
 *   1. le nom            on sait ce qu'on veut faire avant de savoir quand
 *   2. l'échéance        c'est la deuxième question, et souvent la dernière
 *   3. la description    facultative, et elle l'est vraiment
 *   4. les sous-tâches   on découpe une fois qu'on a nommé
 *   5. les rattachements en dernier : c'est du classement, pas de la décision
 *
 * ══ RIEN N'EST ENVOYÉ AVANT « ENREGISTRER » ════════════════════════════════
 *
 * Le formulaire tient son propre état et n'écrit qu'une fois. Une sauvegarde à
 * chaque frappe transformerait une hésitation — trois sous-tâches ajoutées puis
 * retirées — en trois écritures et deux suppressions dans l'historique.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Input } from '@/components/base/input/input';
import { TextArea } from '@/components/base/textarea/textarea';
import { Icon } from '@/components/Icon';
import { DueAtPicker } from '@/components/tasks/DueAtPicker';
import { TaskLinkPicker } from '@/components/tasks/TaskLinkPicker';
import { EMPTY_LINKS } from '@/types.tasks';
import type { Subtask, Task, TaskInput, TaskLinks } from '@/types.tasks';
import type { TaskTargetResolver } from '@/lib/useTaskTargets';

const identifiant = () => (
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `st-${Math.random().toString(36).slice(2)}`
);

export interface TaskFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (body: TaskInput) => Promise<void>;
  cibles: TaskTargetResolver;
  /** La tâche à modifier. Absente = création. */
  task?: Task | null;
  /** Rattachements imposés — la fiche d'où l'on vient. */
  liensInitiaux?: Partial<TaskLinks>;
  titre?: string;
}

export function TaskForm({
  open, onClose, onSubmit, cibles, task = null, liensInitiaux, titre,
}: TaskFormProps) {
  const [nom, setNom] = useState('');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [sousTaches, setSousTaches] = useState<Subtask[]>([]);
  const [liens, setLiens] = useState<TaskLinks>(EMPTY_LINKS);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  /*
    LE FORMULAIRE SE RECHARGE À L'OUVERTURE, PAS AU MONTAGE.
    Il reste monté entre deux ouvertures ; sans cette remise à zéro, éditer une
    tâche puis en créer une autre proposerait les valeurs de la première.
  */
  useEffect(() => {
    if (!open) return;
    setNom(task?.name ?? '');
    setDescription(task?.description ?? '');
    setDueAt(task?.dueAt ?? null);
    setSousTaches(task?.subtasks ?? []);
    setLiens({ ...EMPTY_LINKS, ...(task?.links ?? {}), ...(liensInitiaux ?? {}) });
    setErreur(null);
  }, [open, task]);

  const ajouterSousTache = () => setSousTaches((liste) => [
    ...liste, { id: identifiant(), name: '', description: '', done: false },
  ]);

  const modifierSousTache = (id: string, champ: 'name' | 'description', valeur: string) => {
    setSousTaches((liste) => liste.map((s) => (s.id === id ? { ...s, [champ]: valeur } : s)));
  };

  const supprimerSousTache = (id: string) => {
    setSousTaches((liste) => liste.filter((s) => s.id !== id));
  };

  /**
   * RÉORDONNER PAR ÉCHANGE DE VOISINS.
   *
   * Pas de glisser-déposer : au clavier il n'a pas d'équivalent, sur mobile il
   * se bat avec le défilement de la page, et il demande une bibliothèque de
   * plus. Deux flèches font le même travail, s'annoncent aux lecteurs d'écran,
   * et fonctionnent partout.
   */
  const deplacer = (index: number, sens: -1 | 1) => {
    setSousTaches((liste) => {
      const cible = index + sens;
      if (cible < 0 || cible >= liste.length) return liste;
      const copie = [...liste];
      [copie[index], copie[cible]] = [copie[cible], copie[index]];
      return copie;
    });
  };

  const enregistrer = async () => {
    if (!nom.trim()) { setErreur('Un nom est requis.'); return; }
    setEnCours(true);
    setErreur(null);
    try {
      await onSubmit({
        name: nom.trim(),
        description,
        dueAt,
        /* Les sous-tâches sans nom sont ÉCARTÉES ici plutôt que refusées : une
           ligne ajoutée puis laissée vide est un geste abandonné, pas une
           erreur à signaler. */
        subtasks: sousTaches.filter((s) => s.name.trim()),
        links: liens,
      });
      onClose();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Enregistrement impossible.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <ModalOverlay isOpen={open} onOpenChange={(v) => { if (!v) onClose(); }} isDismissable>
      <Modal className="w-full max-w-2xl">
        <Dialog>
          <div className="uui flex flex-col gap-5 p-5 sm:p-6">
            <header>
              <h2 className="text-lg font-semibold text-primary">
                {titre ?? (task ? 'Modifier la tâche' : 'Nouvelle tâche')}
              </h2>
            </header>

            <Input
              label="Nom"
              isRequired
              value={nom}
              onChange={setNom}
              placeholder="Relancer Dupont après le devis"
            />

            <DueAtPicker value={dueAt} onChange={setDueAt} />

            <TextArea
              label="Description"
              value={description}
              onChange={setDescription}
              rows={3}
              placeholder="Ce qu'il faut faire, et ce qu'il faut savoir avant de le faire."
            />

            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-secondary">Sous-tâches</span>
                <Button size="sm" color="secondary" onClick={ajouterSousTache}>
                  Ajouter
                </Button>
              </div>

              {sousTaches.length === 0 ? (
                <p className="text-xs text-tertiary">
                  Aucune sous-tâche. Une tâche simple n’en a pas besoin.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {sousTaches.map((sous, index) => (
                    <li key={sous.id} className="rounded-lg border border-secondary p-3">
                      <div className="flex items-start gap-2">
                        <div className="flex flex-1 flex-col gap-2">
                          <Input
                            aria-label={`Nom de la sous-tâche ${index + 1}`}
                            size="sm"
                            value={sous.name}
                            onChange={(v) => modifierSousTache(sous.id, 'name', v)}
                            placeholder="Nom"
                          />
                          <Input
                            aria-label={`Description de la sous-tâche ${index + 1}`}
                            size="sm"
                            value={sous.description}
                            onChange={(v) => modifierSousTache(sous.id, 'description', v)}
                            placeholder="Description (facultative)"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <Button
                            size="sm" color="tertiary" className="size-8"
                            aria-label={`Monter la sous-tâche ${index + 1}`}
                            isDisabled={index === 0}
                            onClick={() => deplacer(index, -1)}
                          >
                            <Icon name="chevron-down" className="rotate-180" />
                          </Button>
                          <Button
                            size="sm" color="tertiary" className="size-8"
                            aria-label={`Descendre la sous-tâche ${index + 1}`}
                            isDisabled={index === sousTaches.length - 1}
                            onClick={() => deplacer(index, 1)}
                          >
                            <Icon name="chevron-down" />
                          </Button>
                          <Button
                            size="sm" color="link-destructive" className="size-8"
                            aria-label={`Supprimer la sous-tâche ${index + 1}`}
                            onClick={() => supprimerSousTache(sous.id)}
                          >
                            <Icon name="trash" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <TaskLinkPicker value={liens} onChange={setLiens} cibles={cibles} />

            {erreur ? (
              <p role="alert" className="text-sm text-error-primary">{erreur}</p>
            ) : null}

            <footer className="flex flex-wrap justify-end gap-2 border-t border-secondary pt-4">
              <Button color="secondary" onClick={onClose} isDisabled={enCours}>Annuler</Button>
              <Button color="primary" onClick={enregistrer} isLoading={enCours}>
                {task ? 'Enregistrer' : 'Créer la tâche'}
              </Button>
            </footer>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export default TaskForm;
