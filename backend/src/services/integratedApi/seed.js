// AMORÇAGE DU PLAN DE CONTRÔLE — idempotent, et volontairement stérile.
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §13 (L1).
//
// ── CE QUE FAIT CE SEED ─────────────────────────────────────────────────────
//
// Il crée les jeux d'identifiants VIDES attendus par le registre — un par
// environnement pour un fournisseur `ENVIRONMENT`, un seul pour un fournisseur
// `PANEL_GLOBAL`. Rien de plus.
//
// Créer les documents vides d'avance n'est pas cosmétique : l'écran
// d'administration affiche alors la carte du fournisseur avec son état réel
// (« non configuré ») au lieu d'un trou, et l'index unique est exercé dès le
// premier démarrage plutôt qu'au premier enregistrement.
//
// ── CE QU'IL NE FAIT JAMAIS ─────────────────────────────────────────────────
//
//  · Il ne LIT AUCUNE base de projet. Aspirer les credentials de SB Auto pour
//    les recopier dans le Panel serait une migration silencieuse, faite sans
//    inventaire ni retour arrière — exactement ce que la roadmap interdit
//    avant L6. Les identifiants seront saisis à la main, ou migrés dans un lot
//    dédié.
//  · Il n'écrase JAMAIS un jeu existant. Il n'ajoute que ce qui manque.
//  · Il n'invente aucune valeur : un jeu créé ici est vide, et son état est
//    EMPTY.
//
// ── DEUX INSTANCES, DEUX PROVISIONNEMENTS ───────────────────────────────────
//
// Une instance de Panel ne détient que les identifiants de SON environnement.
// Le Panel TEST amorce le jeu TEST et le jeu PROD (pour que l'administration
// puisse préparer les deux), mais SEUL le jeu correspondant à son runtime
// servira jamais à une action métier. Cf. §9.4 de la roadmap.
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelIntegratedApiCredentialSet, {
  CREDENTIAL_SET_STATUS,
} from '../../models/PanelIntegratedApiCredentialSet.model.js';
import { listProviderDefinitions, environmentsFor } from './providerRegistry.js';
import { newCredentialSetId } from './credentialVault.js';

/**
 * Crée les jeux manquants. Rejouable sans effet : appelé à chaque démarrage.
 *
 * @returns {Promise<{created: number, existing: number, sets: Array}>}
 */
export async function seedIntegratedApiCredentialSets() {
  const at = nowIso();
  let created = 0;
  let existing = 0;
  const sets = [];

  for (const definition of listProviderDefinitions()) {
    for (const environment of environmentsFor(definition.code)) {
      const key = { provider: definition.code, environment, projectId: null };
      const already = await PanelIntegratedApiCredentialSet.findOne(key).select('_id').lean();
      if (already) {
        existing += 1;
        sets.push({ ...key, created: false });
        continue;
      }
      /**
       * `updateOne` + upsert plutôt que `create` : deux démarrages simultanés
       * (un redémarrage PM2 pendant qu'un worker tourne) ne doivent pas
       * produire une erreur de clé dupliquée. L'index unique arbitre, l'upsert
       * s'y plie.
       */
      await PanelIntegratedApiCredentialSet.updateOne(
        key,
        {
          $setOnInsert: {
            credentialSetId: newCredentialSetId(),
            scope: definition.scope,
            credentialsEncrypted: {},
            status: CREDENTIAL_SET_STATUS.EMPTY,
            createdAt: at,
            updatedAt: at,
          },
        },
        { upsert: true },
      );
      created += 1;
      sets.push({ ...key, created: true });
    }
  }

  if (created > 0) {
    logger.info(
      `[integrated-api] Plan de contrôle amorcé : ${created} jeu(x) d’identifiants créé(s), `
      + `${existing} déjà présent(s). Aucun identifiant n’a été copié depuis un projet.`,
    );
  }
  return { created, existing, sets };
}

export default { seedIntegratedApiCredentialSets };
