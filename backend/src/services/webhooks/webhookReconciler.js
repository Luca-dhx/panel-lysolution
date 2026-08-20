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
import { WEBHOOK_DESTINATION } from '../../models/PanelIntegratedApiWebhookBinding.model.js';
import {
  hasProjectVerificationSecret,
  storeProjectVerificationSecret,
} from './projectWebhookSecrets.js';
import { webhookAdapterFor } from './providerWebhookAdapters.js';
import { descriptionFor, mintOwnershipToken, partitionRemote, mayDelete } from './webhookOwnership.js';
import {
  loadProviderCredentials,
  hasWebhookSecret,
  rotateWebhookSecret,
  purgeExpiredPreviousSecret,
  isRotationWindowOpen,
  generateSharedSecret,
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
let bindingIndexesReady = null;

function serialize(key, work) {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(key, next.catch(() => {}));
  return next;
}

export async function ensureWebhookBindingIndexes() {
  if (!bindingIndexesReady) {
    bindingIndexesReady = (async () => {
      const legacyBindings = await PanelIntegratedApiWebhookBinding.find({
        $or: [{ destination: { $exists: false } }, { destination: null }],
      }).lean();

      for (const legacy of legacyBindings) {
        const explicitPanelBinding = await PanelIntegratedApiWebhookBinding.findOne({
          provider: legacy.provider,
          environment: legacy.environment,
          destination: WEBHOOK_DESTINATION.PANEL,
          projectId: null,
          _id: { $ne: legacy._id },
        }).lean();

        if (explicitPanelBinding) {
          await PanelIntegratedApiWebhookBinding.deleteOne({ _id: legacy._id });
          logger.info(
            `[webhooks] Binding legacy ${legacy.provider}/${legacy.environment} retiré : `
            + 'un binding PANEL explicite existe déjà.',
          );
          continue;
        }

        await PanelIntegratedApiWebhookBinding.updateOne(
          { _id: legacy._id },
          {
            $set: {
              destination: WEBHOOK_DESTINATION.PANEL,
              projectId: null,
              updatedAt: legacy.updatedAt ?? nowIso(),
            },
          },
        );
        logger.info(
          `[webhooks] Binding legacy ${legacy.provider}/${legacy.environment} migré vers `
          + 'destination=PANEL.',
        );
      }

      let legacyDropped = false;

      try {
        const indexes = await PanelIntegratedApiWebhookBinding.collection.indexes();
        const legacy = indexes.find((index) =>
          index.unique === true
          && JSON.stringify(index.key) === JSON.stringify({ provider: 1, environment: 1 }));

        if (legacy) {
          await PanelIntegratedApiWebhookBinding.collection.dropIndex(legacy.name);
          legacyDropped = true;
          logger.info(
            `[webhooks] Index historique « ${legacy.name} » retiré : `
            + 'l’unicité vit désormais sur (provider, environment, destination, projectId).',
          );
        }
      } catch (error) {
        logger.warn(`[webhooks] Vérification de l’index historique impossible : ${error.message}`);
      }

      await PanelIntegratedApiWebhookBinding.createIndexes();

      const indexes = await PanelIntegratedApiWebhookBinding.collection.indexes();
      const current = indexes.find((index) =>
        index.name === 'uniq_provider_environment_destination_project'
        && index.unique === true,
      );
      if (!current) {
        throw new Error(
          'L’index « uniq_provider_environment_destination_project » est absent après synchronisation.',
        );
      }

      return { legacyDropped, verified: true };
    })().catch((error) => {
      bindingIndexesReady = null;
      throw error;
    });
  }

  return bindingIndexesReady;
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
/**
 * LA PORTÉE D'UNE RÉCONCILIATION (L6.3A).
 *
 * Jusqu'ici il n'y avait rien à décider : un endpoint était celui du Panel, son
 * adresse se calculait depuis la configuration canonique, et son secret allait
 * au coffre du Panel. Une seule réponse à chaque question, donc aucune question
 * posée.
 *
 * Stripe en introduit une seconde — un endpoint qui pointe vers un PROJET —
 * sans rien changer au reste : c'est toujours le Panel qui crée, avec sa clé,
 * qui reconnaît ses endpoints à son jeton d'appartenance, qui gère la dérive et
 * le plafond. Seules trois réponses diffèrent :
 *
 *   à qui appartient le binding   →  destination + projectId
 *   quelle adresse enregistrer    →  resolveCallback()
 *   où ranger le secret capturé   →  hasSecret() / storeSecret()
 *
 * Le moteur les reçoit au lieu de les déduire. C'est ce qui permet de servir
 * les deux cas avec UN réconciliateur — donc une seule règle de dérive, une
 * seule stratégie de rotation, un seul préflight de plafond — plutôt qu'avec
 * deux systèmes destinés à diverger.
 */
export const PANEL_SECRET_POLICY = Object.freeze({
  has: (provider, environment) => hasWebhookSecret(provider, environment),
  store: (provider, environment, secret) => rotateWebhookSecret(provider, environment, secret),
});

export const PANEL_SCOPE = Object.freeze({
  destination: WEBHOOK_DESTINATION.PANEL,
  projectId: null,
  projectPublicUrl: '',
});

async function ensureBinding(provider, environment, capability, scope = PANEL_SCOPE) {
  const at = nowIso();
  return PanelIntegratedApiWebhookBinding.findOneAndUpdate(
    {
      provider,
      environment,
      destination: scope.destination,
      projectId: scope.projectId,
    },
    {
      $set: {
        callbackSlug: capability.callbackSlug,
        updatedAt: at,
        ...(scope.projectPublicUrl ? { projectPublicUrl: scope.projectPublicUrl } : {}),
      },
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
  /**
   * La description n'est comparée que chez les fournisseurs QUI EN ONT UNE.
   *
   * OpenSign n'expose aucun champ de description sur son webhook : la
   * comparaison opposerait une valeur désirée non vide à une valeur observée
   * toujours vide, et produirait une divergence que rien ne peut résoudre —
   * donc un `update` à chaque passage sur l'unique URL du compte. Le
   * descripteur le déclare (`supportsDescription: false`) plutôt que de laisser
   * le moteur le découvrir en tournant en rond.
   */
  if (capability?.supportsDescription !== false
    && desired.description && observed.description !== desired.description) {
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

  await ensureWebhookBindingIndexes();

  return serialize(`${capability.provider}:${environment}`, () =>
    runReconciliation({ capability, environment, fetchImpl, allowCreate, allowDelete }));
}

/**
 * GARANTIR L'ENDPOINT D'UN PROJET — le geste du lot L6.3A.
 *
 * ══ CE QUI CHANGE, ET CE QUI NE CHANGE PAS ══════════════════════════════════
 *
 * Ne change pas : la clé qui parle au fournisseur est celle du Panel, la
 * reconnaissance des endpoints se fait au jeton d'appartenance, la dérive se
 * calcule pareil, le plafond se vérifie avant de créer, et un secret que le
 * fournisseur ne rend qu'à la création se récupère en recréant — dans l'ordre
 * créer, puis retirer, pour ne jamais laisser de fenêtre sans écoute.
 *
 * Change : l'adresse enregistrée est celle du PROJET, et le secret capturé va
 * dans le coffre du projet plutôt que dans celui du Panel.
 *
 * ══ POURQUOI LE PROJET NE FOURNIT QUE SON ADRESSE ═══════════════════════════
 *
 * Il ne nomme ni l'endpoint, ni le compte, ni les événements. S'il pouvait
 * désigner un `we_…`, il désignerait celui d'un autre — et le Panel lui
 * rendrait un secret qui n'est pas le sien. S'il choisissait ses événements, il
 * pourrait en retirer un dont le métier dépend, et personne ne le verrait avant
 * qu'un paiement ne remonte plus.
 *
 * L'adresse elle-même est vérifiée : c'est la seule chose qu'il apporte, donc
 * la seule par laquelle il pourrait détourner la réception de quelqu'un.
 *
 * @param {object} args
 * @param {string} args.projectId          le projet — vient du jeton de pont
 * @param {string} args.publicBackendUrl   son adresse publique, telle qu'il la voit
 * @param {'TEST'|'PROD'} [args.environment]
 */
export async function ensureProjectWebhookEndpoint({
  provider,
  projectId,
  publicBackendUrl,
  callbackPath: cheminCallback,
  environment = runtimeEnvironment(),
  fetchImpl,
  allowCreate = true,
  allowDelete = true,
} = {}) {
  const capability = webhookCapability(provider);
  if (!capability) {
    throw ApiError.notFound(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_PROVIDER_UNKNOWN,
      `Provisionnement impossible : « ${provider} » n’est pas au registre.`,
    );
  }
  if (!capability.supported) {
    throw ApiError.badRequest(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_UNSUPPORTED,
      `${capability.provider} n’expose aucune administration de webhook.`,
    );
  }
  if (!projectId) {
    throw ApiError.badRequest('PANEL_PROJECT_UNKNOWN', 'Projet non identifié.');
  }

  const adresse = normalizeProjectCallback(publicBackendUrl, cheminCallback, environment);

  // FAIL CLOSED, comme pour le Panel : une callback PROD ne s'enregistre jamais
  // depuis une instance TEST, quel que soit le destinataire.
  assertCallbackEnvironment(environment);

  const scope = Object.freeze({
    destination: WEBHOOK_DESTINATION.PROJECT,
    projectId,
    projectPublicUrl: adresse.publicBackendUrl,
  });

  /**
   * LE COFFRE DU PROJET, JAMAIS CELUI DU PANEL.
   *
   * Se tromper ici écraserait le secret de l'endpoint du Panel avec celui d'un
   * projet : le Panel cesserait de vérifier ses propres événements, et
   * l'incident serait attribué au fournisseur.
   */
  const secretPolicy = Object.freeze({
    has: (prov, env, portee) => hasProjectVerificationSecret({
      projectId: portee.projectId, provider: prov, environment: env,
    }),
    store: async (prov, env, secret, portee) => {
      const r = await storeProjectVerificationSecret({
        projectId: portee.projectId, provider: prov, environment: env, secret,
      });
      // Le moteur attend la forme d'une rotation ; ici il n'y a jamais de
      // fenêtre à ouvrir, puisque le projet ne détient qu'un secret à la fois.
      return { rotated: false, at: r.storedAt, role: r.role };
    },
  });

  /**
   * SÉRIALISÉ PAR PROJET, et c'est ce qui rend huit demandes simultanées
   * inoffensives : elles s'attendent, la première crée, les suivantes
   * constatent. L'index unique du binding est le second filet, pour le cas où
   * deux processus du Panel serviraient le même projet.
   */
  const rapport = await serialize(`${capability.provider}:${environment}:${projectId}`, () =>
    runReconciliation({
      capability, environment, fetchImpl, allowCreate, allowDelete,
      scope, secretPolicy,
      callbackOverride: { ready: true, url: adresse.url },
    }));

  /**
   * LE RAPPORT DU MOTEUR DIT CE QU'IL A FAIT ; LE LIEN DIT CE QUI EST.
   *
   * `runReconciliation` rend un compte rendu d'action — créé, corrigé, dérive
   * constatée — parce que son appelant historique est une tâche de fond qui
   * journalise. L'appelant d'ici est un projet, qui a besoin de l'ÉTAT :
   * quel endpoint, à quelle adresse, pour quels événements.
   *
   * On relit donc le lien plutôt que de gonfler le rapport, pour ne pas
   * modifier ce que les autres consommateurs reçoivent déjà.
   */
  const lien = await PanelIntegratedApiWebhookBinding.findOne({
    provider: capability.provider,
    environment,
    destination: WEBHOOK_DESTINATION.PROJECT,
    projectId,
  }).lean();

  return {
    ...rapport,
    remoteWebhookId: lien?.remoteWebhookId ?? null,
    observedUrl: lien?.observedUrl ?? '',
    desiredUrl: lien?.desiredUrl ?? adresse.url,
    desiredEvents: lien?.desiredEvents ?? [],
    secretConfigured: Boolean(lien?.secretConfigured),
  };
}

/**
 * Valide l'adresse publique d'un projet et en dérive l'URL à enregistrer.
 *
 * En PROD, HTTPS est exigé : un endpoint en clair exposerait des événements de
 * paiement sur le réseau, et Stripe refuserait de toute façon. En TEST, un
 * tunnel local en HTTP reste accepté — c'est le monde où l'on éprouve.
 */
function normalizeProjectCallback(publicBackendUrl, cheminCallback, environment) {
  let parsed;
  try {
    parsed = new URL(String(publicBackendUrl ?? ''));
  } catch {
    throw ApiError.badRequest(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC,
      'Adresse publique du projet illisible : rien ne peut être enregistré.',
    );
  }
  if (environment === 'PROD' && parsed.protocol !== 'https:') {
    throw ApiError.badRequest(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC,
      'Une adresse de production doit être en HTTPS.',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC,
      'Seules les adresses HTTP(S) peuvent recevoir un webhook.',
    );
  }
  const racine = `${parsed.origin}`;
  const chemin = String(cheminCallback ?? '').trim();
  if (!chemin.startsWith('/')) {
    throw ApiError.badRequest(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC,
      'Le chemin de réception du projet doit être une route absolue.',
    );
  }
  return { publicBackendUrl: racine, url: `${racine}${chemin}` };
}

async function runReconciliation({
  capability, environment, fetchImpl, allowCreate, allowDelete,
  scope = PANEL_SCOPE, secretPolicy = PANEL_SECRET_POLICY, callbackOverride = null,
}) {
  const provider = capability.provider;
  const binding = await ensureBinding(provider, environment, capability, scope);

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
  /**
   * L'adresse d'un endpoint de PROJET ne se calcule pas : elle est fournie et
   * validée en amont. La calculer donnerait celle du Panel, et le
   * réconciliateur « corrigerait » l'endpoint du projet vers le Panel — coupant
   * net sa réception. C'est exactement le piège que la portée évite.
   */
  const callback = callbackOverride ?? await resolveWebhookCallback(provider, { environment });
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

  /**
   * L'APPARTENANCE DÉPEND DE CE QUE LE FOURNISSEUR SAIT PORTER.
   *
   * Chez Stripe, Brevo et Yousign, elle est prouvée par un jeton écrit dans la
   * description. OpenSign n'a pas de description : sa preuve est l'URL — la
   * NÔTRE. On transmet donc les deux éléments dont `classifyOwnership` a besoin
   * pour choisir la bonne règle, plutôt que de lui faire deviner le fournisseur.
   */
  const preuve = {
    desiredUrl: desired.url,
    canCarryOwnershipToken: capability.supportsDescription !== false,
  };

  let { owned, peers, foreign } = partitionRemote(remoteList, binding, preuve);
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

  let secretPresent = await secretPolicy.has(provider, environment, scope);

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
      const created = await createOwnedEndpoint({ adapter, ctx, capability, desired, environment, provider, binding, secretPolicy, scope });
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
        const created = await createOwnedEndpoint({ adapter, ctx, capability, desired, environment, provider, binding, secretPolicy, scope });
        outcome.created = true;
        outcome.secretCaptured = created.secretCaptured;
        secretPresent = created.secretCaptured;
        if (allowDelete && mayDelete(keeper, binding, preuve) && String(keeper.id) !== String(created.id)) {
          await adapter.remove(ctx, keeper.id);
          outcome.deleted += 1;
        }
        owned = owned.filter((w) => String(w.id) !== String(keeper.id));
      } else if (!secretPresent && capability.secretDelivery === SECRET_DELIVERY.CALLER_SUPPLIED) {
        /**
         * Cas C du §Secrets : c'est NOUS qui posons le jeton.
         *
         * L'endpoint n'a donc pas besoin d'être recréé — il suffit de lui
         * en poser un neuf. Sans cette branche, un jeton Brevo perdu laissait
         * le binding en WARNING pour toujours, et TOUS les appels entrants
         * étaient refusés : un webhook vivant chez le fournisseur, sourd chez
         * nous, et rien pour le réparer.
         */
        if (!allowCreate) {
          return fail(
            WEBHOOK_DIAGNOSTIC.WEBHOOK_SIGNATURE_CONFIGURATION_INVALID,
            'Endpoint présent, jeton de vérification absent : rotation nécessaire, non demandée.',
          );
        }
        await rotateSecretOnEndpoint({
          adapter, ctx, capability, desired, environment, provider, binding, remoteId: keeper.id,
          secretPolicy, scope,
        });
        outcome.updated = true;
        outcome.secretRotated = true;
        secretPresent = true;
        await patchBinding(binding.bindingId, { remoteWebhookId: String(keeper.id) });
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
    const after = partitionRemote(verified, { ...binding, remoteWebhookId: null }, preuve);
    const keeper = pickKeeper(after.owned, desired, capability);

    // ── 8. RETIRER les doublons — et EUX SEULS ─────────────────────────
    //
    // Un doublon naît d'un crash entre une création et la persistance de son
    // identifiant. On ne le retire qu'APRÈS avoir constaté qu'un survivant
    // conforme existe : sinon on supprimerait la seule écoute en place.
    if (allowDelete && keeper && computeDrift(keeper, desired, capability).length === 0) {
      for (const extra of after.owned) {
        if (String(extra.id) === String(keeper.id)) continue;
        if (!mayDelete(extra, binding, preuve)) continue; // ceinture et bretelles
        await adapter.remove(ctx, extra.id);
        outcome.deleted += 1;
        logger.info(`[webhooks] ${provider}/${environment} : doublon possédé retiré (${extra.id}).`);
      }
    }

    // ── 9. Conclure sur ce qui est OBSERVÉ, jamais sur ce qu'on a voulu ──
    const drift = computeDrift(keeper, desired, capability);
    secretPresent = await secretPolicy.has(provider, environment, scope);

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

    // ── 10. HYGIÈNE — le secret retiré ne survit pas à sa fenêtre ────────
    //
    // Un secret qu'on n'accepte plus n'a aucune raison de rester en base. La
    // purge est ici, dans le passage régulier, plutôt que dans une tâche
    // planifiée : le réconciliateur passe déjà, et un mécanisme de moins est
    // un mécanisme de moins à surveiller.
    const rotated = await PanelIntegratedApiWebhookBinding
      .findOne({ bindingId: binding.bindingId }).select('secretRotatedAt').lean();
    const purge = await purgeExpiredPreviousSecret(provider, environment, {
      rotatedAt: rotated?.secretRotatedAt ?? null,
    }).catch(() => ({ purged: false }));
    if (purge.purged) {
      await patchBinding(binding.bindingId, { secretRotatedAt: null });
      logger.info(`[webhooks] ${provider}/${environment} : fenêtre de rotation close, secret retiré effacé.`);
    }

    // ── 11. NOTRE URL RÉPOND-ELLE ? Diagnostic, jamais un verdict ────────
    const reachability = await probeCallbackReachability(capability, desired.url, ctx.fetchImpl);
    await patchBinding(binding.bindingId, {
      callbackReachable: reachability.reachable,
      callbackCheckedAt: nowIso(),
    });

    outcome.status = status;
    outcome.drift = drift;
    outcome.remoteWebhookId = keeper?.id ?? null;
    outcome.secretConfigured = secretPresent;
    outcome.callbackReachable = reachability.reachable;
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
async function createOwnedEndpoint({ adapter, ctx, capability, desired, environment, provider, binding, secretPolicy = PANEL_SECRET_POLICY, scope = PANEL_SCOPE }) {
  const supplied = secretToSupplyAtCreation(capability);
  const result = await adapter.create(ctx, { ...desired, environment, secret: supplied });

  let secretCaptured = false;
  const secret = result?.secret ?? supplied;
  if (secret) {
    /**
     * ROTATION, PAS ÉCRASEMENT — même lors d'une recréation.
     *
     * L'ancien endpoint n'est retiré qu'APRÈS celui-ci, et les deux portent la
     * MÊME URL. Entre les deux, des événements signés de l'ANCIEN secret
     * arrivent donc encore chez nous. Écraser le secret ici les rejetterait
     * tous ; les faire reculer d'un cran les sauve, pour le temps borné de la
     * fenêtre.
     */
    const outcome = await secretPolicy.store(provider, environment, secret, scope);
    secretCaptured = true;
    if (outcome.rotated && binding?.bindingId) {
      await patchBinding(binding.bindingId, { secretRotatedAt: outcome.at });
    }
  }

  logger.info(
    `[webhooks] ${provider}/${environment} : endpoint créé (${result?.id ?? 'sans id'})`
    + `${secretCaptured ? ', secret capturé' : ', AUCUN secret rendu'}.`,
  );
  return { id: result?.id ?? null, secretCaptured };
}

/**
 * Pose un jeton NEUF sur un endpoint existant — sans le recréer.
 *
 * Réservé aux fournisseurs qui acceptent que nous posions le secret
 * (`CALLER_SUPPLIED`). L'ordre est imposé par ce qu'on ne veut pas perdre :
 * le fournisseur accepte d'abord le nouveau jeton, et seulement ensuite le
 * coffre bascule. Si l'appel distant échoue, rien n'a bougé chez nous et
 * l'ancien jeton continue de vérifier les appels — l'inverse nous laisserait
 * avec un secret que le fournisseur n'utilise pas.
 */
async function rotateSecretOnEndpoint({ adapter, ctx, capability, desired, environment, provider, binding, remoteId, secretPolicy = PANEL_SECRET_POLICY, scope = PANEL_SCOPE }) {
  const secret = generateSharedSecret();
  await adapter.update(ctx, remoteId, { ...desired, environment, secret });
  const outcome = await secretPolicy.store(provider, environment, secret, scope);
  await patchBinding(binding.bindingId, { secretRotatedAt: outcome.at });
  logger.info(`[webhooks] ${provider}/${environment} : jeton de webhook renouvelé sur l’endpoint existant.`);
  return outcome;
}

/**
 * NOTRE propre URL publique répond-elle ?
 *
 * Aucun des trois fournisseurs n'offre d'API d'événement de test : la seule
 * sonde possible est la nôtre. Sans elle, « aucun événement reçu » ne se
 * distingue pas de « le tunnel est tombé », et le diagnostic tourne en rond.
 *
 * Volontairement SANS conséquence sur le statut : un réseau qui hoquette n'est
 * pas une dérive de configuration, et confondre les deux ferait chercher au
 * mauvais endroit. Ne lève jamais.
 */
async function probeCallbackReachability(capability, callbackUrl, fetchImpl) {
  if (!callbackUrl) return { reachable: null };
  const impl = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await impl(`${callbackUrl.replace(/\/+$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return { reachable: response?.ok === true };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
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
    PanelIntegratedApiWebhookBinding.findOne({
      provider: capability.provider,
      environment,
      destination: WEBHOOK_DESTINATION.PANEL,
      projectId: null,
    }).lean(),
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
    /**
     * La fenêtre de rotation est-elle ouverte ? Un booléen et une date — jamais
     * l'ancien secret, ni sa longueur, ni son empreinte.
     */
    secretRotationOpen: isRotationWindowOpen(capability, binding?.secretRotatedAt ?? null),
    secretRotatedAt: binding?.secretRotatedAt ?? null,
    /** Notre propre URL répond-elle ? `null` = jamais sondée. */
    callbackReachable: binding?.callbackReachable ?? null,
    callbackCheckedAt: binding?.callbackCheckedAt ?? null,
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
  ensureWebhookBindingIndexes,
  reconcileProviderWebhook,
  reconcileAllProviderWebhooks,
  describeWebhookState,
  describeAllWebhookStates,
  computeDrift,
};
