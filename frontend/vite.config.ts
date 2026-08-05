import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
