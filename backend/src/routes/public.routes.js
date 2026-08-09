/**
 * SURFACE PUBLIQUE DU PANEL — sans session, et volontairement minuscule.
 *
 * ══ CE QU'ELLE SERT, ET POURQUOI ELLE EXISTE ════════════════════════════════
 *
 * L'écran de connexion doit porter la marque du Panel : son logo, son nom, ses
 * couleurs. Ces trois données vivaient derrière `requirePanelUser` — le login
 * recevait donc un 401 avant même d'exister, et restait sur le thème par
 * défaut avec un titre écrit en dur.
 *
 * ══ CE QU'ELLE N'EST PAS ════════════════════════════════════════════════════
 *
 * Ce n'est PAS une version non authentifiée de `/api/company`. Le service
 * qu'elle appelle construit une LISTE BLANCHE, champ par champ : ce qu'un
 * visiteur anonyme voit de toute façon en arrivant sur l'écran de connexion.
 *
 * Toute route ajoutée ici doit se justifier de la même façon. Une surface
 * publique qui grandit sans raison finit par publier ce que personne n'a
 * décidé de publier.
 */
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { describePublicBranding } from '../services/company/publicBranding.service.js';

const router = Router();

router.get('/branding', asyncHandler(async (_req, res) =>
  ok(res, await describePublicBranding())));

export default router;
