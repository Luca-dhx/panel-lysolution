// LA PASSERELLE — une seule porte, un seul ordre (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md.
//
// ── L'ORDRE, ET POURQUOI IL EST CELUI-LÀ ────────────────────────────────────
//
//   1. la capacité existe-t-elle ?            registre code-first, fail closed
//   2. qui parle ?                            jeton de pont, jamais la charge utile
//   3. quel monde ?                           runtime de l'instance (L2)
//   4. a-t-il le droit ?                      octrois de capacité (L3)
//   5. le commerce est-il ouvert ?            politique L1.75
//   6. la capacité est-elle servie ?          adaptateur présent
//   7. l'entrée est-elle conforme ?           schéma strict
//   8. a-t-on des identifiants ?              coffre L1
//   9. exécuter                               adaptateur
//
// Trois choix d'ordre méritent une justification, parce qu'ils ne sont pas
// interchangeables :
//
// · La POLITIQUE COMMERCIALE passe AVANT la disponibilité de l'adaptateur et
//   AVANT les identifiants. C'est ce qui garantit qu'une écriture financière
//   refusée en pré-ouverture ne touche RIEN — pas même le coffre. Si l'on
//   testait d'abord « est-ce migré ? », la preuve « zéro appel fournisseur »
//   reposerait sur l'absence d'adaptateur, c'est-à-dire sur un accident de
//   calendrier, et non sur la politique.
//
// · L'ENTRÉE est validée AVANT les identifiants. Un corps malformé ne doit pas
//   faire déchiffrer une clé : le coffre ne s'ouvre que pour un appel qui va
//   réellement partir.
//
// · L'ENVIRONNEMENT est résolu AVANT tout le reste, et l'ouverture commerciale
//   ne le modifie JAMAIS. Une instance en pré-ouverture est en PROD : on lui
//   refuse d'agir, on ne la bascule pas en TEST. Confondre les deux recréerait
//   `activeMode` sous un autre nom — exactement ce que L2 a supprimé.
//
// ── CE QUE LE PROJET NE PEUT PAS FAIRE ──────────────────────────────────────
//
// Choisir un fournisseur, un environnement, un jeu d'identifiants, une URL.
// Il choisit un VERBE et son entrée métier. Tout le reste est déduit de son
// jeton d'appairage et de l'instance qui répond.
import logger from '../../utils/logger.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import { canExecute, DECISION } from '../integratedApi/commercialReadiness.js';
import { getCapabilityDefinition } from './capabilityRegistry.js';
import { INVOCATION_SOURCES, buildInvocationContext, describeContext } from './invocationContext.js';
import { assertGranted } from './capabilityGrants.js';
import { resolveCredentialsForCapability } from './credentialResolver.js';
import { executeCapability } from './providerAdapters.js';
import {
  CAPABILITY_OUTCOMES,
  CapabilityError,
  capabilityUnknown,
  capabilityNotAvailable,
  capabilityBlockedPreopening,
  capabilityInputInvalid,
} from './capabilityErrors.js';

/**
 * Invoque une capacité pour le compte d'un projet AUTHENTIFIÉ.
 *
 * @param {object} args
 * @param {string} args.code           code de capacité demandé
 * @param {object} args.panelProject   fiche rendue par `requireBridgeAuth`
 * @param {object} [args.payload]      corps de la requête — NON fiable
 * @param {string} [args.requestId]
 * @param {Function} [args.fetchImpl]  injectable : les tests ne sortent pas
 * @returns {Promise<{capability, provider, environment, outcome, result, requestId, durationMs}>}
 * @throws {CapabilityError}
 */
export async function invokeCapability({ code, panelProject, payload = {}, requestId, fetchImpl }) {
  // ── 1. LA CAPACITÉ EXISTE-T-ELLE ? ────────────────────────────────────────
  // Avant même de savoir qui parle : un code inconnu ne mérite ni contexte, ni
  // lecture de fiche, ni journal d'invocation.
  const definition = getCapabilityDefinition(code);
  if (!definition) throw capabilityUnknown(code);

  // ── 2. QUI PARLE, ET 3. DANS QUEL MONDE ? ─────────────────────────────────
  /**
   * LA CONSTRUCTION DU CONTEXTE PEUT ELLE-MÊME REFUSER — et ce refus-là est
   * précisément celui qu'on veut lire.
   *
   * Une usurpation (`projectId` étranger) et un désaccord de monde échouent
   * ICI, avant tout le reste. Les laisser remonter sans trace serait perdre le
   * seul signal qui distingue un client mal écrit d'une tentative délibérée —
   * et c'est la ligne qu'un opérateur viendra chercher en premier.
   *
   * On journalise donc avec un contexte MINIMAL, bâti sur la seule autorité
   * dont on dispose à coup sûr : le projet que le jeton a authentifié.
   */
  let context;
  try {
    context = buildInvocationContext({ panelProject, payload, requestId });
  } catch (error) {
    await audit(fallbackContext(panelProject, requestId), definition, {
      outcome: error instanceof CapabilityError ? error.outcome : CAPABILITY_OUTCOMES.FAILED,
      durationMs: 0,
      errorCode: error?.code ?? 'UNEXPECTED',
      operationId: typeof payload?.operationId === 'string' ? payload.operationId : null,
    });
    throw error;
  }

  try {
    // ── 4. A-T-IL LE DROIT ? ────────────────────────────────────────────────
    assertGranted(context, definition);

    // ── 5. LE COMMERCE EST-IL OUVERT POUR CET EFFET ? ───────────────────────
    // Rien n'a encore été lu du coffre, aucun adaptateur n'a été atteint : un
    // refus ici garantit zéro contact fournisseur, par construction.
    const verdict = canExecute({
      capability: definition.code,
      commercialState: context.commercialState,
    });
    if (verdict.decision !== DECISION.ALLOWED) {
      if (verdict.decision === DECISION.BLOCKED_PREOPENING) {
        throw capabilityBlockedPreopening(definition.code, definition.effectNature);
      }
      // `UNKNOWN_CAPABILITY` / `INVALID_STATE` : la politique ne sait pas
      // trancher. Fail closed — on ne devine pas le droit d'agir pour de vrai.
      throw capabilityNotAvailable(definition.code, verdict.decision);
    }

    // ── 6. LA CAPACITÉ EST-ELLE SERVIE ? ────────────────────────────────────
    if (!definition.migrated) {
      throw capabilityNotAvailable(definition.code, 'NOT_MIGRATED');
    }

    // ── 7. L'ENTRÉE EST-ELLE CONFORME ? ─────────────────────────────────────
    const input = parseInput(definition, payload);

    // ── 8. A-T-ON DES IDENTIFIANTS ? ET 9. EXÉCUTER ─────────────────────────
    // Les valeurs déchiffrées sont obtenues et consommées dans la même
    // expression : elles ne sont jamais liées à une variable de portée large,
    // jamais journalisées, jamais attachées à une erreur.
    const resolved = await resolveCredentialsForCapability(context, definition);
    const raw = await executeCapability({
      definition,
      context,
      credentials: resolved.values,
      input,
      fetchImpl,
    });

    const result = parseOutput(definition, raw);
    const durationMs = Date.now() - context.startedAt;

    await audit(context, definition, {
      outcome: CAPABILITY_OUTCOMES.SUCCEEDED,
      durationMs,
      operationId: input.operationId ?? null,
    });

    return {
      capability: definition.code,
      provider: definition.provider,
      environment: context.environment,
      outcome: CAPABILITY_OUTCOMES.SUCCEEDED,
      operationId: input.operationId ?? null,
      requestId: context.requestId,
      durationMs,
      result,
    };
  } catch (error) {
    const durationMs = Date.now() - context.startedAt;
    const outcome = error instanceof CapabilityError ? error.outcome : CAPABILITY_OUTCOMES.FAILED;
    await audit(context, definition, {
      outcome,
      durationMs,
      errorCode: error?.code ?? 'UNEXPECTED',
      // La clé d'idempotence du projet, si elle était lisible. Elle lui permet
      // de rapprocher son propre journal du nôtre quand il vient nous demander
      // ce qui s'est passé.
      operationId: typeof payload?.operationId === 'string' ? payload.operationId : null,
    });
    throw error;
  }
}

/**
 * Contexte de SECOURS — juste assez pour tracer un refus survenu avant qu'un
 * vrai contexte ait pu exister.
 *
 * `environment` y est `null` : c'est un aveu, pas une valeur par défaut. Écrire
 * « TEST » ferait croire qu'on a résolu un monde alors que le refus porte
 * précisément sur cette résolution.
 */
function fallbackContext(panelProject, requestId) {
  return {
    projectId: panelProject?.projectId ?? null,
    environment: null,
    commercialState: null,
    requestId: requestId ?? null,
    source: INVOCATION_SOURCES.PROJECT_BRIDGE,
  };
}

/* -------------------------------------------------------------------------- */
/*  CONTRATS D'ENTRÉE ET DE SORTIE                                            */
/* -------------------------------------------------------------------------- */

/**
 * Valide l'entrée contre le schéma STRICT de la capacité.
 *
 * ── POURQUOI AUCUN PASSAGE ARBITRAIRE ───────────────────────────────────────
 *
 * Le schéma refuse les clés inconnues. Un projet qui envoie
 * `{ recipient, environment: 'PROD' }` reçoit donc un refus explicite, et non
 * un silence. Le champ serait inerte aujourd'hui — mais sa présence tolérée
 * ferait croire, à qui relit le code du projet, qu'il agit ; et un jour
 * quelqu'un le brancherait pour « faire marcher ce qui était déjà envoyé ».
 *
 * Le diagnostic rendu NOMME les chemins fautifs, jamais leurs valeurs : une
 * entrée refusée peut contenir une adresse, et un message d'erreur voyage.
 */
function parseInput(definition, payload) {
  const result = definition.inputSchema.safeParse(payload ?? {});
  if (!result.success) {
    throw capabilityInputInvalid(
      definition.code,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(racine)',
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Valide la SORTIE avant de la rendre au projet.
 *
 * Un adaptateur est du code que nous écrivons : le contrôler peut sembler
 * superflu. Ce n'est pas une défiance envers l'adaptateur, c'est une garantie
 * sur ce qui SORT : le schéma est `strict()`, donc un champ ajouté par
 * inadvertance — un objet de réponse fournisseur laissé au passage, un
 * identifiant de compte — fait échouer l'appel au lieu de traverser le pont.
 */
function parseOutput(definition, raw) {
  const result = definition.outputSchema.safeParse(raw);
  if (!result.success) {
    // Le détail reste INTERNE : un défaut de notre adaptateur ne se diagnostique
    // pas depuis le projet, et sa description pourrait citer ce qui a fuité.
    logger.error(
      `[capabilities] sortie non conforme pour ${definition.code} : `
      + result.error.issues.map((i) => i.path.join('.')).join(', '),
    );
    throw capabilityNotAvailable(definition.code, 'OUTPUT_CONTRACT_VIOLATION');
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/*  OBSERVABILITÉ                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Journalise une invocation — succès comme refus.
 *
 * ── CE QUI EST ÉCRIT, ET RIEN D'AUTRE ───────────────────────────────────────
 *
 * capacité, fournisseur, projet, environnement, requête, opération, durée,
 * issue, code d'erreur. Aucune entrée métier, aucune adresse, aucune sortie,
 * aucun identifiant de credential, aucune clé. Ce journal doit pouvoir être lu
 * par n'importe quel opérateur du Panel sans précaution.
 *
 * ── POURQUOI BEST-EFFORT ────────────────────────────────────────────────────
 *
 * Une invocation réussie dont la trace échoue reste une invocation réussie :
 * l'action a eu lieu chez le fournisseur, et lever ici ferait croire au projet
 * qu'elle n'a pas eu lieu — c'est-à-dire l'inciterait à la rejouer.
 */
async function audit(context, definition, { outcome, durationMs, errorCode = null, operationId = null }) {
  const observation = {
    capability: definition.code,
    provider: definition.provider,
    ...describeContext(context),
    operationId,
    durationMs,
    outcome,
    errorCode,
  };

  logger.info(`[capabilities] ${JSON.stringify(observation)}`);

  await recordEvent({
    projectId: context.projectId,
    type: outcome === CAPABILITY_OUTCOMES.SUCCEEDED
      ? EVENT_TYPES.CAPABILITY_INVOKED
      : EVENT_TYPES.CAPABILITY_REFUSED,
    source: 'PANEL',
    severity: outcome === CAPABILITY_OUTCOMES.SUCCEEDED
      ? 'INFO'
      // Une issue INCONNUE est plus grave qu'un refus : quelqu'un doit trancher.
      : outcome === CAPABILITY_OUTCOMES.UNKNOWN ? 'ERROR' : 'WARNING',
    summary: outcome === CAPABILITY_OUTCOMES.SUCCEEDED
      ? `Capacité « ${definition.code} » exécutée (${definition.provider}, ${context.environment}).`
      : `Capacité « ${definition.code} » non exécutée — ${errorCode ?? outcome}.`,
    data: observation,
  }).catch(() => {});
}

export default { invokeCapability };
