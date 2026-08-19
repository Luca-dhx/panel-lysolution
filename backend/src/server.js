// Démarrage du backend du Panel — même séquence que le projet modèle :
// config validée (fail-closed à l'import), connexion Mongo, seed, écoute,
// arrêt propre sur SIGINT/SIGTERM.
import config from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import createApp from './app.js';
import logger from './utils/logger.js';
import { bootstrapPanelAccounts, seedFromEnv } from './services/auth/panelUsers.service.js';
import { finalizeOrphanRuns } from './services/deployment/deploymentRun.service.js';
import { migrateDeploymentTargets } from './services/deployment/destinationLifecycle.service.js';
import { migratePortRegistry } from './services/deployment/portRegistry.service.js';
import { migratePanelMedia } from './services/upload/mediaDescriptor.service.js';
import { reconcileDestinations } from './services/registry/projectDestination.service.js';
import { seedIntegratedApiCredentialSets } from './services/integratedApi/seed.js';
import { reconcileAllProviderWebhooks } from './services/webhooks/webhookReconciler.js';
import {
  backfillScopeTypes,
  reconcileProjectTemplates,
  seedPlatformTemplates,
} from './services/email/panelEmailTemplate.service.js';
import { refreshAllowedOrigins } from './middlewares/cors.middleware.js';
import { resolveBackendUrl } from './services/network/networkConfig.service.js';
import { startEventScheduler, stopEventScheduler } from './services/events/eventScheduler.js';
import {
  startRecurringCostScheduler, stopRecurringCostScheduler,
} from './services/finance/recurringCostScheduler.js';
import { migrateLegacyEvents, migrateParticipants } from './services/events/eventsMigration.js';
import { installProcessGuards } from './services/deployment/forensics/processGuard.js';
import { recoverOrphanRuns } from './services/deployment/forensics/runSteps.service.js';
import { consommerMarqueurReprise } from './services/deployment/forensics/restartMarker.service.js';
import {
  markBootFailed, markBootStep, markDraining, markReady,
} from './services/health/readiness.service.js';

async function start() {
  /**
   * LES OBSERVATEURS D'ERREURS D'ABORD — avant toute autre chose.
   *
   * Une exception pendant la connexion à la base ou les migrations doit elle
   * aussi laisser une trace. Les installer après serait trop tard pour les
   * pannes de démarrage.
   */
  installProcessGuards({ logger });

  /**
   * ══ LE PORT S'OUVRE AVANT L'AMORÇAGE — ET C'EST LE CŒUR DU CORRECTIF ══════
   *
   * ── CE QUI SE PASSAIT ─────────────────────────────────────────────────────
   *
   * `app.listen()` était la DERNIÈRE ligne du démarrage : il venait après la
   * connexion Mongo, le seed, une douzaine de migrations et de reprises. Pendant
   * toute cette fenêtre, rien n'écoutait sur le port. Nginx répondait alors
   * `502 Bad Gateway` avec sa page HTML — un corps que le frontend ne sait pas
   * lire, donc une erreur sans code et sans message.
   *
   * Cette erreur muette était indiscernable, pour le frontend, d'une session
   * invalide. C'est elle qui renvoyait l'utilisateur au login après un simple
   * redémarrage : rien n'avait jamais contesté son identité, mais rien n'avait
   * pu la confirmer non plus.
   *
   * ── CE QUI LE REMPLACE ────────────────────────────────────────────────────
   *
   * Le port s'ouvre immédiatement. Les sondes répondent tout de suite. Les
   * routes métier, elles, sont gardées par `requireServiceReady` et refusent
   * proprement — `503` + code stable — tant que l'amorçage n'est pas terminé.
   *
   * L'invariant est INTACT : aucune route métier ne sert avant que ses
   * dépendances ne soient prêtes. Ce qui change, c'est la QUALITÉ du refus.
   * Le service n'est pas annoncé disponible plus tôt ; il est simplement
   * capable de dire pourquoi il ne l'est pas encore.
   */
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      `${config.panelName} — port ${config.port} ouvert (ENV ${config.env}) ; `
      + 'amorçage en cours, les routes métier répondent 503 SERVICE_STARTING.',
    );
  });

  /**
   * Un port déjà pris doit tuer le démarrage TOUT DE SUITE, avec le message qui
   * nomme la cause. Sans cet écouteur, l'erreur remonterait en `uncaughtException`
   * bien après, et le journal parlerait d'un amorçage inachevé plutôt que d'un
   * port occupé.
   */
  server.on('error', (err) => {
    markBootFailed(err);
    logger.error(
      err?.code === 'EADDRINUSE'
        ? `Port ${config.port} déjà utilisé : un autre backend du Panel tourne-t-il déjà ?`
        : `Écoute impossible sur le port ${config.port} : ${err.message}`,
    );
    process.exit(1);
  });

  markBootStep('connexion à la base de données');
  await connectDatabase();
  markBootStep('amorçage des comptes');
  await seedFromEnv();
  /**
   * L'AMORÇAGE DES COMPTES — après le semis, et à CHAQUE démarrage.
   *
   * `seedFromEnv()` ne s'exécute que sur une base VIERGE : il ne peut donc rien
   * pour un parc déjà en exercice. Les deux gestes qui suivent sont pour lui —
   * poser les champs d'accès sur les comptes antérieurs à L12.A, et porter
   * `luca.duhoux@gmail.com` au rôle souverain. Tous deux idempotents, tous deux
   * sans effet sur une base déjà à jour.
   *
   * NON BLOQUANT : un backfill qui échoue ne doit pas empêcher le Panel de
   * démarrer — il doit se voir dans le journal et se rejouer au démarrage
   * suivant. Refuser de démarrer laisserait tout le parc sans supervision pour
   * une promotion de rôle qui peut attendre une minute.
   */
  await bootstrapPanelAccounts().catch((err) => {
    logger.warn(`Amorçage des comptes incomplet : ${err?.message ?? err}`);
  });
  markBootStep('origines autorisées');
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
  /**
   * L'ORDRE COMPTE — le marqueur de reprise AVANT la reprise générique.
   *
   * `recoverOrphanRuns()` classe tout run « en cours » comme interrompu.
   * Appelé en premier, il qualifierait d'incident un redémarrage parfaitement
   * attendu — celui que le Panel provoque en se déployant lui-même.
   */
  const reprise = await consommerMarqueurReprise().catch(() => null);
  if (reprise?.consumed && reprise.workerAlive) {
    logger.info(`Redémarrage attendu constaté : run ${reprise.runId} se poursuit (étape suivante ${reprise.nextExpectedStep ?? 'inconnue'}).`);
  } else if (reprise?.consumed) {
    logger.warn(`Redémarrage attendu constaté, mais le worker du run ${reprise.runId} n'a pas survécu : le déploiement s'est arrêté.`);
  } else if (reprise?.reason) {
    logger.warn(`Marqueur de reprise non consommé (${reprise.reason})`
      + `${reprise.runId ? ` — run ${reprise.runId} laissé en l'état.` : '.'}`);
  }

  /**
   * REPRISE DES RUNS ORPHELINS — l'invariant « toute étape RUNNING finit ».
   *
   * Le worker du Panel est DÉTACHÉ : il survit au redémarrage de l'API. Seuls
   * les runs dont le worker est réellement mort sont concernés — ce que cette
   * reprise VÉRIFIE désormais au battement de cœur, au lieu de le supposer.
   * Le run dont le marqueur vient d'être consommé lui est transmis : c'est
   * précisément celui qu'il ne faut pas déclarer interrompu après avoir
   * journalisé que son redémarrage était attendu et confirmé.
   */
  const repris = await recoverOrphanRuns({
    reason: 'process_restart',
    /**
     * Le run n'est protégé que si son worker a PROUVÉ sa survie. Un
     * redémarrage constaté ne suffit pas : si le worker est mort avec l'API,
     * le déploiement s'est bel et bien arrêté, et le dire est la seule
     * réponse honnête.
     */
    runRepris: reprise?.consumed && reprise.workerAlive ? reprise.runId : null,
  }).catch(() => null);
  if (repris?.recovered) {
    logger.warn(`${repris.recovered} déploiement(s) interrompu(s) : étapes closes et journalisées.`);
  }
  if (repris?.preserved) {
    logger.info(`${repris.preserved} déploiement(s) toujours exécuté(s) par leur worker : laissés en cours.`);
  }

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

  /**
   * PLAN DE CONTRÔLE INTEGRATEDAPI (L1) — amorçage idempotent des jeux vides.
   *
   * Non bloquant : un Panel dont le coffre n'est pas amorcé démarre quand
   * même, simplement sans cartes de fournisseurs pré-créées. Perdre cela
   * n'empêche ni de se connecter, ni de superviser, ni de déployer — et un
   * démarrage refusé pour ça serait une panne inventée.
   *
   * Ce seed ne lit AUCUNE base de projet et ne copie AUCUN identifiant.
   */
  const coffre = await seedIntegratedApiCredentialSets().catch((err) => {
    logger.warn(`Amorçage du plan de contrôle IntegratedAPI impossible : ${err.message}`);
    return null;
  });
  if (coffre?.created) {
    logger.info(`Plan de contrôle IntegratedAPI : ${coffre.created} jeu(x) d’identifiants amorcé(s).`);
  }

  /**
   * MODÈLES D'E-MAIL DE LA PLATEFORME (L8.3) — amorçage idempotent.
   *
   * Non bloquant : un Panel dont les modèles ne sont pas amorcés démarre quand
   * même. Le résolveur retombe alors sur le défaut du REGISTRE, qui est
   * exactement ce que ce seed aurait écrit — un e-mail attendu n'est donc
   * jamais perdu parce qu'une migration n'a pas tourné.
   */
  /**
   * ── 1. LA PORTÉE, D'ABORD — sans quoi rien de ce qui suit ne trouve rien ──
   *
   * L11.1 a introduit `scopeType` et livré son backfill… sans jamais l'appeler.
   * Onze documents de contenu sont donc restés sans portée, et le filtre de
   * résolution (`{scopeType:'PANEL', projectId:null}`) n'en retrouvait AUCUN :
   * le Panel servait le défaut du registre, et tout contenu écrit à la main
   * dans l'éditeur était ignoré à l'envoi — sans la moindre erreur.
   *
   * Il passe donc en PREMIER, et avant l'amorçage : `seedPanelTemplates()`
   * cherche par portée, ne trouvait pas ces documents, tentait de les recréer
   * et heurtait l'index unique `(templateCode, projectId)`. Son échec était
   * avalé par le `catch` ci-dessous, à chaque démarrage, depuis L11.1.
   */
  const portees = await backfillScopeTypes().catch((err) => {
    logger.warn(`Backfill de portée des modèles impossible : ${err.message}`);
    return null;
  });
  if (portees) {
    const total = Object.values(portees).reduce((n, r) => n + r.panel + r.project, 0);
    if (total) logger.info(`Modèles d’e-mail : portée posée sur ${total} document(s) hérité(s).`);
  }

  const modeles = await seedPlatformTemplates().catch((err) => {
    logger.warn(`Amorçage des modèles d’e-mail impossible : ${err.message}`);
    return null;
  });
  if (modeles?.created) {
    logger.info(`Modèles d’e-mail : ${modeles.created} amorcé(s) pour la plateforme.`);
  }

  /**
   * ── 2. LES INSTANCES DE PROJET — FILET, plus moteur ───────────────────────
   *
   * Le moteur est ailleurs : c'est le projet qui DÉCLARE ce qu'il utilise, et
   * le projecteur du pont réconcilie à la réception, en temps réel. Ce passage
   * ne parcourt donc plus « tous les projets × tous les modèles » : il relit les
   * déclarations DÉJÀ REÇUES et s'assure que ce qu'elles demandent existe.
   *
   * Il rattrape le seul cas que la voie temps réel ne peut pas rattraper : une
   * réconciliation interrompue à mi-chemin. La déclaration est persistée, sa
   * révision n'a pas changé, et le projet ne la réémettra donc pas — sans ce
   * filet, les instances manquantes le resteraient.
   *
   * Coût proportionnel à l'usage réel, et nul quand rien ne manque.
   */
  const instances = await reconcileProjectTemplates().catch((err) => {
    logger.warn(`Réconciliation des modèles de projet impossible : ${err.message}`);
    return null;
  });
  if (instances?.created) {
    logger.info(
      `Modèles d’e-mail : ${instances.created} instance(s) posée(s) sur `
      + `${instances.byProject.length} projet(s) (${instances.projects} examiné(s)).`,
    );
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

  /**
   * COÛTS RÉCURRENTS — premier passage AU DÉMARRAGE, et c'est ce qui rattrape.
   *
   * Un Panel arrêté quatre mois retrouve ses quatre occurrences ici, avant
   * qu'aucun écran ne soit ouvert. Ce n'est pas la garantie — la lecture
   * financière matérialise aussi — mais c'est le moment où le rattrapage a lieu
   * pour un système que personne ne regarde encore.
   */
  startRecurringCostScheduler();

  /**
   * ══ L'ÉTAT READY — POSÉ ICI, ET NULLE PART AILLEURS ══════════════════════
   *
   * Tout ce dont une route métier a besoin est fait : base connectée, comptes
   * amorcés, migrations passées, reprises consommées, ordonnanceurs lancés.
   * C'est le premier instant où répondre à une requête métier est honnête.
   *
   * La garde `requireServiceReady` cesse de refuser à partir de cette ligne.
   * Avancer cet appel, ne serait-ce que d'une migration, remettrait en service
   * un backend qui ne tient pas encore ses garanties.
   */
  markReady();
  logger.success(
    `${config.panelName} — backend PRÊT (ENV ${config.env}) sur le port ${config.port}`,
  );

  /**
   * RÉCONCILIATION DES WEBHOOKS (L5) — APRÈS l'état READY, et DÉTACHÉE.
   *
   * ── POURQUOI APRÈS ──────────────────────────────────────────────────────
   * Enregistrer une callback avant d'être prêt, c'est publier une adresse qui
   * répondrait `503` : un fournisseur qui sonde immédiatement la trouverait
   * indisponible, et certains désactivent un endpoint qui échoue trop souvent.
   *
   * ── POURQUOI DÉTACHÉE ───────────────────────────────────────────────────
   * Un fournisseur momentanément indisponible ne doit PAS retarder ni empêcher
   * un démarrage — ni, désormais, retarder l'état READY. La réconciliation est
   * idempotente : elle repassera au prochain boot, et rien de ce qu'elle n'a
   * pas fait n'est perdu. Elle ne lève jamais — c'est une propriété du service,
   * pas une politesse de ce `catch`.
   */
  void reconcileAllProviderWebhooks()
    .then((rapport) => {
      for (const warning of rapport.warnings) {
        logger.warn(
          `Webhook ${warning.provider} (${rapport.environment}) : ${warning.status}`
          + `${warning.code ? ` — ${warning.code}` : ''} [${warning.severity}].`,
        );
      }
      const prets = rapport.results.filter((r) => r.status === 'READY').length;
      logger.info(`Webhooks fournisseur : ${prets} prêt(s), ${rapport.warnings.length} à surveiller.`);
    })
    .catch((err) => {
      logger.warn(`Réconciliation des webhooks impossible : ${err.message}`);
    });

  const shutdown = (signal) => {
    logger.info(`${signal} reçu : arrêt du serveur…`);
    /**
     * DRAINAGE ANNONCÉ AVANT DE FERMER.
     *
     * Une requête qui arrive pendant l'arrêt recevait une socket coupée — que
     * le frontend lit comme une panne réseau anonyme. Elle reçoit désormais un
     * `503 PANEL_SERVICE_STOPPING` : un refus daté, explicite, et surtout
     * porteur de « ta session reste valide ».
     */
    markDraining();
    stopEventScheduler();
    stopRecurringCostScheduler();
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
  /**
   * L'ÉCHEC EST ENREGISTRÉ AVANT DE SORTIR.
   *
   * Le port est ouvert depuis la première seconde : entre l'échec et la sortie
   * du process, `/readyz` peut encore être interrogé. Il doit alors dire ce qui
   * a échoué, pas se contenter de « pas prêt » — c'est la différence entre un
   * diagnostic et une devinette.
   */
  markBootFailed(err);
  logger.error(`Démarrage impossible : ${err.message}`);
  process.exit(1);
});
