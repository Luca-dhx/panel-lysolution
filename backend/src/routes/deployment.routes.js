// Déploiement du Panel — docs/architecture/60_PANEL_DEPLOYMENT.md.
//
// DEV uniquement, sans exception : ces routes ouvrent une session SSH sur un
// serveur et y publient du code. Le rôle ADMIN n'y a aucun accès.
//
// Les opérations sont des POST parce qu'elles transportent un mot de passe
// dans leur corps — jamais dans une URL, qui finirait dans les journaux
// d'accès de nginx.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  create,
  deploy,
  detail,
  overview,
  preflight,
  releases,
  remove,
  rollback,
  run,
  runs,
  runStream,
  self,
  simulate,
  testConnection,
  update,
} from '../controllers/deployment.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));
router.use(requirePanelDev);

// — Lecture ----------------------------------------------------------------
router.get('/', asyncHandler(overview));
router.get('/self', asyncHandler(self));
router.get('/runs', asyncHandler(runs));
router.get('/runs/:runId', asyncHandler(run));
// Flux NDJSON reprenable : `?since=<seq>` reprend après une coupure (le
// backend redémarre quand le Panel se déploie lui-même).
router.get('/runs/:runId/stream', asyncHandler(runStream));
router.get('/targets/:targetId', asyncHandler(detail));

// — Destinations -----------------------------------------------------------
router.post('/targets', asyncHandler(create));
router.patch('/targets/:targetId', asyncHandler(update));
router.delete('/targets/:targetId', asyncHandler(remove));

// ── L'ACTION PRINCIPALE ───────────────────────────────────────────────────
// Une seule. L'opérateur exprime une intention — « déployer cette
// destination » — et le moteur enchaîne connexion, prérequis, sécurité de la
// destination, build, transfert, nginx, TLS, services, contrôle de santé et
// vérification publique. Répond 202 avec un executionId.
router.post('/targets/:targetId/deploy', asyncHandler(deploy));

// Retour à une release antérieure — également une intention, pas une étape.
router.post('/targets/:targetId/rollback', asyncHandler(rollback));

// ── OUTILS DE DIAGNOSTIC ──────────────────────────────────────────────────
// Ces trois opérations ne font PLUS partie du parcours : le déploiement les
// exécute lui-même. Elles restent exposées parce qu'elles gardent une
// utilité propre — vérifier un serveur AVANT de préparer un déploiement,
// sans rien engager. L'interface ne les propose pas dans le parcours normal.
router.post('/targets/:targetId/test-connection', asyncHandler(testConnection));
router.post('/targets/:targetId/preflight', asyncHandler(preflight));
router.post('/targets/:targetId/simulate', asyncHandler(simulate));

// Lecture courte exécutée dans la requête : l'opérateur en a besoin tout de
// suite pour choisir une release.
router.post('/targets/:targetId/releases', asyncHandler(releases));

export default router;
