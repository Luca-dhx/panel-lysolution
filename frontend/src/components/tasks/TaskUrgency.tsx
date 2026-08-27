/**
 * LE COMPTE À REBOURS D'UNE TÂCHE, ET SA COULEUR.
 *
 * ══ LA COULEUR EST UNE DÉCISION, PAS UNE DÉCORATION ═════════════════════════
 *
 * Quatre teintes seulement, et chacune répond à « qu'est-ce que je fais de
 * cette ligne, maintenant ? » :
 *
 *   gris     pas d'échéance, ou déjà faite. Rien à décider aujourd'hui.
 *   bleu     plus de trois jours. On la voit, on ne s'en occupe pas.
 *   orange   moins de trois jours. Elle entre dans la semaine.
 *   rouge    imminente ou dépassée. Elle demande une décision.
 *
 * L'imminent et le retard partagent le rouge à dessein : dans les deux cas il
 * faut agir tout de suite, et deux rouges différents auraient demandé au
 * lecteur de faire une distinction dont il ne peut rien tirer.
 *
 * ══ POURQUOI CE COMPOSANT PREND `maintenant` EN PROPRIÉTÉ ══════════════════
 *
 * Il ne lit pas l'heure lui-même. L'horloge bat une fois pour toute la page
 * (`useHorloge`), et tous les rebours de l'écran changent EN MÊME TEMPS. Chacun
 * la lisant pour soi, deux badges voisins pourraient afficher deux minutes
 * différentes — et le lecteur aurait raison de ne plus croire ni l'un ni
 * l'autre.
 */
import { Badge } from '@/components/base/badges/badges';
import { formatCountdown, taskUrgency } from '@/lib/taskTime';
import type { TaskUrgency } from '@/lib/taskTime';
import type { TaskStatus } from '@/types.tasks';

type CouleurBadge = 'gray' | 'blue' | 'orange' | 'error' | 'success';

const COULEURS: Record<TaskUrgency, CouleurBadge> = {
  none: 'gray',
  far: 'blue',
  soon: 'orange',
  imminent: 'error',
  overdue: 'error',
};

export function TaskCountdown({
  dueAt,
  status,
  maintenant,
  size = 'sm',
}: {
  dueAt: string | null;
  status: TaskStatus;
  maintenant: number;
  size?: 'sm' | 'md' | 'lg';
}) {
  if (status === 'DONE') {
    return <Badge size={size} color="success" type="pill-color">Faite</Badge>;
  }

  const urgence = taskUrgency(dueAt, maintenant, status);
  return (
    <Badge size={size} color={COULEURS[urgence]} type="pill-color">
      {formatCountdown(dueAt, maintenant)}
    </Badge>
  );
}

/**
 * LE COMPTEUR DE RETARD.
 *
 * ══ IL DISPARAÎT QUAND IL VAUT ZÉRO ════════════════════════════════════════
 *
 * Un badge « 0 » présent en permanence devient un élément de décor : l'œil
 * cesse de le lire, et le jour où il passe à 3 personne ne le remarque. Il
 * n'apparaît donc que lorsqu'il a quelque chose à dire.
 */
export function OverdueBadge({ count, size = 'sm' }: { count: number; size?: 'sm' | 'md' | 'lg' }) {
  if (!count) return null;
  return (
    <Badge size={size} color="error" type="pill-color">
      {count} en retard
    </Badge>
  );
}

export default TaskCountdown;
