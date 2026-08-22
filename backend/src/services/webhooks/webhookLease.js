// LE BAIL DE TRAITEMENT — ce qui transforme un registre de réception en unité
// de travail (L5 bis).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Reprise après incident ».
//
// ── LE DÉFAUT QUE CE MODULE FERME ───────────────────────────────────────────
//
// L'idempotence reposait sur une seule question : « la ligne existe-t-elle ? ».
// Elle protégeait parfaitement du rejeu — et détruisait le rattrapage :
//
//     webhook  →  ligne écrite  →  CRASH  →  Stripe rejoue  →  « doublon »
//                                                           →  effet PERDU
//
// Le fournisseur offrait la seule chance de réparation qui existe, et nous la
// refusions. Pire : nous la refusions en silence, avec un HTTP 200.
//
// ── CE QUE LE BAIL AJOUTE, ET RIEN DE PLUS ──────────────────────────────────
//
// Une ligne ne dit plus « vu », elle dit « vu, et voilà où j'en suis ». Un
// rejeu consulte l'ÉTAT :
//
//     PROCESSED / IGNORED / DEAD_LETTER  →  doublon terminal, aucun effet
//     PROCESSING, bail VALIDE            →  quelqu'un travaille, on n'entre pas
//     PROCESSING, bail EXPIRÉ            →  travail abandonné, on REPREND
//     RECEIVED ancien                    →  jamais réclamé, on REPREND
//     FAILED reprenable                  →  on REPREND
//
// ── AUCUN VERROU MÉMOIRE ────────────────────────────────────────────────────
//
// Le Panel tourne derrière un ordonnanceur, un worker détaché et une API : un
// `Set` de clés en cours n'aurait protégé qu'à l'intérieur d'un processus, et
// aurait donné l'illusion d'une garantie multi-processus. La réclamation est
// donc une écriture conditionnelle en base, et rien d'autre.
import crypto from 'node:crypto';
import os from 'node:os';

import {
  WEBHOOK_EVENT_STATUS,
  WEBHOOK_TERMINAL_STATUSES,
} from '../../models/PanelProviderWebhookEvent.model.js';

/**
 * ══ LA DURÉE DU BAIL — 120 s, ET VOICI POURQUOI ═════════════════════════════
 *
 * Mesure des traitements légitimes sur le compte de recette : la réception
 * d'un `invoice.paid` enchaîne résolution d'appartenance, adoption éventuelle,
 * normalisation, un aller-retour Stripe pour la `balance_transaction` (les
 * frais réels, jamais calculés), l'écriture du fait puis celle du mouvement.
 * Les invocations de capacité les plus proches mesurées en base tiennent entre
 * 150 et 250 ms ; le pire cas plausible — Stripe lent, réseau dégradé, deux
 * tentatives de transport — reste sous la seconde.
 *
 * 120 s, c'est donc environ deux ordres de grandeur au-dessus du pire cas
 * observé, et bien en dessous du premier rejeu utile de Stripe. Les deux bornes
 * comptent :
 *
 *   trop COURT  →  on reprend un travail qui tourne encore, et deux processus
 *                  appliquent le même événement. La barrière d'idempotence
 *                  métier tiendrait — mais on l'aurait sollicitée pour rien.
 *   trop LONG   →  un événement abandonné reste invisible des minutes durant.
 *                  Pour un `subscription.deleted`, c'est un site servi alors
 *                  que le contrat est fini.
 */
export const LEASE_TTL_MS = positiveEnv('WEBHOOK_LEASE_TTL_MS', 120_000);

/**
 * Un `RECEIVED` de moins de 120 s n'est pas « abandonné » : c'est peut-être le
 * même événement, en cours de première livraison, dont le bail n'est pas encore
 * écrit. On applique donc le même délai qu'au bail — la question posée est la
 * même : « assez de temps a-t-il passé pour que le silence signifie mort ? ».
 */
export const STALE_RECEIVED_MS = positiveEnv('WEBHOOK_STALE_RECEIVED_MS', LEASE_TTL_MS);

/**
 * ══ CINQ TENTATIVES, PUIS ON RENONCE — ET ON LE DIT ═════════════════════════
 *
 * Un événement toxique — schéma qu'on ne sait pas lire, ressource disparue chez
 * le fournisseur — échouerait indéfiniment, à chaque rejeu et à chaque
 * démarrage. Cinq laisse largement place aux pannes réelles (une dépendance
 * indisponible revient rarement cinq fois de suite) sans transformer un défaut
 * en boucle perpétuelle.
 *
 * Le renoncement n'est PAS un silence : il écrit `DEAD_LETTER` et lève une
 * alerte de supervision nommée. Un événement abandonné sans trace est
 * exactement le défaut que ce lot corrige.
 */
export const MAX_PROCESSING_ATTEMPTS = positiveEnv('WEBHOOK_MAX_ATTEMPTS', 5);

function positiveEnv(nom, defaut) {
  const brut = Number.parseInt(process.env[nom] ?? '', 10);
  return Number.isFinite(brut) && brut > 0 ? brut : defaut;
}

/**
 * L'IDENTITÉ DU PROCESSUS — et le nonce en est la seule partie sérieuse.
 *
 * Hôte et pid sont du confort de diagnostic. Le nonce, tiré une fois au
 * chargement du module, est ce qui distingue CE processus de son propre
 * fantôme : un processus redémarré peut réutiliser un pid sur le même hôte, et
 * se croirait alors titulaire d'un bail qu'il a perdu en mourant.
 */
const NONCE_DEMARRAGE = crypto.randomBytes(6).toString('hex');
export const PROCESS_IDENTITY = `${os.hostname()}:${process.pid}:${NONCE_DEMARRAGE}`;

/** Issue d'une tentative de réclamation. Fermé. */
export const CLAIM_OUTCOME = Object.freeze({
  /** Premier passage : la ligne vient d'être créée, sous bail. */
  CLAIMED: 'CLAIMED',
  /** Un travail abandonné a été repris. C'est la réparation. */
  RECLAIMED: 'RECLAIMED',
  /** Un autre processus tient un bail valide. On n'entre pas. */
  IN_FLIGHT: 'IN_FLIGHT',
  /** Déjà conclu (PROCESSED / IGNORED / DEAD_LETTER). Doublon SÛR. */
  TERMINAL: 'TERMINAL',
});

const iso = (d) => new Date(d).toISOString();

/**
 * LE FILTRE DE REPRISE — écrit une seule fois, utilisé partout.
 *
 * Le réutiliser pour la réclamation ET pour le balayage garantit que les deux
 * parlent du même « abandonné ». Deux définitions auraient divergé, et le
 * balayage aurait fini par signaler des événements que la réclamation refusait
 * de reprendre — ou l'inverse, plus grave.
 */
export function abandonedFilter(now = Date.now()) {
  const limiteBail = iso(now);
  const limiteRecue = iso(now - STALE_RECEIVED_MS);
  return {
    $or: [
      { status: WEBHOOK_EVENT_STATUS.RECEIVED, receivedAt: { $lte: limiteRecue } },
      { status: WEBHOOK_EVENT_STATUS.FAILED, 'lastError.retryable': { $ne: false } },
      { status: WEBHOOK_EVENT_STATUS.PROCESSING, leaseExpiresAt: { $lte: limiteBail } },
    ],
  };
}

/**
 * RÉCLAMER UN ÉVÉNEMENT — insertion, ou reprise. Atomique dans les deux cas.
 *
 * ── POURQUOI DEUX ÉCRITURES ET PAS UN `upsert` ──────────────────────────────
 *
 * Un `findOneAndUpdate(..., {upsert: true})` ne peut pas porter un filtre
 * d'état : le filtre doit aussi décrire le document à créer. On aurait donc dû
 * upserter sur la seule clé — et écraser le bail d'un processus qui travaille.
 *
 * L'insertion d'abord, la reprise conditionnelle ensuite, ne coûte une seconde
 * écriture QUE sur le chemin du rejeu, et laisse l'index unique arbitrer le cas
 * concurrent : deux premières livraisons simultanées, une seule insertion.
 *
 * @param {object} p
 * @param {import('mongoose').Model} p.Model
 * @param {object} p.key      la clé unique (provider, environment, providerEventId)
 * @param {object} p.seed     les champs de première écriture
 * @returns {Promise<{outcome: string, event: object|null, attempts: number}>}
 */
export async function claimWebhookEvent({ Model, key, seed = {} }) {
  const maintenant = Date.now();
  const bail = {
    status: WEBHOOK_EVENT_STATUS.PROCESSING,
    leaseOwner: PROCESS_IDENTITY,
    processingStartedAt: iso(maintenant),
    leaseExpiresAt: iso(maintenant + LEASE_TTL_MS),
  };

  try {
    const cree = await Model.create({ ...seed, ...key, ...bail, processingAttempts: 1 });
    return { outcome: CLAIM_OUTCOME.CLAIMED, event: cree, attempts: 1 };
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  /**
   * LA REPRISE — conditionnelle, donc sûre entre processus.
   *
   * Si le filtre ne matche pas, c'est que l'événement est conclu ou qu'un bail
   * valide court : dans les deux cas nous ne devons pas travailler, et Mongo
   * nous le dit en ne rendant rien. Aucune lecture-puis-décision.
   */
  const repris = await Model.findOneAndUpdate(
    { ...key, ...abandonedFilter(maintenant) },
    { $set: bail, $inc: { processingAttempts: 1 } },
    { new: true },
  );
  if (repris) {
    return {
      outcome: CLAIM_OUTCOME.RECLAIMED,
      event: repris,
      attempts: repris.processingAttempts ?? 1,
    };
  }

  /**
   * On n'a pas pu reprendre. Reste à dire POURQUOI — et c'est une lecture de
   * diagnostic, pas une décision : la décision a déjà été prise par le refus
   * ci-dessus.
   */
  const actuel = await Model.findOne(key).lean();
  const conclu = !actuel || WEBHOOK_TERMINAL_STATUSES.includes(actuel.status)
    || actuel.status === WEBHOOK_EVENT_STATUS.DUPLICATE;
  return {
    outcome: conclu ? CLAIM_OUTCOME.TERMINAL : CLAIM_OUTCOME.IN_FLIGHT,
    event: actuel ?? null,
    attempts: actuel?.processingAttempts ?? 0,
  };
}

/**
 * CONCLURE — et n'écrire QUE si le bail est encore le nôtre.
 *
 * Le garde `leaseOwner` n'est pas une précaution de style. Un traitement qui
 * dépasse son bail voit son événement repris par un autre ; s'il écrivait
 * `PROCESSED` en rentrant, il effacerait le travail en cours de son
 * successeur et rendrait terminal un événement que personne n'a fini.
 */
export async function settleWebhookEvent({ Model, key, status, patch = {}, error = null }) {
  const maintenant = new Date().toISOString();
  const set = { ...patch, status, processedAt: maintenant };
  if (error) {
    set.lastError = {
      code: error.code ?? null,
      message: String(error.message ?? '').slice(0, 300),
      retryable: error.retryable ?? null,
      at: maintenant,
    };
  }
  if (status !== WEBHOOK_EVENT_STATUS.PROCESSING) {
    set.leaseOwner = null;
    set.leaseExpiresAt = null;
  }
  const r = await Model.updateOne({ ...key, leaseOwner: PROCESS_IDENTITY }, { $set: set });
  return { written: (r?.modifiedCount ?? 0) > 0 };
}

/**
 * ══ RETRYABLE OU TERMINAL — la classification, et elle tient en peu de lignes ═
 *
 * Une taxonomie ambitieuse aurait vieilli plus vite que le code qu'elle décrit.
 * La question posée est unique : **une nouvelle tentative a-t-elle une chance
 * de donner un résultat différent ?**
 *
 * OUI  — panne de base, dépendance injoignable, délai dépassé, redémarrage,
 *        erreur de transport marquée `retryable` par le module qui l'a levée.
 * NON  — le corps ne se lit pas, le schéma est incompatible, l'appartenance est
 *        définitivement impossible. Réessayer ne fera que rejouer l'échec.
 *
 * ── LE DÉFAUT PAR DÉFAUT EST « REPRENABLE », ET C'EST DÉLIBÉRÉ ──────────────
 *
 * Une erreur inconnue est plus souvent une panne qu'un vice de forme. Se
 * tromper vers la reprise coûte quelques tentatives et finit en `DEAD_LETTER`
 * supervisé au bout de cinq ; se tromper vers le terminal perd un fait
 * financier en silence. Les deux erreurs n'ont pas le même prix.
 */
const CODES_TERMINAUX = new Set([
  'WEBHOOK_PAYLOAD_INVALID',
  'WEBHOOK_SIGNATURE_REJECTED',
  'WEBHOOK_SCHEMA_UNSUPPORTED',
  'CAPABILITY_INPUT_INVALID',
  'VALIDATION_FAILED',
]);

export function classifyWebhookError(err) {
  const code = err?.code ? String(err.code) : 'WEBHOOK_PROCESSING_FAILED';
  if (typeof err?.retryable === 'boolean') {
    return { code, retryable: err.retryable, message: err?.message ?? '' };
  }
  if (CODES_TERMINAUX.has(code) || err?.name === 'ValidationError') {
    return { code, retryable: false, message: err?.message ?? '' };
  }
  return { code, retryable: true, message: err?.message ?? '' };
}

/**
 * L'état à écrire après un échec — et le compteur y participe.
 *
 * Une erreur reprenable ne reste reprenable que tant qu'il reste des
 * tentatives. Passé le plafond, elle devient un abandon assumé : `DEAD_LETTER`,
 * supervisé, jamais rejoué. C'est ce qui empêche la boucle infinie sans jamais
 * jeter en silence.
 */
export function statusAfterFailure({ retryable, attempts }) {
  if (!retryable) return WEBHOOK_EVENT_STATUS.DEAD_LETTER;
  return attempts >= MAX_PROCESSING_ATTEMPTS
    ? WEBHOOK_EVENT_STATUS.DEAD_LETTER
    : WEBHOOK_EVENT_STATUS.FAILED;
}

/** L'âge d'un événement, en secondes — pour la supervision et les journaux. */
export function ageSeconds(event, now = Date.now()) {
  const depuis = Date.parse(event?.receivedAt ?? '');
  return Number.isFinite(depuis) ? Math.round((now - depuis) / 1000) : null;
}

export default {
  LEASE_TTL_MS,
  STALE_RECEIVED_MS,
  MAX_PROCESSING_ATTEMPTS,
  PROCESS_IDENTITY,
  CLAIM_OUTCOME,
  abandonedFilter,
  claimWebhookEvent,
  settleWebhookEvent,
  classifyWebhookError,
  statusAfterFailure,
  ageSeconds,
};
