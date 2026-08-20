// VÉRIFICATION D'UN APPEL ENTRANT — le corps brut, et rien que le corps brut.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Endpoint entrant ».
//
// ── LE PIÈGE, ET IL EST TOUJOURS LE MÊME ────────────────────────────────────
//
// Une signature HMAC porte sur les OCTETS reçus. `express.json()` parse, puis
// `JSON.stringify()` re-sérialise — et la chaîne obtenue diffère de l'originale
// dès qu'il y a un espace, un ordre de clés, un caractère non-ASCII. La
// vérification échoue alors sur des messages parfaitement authentiques, ce qui
// pousse invariablement à « désactiver temporairement la vérification ».
//
// D'où : la route est montée AVANT `express.json()`, avec `express.raw()`, et
// ces fonctions ne reçoivent qu'un `Buffer`.
//
// ── PROUVÉ N'EST PAS AUTHENTIFIÉ ────────────────────────────────────────────
//
// Le résultat porte `proven`. Un HMAC prouve que le détenteur du secret a
// produit CE corps-là. Un jeton partagé (Brevo) prouve seulement que l'appelant
// connaît le jeton : il ne dit rien du corps, qu'un intermédiaire pourrait
// avoir modifié. Les deux sont acceptés, ils ne valent pas la même chose, et le
// code refuse de faire semblant du contraire.
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

import { SIGNATURE_SCHEMES } from './webhookRegistry.js';

/** Tolérance d'horloge sur l'horodatage signé de Stripe. */
const STRIPE_TOLERANCE_S = 300;

/** Comparaison à temps constant. La garde de longueur est faite AVANT. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Empreinte du corps brut — la clé d'idempotence des fournisseurs muets. */
export function payloadDigest(rawBody) {
  return createHash('sha256').update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8')).digest('hex');
}

/**
 * Lecture d'en-tête insensible à la casse, quelle que soit la forme reçue.
 *
 * Exportée sous `readHeader` : le diagnostic de représentation (plus bas) et la
 * réception en ont besoin, et deux lectures d'en-tête écrites séparément
 * finiraient par diverger sur la casse — c'est-à-dire sur le seul point qui
 * compte ici.
 */
export function readHeader(headers, name) {
  if (!headers) return '';
  const wanted = String(name).toLowerCase();
  if (typeof headers.get === 'function') return String(headers.get(wanted) ?? '');
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return String(Array.isArray(value) ? value[0] : value ?? '');
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Stripe — `Stripe-Signature: t=<epoch>,v1=<hex>[,v1=<hex>]`.
 *
 * La charge signée est `${t}.${corpsBrut}` : l'horodatage EST dans le calcul,
 * c'est ce qui empêche de rejouer indéfiniment un appel intercepté. Plusieurs
 * `v1` peuvent coexister pendant une rotation côté Stripe — on les essaie tous.
 */
function verifyStripe({ rawBody, signatureHeader, secrets, nowSeconds }) {
  const parts = String(signatureHeader).split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
  const provided = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || provided.length === 0) return { verified: false, reason: 'MALFORMED' };

  const age = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isFinite(age) || age > STRIPE_TOLERANCE_S) return { verified: false, reason: 'STALE' };

  const payload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8'),
  ]);

  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    if (provided.some((candidate) => safeEqual(candidate, expected))) {
      return { verified: true, proven: true };
    }
  }
  return { verified: false, reason: 'MISMATCH' };
}

/** HMAC-SHA256 hexadécimal du corps brut, dans un en-tête dédié (Yousign). */
function verifyHmacBody({ rawBody, signatureHeader, secrets }) {
  const provided = String(signatureHeader).trim().replace(/^sha256=/i, '');
  if (!provided) return { verified: false, reason: 'MALFORMED' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    if (safeEqual(provided.toLowerCase(), expected)) return { verified: true, proven: true };
  }
  return { verified: false, reason: 'MISMATCH' };
}

/**
 * Jeton partagé — `Authorization: Bearer <secret>`.
 *
 * `proven: false`, et c'est la seule chose honnête à écrire : ce contrôle
 * authentifie le porteur, il ne prouve pas le corps.
 */
function verifyBearer({ signatureHeader, secrets }) {
  const match = /^Bearer\s+(.+)$/i.exec(String(signatureHeader).trim());
  const token = match ? match[1].trim() : '';
  if (!token) return { verified: false, reason: 'MALFORMED' };
  for (const secret of secrets) {
    if (safeEqual(token, secret)) return { verified: true, proven: false };
  }
  return { verified: false, reason: 'MISMATCH' };
}

/* -------------------------------------------------------------------------- */
/*  ENTRÉE UNIQUE                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Vérifie un appel entrant selon la capacité du fournisseur.
 *
 * @param {object} capability   descripteur issu de `webhookRegistry`
 * @param {object} args
 * @param {Buffer} args.rawBody  les OCTETS reçus, jamais un objet reparsé
 * @param {object} args.headers
 * @param {string[]} args.secrets  candidats (fenêtre de rotation)
 * @returns {{verified: boolean, proven: boolean, reason: string|null}}
 *
 * `secrets` vide → refus avec `NO_SECRET`. Un endpoint dont on a perdu le
 * secret ne doit PAS accepter les appels « en attendant » : ce serait accepter
 * n'importe qui.
 */
export function verifyWebhookSignature(capability, { rawBody, headers, secrets = [], nowSeconds } = {}) {
  const scheme = capability?.signatureScheme ?? SIGNATURE_SCHEMES.NONE;

  if (scheme === SIGNATURE_SCHEMES.NONE) {
    return { verified: false, proven: false, reason: 'NO_SCHEME' };
  }
  if (!Array.isArray(secrets) || secrets.length === 0) {
    return { verified: false, proven: false, reason: 'NO_SECRET' };
  }

  const signatureHeader = readHeader(headers, capability.signatureHeader);
  if (!signatureHeader) return { verified: false, proven: false, reason: 'MISSING_HEADER' };

  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  let outcome;
  switch (scheme) {
    case SIGNATURE_SCHEMES.HMAC_SHA256_STRIPE:
      outcome = verifyStripe({ rawBody, signatureHeader, secrets, nowSeconds: now });
      break;
    case SIGNATURE_SCHEMES.HMAC_SHA256_BODY:
      outcome = verifyHmacBody({ rawBody, signatureHeader, secrets });
      break;
    case SIGNATURE_SCHEMES.SHARED_SECRET_BEARER:
      outcome = verifyBearer({ signatureHeader, secrets });
      break;
    default:
      outcome = { verified: false, reason: 'UNKNOWN_SCHEME' };
  }

  return {
    verified: Boolean(outcome.verified),
    proven: Boolean(outcome.proven),
    reason: outcome.verified ? null : (outcome.reason ?? 'MISMATCH'),
  };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE DU CORPS                                                          */
/* -------------------------------------------------------------------------- */

/** Lecture d'un chemin simple (`a.b.c`) sans dépendance ni évaluation. */
function pick(source, path) {
  let current = source;
  for (const segment of String(path).split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Identifiant d'événement — l'ancre de l'idempotence.
 *
 * Quand le fournisseur en donne un, on le prend. Quand il n'en donne pas
 * (Brevo), on prend l'empreinte du corps brut : deux livraisons identiques ont
 * la même empreinte, deux événements distincts ne l'ont pas. C'est moins beau
 * qu'un identifiant, et c'est exactement aussi sûr pour ce qu'on en fait.
 */
export function extractEventIdentity(capability, { rawBody, parsed, environment } = {}) {
  const digest = payloadDigest(rawBody);
  let providerEventId = '';

  for (const field of capability.eventIdFields ?? []) {
    const value = pick(parsed, field);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      providerEventId = String(value).trim();
      break;
    }
  }

  /**
   * CLÉ COMPOSITE — quand le fournisseur n'a pas d'identifiant mais que son
   * corps permet d'en reconstruire un stable.
   *
   * Préférée à l'empreinte : elle survit à une re-sérialisation du fournisseur
   * (espaces, ordre des clés) qui changerait l'empreinte sans que l'événement
   * ait changé — et ferait donc passer un rejeu pour un événement neuf.
   */
  if (!providerEventId && typeof capability.eventIdentity === 'function') {
    providerEventId = capability.eventIdentity(parsed, { environment }) ?? '';
  }

  let eventType = '';
  for (const field of capability.eventTypeFields ?? []) {
    const value = pick(parsed, field);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      eventType = String(value).trim().slice(0, 120);
      break;
    }
  }

  return {
    // Le repli sur l'empreinte n'est pas un défaut de configuration : c'est le
    // comportement NORMAL des fournisseurs sans identifiant d'événement.
    providerEventId: providerEventId || `sha256:${digest}`,
    eventType,
    payloadHash: digest,
  };
}

/* -------------------------------------------------------------------------- */
/*  DIAGNOSTIC — pourquoi une signature HMAC ne correspond pas                 */
/* -------------------------------------------------------------------------- */

/**
 * QUELLE REPRÉSENTATION DU CORPS LE FOURNISSEUR A-T-IL SIGNÉE ?
 *
 * ══ CE QUE CETTE FONCTION N'EST PAS ═════════════════════════════════════════
 *
 * Ce n'est PAS un vérificateur de repli. Elle ne rend aucun verdict
 * d'acceptation, et `verifyWebhookSignature` ne l'appelle jamais. Un
 * vérificateur qui essaie plusieurs représentations « jusqu'à ce qu'une passe »
 * accepte tout ce qu'un attaquant peut faire correspondre à l'une d'elles : la
 * garantie tombe au niveau de la plus faible.
 *
 * ══ CE QU'ELLE EST ══════════════════════════════════════════════════════════
 *
 * Un instrument de DIAGNOSTIC, appelé uniquement quand la vérification a DÉJÀ
 * refusé, et dont la sortie ne va que dans le journal.
 *
 * Le problème qu'elle résout est concret et documenté : la page d'aide
 * d'OpenSign dit « utilisez le corps brut », et l'exemple de code publié juste
 * en dessous calcule le HMAC sur `JSON.stringify(req.body)`, c'est-à-dire sur
 * une RE-SÉRIALISATION. Les deux ne coïncident que si le fournisseur émet
 * exactement les octets qu'il a signés.
 *
 * Sans ce diagnostic, un désaccord se présente comme un simple `MISMATCH` :
 * indiscernable d'une mauvaise clé, d'un secret non tourné, ou d'un appel
 * falsifié. Trois causes, trois actions opposées, et aucune information pour
 * choisir. Avec lui, le journal dit « le fournisseur signe une
 * re-sérialisation » — un fait, actionnable en une minute.
 *
 * @returns {{matched: string|null, candidates: string[]}} `matched` nomme la
 *   représentation qui aurait correspondu, ou `null` si aucune — auquel cas la
 *   cause n'est pas la représentation, et c'est aussi une information.
 */
export function diagnoseHmacRepresentation({ rawBody, signatureHeader, secrets = [] }) {
  const provided = String(signatureHeader ?? '').trim().replace(/^sha256=/i, '').toLowerCase();
  const candidates = [];
  if (!provided || secrets.length === 0) return { matched: null, candidates };

  const brut = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const representations = [{ nom: 'RAW_BODY', octets: brut }];

  /**
   * La re-sérialisation canonique — celle que produit l'exemple d'OpenSign.
   * Elle n'existe que si le corps est du JSON : sur un corps illisible, il n'y
   * a rien à comparer, et prétendre le contraire serait inventer une piste.
   */
  try {
    const parsed = JSON.parse(brut.toString('utf8'));
    representations.push({ nom: 'JSON_RESERIALIZED', octets: Buffer.from(JSON.stringify(parsed), 'utf8') });
  } catch { /* corps non-JSON : une seule représentation à examiner */ }

  for (const { nom, octets } of representations) {
    candidates.push(nom);
    for (const secret of secrets) {
      if (createHmac('sha256', secret).update(octets).digest('hex') === provided) {
        return { matched: nom, candidates };
      }
    }
  }
  return { matched: null, candidates };
}

/** Parse tolérant : un corps illisible ne doit pas lever, il doit être vide. */
export function parseJsonBody(rawBody) {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export default {
  verifyWebhookSignature,
  extractEventIdentity,
  parseJsonBody,
  payloadDigest,
  diagnoseHmacRepresentation,
  readHeader,
};
