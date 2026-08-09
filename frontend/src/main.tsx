import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '@/App';
import { applyCachedBranding } from '@/lib/publicBranding';
import { AuthProvider } from '@/auth/AuthContext';
// Jeu d'icônes officiel : les références publiées portent des noms `bi-*`,
// et sans cette feuille elles ne rendaient rien du tout.
import 'bootstrap-icons/font/bootstrap-icons.css';
import '@/tokens.css';
import '@/styles.css';
import '@/components.css';

/**
 * LA MARQUE EST PEINTE AVANT QUE REACT NE MONTE.
 *
 * ══ LE FLASH QUE CECI SUPPRIME ══════════════════════════════════════════════
 *
 * Le thème n'était appliqué qu'après un aller-retour réseau, depuis un effet de
 * `App`. L'écran affichait donc les couleurs par défaut, puis se repeignait —
 * un flash à chaque chargement, sur l'élément le plus stable de l'interface.
 * Sur l'écran de connexion, la requête échouait même en 401 : le thème
 * n'arrivait jamais.
 *
 * On applique ici, SYNCHRONIQUEMENT, la dernière marque connue. Le document
 * porte déjà les bonnes variables CSS et le bon favicon quand le premier rendu
 * a lieu. Le réseau reste l'autorité : `App` recharge et écrase.
 */
applyCachedBranding();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Élément racine #root introuvable.');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
