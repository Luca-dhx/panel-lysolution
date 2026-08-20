// REGISTRE DES CAPACITÉS — ce que les projets peuvent DEMANDER (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Registre ».
//
// ── CODE-FIRST, ET C'EST UN INVARIANT ───────────────────────────────────────
//
// Rien en base ne peut ajouter, retirer ni modifier une capacité. Une capacité
// enregistrable depuis Mongo serait une porte ouverte sans adaptateur et sans
// test — et un projet finirait par l'invoquer.
//
// ── CE REGISTRE NE RÉINVENTE RIEN ───────────────────────────────────────────
//
// Il AGRÈGE des autorités déjà écrites, et ne les redéfinit jamais :
//
//   providerRegistry.js       → quel fournisseur, quelle portée
//   brevo/brevoCapabilities.js → le contrat métier Brevo, écrit par L8
//
// `assertRegistryAlignment()` échoue si l'une diverge. C'est ce contrôle, et
// non la discipline, qui garantit qu'on ne se retrouvera pas avec une capacité
// dont l'écran promet une chose et dont l'exécution en décide une autre.
//
// ── DÉCLARÉE = SERVIE, ET IL N'Y A PAS D'ÉTAT INTERMÉDIAIRE ─────────────────
//
// Ce registre portait un booléen `migrated` : une capacité pouvait être
// déclarée, affichée, accordable — et refuser à l'invocation avec « pas encore
// servie ». C'était un état que rien n'obligeait à quitter, et il a duré :
// `billing.subscription.reconcile` l'occupait encore, annoncée à l'écran et
// servie par personne.
//
// Le booléen a été supprimé, pas seulement mis à `true` partout. Tant que le
// champ existe, l'état est REPRÉSENTABLE, donc il revient. Une capacité est
// désormais dans ce fichier ou elle n'y est pas ; `assertAdapterAlignment()`
// exige de chacune un exécutant, et le contrôle échoue si l'un manque.
import { z } from 'zod';

import { MAX_DOCUMENT_BASE64_LENGTH } from '../integratedApi/yousign/signatureDocumentLimits.js';

import { getProviderDefinition, listProviderDefinitions } from '../integratedApi/providerRegistry.js';
import { BREVO_CAPABILITY_CODES } from '../integratedApi/brevo/brevoCapabilities.js';
import {
  HOSTINGER_CAPABILITIES,
  HOSTINGER_CAPABILITY_CODES,
} from '../integratedApi/hostinger/hostingerCapabilities.js';
import { STRIPE_CAPABILITIES } from '../integratedApi/stripe/stripeCapabilities.js';
import { customerOperationId } from '../integratedApi/stripe/stripeCustomerAuthority.js';
import { productOperationId } from '../integratedApi/stripe/stripePriceAuthority.js';
import { cancellationOperationId } from '../integratedApi/stripe/stripeSubscriptionCancellation.js';

/* -------------------------------------------------------------------------- */
/*  IDEMPOTENCE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Ce qu'on peut se permettre quand une invocation tourne mal.
 *
 * Une stratégie unique serait fausse dans les deux sens : appliquée partout,
 * elle interdirait de relire un compte après un hoquet réseau ; assouplie
 * partout, elle enverrait deux fois le même e-mail.
 */
export const IDEMPOTENCY = Object.freeze({
  /** Rien à protéger : l'appel ne change rien. Relire est gratuit. */
  NONE: 'NONE',
  /** Sans effet de bord observable : rejouer est sûr, même après un doute. */
  SAFE_RETRY: 'SAFE_RETRY',
  /**
   * Le fournisseur n'offre aucune clé d'idempotence : un délai dépassé laisse
   * l'action dans un état INDÉCIDABLE, et le rejeu est un arbitrage humain.
   */
  UNKNOWN_ON_TIMEOUT: 'UNKNOWN_ON_TIMEOUT',
  /** Le fournisseur déduplique lui-même (en-tête d'idempotence). */
  PROVIDER_IDEMPOTENT: 'PROVIDER_IDEMPOTENT',
});

/* -------------------------------------------------------------------------- */
/*  PERMISSIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Permissions portées par une capacité — une FAMILLE, pour raisonner sans
 * réénumérer les codes un à un.
 *
 * Elles complétaient autrefois les octrois (`capabilityGrants`), qui disaient
 * QUI quand celles-ci disent QUOI. Les octrois ayant disparu, elles ne
 * gouvernent plus aucune décision d'accès : elles restent une classification
 * descriptive, utile aux écrans et à la lecture du registre.
 */
export const PERMISSIONS = Object.freeze({
  EMAIL_SEND: 'email:send',
  EMAIL_VERIFY: 'email:verify',
  BILLING_READ: 'billing:read',
  BILLING_WRITE: 'billing:write',
  SIGNATURE_READ: 'signature:read',
  SIGNATURE_WRITE: 'signature:write',
  DNS_WRITE: 'dns:write',
  /**
   * L6.3A — administrer l'endpoint webhook d'un projet chez le fournisseur.
   *
   * Une famille à part, et non `billing:write` : ce verbe ne déplace pas
   * d'argent, et le ranger avec ceux qui en déplacent obligerait à accorder le
   * paiement pour obtenir la réception. Un projet peut légitimement avoir l'un
   * sans l'autre — c'est même l'ordre naturel, la réception d'abord.
   */
  WEBHOOKS_MANAGE: 'webhooks:manage',
});

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS D'ENTRÉE                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Adresse de destinataire — la seule donnée personnelle qu'une capacité
 * d'e-mail accepte, et elle est validée avant d'aller où que ce soit.
 */
const recipientSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).optional(),
});

/**
 * `strict()` PARTOUT, et c'est le cœur de la garantie.
 *
 * Zod ignore les clés inconnues par défaut : un projet pourrait envoyer
 * `{ recipient, environment: 'PROD', apiKey: '…' }` sans que rien ne proteste.
 * Les champs seraient inertes — mais leur présence signalerait à quiconque lit
 * le code du projet qu'ils font peut-être quelque chose, et un jour quelqu'un
 * les brancherait. Un refus explicite tue l'idée à la racine.
 */
const emailSenderVerifyInput = z.object({
  /**
   * FACULTATIF — et c'est la sémantique réellement servie qui le veut.
   *
   * L'adaptateur LIT le compte chez Brevo (`GET /v3/account`) : il n'envoie
   * rien, donc personne ne reçoit rien, donc il n'y a pas de destinataire. Le
   * rendre obligatoire forçait l'appelant à inventer une adresse pour un appel
   * qui ne l'utilise pas — et le diagnostic de connexion du Manager, qui n'en
   * a aucune sous la main, aurait échoué sur une validation d'entrée en
   * laissant croire que la connexion, elle, était en cause.
   *
   * Il reste accepté et VALIDÉ quand il est fourni : le jour où cette capacité
   * enverra réellement un message de contrôle (contrat L8 §« sender.verify »),
   * l'entrée n'aura pas à changer de forme.
   */
  recipient: recipientSchema.optional(),
  /**
   * Clé d'idempotence FOURNIE PAR LE PROJET. Il est le seul à savoir que deux
   * clics sont la même intention ; le Panel ne peut que le constater trop tard.
   */
  operationId: z.string().trim().min(8).max(64),
}).strict();

/**
 * ══ UN MONTANT PORTE SA DEVISE — et le contrat d'entrée doit l'admettre ═════
 *
 * ── LE DÉFAUT FERMÉ ICI ────────────────────────────────────────────────────
 *
 * Les variables n'acceptaient que des scalaires. Or le RENDU, lui, accepte
 * depuis toujours deux formes pour un montant : un entier de centimes, ou
 * `{ amount, currency }` — et il documente pourquoi la seconde existe, « sans
 * quoi un montant en USD s'afficherait avec € ».
 *
 * Deux contrats du même Panel disaient donc le contraire l'un de l'autre, et
 * c'est l'entrée qui gagnait : tout envoi portant un montant sous sa forme
 * complète était refusé à la passerelle, avant d'atteindre le rendu qui
 * l'attendait. Le message rendu — « Entrée non conforme au contrat » — ne
 * nommait pas la variable fautive, et le refus ressemblait à une erreur
 * d'appel alors que l'appelant suivait la forme documentée.
 *
 * Ce que cela cassait, concrètement : les e-mails de facturation d'un projet
 * (paiement reçu, impayé, régularisation) et le bouton « envoi de test » de
 * tout modèle portant un montant — donc, pour ces modèles, l'écran entier.
 *
 * ── POURQUOI PAS `z.any()` ─────────────────────────────────────────────────
 *
 * Parce que le point du schéma est de refuser ce qui n'a pas de sens. On admet
 * EXACTEMENT la forme que le rendu sait lire, et rien d'autre : un objet
 * inconnu reste refusé, et il le reste au bon endroit.
 */
const moneyVariable = z.object({
  /** Des CENTIMES, entiers : la même unité que partout ailleurs dans le parc. */
  amount: z.number().int(),
  /** ISO 4217. Absente, le rendu retient l'euro — c'est son défaut documenté. */
  currency: z.string().trim().length(3).optional(),
}).strict();

const emailSendTemplateInput = z.object({
  templateRef: z.string().trim().min(1).max(120),
  recipient: recipientSchema,
  variables: z.record(z.union([z.string(), z.number(), z.boolean(), moneyVariable])).optional(),
  replyTo: recipientSchema.optional(),
  operationId: z.string().trim().min(8).max(64),
}).strict();

/* ── Yousign (R10.5C) ─────────────────────────────────────────────────────── */

/**
 * UN SIGNATAIRE, tel que le projet le décrit.
 *
 * L'identité vient du SNAPSHOT contractuel figé à la validation, jamais des
 * fiches Entreprise vivantes : c'est une règle du projet, et la passerelle n'a
 * pas à la connaître. Ce qu'elle impose, elle, c'est que les trois champs
 * soient présents — un signataire vide produirait chez Yousign un refus dont le
 * message n'apprend rien.
 */
const signerSchema = z.object({
  role: z.enum(['DEVELOPER', 'CLIENT']),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  /** Retour de fin de signature. FACULTATIF : sans lui, le signataire reste chez Yousign. */
  redirectUrls: z.object({
    success: z.string().url(),
    error: z.string().url(),
    decline: z.string().url(),
  }).strict().optional(),
}).strict();

/** UNE ZONE DE SIGNATURE, déjà convertie en coordonnées par le projet. */
const signatureFieldSchema = z.object({
  signerRole: z.enum(['DEVELOPER', 'CLIENT']),
  page: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
}).strict();

const signatureRequestOpenInput = z.object({
  /**
   * LA RÉFÉRENCE MÉTIER — c'est elle qui fonde l'appartenance et l'unicité.
   * Un contrat n'a qu'une demande vivante à la fois (index partiel).
   */
  contractRef: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  /**
   * LE PDF, EN BASE64.
   *
   * La passerelle porte du JSON ; un transport binaire dédié aurait créé un
   * second chemin d'exécution, donc un second endroit où l'appartenance
   * pourrait être oubliée. Borné à ~15 Mio décodés.
   */
  /**
   * LE PDF, EN BASE64 — borné par une limite NOMMÉE.
   *
   * Le schéma refuse d'emblée une chaîne hors gabarit, avant tout décodage :
   * décoder 100 Mio pour découvrir qu'ils sont de trop ferait payer l'attaque
   * avant de la refuser. L'adaptateur revérifie la taille DÉCODÉE, qui est la
   * seule que l'humain manipule, et rend alors un message actionnable.
   */
  documentBase64: z.string().min(1).max(MAX_DOCUMENT_BASE64_LENGTH),
  documentFilename: z.string().trim().min(1).max(200),
  /** L'ORDRE du tableau EST l'ordre de signature. */
  signers: z.array(signerSchema).min(1).max(4),
  fields: z.array(signatureFieldSchema).min(1).max(40),
  operationId: z.string().trim().min(8).max(64),
}).strict();

const signatureRequestOpenOutput = z.object({
  status: z.enum(['OPENED', 'ALREADY_OPEN']),
  signatureRequestId: z.string().nullable(),
  documentId: z.string().nullable(),
  contractRef: z.string(),
  signers: z.array(z.object({
    role: z.string(),
    signerId: z.string(),
    signatureLink: z.string().nullable(),
  }).strict()),
}).strict();

const signatureRequestRefInput = z.object({
  signatureRequestId: z.string().trim().min(8).max(64),
  operationId: z.string().trim().min(8).max(64).optional(),
}).strict();

const signatureRequestRetrieveOutput = z.object({
  signatureRequestId: z.string(),
  status: z.string().nullable(),
  signers: z.array(z.object({
    signerId: z.string(),
    status: z.string().nullable(),
  }).strict()),
}).strict();

const signatureSignerRetrieveInput = z.object({
  signatureRequestId: z.string().trim().min(8).max(64),
  signerId: z.string().trim().min(8).max(64),
  operationId: z.string().trim().min(8).max(64).optional(),
}).strict();

const signatureSignerRetrieveOutput = z.object({
  signerId: z.string(),
  status: z.string().nullable(),
  signatureLink: z.string().nullable(),
}).strict();

const signatureDocumentDownloadOutput = z.object({
  signatureRequestId: z.string(),
  documentId: z.string(),
  contentBase64: z.string(),
  byteLength: z.number().int(),
  /** L'empreinte accompagne le contenu : le projet vérifie ce qu'il a reçu. */
  sha256: z.string(),
}).strict();

const signatureRequestCancelInput = z.object({
  signatureRequestId: z.string().trim().min(8).max(64),
  reason: z.string().trim().max(200).optional(),
  operationId: z.string().trim().min(8).max(64),
}).strict();

const signatureRequestCancelOutput = z.object({
  signatureRequestId: z.string(),
  status: z.literal('CANCELED'),
}).strict();

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS DE SORTIE                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Ce qui revient au projet. Volontairement étroit : la sortie d'une capacité
 * est un CONSTAT métier, pas une transcription de la réponse du fournisseur.
 * Y laisser passer un objet brut ferait fuir, tôt ou tard, un identifiant de
 * compte, une URL interne ou un message qu'on n'a pas relu.
 */
const emailSenderVerifyOutput = z.object({
  provider: z.literal('BREVO'),
  reachable: z.boolean(),
  /** Nom public du compte chez le fournisseur. Aucun secret. */
  accountLabel: z.string().nullable(),
  checkedAt: z.string(),
}).strict();

const emailSendTemplateOutput = z.object({
  status: z.enum(['ACCEPTED', 'ALREADY_SENT']),
  providerMessageId: z.string().nullable(),
  operationId: z.string(),
  /**
   * L'EXPÉDITEUR RÉELLEMENT UTILISÉ — rendu au projet (R10.4).
   *
   * ── POURQUOI LE PROJET A BESOIN DE LE SAVOIR ──────────────────────────────
   *
   * Il affiche un suivi de ses envois, et cet écran doit dire de quelle adresse
   * le message est parti. Avant R10.4 il le lisait dans sa propre
   * configuration ; depuis que le `From` est global et détenu par le Panel,
   * cette copie locale serait une DEVINETTE — juste tant que personne ne change
   * l'adresse, fausse pour tous les envois passés le jour où quelqu'un la
   * change.
   *
   * Le rendre ici n'expose rien : l'adresse figure déjà dans l'en-tête de
   * chaque message reçu. Ce n'est pas un secret, c'est un fait constaté.
   */
  /**
   * FACULTATIF, et pour une raison précise : le REJEU ne le porte pas.
   *
   * `ALREADY_SENT` est rendu depuis le registre d'opérations, sans réexécuter
   * l'adaptateur — donc sans re-résoudre l'expéditeur. Le stocker dans le
   * registre pour le rejouer serait inutile : un rejeu signifie que le premier
   * appel a réussi, et le projet a déjà enregistré l'expéditeur à ce
   * moment-là. Le rendre obligatoire forcerait à inventer une valeur pour la
   * seule branche qui n'en a pas besoin.
   */
  sender: z.object({
    email: z.string(),
    name: z.string(),
  }).strict().optional(),

  /**
   * QUEL DOCUMENT EXACT EST PARTI — l'observabilité du lot L11.1.
   *
   * ── POURQUOI LE PROJET DOIT LE RECEVOIR, ET PAS SEULEMENT LE JOURNAL ──────
   *
   * Le projet tient son propre suivi de livraison, et il y écrivait jusqu'ici
   * une `templateVersion` LUE DANS SA BASE LOCALE — c'est-à-dire la version
   * d'un document qui n'a jamais été expédié. Un exploitant qui enquêtait sur
   * un e-mail lisait donc un numéro sans rapport avec ce qui était parti.
   *
   * Le seul composant qui SAIT est celui qui vient de rendre. Il le dit ici.
   *
   * ── POURQUOI TOUS FACULTATIFS ─────────────────────────────────────────────
   *
   * Pour la même raison que `sender` : le REJEU (`ALREADY_SENT`) est rendu
   * depuis le registre d'opérations, sans réexécuter l'adaptateur, donc sans
   * re-résoudre le modèle. Les rendre obligatoires forcerait à inventer des
   * valeurs pour la seule branche qui n'en a pas besoin — un rejeu signifie que
   * le premier appel a réussi, et que le projet a déjà enregistré la vérité.
   */
  templateCode: z.string().optional(),
  templateScope: z.enum(['PANEL', 'PROJECT']).optional(),
  templateScopeId: z.string().nullable().optional(),
  templateVersion: z.number().int().min(0).optional(),
  templateSource: z.enum(['PANEL', 'PROJECT', 'REGISTRY_DEFAULT']).optional(),
}).strict();

/* -------------------------------------------------------------------------- */
/*  DÉFINITIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Construit une définition.
 *
 * Il n'y a plus ni `migrated` ni `migrationNote` : figurer ici, c'est être
 * servie. Une capacité qu'on voudrait « préparer sans la brancher » ne
 * s'ajoute pas à ce fichier — elle s'ajoute le jour où son adaptateur existe.
 */
function capability(code, options) {
  const provider = options.provider;
  const definition = getProviderDefinition(provider);
  return Object.freeze({
    code,
    provider,
    /** Portée du fournisseur (ENVIRONMENT | PANEL_GLOBAL) — registre L1. */
    scope: definition?.scope ?? null,
    label: options.label,
    inputSchema: options.inputSchema ?? null,
    outputSchema: options.outputSchema ?? null,
    timeoutMs: options.timeoutMs,
    idempotency: options.idempotency,
    requiredPermissions: Object.freeze([...(options.requiredPermissions ?? [])]),
    /**
     * Champ de la SORTIE qui identifie l'objet produit chez le fournisseur.
     *
     * C'est lui que le registre d'opérations conserve, et par lui qu'un
     * événement fournisseur retrouvera plus tard le projet à qui il appartient.
     * Déclaré ici plutôt que deviné dans la passerelle : sinon le vocabulaire
     * d'un fournisseur entre dans un fichier qui n'en connaît aucun.
     */
    correlationField: options.correlationField ?? null,
    /**
     * L'identité de l'ACTE, quand elle n'est PAS fournie par le projet.
     *
     * Fonction PURE de `(context, input)` : la passerelle l'évalue avant de
     * réserver l'opération, sans lecture de base. Une dérivation qui aurait
     * besoin d'interroger Mongo serait faite deux fois — ici et dans
     * l'adaptateur — et les deux pourraient diverger.
     *
     * `null` = le projet nomme l'acte, comme partout ailleurs.
     */
    deriveOperationId: options.deriveOperationId ?? null,
  });
}

export const CAPABILITY_DEFINITIONS = Object.freeze({
  /* ── Brevo — le contrat vient de L8, la passerelle le sert ──────────────── */

  'email.sender.verify': capability('email.sender.verify', {
    provider: 'BREVO',
    label: 'Vérifier la chaîne d’envoi',
    /**
     * LA PREMIÈRE, ET C'EST DÉLIBÉRÉ (recommandation L8 §13).
     *
     * Elle lit le compte chez le fournisseur : rien n'est créé, rien n'est
     * envoyé, personne ne reçoit de message. Son échec ne prive aucun
     * utilisateur d'une notification attendue, et son rejeu ne peut pas
     * produire de doublon. C'est la seule capacité dont on peut se permettre
     * qu'elle se trompe pendant qu'on éprouve le chemin complet.
     */
    inputSchema: emailSenderVerifyInput,
    outputSchema: emailSenderVerifyOutput,
    timeoutMs: 10_000,
    // Lecture pure : rejouer est sans conséquence, même après un délai dépassé.
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.EMAIL_VERIFY],
  }),

  'email.send_template': capability('email.send_template', {
    provider: 'BREVO',
    label: 'Envoyer une notification depuis un modèle',
    /**
     * SERVIE DEPUIS L8.4B — et seulement parce que le CHEMIN RETOUR existe.
     *
     * Les envois partent du compte Brevo du Panel : les webhooks de livraison
     * suivent le compte, pas le projet. Activer l'émission sans
     * `emailDeliveryDispatch` aurait figé chaque suivi de livraison sur
     * « envoyé », en silence. Les deux moitiés ont été livrées ensemble.
     */
    inputSchema: emailSendTemplateInput,
    outputSchema: emailSendTemplateOutput,
    timeoutMs: 15_000,
    // Brevo n'expose aucune clé d'idempotence sur /v3/smtp/email (audit L8 §7).
    idempotency: IDEMPOTENCY.UNKNOWN_ON_TIMEOUT,
    requiredPermissions: [PERMISSIONS.EMAIL_SEND],
    /**
     * Cette note s'AFFICHE. Elle ne nomme donc aucun projet : le Panel sert un
     * parc, et un opérateur d'une autre instance lirait ici le nom d'un client
     * qui n'est pas le sien. La garde d'architecture le vérifie sur les
     * chaînes, pas seulement sur les commentaires — et elle a bien fait.
     */
  }),

  /* ── Stripe ─────────────────────────────────────────────────────────────── */

  /**
   * LA LECTURE D'UNE SESSION — servie depuis L6.2C.
   *
   * Contrat repris du catalogue L6.1, comme l'écriture : `assertRegistryAlignment`
   * vérifie que ce sont les MÊMES objets de schéma, pas deux définitions qui se
   * ressemblent.
   *
   * `SAFE_RETRY` et non `PROVIDER_IDEMPOTENT` : une lecture rejouée ne produit
   * aucun second acte, donc elle ne réserve pas d'opération. Confondre les deux
   * ferait payer à un `GET` le prix d'une écriture financière.
   */
  'billing.checkout.retrieve': capability('billing.checkout.retrieve', {
    provider: 'STRIPE',
    label: 'Lire l’état d’une session de paiement',
    inputSchema: STRIPE_CAPABILITIES['billing.checkout.retrieve'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.checkout.retrieve'].outputSchema,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.BILLING_READ],
  }),
  /**
   * LA LECTURE D'UN ABONNEMENT — servie depuis L6.2F.
   *
   * `SAFE_RETRY` : une lecture rejouée ne produit aucun second acte. Comme la
   * lecture de session, elle exige en revanche la preuve d'appartenance — et
   * c'est cette exigence, et non l'octroi, qui empêche un projet de lire
   * l'abonnement d'un autre.
   */
  'billing.subscription.retrieve': capability('billing.subscription.retrieve', {
    provider: 'STRIPE',
    label: 'Lire l’état d’un abonnement',
    inputSchema: STRIPE_CAPABILITIES['billing.subscription.retrieve'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.subscription.retrieve'].outputSchema,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.BILLING_READ],
  }),

  /**
   * L'ENDPOINT WEBHOOK DU PROJET — provisionné par le Panel (L6.3A).
   *
   * Elle ne ressemble à aucune autre capacité Stripe : elle n'agit pas sur
   * l'argent, mais sur le CHEMIN par lequel le projet apprend que de l'argent a
   * bougé. Sans elle, le projet devait garder une clé d'API pour enregistrer sa
   * propre adresse — c'est-à-dire garder le pouvoir d'appeler Stripe pour tout
   * le reste.
   *
   * `SAFE_RETRY` parce qu'elle est convergente : elle compare l'état désiré au
   * réel avant d'agir. Deux appels ne produisent pas deux endpoints, et huit
   * appels simultanés non plus — le binding porte un index unique par projet et
   * par monde.
   */
  /**
   * L6.3B — LES TROIS VERBES QUI FERMENT LA SURFACE LOCALE DU PROJET.
   *
   * Ils ne migrent pas un parcours financier de plus : ils retirent au projet
   * ses dernières LECTURES Stripe, et l'écran de portail. C'est ce qui rendra
   * possible, au lot suivant, de lui retirer sa clé.
   *
   * Tous trois désignent leur objet par un CONTRAT et remontent au client par
   * le lien d'appartenance de L6.2D. Aucun n'accepte d'identifiant Stripe
   * choisi par le projet — sauf `invoiceId`, qui n'est qu'un filtre sur des
   * factures déjà restreintes au client possédé.
   */
  'billing.invoice.list': capability('billing.invoice.list', {
    provider: 'STRIPE',
    label: 'Lister les factures d’un contrat',
    inputSchema: STRIPE_CAPABILITIES['billing.invoice.list'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.invoice.list'].outputSchema,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.BILLING_READ],
  }),

  'billing.invoice.retrieve': capability('billing.invoice.retrieve', {
    provider: 'STRIPE',
    label: 'Lire une facture du contrat',
    inputSchema: STRIPE_CAPABILITIES['billing.invoice.retrieve'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.invoice.retrieve'].outputSchema,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.BILLING_READ],
  }),

  /**
   * `BILLING_WRITE`, alors qu'aucun euro ne bouge : ce verbe ouvre au client un
   * écran d'où il PEUT résilier ou changer de carte. Le ranger en lecture
   * l'accorderait avec les lectures, à des projets qui n'ont pas à l'avoir.
   */
  'billing.portal.create': capability('billing.portal.create', {
    provider: 'STRIPE',
    label: 'Ouvrir le portail client d’un contrat',
    inputSchema: STRIPE_CAPABILITIES['billing.portal.create'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.portal.create'].outputSchema,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
  }),

  'webhook.endpoint.ensure': capability('webhook.endpoint.ensure', {
    provider: 'STRIPE',
    label: 'Garantir l’endpoint webhook du projet',
    inputSchema: STRIPE_CAPABILITIES['webhook.endpoint.ensure'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['webhook.endpoint.ensure'].outputSchema,
    timeoutMs: 30_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.WEBHOOKS_MANAGE],
  }),

  /**
   * `billing.subscription.reconcile` A ÉTÉ RETIRÉE, ET NON IMPLÉMENTÉE.
   *
   * Elle était LA capacité fantôme du registre : déclarée, affichée, accordable,
   * et servie par personne — sa note « L6. Réparation d’un webhook perdu : doit
   * rester rejouable » s'affichait à l'écran sous un libellé « accordée, mais
   * pas encore servie », ce qui laissait croire à un chemin ouvert.
   *
   * Elle n'est pas revenue sous forme d'adaptateur parce qu'elle n'aurait rien
   * ajouté : `billing.subscription.retrieve` relit déjà l'état d'un abonnement
   * chez Stripe, avec preuve d'appartenance, et c'est exactement ce dont la
   * réparation d'un webhook perdu a besoin. Aucun appelant du parc ne la
   * demandait — le catalogue L6.1 avait d'ailleurs refusé de la
   * contractualiser.
   */
  /**
   * LE CLIENT D'UN CONTRAT — servi depuis L6.2D.
   *
   * Son identité d'acte est DÉRIVÉE, et c'est la seule du registre dans ce cas :
   * « garantir » n'a qu'une réponse correcte par contrat, et laisser le projet
   * nommer l'acte lui permettrait d'en obtenir deux.
   */
  'billing.customer.ensure': capability('billing.customer.ensure', {
    provider: 'STRIPE',
    label: 'Garantir le client Stripe d’un contrat',
    inputSchema: STRIPE_CAPABILITIES['billing.customer.ensure'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.customer.ensure'].outputSchema,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    correlationField: 'customerId',
    deriveOperationId: (context, input) => customerOperationId({
      environment: context.environment,
      contractId: input.contractRef,
    }),
  }),
  /**
   * LA PREMIÈRE CAPACITÉ FINANCIÈRE RÉELLEMENT SERVIE (L6.2B).
   *
   * Son contrat n'est pas réécrit ici : il vient du catalogue L6.1, seule
   * source du vocabulaire Stripe, comme Brevo vient de L8 et le DNS de L9.
   * `assertRegistryAlignment()` vérifie que ce sont bien les MÊMES objets de
   * schéma — pas deux définitions qui se ressemblent.
   *
   * Elle reste FINANCIAL_WRITE : la pré-ouverture la refuse, migrée ou non, et
   * ce refus tombe avant le coffre comme avant l'adaptateur.
   */
  /**
   * LE TARIF D'UN CONTRAT — servi depuis L6.2E.
   *
   * L'identité déclarée ici est celle du PRODUCT, pas du Price : c'est elle qui
   * réserve l'opération au goulot de la passerelle, et elle est stable pour un
   * contrat donné. L'adaptateur dérive ensuite l'identité du Price à partir des
   * TERMES lus dans la projection — que la passerelle n'a pas à connaître.
   *
   * Conséquence voulue : deux appels concurrents pour le même contrat se
   * bloquent l'un l'autre même si les termes ont changé entre-temps. C'est le
   * bon arbitrage — mieux vaut sérialiser deux changements de tarif que les
   * laisser courir ensemble.
   */
  'billing.price.ensure': capability('billing.price.ensure', {
    provider: 'STRIPE',
    label: 'Garantir le tarif Stripe d’un contrat',
    inputSchema: STRIPE_CAPABILITIES['billing.price.ensure'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.price.ensure'].outputSchema,
    timeoutMs: 25_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    correlationField: 'priceId',
    deriveOperationId: (context, input) => productOperationId({
      environment: context.environment,
      contractId: input.contractRef,
    }),
  }),

  'billing.checkout.create': capability('billing.checkout.create', {
    provider: 'STRIPE',
    label: 'Ouvrir une session de paiement',
    inputSchema: STRIPE_CAPABILITIES['billing.checkout.create'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.checkout.create'].outputSchema,
    timeoutMs: 25_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    correlationField: 'checkoutSessionId',
  }),
  /**
   * LES DEUX RÉSILIATIONS — servies depuis L6.2G.
   *
   * Leur identité d'acte est DÉRIVÉE du monde et de l'abonnement : une
   * résiliation est terminale, et laisser le projet la nommer lui permettrait
   * de couper deux fois ce qui ne se coupe qu'une.
   *
   * La capacité ne figure pas dans l'identité — elle est déjà dans la clé du
   * registre `(projectId, capability, operationId)` et dans la dérivation de la
   * clé Stripe. Les deux verbes restent donc des actes distincts.
   */
  'billing.subscription.cancel_at_period_end': capability('billing.subscription.cancel_at_period_end', {
    provider: 'STRIPE',
    label: 'Résilier en fin de période',
    inputSchema: STRIPE_CAPABILITIES['billing.subscription.cancel_at_period_end'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.subscription.cancel_at_period_end'].outputSchema,
    timeoutMs: 25_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    correlationField: 'subscriptionId',
    deriveOperationId: (context, input) => cancellationOperationId({
      environment: context.environment,
      subscriptionId: input.subscriptionId,
    }),
  }),
  'billing.subscription.cancel_now': capability('billing.subscription.cancel_now', {
    provider: 'STRIPE',
    label: 'Résilier immédiatement',
    inputSchema: STRIPE_CAPABILITIES['billing.subscription.cancel_now'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.subscription.cancel_now'].outputSchema,
    timeoutMs: 25_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    correlationField: 'subscriptionId',
    deriveOperationId: (context, input) => cancellationOperationId({
      environment: context.environment,
      subscriptionId: input.subscriptionId,
    }),
  }),
  /**
   * LE PREMIER USAGE NEUF DU PLAN DE CONTRÔLE (L10.4).
   *
   * Sa note de migration l'annonçait depuis L6 : « aucun code projet ne le
   * fait ». C'est toujours vrai, et ce n'est plus un obstacle — l'appelant
   * n'est pas un projet mais le Panel lui-même, depuis l'onglet Finances, via
   * `INVOCATION_SOURCES.PANEL_INTERNAL`. Toutes les autres capacités servies
   * ont migré un appel qui existait déjà ailleurs ; celle-ci n'en remplace
   * aucun. Elle naît directement dans le plan de contrôle.
   *
   * ══ SON IDENTITÉ D'ACTE N'EST PAS DÉRIVÉE, ET C'EST VOULU ═══════════════
   *
   * Les résiliations la dérivent parce qu'on ne résilie qu'une fois. Un
   * paiement de 500 € accepte en revanche deux remboursements partiels de
   * 100 € : dériver de `(monde, paiement)` rendrait le second impossible à
   * nommer. L'appelant nomme donc l'acte — et cet appelant étant le Panel, il
   * le nomme depuis une demande de remboursement DURABLE, écrite avant tout
   * contact fournisseur (`refundOperationId`). Deux clics rejouent la même
   * demande ; deux demandes sont deux actes.
   */
  'billing.refund': capability('billing.refund', {
    provider: 'STRIPE',
    label: 'Rembourser',
    inputSchema: STRIPE_CAPABILITIES['billing.refund'].inputSchema,
    outputSchema: STRIPE_CAPABILITIES['billing.refund'].outputSchema,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    correlationField: 'refundId',
  }),

  /* ── Yousign — SERVIES (R10.5C) ─────────────────────────────────────────── */

  /**
   * OUVRIR UNE SIGNATURE — un acte, cinq appels.
   *
   * Elle remplace `signature.request.create` : le nom `create` laissait croire
   * à un acte élémentaire qu'on compléterait ensuite, et c'est cette lecture
   * qui aurait fait exposer six capacités — donc laissé un projet capable de
   * s'arrêter au milieu d'une préparation.
   */
  'signature.request.open': capability('signature.request.open', {
    provider: 'YOUSIGN',
    label: 'Ouvrir une demande de signature',
    inputSchema: signatureRequestOpenInput,
    outputSchema: signatureRequestOpenOutput,
    /** Généreux : un upload de PDF n'est pas une lecture. */
    timeoutMs: 60_000,
    /**
     * Aucune clé d'idempotence chez Yousign : un doublon sollicite une seconde
     * fois une personne réelle avec un engagement juridique. Le registre
     * d'opérations EST la garantie, doublé de l'index partiel « une demande
     * vivante par contrat ».
     */
    idempotency: IDEMPOTENCY.UNKNOWN_ON_TIMEOUT,
    requiredPermissions: [PERMISSIONS.SIGNATURE_WRITE],
    correlationField: 'signatureRequestId',
  }),
  'signature.request.retrieve': capability('signature.request.retrieve', {
    provider: 'YOUSIGN',
    label: 'Lire l’état d’une demande de signature',
    inputSchema: signatureRequestRefInput,
    outputSchema: signatureRequestRetrieveOutput,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.SIGNATURE_READ],
  }),
  'signature.signer.retrieve': capability('signature.signer.retrieve', {
    provider: 'YOUSIGN',
    label: 'Lire le lien de signature d’un signataire',
    inputSchema: signatureSignerRetrieveInput,
    outputSchema: signatureSignerRetrieveOutput,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.SIGNATURE_READ],
  }),
  'signature.document.download': capability('signature.document.download', {
    provider: 'YOUSIGN',
    label: 'Télécharger un document signé',
    inputSchema: signatureRequestRefInput,
    outputSchema: signatureDocumentDownloadOutput,
    timeoutMs: 60_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.SIGNATURE_READ],
  }),
  'signature.request.cancel': capability('signature.request.cancel', {
    provider: 'YOUSIGN',
    label: 'Annuler une demande de signature',
    inputSchema: signatureRequestCancelInput,
    outputSchema: signatureRequestCancelOutput,
    timeoutMs: 30_000,
    idempotency: IDEMPOTENCY.UNKNOWN_ON_TIMEOUT,
    requiredPermissions: [PERMISSIONS.SIGNATURE_WRITE],
  }),

  /* ── Hostinger — les trois verbes du DNS, servis (L9.1) ─────────────────── */

  /**
   * LE CATALOGUE VIENT DE L9, LA PASSERELLE LE SERT — même patron que Brevo.
   *
   * Il y avait ici une définition locale de `dns.record.ensure`, écrite avant
   * l'audit L9 et fausse sur deux points : elle annonçait `SAFE_RETRY` là où
   * Hostinger n'expose aucune clé d'idempotence sur `PUT /zones/{zone}` — un
   * rejeu après un silence écrase une correction humaine — et sa note disait
   * « aucun projet ne l'invoquera », alors que le seul appelant réel du parc
   * est justement un projet. Les deux erreurs venaient de la même cause : la
   * capacité était décrite depuis le Panel, sans avoir lu le code qui l'appelle.
   *
   * `HOSTINGER_CAPABILITIES` porte en plus `requiresResourceOwnership` — un
   * champ que la fabrique d'ici ignore et que l'adaptateur lit : un jeton global
   * n'est pas une autorisation globale.
   */
  ...HOSTINGER_CAPABILITIES,
});

export const CAPABILITY_CODES = Object.freeze(Object.keys(CAPABILITY_DEFINITIONS));

/* -------------------------------------------------------------------------- */
/*  ACCÈS                                                                     */
/* -------------------------------------------------------------------------- */

export function isKnownCapability(code) {
  return typeof code === 'string' && Object.hasOwn(CAPABILITY_DEFINITIONS, code);
}

/** Définition, ou `null`. L'appelant décide si l'absence est une erreur. */
export function getCapabilityDefinition(code) {
  return isKnownCapability(code) ? CAPABILITY_DEFINITIONS[code] : null;
}

/** Toutes les définitions, dans un ordre STABLE — celui des écrans. */
export function listCapabilityDefinitions() {
  return CAPABILITY_CODES.map((code) => CAPABILITY_DEFINITIONS[code]);
}

export function capabilitiesForProvider(provider) {
  const code = String(provider ?? '').toUpperCase();
  return listCapabilityDefinitions().filter((c) => c.provider === code);
}

/**
 * Vue publique — ce que rend l'API et ce que montre l'écran.
 *
 * Ni schéma zod, ni note interne : un schéma sérialisé n'aide personne à
 * l'écran, et l'exposer inviterait un client à le réimplémenter au lieu de
 * lire le contrat.
 */
export function describeCapability(code) {
  const capability = getCapabilityDefinition(code);
  if (!capability) return null;
  return {
    code: capability.code,
    label: capability.label,
    provider: capability.provider,
    scope: capability.scope,
    idempotency: capability.idempotency,
    timeoutMs: capability.timeoutMs,
    requiredPermissions: [...capability.requiredPermissions],
  };
}

export function describeCapabilities() {
  return CAPABILITY_CODES.map((code) => describeCapability(code));
}

/* -------------------------------------------------------------------------- */
/*  ALIGNEMENT — le contrôle qui empêche deux vérités                         */
/* -------------------------------------------------------------------------- */

/**
 * Les registres racontent-ils la même histoire ?
 *
 * Trois divergences possibles, et chacune est un incident réel en puissance :
 *
 *  · un fournisseur inconnu du registre L1 → aucun credential ne sera trouvé ;
 *  · une capacité sans contrat d'entrée ou de sortie → elle accepterait
 *    n'importe quoi, et rendrait n'importe quoi ;
 *  · une capacité annoncée par un fournisseur mais absente d'ici → l'écran
 *    promet ce que la passerelle ne sait pas faire.
 *
 * @returns {string[]} problèmes, vide si tout s'accorde.
 */
export function assertRegistryAlignment() {
  const problems = [];

  for (const capability of listCapabilityDefinitions()) {
    if (!getProviderDefinition(capability.provider)) {
      problems.push(`« ${capability.code} » désigne un fournisseur absent du registre L1 : ${capability.provider}.`);
    }
    /**
     * Toute capacité déclarée est SERVIE : la condition `migrated` qui gardait
     * autrefois ce contrôle laissait passer les capacités fantômes, puisqu'elle
     * les dispensait précisément de tenir un contrat.
     */
    if (!capability.inputSchema || !capability.outputSchema) {
      problems.push(`« ${capability.code} » est servie sans schéma d’entrée ou de sortie.`);
    }
    if (!Object.values(IDEMPOTENCY).includes(capability.idempotency)) {
      problems.push(`« ${capability.code} » porte une stratégie d’idempotence inconnue.`);
    }
    if (!Number.isFinite(capability.timeoutMs) || capability.timeoutMs <= 0) {
      problems.push(`« ${capability.code} » n’a pas de délai d’attente exploitable.`);
    }
    if (capability.requiredPermissions.length === 0) {
      problems.push(`« ${capability.code} » n’exige aucune permission.`);
    }
  }

  // Le catalogue Brevo de L8 est la source du contrat métier Brevo : la
  // passerelle le SERT, elle ne le redéfinit pas.
  for (const code of BREVO_CAPABILITY_CODES) {
    if (!isKnownCapability(code)) {
      problems.push(`le catalogue Brevo (L8) déclare « ${code} » — absent du registre des capacités.`);
    }
  }
  for (const capability of capabilitiesForProvider('BREVO')) {
    if (!BREVO_CAPABILITY_CODES.includes(capability.code)) {
      problems.push(`« ${capability.code} » est déclarée Brevo ici, mais absente du catalogue L8.`);
    }
  }

  // Même règle pour le catalogue Hostinger de L9 : il est la source du contrat
  // DNS, et la symétrie doit tenir dans les DEUX sens. Une capacité Hostinger
  // qui n'existerait qu'ici serait servie sans appartenance vérifiée — c'est
  // exactement le pouvoir qu'un jeton global ne doit jamais accorder.
  for (const code of HOSTINGER_CAPABILITY_CODES) {
    if (!isKnownCapability(code)) {
      problems.push(`le catalogue Hostinger (L9) déclare « ${code} » — absent du registre des capacités.`);
    }
  }
  for (const capability of capabilitiesForProvider('HOSTINGER')) {
    if (!HOSTINGER_CAPABILITY_CODES.includes(capability.code)) {
      problems.push(`« ${capability.code} » est déclarée Hostinger ici, mais absente du catalogue L9.`);
    }
    if (capability.requiresResourceOwnership !== true) {
      problems.push(`« ${capability.code} » administre une ressource sans exiger la preuve de son appartenance.`);
    }
  }

  /**
   * Le catalogue Stripe de L6.1 est la source du contrat financier.
   *
   * La symétrie est désormais COMPLÈTE dans ce sens-là : toute capacité Stripe
   * du registre tient son contrat du catalogue, et le MÊME objet — deux schémas
   * qui se ressemblent divergeraient au premier ajout de champ, et la
   * divergence porterait sur ce qu'on accepte de facturer.
   *
   * La dispense `if (!capability.migrated) continue;` a disparu avec le booléen
   * qu'elle lisait. Elle exemptait exactement les capacités que L6.1 avait
   * refusé de contractualiser — c'est-à-dire celles qu'on affichait sans
   * pouvoir les servir. Il n'en reste aucune.
   */
  for (const capability of capabilitiesForProvider('STRIPE')) {
    const catalogue = STRIPE_CAPABILITIES[capability.code];
    if (!catalogue) {
      problems.push(`« ${capability.code} » est servie sans figurer au catalogue Stripe (L6.1).`);
      continue;
    }
    if (capability.inputSchema !== catalogue.inputSchema
      || capability.outputSchema !== catalogue.outputSchema) {
      problems.push(`« ${capability.code} » ne sert pas le contrat du catalogue Stripe (L6.1).`);
    }
    /**
     * Les deux règles suivantes ne valent que pour les ÉCRITURES.
     *
     * Une lecture n'a ni doublon à craindre ni objet à corréler : lui imposer
     * une idempotence fournisseur et une poignée de corrélation obligerait à
     * inventer les deux, et une exigence qu'on satisfait en inventant ne
     * protège plus rien.
     */
    /**
     * `billing.customer.ensure` n'est pas FINANCIÈRE — créer un client ne
     * débite rien — mais elle CRÉE un objet chez le fournisseur. Les deux
     * exigences suivantes valent donc pour toute écriture qui produit une
     * ressource, financière ou non : sans idempotence on la duplique, sans
     * poignée de corrélation on la perd.
     */
    const ecritureCreatrice = catalogue.financial || Boolean(capability.correlationField);
    if (ecritureCreatrice) {
      if (capability.idempotency !== IDEMPOTENCY.PROVIDER_IDEMPOTENT) {
        problems.push(`« ${capability.code} » est une écriture Stripe servie sans idempotence fournisseur.`);
      }
      // Sans poignée de corrélation, l'objet créé serait produit puis oublié.
      if (!capability.correlationField) {
        problems.push(`« ${capability.code} » est servie sans champ de corrélation.`);
      }
    }
    /**
     * En revanche, TOUTE capacité servie qui manipule une ressource
     * préexistante doit exiger la preuve de son appartenance. C'est la règle qui
     * empêche qu'un jour on serve une lecture « juste pour dépanner ».
     */
    if (catalogue.resourceKind && !catalogue.requiresResourceOwnership) {
      problems.push(`« ${capability.code} » manipule une ressource sans exiger la preuve de son appartenance.`);
    }
  }

  /**
   * TOUS les fournisseurs du registre, et non une liste retapée ici.
   *
   * La liste littérale était une bombe à retardement silencieuse : un
   * fournisseur ajouté au registre L1 échappait à ce contrôle, et pouvait donc
   * annoncer une capacité inexistante sans que rien ne le dise. Le contrôle
   * s'appliquait exactement aux fournisseurs qui n'en avaient plus besoin —
   * ceux déjà écrits — et jamais au suivant, qui est le seul cas où il sert.
   */
  for (const definition of listProviderDefinitions()) {
    for (const code of definition.capabilities) {
      if (!isKnownCapability(code)) {
        problems.push(`${definition.code} annonce « ${code} » — absent du registre des capacités.`);
      }
    }
  }

  return problems;
}

export default {
  IDEMPOTENCY,
  PERMISSIONS,
  CAPABILITY_DEFINITIONS,
  CAPABILITY_CODES,
  isKnownCapability,
  getCapabilityDefinition,
  listCapabilityDefinitions,
  capabilitiesForProvider,
  describeCapability,
  describeCapabilities,
  assertRegistryAlignment,
};
