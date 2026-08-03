import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import type { PublicProject } from '@/types';

export interface UseProjectsResult {
  projects: PublicProject[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Cadence du sondage — assez court pour paraître immédiat, assez long pour
 *  ne pas marteler le serveur. */
const REFRESH_MS = 7000;

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

  /**
   * RAFRAÎCHISSEMENT AUTOMATIQUE — une modification faite dans le Manager d'un
   * projet doit apparaître ici sans clic. Le projet pousse sa projection au
   * Panel en moins d'une seconde ; il ne reste qu'à relire.
   *
   * Sondage léger plutôt que WebSocket : le Panel n'a aucune infrastructure
   * temps réel, et en introduire une pour rafraîchir une liste serait
   * disproportionné. On se tait quand l'onglet est caché — personne ne
   * regarde, rien ne sert de solliciter le serveur.
   */
  useEffect(() => {
    void reload();
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void reload();
    };
    const timer = setInterval(tick, REFRESH_MS);
    // Revenir sur la fenêtre est le moment où l'on veut des données fraîches.
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [reload]);

  return { projects, loading, error, reload };
}
