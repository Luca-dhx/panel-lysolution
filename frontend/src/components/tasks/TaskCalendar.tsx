/**
 * LE MOIS, ET CE QU'IL CONTIENT.
 *
 * ══ CE QUE LA VUE CALENDRIER APPORTE, ET QUE LA LISTE NE PEUT PAS ═══════════
 *
 * La densité. Une liste répond à « qu'est-ce qui vient ensuite ? » ; un
 * calendrier répond à « où est-ce que ça s'accumule ? ». Trois échéances le
 * même jeudi se voient d'un coup d'œil sur une grille, et jamais sur une liste
 * où elles sont trois lignes parmi vingt.
 *
 * ══ LES TÂCHES SANS ÉCHÉANCE N'Y SONT PAS, ET C'EST DIT ════════════════════
 *
 * Un calendrier ne peut pas placer ce qui n'a pas de date. Plutôt que de les
 * faire disparaître en silence — l'utilisateur croirait les avoir perdues —,
 * un bandeau les compte et renvoie à la liste.
 *
 * ══ LA SEMAINE COMMENCE LE LUNDI ═══════════════════════════════════════════
 *
 * `getDay()` rend 0 pour dimanche. Une grille construite dessus décalerait tout
 * d'un jour pour un lecteur français, et le décalage passerait inaperçu jusqu'à
 * ce que quelqu'un manque une échéance.
 */
import { useMemo, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Icon } from '@/components/Icon';
import { taskUrgency } from '@/lib/taskTime';
import type { Task } from '@/types.tasks';

const JOURS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MOIS_ANNEE = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

const PASTILLE: Record<string, string> = {
  overdue: 'bg-fg-error-primary',
  imminent: 'bg-fg-error-primary',
  soon: 'bg-fg-warning-primary',
  far: 'bg-fg-brand-primary',
  none: 'bg-fg-quaternary',
};

/** La clef civile d'un jour, en heure locale — celle où l'échéance se lit. */
function clefJour(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function TaskCalendar({
  tasks, maintenant, onOpen,
}: {
  tasks: Task[];
  maintenant: number;
  onOpen?: (task: Task) => void;
}) {
  const [curseur, setCurseur] = useState(() => {
    const d = new Date(maintenant);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const parJour = useMemo(() => {
    const index = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.dueAt) continue;
      const d = new Date(t.dueAt);
      if (Number.isNaN(d.getTime())) continue;
      const clef = clefJour(d);
      index.set(clef, [...(index.get(clef) ?? []), t]);
    }
    return index;
  }, [tasks]);

  const sansEcheance = tasks.filter((t) => !t.dueAt && t.status === 'OPEN').length;

  const cellules = useMemo(() => {
    const premier = new Date(curseur.getFullYear(), curseur.getMonth(), 1);
    /* Lundi = 0. `getDay()` rend 0 pour dimanche : sans ce décalage la grille
       partirait d'un jour trop tôt. */
    const decalage = (premier.getDay() + 6) % 7;
    const debut = new Date(premier);
    debut.setDate(debut.getDate() - decalage);

    return Array.from({ length: 42 }, (_, i) => {
      const jour = new Date(debut);
      jour.setDate(debut.getDate() + i);
      return {
        date: jour,
        dansLeMois: jour.getMonth() === curseur.getMonth(),
        aujourdHui: clefJour(jour) === clefJour(new Date(maintenant)),
        taches: parJour.get(clefJour(jour)) ?? [],
      };
    });
  }, [curseur, parJour, maintenant]);

  const decaler = (mois: number) => setCurseur(
    (c) => new Date(c.getFullYear(), c.getMonth() + mois, 1),
  );

  return (
    <div className="uui flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" color="tertiary" className="size-8" aria-label="Mois précédent" onClick={() => decaler(-1)}>
            <Icon name="chevron-right" className="rotate-180" />
          </Button>
          <span className="min-w-40 text-center text-sm font-semibold text-primary first-letter:uppercase">
            {MOIS_ANNEE.format(curseur)}
          </span>
          <Button size="sm" color="tertiary" className="size-8" aria-label="Mois suivant" onClick={() => decaler(1)}>
            <Icon name="chevron-right" />
          </Button>
        </div>
        <Button
          size="sm"
          color="secondary"
          onClick={() => {
            const d = new Date(maintenant);
            setCurseur(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
        >
          Aujourd’hui
        </Button>
      </header>

      {sansEcheance > 0 ? (
        <p className="rounded-lg border border-secondary bg-secondary px-3 py-2 text-xs text-tertiary">
          {sansEcheance} tâche{sansEcheance > 1 ? 's' : ''} sans échéance —
          {' '}elles n’apparaissent pas sur la grille, mais elles existent.
          {' '}La vue liste les montre.
        </p>
      ) : null}

      {/* La grille défile dans SON conteneur : sept colonnes ne tiennent pas
          sous 320 px sans écraser les nombres. */}
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-7 gap-px">
            {JOURS.map((j) => (
              <div key={j} className="px-1 pb-1 text-center text-xs font-medium text-tertiary">{j}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-secondary bg-border-secondary">
            {cellules.map((cel) => (
              <div
                key={cel.date.toISOString()}
                className={[
                  'min-h-20 bg-primary p-1.5',
                  cel.dansLeMois ? '' : 'opacity-45',
                ].join(' ')}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={[
                      'text-xs',
                      cel.aujourdHui
                        ? 'flex size-5 items-center justify-center rounded-full bg-brand-solid font-semibold text-white'
                        : 'text-tertiary',
                    ].join(' ')}
                  >
                    {cel.date.getDate()}
                  </span>
                </div>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {cel.taches.slice(0, 3).map((t) => (
                    <li key={t._id}>
                      <button
                        type="button"
                        onClick={() => onOpen?.(t)}
                        className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-secondary"
                      >
                        <span
                          aria-hidden="true"
                          className={`size-1.5 shrink-0 rounded-full ${PASTILLE[taskUrgency(t.dueAt, maintenant, t.status)]}`}
                        />
                        <span className={`truncate text-xs ${t.status === 'DONE' ? 'text-quaternary line-through' : 'text-secondary'}`}>
                          {t.name}
                        </span>
                      </button>
                    </li>
                  ))}
                  {/* Au-delà de trois, on COMPTE plutôt que d'écraser la case :
                      quatre noms tronqués à six caractères n'apprennent rien. */}
                  {cel.taches.length > 3 ? (
                    <li className="px-1 text-xs text-quaternary">
                      + {cel.taches.length - 3} autre{cel.taches.length - 3 > 1 ? 's' : ''}
                    </li>
                  ) : null}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TaskCalendar;
