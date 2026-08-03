// Diagnostic du parc — docs/architecture/39_DIAGNOSTIC_ENGINE.md.
//
// LECTURE SEULE : ce routeur ne déclare QUE des GET, comme la supervision.
// Un test d'architecture échoue si une méthode d'écriture apparaît ici.
//
// Le diagnostic ANALYSE ce que la supervision a OBSERVÉ. Il ne contacte
// aucun projet et n'écrit rien.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  catalog,
  fleetDiagnostic,
  projectCompatibility,
  projectDiagnostic,
  projectReadiness,
  projectRecommendations,
  projectRisks,
} from '../controllers/diagnostic.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));
// Surface TECHNIQUE : réservée aux comptes DEV, comme les écrans qui la
// consomment. La garde du frontend redirige un ADMIN ; sans cette ligne, la
// donnée restait atteignable par appel direct à l'API.
router.use(requirePanelDev);

// Niveau 0 — analyse du parc
router.get('/fleet', asyncHandler(fleetDiagnostic));
// Le catalogue de règles, pour rendre le moteur auditable
router.get('/catalog', asyncHandler(catalog));

// Niveau 2 — analyse d'un projet
router.get('/projects/:projectId', asyncHandler(projectDiagnostic));
// Niveau 3 — axes isolés
router.get('/projects/:projectId/compatibility', asyncHandler(projectCompatibility));
router.get('/projects/:projectId/readiness', asyncHandler(projectReadiness));
router.get('/projects/:projectId/risks', asyncHandler(projectRisks));
router.get('/projects/:projectId/recommendations', asyncHandler(projectRecommendations));

export default router;
