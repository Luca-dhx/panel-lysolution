import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { Meeting, ProjectEvent } from '@/types.events';
import type { Prospect, ProspectListResult, ProspectStatus } from '@/types.prospection';

/**
 * LECTURES VIVANTES DE LA PROSPECTION.
 *
 * Même primitive que l'agenda : le contenu affiché ne disparaît jamais entre
 * deux réponses, et le tri comme le défilement restent où l'utilisateur les a
 * laissés. Sans cela, un rafraîchissement remettrait le tableau en haut de
 * page toutes les trente secondes.
 *
 * Cadence de l'agenda, et pour la même raison : une affaire commerciale ne se
 * joue pas à la seconde, mais un statut changé depuis un autre poste doit finir
 * par arriver sans qu'on recharge la page.
 */
const REFRESH_MS = 30_000;

export function useProspects(status?: ProspectStatus | '') {
  const cle = `p:${status ?? ''}`;
  const fetcher = useCallback(
    async () => api.listProspects(status || undefined),
    [cle],
  );
  const q = useLiveQuery<ProspectListResult>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les prospects.',
    key: cle,
  });
  return {
    ...q,
    prospects: q.data?.prospects ?? [],
    summary: q.data?.summary ?? null,
  };
}

/** La fiche : le prospect, son agenda, son historique — en une seule lecture. */
export function useProspect(prospectId: string | undefined) {
  const fetcher = useCallback(
    async () => api.getProspect(prospectId as string),
    [prospectId],
  );
  const q = useLiveQuery<{ prospect: Prospect; meetings: Meeting[]; events: ProjectEvent[] }>(
    fetcher,
    {
      intervalMs: REFRESH_MS,
      fallbackError: 'Impossible de charger ce prospect.',
      key: prospectId ?? '',
    },
  );
  return {
    ...q,
    prospect: q.data?.prospect ?? null,
    meetings: q.data?.meetings ?? [],
    events: q.data?.events ?? [],
  };
}
