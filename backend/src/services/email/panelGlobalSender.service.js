// L'EXPÉDITEUR GLOBAL — « au nom de qui tout le parc écrit-il ? » (R10.4).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Expéditeurs ».
//
// ══ UNE SEULE SOURCE, ET LA PREUVE QUE C'EST LA SEULE ═══════════════════════
//
// Ce module est la SEULE autorité sur le `From` du parc. Tous les chemins
// d'envoi — projets, Panel, modèles métier, notifications de paiement, tests —
// le traversent. Un second endroit qui déciderait d'un expéditeur ferait
// exactement ce que R10.4 interdit : deux vérités sur la même ligne d'en-tête,
// dont l'une finit par gagner sans que personne sache laquelle.
//
// ══ CE QUI EST INTERDIT ICI, EXPLICITEMENT ══════════════════════════════════
//
//   · aucun repli sur une variable d'environnement — un `.env` oublié sur un
//     serveur ferait partir des e-mails depuis une adresse que personne n'a
//     choisie, et le silence du repli le rendrait indétectable ;
//   · aucun expéditeur dérivé du credential Brevo — le compte qui expédie et
//     l'adresse au nom de laquelle on expédie sont deux questions distinctes ;
//   · aucun `From` codé en dur dans un modèle ;
//   · aucun expéditeur venu d'un projet ou d'une charge utile.
//
// L'absence de configuration est donc un REFUS, pas un défaut. C'est le seul
// comportement qui rende l'oubli visible : le premier envoi échoue avec un
// message qui nomme l'écran à remplir, au lieu de partir sous une adresse
// fantôme dont on découvrirait l'existence dans une plainte.
//
// ══ ENVIRONNEMENT ═══════════════════════════════════════════════════════════
//
// Il n'y en a pas. L'identité par (projet, environnement) de L8.3 séparait TEST
// et PROD pour protéger la réputation d'un domaine réel — un souci légitime
// quand chaque projet apportait son domaine. Avec une adresse unique détenue
// par la plateforme, la séparation utile est déjà faite ailleurs : deux comptes
// Brevo, deux jeux d'identifiants, deux mondes dans le coffre. Dédoubler
// l'adresse ici ajouterait un réglage sans ajouter une garantie.
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import SystemConfiguration from '../../models/SystemConfiguration.model.js';

/** Codes stables — l'écran et le rapport de test les traduisent. */
export const GLOBAL_SENDER_CODES = Object.freeze({
  OK: 'OK',
  /** Personne n'a jamais rempli l'écran. */
  NOT_CONFIGURED: 'PANEL_GLOBAL_SENDER_NOT_CONFIGURED',
  /** Rempli, mais inexploitable — adresse illisible ou nom vide. */
  INVALID: 'PANEL_GLOBAL_SENDER_INVALID',
});

/**
 * Volontairement la MÊME expression que le contrat L8. Une seconde règle de
 * validation d'adresse, même « meilleure », ferait accepter ici ce que la
 * couche voisine refuse — et l'écart ne se verrait qu'à l'envoi.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Champs qui n'ont RIEN à faire dans une configuration d'expéditeur.
 *
 * Repris du contrat L8 (`SENDER_IDENTITY_SHAPE.forbidden`) plutôt que réinventé :
 * la configuration globale est publique — elle s'affiche en clair dans un écran
 * et dans le rapport de test — et un secret qui y entrerait en sortirait par
 * les deux.
 */
const FORBIDDEN_FIELDS = Object.freeze(['apiKey', 'webhookSecret', 'secretKey', 'apiToken', 'password']);

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/** Le sous-document, toujours défini (défauts du schéma). */
async function readStored() {
  const configuration = await SystemConfiguration.findOneAndUpdate(
    { key: 'SINGLETON' },
    { $setOnInsert: { key: 'SINGLETON' } },
    { new: true, upsert: true },
  ).lean();
  return configuration?.email ?? {};
}

/**
 * Valide un couple SANS rien décider d'autre.
 *
 * @returns {{valid: boolean, code: string, problems: string[]}}
 */
export function validateGlobalSender(candidate) {
  const problems = [];
  const senderEmail = String(candidate?.senderEmail ?? '').trim().toLowerCase();
  const senderName = String(candidate?.senderName ?? '').trim();

  if (!senderEmail) problems.push('Adresse d’expédition absente.');
  else if (!EMAIL_RE.test(senderEmail)) problems.push('Adresse d’expédition illisible.');
  // Un nom vide ferait afficher l'adresse brute dans la boîte du destinataire.
  // Brevo l'accepte ; la crédibilité du message, non.
  if (!senderName) problems.push('Nom d’expéditeur absent.');

  if (problems.length > 0) {
    const code = senderEmail || senderName
      ? GLOBAL_SENDER_CODES.INVALID
      : GLOBAL_SENDER_CODES.NOT_CONFIGURED;
    return { valid: false, code, problems };
  }
  return { valid: true, code: GLOBAL_SENDER_CODES.OK, problems: [] };
}

/**
 * VUE de la configuration — sans lever, pour un écran de diagnostic.
 *
 * L'adresse n'est PAS masquée : elle est publique par nature, elle figure dans
 * chaque e-mail envoyé, et la cacher à l'opérateur qui la configure n'apporte
 * qu'une gêne.
 */
export async function describeGlobalSender() {
  const stored = await readStored();
  const verdict = validateGlobalSender(stored);
  return {
    senderEmail: stored.senderEmail ?? null,
    senderName: stored.senderName ?? null,
    configured: verdict.valid,
    code: verdict.code,
    problems: verdict.problems,
    updatedAt: stored.updatedAt ?? null,
    updatedBy: stored.updatedBy ?? null,
  };
}

/**
 * L'EXPÉDITEUR À UTILISER — ou un refus net.
 *
 * C'est la fonction que tout chemin d'envoi appelle. Elle LÈVE quand rien
 * n'est configuré : rendre un défaut ferait partir un e-mail sous une adresse
 * que personne n'a choisie, et le repli silencieux est précisément ce que
 * R10.4 interdit.
 *
 * @returns {Promise<{senderEmail: string, senderName: string}>}
 */
export async function resolveGlobalSender() {
  const stored = await readStored();
  const verdict = validateGlobalSender(stored);
  if (!verdict.valid) {
    throw ApiError.conflict(
      verdict.code,
      `Expéditeur global inexploitable : ${verdict.problems.join(' ')} `
      + 'Renseignez-le dans « Expéditeur e-mail » avant tout envoi.',
    );
  }
  return {
    senderEmail: String(stored.senderEmail).trim().toLowerCase(),
    senderName: String(stored.senderName).trim(),
  };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Enregistre l'expéditeur global — geste d'ADMINISTRATION, réservé aux DEV.
 *
 * Les deux champs sont écrits ENSEMBLE. Autoriser une mise à jour partielle
 * permettrait de laisser un nom pointant vers une ancienne adresse, et l'écran
 * afficherait un couple que personne n'a validé comme couple.
 */
export async function updateGlobalSender(input = {}, actor = {}) {
  for (const forbidden of FORBIDDEN_FIELDS) {
    if (input[forbidden] !== undefined) {
      throw ApiError.badRequest(
        GLOBAL_SENDER_CODES.INVALID,
        `Le champ « ${forbidden} » n’a rien à faire dans une configuration d’expéditeur : `
        + 'les secrets vivent dans le coffre, pas dans un réglage lisible.',
      );
    }
  }

  const candidate = {
    senderEmail: String(input.senderEmail ?? '').trim().toLowerCase(),
    senderName: String(input.senderName ?? '').trim(),
  };
  const verdict = validateGlobalSender(candidate);
  if (!verdict.valid) {
    throw ApiError.badRequest(
      verdict.code,
      `Expéditeur refusé : ${verdict.problems.join(' ')}`,
    );
  }

  const at = nowIso();
  await SystemConfiguration.updateOne(
    { key: 'SINGLETON' },
    {
      $set: {
        'email.senderEmail': candidate.senderEmail,
        'email.senderName': candidate.senderName,
        'email.updatedAt': at,
        'email.updatedBy': actor.userId ?? null,
      },
    },
    { upsert: true },
  );

  // L'adresse est publique — elle figure dans chaque e-mail. La journaliser
  // n'expose rien qu'un destinataire ne voie déjà.
  logger.info(
    `[email] expéditeur global enregistré : « ${candidate.senderName} » <${candidate.senderEmail}>`
    + `${actor.userEmail ? ` par ${actor.userEmail}` : ''}.`,
  );
  return describeGlobalSender();
}

export default {
  GLOBAL_SENDER_CODES,
  validateGlobalSender,
  describeGlobalSender,
  resolveGlobalSender,
  updateGlobalSender,
};
