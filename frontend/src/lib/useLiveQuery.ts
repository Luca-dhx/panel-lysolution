import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api';

/**
 * LECTURE VIVANTE — une donnée qui se rafraîchit seule, SANS que l'écran bouge.
 *
 * ── LE PROBLÈME QU'ELLE RÉSOUT ─────────────────────────────────────────────
 * Un sondage naïf repasse `loading` à vrai à chaque cycle. Comme les écrans
 * s'écrivent `loading ? <chargement…> : <contenu>`, la page entière disparaît
 * puis revient toutes les sept secondes. Techniquement correct, visuellement
 * insupportable : l'utilisateur PERÇOIT chaque requête.
 *
 * D'où la distinction, qui est le cœur de ce module :
 *
 *   isInitialLoading — il n'y a RIEN à montrer. Un chargement est légitime.
 *   isRefreshing     — il y a déjà quelque chose à l'écran. On ne touche à rien.
 *
 * Les deux ne doivent jamais être le même booléen. C'est exactement cette
 * confusion qui produit le clignotement.
 *
 * ── CE QUI SURVIT À UN ÉCHEC ───────────────────────────────────────────────
 * Une donnée affichée ne disparaît pas parce qu'un rafraîchissement a raté.
 * `error` n'est renseigné que lorsqu'il n'y a rien à montrer ; sinon le
 * dernier état connu reste, et l'on retente au cycle suivant. Une coupure
 * réseau de sept secondes ne doit pas transformer une page lue en page d'erreur.
 */
export interface LiveQuery<T> {
  data: T | null;
  /** Premier chargement : aucune donnée en cache. Un squelette est autorisé. */
  isInitialLoading: boolean;
  /** Rafraîchissement en arrière-plan : le contenu reste, intégralement. */
  isRefreshing: boolean;
  /** Erreur BLOQUANTE — uniquement s'il n'y a rien d'affichable. */
  error: string | null;
  reload: () => Promise<void>;
}

export interface LiveQueryOptions<T> {
  /** Cadence du sondage, en millisecondes. */
  intervalMs: number;
  /** Message affiché si le tout premier chargement échoue. */
  fallbackError: string;
  /**
   * Change d'identité quand la ressource demandée change (autre projet, par
   * exemple). Repart alors sur un vrai premier chargement.
   */
  key?: string;
  /**
   * Fusion de l'ancien et du nouvel état. Sert à conserver les références des
   * objets inchangés, pour que React n'ait rien à refaire.
   */
  reconcile?: (previous: T, next: T) => T;
}

export function useLiveQuery<T>(
  fetcher: () => Promise<T>,
  { intervalMs, fallbackError, key = '', reconcile }: LiveQueryOptions<T>,
): LiveQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Les fonctions passées par les écrans sont réécrites à chaque rendu. Les
  // lire dans une référence évite de relancer le minuteur en permanence — ce
  // qui produirait précisément le sondage incontrôlé que l'on veut éviter.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  const hasDataRef = useRef(false);
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);

  const run = useCallback(async () => {
    // UNE seule requête à la fois. Le retour sur la fenêtre et le minuteur
    // peuvent tomber au même instant ; sans cette garde, ils se doublent.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (hasDataRef.current) setIsRefreshing(true);
    try {
      const next = await fetcherRef.current();
      if (!aliveRef.current) return;
      setData((previous) =>
        previous !== null && reconcileRef.current
          ? reconcileRef.current(previous, next)
          : next);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      // Rien à l'écran : il faut bien dire quelque chose. Sinon on se tait et
      // l'on garde ce qui est affiché.
      if (!hasDataRef.current) setError(errorMessage(err, fallbackError));
    } finally {
      if (aliveRef.current) {
        setIsInitialLoading(false);
        setIsRefreshing(false);
      }
      inFlightRef.current = false;
    }
  }, [fallbackError]);

  useEffect(() => {
    aliveRef.current = true;
    inFlightRef.current = false;
    hasDataRef.current = false;
    setData(null);
    setIsInitialLoading(true);
    setIsRefreshing(false);
    setError(null);

    void run();
    const tick = () => {
      // Onglet caché : personne ne regarde, rien ne sert de solliciter.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void run();
    };
    const timer = setInterval(tick, intervalMs);
    // Revenir sur la fenêtre est le moment où l'on veut des données fraîches.
    window.addEventListener('focus', tick);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [key, intervalMs, run]);

  return { data, isInitialLoading, isRefreshing, error, reload: run };
}

/**
 * Vrai seulement si `value` reste vrai plus de `delayMs`.
 *
 * Un rafraîchissement de 200 ms ne mérite aucun signal : afficher puis retirer
 * une mention en un clin d'œil est plus perturbant que le silence.
 */
export function useSustained(value: boolean, delayMs: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!value) {
      setSustained(false);
      return undefined;
    }
    const timer = setTimeout(() => setSustained(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return sustained;
}
