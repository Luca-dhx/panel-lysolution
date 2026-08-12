/**
 * REGISTRE FINANCIER — surface interne /api/finances.
 *
 * ══ QUI PEUT QUOI, ET POURQUOI CE DÉCOUPAGE ═════════════════════════════════
 *
 * Le Panel n'a que deux rôles, `ADMIN` et `DEV`, ce dernier étant un surensemble
 * du premier. Il n'y a donc pas de « rôle comptable » à inventer, et surtout pas
 * une ACL parallèle à construire : la question est seulement de savoir où passe
 * la ligne entre les deux gardes qui existent déjà.
 *
 * ── LECTURE : tout compte du Panel ──────────────────────────────────────────
 * Les finances d'un projet sont une donnée de GESTION, pas d'infrastructure.
 * C'est même la donnée de gestion par excellence : savoir si un client rapporte
 * est le travail de l'ADMIN, pas du développeur. Réserver la lecture aux DEV
 * ferait de la personne qui écrit le code la seule à pouvoir lire le chiffre
 * d'affaires — exactement l'inverse de ce que ce lot construit.
 *
 * ── ÉCRITURE UNITAIRE : tout compte du Panel ────────────────────────────────
 * Saisir un coût ou un revenu est une écriture de tenue de livres. La réserver
 * aux DEV obligerait à passer par un développeur pour enregistrer une facture
 * d'hébergement, et le registre finirait tenu ailleurs — dans un tableur, ce
 * qui est précisément ce qu'on remplace.
 *
 * Chaque écriture porte son auteur (`createdBy`, `updatedBy`, `deletedBy`) et
 * part au journal de chronologie : l'ouverture s'accompagne d'une imputabilité,
 * elle ne s'y substitue pas.
 *
 * ── SUPPRESSION EN MASSE : comptes DEV uniquement ───────────────────────────
 * C'est le seul geste de cette surface qui soit irréversible À L'ÉCHELLE. Une
 * suppression unitaire se rattrape en resaisissant une ligne ; « tout
 * supprimer » sur la portée globale retire des centaines de mouvements que
 * personne ne saura reconstituer de mémoire. Un cran au-dessus, donc, comme la
 * protection contractuelle et l'ouverture commerciale.
 *
 * La suppression reste LOGIQUE dans tous les cas — les documents survivent et
 * restent auditables — mais aucun écran ne sait les restaurer en L10.1 : du
 * point de vue de l'utilisateur, c'est définitif, et la garde le reflète.
 *
 * ══ AUCUNE ROUTE NE PARLE À UN FOURNISSEUR ══════════════════════════════════
 *
 * Il n'y a volontairement ni « importer depuis Stripe », ni « rembourser », ni
 * « synchroniser ». Ces verbes appartiennent aux lots suivants, et ils
 * n'entreront pas par cette porte : ils produiront des mouvements via le
 * service, sous une origine qui n'est pas `MANUAL`.
 */
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  addTransaction,
  bulkScope,
  byProject,
  editTransaction,
  removeAll,
  removeTransaction,
  summary,
  transaction,
  transactions,
} from '../controllers/finances.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

/* ── Lecture ───────────────────────────────────────────────────────────────── */
router.get('/summary', asyncHandler(summary));
router.get('/by-project', asyncHandler(byProject));
router.get('/bulk-scope', asyncHandler(bulkScope));
router.get('/transactions', asyncHandler(transactions));
// APRÈS les chemins fixes : `/summary` ne doit jamais être lu comme un identifiant.
router.get('/transactions/:transactionId', asyncHandler(transaction));

/* ── Écriture ──────────────────────────────────────────────────────────────── */
router.post('/transactions', asyncHandler(addTransaction));
router.patch('/transactions/:transactionId', asyncHandler(editTransaction));
router.delete('/transactions/:transactionId', asyncHandler(removeTransaction));

/**
 * « TOUT SUPPRIMER » — DEV, portée explicite, confirmation retapée.
 *
 * POST et non DELETE : la requête porte un CORPS (portée, motif, confirmation),
 * et un DELETE avec corps est mal servi par une partie des intermédiaires HTTP.
 * Le verbe décrit ici une opération, pas la suppression d'une ressource
 * désignée par son adresse — il n'y a d'ailleurs aucune adresse à désigner.
 */
router.post('/transactions/bulk-delete', requirePanelDev, asyncHandler(removeAll));

export default router;
