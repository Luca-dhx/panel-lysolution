/**
 * L'AVANCEMENT D'UNE LISTE — la barre Untitled, et ce qu'elle mesure.
 *
 * La barre glisse sur 500 ms au lieu des 75 ms d'origine : on la regarde
 * AVANCER après avoir coché, c'est le retour qu'on attend du geste. Elle passe
 * au vert à 100 %, quelle que soit la couleur de la liste.
 */
import { ProgressBarBase } from '@/components/base/progress-indicators/progress-indicators';
import { cx } from '@/utils/cx';
import { avancement, TEINTES } from '@/lib/todoLists';
import type { TodoItem, TodoListColor } from '@/types.todoLists';

export function TodoProgress({
  items, color = 'brand', size = 'md', className,
}: {
  items: Pick<TodoItem, 'done'>[];
  color?: TodoListColor;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const a = avancement(items);
  return (
    <div className={cx('flex items-center gap-3', className)}>
      <ProgressBarBase
        value={a.pourcentage}
        className={cx(size === 'sm' ? 'h-1.5' : 'h-2', 'rounded-full')}
        progressClassName={cx(
          'rounded-full duration-500 ease-out motion-reduce:transition-none',
          a.complete ? 'bg-utility-green-500' : TEINTES[color].barre,
        )}
      />
      <span
        className={cx(
          'shrink-0 text-right font-semibold tabular-nums',
          size === 'sm' ? 'min-w-9 text-xs' : 'min-w-11 text-sm',
          a.complete ? 'text-utility-green-700' : 'text-secondary',
        )}
        aria-label={`${a.faits} sur ${a.total} éléments faits, ${a.pourcentage} %`}
      >
        {a.pourcentage}%
      </span>
    </div>
  );
}

export default TodoProgress;
