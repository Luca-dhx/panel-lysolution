// LE TEST D'EXPÉDITION — ce qu'on a demandé, et ce qui en est advenu (R10.4).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Test d'expéditeur ».
//
// ══ POURQUOI CE MODÈLE EXISTE ═══════════════════════════════════════════════
//
// L'envoi de test emprunte la chaîne réelle, donc il produit exactement ce
// qu'un envoi de projet produit : une opération réservée, un identifiant de
// message, et — plus tard, par un autre canal — un webhook de livraison.
//
// Pour un projet, cet aboutissement est acheminé par le pont vers son propre
// suivi de livraison. Le Panel écrivant pour LUI-MÊME n'a pas de projet à qui
// l'acheminer : sans ce modèle, le `delivered` arriverait, serait reconnu, et
// n'aurait nulle part où se poser. L'écran resterait éternellement sur
// « accepté », c'est-à-dire sur la moitié de la réponse — et c'est précisément
// la moitié qui ne prouve rien, puisque « accepté par Brevo » ne veut pas dire
// « arrivé ».
//
// ══ CE QU'IL NE PORTE PAS ═══════════════════════════════════════════════════
//
// Aucune clé d'API, aucun secret de webhook, aucun en-tête d'autorisation.
// Ce document est lu par un écran et recopié dans un rapport que des humains
// se transmettent : tout ce qui y entre doit pouvoir être collé dans un ticket.
//
// L'ADRESSE du destinataire, elle, y figure en clair — c'est un test déclenché
// à la main vers une adresse saisie à la main, et la masquer empêcherait de
// vérifier qu'on a bien écrit à qui l'on croyait.
import mongoose from 'mongoose';

/**
 * L'issue d'un test. FERMÉE, et chaque valeur répond à une question différente
 * de l'exploitant — c'est ce qui interdit de les réduire à « ok / pas ok ».
 */
export const SENDER_TEST_STATUS = Object.freeze({
  /** Créé, rien n'est encore parti. État transitoire, visible en cas de crash. */
  REQUESTED: 'REQUESTED',
  /** Le fournisseur a pris le message. Il n'est PAS arrivé pour autant. */
  ACCEPTED: 'ACCEPTED',
  /** Refus AVANT le fournisseur, ou refus certain DU fournisseur. Rien n'est parti. */
  REFUSED: 'REFUSED',
  /** Le fournisseur n'a rien dit : l'envoi a peut-être eu lieu. Indécidable. */
  UNKNOWN: 'UNKNOWN',
  /** Un webhook a confirmé la remise. La seule preuve qui vaille. */
  DELIVERED: 'DELIVERED',
  /** Un webhook a dit que le message n'arriverait pas. */
  BOUNCED: 'BOUNCED',
});

/** Où en est le RETOUR, indépendamment de l'envoi. */
export const SENDER_TEST_WEBHOOK_STATUS = Object.freeze({
  /** Aucun retour attendu : rien n'est parti. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  /** Le message est parti, le retour n'est pas encore arrivé. */
  PENDING: 'PENDING',
  /** Un retour a été reçu et rattaché à ce test. */
  RECEIVED: 'RECEIVED',
});

const panelEmailSenderTestSchema = new mongoose.Schema(
  {
    /**
     * L'identité de l'acte — et c'est le MÊME que l'`operationId` passé à la
     * capacité. Un second identifiant à corréler n'apporterait rien qu'une
     * occasion de les confondre.
     */
    testId: { type: String, required: true, unique: true },

    /** Le monde SERVI au moment du test. Constaté, jamais choisi. */
    environment: { type: String, required: true },
    recipientEmail: { type: String, required: true, trim: true, lowercase: true },

    /**
     * L'expéditeur RÉSOLU au moment de l'envoi — un fait, pas la configuration.
     *
     * Le figer ici permet de relire un test ancien après un changement
     * d'adresse : sans cela, le rapport afficherait l'expéditeur d'aujourd'hui
     * pour un envoi d'hier, et le diagnostic porterait sur la mauvaise adresse.
     */
    senderEmail: { type: String, default: null },
    senderName: { type: String, default: null },

    templateCode: { type: String, required: true },
    provider: { type: String, default: 'BREVO' },
    providerMessageId: { type: String, default: null },

    status: {
      type: String,
      required: true,
      enum: Object.values(SENDER_TEST_STATUS),
      default: SENDER_TEST_STATUS.REQUESTED,
    },
    webhookStatus: {
      type: String,
      required: true,
      enum: Object.values(SENDER_TEST_WEBHOOK_STATUS),
      default: SENDER_TEST_WEBHOOK_STATUS.NOT_APPLICABLE,
    },

    requestedAt: { type: String, required: true },
    acceptedAt: { type: String, default: null },
    lastWebhookAt: { type: String, default: null },
    /**
     * L'événement CANONIQUE du fournisseur (`DELIVERED`, `HARD_BOUNCE`…), tel
     * que l'aiguillage l'a normalisé — le même vocabulaire que celui projeté
     * vers les projets. Conserver la graphie brute de Brevo à la place ferait
     * du rapport du Panel le seul endroit du parc à parler un autre dialecte.
     */
    lastWebhookEvent: { type: String, default: null },
    lastWebhookReason: { type: String, default: null },

    /**
     * Le refus, en deux champs SÛRS.
     *
     * `errorCode` est le nôtre (vocabulaire de passerelle), `errorMessage` la
     * phrase que nous avons formulée. Le message du fournisseur n'est jamais
     * recopié : il peut contenir un identifiant de compte ou une URL interne,
     * et ce document finit collé dans un ticket.
     */
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },

    requestedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/** Le rapport lit toujours le dernier test — l'index sert cette lecture. */
panelEmailSenderTestSchema.index({ requestedAt: -1 });
/** Le webhook retrouve son test par l'identifiant de message du fournisseur. */
panelEmailSenderTestSchema.index({ providerMessageId: 1 });

export const PanelEmailSenderTest = mongoose.model(
  'PanelEmailSenderTest',
  panelEmailSenderTestSchema,
);
export default PanelEmailSenderTest;
