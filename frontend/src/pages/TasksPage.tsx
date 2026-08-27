/**
 * LES TÂCHES — liste ou calendrier, au choix.
 *
 * ══ DEUX VUES PARCE QU'IL Y A DEUX QUESTIONS ════════════════════════════════
 *
 *   la LISTE       « qu'est-ce qui vient ensuite ? » — triée par urgence,
 *                  groupée par état, et elle montre TOUT, y compris ce qui n'a
 *                  pas de date ;
 *   le CALENDRIER  « où est-ce que ça s'accumule ? » — la densité d'un mois se
 *                  voit sur une grille et jamais sur une liste.
 *
 * Le choix est mémorisé pour la session : passer d'un écran à l'autre et
 * retrouver la vue qu'on n'avait pas choisie est une petite contrariété, mais
 * elle se répète toute la journée.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { PageHeader, Panel, SkeletonRows } from '@/components/ui-kit';
import { Icon } from '@/components/Icon';
import { TaskCalendar } from '@/components/tasks/TaskCalendar';
import { TaskCard } from '@/components/tasks/TaskCard';
import { TaskForm } from '@/components/tasks/TaskForm';
import { OverdueBadge } from '@/components/tasks/TaskUrgency';
import { PostponeDialog } from '@/components/tasks/PostponeDialog';
import { api } from '@/lib/api';
import { buildTimeline } from '@/lib/taskTime';
import { useHorloge, useTasks } from '@/lib/useTasks';
import { useTaskTargets } from '@/lib/useTaskTargets';
import type { Task, TaskInput } from '@/types.tasks';

type Vue = 'liste' | 'calendrier';
const CLEF_VUE = 'panel.tasks.vue';

export default function TasksPage() {
  const [vue, setVue] = useState<Vue>(() => {
    /* Le stockage peut lever — navigation privée, site data bloqué. Une
       préférence d'affichage ne doit jamais empêcher l'écran de s'ouvrir. */
    try {
      return (sessionStorage.getItem(CLEF_VUE) as Vue) || 'liste';
    } catch { return 'liste'; }
  });
  useEffect(() => {
    try { sessionStorage.setItem(CLEF_VUE, vue); } catch { /* sans conséquence */ }
  }, [vue]);

  const [montrerFaites, setMontrerFaites] = useState(false);
  const [enEdition, setEnEdition] = useState<Task | null>(null);
  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [aReporter, setAReporter] = useState<Task | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const maintenant = useHorloge();
  const cibles = useTaskTargets();
  const { tasks, summary, isInitialLoading, reload } = useTasks(
    montrerFaites ? {} : { status: 'OPEN' },
  );

  const { overdue, upcoming, undated, done } = useMemo(
    () => buildTimeline(tasks, maintenant),
    [tasks, maintenant],
  );

  const agir = useCallback(async (action: () => Promise<unknown>) => {
    setErreur(null);
    try {
      await action();
      await reload();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Action impossible.');
    }
  }, [reload]);

  const enregistrer = useCallback(async (body: TaskInput) => {
    if (enEdition) await api.updateTask(enEdition._id, body);
    else await api.createTask(body);
    await reload();
  }, [enEdition, reload]);

  const carte = (t: Task) => (
    <TaskCard
      key={t._id}
      task={t}
      maintenant={maintenant}
      cibles={cibles}
      onToggleSubtask={(subtaskId, coche) => agir(() => api.updateTask(t._id, {
        subtasks: t.subtasks.map((s) => (s.id === subtaskId ? { ...s, done: coche } : s)),
      }))}
      onComplete={() => agir(() => api.completeTask(t._id))}
      onReopen={() => agir(() => api.reopenTask(t._id))}
      onPostpone={() => setAReporter(t)}
      onEdit={() => { setEnEdition(t); setFormulaireOuvert(true); }}
      onDelete={() => agir(() => api.deleteTask(t._id))}
    />
  );

  const groupe = (titre: string, liste: Task[], indice?: string) => (
    liste.length > 0 ? (
      <Panel title={titre} badge={String(liste.length)} description={indice}>
        <div className="flex flex-col gap-3">{liste.map(carte)}</div>
      </Panel>
    ) : null
  );

  return (
    <div className="page">
      <PageHeader
        title="Tâches"
        description="Ce qu’il reste à faire, et ce que ça concerne. Une tâche peut nommer un projet, un prospect, une entreprise et un mouvement à la fois."
        badges={summary ? <OverdueBadge count={summary.overdue} size="md" /> : null}
        actions={(
          <Button
            color="primary"
            iconLeading={() => <Icon name="plus-lg" />}
            onClick={() => { setEnEdition(null); setFormulaireOuvert(true); }}
          >
            Nouvelle tâche
          </Button>
        )}
        toolbar={(
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-secondary p-0.5">
              {(['liste', 'calendrier'] as Vue[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVue(v)}
                  aria-pressed={vue === v}
                  className={[
                    'rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                    vue === v ? 'bg-secondary text-primary' : 'text-tertiary hover:text-secondary',
                  ].join(' ')}
                >
                  {v}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              color={montrerFaites ? 'secondary' : 'link-gray'}
              onClick={() => setMontrerFaites((v) => !v)}
              aria-pressed={montrerFaites}
            >
              {montrerFaites ? 'Masquer les tâches faites' : 'Afficher les tâches faites'}
            </Button>
          </div>
        )}
      />

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      {isInitialLoading ? (
        <Panel title="Tâches"><SkeletonRows rows={4} /></Panel>
      ) : vue === 'calendrier' ? (
        <Panel title="Calendrier" flush>
          <div className="p-4">
            <TaskCalendar
              tasks={tasks}
              maintenant={maintenant}
              onOpen={(t) => { setEnEdition(t); setFormulaireOuvert(true); }}
            />
          </div>
        </Panel>
      ) : tasks.length === 0 ? (
        <Panel title="Tâches">
          <p className="text-sm text-tertiary">
            Aucune tâche. Le bouton « Nouvelle tâche » en crée une — elle peut
            rester sans échéance.
          </p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {groupe('En retard', overdue, 'Le plus ancien d’abord : c’est celui qui a le plus attendu.')}
          {groupe('À venir', upcoming, 'Le plus proche d’abord.')}
          {groupe('Sans échéance', undated, 'Elles ne pressent pas, et elles ne sont pas closes pour autant.')}
          {montrerFaites ? groupe('Faites', done) : null}
        </div>
      )}

      <TaskForm
        open={formulaireOuvert}
        onClose={() => { setFormulaireOuvert(false); setEnEdition(null); }}
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
    </div>
  );
}
