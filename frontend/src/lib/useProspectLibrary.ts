/**
 * LES DOSSIERS ET LES MODÈLES, CÔTÉ ÉCRAN.
 *
 * ══ L'ARBRE SE LIT EN ENTIER, PAS NIVEAU PAR NIVEAU ═════════════════════════
 *
 * Quelques dizaines de nœuds par famille : une seule requête, et l'écran plie
 * la hiérarchie lui-même. Le charger à mesure qu'on déplie aurait coûté un
 * aller-retour par dossier ouvert, pour une donnée qui tient en deux kilo-octets.
 */
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { FolderKind, ProspectFolder, ProspectTemplate } from '@/types.prospection';

const REFRESH_MS = 60_000;

export function useProspectFolders(kind: FolderKind) {
  const fetcher = useCallback(async () => api.listProspectFolders(kind), [kind]);
  const q = useLiveQuery<{ folders: ProspectFolder[] }>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les dossiers.',
    key: `folders:${kind}`,
  });
  return { ...q, folders: q.data?.folders ?? [] };
}

export function useProspectTemplates() {
  const fetcher = useCallback(async () => api.listProspectTemplates(), []);
  const q = useLiveQuery<{ templates: ProspectTemplate[] }>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les modèles.',
    key: 'templates',
  });
  return { ...q, templates: q.data?.templates ?? [] };
}
