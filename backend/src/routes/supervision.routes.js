// Supervision du parc — docs/architecture/36_SUPERVISION.md.
//
// LECTURE SEULE : ce routeur ne déclare QUE des GET. Aucune écriture, aucune
// action distante. Un test d'architecture échoue si un POST, PUT, PATCH ou
// DELETE apparaît ici.
//
// Lecture ouverte à tout utilisateur du Panel : superviser n'est pas
// administrer. Les actions sensibles restent sur /api/projects, réservées
// aux comptes DEV.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  dashboard,
  events,
  facets,
  fleet,
  projectEvents,
  projectHeartbeats,
  projectOverview,
  projectTechnical,
} from '../controllers/supervision.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));
// Surface TECHNIQUE : réservée aux comptes DEV, comme les écrans qui la
// consomment. La garde du frontend redirige un ADMIN ; sans cette ligne, la
// donnée restait atteignable par appel direct à l'API.
router.use(requirePanelDev);

// Niveau 0 — vue globale
router.get('/dashboard', asyncHandler(dashboard));
// Niveau 1 — parc et recherche
router.get('/fleet', asyncHandler(fleet));
router.get('/facets', asyncHandler(facets));
router.get('/events', asyncHandler(events));
// Niveau 2 — fiche projet
router.get('/projects/:projectId', asyncHandler(projectOverview));
// Niveau 3 — détails techniques
router.get('/projects/:projectId/technical', asyncHandler(projectTechnical));
router.get('/projects/:projectId/heartbeats', asyncHandler(projectHeartbeats));
router.get('/projects/:projectId/events', asyncHandler(projectEvents));

export default router;
