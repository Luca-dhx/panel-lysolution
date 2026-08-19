import { PanelUserProfileEditor } from '@/components/PanelUserProfileEditor';

/**
 * MON PROFIL — l'unique destination des deux entrées (L12.C).
 *
 * ── POURQUOI UNE PAGE, ET NON UNE FENÊTRE MODALE ────────────────────────────
 *
 * Parce qu'elle a DEUX entrées : la barre latérale et le bouton « Modifier » de
 * sa propre ligne dans `/panel-users`. Une modale aurait dû être ouverte depuis
 * deux endroits, avec deux états à synchroniser ; une route est une adresse —
 * les deux entrées y mènent, et il n'y a rien à tenir en accord.
 *
 * Elle n'est PAS derrière la garde DEV : corriger son propre nom n'est pas une
 * opération technique, et un ADMIN a le même droit.
 */
export function MyProfilePage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1>Mon profil</h1>
        <p className="page-description">
          Vos informations personnelles. Les privilèges — rôle, état du compte, accès aux
          projets — sont accordés par un autre développeur autorisé.
        </p>
      </header>

      <PanelUserProfileEditor />
    </div>
  );
}

export default MyProfilePage;
