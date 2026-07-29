// AMORCE DU PROJET pour le test d'écosystème — Phase 4, LOT 9.
//
// Démarre le backend RÉEL de SB Auto 06 dans son propre processus, sur un
// port libre, et annonce ce port sur stdout pour que le test puisse
// l'appeler.
//
// ── POURQUOI UN PROCESSUS SÉPARÉ ────────────────────────────────────────────
// Les deux backends déclarent leurs modèles sur le MÊME registre global de
// Mongoose et lisent `process.env` à l'import de leur configuration. Les
// charger côte à côte dans un seul processus les ferait se recouvrir — et le
// test ne prouverait plus que deux applications distinctes savent se parler,
// ce qui est précisément son objet.
//
// Ce fichier vit côté Panel mais démarre le projet : c'est un outil
// d'atelier, pas un composant. Il n'est jamais déployé, et le dépôt du projet
// n'en dépend pas.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const backendRoot = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(backendRoot, 'src', relative)).href);

const { connectDatabase } = await load('config/db.js');
const { bootstrap } = await load('config/bootstrap.js');
const { createApp } = await load('app.js');

await connectDatabase();
// Le bootstrap complet : c'est lui qui branche la persistance de
// l'appairage, les applicateurs de configuration et l'ordonnanceur. Le
// court-circuiter donnerait un projet qui ne ressemble pas à celui qui tourne
// en production.
await bootstrap();

const app = createApp();
const server = app.listen(0, '127.0.0.1', () => {
  // Contrat avec le test : cette ligne, et le port qu'elle porte.
  process.stdout.write(`E2E_PROJECT_PORT=${server.address().port}\n`);
});

const shutdown = async () => {
  server.close(async () => {
    try {
      const { disconnectDatabase } = await load('config/db.js');
      await disconnectDatabase();
    } catch {
      /* le processus s'arrête de toute façon */
    }
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
