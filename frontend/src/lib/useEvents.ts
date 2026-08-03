import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { EventScope, ProjectEvent, ProjectEventsSummary } from '@/types.events';

/**
 * Lectures VIVANTES de l'agenda.
 *
 * Une confirmation devient due sans que personne ne clique : l'écran doit donc
 * l'apprendre seul. On réutilise la primitive de lecture silencieuse — le
 * contenu affiché ne disparaît jamais entre deux réponses, les filtres et le
 * défilement restent où l'utilisateur les a laissés.
 *
 * Cadence plus lente que celle des projets : un rendez-vous ne se joue pas à
 * la seconde, et une relance toutes les trente secondes suffit largement.
 */
const REFRESH_MS = 30_000;

export function useEvents(scope: EventScope, projectId?: string) {
  const fetcher = useCallback(
    async () => (await api.listEvents(scope, projectId)).events,
    [scope, projectId],
  );
  const q = useLiveQuery<ProjectEvent[]>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger l’agenda.',
    key: `${scope}:${projectId ?? ''}`,
  });
  return { ...q, events: q.data ?? [] };
}

/** Ce qui attend une confirmation — nourrit le badge et la boîte. */
export function usePendingEvents() {
  const fetcher = useCallback(async () => (await api.pendingEvents()).events, []);
  const q = useLiveQuery<ProjectEvent[]>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les confirmations en attente.',
  });
  return { ...q, events: q.data ?? [] };
}

export function useProjectEvents(projectId: string | undefined) {
  const fetcher = useCallback(async () => api.projectEvents(projectId as string), [projectId]);
  const q = useLiveQuery<ProjectEventsSummary>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les événements du projet.',
    key: projectId ?? '',
  });
  return { ...q, summary: q.data };
}
