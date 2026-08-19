// L'INTROSPECTION — « cette identité est-elle ENCORE valable ? » (L12.B).
//
// docs/auth/PANEL_FEDERATED_DEV_IDENTITY_IMPLEMENTATION.md §« LIVE REVOCATION ».
//
// ── LE PROBLÈME QU'ELLE RÉSOUT ──────────────────────────────────────────────
//
// Une assertion vit trois minutes ; la session projet qu'elle établit vit plus
// longtemps. Entre les deux, tout peut changer : le compte est désactivé, son
// accès au projet retiré, l'appairage révoqué. Sans un moyen de REDEMANDER, le
// projet servirait une session dont le fondement a disparu — et la seule façon
// de la couper serait d'aller éditer sa base à la main. C'est exactement ce que
// le lot interdit.
//
// ── POURQUOI CE N'EST PAS UNE CAPACITÉ ──────────────────────────────────────
//
// Une capacité désigne un acte chez un FOURNISSEUR : elle ouvre le coffre,
// réserve une opération, traduit des pannes de transport. Demander « ce compte
// est-il actif » ne touche aucun tiers et ne consomme aucun credential. La
// faire passer par la passerelle ferait déchiffrer une clé Brevo pour lire un
// booléen.
//
// C'est une LECTURE DE PONT, exactement comme le secret de vérification des
// webhooks (L6.3A) : même nature, même authentification, même absence
// d'identifiant de projet dans la requête.
//
// ── CE QU'ELLE NE DIT JAMAIS ────────────────────────────────────────────────
//
// Elle ne dit pas si un compte EXISTE. Un projet compromis pourrait sinon
// énumérer les employés de L.Y Solution en demandant des identifiants au
// hasard. « Inconnu », « désactivé » et « sans accès à ce projet » rendent donc
// tous `active: false` — le `reasonCode` reste pour le journal DU PANEL, et la
// réponse ne porte de profil que lorsque la réponse est OUI.
import logger from '../../utils/logger.js';
import { PROJECT_ACCESS_MODES, getStoredUserById } from '../auth/panelUsers.service.js';
import { FEDERATED_PROJECT_ROLE, grantsProjectFederation } from '../auth/panelRoles.js';

/** Motifs de refus. Journalisés côté Panel ; jamais interprétés par le projet. */
export const INTROSPECTION_REASONS = Object.freeze({
  UNKNOWN: 'UNKNOWN_PRINCIPAL',
  DISABLED: 'USER_DISABLED',
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
  ACCESS_DENIED: 'PROJECT_ACCESS_DENIED',
  /** La session du projet repose sur une version de session périmée. */
  TOKEN_VERSION_STALE: 'TOKEN_VERSION_STALE',
});

function accessCoversProject(projectAccess, projectId) {
  const mode = projectAccess?.mode ?? PROJECT_ACCESS_MODES.NONE;
  if (mode === PROJECT_ACCESS_MODES.ALL_PAIRED) return true;
  if (mode === PROJECT_ACCESS_MODES.EXPLICIT) {
    return (projectAccess?.projectIds ?? []).map(String).includes(String(projectId));
  }
  return false;
}

/**
 * L'IDENTITÉ EST-ELLE ENCORE VALABLE POUR CE PROJET ?
 *
 * `projectId` vient du JETON DE PONT, jamais de la requête : un projet ne peut
 * donc introspecter que pour lui-même. L'APPAIRAGE n'est pas revérifié ici —
 * `requireBridgeAuth` l'a déjà fait, et un jeton révoqué n'atteint pas cette
 * fonction. Le revérifier donnerait l'illusion d'une garde qui vit ailleurs.
 *
 * `expectedTokenVersion` est facultatif : absent, on répond sur l'état courant
 * (« cette personne a-t-elle accès ? ») ; présent, on répond aussi « la session
 * bâtie sur cette version tient-elle encore ? ».
 *
 * @returns {Promise<{active: boolean, reasonCode?: string, principal?: object}>}
 */
export async function introspectPrincipal({ panelUserId, projectId, expectedTokenVersion = null }) {
  const refuse = (reasonCode) => {
    logger.info(`[federation] introspection refusée — ${reasonCode} (projet ${projectId}).`);
    // Aucun profil, aucune distinction : le projet reçoit « non », et c'est tout.
    return { active: false, reasonCode };
  };

  const user = await getStoredUserById(String(panelUserId ?? ''));
  if (!user) return refuse(INTROSPECTION_REASONS.UNKNOWN);
  if (user.enabled === false) return refuse(INTROSPECTION_REASONS.DISABLED);
  /**
   * MÊME POPULATION QU'À L'ÉMISSION — `DEV` ou `SUPER_ADMIN`.
   *
   * Les deux questions doivent avoir la même réponse : si l'émission accorde
   * et que l'introspection refuse, un développeur obtiendrait une session
   * projet fermée cinq minutes plus tard, sans qu'aucun refus ne le lui dise
   * au moment où il pourrait le comprendre.
   */
  if (!grantsProjectFederation(user.role)) return refuse(INTROSPECTION_REASONS.ROLE_FORBIDDEN);
  if (!accessCoversProject(user.projectAccess, projectId)) {
    return refuse(INTROSPECTION_REASONS.ACCESS_DENIED);
  }

  const currentVersion = user.tokenVersion ?? 0;
  if (expectedTokenVersion !== null && Number(expectedTokenVersion) !== currentVersion) {
    return refuse(INTROSPECTION_REASONS.TOKEN_VERSION_STALE);
  }

  /**
   * LE PROFIL MINIMAL — et il n'est rendu QUE sur un « oui ».
   *
   * Ce sont les données d'affichage que l'assertion ne porte volontairement
   * pas : les y figer en ferait des copies périmées. Le projet peut les mettre
   * en cache pour son écran ; le Panel reste l'autorité, et c'est cet appel
   * qui les rafraîchit.
   *
   * Rien de plus n'est rendu : ni date de création, ni dernier accès, ni les
   * autres projets de cette personne — un projet n'a pas à savoir chez qui
   * d'autre travaille le développeur qui l'assiste.
   */
  return {
    active: true,
    principal: {
      panelUserId: user.userId,
      displayName: user.displayName,
      email: user.email,
      /**
       * LE RÔLE PROJETÉ, ET NON LE RÔLE RÉEL — voir `panelRoles.js`.
       *
       * Le projet stocke cette valeur dans sa projection d'identité externe.
       * Y laisser passer `SUPER_ADMIN` la ferait entrer dans SA base, puis dans
       * SES écrans, puis un jour dans SES décisions. Un projet ne connaît que
       * son propre modèle de rôles.
       */
      role: FEDERATED_PROJECT_ROLE,
      enabled: true,
      tokenVersion: currentVersion,
    },
  };
}

export default { INTROSPECTION_REASONS, introspectPrincipal };
