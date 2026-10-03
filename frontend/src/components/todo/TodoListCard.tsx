/**
 * LA CARTE D'UNE TO-DO LIST — on coche ici, on édite ailleurs.
 *
 * ══ CE QU'ON FAIT DEPUIS LA CARTE, ET CE QU'ON N'Y FAIT PAS ═════════════════
 *
 * Cocher, c'est le geste de la journée : il doit coûter un clic, sans changer
 * d'écran. Renommer, réordonner, ajouter des éléments, c'est préparer : cela se
 * fait sur l'écran d'édition, où chaque bloc a la place de respirer. Mêler les
 * deux sur la carte en ferait un formulaire qu'on modifie par mégarde en
 * voulant cocher.
 *
 * Toute la LIGNE est cliquable, pas seulement la case : sur un téléphone, une
 * case de 16 px est une cible trop petite pour un pouce.
 */
import { useState } from 'react';
import { Edit05, Trash01 } from '@untitledui/icons';
import { Badge } from '@/components/base/badges/badges';
import { Button } from '@/components/base/buttons/button';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { TodoProgress } from '@/components/todo/TodoProgress';
import { avancement, libelleJour, TEINTES } from '@/lib/todoLists';
import { cx } from '@/utils/cx';
import type { TodoList } from '@/types.todoLists';

const VISIBLES = 8;

export function TodoListCard({
  liste, aujourdHui, onToggle, onEdit, onDelete, afficherDate = false,
}: {
  liste: TodoList;
  aujourdHui: string;
  onToggle: (itemId: string, done: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Utile hors d'un groupe daté — dans le panneau du jour, la date est déjà dite. */
  afficherDate?: boolean;
}) {
  const [toutVoir, setToutVoir] = useState(false);
  const a = avancement(liste.items);
  const teinte = TEINTES[liste.color] ?? TEINTES.brand;
  const visibles = toutVoir ? liste.items : liste.items.slice(0, VISIBLES);
  const caches = liste.items.length - visibles.length;
  const passee = liste.date < aujourdHui && !a.complete && a.total > 0;

  return (
    <article
      className={cx(
        'uui group relative flex flex-col overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary',
        'transition-shadow duration-200 hover:shadow-md',
      )}
    >
      <span aria-hidden="true" className={cx('absolute inset-y-0 left-0 w-1', a.complete ? 'bg-utility-green-500' : teinte.pastille)} />

      <header className="flex items-start gap-3 px-4 pt-4 pl-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-md font-semibold text-primary">{liste.title}</h3>
            {a.complete ? (
              <Badge type="pill-color" color="success" size="sm">Terminée</Badge>
            ) : passee ? (
              <Badge type="pill-color" color="warning" size="sm">Inachevée</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-tertiary">
            {afficherDate ? `${libelleJour(liste.date, aujourdHui)} · ` : ''}
            {a.total === 0 ? 'Aucun élément' : `${a.faits} / ${a.total} élément${a.total > 1 ? 's' : ''}`}
          </p>
        </div>
        {/* Les actions restent visibles au doigt (pas de survol sur mobile),
            et s'effacent un peu sur ordinateur tant qu'on ne vise pas la carte. */}
        <div className="flex shrink-0 items-center gap-0.5 transition-opacity lg:opacity-60 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
          <Button size="sm" color="tertiary" aria-label={`Modifier « ${liste.title} »`} onClick={onEdit} iconLeading={Edit05} />
          <Button size="sm" color="tertiary-destructive" aria-label={`Supprimer « ${liste.title} »`} onClick={onDelete} iconLeading={Trash01} />
        </div>
      </header>

      {liste.description ? (
        <p className="line-clamp-2 px-4 pt-2 pl-5 text-sm whitespace-pre-line text-tertiary">{liste.description}</p>
      ) : null}

      <div className="px-4 pt-3 pl-5">
        <TodoProgress items={liste.items} color={liste.color} />
      </div>

      {liste.items.length > 0 ? (
        <ul className="mt-2 flex flex-col px-2 pb-2 pl-3">
          {visibles.map((item) => (
            <li key={item.id}>
              <Checkbox
                isSelected={item.done}
                onChange={(coche) => onToggle(item.id, coche)}
                className="w-full cursor-pointer rounded-lg px-2 py-2 transition-colors hover:bg-primary_hover"
                label={(
                  <span
                    className={cx(
                      'block text-sm break-words transition-colors duration-200',
                      item.done ? 'text-quaternary line-through decoration-1' : 'text-secondary',
                    )}
                  >
                    {item.label}
                  </span>
                )}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 pl-5 text-sm text-tertiary">
          Cette liste est vide. « Modifier » permet d’y ajouter des éléments.
        </p>
      )}

      {caches > 0 || toutVoir ? (
        <div className="border-t border-secondary px-4 py-2 pl-5">
          <Button size="sm" color="link-gray" onClick={() => setToutVoir((v) => !v)}>
            {toutVoir ? 'Réduire' : `Afficher ${caches} élément${caches > 1 ? 's' : ''} de plus`}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

export default TodoListCard;
