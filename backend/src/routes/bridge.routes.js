// Surface publique de pont — implémentation serveur de
// docs/spec/PanelBridge.openapi.yaml, montée sous /bridge/v1.
// Ordre contractuel des gardes : version de contrat sur TOUT le routeur
// (ping compris), puis routes publiques (ping, bootstrap), puis bridgeToken.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import bridgeContractVersionGuard from '../middlewares/bridgeContractVersion.middleware.js';
import requireBridgeAuth from '../middlewares/bridgeAuth.middleware.js';
import {
  bootstrapPairing,
  heartbeat,
  ping,
  syncPull,
  syncPush,
  unpair,
} from '../controllers/bridge.controller.js';
import { invoke as invokeCapability } from '../controllers/capabilities.controller.js';
import { fetchVerificationSecret } from '../controllers/webhookVerification.controller.js';
import { introspectFederatedPrincipal } from '../controllers/bridgeFederation.controller.js';
import {
  getProjectEmailTemplate,
  getProjectEmailTemplateReadiness,
  listProjectEmailTemplates,
  postProjectEmailTemplatePreview,
  postProjectEmailTemplateTestSend,
} from '../controllers/bridgeEmailTemplates.controller.js';

const router = Router();

router.use(bridgeContractVersionGuard);

router.get('/ping', ping);
router.post('/pairings', asyncHandler(bootstrapPairing));

router.delete('/pairings/current', asyncHandler(requireBridgeAuth), asyncHandler(unpair));

router.use(asyncHandler(requireBridgeAuth));
router.post('/heartbeats', asyncHandler(heartbeat));
router.post('/sync/push', asyncHandler(syncPush));
router.get('/sync/pull', asyncHandler(syncPull));

/**
 * PASSERELLE DE CAPACITÉS (contrat 1.5.0) — montée APRÈS `requireBridgeAuth`,
 * et c'est tout l'enjeu : le `projectId` qui fera autorité vient du jeton,
 * jamais de l'URL ni du corps. Un montage au-dessus de la garde rendrait la
 * capacité anonyme, donc adressable par n'importe qui.
 */
router.post('/capabilities/:code/invoke', asyncHandler(invokeCapability));

/**
 * LE SECRET DE VÉRIFICATION D'UN PROJET (L6.3A) — montée ici, et pas ailleurs.
 *
 * Sous `requireBridgeAuth`, comme les capacités : le projet dont on rend le
 * secret est celui du JETON. Il n'y a pas de `:projectId` dans l'URL, et c'est
 * délibéré — un identifiant dans le chemin serait un identifiant que l'appelant
 * choisit, donc une invitation à demander celui du voisin.
 *
 * En GET, parce que la demande ne change rien chez le fournisseur : elle relit
 * ce que le provisionnement a déjà rangé.
 */
router.get(
  '/webhooks/:provider/verification-secret',
  asyncHandler(fetchVerificationSecret),
);

/**
 * L'INTROSPECTION D'IDENTITÉ FÉDÉRÉE (L12.B) — montée ici, et pas ailleurs.
 *
 * Sous `requireBridgeAuth`, comme les capacités et le secret de vérification :
 * le projet POUR LEQUEL on répond est celui du jeton. Il n'y a pas de
 * `:projectId` dans le chemin, et c'est délibéré — un identifiant dans l'URL
 * serait un identifiant que l'appelant choisit, donc une invitation à demander
 * si le développeur d'à côté a encore accès chez le voisin.
 *
 * En POST bien qu'il s'agisse d'une lecture : la requête porte un identifiant
 * d'utilisateur et une version de session, qui n'ont rien à faire dans les
 * journaux d'accès des intermédiaires.
 */
router.post('/federation/introspect', asyncHandler(introspectFederatedPrincipal));

/**
 * LES MODÈLES DU PROJET (L11.1) — montés APRÈS `requireBridgeAuth`, comme les
 * capacités, et pour la même raison.
 *
 * ── POURQUOI AUCUN `:projectId` DANS CES CHEMINS ───────────────────────────
 *
 * Le projet dont on rend, écrit et restaure les modèles est celui du JETON. Un
 * identifiant dans l'URL serait un identifiant que l'appelant choisit ; ce
 * lot-ci existe précisément parce que le contenu d'un client ne doit jamais
 * pouvoir être servi — ni réécrit — au nom d'un autre.
 *
 * ── POURQUOI UNE SURFACE D'ÉDITION, ET PAS UNE CAPACITÉ DE PLUS ────────────
 *
 * Une capacité désigne un acte chez un FOURNISSEUR : elle ouvre le coffre,
 * réserve une opération, traduit des pannes de transport. Éditer un modèle ne
 * touche aucun fournisseur et ne consomme aucun credential — l'y faire passer
 * ferait déchiffrer une clé Brevo pour enregistrer du texte. `test-send`, lui,
 * EST un acte fournisseur : il redescend par la passerelle, sans exception.
 */
/*
 * MODÈLES D'E-MAIL — LECTURE SEULE (1.11.0).
 *
 * Les verbes d'écriture (`PUT /:id`, `POST /import`, `POST /:id/versions/:v/
 * restore`) ont été retirés : le Panel est la seule autorité d'édition, et
 * aucun projet n'empruntait ces routes. Voir l'en-tête du contrôleur.
 */
router.get('/email-templates', asyncHandler(listProjectEmailTemplates));
router.get('/email-templates/:templateId', asyncHandler(getProjectEmailTemplate));
router.post('/email-templates/:templateId/preview', asyncHandler(postProjectEmailTemplatePreview));
router.get('/email-templates/:templateId/readiness', asyncHandler(getProjectEmailTemplateReadiness));
router.post('/email-templates/:templateId/test-send', asyncHandler(postProjectEmailTemplateTestSend));

export default router;
