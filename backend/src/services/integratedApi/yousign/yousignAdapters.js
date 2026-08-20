// ADAPTATEURS YOUSIGN — les actes métier, et rien qu'eux (R10.5C).
//
// docs/R10_5_FINAL_EMAIL_AND_YOUSIGN_CONTROL_PLANE_REPORT.md §3.
//
// ══ CINQ CAPACITÉS, PAS ONZE VERBES ═════════════════════════════════════════
//
// L'API Yousign expose onze endpoints. Les exposer un par un aurait été le
// choix mécanique, et le mauvais : ouvrir une signature suppose de créer la
// demande, y joindre le document, ajouter deux signataires, poser N champs,
// puis activer. Découpé, le projet piloterait cette séquence — et pourrait
// s'arrêter au milieu.
//
// Or c'est précisément l'état que le code d'origine s'échinait à ne jamais
// rendre observable : en cas d'échec de préparation, il SUPPRIME le brouillon
// avant de lever, pour qu'aucun `signatureRequestId` à moitié préparé ne
// remonte. Six capacités auraient déplacé cette fenêtre d'incohérence chez
// l'appelant, qui n'a aucun moyen de la refermer.
//
// L'ouverture reste donc UN acte, tout-ou-rien, avec son nettoyage.
//
// ══ L'ORDRE DE CHAQUE ADAPTATEUR ════════════════════════════════════════════
//
//   1. appartenance      (avant le coffre — un refus ne déchiffre rien)
//   2. exécution         (transport)
//   3. traduction        (erreurs typées → vocabulaire de passerelle)
//
// `credentials` entre ici et n'en ressort pas : aucun adaptateur ne le rend, ne
// le journalise, ni ne l'attache à une erreur.
import logger from '../../../utils/logger.js';
import {
  YousignTransportError,
  TRANSPORT_CODES,
  OUTCOMES as TRANSPORT_OUTCOMES,
  createSignatureRequest,
  addDocument,
  addSigner,
  addField,
  activate,
  getSignatureRequest,
  getSigner,
  cancelSignatureRequest,
  YOUSIGN_CANCEL_REASON,
  deleteSignatureRequest,
  downloadSignedDocument,
} from './yousignTransport.js';
import {
  SIGNATURE_OWNERSHIP_CODES,
  claimSignatureRequest,
  attachResource,
  releaseClaim,
  closeBinding,
  describeOwnership,
  maskResourceId,
} from './signatureOwnership.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
} from '../../capabilities/capabilityErrors.js';
import { checkDocumentSize } from './signatureDocumentLimits.js';

/* -------------------------------------------------------------------------- */
/*  TRADUCTION DES REFUS                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Traduit une erreur de transport en refus de passerelle.
 *
 * ── LA DISTINCTION QUI PORTE TOUT LE LOT ────────────────────────────────────
 *
 * `TIMEOUT`, `UNREACHABLE` et `MALFORMED_RESPONSE` deviennent `TIMEOUT`, JAMAIS
 * `PROVIDER_UNAVAILABLE`. Le second affirme que rien n'a eu lieu ; sur une
 * demande de signature, cette affirmation pousse à rejouer, donc à solliciter
 * deux fois une personne réelle avec un engagement juridique.
 *
 * Le message du fournisseur n'est jamais relayé tel quel. Les CHAMPS refusés,
 * eux, le sont — ils nomment la cause sans porter de valeur.
 *
 * ── ET POURTANT UN REFUS PEUT ÊTRE MUET ─────────────────────────────────────
 *
 * Yousign refuse parfois SANS `invalid_params` : la cause n'est pas un champ
 * mais une règle de compte. Le refus arrivait alors au projet sous la forme
 * « Entrée refusée par « signature.request.open ». » — un message que personne
 * ne peut actionner, et qui envoie chercher un défaut de payload là où il n'y
 * en a pas.
 *
 * On ne relaie toujours pas la phrase du fournisseur. On la RECONNAÎT, et on
 * rend à sa place un motif stable : une donnée testable, traduisible côté
 * projet, et qui ne transporte aucune valeur.
 */

/**
 * Refus d'entrée que l'on sait NOMMER — la liste s'allonge par l'expérience.
 *
 * `SIGNER_EMAIL_NOT_IN_ORGANISATION` : en bac à sable, Yousign n'accepte comme
 * destinataire qu'une adresse appartenant à l'organisation du compte. Le
 * payload est alors parfaitement valide — c'est le compte qui est bridé. Sans
 * ce motif, l'exploitant cherche un champ fautif qui n'existe pas.
 */
export const YOUSIGN_INPUT_REFUSAL = Object.freeze({
  SIGNER_EMAIL_NOT_IN_ORGANISATION: 'SIGNER_EMAIL_NOT_IN_ORGANISATION',
});

/**
 * Reconnaît un refus de compte dans la phrase du fournisseur.
 *
 * On teste des CONCEPTS conjoints plutôt qu'une phrase exacte : Yousign peut
 * reformuler son message sans changer sa règle, et une correspondance littérale
 * cesserait alors de reconnaître le même refus.
 */
export function recogniseInputRefusal(message) {
  const m = String(message ?? '').toLowerCase();
  if (!m) return null;
  const bacASable = m.includes('sandbox');
  const adresse = m.includes('email') || m.includes('recipient');
  const organisation = m.includes('organization') || m.includes('organisation');
  if (bacASable && adresse && organisation) {
    return YOUSIGN_INPUT_REFUSAL.SIGNER_EMAIL_NOT_IN_ORGANISATION;
  }
  return null;
}

export function translateTransportError(error, capability) {
  if (!(error instanceof YousignTransportError)) {
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

  if (error.code === TRANSPORT_CODES.INPUT_INVALID) {
    const champs = error.invalidParams?.length
      ? ` : ${error.invalidParams.map((p) => p.field).join(', ')}.`
      : '.';
    const motif = recogniseInputRefusal(error.message);
    if (motif) {
      logger.warn(`[yousign] ${capability.code} refusée par le compte — ${motif}.`);
    }
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `Entrée refusée par « ${capability.code} »${champs}`,
      {
        httpStatus: error.httpStatus ?? null,
        /**
         * Le motif VOYAGE. C'est lui qui permet au projet de dire à l'exploitant
         * ce qu'il doit changer, sans que le Panel ait relayé la phrase du
         * fournisseur ni exposé la moindre valeur.
         */
        ...(motif ? { reason: motif } : {}),
        ...(error.invalidParams?.length
          ? { invalidParams: error.invalidParams.map((p) => p.field) }
          : {}),
      },
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
 * Le code interne distingue « inconnue » de « à un autre », parce que le
 * journal doit le savoir. Le message rendu, lui, est le même : sinon la
 * capacité devient un oracle d'existence, où l'on apprend qu'un identifiant
 * appartient à quelqu'un en observant le refus changer de forme.
 */
function ownershipRefusal(capability, verdict, resourceId) {
  logger.warn(
    `[yousign] ${capability.code} refusée — ${verdict.code} (${maskResourceId(resourceId)}).`,
  );
  return new CapabilityError(
    CAPABILITY_ERROR_CODES.RESOURCE_NOT_OWNED,
    'Demande de signature inconnue pour ce projet.',
    { reason: SIGNATURE_OWNERSHIP_CODES.UNKNOWN_RESOURCE },
  );
}

/** Garde commune aux capacités qui NOMMENT une ressource. */
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
/*  OUVRIR UNE SIGNATURE — l'acte composé                                      */
/* -------------------------------------------------------------------------- */

/**
 * `signature.request.open` — création + document + signataires + champs + activation.
 *
 * ── TOUT-OU-RIEN, ET LE NETTOYAGE QUI VA AVEC ───────────────────────────────
 *
 * Dès que la demande brouillon existe chez Yousign, toute sortie en erreur doit
 * la supprimer. Sans cela, chaque tentative ratée laisserait un brouillon
 * orphelin sur le compte de la plateforme, et le contrat n'en garderait aucune
 * trace — invisible, et facturable.
 *
 * Le nettoyage est best-effort : son échec ne doit JAMAIS masquer l'erreur
 * d'origine, qui est celle que l'exploitant doit lire.
 */
async function signatureRequestOpen({ definition, context, credentials, input, fetchImpl }) {
  const timeoutMs = definition.timeoutMs;
  const common = { credentials, timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) };

  /**
   * ── LA TAILLE, VÉRIFIÉE AVANT TOUTE RÉSERVATION ───────────────────────────
   *
   * Le schéma a déjà borné la CHAÎNE ; ici on borne le PDF DÉCODÉ, qui est la
   * grandeur que l'exploitant manipule et la seule dont le message puisse
   * parler utilement.
   *
   * Placé avant `claimSignatureRequest` : un document hors gabarit ne doit pas
   * laisser derrière lui une réservation à libérer, ni verrouiller un contrat
   * pour une raison qui n'a rien à voir avec le fournisseur.
   */
  const taille = checkDocumentSize(input.documentBase64);
  if (!taille.ok) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      taille.message,
      { reason: taille.code, byteLength: taille.byteLength },
    );
  }

  /**
   * ── 1. RÉSERVER LE CONTRAT, AVANT TOUT APPEL ──────────────────────────────
   *
   * L'index partiel arbitre en base. Un second clic — même avec une nouvelle
   * clé d'idempotence — retrouve la réservation existante et n'ouvre PAS une
   * seconde demande. C'est la garantie qui empêche de solliciter deux fois un
   * signataire réel.
   */
  const claim = await claimSignatureRequest({
    projectId: context.projectId,
    environment: context.environment,
    contractRef: input.contractRef,
    operationId: input.operationId,
  });

  if (!claim.claimed) {
    const existing = claim.binding;
    // Une demande vivante existe déjà : on rend CE qu'elle est, sans rien créer.
    return {
      status: 'ALREADY_OPEN',
      signatureRequestId: existing?.resourceId?.startsWith('pending:') ? null : existing?.resourceId ?? null,
      documentId: existing?.documentId ?? null,
      contractRef: input.contractRef,
      signers: [],
    };
  }

  let draft = null;
  try {
    draft = await createSignatureRequest({ ...common, name: input.name });

    const document = await addDocument({
      ...common,
      requestId: draft.id,
      buffer: Buffer.from(input.documentBase64, 'base64'),
      filename: input.documentFilename,
      parseAnchors: false,
    });

    /**
     * L'ORDRE DE CRÉATION EST L'ORDRE DE SIGNATURE (`ordered_signers: true`).
     * Le tableau reçu est donc significatif, et n'est jamais retrié ici.
     */
    const signers = [];
    for (const signer of input.signers) {
      // eslint-disable-next-line no-await-in-loop
      const created = await addSigner({
        ...common,
        requestId: draft.id,
        signer: {
          info: {
            first_name: signer.firstName,
            last_name: signer.lastName,
            email: signer.email,
            locale: 'fr',
          },
          signature_level: 'electronic_signature',
          signature_authentication_mode: 'no_otp',
          ...(signer.redirectUrls ? { redirect_urls: signer.redirectUrls } : {}),
        },
      });
      signers.push({ role: signer.role, signerId: created.id });
    }

    const byRole = new Map(signers.map((s) => [s.role, s.signerId]));
    for (const field of input.fields) {
      // eslint-disable-next-line no-await-in-loop
      await addField({
        ...common,
        requestId: draft.id,
        documentId: document.id,
        field: {
          type: 'signature',
          page: field.page,
          x: field.x,
          y: field.y,
          width: field.width,
          height: field.height,
          signer_id: byRole.get(field.signerRole),
        },
      });
    }

    const activated = await activate({ ...common, requestId: draft.id });

    await attachResource({
      operationId: input.operationId,
      resourceId: draft.id,
      documentId: document.id,
    });

    return {
      status: 'OPENED',
      signatureRequestId: draft.id,
      documentId: document.id,
      contractRef: input.contractRef,
      /**
       * LES LIENS DE SIGNATURE — le seul champ « riche » rendu au projet, et il
       * est indispensable : c'est ce que l'écran présente au signataire. Aucun
       * autre détail Yousign ne traverse.
       */
      signers: signers.map((s) => ({
        role: s.role,
        signerId: s.signerId,
        signatureLink: (activated.signers || []).find((x) => x.id === s.signerId)?.signature_link ?? null,
      })),
    };
  } catch (error) {
    const translated = error instanceof CapabilityError ? error : translateTransportError(error, definition);

    /**
     * ── LIBÉRER, OU NE PAS LIBÉRER ────────────────────────────────────────────
     *
     * On ne libère la réservation QUE si l'issue est certaine. Sur un timeout,
     * la demande a peut-être été créée : libérer le contrat autoriserait une
     * seconde ouverture, c'est-à-dire le doublon qu'on évite. Le contrat reste
     * alors verrouillé, et c'est le bon arbitrage — un humain tranche.
     */
    const certain = translated.code !== CAPABILITY_ERROR_CODES.TIMEOUT;

    if (draft?.id && certain) {
      try {
        await deleteSignatureRequest({ ...common, requestId: draft.id });
        logger.info(`[yousign] brouillon ${maskResourceId(draft.id)} supprimé après échec de préparation.`);
      } catch (cleanup) {
        logger.warn(
          `[yousign] brouillon ${maskResourceId(draft.id)} NON supprimé (${cleanup?.code ?? 'inconnu'}) — `
          + 'à nettoyer manuellement.',
        );
      }
    }
    if (certain) await releaseClaim({ operationId: input.operationId });

    throw translated;
  }
}

/* -------------------------------------------------------------------------- */
/*  LECTURES                                                                  */
/* -------------------------------------------------------------------------- */

/** `signature.request.retrieve` — l'état d'une demande possédée. */
async function signatureRequestRetrieve({ definition, context, credentials, input, fetchImpl }) {
  await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  const raw = await getSignatureRequest({
    credentials,
    requestId: input.signatureRequestId,
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  /**
   * DTO MINIMAL. L'objet Yousign porte bien davantage — expéditeur, workspace,
   * horodatages internes, e-mails des signataires. Rien de tout cela n'est
   * nécessaire au projet, et tout cela serait une donnée de plus à protéger.
   */
  return {
    signatureRequestId: raw.id,
    status: raw.status ?? null,
    signers: (raw.signers || []).map((s) => ({ signerId: s.id, status: s.status ?? null })),
  };
}

/** `signature.signer.retrieve` — le lien de signature d'un signataire. */
async function signatureSignerRetrieve({ definition, context, credentials, input, fetchImpl }) {
  await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  const raw = await getSigner({
    credentials,
    requestId: input.signatureRequestId,
    signerId: input.signerId,
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    signerId: raw.id,
    status: raw.status ?? null,
    signatureLink: raw.signature_link ?? null,
  };
}

/**
 * `signature.document.download` — le PDF signé.
 *
 * ── LE `documentId` VIENT DU LIEN, JAMAIS DE L'APPELANT ─────────────────────
 *
 * Laisser le projet nommer le document à télécharger lui permettrait de tenter
 * d'en lire un autre au sein d'une demande qu'il possède. Le Panel le connaît
 * depuis l'ouverture : il le tient, et l'appelant ne le fournit pas.
 */
async function signatureDocumentDownload({ definition, context, credentials, input, fetchImpl }) {
  const binding = await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  if (!binding.documentId) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      'Aucun document signable n’est rattaché à cette demande.',
    );
  }

  const buffer = await downloadSignedDocument({
    credentials,
    requestId: input.signatureRequestId,
    documentId: binding.documentId,
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  /**
   * LE BINAIRE TRAVERSE EN BASE64, ET C'EST ASSUMÉ.
   *
   * La passerelle porte du JSON. Un transport binaire dédié aurait été plus
   * efficace, et aurait demandé un second chemin d'exécution — donc un second
   * endroit où l'appartenance pourrait être oubliée. Le surcoût de 33 % sur un
   * PDF de contrat est le prix d'une porte unique.
   *
   * L'empreinte accompagne le contenu : le projet vérifie qu'il a reçu ce que
   * le Panel a lu, sans avoir à refaire confiance au transport.
   */
  const { createHash } = await import('node:crypto');
  return {
    signatureRequestId: input.signatureRequestId,
    documentId: binding.documentId,
    contentBase64: buffer.toString('base64'),
    byteLength: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/* -------------------------------------------------------------------------- */
/*  ANNULATION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `signature.request.cancel` — défaire un engagement pris devant un tiers.
 *
 * Classée `LEGAL_WRITE` comme l'ouverture : annuler une signature en cours
 * atteint la même personne réelle que la demander. La ranger en écriture
 * réversible l'aurait autorisée en pré-ouverture, c'est-à-dire pendant la
 * recette, sur un vrai signataire.
 */
async function signatureRequestCancel({ definition, context, credentials, input, fetchImpl }) {
  await requireOwned({ context, definition, resourceId: input.signatureRequestId });
  await cancelSignatureRequest({
    credentials,
    requestId: input.signatureRequestId,
    /**
     * `'cancelled'` était écrit ici aussi, et Yousign le refuse : le motif est
     * une ÉNUMÉRATION du fournisseur, pas un libellé. Voir
     * `YOUSIGN_CANCEL_REASON` — la valeur dont on a la preuve qu'elle marche.
     */
    reason: input.reason ?? YOUSIGN_CANCEL_REASON,
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await closeBinding({
    environment: context.environment,
    resourceId: input.signatureRequestId,
    reason: 'CANCELLED',
  });
  return { signatureRequestId: input.signatureRequestId, status: 'CANCELED' };
}

/* -------------------------------------------------------------------------- */
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

export const YOUSIGN_ADAPTERS = Object.freeze({
  'signature.request.open': signatureRequestOpen,
  'signature.request.retrieve': signatureRequestRetrieve,
  'signature.signer.retrieve': signatureSignerRetrieve,
  'signature.document.download': signatureDocumentDownload,
  'signature.request.cancel': signatureRequestCancel,
});

export default { YOUSIGN_ADAPTERS, translateTransportError };
