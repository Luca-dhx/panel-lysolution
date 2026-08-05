import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '@/App';
import { AuthProvider } from '@/auth/AuthContext';
// Jeu d'icônes officiel : les références publiées portent des noms `bi-*`,
// et sans cette feuille elles ne rendaient rien du tout.
import 'bootstrap-icons/font/bootstrap-icons.css';
import '@/tokens.css';
import '@/styles.css';
import '@/components.css';

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
