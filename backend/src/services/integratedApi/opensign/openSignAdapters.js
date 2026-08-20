// ADAPTATEURS OPENSIGN — les actes métier de la signature, servis par OpenSign.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md.
//
// ══ MÊME CONTRAT, MOINS D'APPELS ════════════════════════════════════════════
//
// Les cinq capacités `signature.*` ne changent pas de nom, pas de forme, pas de
// sens. Ce qui change est ce qu'il faut faire pour les tenir :
//
//   ouvrir     Yousign : 5 appels + un nettoyage de brouillon
//              OpenSign : 1 appel
//   lire       Yousign : GET demande            OpenSign : GET document
//   liens      Yousign : GET signataire         OpenSign : GET signinglinks
//   télécharger Yousign : GET binaire           OpenSign : GET document → URL pré-signée → GET
//   annuler    Yousign : POST cancel (motif énuméré)  OpenSign : POST document (motif libre)
//
// ══ CE QUI N'EST PAS RECOPIÉ DE L'ADAPTATEUR YOUSIGN ════════════════════════
//
// Le nettoyage tout-ou-rien du brouillon. Il n'a plus d'objet : il n'existe
// aucun état intermédiaire à nettoyer, puisqu'un seul appel crée tout. Le
// reproduire aurait été du mimétisme — et un `DELETE` inutile sur une ressource
// qui, en cas d'échec, n'a jamais été créée.
//
// ══ L'ORDRE, LUI, EST LE MÊME, ET IL N'EST PAS NÉGOCIABLE ═══════════════════
//
//   1. appartenance      (avant le coffre — un refus ne déchiffre rien)
//   2. exécution         (transport)
//   3. traduction        (erreurs typées → vocabulaire de passerelle)
//
// `credentials` entre ici et n'en ressort pas.
import { createHash } from 'node:crypto';

import logger from '../../../utils/logger.js';
import {
  OpenSignTransportError,
  TRANSPORT_CODES,
  OUTCOMES as TRANSPORT_OUTCOMES,
  createDocument,
  getDocument,
  getSigningLinks,
  revokeDocument,
  fetchProviderFile,
} from './openSignTransport.js';
import {
  SIGNATURE_OWNERSHIP_CODES,
  claimSignatureRequest,
  attachResource,
  releaseClaim,
  closeBinding,
  describeOwnership,
  maskResourceId,
} from '../signature/signatureOwnership.js';
import { checkDocumentSize } from '../signature/signatureDocumentLimits.js';
import {
  SIGNATURE_REQUEST_STATE,
  SIGNER_STATE,
  toRequestState,
  signerStateFromAuditTrace,
} from '../signature/signatureVocabulary.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
} from '../../capabilities/capabilityErrors.js';

export const PROVIDER = 'OPENSIGN';

/* -------------------------------------------------------------------------- */
/*  L'IDENTITÉ D'UN SIGNATAIRE                                                */
/* -------------------------------------------------------------------------- */

/**
 * LA POIGNÉE D'UN SIGNATAIRE — opaque, stable, et SANS DONNÉE PERSONNELLE.
 *
 * ══ LE PROBLÈME ════════════════════════════════════════════════════════════
 *
 * Le contrat de capacité rend un `signerId` que le projet conserve, renvoie, et
 * compare pour savoir QUI a signé. Yousign en fournissait un. OpenSign n'en a
 * pas : chez lui, un signataire est désigné par SON ADRESSE.
 *
 * ══ POURQUOI PAS L'ADRESSE, TOUT SIMPLEMENT ════════════════════════════════
 *
 * Parce qu'elle traverserait le pont, entrerait dans le journal durable, dans
 * les projections du projet, dans ses traces — et que le lot Yousign avait
 * explicitement choisi de ne faire voyager qu'une référence OPAQUE. Une adresse
 * est une donnée personnelle ; un identifiant de corrélation ne doit pas en
 * être une. (Et `a@b.co` ferait en prime échouer la borne de 8 caractères du
 * schéma.)
 *
 * ══ POURQUOI DÉRIVÉE, ET NON TIRÉE AU SORT NI PERSISTÉE ════════════════════
 *
 * Une poignée aléatoire devrait être stockée, donc maintenue, donc
 * resynchronisée — un état de plus à faire diverger. Dérivée, elle se
 * RECALCULE : il suffit de relire les signataires du document pour retrouver
 * celui qui correspond. Aucune table, aucune migration, aucune dérive possible.
 *
 * Le document entre dans le calcul : la même adresse sur deux contrats donne
 * deux poignées. Un identifiant appris sur un contrat ne désigne donc rien sur
 * un autre.
 */
export function signerHandle(documentId, email) {
  return createHash('sha256')
    .update(`opensign:${documentId}:${String(email ?? '').trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/*  TRADUCTION DES REFUS                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Refus d'entrée qu'on sait NOMMER.
 *
 * La liste est courte, et c'est un fait mesuré : OpenSign rend une phrase
 * unique — « Something went wrong, please try again later! » — pour presque
 * toutes les causes d'entrée, et ne nomme JAMAIS le champ fautif. Là où Yousign
 * rendait `invalid_params`, il n'y a ici rien à extraire.
 *
 * Deux refus font exception parce qu'ils sont explicites, et ce sont justement
 * les deux qui appellent une action précise de l'exploitant.
 */
export const OPENSIGN_INPUT_REFUSAL = Object.freeze({
  DOCUMENT_TOO_LARGE: 'SIGNATURE_DOCUMENT_TOO_LARGE_FOR_PROVIDER',
  CREDITS_EXHAUSTED: 'SIGNATURE_PROVIDER_CREDITS_EXHAUSTED',
});

/** Reconnaît un refus explicite dans la phrase du fournisseur. */
export function recogniseInputRefusal(providerError) {
  const m = String(providerError ?? '').toLowerCase();
  if (!m) return null;
  if (m.includes('file too large') || (m.includes('file') && m.includes('size'))) {
    return OPENSIGN_INPUT_REFUSAL.DOCUMENT_TOO_LARGE;
  }
  if (m.includes('credit')) return OPENSIGN_INPUT_REFUSAL.CREDITS_EXHAUSTED;
  return null;
}

export function translateTransportError(error, capability) {
  if (!(error instanceof OpenSignTransportError)) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `L’exécution de « ${capability.code} » a échoué chez le fournisseur.`,
    );
  }

  const indecidable = error.outcome === TRANSPORT_OUTCOMES.UNKNOWN
    || error.code === TRANSPORT_CODES.TIMEOUT
    || error.code === TRANSPORT_CODES.UNREACHABLE
    || error.code === TRANSPORT_CODES.MALFORMED_RESPONSE;

  if (indecidable) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Le fournisseur n’a pas confirmé « ${capability.code} » : l’issue est indéterminée, `
      + 'et l’acte ne doit pas être rejoué automatiquement.',
      { httpStatus: error.httpStatus ?? null, replaySafe: false },
    );
  }

  if (error.code === TRANSPORT_CODES.MISSING_CREDENTIALS) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING,
      `Identifiants incomplets pour ${capability.provider}.`,
    );
  }

  /**
   * LES CRÉDITS ÉPUISÉS NE SONT PAS UNE ERREUR D'ENTRÉE.
   *
   * C'est une panne de COMPTE : le payload est parfait, et aucune correction
   * du contrat n'y changera rien. Les confondre enverrait l'exploitant relire
   * ses zones de signature pendant que la vraie action — recharger des
   * crédits — attend.
   */
  if (error.code === TRANSPORT_CODES.QUOTA_EXHAUSTED) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      'Le compte de signature de la plateforme n’a plus de crédits : aucune demande '
      + 'ne peut être ouverte tant qu’il n’est pas rechargé.',
      { reason: OPENSIGN_INPUT_REFUSAL.CREDITS_EXHAUSTED, httpStatus: error.httpStatus ?? null },
    );
  }

  if (error.code === TRANSPORT_CODES.INPUT_INVALID) {
    const motif = recogniseInputRefusal(error.providerError);
    if (motif) logger.warn(`[opensign] ${capability.code} refusée — ${motif}.`);
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      motif === OPENSIGN_INPUT_REFUSAL.DOCUMENT_TOO_LARGE
        ? 'Le fournisseur a refusé le document : il dépasse la taille qu’il accepte.'
        : `Entrée refusée par « ${capability.code} ».`,
      {
        httpStatus: error.httpStatus ?? null,
        ...(motif ? { reason: motif } : {}),
      },
    );
  }

  if (error.code === TRANSPORT_CODES.NOT_FOUND) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      'Le fournisseur ne connaît plus cette demande de signature.',
      { httpStatus: error.httpStatus ?? null },
    );
  }

  return new CapabilityError(
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    `Le fournisseur a refusé « ${capability.code} ».`,
    { httpStatus: error.httpStatus ?? null },
  );
}

/**
 * Refus d'appartenance — INDISCERNABLE d'une ressource inconnue.
 *
 * Le journal distingue « inconnue » de « à un autre » ; le message rendu, non.
 * Sinon la capacité devient un oracle d'existence, où l'on apprend qu'un
 * identifiant appartient à quelqu'un en observant le refus changer de forme.
 */
function ownershipRefusal(capability, verdict, resourceId) {
  logger.warn(
    `[opensign] ${capability.code} refusée — ${verdict.code} (${maskResourceId(resourceId)}).`,
  );
  return new CapabilityError(
    CAPABILITY_ERROR_CODES.RESOURCE_NOT_OWNED,
    'Demande de signature inconnue pour ce projet.',
    { reason: SIGNATURE_OWNERSHIP_CODES.UNKNOWN_RESOURCE },
  );
}

async function requireOwned({ context, definition, resourceId }) {
  const verdict = await describeOwnership({
    projectId: context.projectId,
    environment: context.environment,
    resourceId,
  });
  if (!verdict.owned) throw ownershipRefusal(definition, verdict, resourceId);
  return verdict.binding;
}

/* -------------------------------------------------------------------------- */
/*  OUVRIR UNE SIGNATURE                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Construit la charge utile `createdocument` — fonction PURE, donc inspectable
 * en test sans réseau ni credential. C'est le payload exact envoyé à OpenSign.
 *
 * ── LES RÉGLAGES, ET POURQUOI CHACUN EST CELUI-LÀ ──────────────────────────
 *
 * `send_email: false` — Yousign était appelé en `delivery_mode: 'none'` : c'est
 *   le PROJET qui présente les liens, jamais le fournisseur qui écrit aux
 *   signataires. Mettre `true` ferait partir des e-mails que personne n'attend,
 *   depuis une adresse qui n'est pas celle de la plateforme, et changerait le
 *   parcours sous prétexte de changer de fournisseur.
 *
 * `sendInOrder` + `send_in_order_strict` — l'ordre DEV puis CLIENT est une
 *   règle métier. `sendInOrder` seul n'échelonne que des e-mails qu'on
 *   n'envoie pas ; c'est `strict` qui fait respecter l'ordre par le serveur.
 *   Mesuré au lot 1 : le second signataire peut LIRE avant son tour, il ne peut
 *   pas signer.
 *
 * `enableOTP: false` — l'équivalent exact de
 *   `signature_authentication_mode: 'no_otp'`. Le lien fait foi.
 *
 * `merge_certificate: false` — le certificat reste un document SÉPARÉ. Le
 *   fusionner rendrait impossible de distinguer le contrat signé de sa preuve
 *   d'audit, et la fusion est irréversible.
 */
export function buildCreateDocumentPayload(input) {
  const parRole = new Map();
  for (const field of input.fields ?? []) {
    if (!parRole.has(field.signerRole)) parRole.set(field.signerRole, []);
    parRole.get(field.signerRole).push({
      type: 'signature',
      page: field.page,
      /**
       * DES POINTS PDF, DEPUIS LE COIN SUPÉRIEUR GAUCHE.
       *
       * Prouvé au lot 1 par quatre chemins concordants, jusqu'à la matrice du
       * PDF signé (`1 0 0 1 45 707 cm`, écart nul). Aucune conversion ici :
       * l'appelant fournit déjà des points, et en ajouter une serait inventer
       * une échelle que le fournisseur n'applique pas.
       */
      x: field.x,
      y: field.y,
      w: field.width,
      h: field.height,
    });
  }

  const signers = (input.signers ?? []).map((signer) => ({
    /** `role` est un LIBELLÉ LIBRE chez OpenSign : nos rôles métier y tiennent. */
    role: signer.role,
    email: signer.email,
    name: `${signer.firstName} ${signer.lastName}`.trim(),
    signer_role: 'signer',
    widgets: parRole.get(signer.role) ?? [],
  }));

  /**
   * UNE SEULE URL DE RETOUR, POUR TOUT LE DOCUMENT.
   *
   * Yousign en acceptait trois PAR SIGNATAIRE (succès, erreur, refus). OpenSign
   * n'en accepte qu'une, et n'y ajoute aucun paramètre — mesuré au lot 1.
   *
   * On prend donc `returnUrl` quand l'appelant la fournit (la forme cible), et
   * à défaut l'URL de succès du CLIENT : c'est le signataire externe, celui
   * pour qui atterrir quelque part de sensé compte vraiment. Le développeur,
   * lui, sait revenir.
   *
   * L'ISSUE ne se lit jamais dans cette URL : elle se lit dans l'état du
   * contrat. C'était déjà la règle des pages de retour de SB Auto, et elle
   * devient ici une nécessité plutôt qu'une prudence.
   */
  const retour = input.returnUrl
    ?? (input.signers ?? []).find((s) => s.role === 'CLIENT')?.redirectUrls?.success
    ?? null;

  return {
    file: input.documentBase64,
    title: input.name,
    signers,
    send_email: false,
    sendInOrder: true,
    send_in_order_strict: true,
    enableOTP: false,
    enableTour: false,
    merge_certificate: false,
    ...(retour ? { redirect_url: retour } : {}),
  };
}

/**
 * `signature.request.open` — un acte, un appel.
 *
 * La réservation du contrat précède TOUT contact fournisseur : c'est elle, et
 * non le fournisseur, qui garantit qu'un second clic n'ouvre pas une seconde
 * demande. OpenSign n'offre aucune clé d'idempotence — et chaque création
 * débite un crédit.
 */
async function signatureRequestOpen({ definition, context, credentials, input, fetchImpl }) {
  const timeoutMs = definition.timeoutMs;
  const commun = { credentials, timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) };

  /**
   * LA TAILLE, VÉRIFIÉE AVANT TOUTE RÉSERVATION.
   *
   * La borne appliquée est celle du FOURNISSEUR RETENU (10 Mo chez OpenSign),
   * pas une valeur historique. Laisser passer un document que le fournisseur
   * refusera déterministe­ment coûterait une réservation à libérer, un contrat
   * verrouillé, et un message qui parlerait du fournisseur au lieu de parler du
   * PDF.
   */
  const taille = checkDocumentSize(input.documentBase64, { provider: PROVIDER });
  if (!taille.ok) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      taille.message,
      { reason: taille.code, byteLength: taille.byteLength },
    );
  }

  const claim = await claimSignatureRequest({
    projectId: context.projectId,
    environment: context.environment,
    contractRef: input.contractRef,
    operationId: input.operationId,
    provider: PROVIDER,
  });

  if (!claim.claimed) {
    const existant = claim.binding;
    return {
      status: 'ALREADY_OPEN',
      provider: existant?.provider ?? PROVIDER,
      signatureRequestId: existant?.resourceId?.startsWith('pending:') ? null : existant?.resourceId ?? null,
      documentId: existant?.documentId ?? null,
      contractRef: input.contractRef,
      signers: [],
    };
  }

  try {
    const reponse = await createDocument({ ...commun, document: buildCreateDocumentPayload(input) });
    const documentId = String(reponse?.objectId ?? '').trim();
    if (!documentId) {
      throw new OpenSignTransportError(
        TRANSPORT_CODES.MALFORMED_RESPONSE,
        'OpenSign a répondu sans identifiant de document.',
        { outcome: TRANSPORT_OUTCOMES.UNKNOWN },
      );
    }

    const lienParAdresse = new Map(
      (reponse.signurl ?? []).map((s) => [String(s.email ?? '').trim().toLowerCase(), s.url]),
    );

    /**
     * LE DOCUMENT EST SA PROPRE RESSOURCE.
     *
     * Chez Yousign, une demande contenait des documents, et il fallait retenir
     * lequel télécharger — d'où un `documentId` distinct, que l'appelant ne
     * devait jamais pouvoir nommer. Chez OpenSign, la demande EST le document :
     * on renseigne les deux à la même valeur plutôt que d'inventer une
     * distinction, et le contrat de capacité ne bouge pas.
     */
    await attachResource({ operationId: input.operationId, resourceId: documentId, documentId });

    return {
      status: 'OPENED',
      provider: PROVIDER,
      signatureRequestId: documentId,
      documentId,
      contractRef: input.contractRef,
      signers: (input.signers ?? []).map((signer) => ({
        role: signer.role,
        signerId: signerHandle(documentId, signer.email),
        signatureLink: lienParAdresse.get(String(signer.email).trim().toLowerCase()) ?? null,
      })),
    };
  } catch (error) {
    const traduite = error instanceof CapabilityError ? error : translateTransportError(error, definition);

    /**
     * ON NE LIBÈRE QUE SUR UNE ISSUE CERTAINE.
     *
     * Sur un délai dépassé, le document a PEUT-ÊTRE été créé — et un crédit
     * peut-être débité. Libérer autoriserait une seconde ouverture, c'est-à-dire
     * le doublon qu'on évite. Le contrat reste verrouillé, et un humain
     * tranche. C'est le même arbitrage que chez Yousign, pour la même raison.
     *
     * ── ET IL N'Y A RIEN À NETTOYER ───────────────────────────────────────
     *
     * L'adaptateur Yousign supprimait ici son brouillon. Aucun brouillon
     * n'existe : soit l'appel unique a abouti et le document est complet, soit
     * il a échoué et rien n'a été créé. Ajouter un `DELETE` « par symétrie »
     * viserait une ressource dont on vient d'établir qu'elle n'existe pas.
     */
    const certain = traduite.code !== CAPABILITY_ERROR_CODES.TIMEOUT;
    if (certain) await releaseClaim({ operationId: input.operationId });

    throw traduite;
  }
}

/* -------------------------------------------------------------------------- */
/*  LECTURES                                                                  */
/* -------------------------------------------------------------------------- */

/** La piste d'audit, indexée par adresse normalisée. */
function auditParAdresse(document) {
  return new Map(
    (document?.audit_trail ?? []).map((t) => [String(t.email ?? '').trim().toLowerCase(), t]),
  );
}

/** `signature.request.retrieve` — l'état d'une demande possédée. */
async function signatureRequestRetrieve({ definition, context, credentials, input, fetchImpl }) {
  await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  const brut = await getDocument({
    credentials,
    documentId: input.signatureRequestId,
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const audit = auditParAdresse(brut);

  /**
   * DTO MINIMAL, et TRADUIT.
   *
   * `state` est le vocabulaire des projets ; `status` reste la chaîne brute du
   * fournisseur, pour le forensic et pour la coexistence — SB Auto la traduit
   * encore aujourd'hui, et cessera de le faire au lot de bascule.
   */
  return {
    signatureRequestId: input.signatureRequestId,
    provider: PROVIDER,
    state: toRequestState(PROVIDER, brut?.status),
    status: brut?.status ?? null,
    signers: (brut?.signers ?? []).map((s) => {
      const trace = audit.get(String(s.email ?? '').trim().toLowerCase());
      return {
        signerId: signerHandle(input.signatureRequestId, s.email),
        role: s.role ?? null,
        state: signerStateFromAuditTrace(trace),
        status: trace?.signed ? 'signed' : trace?.viewed ? 'viewed' : null,
      };
    }),
  };
}

/**
 * `signature.signer.retrieve` — le lien de signature d'un signataire.
 *
 * La poignée est RECALCULÉE pour chaque signataire du document, puis comparée.
 * C'est ce qui évite de persister une table de correspondance — donc de la
 * maintenir, de la migrer, et de la voir diverger.
 */
async function signatureSignerRetrieve({ definition, context, credentials, input, fetchImpl }) {
  await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  const commun = {
    credentials, timeoutMs: definition.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}),
  };

  const document = await getDocument({ ...commun, documentId: input.signatureRequestId });
  const cible = (document?.signers ?? []).find(
    (s) => signerHandle(input.signatureRequestId, s.email) === input.signerId,
  );
  if (!cible) {
    /**
     * SIGNATAIRE INCONNU — refusé comme une ressource inconnue.
     *
     * On ne dit pas « ce signataire n'existe pas » : la demande, elle, existe
     * et appartient bien au projet. Distinguer les deux permettrait d'énumérer
     * les signataires d'un contrat qu'on possède en observant le refus changer.
     */
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      'Aucun signataire ne correspond à cette référence pour cette demande.',
    );
  }

  const liens = await getSigningLinks({ ...commun, documentId: input.signatureRequestId });
  const adresse = String(cible.email ?? '').trim().toLowerCase();
  const lien = (liens?.signurl ?? []).find(
    (s) => String(s.email ?? '').trim().toLowerCase() === adresse,
  )?.url ?? null;

  const trace = auditParAdresse(document).get(adresse);
  return {
    signerId: input.signerId,
    provider: PROVIDER,
    state: signerStateFromAuditTrace(trace),
    status: trace?.signed ? 'signed' : trace?.viewed ? 'viewed' : null,
    signatureLink: lien,
  };
}

/**
 * `signature.document.download` — le PDF signé.
 *
 * ── DEUX APPELS, ET LE SECOND NE VISE PAS L'API ────────────────────────────
 *
 * OpenSign ne sert pas les PDF : il rend une URL PRÉ-SIGNÉE, valable quelques
 * minutes. Le Panel la suit LUI-MÊME et rend le contenu. La transmettre au
 * projet reviendrait à lui donner le document sans passer par la preuve
 * d'appartenance — cette URL porte son propre droit d'accès.
 */
async function signatureDocumentDownload({ definition, context, credentials, input, fetchImpl }) {
  const binding = await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  const commun = {
    credentials, timeoutMs: definition.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}),
  };

  const document = await getDocument({ ...commun, documentId: binding.documentId ?? input.signatureRequestId });
  const url = document?.file ?? null;
  if (!url) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      'Aucun document signable n’est rattaché à cette demande.',
    );
  }

  const octets = await fetchProviderFile({
    url, timeoutMs: definition.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}),
  });

  return {
    signatureRequestId: input.signatureRequestId,
    documentId: binding.documentId ?? input.signatureRequestId,
    provider: PROVIDER,
    contentBase64: octets.toString('base64'),
    byteLength: octets.length,
    sha256: createHash('sha256').update(octets).digest('hex'),
    /**
     * LE CERTIFICAT D'AUDIT, QUAND IL EXISTE.
     *
     * Yousign n'en rendait pas par cette voie. OpenSign le publie dès qu'un
     * document est achevé — c'est la pièce qui atteste QUI a signé, QUAND et
     * DEPUIS OÙ. L'annoncer ici (par un booléen, jamais par son URL) permet à
     * l'appelant de savoir qu'il peut le demander, sans lui remettre un droit
     * d'accès qu'il n'a pas à détenir.
     */
    certificateAvailable: Boolean(document?.certificate),
  };
}

/* -------------------------------------------------------------------------- */
/*  ANNULATION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `signature.request.cancel` — défaire un engagement pris devant un tiers.
 *
 * ⚠️ Mesuré : après révocation, OpenSign place le document en `declined`. Il
 * n'a pas d'état « révoqué » distinct. On rend donc l'état NEUTRE `CANCELED` —
 * c'est nous qui savons que l'acte était une annulation, et le projet a besoin
 * de cette nuance pour ses propres règles de relance.
 */
async function signatureRequestCancel({ definition, context, credentials, input, fetchImpl }) {
  await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  await revokeDocument({
    credentials,
    documentId: input.signatureRequestId,
    /**
     * Le motif est un TEXTE LIBRE chez OpenSign — pas une énumération non
     * documentée comme chez Yousign, où `'cancelled'` était refusé sans que
     * rien ne nomme le champ fautif. Un défaut lisible suffit.
     */
    reason: input.reason ?? 'Annulée par la plateforme.',
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  await closeBinding({
    environment: context.environment,
    resourceId: input.signatureRequestId,
    reason: 'CANCELLED',
  });

  return {
    signatureRequestId: input.signatureRequestId,
    provider: PROVIDER,
    state: SIGNATURE_REQUEST_STATE.CANCELED,
    status: 'CANCELED',
  };
}

/* -------------------------------------------------------------------------- */
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

export const OPENSIGN_ADAPTERS = Object.freeze({
  'signature.request.open': signatureRequestOpen,
  'signature.request.retrieve': signatureRequestRetrieve,
  'signature.signer.retrieve': signatureSignerRetrieve,
  'signature.document.download': signatureDocumentDownload,
  'signature.request.cancel': signatureRequestCancel,
});

export default {
  PROVIDER,
  OPENSIGN_ADAPTERS,
  signerHandle,
  buildCreateDocumentPayload,
  translateTransportError,
  recogniseInputRefusal,
  OPENSIGN_INPUT_REFUSAL,
  SIGNER_STATE,
};
