/**
 * GARDE DES ROUTES DÉVELOPPEUR — la seule barrière d'écran, et elle est unique.
 *
 * Masquer une entrée de menu ne protège rien : l'URL reste tapable, et jusqu'ici
 * un compte ADMIN atteignait `/deployment` ou `/pairings` en les saisissant.
 * Toute route technique passe donc par ici, et un ADMIN est renvoyé vers son
 * tableau de bord plutôt que sur un écran qu'il ne peut pas interpréter.
 *
 * ══ ELLE N'EST PLUS BINAIRE, ET C'ÉTAIT LE PIÈGE ════════════════════════════
 *
 * Elle testait `role === 'DEV'`. C'était juste avec deux rôles — une
 * comparaison EST une hiérarchie quand il n'y a qu'une marche. Avec
 * `SUPER_ADMIN`, la même ligne enferme dehors le rôle le PLUS élevé : aucune
 * erreur, aucun message, simplement une application vide pour la personne qui
 * gouverne le Panel. Le prédicat vit désormais dans `@/auth/roles`, en miroir
 * de l'échelle du serveur.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { administersPanelUsers, isPanelDeveloper } from '@/auth/roles';

export function useIsDev(): boolean {
  const { user } = useAuth();
  return isPanelDeveloper(user?.role);
}

/** Le compte courant gouverne-t-il le Panel ? Pour les affordances, pas pour garder. */
export function useIsSuperAdmin(): boolean {
  const { user } = useAuth();
  return administersPanelUsers(user?.role);
}

export function RequireDev({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="fullscreen-loader">Chargement de la session…</div>;
  }
  if (!isPanelDeveloper(user?.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * LA GARDE SOUVERAINE — pour une route qui n'existerait que pour SUPER_ADMIN.
 *
 * Aucune route ne l'utilise aujourd'hui : l'administration des comptes vit dans
 * `/panel-users`, que les DEV LISENT. La séparation s'y fait donc au bouton, et
 * non à la porte — un développeur voit l'annuaire, il n'y voit aucune action.
 *
 * Elle existe quand même, et ce n'est pas de l'anticipation gratuite : sans
 * elle, la première route réellement souveraine serait gardée par un
 * `role === 'SUPER_ADMIN'` écrit sur place, et l'échelle recommencerait à se
 * disperser — exactement ce que ce lot vient de réparer.
 */
export function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="fullscreen-loader">Chargement de la session…</div>;
  }
  if (!administersPanelUsers(user?.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export default RequireDev;
