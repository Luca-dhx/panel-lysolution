/**
 * LA CARTE COMPLÈTE D'UNE TÂCHE.
 *
 * ══ CE QU'ELLE MONTRE, ET DANS QUEL ORDRE ══════════════════════════════════
 *
 * L'ordre suit la question qu'on se pose en l'ouvrant :
 *
 *   1. quoi, et pour quand          nom, rebours, échéance
 *   2. de quoi il s'agit            description
 *   3. où j'en suis                 sous-tâches, cochables
 *   4. sur quoi ça porte            rattachements, cliquables
 *   5. ce que j'en fais             faite, reporter, modifier
 *
 * ══ LES RATTACHEMENTS SONT DES LIENS, PAS DES ÉTIQUETTES ═══════════════════
 *
 * C'est le point de la fonctionnalité : depuis la tâche, on va au projet, au
 * prospect, au mouvement. Une cible disparue perd son lien mais garde sa ligne
 * — la tâche dit toujours de quoi elle parlait, et l'écran le dit avec des mots
 * plutôt qu'avec un identifiant technique.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/base/badges/badges';
import { Button } from '@/components/base/buttons/button';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { Icon } from '@/components/Icon';
import { TaskCountdown } from '@/components/tasks/TaskUrgency';
import { formatDueAt, subtaskProgress, taskUrgency } from '@/lib/taskTime';
import { TASK_LINK_KINDS, TASK_LINK_LABELS } from '@/types.tasks';
import type { Task, TaskLinkKind } from '@/types.tasks';
import type { TaskTargetResolver } from '@/lib/useTaskTargets';

/**
 * LES DEUX DÉCISIONS D'UNE TÂCHE ÉCHUE, ET LEURS COULEURS.
 *
 * ══ POURQUOI CE N'EST PAS DÉCORATIF ═════════════════════════════════════════
 *
 * Une échéance passée pose exactement deux questions — « c'est fait ? » ou
 * « on repousse ? » — et ce sont deux réponses OPPOSÉES. Les peindre du même
 * gris obligeait à lire les deux libellés avant de cliquer, à chaque fois.
 *
 * Le vert et l'orange sont ceux du Panel : `--p-ok` et `--p-warn`, par les
 * échelles `utility-green` et `utility-orange` du pont. Pas un code
 * hexadécimal — changer le thème repeint ces deux boutons comme le reste.
 *
 * `Button` n'expose pas de couleur verte ni orange : on part de `primary`, dont
 * on garde la forme, le rembourrage et les états de focus, et on remplace la
 * seule teinte. `tailwind-merge` fait gagner la classe la plus tardive.
 *
 * ── POURQUOI DES CLASSES MAISON, ET PAS DES UTILITAIRES ────────────────────
 * Parce que la teinte de SURVOL n'était pas émise : `hover:bg-utility-green-600`
 * n'existait dans aucune des feuilles produites — vérifié fichier par fichier.
 * Un bouton dont le survol ne répond pas se lit comme un bouton mort. Les deux
 * règles vivent donc dans `components.css`, sur `--p-ok` et `--p-warn`.
 */
const VERT = 'task-btn-done';
const ORANGE = 'task-btn-postpone';

export interface TaskCardProps {
  task: Task;
  maintenant: number;
  cibles: TaskTargetResolver;
  onToggleSubtask?: (subtaskId: string, done: boolean) => void;
  onComplete?: () => void;
  onReopen?: () => void;
  onPostpone?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Compacte : la carte vit dans une fiche, pas sur sa propre page. */
  dense?: boolean;
}

export function TaskCard({
  task, maintenant, cibles,
  onToggleSubtask, onComplete, onReopen, onPostpone, onEdit, onDelete,
  dense = false,
}: TaskCardProps) {
  const [deplie, setDeplie] = useState(!dense);
  const avancement = subtaskProgress(task.subtasks);
  const urgence = taskUrgency(task.dueAt, maintenant, task.status);
  const faite = task.status === 'DONE';

  const rattachements = TASK_LINK_KINDS
    .map((kind) => ({ kind, ids: task.links?.[kind] ?? [] }))
    .filter((r) => r.ids.length > 0);

  return (
    <article
      className={[
        'uui rounded-xl border bg-primary p-4',
        /* LE CADRE PORTE L'URGENCE. Sur une liste longue, la bordure se voit
           avant le badge : elle se lit en balayant, sans lire. */
        urgence === 'overdue' ? 'border-error-subtle' : 'border-secondary',
        faite ? 'opacity-70' : '',
      ].join(' ')}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={`text-md font-semibold ${faite ? 'text-tertiary line-through' : 'text-primary'}`}>
              {task.name}
            </h3>
            <TaskCountdown dueAt={task.dueAt} status={task.status} maintenant={maintenant} />
          </div>
          <p className="mt-0.5 text-xs text-tertiary">
            {formatDueAt(task.dueAt)}
            {task.postponements.length > 0 ? (
              /* UN REPORT RÉPÉTÉ DIT QUELQUE CHOSE que la nouvelle date, seule,
                 ne dit pas : la tâche résiste. */
              <> · reportée {task.postponements.length} fois</>
            ) : null}
          </p>
        </div>

        {dense ? (
          <Button
            size="sm"
            color="link-gray"
            onClick={() => setDeplie((v) => !v)}
            aria-expanded={deplie}
          >
            {deplie ? 'Réduire' : 'Voir'}
          </Button>
        ) : null}
      </header>

      {deplie ? (
        <>
          {task.description ? (
            <p className="mt-3 text-sm whitespace-pre-wrap text-secondary">{task.description}</p>
          ) : null}

          {task.subtasks.length > 0 ? (
            <section className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold tracking-wide text-tertiary uppercase">
                  Sous-tâches
                </h4>
                {avancement ? (
                  <span className="text-xs text-tertiary">
                    {avancement.done} / {avancement.total}
                  </span>
                ) : null}
              </div>
              <ul className="mt-2 flex flex-col gap-1.5">
                {task.subtasks.map((sous) => (
                  <li key={sous.id} className="flex items-start gap-2.5">
                    <Checkbox
                      isSelected={sous.done}
                      isDisabled={!onToggleSubtask}
                      onChange={(v) => onToggleSubtask?.(sous.id, v)}
                      aria-label={sous.name}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <p className={`text-sm ${sous.done ? 'text-tertiary line-through' : 'text-secondary'}`}>
                        {sous.name}
                      </p>
                      {sous.description ? (
                        <p className="text-xs text-tertiary">{sous.description}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {rattachements.length > 0 ? (
            <section className="mt-4">
              <h4 className="text-xs font-semibold tracking-wide text-tertiary uppercase">
                Rattachements
              </h4>
              <div className="mt-2 flex flex-col gap-2">
                {rattachements.map(({ kind, ids }) => (
                  <div key={kind} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-tertiary">
                      {ids.length > 1
                        ? TASK_LINK_LABELS[kind as TaskLinkKind].pluriel
                        : TASK_LINK_LABELS[kind as TaskLinkKind].singulier}
                    </span>
                    {ids.map((id) => {
                      const cible = cibles.resolve(kind as TaskLinkKind, id);
                      return cible.to ? (
                        <Link
                          key={id}
                          to={cible.to}
                          className="rounded-md border border-secondary px-2 py-0.5 text-xs text-secondary hover:bg-secondary"
                        >
                          {cible.label}
                          <Icon name="box-arrow-up-right" className="ml-1 opacity-60" />
                        </Link>
                      ) : (
                        <span
                          key={id}
                          className="rounded-md border border-dashed border-secondary px-2 py-0.5 text-xs text-quaternary"
                        >
                          {cible.label}
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {/*
        LES ACTIONS SUIVENT L'ÉTAT.

        Une tâche EN RETARD pose exactement deux questions — « faite ? » ou
        « on repousse ? » — et ce sont les deux boutons mis en avant. Les
        proposer en permanence, sur une tâche due dans trois semaines, aurait
        dilué le moment où ils comptent.
      */}
      {(onComplete || onPostpone || onEdit || onDelete || onReopen) ? (
        <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-secondary pt-3">
          {faite ? (
            onReopen ? (
              <Button size="sm" color="secondary" iconLeading={() => <Icon name="arrow-clockwise" />} onClick={onReopen}>
                Rouvrir
              </Button>
            ) : null
          ) : (
            <>
              {onComplete ? (
                <Button size="sm" color="primary" className={VERT} iconLeading={() => <Icon name="check2" />} onClick={onComplete}>
                  Fait
                </Button>
              ) : null}
              {onPostpone ? (
                <Button size="sm" color="primary" className={ORANGE} iconLeading={() => <Icon name="clock" />} onClick={onPostpone}>
                  Reporter
                </Button>
              ) : null}
            </>
          )}
          {onEdit ? (
            <Button size="sm" color="secondary" iconLeading={() => <Icon name="pencil" />} onClick={onEdit}>
              Éditer
            </Button>
          ) : null}
          {onDelete ? (
            <Button size="sm" color="link-destructive" onClick={onDelete}>Supprimer</Button>
          ) : null}
          {faite && task.completedAt ? (
            <Badge size="sm" color="gray" type="pill-color" className="ml-auto">
              Faite le {new Date(task.completedAt).toLocaleDateString('fr-FR')}
            </Badge>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export default TaskCard;
