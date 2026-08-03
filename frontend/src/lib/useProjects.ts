import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { PublicProject } from '@/types';

export interface UseProjectsResult {
  projects: PublicProject[];
  /** Premier chargement UNIQUEMENT — jamais vrai pendant un rafraîchissement. */
  isInitialLoading: boolean;
  /** Rafraîchissement en arrière-plan : le contenu affiché ne bouge pas. */
  isRefreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export interface UseProjectResult {
  project: PublicProject | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Cadence du sondage — assez court pour paraître immédiat, assez long pour
 *  ne pas marteler le serveur. */
const REFRESH_MS = 7000;

/**
 * Conserve les objets INCHANGÉS d'un cycle à l'autre.
 *
 * Sans cela, chaque réponse produit des objets neufs et React refait le travail
 * pour des cartes rigoureusement identiques. Comparer une fois par projet coûte
 * beaucoup moins cher que de reconstruire une liste entière toutes les sept
 * secondes.
 *
 * Si RIEN n'a changé, on rend le tableau précédent lui-même : les écrans qui
 * en dérivent des calculs mémorisés n'ont alors strictement rien à refaire.
 */
export function reconcileProjects(
  previous: PublicProject[],
  next: PublicProject[],
): PublicProject[] {
  const byId = new Map(previous.map((p) => [p.projectId, p]));
  let changed = previous.length !== next.length;
  const merged = next.map((project, index) => {
    const former = byId.get(project.projectId);
    if (former && JSON.stringify(former) === JSON.stringify(project)) {
      if (previous[index] !== former) changed = true; // même projet, autre rang
      return former;
    }
    changed = true;
    return project;
  });
  return changed ? merged : previous;
}

function reconcileProject(previous: PublicProject, next: PublicProject): PublicProject {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/**
 * RAFRAÎCHISSEMENT AUTOMATIQUE — une modification faite dans le Manager d'un
 * projet doit apparaître ici sans clic. Le projet pousse sa projection au
 * Panel en moins d'une seconde ; il ne reste qu'à relire.
 *
 * Sondage léger plutôt que WebSocket : le Panel n'a aucune infrastructure
 * temps réel, et en introduire une pour rafraîchir une liste serait
 * disproportionné. Le sondage doit en revanche être INVISIBLE — c'est le rôle
 * de `useLiveQuery`, qui ne vide jamais l'écran entre deux réponses.
 */
export function useProjects(): UseProjectsResult {
  const fetcher = useCallback(async () => (await api.listProjects()).projects, []);
  const { data, isInitialLoading, isRefreshing, error, reload } = useLiveQuery(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Erreur inattendue lors du chargement des projets.',
    reconcile: reconcileProjects,
  });
  return { projects: data ?? [], isInitialLoading, isRefreshing, error, reload };
}

/** Même lecture vivante, pour une fiche. Repart à zéro si l'on change de projet. */
export function useProject(projectId: string | undefined): UseProjectResult {
  const fetcher = useCallback(
    async () => (await api.getProject(projectId as string)).project,
    [projectId],
  );
  const { data, isInitialLoading, isRefreshing, error, reload } = useLiveQuery(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Projet introuvable.',
    key: projectId ?? '',
    reconcile: reconcileProject,
  });
  return { project: data, isInitialLoading, isRefreshing, error, reload };
}
