/**
 * LES PROCHAINES TÂCHES, SUR LE TABLEAU DE BORD.
 *
 * ══ CE QU'IL MONTRE, ET CE QU'IL LAISSE À LA PAGE DÉDIÉE ════════════════════
 *
 * Il montre ce qui appelle une décision AUJOURD'HUI : le retard d'abord, puis
 * ce qui vient. Rien d'autre. Les tâches sans échéance et les tâches faites
 * n'ont pas leur place sur un tableau de bord — elles n'appellent aucune
 * action, et elles pousseraient le reste sous la ligne de flottaison.
 *
 * ══ « VOIR » OUVRE LA CARTE COMPLÈTE ═══════════════════════════════════════
 *
 * Avec ses rattachements cliquables : c'est depuis là qu'on saute au projet, au
 * prospect ou au mouvement concerné. Une ligne de tableau de bord doit tenir en
 * une ligne ; la carte, elle, a le droit de tout dire.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/base/buttons/button';
import { Panel, SkeletonRows } from '@/components/ui-kit';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { TaskCard } from '@/components/tasks/TaskCard';
import { TaskForm } from '@/components/tasks/TaskForm';
import { OverdueBadge, TaskCountdown } from '@/components/tasks/TaskUrgency';
import { PostponeDialog } from '@/components/tasks/PostponeDialog';
import { api } from '@/lib/api';
import { buildTimeline, formatDueAt } from '@/lib/taskTime';
import { useHorloge, useTasks } from '@/lib/useTasks';
import { useTaskTargets } from '@/lib/useTaskTargets';
import type { Task, TaskInput } from '@/types.tasks';

/** Au-delà, ce n'est plus un aperçu : c'est la page des tâches, en moins bien. */
const MAX_LIGNES = 6;

export function UpcomingTasksPanel() {
  const maintenant = useHorloge();
  const cibles = useTaskTargets();
  const { tasks, summary, isInitialLoading, reload } = useTasks({ status: 'OPEN' });
  const [ouverte, setOuverte] = useState<Task | null>(null);
  const [aReporter, setAReporter] = useState<Task | null>(null);
  const [enEdition, setEnEdition] = useState<Task | null>(null);

  const { overdue, upcoming } = buildTimeline(tasks, maintenant);
  const lignes = [...overdue, ...upcoming].slice(0, MAX_LIGNES);

  const agir = useCallback(async (action: () => Promise<unknown>) => {
    await action();
    await reload();
  }, [reload]);

  /**
   * ÉDITER DEPUIS LE TABLEAU DE BORD, SANS LE QUITTER.
   *
   * « Voir » ouvre la carte ; de là, « Éditer » ouvre le formulaire complet.
   * Renvoyer vers la page des tâches aurait fait perdre le contexte pour
   * corriger un mot dans un intitulé — et il aurait fallu revenir.
   */
  const enregistrer = useCallback(async (body: TaskInput) => {
    if (enEdition) await api.updateTask(enEdition._id, body);
    await reload();
  }, [enEdition, reload]);

  return (
    <>
      <Panel
        title="Prochaines tâches"
        badge={summary ? <OverdueBadge count={summary.overdue} /> : null}
        actions={<Link className="btn btn-secondary btn-small" to="/taches">Toutes les tâches</Link>}
      >
        {isInitialLoading ? (
          <SkeletonRows rows={3} />
        ) : lignes.length === 0 ? (
          <p className="text-sm text-tertiary">
            Rien à faire dans l’immédiat.
            {summary && summary.undated > 0 ? (
              <> {summary.undated} tâche{summary.undated > 1 ? 's' : ''} sans échéance
                {' '}attend{summary.undated > 1 ? 'ent' : ''} sur la page des tâches.</>
            ) : null}
          </p>
        ) : (
          <ul className="uui flex flex-col divide-y divide-secondary">
            {lignes.map((t) => (
              <li key={t._id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{t.name}</p>
                  <p className="text-xs text-tertiary">{formatDueAt(t.dueAt)}</p>
                </div>
                <TaskCountdown dueAt={t.dueAt} status={t.status} maintenant={maintenant} />
                <Button size="sm" color="link-gray" onClick={() => setOuverte(t)}>Voir</Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* LA CARTE COMPLÈTE, dans un dialogue : le tableau de bord ne perd pas
          son contexte, et la tâche dit tout ce qu'elle a à dire. */}
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
                  onPostpone={() => { setAReporter(ouverte); setOuverte(null); }}
                  onEdit={() => { setEnEdition(ouverte); setOuverte(null); }}
                  onReopen={() => agir(() => api.reopenTask(ouverte._id)).then(() => setOuverte(null))}
                />
              ) : null}
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <TaskForm
        open={enEdition !== null}
        onClose={() => setEnEdition(null)}
        onSubmit={enregistrer}
        cibles={cibles}
        task={enEdition}
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

export default UpcomingTasksPanel;
