// MIGRATION — efface les cinq champs d'autorisation devenus sans lecteur.
//
//   npm run migrate:drop-capability-authorization
//   npm run migrate:drop-capability-authorization -- --dry-run
//
// ── CE QUE CETTE MIGRATION EFFACE ───────────────────────────────────────────
//
//   capabilityGrants            les capacités cochées projet par projet
//   commercialState             l'ouverture commerciale (PREOPENING | LIVE)
//   commercialStateUpdatedAt    qui l'a décidée, quand, et pourquoi
//   commercialStateUpdatedBy
//   commercialStateReason
//
// ── POURQUOI EFFACER, ALORS QU'AUCUN CODE NE LES LIT PLUS ───────────────────
//
// Parce que « aucun code ne les lit » est une propriété du code d'aujourd'hui,
// et que la donnée, elle, survit au code. Un tableau nommé `capabilityGrants`
// laissé dans une fiche est une invitation permanente : le prochain lecteur
// supposera qu'il gouverne quelque chose, et la garde qu'il écrira pour « le
// respecter » ressuscitera exactement le mécanisme qu'on vient de retirer.
//
// Le précédent est dans ce dépôt : `PanelIntegratedApi.grants[]` a été conservé
// « pour ne pas détruire une saisie manuelle », et il a fallu répéter pendant
// des lots entiers, en commentaire, qu'il ne gouvernait plus rien.
//
// ── CE QU'ELLE NE TOUCHE PAS ────────────────────────────────────────────────
//
// Les ÉVÉNEMENTS déjà écrits (`COMMERCIAL_OPENED`, `CAPABILITY_GRANTS_UPDATED`)
// restent en base. Ils racontent des décisions réellement prises par des
// personnes réelles, à une date où elles avaient un sens ; une chronologie
// qu'on réécrit après coup ne vaut plus rien. Ils sont lisibles tels quels — le
// champ `type` de la collection d'événements ne porte aucune énumération.
//
// ── IDEMPOTENTE ─────────────────────────────────────────────────────────────
//
// `$unset` sur un champ absent ne fait rien. Rejouer cette migration est sans
// effet, et son deuxième passage rapporte honnêtement « 0 fiche modifiée ».
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import PanelProject from '../../models/PanelProject.model.js';
import logger from '../../utils/logger.js';

/** Les champs retirés du schéma, et donc de la base. */
const CHAMPS_RETIRES = Object.freeze([
  'capabilityGrants',
  'commercialState',
  'commercialStateUpdatedAt',
  'commercialStateUpdatedBy',
  'commercialStateReason',
]);

const dryRun = process.argv.includes('--dry-run');

try {
  await connectDatabase();

  /**
   * On interroge la collection BRUTE, et non le modèle.
   *
   * Mongoose ne rend que ce que le schéma déclare : les cinq champs ayant été
   * retirés du schéma, `PanelProject.find()` ne les verrait plus du tout, et
   * cette migration rapporterait fièrement « rien à faire » sur une base qui
   * les contient tous.
   */
  const collection = mongoose.connection.db.collection(PanelProject.collection.name);

  const filtre = { $or: CHAMPS_RETIRES.map((champ) => ({ [champ]: { $exists: true } })) };

  const concernees = await collection.find(filtre, {
    projection: { projectId: 1, projectName: 1, ...Object.fromEntries(CHAMPS_RETIRES.map((c) => [c, 1])) },
  }).toArray();

  if (concernees.length === 0) {
    logger.success('Aucune fiche ne porte ces champs : rien à migrer.');
  } else {
    logger.info(`${concernees.length} fiche(s) portent au moins un des champs retirés :`);
    for (const fiche of concernees) {
      const presents = CHAMPS_RETIRES
        .filter((champ) => fiche[champ] !== undefined)
        /**
         * On journalise la VALEUR des octrois et de l'état d'ouverture.
         *
         * Ce sont des décisions d'exploitation, pas des secrets — aucun de ces
         * champs n'a jamais porté de credential. Les afficher donne à
         * l'opérateur la seule trace qui subsistera de ce qui était configuré
         * avant l'effacement, et c'est précisément ce qu'il voudra relire s'il
         * doute d'une régression après la bascule.
         */
        .map((champ) => `${champ}=${JSON.stringify(fiche[champ])}`);
      logger.info(`  · ${fiche.projectName ?? '(sans nom)'} [${fiche.projectId}] — ${presents.join(', ')}`);
    }

    if (dryRun) {
      logger.warn('--dry-run : aucune écriture. Relancez sans l’option pour appliquer.');
    } else {
      const result = await collection.updateMany(
        filtre,
        { $unset: Object.fromEntries(CHAMPS_RETIRES.map((champ) => [champ, ''])) },
      );
      logger.success(`${result.modifiedCount} fiche(s) nettoyée(s).`);
    }
  }
} catch (error) {
  logger.error(`Migration interrompue : ${error.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
