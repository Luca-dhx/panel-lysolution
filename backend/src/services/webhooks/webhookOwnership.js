// APPARTENANCE — « ai-je le droit de toucher à cet endpoint ? » (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Appartenance ».
//
// ── LE PROBLÈME, EN UNE PHRASE ──────────────────────────────────────────────
//
// Un compte fournisseur est PARTAGÉ. Le même compte Stripe sert le Panel, les
// projets déployés, peut-être un outil comptable, peut-être une intégration
// posée à la main par quelqu'un il y a deux ans. Supprimer un endpoint « parce
// qu'il n'est pas dans notre base » revient à couper la ligne de quelqu'un
// d'autre — et personne ne s'en apercevra avant le premier paiement perdu.
//
// D'où la règle, qui n'a pas d'exception :
//
//   ON NE SUPPRIME QUE CE QU'ON PEUT PROUVER AVOIR CRÉÉ.
//
// ── TROIS DEGRÉS, ET UN SEUL DONNE LE DROIT DE SUPPRIMER ────────────────────
//
//   OWNED      la description porte NOTRE jeton, ou l'id est celui qu'on a
//              persisté. C'est nous. Suppression autorisée.
//   PANEL_PEER la description porte le préfixe canonique d'un Panel, mais un
//              AUTRE jeton. C'est un Panel — recette, autre client, ancienne
//              installation. On le reconnaît, on ne le touche pas.
//   FOREIGN    rien ne le rattache à nous. On ne le touche pas, et on ne le
//              journalise même pas en détail : ce n'est pas notre affaire.
//
// La distinction OWNED / PANEL_PEER est ce qui rend deux instances de Panel
// capables de partager un compte fournisseur sans se détruire mutuellement.
// Sans elle, un Panel de recette effacerait l'endpoint du Panel de production
// à chaque démarrage — et il aurait l'air d'avoir raison de le faire.
import { randomUUID } from 'node:crypto';

import { ownershipPrefix, ownershipDescription } from './webhookRegistry.js';
import { sameCallback } from './webhookCallback.js';

export const OWNERSHIP = Object.freeze({
  OWNED: 'OWNED',
  PANEL_PEER: 'PANEL_PEER',
  FOREIGN: 'FOREIGN',
});

/**
 * Frappe un jeton d'appartenance.
 *
 * Il est persisté AVANT le premier appel de création : un processus tué entre
 * les deux laisse un endpoint que le passage suivant reconnaîtra comme le sien.
 * L'inverse — frapper le jeton après la réponse du fournisseur — produirait un
 * orphelin indiscernable d'un endpoint tiers, donc intouchable à jamais.
 */
export function mintOwnershipToken() {
  return randomUUID();
}

/**
 * Degré d'appartenance d'un endpoint distant.
 *
 * @param {{id: string, url: string, description: string}} remote
 * @param {{provider: string, environment: string, ownershipToken: string, remoteWebhookId: string|null}} binding
 * @param {object} [options]
 * @param {string|null} [options.desiredUrl] la callback de CE Panel
 * @param {boolean} [options.canCarryOwnershipToken] le fournisseur sait-il
 *   stocker une description ? `false` change la nature de la preuve — voir plus bas.
 */
export function classifyOwnership(remote, binding, {
  desiredUrl = null, canCarryOwnershipToken = true,
} = {}) {
  const description = String(remote?.description ?? '');
  const prefix = ownershipPrefix(binding.provider, binding.environment);

  // L'identifiant persisté est une preuve à part entière, et la plus robuste :
  // il survit à un opérateur qui réécrit la description dans le tableau de bord
  // du fournisseur.
  if (binding.remoteWebhookId && String(remote?.id) === String(binding.remoteWebhookId)) {
    return OWNERSHIP.OWNED;
  }

  /**
   * ══ QUAND LE FOURNISSEUR NE SAIT PAS PORTER NOTRE JETON ═══════════════════
   *
   * Tout ce qui précède suppose une DESCRIPTION : c'est elle qui transporte le
   * jeton d'appartenance. OpenSign n'en a pas — son webhook est une URL, seule,
   * unique par compte. Sans règle propre, aucun endpoint OpenSign ne serait
   * jamais reconnu comme nôtre, et le plafond d'un endpoint par compte
   * refuserait ensuite toute création. Le plan de contrôle ne pourrait donc
   * JAMAIS converger — ni adopter, ni corriger, ni retirer.
   *
   * ── POURQUOI L'URL SUFFIT ICI, ET SEULEMENT ICI ───────────────────────────
   *
   * L'adresse comparée n'est pas une adresse quelconque : c'est LA CALLBACK DE
   * CE PANEL, calculée par nous, pointant notre propre hôte et notre propre
   * segment de fournisseur. Un endpoint qui l'affiche envoie ses événements
   * chez nous. Un autre Panel a une autre adresse — et s'il avait la même, il
   * SERAIT nous : même hôte, même route, même destinataire.
   *
   * La preuve est donc plus faible qu'un jeton, mais elle est de même nature :
   * elle établit que retirer ou corriger cet endpoint ne coupe la réception de
   * personne d'autre. C'est exactement ce que `mayDelete` a besoin de savoir.
   *
   * ── ET ELLE RESTE ÉTROITE ─────────────────────────────────────────────────
   *
   * Elle ne s'applique QUE si le fournisseur est incapable de porter un jeton,
   * et QUE sur une égalité d'URL normalisée. Un endpoint OpenSign pointant
   * ailleurs reste FOREIGN : on ne le touche pas, on ne le compte pas pour
   * nôtre, et le plafond refusera d'en créer un second — ce qui est le bon
   * arbitrage, puisqu'on ne peut pas prouver à qui il appartient.
   */
  if (!canCarryOwnershipToken) {
    return desiredUrl && sameCallback(remote?.url, desiredUrl)
      ? OWNERSHIP.OWNED
      : OWNERSHIP.FOREIGN;
  }

  if (!description.startsWith(prefix)) return OWNERSHIP.FOREIGN;

  const token = description.slice(prefix.length).replace(/^#/, '');
  if (token && binding.ownershipToken && token === binding.ownershipToken) return OWNERSHIP.OWNED;

  // Préfixe canonique sans jeton : une écriture d'une version antérieure, ou
  // une description tronquée. On la reconnaît comme « un Panel », jamais comme
  // « CE Panel » — le doute ne donne pas le droit de supprimer.
  return OWNERSHIP.PANEL_PEER;
}

/** La description à POSER chez le fournisseur pour ce binding. */
export function descriptionFor(binding) {
  return ownershipDescription(binding.provider, binding.environment, binding.ownershipToken);
}

/**
 * PEUT-ON SUPPRIMER ? Une seule réponse positive, et elle est explicite.
 *
 * La fonction est minuscule et c'est voulu : elle est le point unique à relire
 * le jour où l'on se demande « qu'est-ce qui a supprimé cet endpoint ». Toute
 * suppression du réconciliateur passe par ici.
 */
export function mayDelete(remote, binding, options = {}) {
  return classifyOwnership(remote, binding, options) === OWNERSHIP.OWNED;
}

/**
 * Répartit une liste distante en trois seaux.
 *
 * `owned` peut contenir PLUSIEURS entrées — un doublon né d'un crash entre la
 * création et la persistance de l'identifiant. Le réconciliateur en garde un
 * et ne retire les autres qu'après avoir vérifié que le survivant est conforme.
 */
export function partitionRemote(remoteList, binding, options = {}) {
  const owned = [];
  const peers = [];
  const foreign = [];
  for (const remote of remoteList ?? []) {
    const verdict = classifyOwnership(remote, binding, options);
    if (verdict === OWNERSHIP.OWNED) owned.push(remote);
    else if (verdict === OWNERSHIP.PANEL_PEER) peers.push(remote);
    else foreign.push(remote);
  }
  return { owned, peers, foreign };
}

export default {
  OWNERSHIP,
  mintOwnershipToken,
  classifyOwnership,
  descriptionFor,
  mayDelete,
  partitionRemote,
};
