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
router.get('/targets/:targetId', asyncHandler(detail));

// — Destinations -----------------------------------------------------------
router.post('/targets', asyncHandler(create));
router.patch('/targets/:targetId', asyncHandler(update));
router.delete('/targets/:targetId', asyncHandler(remove));

// — Opérations (toutes déléguées au worker détaché) ------------------------
router.post('/targets/:targetId/test-connection', asyncHandler(testConnection));
router.post('/targets/:targetId/preflight', asyncHandler(preflight));
router.post('/targets/:targetId/simulate', asyncHandler(simulate));
router.post('/targets/:targetId/deploy', asyncHandler(deploy));
router.post('/targets/:targetId/rollback', asyncHandler(rollback));

// Lecture courte exécutée dans la requête : l'opérateur en a besoin tout de
// suite pour choisir une release.
router.post('/targets/:targetId/releases', asyncHandler(releases));

export default router;
