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
 * Il n'y a volontairement ni « importer depuis Stripe », ni « synchroniser ».
 * Aucune route ne construit d'appel fournisseur, ne lit de clé, ne connaît
 * d'URL d'API : les mouvements automatiques entrent par le service, sous une
 * origine qui n'est pas `MANUAL`.
 *
 * « Rembourser » fait exception depuis L10.4, et l'exception confirme la règle :
 * la route ne parle pas à Stripe non plus. Elle demande un acte au PLAN DE
 * CONTRÔLE, qui vérifie l'appartenance, réserve l'opération et porte la clé
 * d'idempotence. Le registre financier, lui, reçoit ensuite un fait — comme
 * pour n'importe quel encaissement.
 */
import { Router } from 'express';
import multer from 'multer';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import { MAX_INPUT_BYTES, humanBytes } from '../services/upload/mediaPolicy.js';
import {
  addRecurringCost,
  addTransaction,
  bulkScope,
  byProject,
  downloadReceipt,
  editRecurringCost,
  editTransaction,
  addPaymentRequest,
  cancelPayment,
  paymentRequest,
  paymentRequests,
  recurringCost,
  recurringCosts,
  refund,
  refundEligibility,
  removeAll,
  removeReceipt,
  removeTransaction,
  stopRecurring,
  summary,
  transaction,
  transactions,
  unprojectedRevenue,
  uploadReceipt,
} from '../controllers/finances.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

/**
 * RÉCEPTION D'UN JUSTIFICATIF — en mémoire, jamais sur disque avant contrôle.
 *
 * Le fichier ne touche le disque qu'APRÈS avoir été validé sur ses octets et
 * nommé par le protocole Media. `multer` avec un stockage disque écrirait
 * d'abord, sous un nom qu'il choisit, dans un dossier temporaire — trois choses
 * dont on ne veut aucune.
 *
 * AUCUN filtre de type ici : `file.mimetype` est DÉCLARÉ par le navigateur
 * d'après l'extension, donc il ne prouve rien. Le vrai contrôle lit la
 * signature du contenu (`documentValidation.js`). Un filtre sur le type déclaré
 * donnerait l'illusion d'une barrière là où il n'y en aurait pas.
 */
const receptionJustificatif = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INPUT_BYTES },
});

/** Traduit les refus de `multer` en erreurs métier — jamais en « erreur interne ». */
function traduireRefusUpload(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(
        413,
        'PANEL_DOCUMENT_TOO_LARGE',
        `Ce document dépasse la taille maximale acceptée (${humanBytes(MAX_INPUT_BYTES)}).`,
        { maxBytes: MAX_INPUT_BYTES },
      ));
    }
    return next(ApiError.badRequest('PANEL_DOCUMENT_INVALID', `Envoi de fichier invalide (${err.code}).`));
  }
  return next(err);
}

/* ── Lecture ───────────────────────────────────────────────────────────────── */
router.get('/summary', asyncHandler(summary));
router.get('/by-project', asyncHandler(byProject));
router.get('/bulk-scope', asyncHandler(bulkScope));
router.get('/transactions', asyncHandler(transactions));
/**
 * L10.3 — LES FAITS FOURNISSEUR QUI N'ONT PAS PU ÊTRE PROJETÉS.
 *
 * Réservée aux comptes DEV : elle expose des identités techniques Stripe, et
 * répond à une question d'exploitation — « de l'argent est arrivé chez le
 * fournisseur et n'apparaît pas ici, pourquoi ? ». Ce n'est pas une donnée de
 * gestion, c'est un diagnostic.
 */
router.get('/provider-revenue/unprojected', requirePanelDev, asyncHandler(unprojectedRevenue));
// APRÈS les chemins fixes : `/summary` ne doit jamais être lu comme un identifiant.
router.get('/transactions/:transactionId', asyncHandler(transaction));

/* ══════════════════════════════════════════════════════════════════════════
   REMBOURSEMENTS (L10.4) — le seul verbe de cette surface qui rende de l'argent.

   ══ POURQUOI SOUS LA TRANSACTION, ET NON SOUS UNE SURFACE « /refunds » ══════

   Parce que le CHEMIN porte la preuve. Un remboursement ne se demande pas dans
   l'absolu : il se demande SUR un encaissement précis, dont le serveur tire le
   projet, le monde et l'intention de paiement. Une surface autonome aurait dû
   accepter ces trois-là dans un corps de requête — c'est-à-dire laisser un
   navigateur désigner la ressource Stripe à muter.

   ══ AUCUN IDENTIFIANT FOURNISSEUR N'ENTRE PAR ICI ═══════════════════════════

   Ni « pi_ », ni « ch_ », ni « in_ », ni « TEST/PROD ». L'en-tête de ce fichier
   annonçait qu'aucune route ne parlerait à un fournisseur ; celle-ci le fait
   désormais, mais elle passe par le PLAN DE CONTRÔLE — appartenance vérifiée,
   opération réservée, clé d'idempotence — jamais par un appel direct.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/transactions/:transactionId/refund', asyncHandler(refundEligibility));
router.post('/transactions/:transactionId/refund', asyncHandler(refund));

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

/* ══════════════════════════════════════════════════════════════════════════
   PRESTATIONS À FACTURER (L10.5) — de l'argent RÉCLAMÉ.

   ══ POURQUOI UNE SURFACE À PART, ET NON UNE CATÉGORIE DE MOUVEMENT ══════════

   Parce qu'une créance n'a rien eu lieu. La loger sous `/transactions` l'aurait
   fait entrer dans le registre, donc dans les totaux, donc dans le bénéfice —
   et le résultat du mois aurait dépendu de ce qu'on espère encaisser.

   Elle rejoint le ledger à UN seul instant : le paiement. Et pas par cette
   porte — par le webhook Stripe, la projection L10.3, et un unique revenu.

   ══ PERMISSIONS ═════════════════════════════════════════════════════════════

   Comme la saisie d'un mouvement : tout compte du Panel. Facturer une
   prestation est un acte de gestion courant, et le réserver aux DEV obligerait
   à passer par un développeur pour envoyer une note de 500 €. Chaque écriture
   porte son auteur et part au journal.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/payment-requests', asyncHandler(paymentRequests));
router.post('/payment-requests', asyncHandler(addPaymentRequest));
// APRÈS le chemin fixe : la création ne doit jamais être lue comme un identifiant.
router.get('/payment-requests/:paymentRequestId', asyncHandler(paymentRequest));
/**
 * POST et non DELETE : annuler n'est pas supprimer. La demande RESTE, avec son
 * histoire et son motif — c'est une trace commerciale, et elle se relit.
 */
router.post('/payment-requests/:paymentRequestId/cancel', asyncHandler(cancelPayment));

/* ══════════════════════════════════════════════════════════════════════════
   COÛTS RÉCURRENTS (L10.2) — les RÈGLES.

   Surface distincte de `/transactions`, et c'est le point : une règle n'est pas
   un mouvement. Les loger sous la même adresse aurait fini par faire lister des
   dépenses futures à côté de dépenses réelles.

   Mêmes permissions que le reste du registre : lire et tenir les livres est le
   travail de l'équipe (§ en-tête). Arrêter une récurrence n'est PAS réservé aux
   DEV — c'est un acte de gestion courant, et il est parfaitement réversible en
   créant une nouvelle règle. Seule la suppression EN MASSE du livret reste un
   cran au-dessus.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/recurring-costs', asyncHandler(recurringCosts));
router.get('/recurring-costs/:recurringCostId', asyncHandler(recurringCost));
router.post('/recurring-costs', asyncHandler(addRecurringCost));
router.patch('/recurring-costs/:recurringCostId', asyncHandler(editRecurringCost));
router.post('/recurring-costs/:recurringCostId/stop', asyncHandler(stopRecurring));

/* ══════════════════════════════════════════════════════════════════════════
   JUSTIFICATIFS — attachés à une OCCURRENCE, jamais à une règle.

   ══ POURQUOI L'ADRESSE PASSE PAR LA TRANSACTION ═════════════════════════════

   Il aurait été plus court d'exposer `/api/media/private/:mediaId`. Cette
   surface-là ne peut être autorisée que par une table d'ACL parallèle : un
   média, seul, ne sait pas à qui il appartient.

   Ici, le CHEMIN porte le contexte. On charge la transaction, on vérifie que le
   document demandé est bien le sien, et l'autorisation devient une conséquence
   de l'objet métier plutôt qu'une liste à maintenir. Un identifiant de média
   récupéré ailleurs ne mène nulle part.

   ══ AUCUNE ROUTE STATIQUE, AUCUNE URL PUBLIQUE ══════════════════════════════

   Ces documents vivent sous `storage/media/`, qu'aucun bloc `location` d'Nginx
   ne dessert et qu'aucun `express.static` ne monte. Il n'existe pas d'adresse
   publique à deviner : c'est cette route, avec le jeton du Panel, ou rien.
   ══════════════════════════════════════════════════════════════════════════ */
router.post(
  '/transactions/:transactionId/receipt',
  receptionJustificatif.single('file'),
  traduireRefusUpload,
  asyncHandler(uploadReceipt),
);
router.get('/transactions/:transactionId/receipt', asyncHandler(downloadReceipt));
router.delete('/transactions/:transactionId/receipt', asyncHandler(removeReceipt));

export default router;
