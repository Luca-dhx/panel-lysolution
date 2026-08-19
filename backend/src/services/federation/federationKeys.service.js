// LES CLÉS DE LA FÉDÉRATION — création, sélection, publication (L12.A).
//
// docs/auth/PANEL_FEDERATED_DEV_IDENTITY_IMPLEMENTATION.md §« KEY STRATEGY ».
//
// ── LE CHOIX D'ALGORITHME, ET COMMENT IL A ÉTÉ TRANCHÉ ──────────────────────
//
// Le lot demande EdDSA/Ed25519 « si jsonwebtoken et le runtime le supportent
// proprement », sinon RS256 avec justification. La question a été tranchée par
// l'exécution, pas par la documentation :
//
//     jwt.sign({}, ed25519Key, { algorithm: 'EdDSA' })
//     → « "algorithm" must be a valid string enum value »
//
// `jsonwebtoken@9` ne connaît pas EdDSA (son moteur `jwa` ne l'implémente pas).
// Les deux options réelles étaient donc RS256 et ES256, toutes deux
// asymétriques et standard. RS256 est retenu : c'est le repli que le lot
// nomme, et c'est l'algorithme qu'un vérificateur non-Node — un futur projet
// dans une autre stack — trouvera implémenté partout.
//
// ── CE QUE CE MODULE NE FAIT JAMAIS ─────────────────────────────────────────
//
// Il ne rend jamais une clé privée à un appelant extérieur : `signingKey()` est
// la seule fonction qui la déchiffre, elle est interne au service d'assertion,
// et la valeur déchiffrée n'est liée à aucune variable de portée large.
// Aucune fonction de ce fichier ne journalise un PEM.
import crypto from 'node:crypto';

import logger from '../../utils/logger.js';
import { nowIso, newBridgeId } from '../../bridge/bridgeContract.js';
import { encryptSecret, decryptSecret } from '../../utils/panelCrypto.js';
import PanelFederationKey, {
  FEDERATION_ALGORITHM,
  FEDERATION_KEY_STATUS,
} from '../../models/PanelFederationKey.model.js';

/**
 * 2048 bits, et non 4096.
 *
 * Une assertion vit trois minutes. Doubler la taille de clé double le coût de
 * signature sur un chemin interactif — un DEV attend devant son écran — pour
 * une marge qui n'a de sens que sur des secrets de longue durée. 2048 reste la
 * recommandation courante pour des jetons éphémères.
 */
const MODULUS_LENGTH = 2048;

/**
 * POSE LA PREMIÈRE CLÉ SI AUCUNE N'EXISTE. Idempotent.
 *
 * ── POURQUOI L'AMORÇAGE EST PARESSEUX, ET PAS AU DÉMARRAGE ─────────────────
 *
 * Générer une paire RSA coûte des centaines de millisecondes. Le faire au
 * démarrage ralentirait chaque boot — y compris ceux des suites de tests, y
 * compris sur des instances qui n'émettront jamais d'assertion. On la crée au
 * premier besoin réel, et une seule fois.
 */
export async function ensureActiveKey() {
  const existing = await PanelFederationKey.findOne({ status: FEDERATION_KEY_STATUS.ACTIVE }).lean();
  if (existing) return describeKey(existing);
  return createKey({ activate: true });
}

/**
 * Crée une paire. `activate: false` la publie SANS la faire signer — c'est
 * l'étape 1 d'une rotation, celle qui donne aux projets le temps de la
 * connaître avant qu'elle ne produise quoi que ce soit.
 */
export async function createKey({ activate = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: MODULUS_LENGTH,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const at = nowIso();
  const kid = `fed-${newBridgeId()}`;

  if (activate) {
    // Une seule clé signe à la fois : les précédentes passent en RETIRED,
    // elles restent publiées le temps que leurs assertions expirent.
    await PanelFederationKey.updateMany(
      { status: FEDERATION_KEY_STATUS.ACTIVE },
      { $set: { status: FEDERATION_KEY_STATUS.RETIRED, retiredAt: at } },
    );
  }

  const document = {
    kid,
    algorithm: FEDERATION_ALGORITHM,
    publicKeyPem: publicKey,
    privateKeyEncrypted: encryptSecret(privateKey),
    status: activate ? FEDERATION_KEY_STATUS.ACTIVE : FEDERATION_KEY_STATUS.RETIRED,
    createdAt: at,
    activatedAt: activate ? at : null,
    retiredAt: null,
  };
  await PanelFederationKey.create(document);

  // On NOMME la clé, jamais son contenu. Un PEM dans un journal est un PEM
  // recopié dans un ticket, puis dans une conversation.
  logger.info(`[federation] clé ${kid} créée (${FEDERATION_ALGORITHM}, ${activate ? 'ACTIVE' : 'publiée seulement'}).`);
  return describeKey(document);
}

/** Fait signer une clé déjà publiée — l'étape 3 d'une rotation. */
export async function activateKey(kid) {
  const target = await PanelFederationKey.findOne({ kid }).lean();
  if (!target) return null;

  const at = nowIso();
  await PanelFederationKey.updateMany(
    { status: FEDERATION_KEY_STATUS.ACTIVE, kid: { $ne: kid } },
    { $set: { status: FEDERATION_KEY_STATUS.RETIRED, retiredAt: at } },
  );
  const updated = await PanelFederationKey.findOneAndUpdate(
    { kid },
    { $set: { status: FEDERATION_KEY_STATUS.ACTIVE, activatedAt: at, retiredAt: null } },
    { new: true },
  ).lean();

  logger.info(`[federation] clé ${kid} activée : elle signe désormais les assertions.`);
  return describeKey(updated);
}

/**
 * LA CLÉ QUI SIGNE, PRIVÉE DÉCHIFFRÉE. Réservée au service d'assertion.
 *
 * Rend `null` s'il n'y en a pas : l'appelant doit refuser explicitement plutôt
 * que de recevoir une exception opaque au moment de signer.
 */
export async function signingKey() {
  const active = await PanelFederationKey.findOne({ status: FEDERATION_KEY_STATUS.ACTIVE }).lean();
  if (!active) return null;
  return {
    kid: active.kid,
    algorithm: active.algorithm,
    privateKeyPem: decryptSecret(active.privateKeyEncrypted),
  };
}

/** La clé publique d'un `kid`, ou `null`. C'est ce que lit le vérificateur. */
export async function publicKeyFor(kid) {
  if (!kid) return null;
  const key = await PanelFederationKey.findOne({ kid }).lean();
  return key ? { kid: key.kid, algorithm: key.algorithm, publicKeyPem: key.publicKeyPem } : null;
}

/**
 * LE JEU DE CLÉS PUBLIQUES — format JWKS (RFC 7517).
 *
 * ── POURQUOI JWKS, ET PAS UN PEM DANS UN CHAMP ─────────────────────────────
 *
 * Parce qu'un PEM ne porte pas de `kid`. Le jour de la première rotation, un
 * projet qui n'a qu'un PEM ne peut pas savoir laquelle des deux clés a signé
 * l'assertion qu'il tient : il doit les essayer toutes, et il ne peut pas
 * distinguer « signature fausse » de « mauvaise clé essayée ». JWKS règle cela
 * par construction, et c'est un format que tout vérificateur sait lire.
 *
 * `use: 'sig'` et `alg` sont déclarés : un vérificateur ne doit jamais déduire
 * l'algorithme du jeton qu'il vérifie — c'est la porte d'entrée de la confusion
 * d'algorithme.
 */
export async function publicJwks() {
  const keys = await PanelFederationKey.find({}).sort({ createdAt: -1 }).lean();
  return {
    keys: keys.map((key) => {
      const jwk = crypto.createPublicKey(key.publicKeyPem).export({ format: 'jwk' });
      return {
        ...jwk,
        kid: key.kid,
        use: 'sig',
        alg: key.algorithm,
        /**
         * NON STANDARD, et assumé : un projet peut vouloir refuser une
         * assertion fraîchement signée par une clé qu'on est en train de
         * retirer. Le champ est purement informatif — la sécurité ne repose
         * jamais dessus, elle repose sur la signature.
         */
        status: key.status,
      };
    }),
  };
}

/** Vue SÛRE d'une clé — jamais la privée, même chiffrée. */
function describeKey(key) {
  return {
    kid: key.kid,
    algorithm: key.algorithm,
    status: key.status,
    createdAt: key.createdAt,
    activatedAt: key.activatedAt ?? null,
    retiredAt: key.retiredAt ?? null,
  };
}

/** Le catalogue des clés, pour un écran d'exploitation. Aucune privée. */
export async function describeKeys() {
  const keys = await PanelFederationKey.find({}).sort({ createdAt: -1 }).lean();
  return keys.map(describeKey);
}

export default {
  FEDERATION_ALGORITHM,
  FEDERATION_KEY_STATUS,
  activateKey,
  createKey,
  describeKeys,
  ensureActiveKey,
  publicJwks,
  publicKeyFor,
  signingKey,
};
