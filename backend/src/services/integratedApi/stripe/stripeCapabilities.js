// CAPACITÉS STRIPE — les contrats, avant tout cutover (L6.1).
//
// docs/architecture/STRIPE_L6_1_CONTROL_PLANE_FOUNDATION_REPORT.md §« Capacités ».
//
// ── CE FICHIER NE MIGRE RIEN ────────────────────────────────────────────────
//
// Il POSE les contrats : ce qu'une capacité accepte, ce qu'elle rend, ce
// qu'elle exige avant d'agir. Aucune n'est déclarée servie — l'ancrage
// d'appartenance des ressources Stripe n'existe pas encore côté Panel
// (`stripeResourceOwnership.js`), et servir sans lui donnerait à un projet le
// pouvoir d'agir sur les objets d'un autre.
//
// ── LES CAPACITÉS VIENNENT DU RUNTIME RÉEL ──────────────────────────────────
//
// L'audit du 2026-08-10 relève exactement treize méthodes appelées côté projet.
// On n'en contractualise ici que celles qui correspondent à un ACTE MÉTIER
// distinct — pas les primitives internes qu'un acte compose.
//
// Ainsi `createProduct` et `createPrice` n'ont pas de capacité : elles ne sont
// jamais un but, seulement les deux étapes que `ensureProductAndPrice` traverse
// pour figer le tarif d'un abonnement. Les exposer donnerait au projet un
// pouvoir qu'il n'a jamais demandé — créer des produits arbitraires sur le
// compte Stripe de la plateforme.
//
// `billing.refund` a longtemps été absente pour cette même raison : aucun code
// du parc n'appelait `refunds.create`, les remboursements se faisaient depuis le
// tableau de bord Stripe, et contractualiser un acte que personne n'émet aurait
// créé la capacité la plus dangereuse du système pour un usage inexistant.
// L10.4 change ce fait : le Panel rembourse désormais depuis l'onglet Finances
// d'un projet. La capacité entre donc au catalogue avec un appelant réel — et
// c'est le seul motif d'entrée admis ici.
import { z } from 'zod';

import { getProviderDefinition } from '../providerRegistry.js';
import { STRIPE_RESOURCE_KINDS } from './stripeResourceOwnership.js';

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `operationId` — l'identité de l'ACTE MÉTIER, fournie par le projet.
 *
 * Plus long que pour les autres fournisseurs (16 caractères minimum) : sur un
 * provider financier, deux actes distincts qui se retrouveraient avec la même
 * identité produiraient soit un paiement manquant, soit un doublon. On force
 * une identité assez large pour être réellement unique.
 */
const operationId = z.string().trim().min(16).max(96);

/** Identifiants Stripe — forme contrôlée, appartenance vérifiée plus loin. */
const subscriptionId = z.string().trim().regex(/^sub_[A-Za-z0-9_]+$/, 'Identifiant d’abonnement invalide.');
const customerId = z.string().trim().regex(/^cus_[A-Za-z0-9_]+$/, 'Identifiant de client invalide.');
const checkoutSessionId = z.string().trim().regex(/^cs_[A-Za-z0-9_]+$/, 'Identifiant de session invalide.');
/** L10.4 — refuser tôt : un `in_…` présenté là où on rembourse est une confusion. */
const paymentIntentId = z.string().trim().regex(/^pi_[A-Za-z0-9_]+$/, 'Identifiant de paiement invalide.');
/**
 * La RÉFÉRENCE DE CONTRAT — la seule identité métier que le projet apporte pour
 * désigner ce qui lui appartient (L6.2B). Le Panel en dérive le client, le
 * tarif, les factures : le projet ne nomme jamais un objet Stripe.
 */
const contractRef = z.string().trim().min(1).max(64);

/**
 * `strict()` partout. Les champs explicitement REFUSÉS, et pourquoi :
 *
 *   `mode`, `environment`, `livemode`  le monde appartient au Panel (L2) ;
 *   `secretKey`, `apiKey`              le projet n'en détient plus ;
 *   `account`, `stripeAccount`         Connect n'est pas utilisé, et l'ouvrir
 *                                      permettrait d'agir sur un autre compte ;
 *   `amount` libre sur une lecture     une lecture ne porte pas de montant.
 */
/**
 * `billing.invoice.list` — LES FACTURES D'UN CONTRAT (ouverte en L6.3B).
 *
 * ══ CE QUI A CHANGÉ, ET POURQUOI ═══════════════════════════════════════════
 *
 * Le contrat de L6.1 acceptait `customerId` OU `subscriptionId`. C'est
 * précisément ce qui l'a maintenue fermée pendant sept lots : un projet nommant
 * le client dont il veut les factures nomme un client qu'il pourrait ne pas
 * posséder, et l'appartenance d'une facture ne se prouve pas objet par objet.
 *
 * Elle ne prend plus que la référence de CONTRAT. Le Panel en dérive le client
 * — celui du lien d'appartenance de L6.2D, qu'il a lui-même créé — et liste ses
 * factures. Le projet ne peut donc demander que les siennes, et l'identifiant
 * qu'il présenterait ne vaudrait rien.
 */
const invoiceListInput = z.object({
  contractRef,
  limit: z.number().int().min(1).max(100).optional(),
  operationId,
}).strict();

/**
 * `billing.invoice.retrieve` — UNE facture, désignée par son contrat (L6.3B).
 *
 * Le contrat d'abord, l'identifiant ensuite : c'est le contrat qui porte
 * l'appartenance, et l'identifiant n'est qu'un filtre. Le Panel vérifie que la
 * facture rendue appartient bien au client possédé — sans quoi il refuserait
 * exactement comme si elle n'existait pas.
 */
const invoiceRetrieveInput = z.object({
  contractRef,
  invoiceId: z.string().trim().regex(/^in_[A-Za-z0-9_]+$/, 'Identifiant de facture invalide.'),
  operationId,
}).strict();

/**
 * `billing.portal.create` — LE PORTAIL CLIENT (L6.3B).
 *
 * ══ CE QUE LE PROJET N'APPORTE PAS ═════════════════════════════════════════
 *
 * Pas de `customerId`. C'est la seule chose qui compte ici : le portail donne
 * accès aux moyens de paiement, aux factures et aux abonnements d'un client.
 * Laisser le projet le désigner reviendrait à lui laisser ouvrir le portail de
 * n'importe qui — un vol de données qui ne ressemblerait même pas à une
 * effraction, puisque l'appel serait parfaitement formé.
 *
 * Il nomme donc son CONTRAT, et le Panel remonte au client par le lien
 * d'appartenance qu'il a lui-même écrit en L6.2D.
 *
 * `returnUrl` est l'adresse où Stripe renvoie le client après coup. Elle est
 * cosmétique — elle n'ouvre aucun accès — mais elle est bornée : une adresse
 * absolue http(s), et rien d'autre.
 */
const portalCreateInput = z.object({
  contractRef,
  returnUrl: z.string().url().max(2_048),
  operationId,
}).strict();

const portalSessionView = z.object({
  url: z.string(),
  /** Quand cette URL cessera de fonctionner — le projet peut le dire au client. */
  expiresAt: z.number().nullable(),
}).strict();

const subscriptionRetrieveInput = z.object({ subscriptionId, operationId }).strict();

const checkoutRetrieveInput = z.object({ checkoutSessionId, operationId }).strict();

/**
 * `billing.checkout.create` — le contrat le plus délicat du lot.
 *
 * Le projet décrit l'INTENTION (quel contrat, quel type de paiement, où
 * revenir) ; il ne décrit ni le prix, ni le client Stripe, ni la devise. Le
 * montant vient de la projection de contrat que le Panel détient déjà : laisser
 * le projet l'annoncer permettrait de facturer un euro un contrat à mille.
 */
const checkoutCreateInput = z.object({
  /**
   * Référence du contrat, telle que le Panel la connaît par projection.
   *
   * FACULTATIVE depuis L10.5 : une prestation ponctuelle n'appartient à aucun
   * contrat. Le raffinement en bas de ce schéma exige l'une OU l'autre des deux
   * références selon le type — jamais aucune, jamais les deux.
   */
  contractRef: z.string().trim().min(1).max(64).optional(),
  /**
   * L10.5 — LA PRESTATION À PAYER, DÉSIGNÉE PAR SON IDENTITÉ INTERNE.
   *
   * ══ CE QUI N'ENTRE PAS ICI, ET C'EST TOUT LE POINT ════════════════════════
   *
   * Aucun montant. Le projet nomme une demande ; le Panel lit LE SIEN, dans son
   * propre document. Un client qui remplacerait 500 par 5 dans la requête ne
   * modifierait rien — il n'y a pas de montant dans la requête à modifier.
   *
   * C'est la même doctrine que `contractRef` depuis L6.2B (« laisser le projet
   * l'annoncer permettrait de facturer un euro un contrat à mille »), appliquée
   * à un objet qui n'est pas un contrat.
   */
  paymentRequestId: z.string().trim().uuid().optional(),
  paymentType: z.enum(['LAUNCH_FEE', 'SUBSCRIPTION', 'SERVICE']),
  successUrl: z.string().trim().url().max(2048),
  cancelUrl: z.string().trim().url().max(2048),
  /**
   * CORROBORATION — recopiée dans les metadata Stripe, jamais interrogée (L6.2B).
   *
   * Le journal de paiement du projet se rattache aux objets Stripe par
   * `metadata.paymentId` depuis l'origine ; couper ce fil casserait la
   * réconciliation historique sans rien gagner. Mais ces valeurs ne décident de
   * RIEN : les metadata Stripe s'éditent depuis le tableau de bord, et
   * l'autorité d'appartenance reste le registre de liens de L6.2A.
   *
   * Volontairement close et courte : c'est une référence opaque, pas un canal.
   */
  correlation: z.object({
    paymentRef: z.string().trim().min(1).max(64).optional(),
  }).strict().optional(),
  operationId,
}).strict().superRefine((valeur, ctx) => {
  /**
   * UNE RÉFÉRENCE, ET UNE SEULE — celle que le type exige.
   *
   * ══ POURQUOI UN RAFFINEMENT PLUTÔT QUE DEUX SCHÉMAS ══════════════════════
   *
   * Deux schémas auraient signifié deux capacités, donc deux adaptateurs, deux
   * clés d'idempotence et deux chemins d'appartenance — pour un acte qui est le
   * MÊME : ouvrir une session de paiement. Ce qui change n'est pas l'acte, c'est
   * d'où le Panel tire le montant.
   *
   * Le refus des DEUX références à la fois n'est pas du zèle : accepter
   * l'ambiguïté obligerait l'autorité à choisir, et ce choix serait la première
   * chose qu'on chercherait à retourner contre elle.
   */
  const service = valeur.paymentType === 'SERVICE';
  if (service && !valeur.paymentRequestId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paymentRequestId'],
      message: 'Une prestation doit désigner la demande de paiement à régler.',
    });
  }
  if (!service && !valeur.contractRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contractRef'],
      message: 'Ce type de paiement doit désigner un contrat.',
    });
  }
  if (valeur.contractRef && valeur.paymentRequestId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paymentRequestId'],
      message: 'Un paiement désigne un contrat OU une prestation, jamais les deux.',
    });
  }
});

/**
 * LES DEUX RÉSILIATIONS — contrats ÉTROITS, et sans `operationId` (L6.2G).
 *
 * ══ POURQUOI PAS DE VERBE GÉNÉRIQUE ═════════════════════════════════════════
 *
 * Une capacité `billing.subscription.update` permettrait n'importe quelle
 * mutation d'abonnement — changer le tarif, la quantité, la période d'essai.
 * On n'expose donc que les deux gestes que le parc pratique réellement, chacun
 * avec son propre contrat et sa propre politique.
 *
 * ══ POURQUOI PAS D'`operationId` NON PLUS ═══════════════════════════════════
 *
 * Un paiement peut légitimement être retenté : une session expire, une carte
 * est refusée, et la tentative suivante est un acte NOUVEAU. C'est pourquoi le
 * projet nomme ses paiements.
 *
 * Une résiliation est TERMINALE : « résilier cet abonnement de cette façon »
 * n'a pas de seconde tentative légitime, seulement des rejeux de la même
 * intention. Laisser le projet nommer l'acte lui permettrait d'en fabriquer
 * deux — de couper deux fois ce qui ne se coupe qu'une. L'identité est donc
 * dérivée du monde et de l'abonnement.
 */
const subscriptionCancelInput = z.object({ subscriptionId }).strict();

/**
 * `webhook.endpoint.ensure` — GARANTIR L'ENDPOINT D'UN PROJET (L6.3A).
 *
 * ══ CE QUE LE PROJET APPORTE, ET C'EST TOUT ═════════════════════════════════
 *
 * Son adresse publique. Rien d'autre.
 *
 * Pas d'identifiant d'endpoint : s'il pouvait désigner un `we_…`, il
 * désignerait celui d'un autre projet, et le Panel finirait par lui livrer un
 * secret qui n'est pas le sien.
 *
 * Pas la liste des événements : il pourrait en retirer un dont son propre
 * métier dépend, et personne ne s'en apercevrait avant qu'un paiement ne
 * remonte plus. Le Panel la connaît, et c'est lui qui la pose.
 *
 * Pas le monde, pas le compte, pas la clé — comme partout ailleurs.
 *
 * ══ POURQUOI `ensure` ═══════════════════════════════════════════════════════
 *
 * L'appelant n'exprime pas « crée » mais « fais en sorte que ». Il ne sait pas,
 * et n'a pas à savoir, si l'endpoint existe déjà, s'il a dérivé, ou si son
 * adresse a changé depuis hier. Un projet redémarre, un tunnel bouge : la même
 * phrase doit convenir dans tous les cas, et converger vers un seul endpoint.
 */
const webhookEndpointEnsureInput = z.object({
  /**
   * L'adresse RACINE, pas la route de réception : le chemin est décidé par le
   * Panel à partir du registre. Un projet qui choisirait son chemin pourrait
   * faire pointer l'endpoint vers une route qui ne vérifie rien.
   */
  publicBackendUrl: z.string().url().max(2_048),
}).strict();

/**
 * CE QUE LE PANEL REND — et ce qu'il ne rend PAS.
 *
 * Le secret de vérification N'EST PAS ICI, et son absence est le cœur du lot :
 * le résultat d'une capacité traverse la garde L4, qui refuse tout identifiant
 * fournisseur. Le secret voyage par une route dédiée qui ne transporte que
 * cela — voir `webhookVerification.controller.js`.
 *
 * `secretAvailable` dit seulement s'il y a quelque chose à aller chercher. Le
 * projet peut donc savoir qu'il doit rafraîchir sans qu'aucun secret n'ait
 * transité par ce canal.
 */
const webhookEndpointView = z.object({
  endpointId: z.string().nullable(),
  url: z.string(),
  events: z.array(z.string()),
  status: z.string(),
  created: z.boolean(),
  updated: z.boolean(),
  /** Un secret courant existe-t-il côté Panel pour ce projet ? */
  secretAvailable: z.boolean(),
  /** A-t-il été (re)posé pendant CET appel ? Le projet sait qu'il doit relire. */
  secretRenewed: z.boolean(),
}).strict();

/**
 * `billing.refund` — LE SEUL CONTRAT QUI REND DE L'ARGENT (L10.4).
 *
 * ══ POURQUOI L'INTENTION DE PAIEMENT, ET PAS LA FACTURE ═════════════════════
 *
 * Le Panel projette des revenus depuis quatre objets Stripe différents — session
 * de paiement, facture, intention, débit (L10.3). Un seul est commun à TOUS les
 * encaissements et acceptable par `POST /v1/refunds` : l'intention. Rembourser
 * « une facture » n'existe pas chez Stripe ; rembourser « un abonnement » non
 * plus. Le contrat nomme donc ce qui est réellement remboursable.
 *
 * ══ POURQUOI L'APPARTENANCE PORTE SUR `pi_…` ════════════════════════════════
 *
 * `PAYMENT_INTENT` est une famille liable depuis L6.2A, mais rien n'en créait de
 * lien. L10.4 en pose un À LA PROJECTION du revenu, par filiation de la session
 * ou de l'abonnement possédé qui l'a produit — exactement le mécanisme d'adoption
 * de L6.2F. La vérification d'appartenance porte donc ici sur la ressource même
 * qu'on s'apprête à muter, sans détour ni raisonnement d'adaptateur.
 *
 * ══ LE MONTANT ══════════════════════════════════════════════════════════════
 *
 * Absent = remboursement TOTAL du restant. Ce n'est pas un raccourci : envoyer
 * un total calculé chez nous ferait échouer l'acte si un autre remboursement
 * s'est glissé entre notre lecture et notre écriture, là où l'omission converge.
 */
const refundInput = z.object({
  paymentIntentId,
  /** En centimes. Absent = total du restant remboursable, tranché par Stripe. */
  amountCents: z.number().int().positive().max(100_000_000).optional(),
  /**
   * Les TROIS seuls motifs que Stripe accepte. La raison libre de l'opérateur
   * n'est pas transmise au fournisseur : elle vit dans la demande de
   * remboursement du Panel, où elle est lisible sans compte Stripe.
   */
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
  operationId,
}).strict();

/**
 * `outcome` distingue l'acte NEUF du rejeu convergent — comme la résiliation.
 *
 * `ALREADY_REFUNDED` ne signifie pas « ce paiement était déjà remboursé » : il
 * peut l'être partiellement et rester remboursable. Il signifie « CET acte-ci,
 * sous CETTE identité, était déjà inscrit chez Stripe » — retrouvé par la
 * métadonnée qu'on y appose. C'est la convergence hors fenêtre d'idempotence.
 */
const refundView = z.object({
  refundId: z.string(),
  status: z.string().nullable(),
  amountCents: z.number().int(),
  currency: z.string(),
  paymentIntentId: z.string().nullable(),
  chargeId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number().nullable(),
  /**
   * Le reçu Stripe de la CHARGE — pas du remboursement, qui n'a ni PDF ni page.
   * Stripe le réédite après un remboursement et y affiche les sommes rendues :
   * c'est le seul document que le fournisseur produise réellement ici.
   */
  receiptUrl: z.string().nullable(),
  /** État du paiement APRÈS l'acte — ce qui reste remboursable. */
  collectedCents: z.number().int(),
  refundedCents: z.number().int(),
  remainingCents: z.number().int(),
  outcome: z.enum(['REFUNDED', 'ALREADY_REFUNDED']),
}).strict();

/**
 * `billing.customer.ensure` — LE SEUL CONTRAT SANS `operationId`, et c'est le
 * cœur de sa sémantique (L6.2D).
 *
 * ══ POURQUOI LE PROJET NE NOMME PAS CET ACTE ════════════════════════════════
 *
 * Partout ailleurs, le projet fournit l'identité de l'acte : lui seul sait que
 * deux clics sont la même intention. `ensure` ne pose pas cette question — elle
 * affirme « converge vers l'unique client de ce contrat ». La réponse correcte
 * est déterminée par le contrat, et il n'y en a qu'une.
 *
 * Accepter une identité fournie permettrait d'appeler deux fois avec deux
 * identités pour le même contrat et d'obtenir deux clients : exactement ce que
 * le verbe promet d'empêcher. L'identité est donc DÉRIVÉE côté Panel, du
 * contrat VÉRIFIÉ — voir `stripeCustomerAuthority.customerOperationId()`.
 *
 * ══ CE QUE LE PROJET APPORTE, ET RIEN DE PLUS ═══════════════════════════════
 *
 * L'identité de la personne à facturer. Le Panel ne peut pas la déduire : sa
 * projection de contrat ne porte pas les signataires. Il n'y a ni adresse, ni
 * téléphone, ni moyen de paiement — le code historique n'en envoyait aucun.
 *
 * `customerId` est ABSENT du schéma, délibérément : un projet ne propose jamais
 * la ressource à adopter. Voir le § adoption du rapport L6.2D.
 */
/**
 * ══ `customer` EST DEVENU FACULTATIF — ET SURTOUT, IL N'EST PLUS LU ═════════
 *
 * ── CE QU'IL FAISAIT, ET POURQUOI C'ÉTAIT LA FAUTE DE TOUT LE CHANTIER ──────
 *
 * Le commentaire ci-dessus disait vrai à l'époque : « le Panel ne peut pas
 * déduire l'identité de la personne à facturer, sa projection de contrat ne
 * porte pas les signataires ». La conclusion — la demander au projet — était
 * la seule possible.
 *
 * En pratique, le projet ne la connaissait pas non plus. Il envoyait donc un
 * objet vide, et l'autorité retombait sur `projection.reference` : la
 * RÉFÉRENCE DE CONTRAT. D'où « Facturer à : CTR-2026-0002 » sur des factures
 * réelles.
 *
 * ── CE QUI A CHANGÉ ────────────────────────────────────────────────────────
 *
 * Le Panel détient désormais `PanelClientCompany` — l'identité juridique du
 * client, rattachée au projet, avec sa raison sociale, son SIREN, ses adresses
 * et son e-mail de facturation. Il n'a plus rien à demander : il SAIT.
 *
 * ── POURQUOI LE CHAMP RESTE DÉCLARÉ ────────────────────────────────────────
 *
 * Parce qu'un projet non encore redéployé continue de l'envoyer. Le retirer du
 * schéma ferait échouer ses appels en `CAPABILITY_INPUT_INVALID` — un projet
 * parfaitement sain rendu incapable de facturer par un durcissement de contrat.
 *
 * Il est donc ACCEPTÉ et IGNORÉ. `stripeCustomerAuthority` ne le lit plus, et
 * un test le vérifie : c'est la seule façon de garantir qu'il ne redeviendra
 * pas, un jour, un repli « pendant qu'on y est ».
 */
const customerEnsureInput = z.object({
  /**
   * ── FACULTATIF DEPUIS QUE L’AUTORITÉ EST L’ENTREPRISE CLIENTE ─────────────
   *
   * Une prestation ponctuelle n’a pas de contrat. L’exiger revenait à interdire
   * de la facturer — c’est-à-dire à émettre une facture sans destinataire
   * juridique, ce que ce parc a précisément cessé de faire.
   *
   * Fourni, il reste VÉRIFIÉ : `resolveCustomerIntent` refuse un contrat qui
   * n’est pas celui du projet, exactement comme avant. Le rendre facultatif
   * n’ouvre donc aucune porte ; cela distingue « pas de contrat » de « pas le
   * bon contrat », qui sont deux situations différentes.
   */
  contractRef: z.string().trim().min(1).max(64).optional(),
  customer: z.object({
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    name: z.string().trim().min(1).max(160).optional(),
  }).strict().optional(),
}).strict();

/**
 * `billing.price.ensure` — même forme que `customer.ensure`, même raison.
 *
 * Le projet apporte UNE référence de contrat, et rien d'autre. Ni montant, ni
 * devise, ni périodicité : le Panel les lit dans sa projection, dont il est
 * l'autorité. Ni `productId`, ni `priceId` : proposer une ressource à adopter
 * reviendrait à faire du registre d'appartenance un registre de déclarations.
 *
 * Aucun `operationId` non plus — l'identité de l'acte est DÉRIVÉE des termes du
 * contrat. « Ce contrat a-t-il son tarif ? » n'a qu'une réponse correcte.
 */
const priceEnsureInput = z.object({
  contractRef: z.string().trim().min(1).max(64),
}).strict();

/**
 * SORTIE — ce que le checkout d'abonnement consomme, plus de quoi se relire.
 *
 * `amount`, `currency` et `interval` sont RENDUS et non reçus : le projet peut
 * vérifier que le Panel a bien retenu les termes qu'il croit avoir publiés,
 * sans jamais pouvoir les imposer. C'est une reddition de comptes, pas un canal.
 */
const priceEnsureOutput = z.object({
  priceId: z.string(),
  productId: z.string(),
  status: z.enum(['CREATED', 'EXISTING']),
  interval: z.enum(['month', 'year']),
  /**
   * LE NOMBRE DE PAS — rendu, comme le reste des termes.
   *
   * Sans lui, un projet ayant publié « tous les 3 mois » ne pouvait pas
   * vérifier que le Panel avait retenu autre chose que du mensuel : il lisait
   * `month` et n'en apprenait rien. La reddition de comptes n'a de valeur que
   * si elle porte sur TOUS les termes du tarif.
   */
  intervalCount: z.number().int().positive(),
  amount: z.number().int().positive(),
  currency: z.string(),
}).strict();

/**
 * CE QUE REND UNE RÉSILIATION — l'état de l'abonnement, plus le CONSTAT.
 *
 * Les mêmes champs que `billing.subscription.retrieve` : le projet projette
 * déjà cet état, et lui rendre une seconde forme l'obligerait à écrire deux
 * traductions pour une même réalité.
 *
 * `outcome` porte la seule information vraiment nouvelle : a-t-on muté, ou
 * constaté que c'était déjà fait ? `ALREADY_CANCELLED` n'est PAS un échec —
 * c'est la preuve qu'une reprise a convergé sans rien recouper.
 */
const subscriptionCancelledView = z.object({
  subscriptionId: z.string(),
  status: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.number().nullable(),
  currentPeriodEnd: z.number().nullable(),
  latestInvoiceId: z.string().nullable(),
  customerId: z.string().nullable(),
  outcome: z.enum(['CANCELLED', 'ALREADY_CANCELLED']),
}).strict();

const customerEnsureOutput = z.object({
  customerId: z.string(),
  /**
   * `CREATED` — le Panel vient de le créer. `EXISTING` — ce contrat en avait
   * déjà un, retrouvé par son lien. Il n'y a PAS de troisième valeur : aucune
   * adoption d'un identifiant présenté par le projet n'est possible.
   */
  status: z.enum(['CREATED', 'EXISTING']),
}).strict();

/* -------------------------------------------------------------------------- */
/*  SORTIES                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ce qui revient au projet : un CONSTAT métier, jamais l'objet Stripe brut.
 *
 * Un objet Stripe complet porte le client, ses adresses, ses moyens de
 * paiement, et l'identifiant du compte. Le relayer ferait traverser au pont des
 * données personnelles qu'aucune capacité n'a promises.
 */
/**
 * CE QU'UNE FACTURE MONTRE AU PROJET — établi sur ce qu'il ÉCRIT, pas sur ce
 * que Stripe expose (L6.3B).
 *
 * Le contrat de L6.1 portait neuf champs, posés avant qu'aucun appelant
 * n'existe. `upsertInvoiceFromStripe` côté SB Auto en lit six de plus : la
 * taxe, le total, l'échéance, la date de paiement effectif, le motif de
 * facturation et l'abonnement d'origine. Sans eux, migrer la lecture aurait
 * appauvri la facture locale — des montants hors taxe faux, des dates vides —
 * et personne ne l'aurait vu avant la première déclaration.
 *
 * Ils sont donc ajoutés parce qu'ils sont LUS, un par un. Ne traversent
 * toujours pas : les lignes de facture, le moyen de paiement, l'adresse de
 * facturation, le solde du client — rien de tout cela n'est écrit côté projet.
 */
const invoiceView = z.object({
  invoiceId: z.string(),
  number: z.string().nullable(),
  status: z.string().nullable(),
  paid: z.boolean(),
  amountDue: z.number().nullable(),
  amountPaid: z.number().nullable(),
  /** Le TOTAL — c'est lui qui fait le montant TTC local, pas `amount_due`. */
  total: z.number().nullable(),
  /** La taxe, sans laquelle le montant hors taxe local serait faux. */
  tax: z.number().nullable(),
  currency: z.string().nullable(),
  createdAt: z.number().nullable(),
  dueAt: z.number().nullable(),
  /** Quand elle a RÉELLEMENT été payée — jamais reconstruit localement. */
  paidAt: z.number().nullable(),
  billingReason: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
  invoicePdfUrl: z.string().nullable(),
  customerId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
}).strict();

const invoiceListOutput = z.object({
  invoices: z.array(invoiceView),
  hasMore: z.boolean(),
}).strict();

/**
 * VUE D'ABONNEMENT — établie sur ce que le projet PROJETTE, pas sur ce que
 * Stripe expose (L6.2F).
 *
 * `projectSubscription()` côté SB Auto lit exactement : statut, résiliation
 * différée, début et fin de période, dernière facture, client. `currency`
 * disparaît du contrat L6.1 — personne ne la lisait, et un champ rendu « au cas
 * où » finit par être utilisé comme une autorité.
 *
 * Ne traversent pas : les lignes d'abonnement, le moyen de paiement par défaut,
 * les remises, l'historique de facturation.
 */
const subscriptionView = z.object({
  subscriptionId: z.string(),
  status: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.number().nullable(),
  currentPeriodEnd: z.number().nullable(),
  latestInvoiceId: z.string().nullable(),
  customerId: z.string().nullable(),
}).strict();

/**
 * VUE DE LECTURE — établie sur ce que le projet CONSOMME, pas sur ce que Stripe
 * expose (L6.2C).
 *
 * `paymentIntentId` et `customerId` s'ajoutent au contrat L6.1 parce que le
 * filet de réconciliation du projet en a besoin : sans eux, il marquerait un
 * paiement PAYÉ sans savoir quelle transaction l'a payé, et le journal
 * affirmerait plus qu'il ne sait.
 *
 * Rien d'autre ne s'y ajoute. Notamment pas les metadata : elles sont
 * corroboratives par nature (éditables depuis le tableau de bord), et les
 * rendre inviterait un appelant à s'en servir comme d'une autorité.
 */
const checkoutView = z.object({
  checkoutSessionId: z.string(),
  status: z.string().nullable(),
  paymentStatus: z.string().nullable(),
  /** L'URL n'est rendue QUE tant que la session est ouverte. */
  url: z.string().nullable(),
  expiresAt: z.number().nullable(),
  paymentIntentId: z.string().nullable(),
  customerId: z.string().nullable(),
  /** L'abonnement ouvert par cette session, quand elle en a ouvert un (L6.2E). */
  subscriptionId: z.string().nullable(),
}).strict();

const checkoutCreateOutput = z.object({
  checkoutSessionId: z.string(),
  /**
   * NULLABLE, et c'est un fait métier (corrigé en L6.2B).
   *
   * Stripe cesse de rendre une URL dès que la session est complétée ou expirée.
   * Le contrat L6.1 la promettait toujours présente : sur une REPRISE d'acte
   * déjà payé, il aurait fallu inventer une chaîne, et le projet aurait envoyé
   * un client vers un lien mort en croyant l'envoyer payer.
   */
  url: z.string().nullable(),
  /**
   * L'ÉTAT, parce qu'une reprise doit pouvoir se raconter.
   *
   * Ce n'est pas l'ouverture d'une capacité de lecture : c'est la description
   * de l'objet que CET appel vient de produire ou de retrouver. Sans elle, un
   * `REUSED` sans URL serait indistinguable d'une panne.
   */
  status: z.string().nullable(),
  paymentStatus: z.string().nullable(),
  /**
   * LES DEUX OBJETS QUE LA SESSION A ELLE-MÊME PRODUITS.
   *
   * Ils ne sont pas une lecture offerte au projet : ce sont les sous-produits
   * de l'acte qu'il vient de demander, et ils lui appartiennent au même titre
   * que la session. Sans eux, la réparation d'un webhook perdu marquerait un
   * paiement PAYÉ sans savoir quelle transaction l'a payé — un journal qui
   * affirme plus qu'il ne sait.
   *
   * `null` tant que la session est ouverte : Stripe ne les attribue qu'au
   * paiement. Aucun secret : ce sont des identifiants d'objets, pas des clés.
   */
  paymentIntentId: z.string().nullable(),
  customerId: z.string().nullable(),
  /**
   * L'ABONNEMENT que la session a ouvert (L6.2E). `null` tant qu'elle n'est pas
   * complétée — Stripe ne le crée qu'au paiement. Sans lui, la réconciliation
   * du projet marquerait un abonnement actif sans savoir lequel.
   */
  subscriptionId: z.string().nullable(),
  /** `REUSED` quand l'acte avait déjà produit sa session — voir L6.2B §reprise. */
  creation: z.enum(['CREATED', 'REUSED']),
  operationId: z.string(),
}).strict();

/* -------------------------------------------------------------------------- */
/*  DÉFINITIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Effets PROPOSÉS pour les codes que la table de L1.75 ne connaît pas encore.
 *
 * Même dispositif qu'en L9 : la table officielle l'emporte dès qu'elle connaît
 * un code, et `validateStripeCapabilities()` échoue si les deux divergent.
 * Les codes déjà présents (`billing.checkout.create`,
 * `billing.subscription.cancel_at_period_end`, `billing.invoice.list`,
 * `billing.subscription.reconcile`) ne figurent PAS ici : ils ont leur autorité.
 */
/**
 * FAMILLES DE RESSOURCES QUE LE PANEL SAIT DÉJÀ POSSÉDER (L6.2C).
 *
 * ══ POURQUOI CETTE LISTE, ET POURQUOI ELLE EST COURTE ═══════════════════════
 *
 * Une capacité qui exige de POSSÉDER un objet Stripe ne peut être servie que si
 * le Panel en crée — et donc en lie — au moins un. Sans cela, elle serait ou
 * bien toujours refusée, ou bien, bien pire, servie en faisant confiance à
 * l'identifiant que le projet présente.
 *
 * `CHECKOUT_SESSION` y entre parce que L6.2B en crée et les lie à la création.
 * `CUSTOMER` et `INVOICE` n'y sont pas : le Panel n'en a jamais créé ni adopté,
 * donc le registre de liens n'en contient aucun.
 *
 * Cette liste se lit comme une DETTE : chaque famille qui s'y ajoute débloque
 * les capacités qui l'exigeaient, et pas une de plus.
 */
const BINDABLE_KINDS = Object.freeze([
  STRIPE_RESOURCE_KINDS.CHECKOUT_SESSION,
  /**
   * L6.3B — LE CLIENT ENTRE ENFIN, ET IL AURAIT PU DEPUIS L6.2D.
   *
   * Le commentaire ci-dessus disait « `CUSTOMER` n'y est pas : le Panel n'en a
   * jamais créé ». C'était vrai en L6.2C ; L6.2D a livré `billing.customer.ensure`
   * — le Panel crée le client d'un contrat et le lie à la création — mais cette
   * liste n'a pas suivi.
   *
   * L'oubli n'était pas coûteux tant qu'aucune capacité n'exigeait cette
   * famille. Les trois de L6.3B l'exigent : lister les factures, en lire une,
   * ouvrir le portail. Toutes trois remontent au client par le lien, jamais par
   * un identifiant que le projet présenterait.
   */
  STRIPE_RESOURCE_KINDS.CUSTOMER,
  /**
   * L6.2F — l'abonnement entre dans la liste sans que le Panel n'en crée aucun.
   * Il y entre parce qu'il est ADOPTABLE : la session qui le produit est
   * possédée, et Stripe lui-même désigne la filiation. C'est la seule famille
   * dont l'ancrage ne vient pas d'une création.
   */
  STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
  /**
   * L10.4 — l'intention de paiement, adoptée par la même filiation. Le Panel
   * n'en crée pas davantage, mais il en PROJETTE le revenu (L10.3) : à ce
   * moment-là, la session ou l'abonnement dont elle découle est déjà possédé, et
   * le fait fournisseur — un webhook signé — désigne la filiation. Le lien est
   * posé là, jamais sur un identifiant présenté par un navigateur.
   */
  STRIPE_RESOURCE_KINDS.PAYMENT_INTENT,
]);

/**
 * Capacités dont l'identité d'acte est DÉRIVÉE par le Panel, pas fournie par le
 * projet. Fermée, et volontairement courte : c'est une exception à la règle
 * générale, et chaque entrée doit pouvoir se justifier par « il n'existe qu'une
 * réponse correcte, et le projet n'a rien à en décider ».
 */
const DERIVED_OPERATION_IDENTITY = Object.freeze([
  'billing.customer.ensure',
  'billing.price.ensure',
  /**
   * L6.2G — une résiliation est TERMINALE : elle n'a pas de seconde tentative
   * légitime, seulement des rejeux. Laisser le projet la nommer lui permettrait
   * de couper deux fois ce qui ne se coupe qu'une.
   */
  'billing.subscription.cancel_at_period_end',
  'billing.subscription.cancel_now',
  /**
   * L6.3A — « garantis MON endpoint » n'a qu'une réponse correcte par projet et
   * par monde. Laisser le projet nommer l'acte lui permettrait d'en fabriquer
   * deux, donc de faire enregistrer deux endpoints là où un seul doit exister.
   *
   * L'identité est ici portée par la portée elle-même — (projet, monde) — et
   * garantie par l'index unique du binding plutôt que par le registre
   * d'opérations : la convergence se fait sur l'ÉTAT réel chez le fournisseur,
   * pas sur une fenêtre d'idempotence.
   */
  'webhook.endpoint.ensure',
]);

function capability(code, options) {
  const definition = getProviderDefinition('STRIPE');
  return Object.freeze({
    code,
    provider: 'STRIPE',
    scope: definition?.scope ?? null,
    label: options.label,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    timeoutMs: options.timeoutMs,
    idempotency: options.idempotency,
    requiredPermissions: Object.freeze([...options.requiredPermissions]),
    /** Famille de ressource dont l'appartenance doit être prouvée. */
    resourceKind: options.resourceKind ?? null,
    requiresResourceOwnership: Boolean(options.resourceKind),
    /**
     * L'acte est-il financier ?
     *
     * Ce drapeau pilote la DOCTRINE DE REJEU — quelles écritures exigent une
     * idempotence fournisseur et une poignée de corrélation. Il ne pilote
     * aucune politique d'accès : il en existait une, l'ouverture commerciale,
     * qui lisait une taxinomie d'effets désormais supprimée.
     */
    financial: options.financial === true,
  });
}

export const STRIPE_CAPABILITIES = Object.freeze({
  /* ── LECTURES ─────────────────────────────────────────────────────────── */

  /**
   * SERVIE DEPUIS L6.3B — et ce qui la débloque n'est pas le calendrier.
   *
   * Sa note de migration disait vrai pendant sept lots : « bloquée par l'absence
   * de lien projet ↔ client Stripe ». L6.2D a créé ce lien, mais le contrat
   * d'entrée continuait de demander un `customerId` au projet — c'est-à-dire de
   * lui demander de désigner ce qu'il ne possède pas forcément.
   *
   * Le contrat prend désormais la référence de CONTRAT. Le Panel remonte au
   * client par le lien qu'il a lui-même écrit. La capacité n'a donc pas été
   * « ouverte » : elle a cessé d'exiger ce qu'on ne pouvait pas lui accorder.
   */
  'billing.invoice.list': capability('billing.invoice.list', {
    label: 'Lister les factures d’un contrat',
    inputSchema: invoiceListInput,
    outputSchema: invoiceListOutput,
    timeoutMs: 20_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:read'],
    resourceKind: STRIPE_RESOURCE_KINDS.CUSTOMER,
    requiresResourceOwnership: true,
  }),

  /**
   * UNE facture, et seulement si elle est à ce contrat (L6.3B).
   *
   * L'appartenance d'une FACTURE ne se prouve pas directement — le Panel n'en
   * crée aucune, Stripe les fabrique au fil des paiements. Elle se prouve par
   * FILIATION, comme l'abonnement en L6.2F : la facture appartient au client
   * possédé, et Stripe le dit lui-même dans l'objet rendu.
   *
   * L'ordre compte donc : le client est vérifié AVANT l'appel, la filiation
   * APRÈS — et une facture dont le client ne serait pas le nôtre est refusée
   * exactement comme une facture inexistante.
   */
  'billing.invoice.retrieve': capability('billing.invoice.retrieve', {
    label: 'Lire une facture du contrat',
    inputSchema: invoiceRetrieveInput,
    outputSchema: invoiceView,
    timeoutMs: 20_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:read'],
    resourceKind: STRIPE_RESOURCE_KINDS.CUSTOMER,
    requiresResourceOwnership: true,
  }),

  /**
   * LE PORTAIL CLIENT — Stripe héberge l'écran, nous n'y touchons jamais (L6.3B).
   *
   * ══ POURQUOI ELLE N'EST PAS UNE ÉCRITURE FINANCIÈRE ═════════════════════════
   *
   * Elle n'encaisse rien et ne rembourse rien : elle ouvre une porte. Mais elle
   * ouvre une porte sur TOUT ce qui concerne un client — moyens de paiement,
   * factures, abonnements. Se tromper de client n'y coûte pas de l'argent, cela
   * coûte des données personnelles, et l'appel aurait l'air parfaitement normal.
   *
   * D'où une appartenance vérifiée aussi strictement que pour un encaissement,
   * et un contrat d'entrée qui ne laisse pas le projet nommer le client.
   */
  'billing.portal.create': capability('billing.portal.create', {
    label: 'Ouvrir le portail client d’un contrat',
    inputSchema: portalCreateInput,
    outputSchema: portalSessionView,
    timeoutMs: 20_000,
    /**
     * `SAFE_RETRY` et non `PROVIDER_IDEMPOTENT` : une session de portail est
     * éphémère et à usage unique. La rejouer crée une session neuve — ce qui
     * est le comportement CORRECT ici, puisque rendre l'ancienne rendrait une
     * URL morte. Voir la dérogation documentée dans le transport.
     */
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:write'],
    resourceKind: STRIPE_RESOURCE_KINDS.CUSTOMER,
    requiresResourceOwnership: true,
  }),

  'billing.subscription.retrieve': capability('billing.subscription.retrieve', {
    label: 'Lire l’état d’un abonnement',
    inputSchema: subscriptionRetrieveInput,
    outputSchema: subscriptionView,
    timeoutMs: 20_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:read'],
    resourceKind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
    /**
     * SERVIE depuis L6.2F. Le lien qui lui manquait existe enfin — non parce
     * que le Panel crée les abonnements (Stripe s'en charge au paiement), mais
     * parce qu'il peut les ADOPTER depuis la session qui les a produits, dont
     * l'appartenance était déjà prouvée.
     */
  }),

  'billing.checkout.retrieve': capability('billing.checkout.retrieve', {
    label: 'Lire l’état d’une session de paiement',
    inputSchema: checkoutRetrieveInput,
    outputSchema: checkoutView,
    timeoutMs: 20_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:read'],
    resourceKind: STRIPE_RESOURCE_KINDS.CHECKOUT_SESSION,
    /**
     * C'est la lecture du parcours de retour de paiement — celle qui, côté
     * projet, a déjà provoqué une boucle d'interrogation. La migrer ne doit pas
     * servir de prétexte à refondre ce parcours : mêmes appels, même cadence.
     */
    /**
     * SERVIE depuis L6.2C. Elle est la première capacité du parc dont
     * l'autorisation repose sur une APPARTENANCE PROUVÉE plutôt que sur un
     * simple octroi : posséder l'identifiant ne suffit pas, il faut que le
     * Panel ait lui-même lié la ressource au projet demandeur.
     *
     * La cadence d'interrogation du parcours de retour n'a pas été touchée :
     * les mêmes appels, aux mêmes moments, par une autre porte.
     */
  }),

  /* ── ÉCRITURES FINANCIÈRES ────────────────────────────────────────────── */

  'billing.checkout.create': capability('billing.checkout.create', {
    label: 'Ouvrir une session de paiement',
    inputSchema: checkoutCreateInput,
    outputSchema: checkoutCreateOutput,
    timeoutMs: 25_000,
    /**
     * Stripe déduplique sur `Idempotency-Key`, et c'est la garantie la plus
     * forte du parc : deux appels de la même clé rendent la MÊME session, pas
     * deux paiements. Encore faut-il que la clé soit stable — c'est le rôle du
     * registre d'opérations du Panel, pas du hasard.
     */
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    financial: true,
    /**
     * Aucune ressource préexistante à posséder : la session est créée. Mais le
     * CONTRAT, lui, doit appartenir au projet — vérifié par la projection, pas
     * par un identifiant Stripe.
     */
    resourceKind: null,
    /**
     * SERVIE depuis L6.2B — et c'est justement `resourceKind: null` qui l'a
     * rendue migrable la première : elle ne consomme aucun objet Stripe
     * préexistant, elle en CRÉE un. Sa contrepartie est qu'elle doit lier ce
     * qu'elle crée, immédiatement, sans quoi la ressource serait orpheline.
     */
  }),

  /**
   * `billing.customer.ensure` — REVERSIBLE_EXTERNAL_WRITE, et non FINANCIAL.
   *
   * Créer un client ne débite rien et se supprime. C'est la table de L1.75 qui
   * le classe ainsi, avec sa raison : l'interdire en pré-ouverture empêcherait
   * de préparer le dossier d'un client avant son ouverture, sans rien protéger.
   * Ce lot ne touche pas cette classification — il la sert.
   */
  'billing.customer.ensure': capability('billing.customer.ensure', {
    label: 'Garantir le client Stripe d’un contrat',
    inputSchema: customerEnsureInput,
    outputSchema: customerEnsureOutput,
    timeoutMs: 20_000,
    /** Stripe déduplique sur `Idempotency-Key` : la clé est dérivée du contrat. */
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    /**
     * `financial: false` — l'acte n'engage aucune somme. Le drapeau pilote la
     * doctrine de rejeu, pas la politique commerciale : un client se recrée
     * sans conséquence pour personne, contrairement à une session de paiement.
     */
    financial: false,
    /**
     * Aucune ressource préexistante à posséder : le client est CRÉÉ. Sa
     * contrepartie est qu'il doit être lié immédiatement, sans quoi le contrat
     * suivant en créerait un second.
     */
    resourceKind: null,
  }),

  /**
   * `billing.price.ensure` — REVERSIBLE_EXTERNAL_WRITE, comme le client.
   *
   * Créer un Product et un Price ne débite personne : ce sont des entrées de
   * catalogue. Ce qui engage, c'est la session qui les utilise — et celle-là
   * reste FINANCIAL_WRITE, donc bloquée en pré-ouverture.
   */
  'billing.price.ensure': capability('billing.price.ensure', {
    label: 'Garantir le tarif Stripe d’un contrat',
    inputSchema: priceEnsureInput,
    outputSchema: priceEnsureOutput,
    timeoutMs: 25_000,
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    financial: false,
    resourceKind: null,
  }),

  /**
   * `billing.subscription.cancel_now` — LA COUPURE IMMÉDIATE.
   *
   * Elle n'existait dans aucun contrat : le projet l'appelait directement, sans
   * clé d'idempotence (défaut L6.1, confirmé à chaque lot depuis). Elle entre
   * ici avec le même effet que sa jumelle — FINANCIAL_WRITE — parce qu'elle
   * décide de ne plus prélever, et que c'est un engagement.
   *
   * `PROVIDER_IDEMPOTENT` décrit la clé qu'on envoie, non une convergence du
   * fournisseur : Stripe REFUSE de résilier deux fois. C'est l'état de
   * l'abonnement qui porte la convergence — voir `stripeSubscriptionCancellation`.
   */
  'billing.subscription.cancel_now': capability('billing.subscription.cancel_now', {
    label: 'Résilier un abonnement immédiatement',
    inputSchema: subscriptionCancelInput,
    outputSchema: subscriptionCancelledView,
    timeoutMs: 25_000,
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    financial: true,
    resourceKind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
  }),

  /**
   * `webhook.endpoint.ensure` — LE PANEL PROVISIONNE POUR LE PROJET (L6.3A).
   *
   * Première capacité qui ne déplace ni argent ni donnée métier : elle
   * administre une ressource du COMPTE Stripe, pour le compte d'un projet.
   *
   * Elle n'est pas financière — elle ne peut rien encaisser ni rembourser —
   * mais elle n'est pas anodine non plus : mal ciblée, elle ferait pointer les
   * événements d'un projet vers un autre. D'où une appartenance qui n'est pas
   * celle des autres capacités : ce n'est pas une ressource Stripe préexistante
   * qu'il faut posséder, c'est l'ADRESSE annoncée qu'il faut valider, puisque
   * c'est la seule chose que l'appelant apporte.
   */
  'webhook.endpoint.ensure': capability('webhook.endpoint.ensure', {
    label: 'Garantir l’endpoint webhook du projet',
    inputSchema: webhookEndpointEnsureInput,
    outputSchema: webhookEndpointView,
    timeoutMs: 30_000,
    /**
     * Convergente par nature : elle compare l'état désiré à l'état réel avant
     * d'agir, exactement comme une résiliation relit avant de couper. Deux
     * appels de suite ne produisent pas deux endpoints.
     */
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['webhooks:manage'],
    financial: false,
  }),

  /**
   * `billing.refund` — RENDRE L'ARGENT (L10.4).
   *
   * ══ CE QUI LA REND DIFFÉRENTE DE TOUTES LES AUTRES ══════════════════════
   *
   * Toutes les écritures précédentes engagent l'avenir : une session ouvre un
   * paiement, une résiliation arrête un prélèvement. Celle-ci défait le passé,
   * et rien ne la défait à son tour — on ne « dé-rembourse » pas.
   *
   * Elle est aussi la seule dont un rejeu tardif crée un acte RÉEL et
   * SUPPLÉMENTAIRE. Résilier deux fois est refusé par Stripe ; rembourser deux
   * fois 100 € est parfaitement accepté, parce que c'est parfois voulu. La
   * convergence ne peut donc pas venir de l'état, et `PROVIDER_IDEMPOTENT`
   * décrit ici la clé qu'on envoie plus la métadonnée qu'on appose — voir
   * `stripeRefundAuthority.js`.
   *
   * ══ SON APPELANT ════════════════════════════════════════════════════════
   *
   * Aucun projet. C'est un acte d'OPÉRATEUR, émis depuis l'onglet Finances du
   * Panel via `INVOCATION_SOURCES.PANEL_INTERNAL`. Le projet reste le
   * périmètre — l'appartenance, les identifiants, le monde en dépendent — mais
   * il ne demande rien. Un pont projet qui appellerait cette capacité serait
   * refusé faute d'octroi, et c'est le comportement voulu.
   */
  'billing.refund': capability('billing.refund', {
    label: 'Rembourser un paiement',
    inputSchema: refundInput,
    outputSchema: refundView,
    timeoutMs: 20_000,
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    financial: true,
    resourceKind: STRIPE_RESOURCE_KINDS.PAYMENT_INTENT,
  }),

  'billing.subscription.cancel_at_period_end': capability('billing.subscription.cancel_at_period_end', {
    label: 'Résilier un abonnement en fin de période',
    inputSchema: subscriptionCancelInput,
    outputSchema: subscriptionView,
    timeoutMs: 25_000,
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    financial: true,
    resourceKind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
    outputSchema: subscriptionCancelledView,
    /**
     * SERVIE depuis L6.2G. Convergente par nature — poser deux fois le même
     * drapeau donne le même état — mais elle décide de ne plus prélever :
     * c'est un engagement, donc FINANCIAL_WRITE.
     */
  }),
});

export const STRIPE_CAPABILITY_CODES = Object.freeze(Object.keys(STRIPE_CAPABILITIES));

export function isStripeCapability(code) {
  return typeof code === 'string' && Object.hasOwn(STRIPE_CAPABILITIES, code);
}

export function getStripeCapability(code) {
  return isStripeCapability(code) ? STRIPE_CAPABILITIES[code] : null;
}

/**
 * Cohérence du catalogue. Ce que cette fonction refuse est exactement ce qui,
 * sur un provider financier, coûterait de l'argent réel.
 */
export function validateStripeCapabilities() {
  const problems = [];
  for (const [code, definition] of Object.entries(STRIPE_CAPABILITIES)) {
    if (definition.code !== code) problems.push(`code incohérent : « ${code} ».`);
    if (definition.provider !== 'STRIPE') problems.push(`${code} : fournisseur inattendu.`);

    // Stripe est à portée ENVIRONMENT : deux comptes, deux mondes.
    if (definition.scope !== 'ENVIRONMENT') {
      problems.push(`${code} : Stripe doit rester ENVIRONMENT (trouvé « ${definition.scope} »).`);
    }
    if (!definition.inputSchema || !definition.outputSchema) {
      problems.push(`${code} : contrat d’entrée ou de sortie manquant.`);
    }
    /**
     * TOUTE CAPACITÉ DE CE CATALOGUE EST SERVIE — les conditions `migrated` qui
     * gardaient les deux règles suivantes ont disparu avec le booléen.
     *
     * Une capacité qui manipule une ressource doit pouvoir en prouver
     * l'appartenance : sans lien, elle serait servie en faisant confiance à
     * l'identifiant fourni par le projet.
     */
    if (definition.requiresResourceOwnership
      && !BINDABLE_KINDS.includes(definition.resourceKind)) {
      problems.push(`${code} : servie alors qu’aucun lien vers ${definition.resourceKind} n’existe encore.`);
    }
    // Une écriture financière servie doit lier ce qu'elle crée : sans preuve
    // d'appartenance, la ressource produite n'appartiendrait à personne.
    if (definition.financial && definition.idempotency !== 'PROVIDER_IDEMPOTENT') {
      problems.push(`${code} : écriture financière servie sans idempotence fournisseur.`);
    }

    const shape = definition.inputSchema?._def?.schema?.shape ?? definition.inputSchema?.shape ?? {};

    // Le monde n'est JAMAIS une entrée.
    for (const forbidden of ['mode', 'environment', 'livemode', 'stripeEnvironment']) {
      if (Object.hasOwn(shape, forbidden)) problems.push(`${code} : « ${forbidden} » ne peut pas être une entrée.`);
    }
    // Aucun credential, aucun compte tiers.
    for (const forbidden of ['secretKey', 'apiKey', 'credentials', 'account', 'stripeAccount', 'baseUrl']) {
      if (Object.hasOwn(shape, forbidden)) problems.push(`${code} : « ${forbidden} » ne peut pas être une entrée.`);
    }
    // Le montant ne vient jamais du projet : il vient de la projection.
    for (const forbidden of ['amount', 'unitAmount', 'price', 'currency']) {
      if (Object.hasOwn(shape, forbidden)) {
        problems.push(`${code} : « ${forbidden} » ne peut pas venir du projet (§ montant).`);
      }
    }
    /**
     * TOUTE CAPACITÉ DOIT AVOIR UNE IDENTITÉ D'ACTE — fournie ou DÉRIVÉE.
     *
     * La règle disait « doit porter un operationId ». Elle visait juste : sans
     * identité, deux appels indiscernables produisent deux effets. Mais elle
     * confondait l'exigence (une identité existe) avec sa forme (le projet la
     * fournit).
     *
     * `billing.customer.ensure` dérive la sienne du contrat, et c'est PLUS
     * fort : le projet ne peut pas fabriquer deux identités pour un même
     * contrat. `DERIVED_OPERATION_IDENTITY` recense ces cas, un par un — la
     * liste est fermée pour qu'aucun verbe ne s'y glisse par commodité.
     */
    if (!Object.hasOwn(shape, 'operationId') && !DERIVED_OPERATION_IDENTITY.includes(code)) {
      problems.push(`${code} : aucune identité d’acte, ni fournie ni dérivée.`);
    }
    // Une ÉCRITURE financière sans idempotence fournisseur est un doublon en
    // attente. Une lecture n'a pas ce problème : la rejouer ne produit rien.
    if (definition.financial && definition.idempotency !== 'PROVIDER_IDEMPOTENT') {
      problems.push(`${code} : écriture financière sans idempotence fournisseur.`);
    }
  }
  return problems;
}

export default {
  STRIPE_CAPABILITIES,
  STRIPE_CAPABILITY_CODES,
  isStripeCapability,
  getStripeCapability,
  validateStripeCapabilities,
};
