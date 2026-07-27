import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import type { PanelVersion } from '@/types';

export interface UsePanelVersionResult {
  version: PanelVersion | null;
  loading: boolean;
  error: string | null;
}

export function usePanelVersion(): UsePanelVersionResult {
  const [version, setVersion] = useState<PanelVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .version()
      .then((data) => {
        if (!cancelled) setVersion(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Version du Panel indisponible.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { version, loading, error };
}
