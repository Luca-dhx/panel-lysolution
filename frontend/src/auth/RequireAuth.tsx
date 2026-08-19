import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { tokenStore } from '@/lib/api';

/**
 * ══ TROIS SITUATIONS, ET NON PLUS DEUX ══════════════════════════════════════
 *
 * Cette garde ne connaissait que « chargement » et « pas d'utilisateur », et
 * traitait le second cas par une redirection vers `/login`. Or « pas
 * d'utilisateur » recouvrait DEUX réalités opposées :
 *
 *   · aucune session — il faut effectivement se connecter ;
 *   · session valide, mais le serveur n'a pas pu la confirmer — il ne faut
 *     surtout pas renvoyer au login, il faut attendre et réessayer.
 *
 * Les confondre produisait exactement le symptôme rapporté : un écran de
 * connexion affiché pendant qu'un backend redémarrait, alors que le jeton était
 * toujours en place et redevenait utilisable quelques secondes plus tard.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, unreachable } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="fullscreen-loader">Chargement de la session…</div>;
  }

  /**
   * SERVICE ABSENT, JETON PRÉSENT — on attend, on ne déconnecte pas.
   *
   * La condition exige le jeton : sans lui, il n'y a pas de session à préserver
   * et l'écran de connexion est la bonne destination, même hors ligne. C'est ce
   * qui empêche cet écran d'apparaître à un visiteur jamais connecté.
   *
   * `AuthContext` réessaie en arrière-plan : dès que le service répond, l'état
   * retombe et l'application s'affiche. Aucun rechargement manuel n'est requis.
   */
  if (unreachable && tokenStore.get() !== null) {
    return (
      <div className="fullscreen-loader" role="status" aria-live="polite">
        <p><strong>Service momentanément indisponible.</strong></p>
        <p>Reconnexion en cours… Votre session est conservée.</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
