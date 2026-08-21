// « CE PROJET PEUT-IL PAYER ? PEUT-IL SIGNER ? » — une seule réponse, ici.
//
// ══ POURQUOI UN MODULE, ET NON DIX BOOLÉENS DISPERSÉS ═══════════════════════
//
// La question se pose à quatre endroits au moins — ouverture d'un paiement de
// frais de lancement, d'un abonnement, d'une prestation, et d'une demande de
// signature — et elle se posera à d'autres. Écrire `if (!company?.siren)` dans
// chacun d'eux garantit trois choses :
//
//   · les quatre finiront par diverger, parce qu'ils seront corrigés
//     séparément ;
//   · aucun écran ne pourra dire à l'utilisateur CE QUI manque, seulement que
//     « ce n'est pas possible » ;
//   · le jour où une mention devient obligatoire — le SIREN au 1er septembre
//     2026 — il faudra retrouver les quatre.
//
// Un seul résolveur, deux verdicts nommés, et des listes de champs manquants
// qui se rendent telles quelles à l'écran.
//
// ══ DEUX VERDICTS, PARCE QU'IL Y A DEUX MÉTIERS ═════════════════════════════
//
//   BILLING   ce qu'une FACTURE doit porter : une personne morale identifiée,
//             une adresse, un destinataire, un SIREN.
//   SIGNING   ce qu'une SIGNATURE exige : une personne physique nommée et
//             joignable, qui engage cette personne morale.
//
// Les deux sont indépendants. Une entreprise parfaitement identifiable peut
// n'avoir désigné personne pour signer ; un signataire complet ne remplace
// aucune adresse de facturation. Les fondre en un seul « prêt » aurait bloqué
// un paiement parfaitement légal parce qu'aucun contrat n'était prévu.
//
// ══ AUCUNE DÉCISION N'EST PRISE ICI ═════════════════════════════════════════
//
// Ce module CONSTATE. Il ne lève pas, ne journalise pas, n'écrit rien. Ce sont
// les gardes — côté capacité Stripe, côté capacité signature — qui refusent, et
// elles le font en citant ce constat. Un résolveur qui lèverait ne pourrait
// plus servir à peindre un écran, et il en faudrait un second.
import PanelClientCompany, {
  CLIENT_COMPANY_STATUS,
} from '../../models/PanelClientCompany.model.js';
import PanelProject from '../../models/PanelProject.model.js';

/**
 * LES ÉTATS — quatre, et l'ordre de priorité est celui de la lecture.
 *
 * `state` est une SYNTHÈSE destinée à l'affichage : quand deux manques
 * coexistent, il nomme celui qu'il faut traiter en premier. Les gardes, elles,
 * lisent `billing.ready` ou `signing.ready` — jamais `state` — parce qu'un
 * paiement n'a aucune raison d'être bloqué par l'absence d'un signataire.
 */
export const CLIENT_COMPANY_READINESS = Object.freeze({
  READY: 'READY',
  MISSING_COMPANY: 'MISSING_COMPANY',
  MISSING_BILLING_IDENTITY: 'MISSING_BILLING_IDENTITY',
  MISSING_SIGNER: 'MISSING_SIGNER',
});

/**
 * CE QU'UNE FACTURE EXIGE — la liste, écrite une fois.
 *
 * ══ POURQUOI LE SIREN EN FAIT PARTIE ════════════════════════════════════════
 *
 * Parce qu'il devient une mention obligatoire de la facture électronique
 * française au 1er septembre 2026, et parce qu'il est de toute façon la seule
 * donnée qui identifie DURABLEMENT la personne morale facturée. Une facture
 * sans SIREN se rapproche à la main, en cherchant un nom dans un annuaire.
 *
 * ══ POURQUOI L'ADRESSE EST EXIGÉE EN TROIS MORCEAUX ═════════════════════════
 *
 * `line1` seul produirait « 12 rue des Lilas » sans ville ni code postal — une
 * adresse qui ne permet pas d'envoyer un courrier, donc pas une adresse. Le
 * pays est exigé aussi : Stripe le refuse absent, et le régime de TVA en
 * dépend.
 */
const BILLING_FIELDS = Object.freeze([
  { path: 'legalName', label: 'Raison sociale' },
  { path: 'siren', label: 'SIREN' },
  { path: 'billingEmail', label: 'E-mail de facturation' },
  { path: 'billingAddress.line1', label: 'Adresse de facturation — voie' },
  { path: 'billingAddress.postalCode', label: 'Adresse de facturation — code postal' },
  { path: 'billingAddress.city', label: 'Adresse de facturation — ville' },
  { path: 'billingAddress.country', label: 'Adresse de facturation — pays' },
]);

/**
 * CE QU'UNE SIGNATURE EXIGE.
 *
 * Prénom, nom, adresse : c'est exactement ce que le fournisseur de signature
 * demande pour créer un signataire, et c'est ce que `buildSignerPayload` côté
 * projet exigeait déjà. La FONCTION (`jobTitle`) n'y figure pas — elle est une
 * mention de courtoisie sur le document, jamais une condition de validité.
 */
const SIGNER_FIELDS = Object.freeze([
  { path: 'contractualSigner.firstName', label: 'Signataire — prénom' },
  { path: 'contractualSigner.lastName', label: 'Signataire — nom' },
  { path: 'contractualSigner.email', label: 'Signataire — e-mail' },
]);

/** Lit un chemin pointé sans jamais lever sur un intermédiaire absent. */
function lire(source, chemin) {
  return chemin.split('.').reduce((noeud, cle) => (noeud == null ? undefined : noeud[cle]), source);
}

/** Une valeur RENSEIGNÉE : ni absente, ni vide, ni faite d'espaces. */
function renseigne(valeur) {
  return typeof valeur === 'string' ? valeur.trim() !== '' : valeur !== null && valeur !== undefined;
}

/**
 * L'ADRESSE DE FACTURATION EFFECTIVE — celle du siège quand aucune n'est propre.
 *
 * ══ POURQUOI CETTE RÉSOLUTION VIT ICI, ET DANS UN SEUL ENDROIT ══════════════
 *
 * `billingAddress: null` signifie « la même que le siège » (voir le modèle).
 * Chaque consommateur — la readiness, le client Stripe, l'instantané légal —
 * doit donc faire cette substitution, et s'ils la faisaient chacun de leur
 * côté, l'un d'eux finirait par facturer à une adresse que l'écran n'affiche
 * pas. Elle est écrite une fois, exportée, et personne ne la refait.
 */
export function effectiveBillingAddress(company) {
  const propre = company?.billingAddress ?? null;
  const utile = propre && (renseigne(propre.line1) || renseigne(propre.city));
  return utile ? propre : (company?.registeredOffice ?? null);
}

/**
 * LA VUE « FACTURABLE » d'une fiche — adresse déjà résolue.
 *
 * Les règles ci-dessus s'appliquent à CETTE vue, jamais au document brut :
 * sans quoi une entreprise dont seule l'adresse de siège est saisie serait
 * déclarée non facturable alors qu'elle l'est parfaitement.
 */
function vueFacturable(company) {
  return { ...company, billingAddress: effectiveBillingAddress(company) };
}

function manquants(source, champs) {
  return champs.filter(({ path }) => !renseigne(lire(source, path))).map(({ label }) => label);
}

/**
 * CONSTATE l'état de préparation d'une entreprise cliente DÉJÀ CHARGÉE.
 *
 * Fonction PURE — aucune lecture de base. C'est elle que les tests éprouvent,
 * et c'est elle que réutilise l'écran du Panel, qui a déjà la fiche en main.
 *
 * @param {object|null} company  la fiche, ou `null` si aucune n'est rattachée
 * @returns {{state: string, ready: boolean, clientCompanyId: string|null,
 *   billing: {ready: boolean, missing: string[]},
 *   signing: {ready: boolean, missing: string[]},
 *   archived: boolean}}
 */
export function describeClientCompanyReadiness(company) {
  if (!company) {
    return {
      state: CLIENT_COMPANY_READINESS.MISSING_COMPANY,
      ready: false,
      clientCompanyId: null,
      archived: false,
      billing: { ready: false, missing: ['Entreprise cliente rattachée'] },
      signing: { ready: false, missing: ['Entreprise cliente rattachée'] },
    };
  }

  /**
   * UNE ENTREPRISE ARCHIVÉE N'EST PRÊTE À RIEN — et ce n'est pas un manque de
   * donnée, c'est une décision. On la traite donc comme « pas d'entreprise »
   * pour les gardes, tout en disant franchement pourquoi : présenter la liste
   * des champs manquants d'une fiche complète mais archivée enverrait
   * l'opérateur remplir des cases qui sont déjà remplies.
   */
  if (company.status === CLIENT_COMPANY_STATUS.ARCHIVED) {
    return {
      state: CLIENT_COMPANY_READINESS.MISSING_COMPANY,
      ready: false,
      clientCompanyId: company.clientCompanyId ?? null,
      archived: true,
      billing: { ready: false, missing: ['Entreprise cliente archivée'] },
      signing: { ready: false, missing: ['Entreprise cliente archivée'] },
    };
  }

  const facturable = vueFacturable(company);
  const billingMissing = manquants(facturable, BILLING_FIELDS);
  const signingMissing = manquants(company, SIGNER_FIELDS);

  const billing = { ready: billingMissing.length === 0, missing: billingMissing };
  const signing = { ready: signingMissing.length === 0, missing: signingMissing };

  let state = CLIENT_COMPANY_READINESS.READY;
  if (!billing.ready) state = CLIENT_COMPANY_READINESS.MISSING_BILLING_IDENTITY;
  else if (!signing.ready) state = CLIENT_COMPANY_READINESS.MISSING_SIGNER;

  return {
    state,
    ready: billing.ready && signing.ready,
    clientCompanyId: company.clientCompanyId ?? null,
    archived: false,
    billing,
    signing,
  };
}

/**
 * L'ENTREPRISE CLIENTE D'UN PROJET — ou `null`.
 *
 * Une lecture, deux requêtes, aucune jointure : le lien vit sur la fiche du
 * registre (`PanelProject.clientCompanyId`), l'identité vit dans sa propre
 * collection. C'est la seule forme qui permette de changer de rattachement sans
 * toucher à l'identité, et de corriger l'identité sans toucher aux projets.
 */
export async function clientCompanyOfProject(projectId) {
  const projet = await PanelProject.findOne({ projectId }).select('clientCompanyId').lean();
  const id = projet?.clientCompanyId ?? null;
  if (!id) return null;
  return PanelClientCompany.findOne({ clientCompanyId: id }).lean();
}

/**
 * LE POINT D'ENTRÉE DES GARDES — « ce projet est-il en état ? ».
 *
 * @param {{projectId: string}} args
 * @returns {Promise<object>} le constat, augmenté de la fiche (`company`) pour
 *   que l'appelant n'ait pas à la relire — la construction d'un client Stripe
 *   en a besoin immédiatement après.
 */
export async function resolveClientCompanyReadiness({ projectId }) {
  const company = await clientCompanyOfProject(projectId);
  return { ...describeClientCompanyReadiness(company), company };
}

export default {
  CLIENT_COMPANY_READINESS,
  describeClientCompanyReadiness,
  effectiveBillingAddress,
  clientCompanyOfProject,
  resolveClientCompanyReadiness,
};
