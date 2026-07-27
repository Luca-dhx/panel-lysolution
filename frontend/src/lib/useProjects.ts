import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import type { PublicProject } from '@/types';

export interface UseProjectsResult {
  projects: PublicProject[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<PublicProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listProjects();
      setProjects(data.projects);
    } catch (err) {
      setError(errorMessage(err, 'Erreur inattendue lors du chargement des projets.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { projects, loading, error, reload };
}
