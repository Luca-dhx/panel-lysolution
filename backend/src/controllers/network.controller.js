// Configuration réseau du Panel (surface interne /api/system-configuration).
// Lecture : tout utilisateur du Panel. Écriture : comptes DEV.
import { ok } from '../utils/apiResponse.js';
import {
  getSystemConfiguration,
  resolveBackendUrl,
  resolveFrontendUrl,
  updateNetworkConfiguration,
} from '../services/network/networkConfig.service.js';
import { getAllowedOrigins, refreshAllowedOrigins } from '../middlewares/cors.middleware.js';
import { reconcileAllProviderWebhooks } from '../services/webhooks/webhookReconciler.js';
import logger from '../utils/logger.js';

async function describeNetwork() {
  const [configuration, backend, frontend] = await Promise.all([
    getSystemConfiguration(),
    resolveBackendUrl(),
    resolveFrontendUrl(),
  ]);
  return {
    stored: configuration.network,
    resolved: {
      backendUrl: { url: backend.url, source: backend.source },
      frontendUrl: { url: frontend.url, source: frontend.source },
    },
    corsOrigins: getAllowedOrigins(),
    updatedAt: configuration.updatedAt ?? null,
    updatedBy: configuration.updatedBy ?? null,
  };
}

export async function getNetwork(_req, res) {
  return ok(res, await describeNetwork());
}

export async function putNetwork(req, res) {
  const avant = (await resolveBackendUrl()).url;

  await updateNetworkConfiguration(req.body ?? {}, { updatedBy: req.panelUser?.userId ?? null });
  await refreshAllowedOrigins();

  const apres = (await resolveBackendUrl()).url;

  /**
   * L'ADRESSE PUBLIQUE A CHANGÉ — LES FOURNISSEURS DOIVENT L'APPRENDRE (L5.1).
   *
   * ══ POURQUOI LE CROCHET EST ICI, ET NULLE PART AILLEURS ═══════════════════
   *
   * La callback des webhooks dérive de `backendUrl`. Cette route est le SEUL
   * endroit où cette adresse change sans redémarrage — le démarrage couvre
   * tous les autres cas, y compris l'auto-déploiement du Panel, qui le
   * redémarre par construction.
   *
   * Le poser dans le pipeline de déploiement aurait été faux : ce pipeline
   * déploie des PROJETS, et sa configuration runtime écrit les URLs de la
   * destination — lesquelles n'ont aucun rapport avec la callback du Panel. Le
   * crochet s'y serait déclenché à chaque mise en ligne de projet, sans raison.
   *
   * Sans ce crochet, changer de domaine laissait les fournisseurs appeler
   * l'ancienne adresse jusqu'au prochain redémarrage — c'est-à-dire dans le
   * silence, la panne la plus longue à diagnostiquer.
   *
   * ══ IL NE PEUT PAS FAIRE ÉCHOUER L'ENREGISTREMENT ═════════════════════════
   *
   * Détaché, et le service ne lève jamais. Un fournisseur indisponible ne doit
   * pas empêcher un opérateur de corriger l'adresse de son Panel — ce serait
   * refuser la réparation à cause de la panne qu'elle répare.
   */
  if (apres && apres !== avant) {
    void reconcileAllProviderWebhooks()
      .then((rapport) => {
        logger.info(
          `Adresse publique modifiée (${avant ?? 'aucune'} → ${apres}) : `
          + `webhooks réconciliés, ${rapport.warnings.length} à surveiller.`,
        );
      })
      .catch((err) => logger.warn(`Réconciliation des webhooks après changement d’adresse : ${err.message}`));
  }

  return ok(res, await describeNetwork());
}
