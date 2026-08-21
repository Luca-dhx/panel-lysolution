// ADAPTATEURS — le seul endroit qui connaît un fournisseur (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Adaptateurs ».
//
// ── UNE TABLE, PAS UN `switch` ──────────────────────────────────────────────
//
// Un aiguillage géant dans le contrôleur grossit à chaque migration, mélange
// les fournisseurs dans une même fonction, et finit par contenir la logique
// métier qu'il était censé router. Ici, une capacité pointe une fonction ; le
// jour où Stripe arrive, on ajoute une ligne et un fichier, et rien d'autre ne
// bouge.
//
// ── CE QU'UN ADAPTATEUR REÇOIT, ET CE QU'IL REND ────────────────────────────
//
//   reçoit  →  { definition, context, credentials, input }
//   rend    →  la SORTIE MÉTIER de la capacité, validée par son schéma
//   lève    →  CapabilityError, jamais une erreur de fournisseur brute
//
// `credentials` entre ici et n'en ressort pas. Aucun adaptateur ne le renvoie,
// ne le journalise, ni ne l'attache à une erreur.
//
// ── POURQUOI LE TRANSPORT BREVO N'EST PAS RÉÉCRIT ───────────────────────────
//
// L8 a livré `integratedApi/brevo/brevoTransport.js` : délais bornés, erreurs
// typées, aucun secret journalisé, distinction entre « il a dit non » et « il
// n'a rien dit ». L'adaptateur ci-dessous ne fait que TRADUIRE ses refus en
// vocabulaire de passerelle. En écrire un second serait créer une seconde
// vérité sur le même fournisseur.
import {
  describeAccount,
  BrevoTransportError,
  TRANSPORT_CODES,
  OUTCOMES as TRANSPORT_OUTCOMES,
} from '../integratedApi/brevo/brevoTransport.js';
import { HOSTINGER_ADAPTERS } from '../integratedApi/hostinger/hostingerAdapters.js';
import { STRIPE_ADAPTERS } from '../integratedApi/stripe/stripeAdapters.js';
/**
 * L'ANCIEN FOURNISSEUR NE SERT PLUS — il répond, et il répond non.
 *
 * `yousignAdapters.js` et son transport ont été SUPPRIMÉS : plus une ligne du
 * Panel ne parle HTTP à ce fournisseur. La table qui le remplace refuse chaque
 * acte avec une phrase qui dit où regarder — sans quoi une demande de 2025
 * lèverait une exception nue au moment où quelqu'un cherche son contrat.
 */
import { RETIRED_SIGNATURE_ADAPTERS } from '../integratedApi/signature/retiredSignatureProvider.js';
import { OPENSIGN_ADAPTERS } from '../integratedApi/opensign/openSignAdapters.js';
import { brevoSendTemplate } from './brevoSendAdapter.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  capabilityNotAvailable,
} from './capabilityErrors.js';

/* -------------------------------------------------------------------------- */
/*  TRADUCTION DES REFUS FOURNISSEUR                                          */
/* -------------------------------------------------------------------------- */

/**
 * Traduit une erreur de transport en refus de passerelle.
 *
 * ── LA SEULE DISTINCTION QUI COMPTE VRAIMENT ────────────────────────────────
 *
 * `TIMEOUT` ne devient PAS `PROVIDER_UNAVAILABLE`. Le premier laisse l'action
 * dans un état indécidable — la requête a pu aboutir et seule la réponse se
 * perdre ; le second affirme que rien n'a eu lieu. Un projet qui les confond
 * rejoue une écriture réelle et la double. La passerelle porte donc la nuance
 * jusqu'au code d'erreur, et jusqu'à l'issue journalisée.
 *
 * ── CE QUI NE TRAVERSE PAS ──────────────────────────────────────────────────
 *
 * Le message du fournisseur n'est jamais relayé. Il peut contenir un
 * identifiant de compte, une URL interne, ou n'importe quoi qu'on n'a pas relu.
 * On garde son STATUT HTTP dans les détails — un nombre ne fuit rien — et on
 * formule le reste nous-mêmes.
 */
export function translateTransportError(error, capability) {
  if (!(error instanceof BrevoTransportError)) {
    // Erreur non typée : on ne sait pas ce qui s'est passé, donc on ne prétend
    // pas le savoir. `PROVIDER_UNAVAILABLE` est le refus le plus prudent qui
    // reste honnête.
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `L’exécution de « ${capability.code} » a échoué chez le fournisseur.`,
    );
  }

  if (error.code === TRANSPORT_CODES.TIMEOUT || error.outcome === TRANSPORT_OUTCOMES.UNKNOWN) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Le fournisseur n’a pas répondu pour « ${capability.code} » : l’issue est indéterminée.`,
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
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `Entrée refusée par l’adaptateur de « ${capability.code} ».`,
    );
  }

  return new CapabilityError(
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    `Le fournisseur a refusé « ${capability.code} ».`,
    { httpStatus: error.httpStatus ?? null },
  );
}

/* -------------------------------------------------------------------------- */
/*  BREVO                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `email.sender.verify` — la première capacité réellement servie.
 *
 * Elle LIT le compte chez Brevo (`GET /v3/account`). Rien n'est créé, rien
 * n'est envoyé, personne ne reçoit de message. C'est ce qui la rend éligible
 * comme première migration : son échec ne prive aucun utilisateur d'une
 * notification, et son rejeu ne peut produire aucun doublon.
 *
 * La sortie est un CONSTAT métier — « ce projet peut écrire, oui ou non » —
 * et non une transcription de la réponse de Brevo. `accountLabel` est le nom
 * public du compte, celui qu'un opérateur reconnaît ; il ne porte aucun secret.
 */
async function brevoSenderVerify({ credentials, definition, fetchImpl }) {
  const account = await describeAccount({
    credentials: { apiKey: credentials.apiKey, baseUrl: credentials.baseUrl },
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  return {
    provider: 'BREVO',
    reachable: account.ok === true,
    accountLabel: account.account ?? null,
    /**
     * L'instant du CONSTAT, pas celui de la requête. Le projet s'en sert pour
     * afficher « vérifié il y a 4 minutes » sans tenir sa propre horloge ;
     * `operationId` reste sa clé de corrélation, et la passerelle le lui rend.
     */
    checkedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Capacité → exécutant. FERMÉE, et volontairement courte.
 *
 * Une capacité absente d'ici n'est pas servie, quoi qu'en dise son registre :
 * c'est la table qui décide de ce qui s'exécute réellement, et
 * `assertAdapterAlignment()` exige que les deux listes soient IDENTIQUES.
 */
const ADAPTERS = Object.freeze({
  'email.sender.verify': brevoSenderVerify,
  /**
   * L'ENVOI — dans son propre module, pour la meme raison que les verbes DNS :
   * il resout trois autorites (modele, expediteur, coffre) avant de parler au
   * fournisseur, et melanger cette resolution a la lecture de compte ferait de
   * ce fichier un service Brevo plutot qu'une table.
   */
  'email.send_template': brevoSendTemplate,
  /**
   * HOSTINGER — trois verbes DNS, définis par le lot qui connaît le fournisseur.
   *
   * Ils ne sont pas écrits ici pour la même raison que le transport Brevo n'y
   * est pas réécrit : chaque adaptateur TRADUIT SES PROPRES ERREURS. Le
   * traducteur générique ci-dessus ne connaît que Brevo — une
   * `HostingerTransportError` y tomberait dans la branche « erreur non typée »
   * et ressortirait en `PROVIDER_UNAVAILABLE`, c'est-à-dire en « rien ne s'est
   * passé ». Sur une écriture DNS interrompue, c'est faux, et c'est exactement
   * l'affirmation qui pousse à rejouer.
   */
  ...HOSTINGER_ADAPTERS,
  /**
   * STRIPE — un seul verbe, et le premier qui déplace de l'argent réel.
   *
   * Même raison qu'ailleurs pour le tenir hors de ce fichier : il traduit ses
   * propres refus. Sur un provider financier, la nuance est plus coûteuse
   * encore qu'ailleurs — le traducteur générique rendrait « rien ne s'est
   * passé » là où Stripe n'a rien dit, et c'est cette phrase-là qui pousse un
   * projet à rejouer un paiement.
   */
  ...STRIPE_ADAPTERS,
  /**
   * LA SIGNATURE — CINQ ACTES, DEUX EXÉCUTANTS POSSIBLES.
   *
   * ══ POURQUOI UN AIGUILLEUR PLUTÔT QUE DEUX ENTRÉES ═══════════════════════
   *
   * `assertAdapterAlignment()` exige une bijection stricte entre les codes du
   * registre et ceux de cette table. Un domaine à deux fournisseurs ne peut
   * donc pas y figurer deux fois — et c'est heureux : deux entrées pour
   * `signature.request.open` poseraient la question « laquelle gagne ? » à un
   * endroit où personne ne saurait y répondre.
   *
   * Une entrée par code, donc, et l'aiguillage à l'intérieur — sur le
   * fournisseur que la passerelle a DÉJÀ résolu et dont elle a ouvert le
   * coffre. L'aiguilleur ne décide rien : il obéit.
   */
  ...signatureAdapters(),
});

/**
 * Construit les cinq entrées de signature, chacune aiguillant sur l'exécutant
 * effectif.
 *
 * ── CE QUI EST VÉRIFIÉ ICI, ET POURQUOI CE N'EST PAS DE LA PARANOÏA ────────
 *
 * Les deux tables doivent couvrir exactement les mêmes codes. Si l'une en
 * perdait un, l'aiguilleur recevrait `undefined` et lèverait une exception nue
 * au moment de l'appel — c'est-à-dire au pire moment, avec le pire message. Le
 * contrôle a lieu au chargement du module.
 */
function signatureAdapters() {
  const parFournisseur = Object.freeze({
    YOUSIGN: RETIRED_SIGNATURE_ADAPTERS,
    OPENSIGN: OPENSIGN_ADAPTERS,
  });

  const codes = Object.keys(OPENSIGN_ADAPTERS);
  const manquants = Object.entries(parFournisseur)
    .flatMap(([code, table]) => codes.filter((c) => !table[c]).map((c) => `${code}:${c}`));
  if (manquants.length) {
    throw new Error(
      `Adaptateurs de signature incomplets — ${manquants.join(', ')}. `
      + 'Un domaine à plusieurs fournisseurs exige que chacun serve TOUS les actes : '
      + 'un acte manquant ne se découvrirait qu’à l’exécution, sur un contrat réel.',
    );
  }

  return Object.fromEntries(codes.map((code) => [code, async (args) => {
    const provider = String(args?.definition?.provider ?? '').toUpperCase();
    const table = parFournisseur[provider];
    if (!table) {
      /**
       * AUCUN REPLI. Un fournisseur inconnu pour un acte de signature signifie
       * que le lien d'appartenance porte une valeur qu'on ne sait pas servir.
       * Choisir « le plus probable » enverrait l'identifiant d'un contrat chez
       * un fournisseur qui ne le connaît pas — avec les identifiants du Panel.
       */
      throw capabilityNotAvailable(code, `NO_SIGNATURE_ADAPTER_FOR_${provider || 'UNKNOWN'}`);
    }
    return table[code](args);
  }]));
}

export function hasAdapter(code) {
  return Object.hasOwn(ADAPTERS, String(code));
}

export function listAdaptedCapabilities() {
  return Object.keys(ADAPTERS);
}

/**
 * Exécute une capacité chez son fournisseur.
 *
 * @param {object} args
 * @param {object} args.definition   définition du registre
 * @param {object} args.context      contexte d'invocation (jamais transmis à l'adaptateur brut)
 * @param {object} args.credentials  valeurs en clair — n'en ressortent pas
 * @param {object} args.input        entrée DÉJÀ validée par le schéma
 * @param {Function} [args.fetchImpl] injectable : les tests ne sortent pas sur le réseau
 * @returns {Promise<object>} sortie métier, non encore validée par son schéma
 * @throws {CapabilityError}
 */
export async function executeCapability({ definition, context, credentials, input, fetchImpl }) {
  const adapter = ADAPTERS[definition.code];
  if (!adapter) {
    // Cas impossible si l'alignement tient — et c'est désormais la SEULE
    // défense contre une capacité fantôme au moment de l'exécution, puisque la
    // passerelle ne teste plus aucun booléen de migration en amont. Une garde
    // qui ne sert jamais coûte une ligne ; son absence coûte une exception nue.
    throw capabilityNotAvailable(definition.code, 'NO_ADAPTER');
  }

  try {
    return await adapter({ definition, context, credentials, input, fetchImpl });
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw translateTransportError(error, definition);
  }
}

/**
 * LA GARDE ANTI-CAPACITÉ FANTÔME — bijection stricte registre ↔ adaptateurs.
 *
 * ── CE QU'ELLE EXIGE, ET POURQUOI DANS LES DEUX SENS ────────────────────────
 *
 *   registre sans adaptateur  →  une capacité que l'écran annonce, que l'API
 *                                accepte, et qui refuse à l'exécution. C'est
 *                                exactement l'état « accordée, mais pas encore
 *                                servie » que la simplification a supprimé.
 *
 *   adaptateur sans registre  →  un chemin d'exécution qu'aucun écran ne
 *                                mentionne, donc que personne n'audite.
 *
 * Ce contrôle existait déjà, mais il s'appuyait sur le booléen `migrated` : une
 * capacité déclarée non migrée SATISFAISAIT la garde en n'ayant pas
 * d'adaptateur. Le booléen offrait donc une dispense permanente, et
 * `billing.subscription.reconcile` l'a utilisée pendant toute sa vie. Sans lui,
 * la seule façon de satisfaire cette fonction est d'écrire l'exécutant.
 *
 * @returns {string[]} problèmes, vide si tout s'accorde.
 */
export function assertAdapterAlignment(definitions) {
  const problems = [];
  const declared = new Set();

  for (const definition of definitions) {
    declared.add(definition.code);
    if (!hasAdapter(definition.code)) {
      problems.push(`« ${definition.code} » est déclarée au registre mais n’a aucun adaptateur.`);
    }
  }

  for (const code of listAdaptedCapabilities()) {
    if (!declared.has(code)) {
      problems.push(`« ${code} » a un adaptateur mais n’est déclarée dans aucun registre.`);
    }
  }

  return problems;
}

export default {
  executeCapability,
  hasAdapter,
  listAdaptedCapabilities,
  assertAdapterAlignment,
  translateTransportError,
};
