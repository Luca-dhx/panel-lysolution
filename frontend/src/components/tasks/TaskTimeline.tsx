/**
 * L'ARBRE CHRONOLOGIQUE D'UNE FICHE.
 *
 * ══ QUATRE GROUPES, ET L'ORDRE EST CELUI DE L'ATTENTION ═════════════════════
 *
 *   en retard        ce qui a déjà trop attendu — le plus ancien en tête
 *   à venir          ce qui arrive — le plus proche en tête
 *   sans échéance    ce qui ne presse pas, et n'est pas clos pour autant
 *   faites           la mémoire, repliée
 *
 * ══ POURQUOI LES TÂCHES SANS ÉCHÉANCE NE SONT PAS DANS LA FRISE ════════════
 *
 * Parce qu'elles n'ont pas de place dedans. Les glisser à la fin de la
 * chronologie leur donnerait implicitement la date « après tout le reste », et
 * les mettre au début « avant tout le reste » : deux mensonges. Leur groupe
 * propre est la seule façon honnête de les montrer sans leur inventer un rang.
 *
 * ══ LE TRAIT VERTICAL N'EST PAS DÉCORATIF ══════════════════════════════════
 *
 * Il relie les points d'un même groupe, et il s'arrête à chaque changement de
 * groupe. C'est ce qui fait lire « ces trois-là se suivent » plutôt que « voici
 * sept lignes ».
 */
import { useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { TaskCountdown } from '@/components/tasks/TaskUrgency';
import { buildTimeline, formatDueAt, subtaskProgress, taskUrgency } from '@/lib/taskTime';
import type { Task } from '@/types.tasks';

const POINT: Record<string, string> = {
  overdue: 'bg-fg-error-primary',
  imminent: 'bg-fg-error-primary',
  soon: 'bg-fg-warning-primary',
  far: 'bg-fg-brand-primary',
  none: 'bg-fg-quaternary',
};

function Ligne({
  task, maintenant, dernier, onOpen,
}: {
  task: Task;
  maintenant: number;
  dernier: boolean;
  onOpen?: (task: Task) => void;
}) {
  const urgence = taskUrgency(task.dueAt, maintenant, task.status);
  const avancement = subtaskProgress(task.subtasks);

  return (
    <li className="relative flex gap-3 pb-3 last:pb-0">
      {/* Le trait s'arrête au dernier point du groupe : il relie, il ne pend pas. */}
      {!dernier ? (
        <span aria-hidden="true" className="absolute top-3 bottom-0 left-[5px] w-px bg-border-secondary" />
      ) : null}
      <span
        aria-hidden="true"
        className={`relative mt-1.5 size-2.5 shrink-0 rounded-full ${POINT[urgence] ?? POINT.none}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm font-medium ${task.status === 'DONE' ? 'text-tertiary line-through' : 'text-primary'}`}>
            {task.name}
          </span>
          <TaskCountdown dueAt={task.dueAt} status={task.status} maintenant={maintenant} />
        </div>
        <p className="text-xs text-tertiary">
          {formatDueAt(task.dueAt)}
          {avancement ? <> · {avancement.done}/{avancement.total} sous-tâches</> : null}
        </p>
      </div>
      {onOpen ? (
        <Button size="sm" color="link-gray" onClick={() => onOpen(task)}>Voir</Button>
      ) : null}
    </li>
  );
}

function Groupe({
  titre, tasks, maintenant, onOpen, repliable = false,
}: {
  titre: string;
  tasks: Task[];
  maintenant: number;
  onOpen?: (task: Task) => void;
  repliable?: boolean;
}) {
  const [ouvert, setOuvert] = useState(!repliable);
  if (!tasks.length) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold tracking-wide text-tertiary uppercase">
          {titre} <span className="text-quaternary">({tasks.length})</span>
        </h4>
        {repliable ? (
          <Button size="sm" color="link-gray" onClick={() => setOuvert((v) => !v)} aria-expanded={ouvert}>
            {ouvert ? 'Masquer' : 'Afficher'}
          </Button>
        ) : null}
      </div>
      {ouvert ? (
        <ul className="flex flex-col">
          {tasks.map((t, i) => (
            <Ligne
              key={t._id}
              task={t}
              maintenant={maintenant}
              dernier={i === tasks.length - 1}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function TaskTimeline({
  tasks, maintenant, onOpen,
}: {
  tasks: Task[];
  maintenant: number;
  onOpen?: (task: Task) => void;
}) {
  const { overdue, upcoming, undated, done } = buildTimeline(tasks, maintenant);

  if (!tasks.length) {
    return (
      <p className="text-sm text-tertiary">
        Aucune tâche rattachée. Le bouton ci-dessus en crée une, déjà reliée à
        cette fiche.
      </p>
    );
  }

  return (
    <div className="uui flex flex-col gap-5">
      <Groupe titre="En retard" tasks={overdue} maintenant={maintenant} onOpen={onOpen} />
      <Groupe titre="À venir" tasks={upcoming} maintenant={maintenant} onOpen={onOpen} />
      <Groupe titre="Sans échéance" tasks={undated} maintenant={maintenant} onOpen={onOpen} />
      {/* Les tâches faites sont repliées : elles sont là pour la mémoire, pas
          pour l'action, et elles finiraient par occuper toute la fiche. */}
      <Groupe titre="Faites" tasks={done} maintenant={maintenant} onOpen={onOpen} repliable />
    </div>
  );
}

export default TaskTimeline;
