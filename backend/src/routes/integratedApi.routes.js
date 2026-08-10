// ROUTES DU PLAN DE CONTRÔLE INTEGRATEDAPI — L1.
//
// ── LA RÈGLE D'ACCÈS, ET SA RAISON ──────────────────────────────────────────
//
// LECTURE  : tout compte authentifié du Panel. L'état d'une intégration
//            (« Stripe TEST est valide, vérifié il y a 4 minutes ») est un
//            diagnostic d'exploitation, pas un secret. Un ADMIN doit pouvoir
//            constater qu'un fournisseur est tombé sans dépendre d'un DEV.
//
// ÉCRITURE : DEV uniquement. Ces routes portent les identifiants d'accès aux
//            services tiers de toute la plateforme.
//
// VALIDATION : DEV uniquement — c'est une ÉCRITURE. Elle sort sur le réseau
//            vers un fournisseur, consomme du quota, et laisse une trace
//            horodatée dans le coffre. Une lecture ne fait pas cela.
//
// Cette répartition suit exactement celle de `company.routes.js`, qui protège
// déjà les mêmes données ; s'en écarter créerait deux doctrines pour un même
// risque.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  availability,
  detail,
  list,
  putCredentials,
  validate,
} from '../controllers/integratedApi.controller.js';
import { catalogue } from '../controllers/capabilities.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

// — Lecture : tout utilisateur authentifié ---------------------------------
router.get('/', asyncHandler(list));
router.get('/availability', asyncHandler(availability));
// AVANT `/:provider`, sinon Express lirait « capabilities » comme un nom de
// fournisseur et répondrait « fournisseur inconnu » — un 404 parfaitement
// exact et parfaitement incompréhensible.
router.get('/capabilities', catalogue);
router.get('/:provider', asyncHandler(detail));

// — Écriture : DEV uniquement ----------------------------------------------
router.use(requirePanelDev);

router.put('/:provider/credentials', asyncHandler(putCredentials));
router.post('/:provider/validate', asyncHandler(validate));

export default router;
