// AMORÇAGE DES COMPTES PANEL, À LA MAIN — le même geste qu'au démarrage.
//
// ══ POURQUOI CE SCRIPT EXISTE, ALORS QUE `server.js` LE FAIT DÉJÀ ═══════════
//
// Parce que « redémarrer le backend » et « appliquer un backfill » sont deux
// décisions différentes, et qu'on ne devrait jamais avoir à prendre la première
// pour obtenir la seconde. Un exploitant qui vient de créer le compte
// `luca.duhoux@gmail.com` doit pouvoir le promouvoir sans interrompre le parc.
//
// C'est EXACTEMENT la même fonction que celle du démarrage — pas une seconde
// implémentation « pour la ligne de commande », qui divergerait au premier
// correctif appliqué à une seule des deux.
//
// ══ CE QU'IL FAIT, ET CE QU'IL NE FERA JAMAIS ═══════════════════════════════
//
//   · pose `enabled` et `projectAccess` sur les comptes antérieurs à L12.A ;
//   · porte le compte d'amorçage au rôle SUPER_ADMIN s'il EXISTE.
//
// Il ne CRÉE aucun compte, et ne touche ni mot de passe, ni accès projets, ni
// activation, ni `tokenVersion`. Sur une base vierge il ne fait rien, et le dit.
//
//   node src/scripts/panel-accounts-bootstrap.js
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { bootstrapPanelAccounts, SOVEREIGN_BOOTSTRAP_EMAIL } from '../services/auth/panelUsers.service.js';

await connectDatabase();
try {
  const { access, sovereign } = await bootstrapPanelAccounts();

  logger.info(
    `[bootstrap] base « ${config.dbName ?? config.env} » — `
    + `${access.enabled} compte(s) ont reçu « enabled », `
    + `${access.projectAccess} ont reçu « projectAccess ».`,
  );

  if (!sovereign.found) {
    logger.warn(
      `[bootstrap] ${SOVEREIGN_BOOTSTRAP_EMAIL} n’existe pas dans cette base : aucune promotion. `
      + 'Créez le compte depuis « Comptes L.Y Solution », puis relancez — '
      + 'ce script ne fabrique pas de compte souverain, et surtout pas son mot de passe.',
    );
  } else if (sovereign.alreadySuperAdmin) {
    logger.info(`[bootstrap] ${SOVEREIGN_BOOTSTRAP_EMAIL} est DÉJÀ SUPER_ADMIN — rien à faire.`);
  } else if (sovereign.promoted) {
    logger.success(`[bootstrap] ${SOVEREIGN_BOOTSTRAP_EMAIL} promu SUPER_ADMIN. 1 compte affecté.`);
  }
} finally {
  await disconnectDatabase();
}
