import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type ToastTone = 'success' | 'error';

interface ToastEntry {
  id: string;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  pushToast: (tone: ToastTone, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const value = useMemo<ToastContextValue>(() => ({
    pushToast(tone, message) {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setToasts((current) => [...current, { id, tone, message }]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 4000);
    },
  }), []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * ── L'OBJET RENDU EST STABLE, ET CE N'EST PAS UN DÉTAIL ─────────────────────
 *
 * ══ LE DÉFAUT QUE `useMemo` FERME, TEL QU'IL S'EST PRODUIT ══════════════════
 *
 * Ce hook construisait son objet littéral à CHAQUE appel : deux rendus
 * successifs rendaient deux objets différents, pour deux fonctions pourtant
 * identiques.
 *
 * Un écran qui l'inscrit dans les dépendances d'un `useEffect` — le réflexe
 * correct, puisque l'effet s'en sert — obtient alors une dépendance qui change
 * à chaque rendu. L'effet se rejoue, pose son état, provoque un rendu, obtient
 * un nouveau `toast`, se rejoue… La boucle est infinie.
 *
 * Observé sur l'éditeur de documents légaux : le chargement du template se
 * rejouait sans fin, réinitialisant le brouillon — donc capable d'EFFACER une
 * saisie en cours — et martelant l'API. À 390 px, où le rendu est plus lourd,
 * l'aperçu ne se stabilisait même jamais.
 *
 * ══ POURQUOI CORRIGER ICI PLUTÔT QUE DANS LES ÉCRANS ═══════════════════════
 *
 * Retirer `toast` des tableaux de dépendances aurait réparé les trois écrans
 * du jour et laissé le piège intact pour le prochain — avec, en prime, un
 * `eslint-disable` à recopier partout pour faire taire la règle qui a raison.
 *
 * Un hook dont la valeur est stable rend la dépendance CORRECTE, et le réflexe
 * juste redevient sans danger.
 *
 * `context` est lui-même mémoïsé par le fournisseur : la référence ne change
 * donc que si le fournisseur est remonté, ce qui est exactement la sémantique
 * voulue.
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast doit être utilisé à l’intérieur de <ToastProvider>.');
  }
  return useMemo(
    () => ({
      success(message: string) {
        context.pushToast('success', message);
      },
      error(message: string) {
        context.pushToast('error', message);
      },
    }),
    [context],
  );
}
