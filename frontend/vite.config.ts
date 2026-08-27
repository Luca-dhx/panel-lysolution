import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * TAILWIND V4 EST UN PLUGIN VITE, PAS UN PLUGIN POSTCSS.
   *
   * La refonte progressive de l'interface s'appuie sur la librairie Untitled UI
   * (`src/styles/uui.css`), qui compile ses utilitaires ici. Aucun écran
   * existant n'en dépend : le préflight de Tailwind est délibérément écarté,
   * pour que `styles.css` continue de gouverner tout ce qui n'a pas été refait.
   */
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    /**
     * CE QUE LE SERVEUR DE DÉVELOPPEMENT DOIT RELAYER AU BACKEND.
     *
     * ── LE DÉFAUT CORRIGÉ ─────────────────────────────────────────────────
     * `/uploads` manquait. L'import d'un logo réussissait pourtant : l'appel
     * partait sur `/api/uploads/image`, relayé ici, le backend écrivait le
     * fichier et rendait un chemin RELATIF (`/uploads/logo-….webp`).
     *
     * Mais l'aperçu demandait ensuite cette adresse au serveur Vite, qui ne
     * connaît pas ce dossier. Vite appliquait alors son repli d'application
     * monopage et répondait `index.html` — avec un code 200.
     *
     * Une image cassée, un statut 200, aucune erreur en console : rien ne
     * pointait vers la cause. Le fichier existait, l'API était correcte ;
     * seul le chemin de LECTURE n'était pas relayé.
     */
    proxy: {
      '/api': 'http://localhost:4100',
      '/health': 'http://localhost:4100',
      '/uploads': 'http://localhost:4100',
    },
  },
});
