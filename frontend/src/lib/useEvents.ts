import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { Meeting, MeetingScope, ProjectEvent, ProjectEventsSummary } from '@/types.events';

/**
 * Lectures VIVANTES de l'agenda et de l'historique.
 *
 * Une réunion devient « à confirmer » sans que personne ne clique : l'écran
 * doit donc l'apprendre seul. On réutilise la primitive de lecture silencieuse
 * — le contenu affiché ne disparaît jamais entre deux réponses, les filtres et
 * le défilement restent où l'utilisateur les a laissés.
 *
 * Cadence plus lente que celle des projets : un rendez-vous ne se joue pas à
 * la seconde.
 */
const REFRESH_MS = 30_000;

export function useMeetings(scope: MeetingScope, projectId?: string) {
  const fetcher = useCallback(
    async () => (await api.listMeetings(scope, projectId)).meetings,
    [scope, projectId],
  );
  const q = useLiveQuery<Meeting[]>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les réunions.',
    key: `m:${scope}:${projectId ?? ''}`,
  });
  return { ...q, meetings: q.data ?? [] };
}

/** Événements d'un projet, ou vue globale explicite. */
export function useEvents(params: { projectId?: string; type?: string; status?: string; all?: boolean }) {
  const cle = `e:${params.projectId ?? ''}:${params.type ?? ''}:${params.status ?? ''}:${params.all ? 'all' : ''}`;
  const fetcher = useCallback(async () => (await api.listEvents(params)).events, [cle]);
  const q = useLiveQuery<ProjectEvent[]>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les événements.',
    key: cle,
  });
  return { ...q, events: q.data ?? [] };
}

/** Ce qui attend une confirmation — nourrit le tableau de bord. */
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
