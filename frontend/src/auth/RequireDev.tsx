/**
 * GARDE DES ROUTES DÉVELOPPEUR — la seule barrière, et elle est unique.
 *
 * Masquer une entrée de menu ne protège rien : l'URL reste tapable, et jusqu'ici
 * un compte ADMIN atteignait `/deployment` ou `/pairings` en les saisissant.
 * Toute route technique passe donc par ici, et un ADMIN est renvoyé vers son
 * tableau de bord plutôt que sur un écran qu'il ne peut pas interpréter.
 *
 * Volontairement binaire (`role === 'DEV'`) : le RBAC viendra remplacer CE
 * point unique le jour venu, sans avoir à retrouver des conditions éparpillées.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';

export function useIsDev(): boolean {
  const { user } = useAuth();
  return user?.role === 'DEV';
}

export function RequireDev({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="fullscreen-loader">Chargement de la session…</div>;
  }
  if (user?.role !== 'DEV') {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export default RequireDev;
