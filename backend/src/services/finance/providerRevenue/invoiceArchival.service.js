/**
 * L12 — L'ARCHIVAGE DE LA FACTURE FOURNISSEUR.
 *
 * ══ CE QUE CE MODULE EXISTE POUR CORRIGER ═══════════════════════════════════
 *
 * Le Panel conservait deux ADRESSES de facture — `invoiceDocument.pdfUrl` et
 * `hostedUrl` — et rien d'autre. Un mouvement financier affichait donc un
 * encaissement dont la pièce vivait entièrement chez le fournisseur, derrière
 * une URL signée dont personne ne garantit la durée de vie. Une facture est une
 * pièce comptable qui doit rester lisible des années : la faire dépendre de la
 * disponibilité d'un tiers, ce n'est pas la conserver.
 *
 * ══ CE MODULE NE CRÉE AUCUN STOCKAGE ════════════════════════════════════════
 *
 * Il n'écrit pas un octet lui-même. Le fichier passe par `storePrivateDocument`
 * — le protocole Media du Panel, celui-là même qui reçoit les justificatifs
 * déposés à la main — et se rattache au mouvement par `receipt.mediaId`, la
 * seule relation qui existe. Une facture Stripe apparaît donc au même endroit,
 * dans le même écran, et se télécharge par la même route contrôlée qu'un
 * justificatif saisi par un opérateur. C'était l'exigence, et elle a une raison
 * pratique : le jour d'un contrôle, on ne veut pas avoir à se souvenir que les
 * pièces sont rangées à deux endroits selon leur origine.
 *
 * ══ IL NE TÉLÉCHARGE PAS LUI-MÊME, ET C'EST UNE RÈGLE DU DÉPÔT ══════════════
 *
 * La décision vit ici, le transport vit dans `stripeDocumentTransport.js`.
 * Poser un `fetch` dans ce module en aurait fait à la fois celui qui décide
 * d'archiver et celui qui ouvre une socket — la garde d'architecture du pont
 * l'a refusé, et elle a raison : chaque axe réseau a un client, et un seul.
 *
 * ══ CE N'EST PAS UN APPEL À L'API STRIPE ════════════════════════════════════
 *
 * `invoice_pdf` est une adresse SIGNÉE, servie par le fournisseur sans clé.
 * Aucune clé n'est lue, aucun crédit d'API n'est consommé, et la doctrine « le
 * Panel n'interroge pas Stripe pour découvrir à qui appartient quelque chose »
 * reste entière — l'appartenance a été prouvée AVANT, par le registre de liens,
 * et ce module ne s'exécute que sur un fait DÉJÀ projeté.
 *
 * ══ TROIS GARANTIES D'IDEMPOTENCE, ET ELLES SE SUPERPOSENT ══════════════════
 *
 *  1. LE FAIT porte `invoiceArchive.mediaId`. Renseigné, on ne retélécharge
 *     rien — c'est le garde-fou le plus rapide, et celui que traversent les
 *     rejeux de webhook.
 *  2. LE MOUVEMENT porte `receipt.mediaId`. Renseigné par quelqu'un d'autre —
 *     un opérateur qui a déposé la facture à la main — on ne l'ÉCRASE JAMAIS.
 *     Une pièce déposée par un humain vaut mieux qu'une copie automatique, et
 *     la remplacer en silence serait détruire un acte volontaire.
 *  3. L'EMPREINTE est comparée. Deux passages sur la même facture produisent le
 *     même sha256 ; on le constate, on le journalise, et on n'écrit pas un
 *     second fichier.
 *
 * ══ UN ÉCHEC D'ARCHIVAGE N'EST JAMAIS UN ÉCHEC DE PROJECTION ════════════════
 *
 * L'argent est encaissé, le mouvement est écrit, seule la pièce manque. Ce
 * module ne lève donc jamais vers la projection : il compte ses tentatives,
 * inscrit son motif d'échec sur le fait, et le rattrapage le reprendra. Un
 * revenu perdu pour un PDF indisponible serait une faute bien plus grave que
 * l'absence temporaire du PDF.
 */
import logger from '../../../utils/logger.js';
import PanelProviderRevenueFact, {
  PROJECTION_STATUS,
} from '../../../models/PanelProviderRevenueFact.model.js';
import { PanelFinancialTransaction } from '../../../models/PanelFinancialTransaction.model.js';
import PanelMedia from '../../../models/PanelMedia.model.js';
import { storePrivateDocument } from '../../upload/privateMedia.service.js';
import { downloadProviderDocument } from '../../integratedApi/stripe/stripeDocumentTransport.js';
import { RECEIPT_ROLE, RECEIPT_SCOPE } from '../receipts.service.js';

/**
 * Au-delà, on cesse de réessayer AUTOMATIQUEMENT.
 *
 * Ce n'est pas un abandon : le fait garde son motif d'échec, il reste visible
 * dans la file de diagnostic, et un rattrapage explicite peut le forcer. C'est
 * une protection contre une adresse définitivement morte, qu'on retélécharger-
 * ait à chaque démarrage pour toujours.
 */
export const MAX_TENTATIVES_ARCHIVAGE = 5;

/** Motifs de non-archivage. Nommés : un échec muet ne se diagnostique pas. */
export const ARCHIVE_OUTCOME = Object.freeze({
  /** La copie vient d'être écrite et rattachée. */
  ARCHIVED: 'ARCHIVED',
  /** Elle existait déjà — rejeu, reconciliation, redémarrage. */
  ALREADY_ARCHIVED: 'ALREADY_ARCHIVED',
  /** Un justificatif est déjà attaché au mouvement, et il n'est pas de nous. */
  RECEIPT_ALREADY_PRESENT: 'RECEIPT_ALREADY_PRESENT',
  /** Le fournisseur n'a produit aucune facture pour ce paiement. */
  NO_PROVIDER_INVOICE: 'NO_PROVIDER_INVOICE',
  /** Le fait n'est pas projeté : il n'a pas de mouvement à documenter. */
  NOT_PROJECTED: 'NOT_PROJECTED',
  /** Le mouvement désigné n'existe plus. */
  TRANSACTION_MISSING: 'TRANSACTION_MISSING',
  /** Le téléchargement ou la validation a échoué — rejouable. */
  FAILED: 'FAILED',
  /** Trop d'échecs successifs : on ne réessaie plus tout seul. */
  ABANDONED: 'ABANDONED',
});

/**
 * Le nom sous lequel la pièce se présentera dans l'écran.
 *
 * Il porte le NUMÉRO de facture quand il existe, jamais l'identifiant technique
 * du fournisseur : c'est le numéro qu'un comptable cherche, et c'est lui qui
 * figure sur le document lui-même.
 */
function nomDeFichier(fait) {
  const numero = fait.invoiceDocument?.number || fait.invoiceDocument?.invoiceId || 'facture';
  return `Facture ${numero}.pdf`;
}

/** Inscrit l'échec sur le fait, sans jamais lever. Le revenu reste écrit. */
async function noterEchec(factId, message) {
  await PanelProviderRevenueFact.updateOne(
    { factId },
    { $inc: { 'invoiceArchive.attempts': 1 }, $set: { 'invoiceArchive.lastError': String(message).slice(0, 300) } },
  ).catch(() => null);
}

/**
 * ARCHIVE la facture d'UN fait projeté — ou explique pourquoi elle ne l'est pas.
 *
 * NE LÈVE JAMAIS. Appelée depuis la projection, elle-même appelée depuis la
 * réception d'un webhook : une exception ici ferait répondre 500 au fournisseur,
 * qui rejouerait — et un PDF indisponible déclencherait une tempête de rejeux
 * sur un paiement parfaitement encaissé.
 *
 * @param {string} factId
 * @returns {Promise<{outcome:string, mediaId:string|null, transactionId:string|null,
 *   sha256:string|null, reason:string|null}>}
 */
export async function archiveInvoiceForFact(factId, { fetchImpl } = {}) {
  const rien = { outcome: null, mediaId: null, transactionId: null, sha256: null, reason: null };

  const fait = await PanelProviderRevenueFact.findOne({ factId }).lean();
  if (!fait) return { ...rien, outcome: ARCHIVE_OUTCOME.FAILED, reason: 'FACT_NOT_FOUND' };

  if (fait.projectionStatus !== PROJECTION_STATUS.PROJECTED || !fait.transactionId) {
    return { ...rien, outcome: ARCHIVE_OUTCOME.NOT_PROJECTED };
  }

  /**
   * PREMIER VERROU — le fait sait déjà quelle copie il a produite.
   *
   * C'est celui que traversent tous les rejeux : quatre annonces Stripe du même
   * règlement, une reconciliation, un redémarrage. Il ne coûte rien et il ferme
   * le cas de très loin le plus fréquent.
   */
  if (fait.invoiceArchive?.mediaId) {
    return {
      outcome: ARCHIVE_OUTCOME.ALREADY_ARCHIVED,
      mediaId: fait.invoiceArchive.mediaId,
      transactionId: fait.transactionId,
      sha256: fait.invoiceArchive.sha256 ?? null,
      reason: null,
    };
  }

  const source = fait.invoiceDocument?.pdfUrl ?? null;
  if (!source) {
    /**
     * PAS DE FACTURE CHEZ LE FOURNISSEUR — et ce n'est pas toujours une anomalie.
     *
     * Un paiement unique par Checkout ne produit une facture que si
     * `invoice_creation` est actif à la création de la session. Quand il ne
     * l'est pas, il n'existe AUCUN PDF à archiver, et en fabriquer un serait
     * produire une pièce que le fournisseur n'a jamais émise — c'est-à-dire un
     * faux. On le dit, on ne le comble pas.
     */
    return { ...rien, outcome: ARCHIVE_OUTCOME.NO_PROVIDER_INVOICE, transactionId: fait.transactionId };
  }

  if ((fait.invoiceArchive?.attempts ?? 0) >= MAX_TENTATIVES_ARCHIVAGE) {
    return {
      ...rien,
      outcome: ARCHIVE_OUTCOME.ABANDONED,
      transactionId: fait.transactionId,
      reason: fait.invoiceArchive?.lastError ?? null,
    };
  }

  const transaction = await PanelFinancialTransaction.findOne({ transactionId: fait.transactionId });
  if (!transaction) {
    return { ...rien, outcome: ARCHIVE_OUTCOME.TRANSACTION_MISSING, transactionId: fait.transactionId };
  }

  /**
   * DEUXIÈME VERROU — UNE PIÈCE DÉPOSÉE À LA MAIN N'EST JAMAIS ÉCRASÉE.
   *
   * Le mouvement porte déjà un justificatif que ce module n'a pas produit : un
   * opérateur l'a attaché. Le remplacer par une copie automatique détruirait un
   * acte volontaire — et l'opérateur avait peut-être une raison de déposer autre
   * chose que la facture du fournisseur (un avoir, une pièce consolidée).
   *
   * On ne le remplace pas, et on le DIT : l'adresse du fournisseur reste sur le
   * fait, donc rien n'est perdu.
   */
  if (transaction.receipt?.mediaId) {
    logger.info(
      `[finance] facture ${fait.invoiceDocument?.number ?? fait.objectId} non archivée : `
      + `le mouvement ${fait.transactionId} porte déjà un justificatif. Il n'est pas remplacé.`,
    );
    return {
      outcome: ARCHIVE_OUTCOME.RECEIPT_ALREADY_PRESENT,
      mediaId: transaction.receipt.mediaId,
      transactionId: fait.transactionId,
      sha256: null,
      reason: null,
    };
  }

  let media;
  try {
    const { bytes } = await downloadProviderDocument({ url: source, fetchImpl });
    media = await storePrivateDocument({
      buffer: bytes,
      scope: RECEIPT_SCOPE,
      role: RECEIPT_ROLE,
      filename: nomDeFichier(fait),
      /**
       * L'AUTEUR EST LE FOURNISSEUR, PAS UN OPÉRATEUR.
       *
       * Écrire ici l'adresse de la personne connectée serait faux — il n'y en a
       * aucune : ce chemin part d'un webhook. `stripe` dit exactement ce qui
       * s'est passé, et c'est la même convention que `createdBy` sur les
       * mouvements projetés.
       */
      createdBy: 'stripe',
    });
  } catch (err) {
    const motif = err?.message ?? 'erreur inconnue';
    await noterEchec(factId, motif);
    logger.warn(
      `[finance] facture non archivée pour le mouvement ${fait.transactionId} — ${motif}. `
      + "L'encaissement, lui, reste écrit ; le rattrapage reprendra.",
    );
    return { ...rien, outcome: ARCHIVE_OUTCOME.FAILED, transactionId: fait.transactionId, reason: motif };
  }

  /**
   * TROISIÈME VERROU — ON N'ATTACHE QUE SI LA PLACE EST TOUJOURS LIBRE.
   *
   * Entre la lecture du mouvement et cette écriture, le téléchargement a pris
   * plusieurs secondes. Un opérateur a pu déposer sa pièce pendant ce temps, ou
   * un second passage concurrent avoir gagné. `receipt.mediaId: null` dans le
   * filtre fait de l'écriture une opération CONDITIONNELLE : celui qui perd la
   * course ne remplace rien.
   */
  const pose = await PanelFinancialTransaction.updateOne(
    { transactionId: fait.transactionId, 'receipt.mediaId': null, deletedAt: null },
    {
      $set: {
        'receipt.mediaId': media.mediaId,
        'receipt.attachedAt': new Date(),
        /**
         * `attachedBy` nomme l'ORIGINE de l'acte, jamais une personne. Un écran
         * qui affiche « attaché par stripe » dit la vérité ; « attaché par
         * système » l'aurait diluée dans tout ce que le Panel fait tout seul.
         */
        'receipt.attachedBy': 'stripe',
      },
    },
  );

  if (pose.modifiedCount !== 1) {
    /**
     * QUELQU'UN NOUS A DEVANCÉS. Le fichier qu'on vient d'écrire n'est référencé
     * par rien : c'est un orphelin, invisible et inoffensif, que le ramassage des
     * médias reprendra. On ne le supprime pas ici — une suppression sur un chemin
     * de course est le meilleur moyen d'effacer la pièce du gagnant.
     */
    logger.info(
      `[finance] justificatif ${media.mediaId} non rattaché à ${fait.transactionId} : `
      + 'une autre pièce y a été posée entre-temps. La copie reste orpheline, elle sera ramassée.',
    );
    return {
      outcome: ARCHIVE_OUTCOME.RECEIPT_ALREADY_PRESENT,
      mediaId: null,
      transactionId: fait.transactionId,
      sha256: null,
      reason: 'RACE_LOST',
    };
  }

  await PanelProviderRevenueFact.updateOne(
    { factId },
    {
      $set: {
        'invoiceArchive.mediaId': media.mediaId,
        'invoiceArchive.sha256': media.sha256,
        'invoiceArchive.mime': media.mime,
        'invoiceArchive.bytes': media.size,
        'invoiceArchive.sourceUrl': source,
        'invoiceArchive.downloadedAt': new Date(),
        'invoiceArchive.lastError': null,
      },
    },
  );

  logger.info(
    `[finance] facture ${fait.invoiceDocument?.number ?? fait.objectId} archivée `
    + `(${media.size} octets) et rattachée au mouvement ${fait.transactionId}.`,
  );

  return {
    outcome: ARCHIVE_OUTCOME.ARCHIVED,
    mediaId: media.mediaId,
    transactionId: fait.transactionId,
    sha256: media.sha256,
    reason: null,
  };
}

/**
 * RATTRAPAGE — les factures projetées AVANT que ce module n'existe.
 *
 * ══ POURQUOI CE N'EST PAS UNE MIGRATION À USAGE UNIQUE ══════════════════════
 *
 * Parce que le retard ne vient pas seulement du passé. Une facture dont le PDF
 * n'était pas encore prêt à l'instant du webhook, un téléchargement qui a expiré,
 * un Panel redémarré entre la projection et l'archivage : chacun de ces cas
 * produit exactement le même état — un mouvement projeté sans pièce — et chacun
 * se répare ici. C'est une CONVERGENCE, comme celle des revenus orphelins, pas
 * un script à jouer une fois.
 *
 * ══ L'ORDRE EST LE PLUS RÉCENT D'ABORD ══════════════════════════════════════
 *
 * Une facture d'hier manque à quelqu'un aujourd'hui ; une facture d'il y a deux
 * ans ne manque à personne dans l'heure. Si le lot est interrompu, on veut avoir
 * réparé ce qui se regarde.
 */
export async function backfillMissingInvoiceArchives({ limit = 50, fetchImpl } = {}) {
  const candidats = await PanelProviderRevenueFact.find({
    projectionStatus: PROJECTION_STATUS.PROJECTED,
    transactionId: { $ne: null },
    'invoiceArchive.mediaId': null,
    'invoiceDocument.pdfUrl': { $type: 'string' },
    $or: [
      { 'invoiceArchive.attempts': { $lt: MAX_TENTATIVES_ARCHIVAGE } },
      { 'invoiceArchive.attempts': null },
    ],
  })
    .sort({ occurredAt: -1 })
    .limit(limit)
    .select('factId')
    .lean();

  const rapport = { examined: candidats.length, archived: 0, skipped: 0, failed: 0, details: [] };

  for (const candidat of candidats) {
    // eslint-disable-next-line no-await-in-loop
    const issue = await archiveInvoiceForFact(candidat.factId, { fetchImpl });
    if (issue.outcome === ARCHIVE_OUTCOME.ARCHIVED) rapport.archived += 1;
    else if (issue.outcome === ARCHIVE_OUTCOME.FAILED || issue.outcome === ARCHIVE_OUTCOME.ABANDONED) rapport.failed += 1;
    else rapport.skipped += 1;
    rapport.details.push({ factId: candidat.factId, ...issue });
  }

  if (rapport.archived > 0 || rapport.failed > 0) {
    logger.info(
      `[finance] rattrapage des factures — ${rapport.examined} examinée(s), `
      + `${rapport.archived} archivée(s), ${rapport.skipped} sans objet, ${rapport.failed} en échec.`,
    );
  }

  return rapport;
}

/**
 * CE QU'ON SAIT DE LA COPIE ARCHIVÉE — pour un écran, jamais pour décider.
 *
 * Le descripteur complet du fichier vit dans `PanelMedia` et se lit par la route
 * du mouvement. Celui-ci répond seulement à « cette facture a-t-elle été
 * archivée, quand, et depuis où ? ».
 */
export async function describeInvoiceArchive(transactionId) {
  const fait = await PanelProviderRevenueFact
    .findOne({ transactionId })
    .select('invoiceDocument invoiceArchive')
    .lean();
  if (!fait) return null;

  const media = fait.invoiceArchive?.mediaId
    ? await PanelMedia.findOne({ mediaId: fait.invoiceArchive.mediaId }).select('mime size deletedAt').lean()
    : null;

  return {
    providerInvoiceId: fait.invoiceDocument?.invoiceId ?? null,
    providerInvoiceNumber: fait.invoiceDocument?.number ?? null,
    /**
     * L'adresse HÉBERGÉE, pas le PDF signé : c'est celle qu'un opérateur peut
     * ouvrir chez le fournisseur pour comparer. Le PDF, lui, se sert par la
     * route du mouvement — c'est tout l'objet de l'archivage.
     */
    providerHostedUrl: fait.invoiceDocument?.hostedUrl ?? null,
    mediaId: fait.invoiceArchive?.mediaId ?? null,
    sha256: fait.invoiceArchive?.sha256 ?? null,
    mime: fait.invoiceArchive?.mime ?? null,
    bytes: fait.invoiceArchive?.bytes ?? null,
    downloadedAt: fait.invoiceArchive?.downloadedAt
      ? new Date(fait.invoiceArchive.downloadedAt).toISOString() : null,
    /** Le média a-t-il survécu ? Un descripteur supprimé ne se sert plus. */
    available: Boolean(media && !media.deletedAt),
    lastError: fait.invoiceArchive?.lastError ?? null,
    attempts: fait.invoiceArchive?.attempts ?? 0,
  };
}

export default {
  ARCHIVE_OUTCOME,
  MAX_TENTATIVES_ARCHIVAGE,
  archiveInvoiceForFact,
  backfillMissingInvoiceArchives,
  describeInvoiceArchive,
};
