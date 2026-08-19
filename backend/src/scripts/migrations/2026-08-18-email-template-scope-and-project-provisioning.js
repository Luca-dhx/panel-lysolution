// MIGRATION — rend leur portée aux modèles hérités, puis pose les instances
// de projet qui n'ont jamais été posées.
//
//   npm run migrate:email-template-provisioning
//   npm run migrate:email-template-provisioning -- --dry-run
//
// ── LE DÉFAUT QU'ELLE RÉPARE ────────────────────────────────────────────────
//
// Le lot L11.1 a introduit la portée explicite (`scopeType`) et la résolution
// stricte par portée. Il a écrit les deux mécanismes qu'il fallait pour amener
// la base à ce nouveau monde — `backfillScopeTypes()` et
// `provisionProjectTemplates()` — et n'en a branché AUCUN.
//
// Deux conséquences, invisibles l'une comme l'autre :
//
//   1. les documents antérieurs sont restés SANS `scopeType`. Le filtre de
//      résolution étant `{ scopeType: 'PANEL', projectId: null }`, il n'en
//      retrouvait plus un seul : le Panel servait le défaut du registre, et
//      tout contenu écrit à la main dans l'éditeur était ignoré à l'envoi ;
//
//   2. aucun projet n'a jamais reçu d'instance PROJECT. La résolution étant
//      fail-closed — et elle a raison de l'être — plus AUCUN projet du parc ne
//      pouvait envoyer le moindre e-mail. Le refus était exact ; c'est la pose
//      qui manquait.
//
// ── POURQUOI CETTE MIGRATION EXISTE, PUISQUE LE DÉMARRAGE LE FAIT ───────────
//
// `server.js` appelle désormais les trois passages à chaque démarrage, et c'est
// là que vit la garantie permanente. Cette migration sert aux cas où l'on ne
// veut pas redémarrer pour réparer : un Panel en service, une base restaurée,
// un environnement dont on veut voir le rapport AVANT d'écrire (`--dry-run`).
//
// Elle n'invente rien : elle appelle EXACTEMENT les mêmes fonctions, dans le
// même ordre. Deux chemins qui répareraient différemment finiraient par
// diverger, et le second serait celui qu'on ne relit jamais.
//
// ── L'ORDRE N'EST PAS INTERCHANGEABLE ───────────────────────────────────────
//
//   1. backfill des portées   sans quoi l'amorçage ne RETROUVE pas les
//                             documents hérités, tente de les recréer, et
//                             heurte l'index unique (templateCode, projectId) ;
//   2. amorçage PANEL         complète le contenu de L.Y Solution ;
//   3. réconciliation PROJET  pose ce qui manque à chaque projet.
//
// ── IDEMPOTENTE, ET NON DESTRUCTIVE ─────────────────────────────────────────
//
// Aucune des trois n'écrase quoi que ce soit : le backfill ne touche que les
// documents sans portée, l'amorçage et la réconciliation lisent avant d'écrire
// et ne posent que l'absent. Un contenu personnalisé, une version 7, un modèle
// désactivé à la main survivent à un nombre quelconque de passages.
import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import logger from '../../utils/logger.js';
import {
  backfillScopeTypes,
  findMissingProjectTemplates,
  reconcileProjectTemplates,
  seedPanelTemplates,
} from '../../services/email/panelEmailTemplate.service.js';
import PanelEmailTemplate from '../../models/PanelEmailTemplate.model.js';

const dryRun = process.argv.includes('--dry-run');

try {
  await connectDatabase();

  /* ── CONSTAT ─────────────────────────────────────────────────────────── */

  const sansPortee = await PanelEmailTemplate.countDocuments({ scopeType: { $exists: false } });
  const manquants = await findMissingProjectTemplates();
  const totalManquant = manquants.missing.reduce((n, m) => n + m.missing.length, 0);

  logger.info('── ÉTAT AVANT ──────────────────────────────────────────────');
  logger.info(`Modèles sans portée déclarée : ${sansPortee}`);
  logger.info(`Codes à poser sur un projet  : ${manquants.codes.length}`);
  logger.info(`Projets au registre          : ${manquants.projects}`);
  logger.info(`Instances manquantes         : ${totalManquant} sur ${manquants.missing.length} projet(s)`);
  for (const m of manquants.missing) {
    logger.info(`  · ${m.projectName ?? '(sans nom)'} [${m.projectId}] — ${m.missing.length} manquante(s)`);
  }

  if (dryRun) {
    logger.warn('--dry-run : aucune écriture. Relancez sans l’option pour appliquer.');
  } else {
    /* ── 1. LA PORTÉE ─────────────────────────────────────────────────── */
    const portees = await backfillScopeTypes();
    const posees = Object.values(portees).reduce((n, r) => n + r.panel + r.project, 0);
    logger.success(`Portée posée sur ${posees} document(s) hérité(s).`);

    /* ── 2. LE CONTENU DE LA PLATEFORME ───────────────────────────────── */
    const panel = await seedPanelTemplates();
    logger.success(`Amorçage PANEL : ${panel.created} posé(s), ${panel.existing} déjà en place.`);

    /* ── 3. LES INSTANCES DE PROJET ───────────────────────────────────── */
    const projets = await reconcileProjectTemplates({ actor: { userId: 'migration' } });
    logger.success(
      `Réconciliation PROJET : ${projets.created} posée(s) sur ${projets.byProject.length} projet(s), `
      + `${projets.existing} déjà en place, ${projets.refused} refusée(s).`,
    );
    for (const p of projets.byProject) {
      logger.info(`  · ${p.projectName ?? '(sans nom)'} [${p.projectId}] — ${p.created.length} posée(s)`);
    }

    /* ── VÉRIFICATION ─────────────────────────────────────────────────── */
    const resteSansPortee = await PanelEmailTemplate.countDocuments({ scopeType: { $exists: false } });
    const resteManquant = await findMissingProjectTemplates();
    const resteTotal = resteManquant.missing.reduce((n, m) => n + m.missing.length, 0);

    logger.info('── ÉTAT APRÈS ──────────────────────────────────────────────');
    logger.info(`Modèles sans portée déclarée : ${resteSansPortee}`);
    logger.info(`Instances manquantes         : ${resteTotal}`);

    if (resteSansPortee !== 0 || resteTotal !== 0) {
      logger.error('La migration n’a pas convergé : il reste des documents à traiter.');
      process.exitCode = 1;
    }
  }
} catch (error) {
  logger.error(`Migration interrompue : ${error.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
