// LA CLÉ DE SIGNATURE FÉDÉRÉE — l'unique secret que le Panel ne partage pas
// mais dont il publie le pendant (L12.A).
//
// docs/auth/PANEL_FEDERATED_DEV_IDENTITY_IMPLEMENTATION.md §« KEY STRATEGY ».
//
// ── POURQUOI UNE COLLECTION, ET PAS UNE VARIABLE D'ENVIRONNEMENT ────────────
//
// Une clé en variable d'environnement ne tourne pas : la remplacer invalide
// d'un coup toutes les assertions en vol, et il n'existe aucun instant où
// l'ancienne et la nouvelle coexistent. Or une rotation sans recouvrement est
// une coupure, donc une rotation qu'on ne fait jamais — et une clé qu'on ne
// tourne jamais est une clé qui finit par fuiter.
//
// Une collection permet le seul ordre correct :
//
//   1. créer la nouvelle clé, statut RETIRED (publiée, pas encore signante)
//   2. publier les DEUX au JWKS
//   3. basculer la signature sur la nouvelle
//   4. attendre l'expiration des assertions signées par l'ancienne (minutes)
//   5. retirer l'ancienne du JWKS
//
// ── CE QUI EST STOCKÉ, ET SOUS QUELLE FORME ─────────────────────────────────
//
//   publicKeyPem        EN CLAIR. C'est une clé PUBLIQUE : la chiffrer serait
//                       du théâtre, et gênerait le diagnostic.
//   privateKeyEncrypted AES-256-GCM par `panelCrypto`, la même primitive qui
//                       protège déjà la copie du bridgeToken. Elle n'est
//                       déchiffrée qu'au moment de signer, jamais rendue par
//                       une API, jamais journalisée.
//
// ── AUCUN CHAMP `algorithm` LIBRE ───────────────────────────────────────────
//
// L'algorithme est une ÉNUMÉRATION fermée. Un champ libre laisserait entrer
// `none` ou `HS256` depuis la base — et `HS256` avec une clé publique comme
// secret est l'attaque de confusion d'algorithme la plus connue du format.
import mongoose from 'mongoose';

/** Le seul algorithme servi. Voir le rapport pour le choix (EdDSA indisponible). */
export const FEDERATION_ALGORITHM = 'RS256';

export const FEDERATION_KEY_STATUS = Object.freeze({
  /** La clé qui SIGNE. Il n'y en a qu'une à la fois. */
  ACTIVE: 'ACTIVE',
  /**
   * Publiée au JWKS, mais ne signe plus. Deux moments de vie l'occupent :
   * juste avant une bascule (elle est publiée d'avance), et juste après (le
   * temps que les assertions qu'elle a signées expirent).
   */
  RETIRED: 'RETIRED',
});

const panelFederationKeySchema = new mongoose.Schema(
  {
    /**
     * L'IDENTIFIANT DE CLÉ — obligatoire dès la v1.
     *
     * Sans lui, un vérificateur doit essayer toutes les clés publiées, ce qui
     * transforme une rotation en devinette et rend impossible de dire QUELLE
     * clé a signé une assertion donnée. Il est aléatoire, jamais dérivé de la
     * clé elle-même : un `kid` calculé depuis le module RSA divulguerait la
     * clé publique avant sa publication.
     */
    kid: { type: String, required: true, unique: true },

    algorithm: {
      type: String,
      enum: [FEDERATION_ALGORITHM],
      required: true,
      default: FEDERATION_ALGORITHM,
    },

    /** PEM SPKI. Publique : sert le JWKS, se lit sans précaution. */
    publicKeyPem: { type: String, required: true },

    /** PEM PKCS#8 chiffré AES-256-GCM. Ne sort jamais de ce processus. */
    privateKeyEncrypted: { type: String, required: true },

    status: {
      type: String,
      enum: Object.values(FEDERATION_KEY_STATUS),
      required: true,
      default: FEDERATION_KEY_STATUS.ACTIVE,
    },

    createdAt: { type: String, required: true },
    activatedAt: { type: String, default: null },
    retiredAt: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/** Retrouver la clé signante, et les clés publiables, sans balayer. */
panelFederationKeySchema.index({ status: 1, createdAt: -1 }, { name: 'federation_key_status' });

export const PanelFederationKey = mongoose.model('PanelFederationKey', panelFederationKeySchema);
export default PanelFederationKey;
