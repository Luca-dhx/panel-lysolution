// RÉCONCILIATION — état désiré, état observé, et l'écart entre les deux (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Réconciliation ».
//
// ── LA QUESTION À LAQUELLE CE FICHIER RÉPOND ────────────────────────────────
//
// Pas « ai-je un identifiant de webhook en base ? » — cette question-là ne
// prouve rien. Un identifiant persisté dit qu'on a créé un endpoint un jour ;
// il ne dit pas qu'il existe encore, ni qu'il pointe où il faut, ni qu'il
// écoute les bons événements, ni qu'on sait vérifier ce qu'il envoie.
//
// La question est : « ce que le Panel VEUT et ce que le fournisseur EXPOSE
// coïncident-ils, et depuis quand le sait-on ? »
//
// ── QUATRE PROPRIÉTÉS, ET AUCUNE N'EST NÉGOCIABLE ───────────────────────────
//
//  1. IDEMPOTENTE — deux passages consécutifs sur un système conforme ne
//     produisent AUCUN appel d'écriture. Un réconciliateur qui « répare » un
//     système sain finit par être désactivé.
//  2. REJOUABLE ET SÛRE AU CRASH — le jeton d'appartenance est écrit AVANT le
//     premier appel de création. Un processus tué entre les deux laisse un
//     endpoint que le passage suivant reconnaît comme le sien.
//  3. NON DESTRUCTIVE PAR DÉFAUT — on ne supprime QUE ce qu'on prouve avoir
//     créé (`webhookOwnership.js`). Un compte fournisseur est partagé.
//  4. ORDRE « CRÉER → VÉRIFIER → RETIRER » — retirer d'abord ouvrirait une
//     fenêtre pendant laquelle personne n'écoute, et les événements de cette
//     fenêtre sont perdus DÉFINITIVEMENT. Aucun fournisseur ne les rejoue.
//
// ── CE QUE CE FICHIER NE FAIT PAS ───────────────────────────────────────────
//
// Il ne dispatche rien. Il ne traduit aucun événement en verbe métier. Il ne
// touche à aucun appel Stripe/Brevo/Yousign autre que le CRUD de l'endpoint.
// L6, L7 et L8 possèdent leurs providers ; ce lot leur pose le sol.
import { randomUUID } from 'node:crypto';

import logger from '../../utils/logger.js';
import ApiError from '../../utils/ApiError.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelIntegratedApiWebhookBinding, {
  WEBHOOK_DRIFT_KINDS,
} from '../../models/PanelIntegratedApiWebhookBinding.model.js';
import { runtimeEnvironment } from '../integratedApi/environment.js';
import {
  webhookCapability,
  listWebhookCapabilities,
  SECRET_DELIVERY,
} from './webhookRegistry.js';
import { resolveWebhookCallback, assertCallbackEnvironment, sameCallback } from './webhookCallback.js';
import { webhookAdapterFor } from './providerWebhookAdapters.js';
import { descriptionFor, mintOwnershipToken, partitionRemote, mayDelete } from './webhookOwnership.js';
import {
  loadProviderCredentials,
  hasWebhookSecret,
  storeWebhookSecret,
  secretToSupplyAtCreation,
} from './webhookSecrets.js';
import {
  WEBHOOK_STATUS,
  WEBHOOK_DIAGNOSTIC,
  WebhookError,
  safeMessage,
  statusForDiagnostic,
  severityFor,
} from './webhookDiagnostics.js';

/* -------------------------------------------------------------------------- */
/*  SÉRIALISATION                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Une réconciliation à la fois par (fournisseur, environnement).
 *
 * Deux passages concurrents liraient la même liste distante, y verraient tous
 * deux « aucun endpoint », et en créeraient deux. L'index unique du binding
 * empêche le doublon EN BASE ; cette file empêche l'appel distant en double,
 * qui aurait déjà consommé une place sur le plafond de 16.
 */
const chains = new Map();

function serialize(key, work) {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(key, next.catch(() => {}));
  return next;
}

/* -------------------------------------------------------------------------- */
/*  PERSISTANCE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Le binding, créé s'il n'existe pas.
 *
 * `$setOnInsert` frappe le jeton d'appartenance : il précède donc TOUT appel
 * distant, ce qui est la condition de la sûreté au crash (propriété 2).
 */
async function ensureBinding(provider, environment, capability) {
  const at = nowIso();
  return PanelIntegratedApiWebhookBinding.findOneAndUpdate(
    { provider, environment },
    {
      $set: { callbackSlug: capability.callbackSlug, updatedAt: at },
      $setOnInsert: {
        bindingId: randomUUID(),
        ownershipToken: mintOwnershipToken(),
        status: WEBHOOK_STATUS.PENDING,
        createdAt: at,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

async function patchBinding(bindingId, patch) {
  await PanelIntegratedApiWebhookBinding.updateOne(
    { bindingId },
    { $set: { ...patch, updatedAt: nowIso() } },
  );
}

/** État terminal SANS erreur — l'erreur précédente est effacée, pas conservée. */
function readyPatch({ status, drift, observed, secretConfigured }) {
  const at = nowIso();
  return {
    status,
    drift,
    observedUrl: observed?.url ?? '',
    observedEvents: observed?.events ?? [],
    observedEnabled: observed?.enabled ?? null,
    observedDescription: observed?.description ?? '',
    remoteWebhookId: observed?.id ?? null,
    secretConfigured,
    lastCheckedAt: at,
    lastReconciledAt: at,
    lastErrorCode: null,
    lastErrorMessage: '',
    lastErrorAt: null,
  };
}

/** État terminal AVEC diagnostic. L'observation déjà acquise est conservée. */
function failurePatch(code, message) {
  const at = nowIso();
  return {
    status: statusForDiagnostic(code),
    lastCheckedAt: at,
    lastErrorCode: code,
    lastErrorMessage: safeMessage(message),
    lastErrorAt: at,
  };
}

/* -------------------------------------------------------------------------- */
/*  DIVERGENCE                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Écart entre un endpoint observé et l'état désiré.
 *
 * ── UN CHOIX QUI MÉRITE D'ÊTRE DIT ──────────────────────────────────────────
 * Un événement DÉSIRÉ mais absent est une divergence : il manque, on ne le
 * recevra pas. Un événement EN TROP n'en est pas une. Les fournisseurs
 * normalisent, regroupent et renomment leurs libellés d'événements ; traiter
 * chaque écart d'étiquette comme une dérive produirait un `update` à chaque
 * passage, éternellement — un réconciliateur qui ne converge jamais.
 */
export function computeDrift(observed, desired, capability = null) {
  const drift = [];
  if (!observed) return [WEBHOOK_DRIFT_KINDS.MISSING];
  if (!sameCallback(observed.url, desired.url)) drift.push(WEBHOOK_DRIFT_KINDS.URL);

  // La comparaison d'événements est une CAPACITÉ du fournisseur : Brevo
  // re-collapse certains libellés, et une comparaison littérale déclarerait
  // une divergence perpétuelle sur un webhook parfaitement fonctionnel.
  const compare = capability?.compareEvents
    ?? ((remote, wanted) => {
      const present = new Set(remote ?? []);
      if (present.has('*')) return { aligned: true, missing: [] };
      const missing = wanted.filter((event) => !present.has(event));
      return { aligned: missing.length === 0, missing };
    });
  if (!compare(observed.events ?? [], desired.events).aligned) {
    drift.push(WEBHOOK_DRIFT_KINDS.EVENTS);
  }
  if (observed.enabled === false) drift.push(WEBHOOK_DRIFT_KINDS.DISABLED);
  if (desired.description && observed.description !== desired.description) {
    drift.push(WEBHOOK_DRIFT_KINDS.DESCRIPTION);
  }
  return drift;
}

/* -------------------------------------------------------------------------- */
/*  RÉCONCILIATION D'UN FOURNISSEUR                                           */
/* -------------------------------------------------------------------------- */

/**
 * Aligne l'endpoint d'un fournisseur sur l'état désiré.
 *
 * @param {object} args
 * @param {string} args.provider
 * @param {'TEST'|'PROD'} [args.environment]  celui servi ici, et refusé sinon
 * @param {Function} [args.fetchImpl]         injectable : la recette ne sort jamais
 * @param {boolean} [args.allowCreate]        `false` = observer sans créer
 * @param {boolean} [args.allowDelete]        `false` = observer sans supprimer
 * @returns {Promise<object>} le rapport — NE LÈVE PAS pour un échec fournisseur
 */
export async function reconcileProviderWebhook({
  provider,
  environment = runtimeEnvironment(),
  fetchImpl,
  allowCreate = true,
  allowDelete = true,
} = {}) {
  const capability = webhookCapability(provider);
  if (!capability) {
    throw ApiError.notFound(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_PROVIDER_UNKNOWN,
      `Réconciliation impossible : « ${provider} » n’est pas au registre.`,
    );
  }

  // Un fournisseur sans webhook n'écrit AUCUN binding. Un enregistrement vide
  // se lirait comme un webhook en panne, et quelqu'un finirait par chercher
  // pourquoi Hostinger « ne reçoit rien ».
  if (!capability.supported) {
    return {
      provider: capability.provider,
      environment,
      status: WEBHOOK_STATUS.UNSUPPORTED,
      supported: false,
      reason: capability.unsupportedReason,
      created: false,
      updated: false,
      deleted: 0,
      drift: [],
      severity: severityFor(capability.provider, WEBHOOK_STATUS.UNSUPPORTED),
    };
  }

  // FAIL CLOSED, et avant toute écriture : une callback PROD ne s'enregistre
  // jamais depuis une instance TEST.
  assertCallbackEnvironment(environment);

  return serialize(`${capability.provider}:${environment}`, () =>
    runReconciliation({ capability, environment, fetchImpl, allowCreate, allowDelete }));
}

async function runReconciliation({ capability, environment, fetchImpl, allowCreate, allowDelete }) {
  const provider = capability.provider;
  const binding = await ensureBinding(provider, environment, capability);

  const outcome = {
    provider,
    environment,
    supported: true,
    bindingId: binding.bindingId,
    created: false,
    updated: false,
    deleted: 0,
    secretCaptured: false,
    peersLeftAlone: 0,
    foreignLeftAlone: 0,
    drift: [],
    status: WEBHOOK_STATUS.PENDING,
  };

  /** Termine sur un diagnostic, sans jamais lever. */
  const fail = async (code, message) => {
    await patchBinding(binding.bindingId, failurePatch(code, message));
    outcome.status = statusForDiagnostic(code);
    outcome.code = code;
    outcome.message = safeMessage(message);
    outcome.severity = severityFor(provider, outcome.status);
    return outcome;
  };

  // ── 1. L'adresse à enregistrer ─────────────────────────────────────────
  const callback = await resolveWebhookCallback(provider, { environment });
  if (!callback.ready) {
    return fail(
      callback.code ?? WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC,
      'Aucune adresse publique résolue pour ce Panel : rien à enregistrer chez le fournisseur.',
    );
  }

  const desired = {
    url: callback.url,
    events: [...capability.desiredEvents],
    description: descriptionFor(binding),
  };

  // ── 2. Les identifiants d'administration ───────────────────────────────
  let credentials;
  try {
    credentials = await loadProviderCredentials(provider, environment);
  } catch (err) {
    return fail(err?.code ?? WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING, err?.message);
  }
  if (!credentials?.[capability.apiCredentialRole]) {
    return fail(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING,
      `« ${capability.apiCredentialRole} » n’est pas renseigné pour ${provider} en ${environment}.`,
    );
  }

  const adapter = webhookAdapterFor(provider);
  if (!adapter) {
    return fail(WEBHOOK_DIAGNOSTIC.WEBHOOK_UNSUPPORTED, `Aucun pilote distant pour ${provider}.`);
  }
  // Le descripteur voyage avec le contexte : un pilote a parfois besoin de
  // connaître une particularité de son fournisseur (chez Brevo, les réponses
  // qui signifient « liste vide » plutôt que « panne »).
  const ctx = { credentials, environment, fetchImpl, capability };

  // L'intention est persistée AVANT le premier appel distant : un crash laisse
  // une trace lisible (« une réconciliation était en cours »), pas un silence.
  await patchBinding(binding.bindingId, {
    status: WEBHOOK_STATUS.RECONCILING,
    desiredUrl: desired.url,
    desiredEvents: desired.events,
    lastCheckedAt: nowIso(),
  });

  // ── 3. Ce que le fournisseur expose réellement ─────────────────────────
  let remoteList;
  try {
    remoteList = await adapter.list(ctx);
  } catch (err) {
    return fail(err?.code ?? WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_ERROR, err?.message);
  }

  let { owned, peers, foreign } = partitionRemote(remoteList, binding);
  outcome.peersLeftAlone = peers.length;
  outcome.foreignLeftAlone = foreign.length;

  // ── 4. Préflight du plafond (roadmap §8.2 — Stripe : 16 par compte) ────
  //
  // Se heurter au plafond PENDANT une création laisse un compte saturé et un
  // diagnostic obscur. On regarde avant, et on le dit.
  if (owned.length === 0 && capability.remoteEndpointLimit
      && remoteList.length >= capability.remoteEndpointLimit) {
    return fail(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_LIMIT_REACHED,
      `${remoteList.length} endpoints déjà enregistrés chez ${provider} pour un plafond de `
      + `${capability.remoteEndpointLimit} : la création est refusée avant d’être tentée. `
      + `C’est exactement la saturation que la centralisation supprime — un endpoint `
      + `par environnement, quel que soit le nombre de projets.`,
    );
  }

  let secretPresent = await hasWebhookSecret(provider, environment);

  try {
    // ── 5. Aucun endpoint à nous : créer ────────────────────────────────
    if (owned.length === 0) {
      if (!allowCreate) {
        await patchBinding(binding.bindingId, {
          ...failurePatch(WEBHOOK_DIAGNOSTIC.WEBHOOK_DRIFT, 'Endpoint absent — création non demandée.'),
          drift: [WEBHOOK_DRIFT_KINDS.MISSING],
          observedUrl: '', observedEvents: [], remoteWebhookId: null,
        });
        outcome.status = WEBHOOK_STATUS.DRIFTED;
        outcome.drift = [WEBHOOK_DRIFT_KINDS.MISSING];
        outcome.severity = severityFor(provider, outcome.status);
        return outcome;
      }
      const created = await createOwnedEndpoint({ adapter, ctx, capability, desired, environment, provider });
      outcome.created = true;
      outcome.secretCaptured = created.secretCaptured;
      secretPresent = secretPresent || created.secretCaptured;
    } else {
      // ── 6. Un endpoint à nous existe ──────────────────────────────────
      const keeper = owned.find((w) => String(w.id) === String(binding.remoteWebhookId)) ?? owned[0];

      // Cas A du §Secrets : le fournisseur ne relivrera JAMAIS le secret. Un
      // endpoint qu'on ne sait pas vérifier n'est pas « configuré » — il est
      // sourd. La seule réparation honnête est d'en obtenir un neuf, dans
      // l'ordre créer → vérifier → retirer, pour ne jamais laisser de fenêtre
      // sans écoute.
      if (!secretPresent && capability.secretDelivery === SECRET_DELIVERY.AT_CREATION_ONLY) {
        if (!allowCreate) {
          return fail(
            WEBHOOK_DIAGNOSTIC.WEBHOOK_SIGNATURE_CONFIGURATION_INVALID,
            'Endpoint présent, secret de vérification absent : recréation nécessaire, non demandée.',
          );
        }
        const created = await createOwnedEndpoint({ adapter, ctx, capability, desired, environment, provider });
        outcome.created = true;
        outcome.secretCaptured = created.secretCaptured;
        secretPresent = created.secretCaptured;
        if (allowDelete && mayDelete(keeper, binding) && String(keeper.id) !== String(created.id)) {
          await adapter.remove(ctx, keeper.id);
          outcome.deleted += 1;
        }
        owned = owned.filter((w) => String(w.id) !== String(keeper.id));
      } else {
        const drift = computeDrift(keeper, desired, capability);
        if (drift.length) {
          // `update` en place : c'est le chemin SÛR, il préserve le secret.
          await adapter.update(ctx, keeper.id, { ...desired, environment });
          outcome.updated = true;
        }
        await patchBinding(binding.bindingId, { remoteWebhookId: String(keeper.id) });
      }
    }

    // ── 7. VÉRIFIER — relire avant de retirer quoi que ce soit ──────────
    let verified = remoteList;
    if (outcome.created || outcome.updated || outcome.deleted) {
      verified = await adapter.list(ctx);
    }
    const after = partitionRemote(verified, { ...binding, remoteWebhookId: null });
    const keeper = pickKeeper(after.owned, desired, capability);

    // ── 8. RETIRER les doublons — et EUX SEULS ─────────────────────────
    //
    // Un doublon naît d'un crash entre une création et la persistance de son
    // identifiant. On ne le retire qu'APRÈS avoir constaté qu'un survivant
    // conforme existe : sinon on supprimerait la seule écoute en place.
    if (allowDelete && keeper && computeDrift(keeper, desired, capability).length === 0) {
      for (const extra of after.owned) {
        if (String(extra.id) === String(keeper.id)) continue;
        if (!mayDelete(extra, binding)) continue; // ceinture et bretelles
        await adapter.remove(ctx, extra.id);
        outcome.deleted += 1;
        logger.info(`[webhooks] ${provider}/${environment} : doublon possédé retiré (${extra.id}).`);
      }
    }

    // ── 9. Conclure sur ce qui est OBSERVÉ, jamais sur ce qu'on a voulu ──
    const drift = computeDrift(keeper, desired, capability);
    secretPresent = await hasWebhookSecret(provider, environment);

    const status = !keeper || drift.length
      ? WEBHOOK_STATUS.DRIFTED
      : secretPresent || !capability.supportsSignatureVerification
        ? WEBHOOK_STATUS.READY
        : WEBHOOK_STATUS.WARNING;

    await patchBinding(binding.bindingId, {
      ...readyPatch({ status, drift, observed: keeper, secretConfigured: secretPresent }),
      ...(status === WEBHOOK_STATUS.WARNING
        ? {
          lastErrorCode: WEBHOOK_DIAGNOSTIC.WEBHOOK_SIGNATURE_CONFIGURATION_INVALID,
          lastErrorMessage: 'Endpoint en place, mais aucun secret ne permet de vérifier ses appels.',
          lastErrorAt: nowIso(),
        }
        : {}),
      ...(status === WEBHOOK_STATUS.DRIFTED
        ? {
          lastErrorCode: WEBHOOK_DIAGNOSTIC.WEBHOOK_DRIFT,
          lastErrorMessage: `Divergence persistante : ${drift.join(', ') || 'endpoint absent'}.`,
          lastErrorAt: nowIso(),
        }
        : {}),
    });

    outcome.status = status;
    outcome.drift = drift;
    outcome.remoteWebhookId = keeper?.id ?? null;
    outcome.secretConfigured = secretPresent;
    outcome.severity = severityFor(provider, status);
    return outcome;
  } catch (err) {
    if (err instanceof WebhookError) return fail(err.code, err.message);
    return fail(WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_ERROR, err?.message ?? 'Réconciliation interrompue.');
  }
}

/**
 * Choisit le survivant parmi plusieurs endpoints possédés.
 * Priorité au conforme : garder un endpoint divergent alors qu'un endpoint
 * correct existe imposerait un `update` inutile au passage suivant.
 */
function pickKeeper(owned, desired, capability) {
  if (!owned.length) return null;
  return owned.find((w) => computeDrift(w, desired, capability).length === 0) ?? owned[0];
}

/**
 * Crée l'endpoint et CAPTURE le secret dans le même souffle.
 *
 * L'ordre est imposé par le fournisseur : `create` est la seule occasion de
 * lire le `whsec_…` de Stripe ou la `secret_key` de Yousign. Le persister avant
 * de rendre la main garantit qu'un crash immédiatement après ne laisse jamais
 * un endpoint vivant que nous serions incapables de vérifier.
 */
async function createOwnedEndpoint({ adapter, ctx, capability, desired, environment, provider }) {
  const supplied = secretToSupplyAtCreation(capability);
  const result = await adapter.create(ctx, { ...desired, environment, secret: supplied });

  let secretCaptured = false;
  const secret = result?.secret ?? supplied;
  if (secret) {
    await storeWebhookSecret(provider, environment, secret);
    secretCaptured = true;
  }

  logger.info(
    `[webhooks] ${provider}/${environment} : endpoint créé (${result?.id ?? 'sans id'})`
    + `${secretCaptured ? ', secret capturé' : ', AUCUN secret rendu'}.`,
  );
  return { id: result?.id ?? null, secretCaptured };
}

/* -------------------------------------------------------------------------- */
/*  RÉCONCILIATION DE TOUT LE REGISTRE                                        */
/* -------------------------------------------------------------------------- */

/**
 * Réconcilie tous les fournisseurs supportés, et NE LÈVE JAMAIS.
 *
 * ── POURQUOI « JAMAIS » EST LITTÉRAL ────────────────────────────────────────
 * Cette fonction est appelée au démarrage du Panel et, plus tard, après un
 * déploiement. Un fournisseur momentanément indisponible ne doit casser NI le
 * démarrage, NI une release valide : le réconciliateur est idempotent, il
 * repassera. Le rapport porte la gravité, et c'est elle qu'on remonte.
 */
export async function reconcileAllProviderWebhooks({
  environment = runtimeEnvironment(),
  fetchImpl,
  allowCreate = true,
  allowDelete = true,
} = {}) {
  const results = [];
  for (const capability of listWebhookCapabilities()) {
    try {
      results.push(await reconcileProviderWebhook({
        provider: capability.provider, environment, fetchImpl, allowCreate, allowDelete,
      }));
    } catch (err) {
      results.push({
        provider: capability.provider,
        environment,
        supported: capability.supported,
        status: WEBHOOK_STATUS.ERROR,
        code: err?.code ?? WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_ERROR,
        message: safeMessage(err?.message),
        severity: severityFor(capability.provider, WEBHOOK_STATUS.ERROR),
      });
    }
  }

  const warnings = results.filter((r) => r.status !== WEBHOOK_STATUS.READY
    && r.status !== WEBHOOK_STATUS.UNSUPPORTED);

  return {
    environment,
    checkedAt: nowIso(),
    results,
    /** Un webhook ne fait JAMAIS échouer un déploiement (roadmap §8.4). */
    blocking: false,
    warnings: warnings.map((r) => ({
      provider: r.provider, status: r.status, code: r.code ?? null, severity: r.severity,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE — aucun appel distant                                             */
/* -------------------------------------------------------------------------- */

/**
 * L'état connu d'un webhook, SANS sortir sur le réseau.
 *
 * C'est ce que l'écran et le diagnostic consomment. Il dit toujours QUAND on a
 * regardé : un état sans date est un état auquel on ne peut pas se fier.
 */
export async function describeWebhookState(provider, { environment = runtimeEnvironment() } = {}) {
  const capability = webhookCapability(provider);
  if (!capability) {
    throw ApiError.notFound(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_PROVIDER_UNKNOWN,
      `« ${provider} » n’est pas au registre des fournisseurs.`,
    );
  }

  const common = {
    provider: capability.provider,
    environment,
    supported: capability.supported,
    signatureScheme: capability.signatureScheme,
    /** Faux pour Brevo : authentifié, jamais prouvé. La nuance remonte. */
    signatureProves: capability.supportsSignatureVerification
      && capability.signatureScheme.startsWith('HMAC_'),
    secretDelivery: capability.secretDelivery,
    remoteEndpointLimit: capability.remoteEndpointLimit,
  };

  if (!capability.supported) {
    return {
      ...common,
      status: WEBHOOK_STATUS.UNSUPPORTED,
      reason: capability.unsupportedReason,
      callbackUrl: '',
      desiredEvents: [],
      drift: [],
      lastCheckedAt: null,
      lastReconciledAt: null,
      lastError: null,
      secretConfigured: false,
    };
  }

  const [binding, callback] = await Promise.all([
    PanelIntegratedApiWebhookBinding.findOne({ provider: capability.provider, environment }).lean(),
    resolveWebhookCallback(capability.provider, { environment }).catch(() => null),
  ]);

  return {
    ...common,
    status: binding?.status ?? WEBHOOK_STATUS.PENDING,
    /** Une réconciliation interrompue est un fait, pas un état stable. */
    interrupted: binding?.status === WEBHOOK_STATUS.RECONCILING,
    callbackUrl: callback?.url ?? '',
    callbackReady: Boolean(callback?.ready),
    callbackSource: callback?.source ?? 'NONE',
    desiredUrl: binding?.desiredUrl ?? '',
    desiredEvents: binding?.desiredEvents ?? [...capability.desiredEvents],
    observedUrl: binding?.observedUrl ?? '',
    observedEvents: binding?.observedEvents ?? [],
    remoteWebhookId: binding?.remoteWebhookId ?? null,
    drift: binding?.drift ?? [],
    /** Un booléen. Jamais le secret, jamais son masque, jamais son empreinte. */
    secretConfigured: Boolean(binding?.secretConfigured),
    lastCheckedAt: binding?.lastCheckedAt ?? null,
    lastReconciledAt: binding?.lastReconciledAt ?? null,
    lastError: binding?.lastErrorCode
      ? { code: binding.lastErrorCode, message: binding.lastErrorMessage, at: binding.lastErrorAt }
      : null,
    lastEventAt: binding?.lastEventAt ?? null,
    lastEventType: binding?.lastEventType ?? null,
    eventsReceived: binding?.eventsReceived ?? 0,
    duplicatesIgnored: binding?.duplicatesIgnored ?? 0,
    severity: severityFor(capability.provider, binding?.status ?? WEBHOOK_STATUS.PENDING),
  };
}

/** L'état de tous les fournisseurs — le tableau de bord webhook. */
export async function describeAllWebhookStates({ environment = runtimeEnvironment() } = {}) {
  const states = [];
  for (const capability of listWebhookCapabilities()) {
    states.push(await describeWebhookState(capability.provider, { environment }));
  }
  return states;
}

export default {
  reconcileProviderWebhook,
  reconcileAllProviderWebhooks,
  describeWebhookState,
  describeAllWebhookStates,
  computeDrift,
};
