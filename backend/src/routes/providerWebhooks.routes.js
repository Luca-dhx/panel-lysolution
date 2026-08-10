// SURFACE ENTRANTE DES WEBHOOKS FOURNISSEUR — publique, brute, close (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Endpoint entrant ».
//
//   POST /webhooks/providers/:slug          l'événement
//   GET  /webhooks/providers/:slug/health   sonde anonyme, sans effet de bord
//
// ── TROIS RAISONS DE NE PAS ÊTRE SOUS `/api` ────────────────────────────────
//
//  1. `/api` porte la garde `requirePanelUser` : un fournisseur n'a pas de JWT.
//  2. `/api` est en `no-store` et en JSON parsé — or il nous faut les OCTETS.
//  3. `/api` est la surface INTERNE du Panel. Celle-ci est publique par
//     nature, et la confondre avec l'autre est le début des accidents.
//
// ── LE CORPS BRUT N'EST PAS UN DÉTAIL ───────────────────────────────────────
//
// `express.raw()` ici, et ce routeur monté AVANT `express.json()` dans
// `app.js`. Une signature HMAC porte sur les octets reçus ; un corps parsé puis
// re-sérialisé diffère dès le premier espace, et la vérification échoue alors
// sur des messages authentiques. C'est le piège classique, et il se termine
// toujours par « on désactive la vérification en attendant ».
//
// ── AUCUN SECRET, AUCUN DÉTAIL, DANS AUCUNE RÉPONSE ─────────────────────────
//
// Les réponses sont volontairement pauvres. Distinguer « signature fausse » de
// « secret absent » côté appelant renseignerait un tiers sur l'état de notre
// configuration ; distinguer « binding inconnu » de « provider inconnu » lui
// dirait quels fournisseurs nous avons configurés.
import { Router } from 'express';
import express from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { receiveProviderWebhook, probeProviderWebhook } from '../controllers/providerWebhooks.controller.js';

const router = Router();

/**
 * 1 Mo : une charge utile de webhook légitime tient très largement dedans
 * (Stripe plafonne bien en dessous). Au-delà, c'est du bruit, et on ne le lit
 * même pas — un endpoint public ne met pas en mémoire ce qu'on lui envoie.
 *
 * `type: () => true` : on accepte tout type déclaré. Un fournisseur qui envoie
 * `text/plain` par erreur ne doit pas voir sa signature « échouer » alors que
 * c'est le parseur qui n'a rien lu.
 */
const rawBody = express.raw({ type: () => true, limit: '1mb' });

router.get('/:slug/health', asyncHandler(probeProviderWebhook));
router.post('/:slug', rawBody, asyncHandler(receiveProviderWebhook));

export default router;
