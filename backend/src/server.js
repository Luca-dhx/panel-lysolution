// Démarrage du backend du Panel — même séquence que le projet modèle :
// config validée (fail-closed à l'import), connexion Mongo, seed, écoute,
// arrêt propre sur SIGINT/SIGTERM.
import config from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import createApp from './app.js';
import logger from './utils/logger.js';
import { seedFromEnv } from './services/auth/panelUsers.service.js';
import { finalizeOrphanRuns } from './services/deployment/deploymentRun.service.js';
import { migrateDeploymentTargets } from './services/deployment/destinationLifecycle.service.js';
import { migratePortRegistry } from './services/deployment/portRegistry.service.js';
import { migratePanelMedia } from './services/upload/mediaDescriptor.service.js';
import { reconcileDestinations } from './services/registry/projectDestination.service.js';
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

  // CYCLE DE VIE DES DESTINATIONS : toute fiche antérieure au LOT 8 devient
  // ACTIVE — le choix conservateur. On ne sait pas ce qu'il reste sur le
  // serveur, donc on suppose que tout y est : supposer l'inverse autoriserait
  // la suppression directe d'une fiche dont le service tourne encore.
  //
  // ── ELLE EST BLOQUANTE, ET ELLE SEULE ─────────────────────────────────
  // Elle porte la garantie « une seule destination active par
  // environnement ». Absorber son échec annoncerait un démarrage sain sans
  // la garantie — l'état le plus dangereux, puisque plus rien ne signale
  // qu'elle manque. Les autres reprises complètent des données ; leur échec
  // reste non bloquant.
  const lifecycle = await migrateDeploymentTargets();
  if (lifecycle?.lifecycleBackfilled) {
    logger.info(`${lifecycle.lifecycleBackfilled} destination(s) reprise(s) en état ACTIVE.`);
  }
  if (lifecycle?.activeIndexVerified) {
    logger.info('Garantie vérifiée : une seule destination active par environnement (index relu en base).');
  }

  /**
   * MÉDIAS ANTÉRIEURS — repris AVANT toute publication.
   *
   * `publishPanelMediaOnDestination` filtre sur l'environnement : un média
   * qui n'en porte pas ne serait jamais transféré ni publié, sans qu'aucun
   * message ne le signale. La reprise doit donc précéder le premier
   * déploiement, pas le suivre.
   *
   * Non bloquante : elle complète une donnée, elle ne promet aucune
   * invariante — contrairement à la reprise des destinations ci-dessus.
   */
  const medias = await migratePanelMedia({ apply: true }).catch((err) => {
    logger.warn(`Reprise des médias impossible : ${err.message}`);
    return null;
  });
  if (medias?.backfilled) {
    logger.info(`${medias.backfilled} média(s) repris dans l'environnement courant.`);
  }

  // REGISTRE DES PORTS : chaque destination vivante reçoit la réservation de
  // son port actuel. On ne réattribue RIEN — un service tourne peut-être
  // derrière. Deux destinations partageant un port sont signalées, pas
  // arbitrées : c'est l'incident lui-même, et le déploiement le refusera.
  const registre = await migratePortRegistry().catch((err) => {
    logger.warn(`Reprise du registre des ports impossible : ${err.message}`);
    return null;
  });
  if (registre?.reservationsCreated) {
    logger.info(`${registre.reservationsCreated} port(s) enregistré(s) au registre.`);
  }
  if (registre?.conflicts) {
    logger.warn(`${registre.conflicts} conflit(s) de port détecté(s) : deux destinations visent le même port sur un même serveur.`);
  }

  /**
   * DESTINATIONS DES PROJETS — une seule ACTIVE par projet et par
   * environnement, reprise depuis ce que chaque projet a déjà annoncé.
   *
   * Les fiches antérieures portaient leurs adresses dans trois champs écrits à
   * trois moments (bootstrap, manifeste, projection). Quand un projet avait
   * déménagé sans se réappairer, ces champs divergeaient — et le Panel
   * affichait les deux. La reprise retient l'annonce la plus RÉCENTE du projet
   * et conserve les hôtes antérieurs en RETIRED.
   */
  const destinations = await reconcileDestinations().catch((err) => {
    logger.warn(`Reprise des destinations de projets impossible : ${err.message}`);
    return null;
  });
  if (destinations?.activated) {
    logger.info(`${destinations.activated} destination(s) de projet reprise(s), ${destinations.retired} retirée(s).`);
  }
  for (const d of destinations?.divergences ?? []) {
    logger.warn(`Destinations divergentes reprises pour « ${d.projectName} » (${d.environment}) : `
      + `retenue « ${d.retained.host} » (${d.retained.source}), `
      + `écartée(s) ${d.superseded.map((s) => `« ${s.host} » (${s.source})`).join(', ')}.`);
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
