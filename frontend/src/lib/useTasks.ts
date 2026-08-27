/**
 * LES TÂCHES, CÔTÉ ÉCRAN.
 *
 * Deux crochets, et la différence compte : `useTasks` interroge le SERVEUR avec
 * un filtre de rattachement — la fiche d'un projet ne veut pas des huit cents
 * tâches du parc pour en garder trois.
 *
 * `useHorloge` est à part parce qu'il ne parle à personne : il fait battre le
 * temps. Sans lui, un compte à rebours resterait figé sur la valeur qu'il avait
 * au chargement de la page, et une échéance passerait sans que rien ne bouge.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { TaskListResult, TaskStatus } from '@/types.tasks';

const REFRESH_MS = 30_000;

export interface TaskFilter {
  status?: TaskStatus;
  projectId?: string;
  prospectId?: string;
  transactionId?: string;
  clientCompanyId?: string;
}

export function useTasks(filtre: TaskFilter = {}) {
  const cle = JSON.stringify(filtre);
  const fetcher = useCallback(async () => api.listTasks(filtre), [cle]);
  const q = useLiveQuery<TaskListResult>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les tâches.',
    key: cle,
  });
  return { ...q, tasks: q.data?.tasks ?? [], summary: q.data?.summary ?? null };
}

/**
 * L'HORLOGE DE L'ÉCRAN.
 *
 * ══ POURQUOI LA MINUTE, ET PAS LA SECONDE ══════════════════════════════════
 *
 * Les comptes à rebours du Panel se lisent en jours, en heures, ou en minutes —
 * jamais en secondes. Battre chaque seconde ferait rendre l'arbre soixante fois
 * plus souvent pour un affichage identique cinquante-neuf fois sur soixante.
 *
 * Le premier battement est aligné sur la minute suivante plutôt que posé
 * soixante secondes plus tard : sinon un « dans 3 min » affiché à 14 h 02 min
 * 59 s resterait faux pendant presque une minute entière.
 */
export function useHorloge(): number {
  const [maintenant, setMaintenant] = useState(() => Date.now());

  useEffect(() => {
    let intervalle: ReturnType<typeof setInterval> | null = null;
    const alignement = setTimeout(() => {
      setMaintenant(Date.now());
      intervalle = setInterval(() => setMaintenant(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));

    return () => {
      clearTimeout(alignement);
      if (intervalle) clearInterval(intervalle);
    };
  }, []);

  return maintenant;
}
