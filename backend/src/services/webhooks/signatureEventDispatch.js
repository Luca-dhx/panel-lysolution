// LE CHEMIN RETOUR DE LA SIGNATURE — du fournisseur jusqu'au bon projet.
//
// docs/R10_5_FINAL_EMAIL_AND_YOUSIGN_CONTROL_PLANE_REPORT.md §6, puis
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md (lot 3).
//
// ══ DEUX FOURNISSEURS, UN SEUL VOCABULAIRE DE SORTIE ════════════════════════
//
// Ce module reconnaissait un fournisseur et un seul. Il en reconnaît deux, et
// c'est le POINT DE TRADUCTION : au-delà d'ici, plus rien du parc ne sait qui a
// signé — ni SB Auto, ni le journal durable, ni les projections de contrat.
//
// La table par fournisseur est ci-dessous, en toutes lettres. Un `if (provider
// === 'OPENSIGN')` semé dans le corps de la fonction aurait produit le même
// résultat et rendu impossible de VOIR, en une page, qu'aucun événement ne
// tombe dans le vide.
//
// ══ POURQUOI L'ENDPOINT A DÉMÉNAGÉ ══════════════════════════════════════════
//
// Avant, Yousign appelait le PROJET. Un événement reçu pendant que le projet
// était éteint était PERDU : Yousign réessaie, mais rien ne garantissait la
// convergence, et un contrat pouvait rester éternellement « en cours » alors
// qu'il était signé.
//
// C'est la même leçon que pour Brevo en L8.4 : après cutover, les webhooks
// suivent le COMPTE, donc le Panel. Les laisser arriver au projet aurait créé
// deux chemins de retour pour un seul fait.
//
// ══ LE CORPS DU WEBHOOK NE DÉSIGNE JAMAIS LE PROJET ═════════════════════════
//
// Le destinataire est retrouvé par le LIEN D'APPARTENANCE que le Panel a écrit
// AVANT d'appeler Yousign. Un `projectId` lu dans la charge utile serait une
// proposition d'un tiers — c'est-à-dire le chemin par lequel quelqu'un ferait
// router ses événements vers le projet de son choix.
//
// ══ POURQUOI LA PROJECTION EST DURABLE ══════════════════════════════════════
//
// `emitChange` écrit dans le journal du pont, que le projet consomme à son
// rythme. Un projet éteint ne perd donc plus rien : il rattrape à la
// reconnexion. C'est exactement ce que l'ancien endpoint local ne savait pas
// faire, et c'est la raison d'être de ce module.
import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { emitChange } from '../sync/syncCore.service.js';
import { findBinding, closeBinding, maskResourceId } from '../integratedApi/signature/signatureOwnership.js';
import { signerHandle } from '../integratedApi/opensign/openSignAdapters.js';

/** Type d'entité du journal durable — le projet s'y abonne. */
export const SIGNATURE_ENTITY_TYPE = 'SIGNATURE_EVENT';

/**
 * LES FAITS QUE LE PARC CONSOMME. Fermé, et volontairement court.
 *
 * Yousign émet bien davantage (ouverture d'e-mail, consultation du document,
 * rappels). Les projeter « par principe » remplirait le journal durable de
 * faits que personne ne lit — et chaque événement inutile est une donnée
 * personnelle de plus à justifier et à purger.
 */
export const SIGNATURE_EVENTS = Object.freeze({
  /** Un signataire a signé. Le parcours avance. */
  SIGNER_SIGNED: 'SIGNATURE_SIGNER_SIGNED',
  /** Tous ont signé : le document signé est disponible. */
  COMPLETED: 'SIGNATURE_COMPLETED',
  /** Refus, expiration ou annulation : le parcours s'arrête. */
  FAILED: 'SIGNATURE_FAILED',
});

/**
 * LA TABLE DE TRADUCTION, PAR FOURNISSEUR — et elle est exhaustive.
 *
 * `null` n'est pas un oubli : c'est la réponse VOULUE pour les notifications de
 * création et de consultation. Les projeter obligerait chaque projet à filtrer
 * un flux qu'il n'a pas demandé, et remplirait le journal durable du Panel de
 * faits que personne ne lit — chacun étant une donnée personnelle de plus à
 * justifier et à purger.
 *
 * Un événement ABSENT de la table rend `null` lui aussi, et c'est l'écriture
 * qui compte : on acquitte sans agir. Refuser ferait rejouer le fournisseur en
 * boucle pour un événement dont on ne veut rien faire.
 */
/**
 * LES FOURNISSEURS DE SIGNATURE — dérivés de la table, jamais retapés.
 *
 * La réception a besoin de savoir quels fournisseurs relèvent de cet
 * acheminement. Le lui faire écrire en dur créerait une seconde liste, et la
 * seconde liste finit toujours par oublier le fournisseur suivant.
 */
export const SIGNATURE_PROVIDERS = new Set(['YOUSIGN', 'OPENSIGN']);

const BUSINESS_EVENT_BY_PROVIDER = Object.freeze({
  YOUSIGN: Object.freeze({
    'signature_request.signer.done': SIGNATURE_EVENTS.SIGNER_SIGNED,
    'signer.done': SIGNATURE_EVENTS.SIGNER_SIGNED,
    'signature_request.done': SIGNATURE_EVENTS.COMPLETED,
    'signature_request.declined': SIGNATURE_EVENTS.FAILED,
    'signature_request.expired': SIGNATURE_EVENTS.FAILED,
    'signature_request.canceled': SIGNATURE_EVENTS.FAILED,
    'signer.declined': SIGNATURE_EVENTS.FAILED,
  }),
  OPENSIGN: Object.freeze({
    /** `created` et `viewed` sont ACQUITTÉS sans être projetés — voir ci-dessus. */
    signed: SIGNATURE_EVENTS.SIGNER_SIGNED,
    completed: SIGNATURE_EVENTS.COMPLETED,
    declined: SIGNATURE_EVENTS.FAILED,
    /**
     * `revoked` N'EST PAS DOCUMENTÉ, ET IL EST QUAND MÊME LÀ.
     *
     * La page d'aide d'OpenSign annonce « Document Revoked or Declined » ; la
     * référence API ne publie que cinq événements, `declined` compris ; et la
     * mesure montre qu'une révocation place le document en `declined`. Il est
     * donc probable qu'aucun `revoked` n'arrive jamais.
     *
     * On le traite tout de même. Le coût d'une ligne est nul ; le coût de son
     * absence serait un contrat révoqué qui resterait « en cours » pour
     * toujours, sans que rien ne le signale.
     */
    revoked: SIGNATURE_EVENTS.FAILED,
    expired: SIGNATURE_EVENTS.FAILED,
  }),
});

/**
 * Traduit un événement fournisseur en fait métier, ou rend `null`.
 *
 * @param {string} eventName  le libellé du fournisseur
 * @param {string} provider   qui l'a émis — DEUX fournisseurs peuvent employer
 *   le même mot pour des choses différentes, et deviner reviendrait à leur
 *   prêter un vocabulaire commun qu'ils n'ont pas.
 */
export function toBusinessEvent(eventName, provider = 'YOUSIGN') {
  const table = BUSINESS_EVENT_BY_PROVIDER[String(provider ?? '').toUpperCase()];
  if (!table) return null;
  return table[String(eventName || '').trim().toLowerCase()] ?? null;
}

/**
 * L'identifiant de demande porté par l'événement.
 *
 * Les deux fournisseurs le placent ailleurs, et ne le nomment pas pareil :
 * Yousign l'imbrique sous `data.signature_request.id`, OpenSign le pose à plat
 * sous `objectId`. Chercher les deux chemins « au cas où » marcherait — et
 * ferait qu'un jour, un champ homonyme d'un fournisseur serait lu comme
 * l'identifiant d'un autre. On lit celui du fournisseur qui parle.
 */
function extractRequestId(payload, provider) {
  if (String(provider ?? '').toUpperCase() === 'OPENSIGN') {
    return String(payload?.objectId ?? '').trim();
  }
  return String(
    payload?.data?.signature_request?.id
    ?? payload?.signature_request?.id
    ?? payload?.data?.id
    ?? '',
  ).trim();
}

/**
 * L'IDENTITÉ DE PONT — un UUID, parce que le contrat n'accepte que ça.
 *
 * ══ LE DÉFAUT QUE CETTE FONCTION EXISTE POUR ÉVITER ═══════════════════════
 *
 * `syncChangeSchema` impose `entityId: uuid`. Une référence de contrat de
 * projet n'en est pas une — c'est un ObjectId de 24 hexadécimaux. Émettre la
 * référence métier telle quelle faisait rejeter la PAGE ENTIÈRE en
 * `BRIDGE_INVALID_PAYLOAD` : aucun événement de signature n'atteignait jamais
 * le projet, et rien ne le signalait au Panel, qui croyait avoir livré.
 * C'est exactement le défaut rencontré sur Brevo en L8.4.
 *
 * ══ POURQUOI DÉRIVÉ, ET NON TIRÉ AU HASARD ════════════════════════════════
 *
 * Deux faits concernant la MÊME demande doivent porter la même identité
 * d'entité : c'est ce qui rend cohérents l'anti-écho et l'idempotence côté
 * projet. Un UUID aléatoire par événement en aurait fait des entités
 * distinctes, et un rejeu serait passé pour une nouveauté.
 *
 * La référence métier, elle, n'est pas perdue : elle voyage dans la charge
 * utile (`contractRef`), qui est ce que l'applicateur lit réellement.
 */
export function toBridgeEntityId(seed) {
  const h = createHash('sha256').update(`signature:${seed}`).digest('hex');
  // Forme UUID v5-like : la version et la variante sont posées explicitement.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/**
 * L'identifiant du signataire — le SEUL fragment d'identité qui traverse.
 *
 * Sans lui, le projet apprend « quelqu'un a signé » sans savoir qui : il ne
 * peut plus horodater la signature du développeur séparément de celle du
 * client, ni ouvrir le contrat à la contresignature au bon moment. Le parcours
 * s'arrêterait à mi-chemin en silence.
 *
 * C'est une référence OPAQUE du fournisseur, pas une donnée personnelle : ni
 * nom, ni adresse. Le projet détient déjà la correspondance signataire→rôle,
 * puisque c'est lui qui a déclaré les signataires à l'ouverture. On lui rend
 * donc la clé de sa propre table, et rien de plus.
 *
 * L'alternative — faire redemander au projet « qui a signé ? » par une capacité
 * — remettrait le Panel dans le chemin critique de l'application d'un fait déjà
 * établi : un projet hors ligne au mauvais moment perdrait l'information.
 */
export function extractSignerId(payload, provider, signatureRequestId) {
  if (String(provider ?? '').toUpperCase() === 'OPENSIGN') {
    /**
     * ══ CHEZ OPENSIGN, LE SIGNATAIRE EST UNE ADRESSE ═══════════════════════
     *
     * Le webhook `signed` porte `signer.email`, et rien d'autre : aucun
     * identifiant opaque n'existe chez ce fournisseur.
     *
     * La faire traverser telle quelle serait deux fautes en une. Une donnée
     * personnelle entrerait dans le journal durable du Panel et dans les
     * projections de chaque projet ; et le projet recevrait une valeur qui ne
     * correspond PAS à celle qu'il a reçue à l'ouverture — il ne saurait donc
     * même pas de qui on parle.
     *
     * On recalcule la POIGNÉE, exactement comme l'adaptateur l'a fait à
     * l'ouverture. Même fonction, mêmes entrées, même résultat : le projet
     * reconnaît son signataire, et aucune adresse ne traverse.
     */
    const adresse = payload?.signer?.email
      ?? payload?.declinedBy
      ?? payload?.viewedBy
      ?? null;
    if (!adresse || !signatureRequestId) return null;
    return signerHandle(signatureRequestId, adresse);
  }

  const brut = payload?.data?.signer?.id
    ?? payload?.data?.signer_id
    ?? payload?.signer?.id
    ?? null;
  const valeur = String(brut ?? '').trim();
  return valeur === '' ? null : valeur;
}

/**
 * Achemine un événement de signature vers le projet propriétaire.
 *
 * Appelé APRÈS l'idempotence de réception : un rejeu du fournisseur n'arrive
 * jamais jusqu'ici, donc le journal durable ne peut pas contenir deux fois le
 * même fait.
 *
 * NE LÈVE JAMAIS. Un endpoint public qui lève produit une 500, et une 500 fait
 * rejouer le fournisseur en boucle.
 *
 * @returns {Promise<{dispatched: boolean, reason?: string, projectId?: string}>}
 */
export async function dispatchSignatureEvent({ provider, environment, payload, eventType }) {
  const emetteur = String(provider ?? '').toUpperCase();
  if (!SIGNATURE_PROVIDERS.has(emetteur)) {
    return { dispatched: false, reason: 'PROVIDER_NOT_DISPATCHED' };
  }

  const businessEvent = toBusinessEvent(eventType ?? payload?.event ?? payload?.event_name, emetteur);
  if (!businessEvent) return { dispatched: false, reason: 'EVENT_NOT_PROJECTED' };

  const signatureRequestId = extractRequestId(payload, emetteur);
  if (!signatureRequestId) return { dispatched: false, reason: 'NO_REQUEST_ID' };

  /**
   * L'APPARTENANCE, ET ELLE SEULE.
   *
   * Aucun lien ⇒ la demande n'a pas été ouverte par ce plan de contrôle. C'est
   * le cas NORMAL pendant la coexistence — un projet ouvre encore ses
   * signatures lui-même. On ne cherche pas plus loin, et surtout on n'invente
   * pas de destinataire.
   */
  const binding = await findBinding({ environment, resourceId: signatureRequestId });
  if (!binding) return { dispatched: false, reason: 'NO_MATCHING_BINDING' };

  /**
   * ── LE LIEN DOIT VENIR DU MÊME FOURNISSEUR QUE L'ÉVÉNEMENT ──────────────
   *
   * Les identifiants de demande n'ont pas la même forme d'un fournisseur à
   * l'autre, mais rien ne garantit qu'ils ne se croiseront jamais — dix
   * caractères alphanumériques chez OpenSign, et un jour peut-être ailleurs.
   *
   * Sans ce contrôle, un événement d'un fournisseur pourrait faire avancer
   * l'état d'un contrat ouvert chez l'autre. La conséquence ne serait pas une
   * erreur : ce serait un contrat marqué signé par un événement qui ne le
   * concerne pas. On refuse, et on le journalise — c'est un fait anormal, pas
   * un cas de bord.
   */
  const detenteur = String(binding.provider ?? 'YOUSIGN').toUpperCase();
  if (detenteur !== emetteur) {
    logger.warn(
      `[signature] événement ${emetteur} ignoré : la demande `
      + `${maskResourceId(signatureRequestId)} appartient à ${detenteur}.`,
    );
    return { dispatched: false, reason: 'PROVIDER_MISMATCH' };
  }

  /**
   * UN FAIT TERMINAL FERME LE LIEN.
   *
   * C'est ce qui libère le contrat pour une éventuelle relance après refus ou
   * expiration — l'index partiel n'autorise qu'une demande VIVANTE par contrat.
   * Sans cette fermeture, un contrat refusé resterait bloqué à jamais.
   */
  if (businessEvent === SIGNATURE_EVENTS.COMPLETED || businessEvent === SIGNATURE_EVENTS.FAILED) {
    await closeBinding({
      environment,
      resourceId: signatureRequestId,
      reason: businessEvent,
    }).catch(() => {});
  }

  await emitChange({
    entityType: SIGNATURE_ENTITY_TYPE,
    /**
     * L'IDENTITÉ D'ENTITÉ EST DÉRIVÉE DE LA RÉFÉRENCE MÉTIER — voir
     * `toBridgeEntityId`. Ni l'identifiant Yousign ni la référence de contrat
     * du projet ne sont des UUID ; les émettre tels quels faisait rejeter la
     * page entière. La référence métier reste lisible dans la charge utile.
     */
    entityId: toBridgeEntityId(binding.contractRef),
    /**
     * CHARGE UTILE MINIMALE. Ni nom de signataire, ni adresse, ni document : le
     * projet les détient, et les recopier ferait du journal durable du Panel un
     * second exemplaire de données personnelles à protéger.
     */
    payload: {
      event: businessEvent,
      contractRef: binding.contractRef,
      signatureRequestId,
      /** Qui a signé — opaque, et absent des faits qui ne concernent personne. */
      signerId: extractSignerId(payload, emetteur, signatureRequestId),
      /** Le libellé du fournisseur — conservé pour le forensic. */
      /**
       * Le libellé du fournisseur, conservé pour le forensic — et le
       * FOURNISSEUR lui-même, sans quoi « signed » ne dit pas d'où il vient.
       */
      provider: emetteur,
      providerEvent: String(eventType ?? payload?.event ?? payload?.event_name ?? ''),
      occurredAt: new Date().toISOString(),
    },
    // Le destinataire est NOMMÉ : cet événement ne concerne qu'un projet.
    audience: binding.projectId,
  });

  logger.info(
    `[signature] ${businessEvent} acheminé vers ${binding.projectId} `
    + `(contrat ${binding.contractRef}, demande ${maskResourceId(signatureRequestId)}).`,
  );

  return { dispatched: true, projectId: binding.projectId, event: businessEvent };
}

export default { dispatchSignatureEvent, toBusinessEvent, SIGNATURE_EVENTS, SIGNATURE_ENTITY_TYPE };
