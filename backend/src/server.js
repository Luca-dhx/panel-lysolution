// Démarrage du backend du Panel — même séquence que le projet modèle :
// config validée (fail-closed à l'import), connexion Mongo, seed, écoute,
// arrêt propre sur SIGINT/SIGTERM.
import config from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import createApp from './app.js';
import logger from './utils/logger.js';
import { seedFromEnv } from './services/auth/panelUsers.service.js';
import { finalizeOrphanRuns } from './services/deployment/deploymentRun.service.js';
import { refreshAllowedOrigins } from './middlewares/cors.middleware.js';
import { resolveBackendUrl } from './services/network/networkConfig.service.js';
import { startEventScheduler, stopEventScheduler } from './services/events/eventScheduler.js';
import { migrateLegacyEvents, migrateParticipants } from './services/events/eventsMigration.js';

async function start() {
  await connectDatabase();
  await seedFromEnv();
  await refreshAllowedOrigins();

  // AUTO-DÉPLOIEMENT : si ce démarrage est celui provoqué par une mise en
  // ligne du Panel par lui-même, un run peut être resté « en cours ». On ne
  // le déclare ni réussi ni échoué — son issue est INCONNUE.
  const orphans = await finalizeOrphanRuns().catch(() => 0);
  if (orphans) {
    logger.warn(`${orphans} exécution(s) de déploiement interrompue(s) — issue inconnue, à vérifier.`);
  }

  const backend = await resolveBackendUrl();
  logger.info(`URL publique du Panel : ${backend.url ?? '(non configurée)'} [source ${backend.source}]`);

  // Reprise de l'ancien modèle d'agenda, s'il en reste quelque chose. Avant
  // l'ordonnanceur : il ne doit pas travailler sur des reliques.
  await migrateLegacyEvents().catch((err) => {
    logger.warn(`Migration de l’agenda impossible : ${err.message}`);
  });

  // Puis les participants : les anciennes chaînes séparées par des virgules
  // deviennent des personnes identifiées. APRÈS la reprise ci-dessus, qui peut
  // encore fabriquer des objets à partir de reliques.
  await migrateParticipants().catch((err) => {
    logger.warn(`Migration des participants impossible : ${err.message}`);
  });

  // ÉCHÉANCES : un événement devient « à confirmer » même si personne n'a le
  // Panel ouvert. La détection est donc ici, pas dans un navigateur.
  startEventScheduler();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.success(
      `${config.panelName} — backend démarré (ENV ${config.env}) sur le port ${config.port}`,
    );
  });

  const shutdown = (signal) => {
    logger.info(`${signal} reçu : arrêt du serveur…`);
    stopEventScheduler();
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
