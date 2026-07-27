// Démarrage du backend du Panel — même séquence que le projet modèle :
// config validée (fail-closed à l'import), connexion Mongo, seed, écoute,
// arrêt propre sur SIGINT/SIGTERM.
import config from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import createApp from './app.js';
import logger from './utils/logger.js';
import { seedFromEnv } from './services/auth/panelUsers.service.js';
import { refreshAllowedOrigins } from './middlewares/cors.middleware.js';
import { resolveBackendUrl } from './services/network/networkConfig.service.js';

async function start() {
  await connectDatabase();
  await seedFromEnv();
  await refreshAllowedOrigins();

  const backend = await resolveBackendUrl();
  logger.info(`URL publique du Panel : ${backend.url ?? '(non configurée)'} [source ${backend.source}]`);

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.success(
      `${config.panelName} — backend démarré (ENV ${config.env}) sur le port ${config.port}`,
    );
  });

  const shutdown = (signal) => {
    logger.info(`${signal} reçu : arrêt du serveur…`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.error(`Démarrage impossible : ${err.message}`);
  process.exit(1);
});
