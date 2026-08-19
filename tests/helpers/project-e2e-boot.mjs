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

/**
 * ══ L'ÉTAT « PRÊT » — ce que `server.js` pose, et que ce harnais doit poser ═
 *
 * Le backend refuse le trafic métier tant qu'il n'a pas déclaré son amorçage
 * abouti : une requête reçue trop tôt repart en `SERVICE_STARTING`. La règle
 * est saine, et le point de bascule est unique — `server.js` appelle
 * `markReady()` juste après `bootstrap()`, quand tout ce dont une route a
 * besoin est en place.
 *
 * Ce harnais compose le même amorçage sans passer par `server.js` : il lui
 * revient donc de franchir le même point, au même endroit et pas plus tôt.
 * L'import est tolérant : une version du projet sans garde de disponibilité
 * n'a rien à déclarer.
 */
try {
  const { markReady } = await load('services/lifecycle/readiness.service.js');
  markReady();
} catch { /* pas de garde de disponibilité dans cette version */ }

/**
 * ══ UN COMPTE UTILISABLE, PAR LE CHEMIN QUE LE PRODUIT PRÉVOIT ═════════════
 *
 * Le projet ne crée plus de compte avec un mot de passe : depuis le lot 2C, le
 * premier développeur naît `PENDING_ACTIVATION` et choisit son secret par un
 * lien reçu par courriel. Un harnais qui posterait encore `SEED_DEV_PASSWORD`
 * sur `/api/auth/login` recevrait un 401 — non par panne, mais parce que ce
 * compte n'a jamais eu de mot de passe.
 *
 * On emprunte donc le VRAI chemin, ses deux actes exacts : émettre une
 * activation, puis l'activer avec le mot de passe voulu. C'est ce que fait le
 * lien du courriel, aux mêmes fonctions près — le harnais se dispense de la
 * boîte de réception, pas de la mécanique.
 *
 * Le mot de passe vient de l'environnement du test ; sans lui, on ne touche à
 * rien : un projet qui doit rester en attente d'activation le reste.
 */
const motDePasseE2E = process.env.E2E_DEV_PASSWORD;
if (motDePasseE2E) {
  const { default: User } = await load('models/User.model.js');
  const { issueActivation, activateAccount } = await load('services/localDevBootstrap.service.js');
  const dev = await User.findOne({ role: 'DEV' }).sort({ createdAt: 1 });
  if (dev) {
    // Le motif appartient au produit : `BOOTSTRAP` est celui d'un premier
    // accès, et c'est exactement la situation. On n'en invente pas un autre.
    const { rawToken } = await issueActivation(dev, { reason: 'BOOTSTRAP' });
    await activateAccount(rawToken, motDePasseE2E);
  }
}

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
