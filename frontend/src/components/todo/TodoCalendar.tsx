/**
 * LE MOIS DES TO-DO LISTS — choisir un jour, voir où ça en est.
 *
 * ══ LA GRILLE NE DÉFILE JAMAIS EN LARGEUR ═══════════════════════════════════
 *
 * Le calendrier des tâches impose 560 px et défile sur téléphone. Ici, la case
 * change de CONTENU avec la place : sur ordinateur elle nomme les listes, avec
 * leur pourcentage ; sur téléphone elle ne montre que des pastilles colorées et
 * l'avancement du jour en filet. Le détail vit sous la grille, dans le panneau
 * du jour sélectionné — un toucher suffit pour y aller.
 *
 * ══ LA SEMAINE COMMENCE LE LUNDI ═══════════════════════════════════════════
 *
 * `getDay()` rend 0 pour dimanche : sans décalage, la grille partirait d'un
 * jour trop tôt pour un lecteur français.
 */
import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from '@untitledui/icons';
import { Button } from '@/components/base/buttons/button';
import { avancement, clefJour, TEINTES } from '@/lib/todoLists';
import { cx } from '@/utils/cx';
import type { TodoList } from '@/types.todoLists';

const JOURS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MOIS_ANNEE = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

export function TodoCalendar({
  listes, mois, onMoisChange, selection, onSelect, aujourdHui,
}: {
  listes: TodoList[];
  /** Le premier jour du mois affiché. */
  mois: Date;
  onMoisChange: (mois: Date) => void;
  selection: string;
  onSelect: (jour: string) => void;
  aujourdHui: string;
}) {
  const parJour = useMemo(() => {
    const index = new Map<string, TodoList[]>();
    for (const l of listes) index.set(l.date, [...(index.get(l.date) ?? []), l]);
    return index;
  }, [listes]);

  const cellules = useMemo(() => {
    const premier = new Date(mois.getFullYear(), mois.getMonth(), 1);
    const decalage = (premier.getDay() + 6) % 7;
    const debut = new Date(premier);
    debut.setDate(debut.getDate() - decalage);
    /* Cinq ou six semaines selon le mois : une sixième rangée vide ne sert
       qu'à allonger la page sur téléphone. */
    const dernier = new Date(mois.getFullYear(), mois.getMonth() + 1, 0);
    const semaines = Math.ceil((decalage + dernier.getDate()) / 7);
    return Array.from({ length: semaines * 7 }, (_, i) => {
      const jour = new Date(debut);
      jour.setDate(debut.getDate() + i);
      const clef = clefJour(jour);
      return { clef, numero: jour.getDate(), dansLeMois: jour.getMonth() === mois.getMonth(), listes: parJour.get(clef) ?? [] };
    });
  }, [mois, parJour]);

  const decaler = (n: number) => onMoisChange(new Date(mois.getFullYear(), mois.getMonth() + n, 1));

  return (
    <div className="uui flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" color="tertiary" aria-label="Mois précédent" onClick={() => decaler(-1)} iconLeading={ChevronLeft} />
          <h2 className="min-w-36 text-center text-md font-semibold text-primary first-letter:uppercase sm:min-w-44">
            {MOIS_ANNEE.format(mois)}
          </h2>
          <Button size="sm" color="tertiary" aria-label="Mois suivant" onClick={() => decaler(1)} iconLeading={ChevronRight} />
        </div>
        <Button
          size="sm"
          color="secondary"
          onClick={() => {
            const d = new Date();
            onMoisChange(new Date(d.getFullYear(), d.getMonth(), 1));
            onSelect(aujourdHui);
          }}
        >
          Aujourd’hui
        </Button>
      </header>

      <div className="grid grid-cols-7 gap-1 sm:gap-1.5" role="grid" aria-label={MOIS_ANNEE.format(mois)}>
        {JOURS.map((j) => (
          <div key={j} role="columnheader" className="pb-1 text-center text-xs font-medium text-tertiary">
            <span className="sm:hidden">{j.charAt(0)}</span>
            <span className="hidden sm:inline">{j}</span>
          </div>
        ))}

        {cellules.map((cel) => {
          const selectionne = cel.clef === selection;
          const aujourd = cel.clef === aujourdHui;
          const tous = cel.listes.flatMap((l) => l.items);
          const jourAv = avancement(tous);
          return (
            <button
              key={cel.clef}
              type="button"
              role="gridcell"
              aria-selected={selectionne}
              aria-label={`${cel.numero}${cel.listes.length ? `, ${cel.listes.length} liste${cel.listes.length > 1 ? 's' : ''}, ${jourAv.pourcentage} %` : ''}`}
              onClick={() => onSelect(cel.clef)}
              className={cx(
                'relative flex min-h-14 flex-col items-stretch overflow-hidden rounded-lg p-1 text-left transition-all duration-150 sm:min-h-24 sm:p-1.5',
                'outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-1',
                selectionne
                  ? 'bg-brand-primary ring-2 ring-brand'
                  : 'bg-primary ring-1 ring-secondary hover:bg-primary_hover hover:ring-primary',
                !cel.dansLeMois && 'opacity-40',
              )}
            >
              <span
                className={cx(
                  'flex size-6 items-center justify-center self-center rounded-full text-xs tabular-nums sm:self-start',
                  aujourd ? 'bg-brand-solid font-semibold text-white' : selectionne ? 'font-semibold text-brand-secondary' : 'text-secondary',
                )}
              >
                {cel.numero}
              </span>

              {/* Téléphone : des pastilles. */}
              {cel.listes.length > 0 ? (
                <span className="mt-1 flex flex-wrap justify-center gap-0.5 sm:hidden">
                  {cel.listes.slice(0, 3).map((l) => (
                    <span
                      key={l._id}
                      className={cx('size-1.5 rounded-full', avancement(l.items).complete ? 'bg-utility-green-500' : TEINTES[l.color]?.pastille)}
                    />
                  ))}
                </span>
              ) : null}

              {/* Ordinateur : les noms, avec leur avancement. */}
              <span className="mt-1 hidden flex-col gap-0.5 sm:flex">
                {cel.listes.slice(0, 2).map((l) => {
                  const a = avancement(l.items);
                  return (
                    <span key={l._id} className="flex items-center gap-1 rounded-sm px-0.5">
                      <span className={cx('size-1.5 shrink-0 rounded-full', a.complete ? 'bg-utility-green-500' : TEINTES[l.color]?.pastille)} />
                      <span className={cx('min-w-0 flex-1 truncate text-xs', a.complete ? 'text-quaternary line-through' : 'text-secondary')}>
                        {l.title}
                      </span>
                      <span className="hidden shrink-0 text-[10px] font-medium text-tertiary tabular-nums 2xl:inline">{a.pourcentage}%</span>
                    </span>
                  );
                })}
                {cel.listes.length > 2 ? (
                  <span className="px-0.5 text-xs text-quaternary">+ {cel.listes.length - 2} autre{cel.listes.length - 2 > 1 ? 's' : ''}</span>
                ) : null}
              </span>

              {/* L'avancement du jour, en filet au pied de la case. */}
              {jourAv.total > 0 ? (
                <span aria-hidden="true" className="absolute inset-x-1 bottom-1 h-0.5 overflow-hidden rounded-full bg-quaternary sm:inset-x-1.5">
                  <span
                    className={cx('block h-full rounded-full transition-[width] duration-500 ease-out', jourAv.complete ? 'bg-utility-green-500' : 'bg-fg-brand-primary')}
                    style={{ width: `${jourAv.pourcentage}%` }}
                  />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default TodoCalendar;
