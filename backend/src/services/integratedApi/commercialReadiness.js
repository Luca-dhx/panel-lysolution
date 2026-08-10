// OUVERTURE COMMERCIALE — « cette action réelle est-elle autorisée ? »
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md — lot L1.75.
//
// ── DEUX QUESTIONS, DEUX RÉPONSES, JAMAIS MÉLANGÉES ─────────────────────────
//
//   environment.js          →  QUEL MONDE fournisseur ?   (TEST | PROD)
//   commercialReadiness.js  →  L'ACTION RÉELLE est-elle autorisée ?
//
// La seconde ne modifie JAMAIS la première. Une instance en pré-ouverture
// n'utilise pas « Stripe TEST » : elle est en PROD, elle utiliserait les
// identifiants PROD — et on lui refuse simplement de capturer de l'argent.
//
//   PREOPENING ≠ TEST
//
// Confondre les deux recréerait `activeMode` sous un autre nom, c'est-à-dire
// exactement ce que le lot L2 doit supprimer.
//
// ── POURQUOI CETTE NOTION EXISTE ────────────────────────────────────────────
//
// L'inventaire L1.5 a trouvé, dans une base dormante, un paiement RÉEL :
//
//     status PAID · environment PROD · providerMode TEST · 2026-07-16
//
// Une instance techniquement en production avait été validée de bout en bout
// avec un Stripe de test. C'était utile — personne ne veut débiter une vraie
// carte pour vérifier qu'un déploiement fonctionne — et c'était possible
// uniquement parce qu'`activeMode` laissait choisir le monde à la main.
//
// L2 supprimera ce choix. Sans remplaçant, il supprimerait aussi la capacité.
// Ce module est le remplaçant : il sépare « quel monde » de « le droit d'agir ».
//
// ── PÉRIMÈTRE L1.75 : UNE PRIMITIVE, RIEN QU'ELLE ───────────────────────────
//
// Aucune persistance. Aucun champ en base, ni côté Panel, ni côté projet.
// Aucun branchement sur Stripe, Brevo, Yousign ou Hostinger. Aucun appel.
//
// C'est délibéré, et c'est la même règle qu'au lot L1 (`IntegratedApiRuntime :
// NOT_NEEDED_L1`) : on ne crée pas une structure de données qu'aucun code
// n'écrit. Le parc ne compte AUCUNE instance PROD vivante — la notion n'a donc
// personne à protéger aujourd'hui. Elle sera stockée et projetée quand la
// première instance de production existera, et lue par la passerelle de
// capacités (L3), qui est son seul appelant prévu.
//
// Ce qui est livré ici est ce qui rend la doctrine EXÉCUTABLE et donc
// vérifiable : un vocabulaire fermé, une table de politique, et une fonction.

/* -------------------------------------------------------------------------- */
/*  ÉTATS                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * DEUX ÉTATS, ET PAS TROIS.
 *
 * `SUSPENDED` a été envisagé puis écarté (§4 de la mission L1.75). Le produit
 * possède déjà une autorité de suspension : `SiteStatus`, avec ses deux
 * sources (`TECHNICAL`, `CONTRACT`) et son `contractProtectionEnabled`.
 *
 * L'argument décisif n'est pas l'économie d'un état, c'est un INTERBLOCAGE :
 * `SiteStatus` passe à `SUSPENDED` avec la source `CONTRACT` précisément quand
 * aucun contrat n'est honoré — et la façon d'en sortir est de PAYER. Un
 * `SUSPENDED` commercial qui refléterait cet état bloquerait le paiement qui
 * doit le lever. Le site ne pourrait plus jamais revenir.
 *
 * Une machine à états répond à UNE question. Celle-ci répond à « le commerce
 * réel est-il ouvert ? ». « Le site doit-il être servi ? » a déjà la sienne.
 */
export const COMMERCIAL_STATE = Object.freeze({
  /**
   * L'instance tourne — elle est installée, configurée, déployée — mais elle
   * n'est pas ouverte au commerce réel. Ce n'est PAS un environnement de test :
   * ses données sont réelles, son environnement est celui qu'il est.
   */
  PREOPENING: 'PREOPENING',
  /** Ouverte. Les opérations réelles autorisées par ailleurs sont permises. */
  LIVE: 'LIVE',
});

export const COMMERCIAL_STATE_VALUES = Object.freeze(Object.values(COMMERCIAL_STATE));

/**
 * L'état par DÉFAUT d'une instance dont on ne sait rien.
 *
 * `PREOPENING`, et c'est un choix fail-closed : une instance qui n'a jamais
 * déclaré son ouverture ne capture pas d'argent. L'inverse — ouvrir par défaut —
 * ferait de l'oubli d'une déclaration un débit réel.
 */
export const DEFAULT_COMMERCIAL_STATE = COMMERCIAL_STATE.PREOPENING;

/* -------------------------------------------------------------------------- */
/*  NATURE DES ACTIONS                                                        */
/* -------------------------------------------------------------------------- */

/**
 * CE QU'UNE CAPACITÉ FAIT AU MONDE EXTÉRIEUR.
 *
 * La politique ne se décide pas capacité par capacité, au jugé : elle découle
 * de la NATURE de l'effet. C'est ce qui rend la table relisable, et ce qui
 * donne une réponse évidente pour la capacité suivante.
 */
export const EFFECT = Object.freeze({
  /** Lit chez le fournisseur. Rien ne change nulle part. */
  READ_ONLY: 'READ_ONLY',
  /** Écrit une configuration chez le fournisseur. Réversible, sans tiers lésé. */
  CONFIGURATION: 'CONFIGURATION',
  /** Crée un objet distant sans engagement : on peut le supprimer. */
  REVERSIBLE_EXTERNAL_WRITE: 'REVERSIBLE_EXTERNAL_WRITE',
  /** Touche à de l'argent réel. Irréversible ou coûteux à défaire. */
  FINANCIAL_WRITE: 'FINANCIAL_WRITE',
  /** Engage juridiquement une personne réelle. */
  LEGAL_WRITE: 'LEGAL_WRITE',
  /** Atteint un tiers réel dans sa boîte de réception. */
  COMMUNICATION_WRITE: 'COMMUNICATION_WRITE',
  /** Modifie l'infrastructure (DNS, hébergement). */
  INFRASTRUCTURE_WRITE: 'INFRASTRUCTURE_WRITE',
});

/**
 * LES EFFETS INTERDITS EN PRÉ-OUVERTURE.
 *
 * Deux, et deux seulement — ceux qui engagent quelqu'un d'autre que nous :
 * l'argent d'un client, et sa signature.
 *
 * ── POURQUOI PAS « TOUT BLOQUER » ───────────────────────────────────────────
 *
 * PREOPENING n'est pas une coupure réseau. Une instance en pré-ouverture doit
 * pouvoir être CONFIGURÉE : déployer son DNS, vérifier ses clés, envoyer la
 * réinitialisation de mot de passe qui permet à son administrateur d'ouvrir la
 * session avec laquelle il l'ouvrira. Bloquer les e-mails la rendrait
 * inutilisable — et l'on contournerait la pré-ouverture pour travailler, ce qui
 * la viderait de son sens.
 */
const FORBIDDEN_IN_PREOPENING = Object.freeze([
  EFFECT.FINANCIAL_WRITE,
  EFFECT.LEGAL_WRITE,
]);

/* -------------------------------------------------------------------------- */
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * POLITIQUE PAR CAPACITÉ — code-first, table FERMÉE.
 *
 * Pas de DSL, pas de règles en base, pas de moteur configurable. Une politique
 * qu'on peut changer sans relire le code est une politique qu'on change sans
 * comprendre — et celle-ci décide si de l'argent réel bouge.
 *
 * Les identifiants sont ceux du catalogue de capacités de la roadmap (§6.2).
 * Aucune n'est invocable aujourd'hui : cette table les précède.
 */
export const CAPABILITY_EFFECTS = Object.freeze({
  // ── Stripe ───────────────────────────────────────────────────────────────
  'billing.invoice.list': EFFECT.READ_ONLY,
  'billing.subscription.reconcile': EFFECT.READ_ONLY,
  // Créer un Customer ne débite rien et se supprime. L'interdire empêcherait
  // de préparer le dossier d'un client avant son ouverture, sans rien protéger.
  'billing.customer.ensure': EFFECT.REVERSIBLE_EXTERNAL_WRITE,
  'billing.checkout.create': EFFECT.FINANCIAL_WRITE,
  'billing.subscription.cancel_at_period_end': EFFECT.FINANCIAL_WRITE,
  'billing.refund': EFFECT.FINANCIAL_WRITE,

  // ── Brevo ────────────────────────────────────────────────────────────────
  'email.sender.verify': EFFECT.CONFIGURATION,
  'email.send_template': EFFECT.COMMUNICATION_WRITE,

  // ── Yousign ──────────────────────────────────────────────────────────────
  'signature.document.download': EFFECT.READ_ONLY,
  // Demander une signature engage juridiquement un tiers réel. C'est aussi la
  // PREMIÈRE étape du parcours d'activation : la refuser en pré-ouverture est
  // cohérent — on ouvre, PUIS on contractualise.
  'signature.request.create': EFFECT.LEGAL_WRITE,

  // ── Hostinger ────────────────────────────────────────────────────────────
  // Les trois verbes du DNS (L9). Le moteur de déploiement PLANIFIE avec les
  // deux lectures, puis MUTE avec la troisième — et c'est cet ordre qui permet
  // de constater un conflit sans avoir rien touché.
  'dns.zone.resolve': EFFECT.READ_ONLY,
  'dns.records.read': EFFECT.READ_ONLY,
  // Déployer est précisément ce qu'on fait AVANT d'ouvrir.
  'dns.record.ensure': EFFECT.INFRASTRUCTURE_WRITE,
});

/** Décisions possibles. Fermées — l'appelant ne reçoit jamais un booléen nu. */
export const DECISION = Object.freeze({
  ALLOWED: 'ALLOWED',
  BLOCKED_PREOPENING: 'BLOCKED_PREOPENING',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
  INVALID_STATE: 'INVALID_STATE',
});

/** Code d'erreur canonique rendu à un projet dont l'action est refusée. */
export const COMMERCIAL_PREOPENING = 'COMMERCIAL_PREOPENING';

/* -------------------------------------------------------------------------- */
/*  LA DÉCISION                                                               */
/* -------------------------------------------------------------------------- */

/**
 * L'action réelle est-elle autorisée dans cet état d'ouverture ?
 *
 * ── CE QUE CETTE FONCTION NE FAIT PAS, ET NE FERA JAMAIS ────────────────────
 *
 * Elle ne rend AUCUN environnement, AUCUN mode, AUCUN jeu d'identifiants,
 * AUCUN point d'accès fournisseur. Sa signature ne contient pas le mot
 * « environment », et un test le vérifie : c'est la garantie, mécanique, que
 * l'ouverture commerciale ne redevient pas un sélecteur de monde.
 *
 * @param {{capability: string, commercialState?: string}} args
 * @returns {{decision: string, capability: string, effect: string|null,
 *            commercialState: string, code: string|null, reason: string}}
 */
export function canExecute({ capability, commercialState = DEFAULT_COMMERCIAL_STATE } = {}) {
  const state = COMMERCIAL_STATE_VALUES.includes(commercialState) ? commercialState : null;

  if (!state) {
    // Un état inconnu n'est pas une autorisation. Fail closed.
    return {
      decision: DECISION.INVALID_STATE,
      capability: capability ?? null,
      effect: null,
      commercialState: String(commercialState),
      code: COMMERCIAL_PREOPENING,
      reason: `État d’ouverture inconnu : « ${commercialState} ».`,
    };
  }

  const effect = CAPABILITY_EFFECTS[capability];
  if (!effect) {
    // Une capacité hors table est refusée, pas autorisée par défaut. Sans quoi
    // ajouter une capacité financière en oubliant cette table l'ouvrirait
    // silencieusement en pré-ouverture.
    return {
      decision: DECISION.UNKNOWN_CAPABILITY,
      capability: capability ?? null,
      effect: null,
      commercialState: state,
      code: COMMERCIAL_PREOPENING,
      reason: `Capacité inconnue de la politique d’ouverture : « ${capability} ».`,
    };
  }

  if (state === COMMERCIAL_STATE.PREOPENING && FORBIDDEN_IN_PREOPENING.includes(effect)) {
    return {
      decision: DECISION.BLOCKED_PREOPENING,
      capability,
      effect,
      commercialState: state,
      code: COMMERCIAL_PREOPENING,
      reason: `« ${capability} » engage un tiers réel (${effect}) : cette instance est en pré-ouverture.`,
    };
  }

  return {
    decision: DECISION.ALLOWED,
    capability,
    effect,
    commercialState: state,
    code: null,
    reason: 'Autorisée.',
  };
}

/** Raccourci booléen — pour un affichage, jamais pour une garde. */
export function isAllowed(args) {
  return canExecute(args).decision === DECISION.ALLOWED;
}

/**
 * Ce qu'une pré-ouverture interdit, pour l'écran de diagnostic.
 * Rendu trié : un ordre stable rend les captures d'écran comparables.
 */
export function capabilitiesBlockedInPreopening() {
  return Object.entries(CAPABILITY_EFFECTS)
    .filter(([, effect]) => FORBIDDEN_IN_PREOPENING.includes(effect))
    .map(([capability, effect]) => ({ capability, effect }))
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

/** Vue lisible de la politique complète — documentation exécutable. */
export function describePolicy() {
  return {
    states: [...COMMERCIAL_STATE_VALUES],
    defaultState: DEFAULT_COMMERCIAL_STATE,
    forbiddenEffectsInPreopening: [...FORBIDDEN_IN_PREOPENING],
    capabilities: Object.entries(CAPABILITY_EFFECTS)
      .map(([capability, effect]) => ({
        capability,
        effect,
        allowedInPreopening: !FORBIDDEN_IN_PREOPENING.includes(effect),
      }))
      .sort((a, b) => a.capability.localeCompare(b.capability)),
  };
}

export default {
  COMMERCIAL_STATE,
  COMMERCIAL_STATE_VALUES,
  DEFAULT_COMMERCIAL_STATE,
  EFFECT,
  CAPABILITY_EFFECTS,
  DECISION,
  COMMERCIAL_PREOPENING,
  canExecute,
  isAllowed,
  capabilitiesBlockedInPreopening,
  describePolicy,
};
