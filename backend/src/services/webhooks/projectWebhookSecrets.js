// LE SEUL ENDROIT QUI ÉCRIT ET LIT UN SECRET DE VÉRIFICATION DE PROJET (L6.3A).
//
// ══ LA RÈGLE QUE CE MODULE INCARNE ══════════════════════════════════════════
//
// Un secret de signature n'ouvre aucune porte : il ne sait que constater qu'un
// message reçu vient bien du fournisseur. C'est ce qui autorise — et c'est la
// SEULE chose qui autorise — qu'il traverse le pont vers un projet, alors
// qu'une clé d'appel ne le fera jamais.
//
// Pour que cette distinction reste vraie dans le temps plutôt que dans les
// intentions, elle est vérifiée à l'ÉCRITURE : ce module refuse de ranger une
// valeur qui n'a pas la forme d'un secret de signature. Une clé Stripe glissée
// ici — par erreur, par copier-coller, par un futur appelant distrait — est
// rejetée avant d'atteindre la base, donc avant de pouvoir être livrée.
//
// ══ CE QU'IL NE FAIT PAS ════════════════════════════════════════════════════
//
// Il ne journalise jamais la valeur, ne la met dans aucune erreur, et ne la
// rend qu'à un appelant qui fournit un `projectId` — lequel vient du jeton de
// pont, jamais de la charge utile. Il n'existe aucune fonction « lister les
// secrets » : on ne peut demander que celui d'un projet précis, un par un.
import PanelProjectWebhookSecret from '../../models/PanelProjectWebhookSecret.model.js';
import { encryptSecret, decryptSecret } from '../../utils/panelCrypto.js';
import { credentialRole } from '../integratedApi/providerRegistry.js';
import logger from '../../utils/logger.js';

/** Le rôle porté par un secret de signature, quel que soit le fournisseur. */
export const VERIFICATION_ROLE = 'webhookSecret';

/** La forme d'un secret de signature. Volontairement stricte. */
const VERIFICATION_SHAPE = /^whsec_[A-Za-z0-9_-]{8,}$/;

export class VerificationSecretRejected extends Error {
  constructor(message) {
    // Le message ne recopie JAMAIS la valeur refusée : l'expliquer la
    // journaliserait, et une valeur refusée est souvent un vrai secret rangé
    // au mauvais endroit — donc exactement ce qu'il ne faut pas écrire.
    super(message);
    this.name = 'VerificationSecretRejected';
    this.code = 'PANEL_VERIFICATION_SECRET_REJECTED';
  }
}

/**
 * Le rôle visé est-il bien déclaré « ne sert qu'à vérifier » au registre ?
 *
 * Dérivé du registre plutôt que codé en dur : le jour où un cinquième
 * fournisseur arrive avec son propre nom de secret de signature, il suffira de
 * le déclarer — et si quelqu'un tentait de ranger ici un rôle d'appel, le
 * registre le dirait.
 */
function assertVerificationRole(provider, role) {
  const declared = credentialRole(provider, role);
  if (!declared?.verificationOnly) {
    throw new VerificationSecretRejected(
      `« ${role} » n’est pas un rôle de vérification déclaré pour ${provider} : `
      + 'ce coffre ne range que des secrets de signature.',
    );
  }
}

const nowIso = () => new Date().toISOString();
const lastFourOf = (value) => String(value).slice(-4);

/**
 * Range le secret de vérification d'un projet — en le REMPLAÇANT s'il existe.
 *
 * Pas de conservation de l'ancien, contrairement au coffre du Panel : la
 * fenêtre de rotation du Panel existe parce que SES événements arrivent chez
 * LUI pendant qu'il tourne la clé. Ici, c'est le projet qui vérifie, et il ne
 * détient qu'un secret à la fois ; lui en confier deux l'obligerait à essayer
 * les deux, donc à accepter plus longtemps un secret retiré.
 *
 * @returns {Promise<{role: string, storedAt: string, lastFour: string}>}
 */
export async function storeProjectVerificationSecret({
  projectId, provider, environment, secret, role = VERIFICATION_ROLE,
}) {
  if (!projectId) throw new VerificationSecretRejected('Projet non identifié.');
  assertVerificationRole(provider, role);

  if (typeof secret !== 'string' || !VERIFICATION_SHAPE.test(secret)) {
    /**
     * LE CONTRÔLE QUI COMPTE. Sans lui, ce coffre serait un coffre à secrets
     * comme un autre, et la garde du pont laisserait passer tout ce qu'on y
     * aurait rangé — y compris une clé d'appel.
     */
    throw new VerificationSecretRejected(
      'La valeur proposée n’a pas la forme d’un secret de signature : refusée '
      + 'avant enregistrement.',
    );
  }

  const at = nowIso();
  await PanelProjectWebhookSecret.findOneAndUpdate(
    { projectId, provider: String(provider).toUpperCase(), environment },
    {
      $set: {
        role,
        encryptedValue: encryptSecret(secret),
        lastFour: lastFourOf(secret),
        updatedAt: at,
      },
      $setOnInsert: { createdAt: at, deliveredAt: null },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  // Le journal dit QU'IL Y A eu un secret, jamais lequel.
  logger.info(
    `[webhooks] secret de vérification rangé pour ${projectId} (${provider}, ${environment}).`,
  );
  return { role, storedAt: at, lastFour: lastFourOf(secret) };
}

/**
 * Rend le secret d'UN projet — et exige de savoir lequel.
 *
 * Il n'existe volontairement aucune variante « par fournisseur » : une lecture
 * qui n'aurait pas à nommer son projet finirait par être appelée sans lui.
 */
export async function readProjectVerificationSecret({ projectId, provider, environment }) {
  if (!projectId) return null;
  const doc = await PanelProjectWebhookSecret.findOne({
    projectId, provider: String(provider).toUpperCase(), environment,
  }).lean();
  if (!doc?.encryptedValue) return null;
  try {
    return { role: doc.role, secret: decryptSecret(doc.encryptedValue), lastFour: doc.lastFour };
  } catch {
    // Un secret indéchiffrable est un secret perdu : le dire honnêtement vaut
    // mieux que rendre une valeur fausse qui ferait rejeter tous les webhooks.
    return null;
  }
}

/** Le projet a-t-il un secret courant ? Un booléen, jamais la valeur. */
export async function hasProjectVerificationSecret({ projectId, provider, environment }) {
  if (!projectId) return false;
  const doc = await PanelProjectWebhookSecret.findOne(
    { projectId, provider: String(provider).toUpperCase(), environment },
  ).select('encryptedValue').lean();
  return Boolean(doc?.encryptedValue);
}

/** Marque la livraison — diagnostic seul, aucune valeur touchée. */
export async function markVerificationSecretDelivered({ projectId, provider, environment }) {
  await PanelProjectWebhookSecret.updateOne(
    { projectId, provider: String(provider).toUpperCase(), environment },
    { $set: { deliveredAt: nowIso(), updatedAt: nowIso() } },
  ).catch(() => {});
}

export default {
  VERIFICATION_ROLE,
  storeProjectVerificationSecret,
  readProjectVerificationSecret,
  hasProjectVerificationSecret,
  markVerificationSecretDelivered,
  VerificationSecretRejected,
};
