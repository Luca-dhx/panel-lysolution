/**
 * LES TÂCHES D'UNE FICHE — projet, prospect, entreprise, mouvement.
 *
 * ══ LE FILTRE EST POSÉ SUR LE SERVEUR, PAS APRÈS COUP ═══════════════════════
 *
 * La fiche d'un projet ne veut pas des huit cents tâches du parc pour en garder
 * trois. `useTasks` passe le rattachement en paramètre de requête, et le
 * serveur a un index dessus.
 *
 * ══ LE BOUTON DE CRÉATION ARRIVE DÉJÀ RATTACHÉ ═════════════════════════════
 *
 * C'est tout l'intérêt du raccourci : créer une tâche depuis la fiche d'un
 * prospect et devoir ensuite le retrouver dans une liste de rattachements
 * n'aurait fait gagner aucun geste. Le rattachement est imposé à l'ouverture du
 * formulaire — et il reste modifiable, parce qu'une tâche peut concerner un
 * second projet.
 */
import { useCallback, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Panel, SkeletonRows } from '@/components/ui-kit';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Icon } from '@/components/Icon';
import { TaskCard } from '@/components/tasks/TaskCard';
import { TaskForm } from '@/components/tasks/TaskForm';
import { TaskTimeline } from '@/components/tasks/TaskTimeline';
import { OverdueBadge } from '@/components/tasks/TaskUrgency';
import { PostponeDialog } from '@/components/tasks/PostponeDialog';
import { api } from '@/lib/api';
import { useHorloge, useTasks } from '@/lib/useTasks';
import { useTaskTargets } from '@/lib/useTaskTargets';
import type { TaskFilter } from '@/lib/useTasks';
import type { Task, TaskInput, TaskLinks } from '@/types.tasks';

export interface LinkedTasksPanelProps {
  /** Le rattachement qui définit « les tâches de cette fiche ». */
  filtre: TaskFilter;
  /** Le même rattachement, en forme de liens — pour la création. */
  liensInitiaux: Partial<TaskLinks>;
  titre?: string;
}

export function LinkedTasksPanel({
  filtre, liensInitiaux, titre = 'Tâches',
}: LinkedTasksPanelProps) {
  const maintenant = useHorloge();
  const cibles = useTaskTargets();
  /* On demande TOUT, faites comprises : la chronologie a besoin des tâches
     closes pour montrer ce qui a été fait, et elle les replie elle-même. */
  const { tasks, isInitialLoading, reload } = useTasks(filtre);

  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [enEdition, setEnEdition] = useState<Task | null>(null);
  const [ouverte, setOuverte] = useState<Task | null>(null);
  const [aReporter, setAReporter] = useState<Task | null>(null);

  const enRetard = tasks.filter(
    (t) => t.status === 'OPEN' && t.dueAt && new Date(t.dueAt).getTime() < maintenant,
  ).length;

  const agir = useCallback(async (action: () => Promise<unknown>) => {
    await action();
    await reload();
  }, [reload]);

  const enregistrer = useCallback(async (body: TaskInput) => {
    if (enEdition) await api.updateTask(enEdition._id, body);
    else await api.createTask(body);
    await reload();
  }, [enEdition, reload]);

  return (
    <>
      <Panel
        title={titre}
        badge={<OverdueBadge count={enRetard} />}
        description="En retard, à venir, sans échéance, puis faites."
        actions={(
          <Button
            size="sm"
            color="secondary"
            iconLeading={() => <Icon name="plus-lg" />}
            onClick={() => { setEnEdition(null); setFormulaireOuvert(true); }}
          >
            Nouvelle tâche
          </Button>
        )}
      >
        {isInitialLoading
          ? <SkeletonRows rows={3} />
          : <TaskTimeline tasks={tasks} maintenant={maintenant} onOpen={setOuverte} />}
      </Panel>

      <ModalOverlay isOpen={ouverte !== null} onOpenChange={(v) => { if (!v) setOuverte(null); }} isDismissable>
        <Modal className="w-full max-w-xl">
          <Dialog>
            <div className="p-4 sm:p-5">
              {ouverte ? (
                <TaskCard
                  task={ouverte}
                  maintenant={maintenant}
                  cibles={cibles}
                  onToggleSubtask={(subtaskId, coche) => agir(() => api.updateTask(ouverte._id, {
                    subtasks: ouverte.subtasks.map((s) => (s.id === subtaskId ? { ...s, done: coche } : s)),
                  })).then(() => setOuverte(null))}
                  onComplete={() => agir(() => api.completeTask(ouverte._id)).then(() => setOuverte(null))}
                  onReopen={() => agir(() => api.reopenTask(ouverte._id)).then(() => setOuverte(null))}
                  onPostpone={() => { setAReporter(ouverte); setOuverte(null); }}
                  onEdit={() => { setEnEdition(ouverte); setOuverte(null); setFormulaireOuvert(true); }}
                />
              ) : null}
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <TaskForm
        open={formulaireOuvert}
        onClose={() => { setFormulaireOuvert(false); setEnEdition(null); }}
        onSubmit={enregistrer}
        cibles={cibles}
        task={enEdition}
        liensInitiaux={enEdition ? undefined : liensInitiaux}
      />

      <PostponeDialog
        task={aReporter}
        onClose={() => setAReporter(null)}
        onConfirm={async (dueAt) => {
          if (aReporter) await agir(() => api.postponeTask(aReporter._id, dueAt));
          setAReporter(null);
        }}
      />
    </>
  );
}

export default LinkedTasksPanel;
