// LES INVARIANTS DU LOT, ÉPROUVÉS SUR LE CODE LUI-MÊME (L6.2C).
//
// ══ POURQUOI DES CONTRÔLES STATIQUES, ALORS QUE L'E2E PASSE ══════════════════
//
// L'E2E prouve que le système SE COMPORTE bien aujourd'hui. Ces contrôles-ci
// visent autre chose : qu'il ne PUISSE PAS mal se comporter demain, après une
// modification faite de bonne foi par quelqu'un qui n'a pas lu ce lot.
//
// Chacun vise une propriété ARCHITECTURALE nommée, pas une chaîne de caractères
// choisie au hasard — un contrôle qui se contourne en renommant une variable ne
// protège rien et donne la fausse impression du contraire.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (relatif) => fs.readFileSync(path.join(RACINE, relatif), 'utf8');

/** Le code SANS ses commentaires : on juge ce qui s'exécute, pas ce qui s'explique. */
const sansCommentaires = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const adaptateurs = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeAdapters.js'));
const routage = sansCommentaires(lire('backend/src/services/webhooks/stripeEventRouting.js'));
const autoriteClient = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeCustomerAuthority.js'));
const autoriteTarif = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripePriceAuthority.js'));
const transport = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeTransport.js'));
const adoption = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeSubscriptionAdoption.js'));
const ingest = sansCommentaires(lire('backend/src/services/webhooks/webhookIngest.js'));

/* ========================================================================== */
section('1. L’APPARTENANCE PRÉCÈDE LE FOURNISSEUR — dans l’ordre du fichier');
/* ========================================================================== */
{
  /**
   * On ne cherche pas « assertOwnedResource est appelé quelque part » : ce
   * serait vrai même si l'appel venait après. On compare les POSITIONS dans le
   * corps de la lecture — la garantie du lot est un ORDRE, et c'est l'ordre
   * qu'on vérifie.
   */
  const debut = adaptateurs.indexOf('async function checkoutRetrieve');
  check('la lecture existe', debut > 0);
  const corps = adaptateurs.slice(debut, adaptateurs.indexOf('\n}', debut));

  const posAppartenance = corps.indexOf('assertOwnedResource');
  const posFournisseur = corps.indexOf('retrieveCheckoutSession');
  check('elle vérifie l’appartenance', posAppartenance > 0);
  check('elle appelle le fournisseur', posFournisseur > 0);
  check('OWNERSHIP_BEFORE_PROVIDER — l’appartenance est vérifiée AVANT',
    posAppartenance < posFournisseur);

  /**
   * Et l'attente est RÉELLE. `assertOwnedResource(...)` sans `await` rendrait
   * une promesse ignorée : l'appel Stripe partirait pendant que la vérification
   * court encore, et le refus arriverait trop tard pour empêcher quoi que ce
   * soit. C'est le défaut le plus facile à introduire, et le plus invisible.
   */
  check('…et attendue avant de poursuivre',
    /await\s+guard\([^)]*,\s*\(\)\s*=>\s*assertOwnedResource/.test(corps));
}

/* ========================================================================== */
section('2. AUCUNE LECTURE FOURNISSEUR POUR DÉCOUVRIR UN PROPRIÉTAIRE');
/* ========================================================================== */
{
  /**
   * UNOWNED_RESOURCE_PROVIDER_LOOKUPS = 0.
   *
   * Le module de routage résout l'appartenance. S'il importait le transport
   * Stripe, il pourrait interroger le fournisseur pour rattacher une ressource
   * inconnue — remonter d'un `payment_intent` vers sa session, par exemple.
   * C'est précisément l'ordre inverse de la doctrine : on paierait un appel
   * fournisseur pour découvrir à qui appartient quelque chose.
   *
   * L'invariant se lit donc sur les DÉPENDANCES : ce module ne sait pas parler
   * à Stripe, donc il ne peut pas le faire.
   */
  check('le routage n’importe aucun transport fournisseur',
    !/stripeTransport|from '.*Transport\.js'/.test(routage));
  check('…n’appelle pas fetch', !/\bfetch\s*\(/.test(routage));
  check('…et ne lit aucun credential', !/credential|secretKey|decrypt/i.test(routage));

  // Il ne connaît qu'une source de vérité : le registre de liens.
  check('sa seule source d’appartenance est le registre de liens',
    /from '\.\.\/integratedApi\/stripe\/stripeResourceBinding\.js'/.test(routage));
}

/* ========================================================================== */
section('3. METADATA N’EST JAMAIS L’AUTORITÉ');
/* ========================================================================== */
{
  /**
   * WEBHOOK_METADATA_AUTHORITY = 0.
   *
   * Les metadata sont lues — il le faut, pour détecter une divergence. Ce qui
   * est interdit, c'est qu'elles ALIMENTENT le champ `projectId` rendu. On
   * vérifie donc que le seul `projectId` retourné vient d'un `binding`.
   */
  const retours = [...routage.matchAll(/projectId:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  check('des destinataires sont bien rendus', retours.length >= 3);
  check('…et chacun vient du LIEN ou vaut null',
    retours.every((v) => v === 'null' || v.startsWith('binding.')));

  // La revendication existe, et elle est nommée pour ce qu'elle est.
  check('la revendication des metadata est isolée dans une fonction dédiée',
    /function claimedProjectId/.test(routage));
  check('…et son résultat ne sert qu’à comparer',
    /claim\s*&&\s*claim\s*!==\s*binding\.projectId/.test(routage));
}

/* ========================================================================== */
section('4. AUCUN NOUVEL ENDPOINT WEBHOOK');
/* ========================================================================== */
{
  /**
   * NEW_STRIPE_WEBHOOK_ENDPOINTS = 0.
   *
   * L6.1 a reporté le cutover d'endpoint pour ne pas ouvrir de fenêtre de perte
   * d'événements financiers. Ni le routage ni la réception ne doivent pouvoir
   * créer, modifier ou supprimer un endpoint chez le fournisseur.
   */
  for (const [nom, source] of [['le routage', routage], ['la réception', ingest]]) {
    check(`${nom} ne touche pas /v1/webhook_endpoints`,
      !/webhook_endpoints/.test(source));
    check(`${nom} ne manipule aucun secret de signature`,
      !/storeWebhookSecret|rotateWebhookSecret/.test(source));
  }
}

/* ========================================================================== */
section('5. LA RÉCEPTION NE MUTE AUCUN PROJET');
/* ========================================================================== */
{
  /**
   * Pendant la coexistence, SB Auto reçoit les MÊMES événements sur son propre
   * endpoint et y règle ses paiements. Si le Panel projetait ici le même fait,
   * la même vérité serait appliquée deux fois par deux chemins.
   *
   * Le routage doit donc RÉSOUDRE et ENREGISTRER — jamais émettre.
   */
  check('le routage n’émet aucun changement dans le journal durable',
    !/emitChange|syncCore/.test(routage));
  check('…et n’écrit dans aucune collection',
    !/updateOne|create\(|save\(|deleteOne/.test(routage));
}

/* ========================================================================== */
section('6. LE REFUS RESTE INDISTINGUABLE — une seule fabrique');
/* ========================================================================== */
{
  const erreurs = sansCommentaires(lire('backend/src/services/capabilities/capabilityErrors.js'));
  /**
   * Un seul constructeur pour le refus d'appartenance, sans paramètre de motif.
   * Lui en ajouter un — même « pour le diagnostic » — rendrait les trois refus
   * distinguables du dehors, et recréerait l'oracle d'existence.
   */
  check('la fabrique du refus n’accepte que le code de capacité',
    /export const capabilityResourceNotOwned = \(code\) =>/.test(erreurs));
  check('…et son message ne prend aucun motif',
    !/capabilityResourceNotOwned\s*=\s*\([^)]*reason/.test(erreurs));

  const registre = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeResourceBinding.js'));
  check('le registre rend un message unique pour tous les motifs',
    (registre.match(/Ressource Stripe inconnue ou non autorisée/g) ?? []).length === 1);
}

/* ========================================================================== */
section('7. PLUS AUCUNE LECTURE LOCALE SUR LE PARCOURS MIGRÉ (SB Auto)');
/* ========================================================================== */
{
  /**
   * MIGRATED_CHECKOUT_LOCAL_RETRIEVE_CALLS = 0.
   *
   * SAUTÉ si le dépôt voisin n'est pas là : ce contrôle porte sur un autre
   * dépôt, et un test qui échoue faute de voisin n'apprend rien.
   */
  const voisin = path.resolve(RACINE, '..', 'SB Auto 06', 'backend', 'src', 'services');
  if (!fs.existsSync(voisin)) {
    check('SB Auto absent — contrôle sauté proprement', true);
  } else {
    const paiement = sansCommentaires(fs.readFileSync(path.join(voisin, 'payment.service.js'), 'utf8'));
    check('le service de paiement ne lit plus la session localement',
      !/provider\.retrieveCheckoutSession/.test(paiement));
    check('…il demande la capacité', /readCheckoutViaPanel/.test(paiement));
    /**
     * Et surtout : AUCUN repli. Un `catch` qui retomberait sur le pilote local
     * ramènerait l'ancien chemin le jour d'un incident, sans que rien ne le
     * signale.
     */
    check('aucun repli local en cas d’échec de la capacité',
      !/catch[\s\S]{0,200}provider\.retrieve/.test(paiement));

    /**
     * ── CE CONTRÔLE A CHANGÉ DE SENS (L6.2E puis L6.2F) ──────────────────────
     *
     * Il vérifiait que l'abonnement lisait ENCORE localement — un périmètre
     * assumé au lot L6.2C, quand ses ressources n'avaient aucun lien.
     *
     * Elles en ont désormais toutes : la session (L6.2B), le client (L6.2D), le
     * tarif (L6.2E) et l'abonnement lui-même (L6.2F, par adoption). Il n'y a
     * donc plus aucune raison de lire quoi que ce soit avec la clé du projet, et
     * le contrôle s'inverse.
     */
    const abonnement = sansCommentaires(fs.readFileSync(path.join(voisin, 'subscription.service.js'), 'utf8'));
    check('le parcours d’abonnement ne lit plus AUCUNE session localement',
      !/provider\.retrieveCheckoutSession/.test(abonnement));
  }
}

/* ========================================================================== */
section('8. LE CLIENT EST CELUI DE L’ENTREPRISE CLIENTE');
/* ========================================================================== */
{
  /**
   * ── L’INVARIANT A CHANGÉ DE PORTEUR, ET C’EST LE CŒUR DE CE LOT ─────────
   *
   * ══ CE QUE L’ANCIENNE CARDINALITÉ PRODUISAIT ═════════════════════════════
   *
   * « Un client Stripe par CONTRAT » venait d’un audit du parc — clé
   * `customer-<contractId>-<mode>`, stockage sur `Contract.stripe.customerId`.
   * Elle décrivait fidèlement un monde où l’acheteur n’existait pas comme
   * entité. Ses conséquences :
   *
   *   · deux contrats successifs d’un même client → deux clients Stripe, et
   *     un historique de facturation scindé pour une seule personne morale ;
   *   · une prestation ponctuelle, qui n’a PAS de contrat → aucun client, donc
   *     une facture sans destinataire juridique.
   *
   * ══ LA CARDINALITÉ COURANTE ══════════════════════════════════════════════
   *
   * Un client Stripe par ENTREPRISE CLIENTE et par MONDE. C’est le seul
   * niveau où « Facturer à » a un sens : on facture une personne morale, pas
   * un engagement ni une instance technique.
   *
   * Le PROJET reste hors de la clé — il est déjà porté par le registre de
   * liens, et l’y remettre laisserait croire qu’une même entreprise pourrait
   * appartenir à deux projets à la fois.
   */
  check('l’identité d’acte du client porte l’ENTREPRISE CLIENTE',
    /customerOperationId\(\{ environment, clientCompanyId \}\)/.test(autoriteClient));
  check('…et le MONDE',
    /stripe-customer:\$\{environment\}:company:\$\{clientCompanyId\}/.test(autoriteClient));
  check('…mais PAS le projet',
    !/stripe-customer:[^`]*projectId/.test(autoriteClient));
  /**
   * La vérification porte sur le CORPS de `customerOperationId` seul : la
   * fonction d'adoption qui la suit contient légitimement l'ancienne forme,
   * et un test qui balaierait tout le fichier confondrait « on crée encore
   * par contrat » avec « on sait encore lire l'ancienne clé ».
   */
  const debutCle = autoriteClient.indexOf('export function customerOperationId');
  const corpsCle = autoriteClient.slice(debutCle, autoriteClient.indexOf(String.fromCharCode(10) + String.fromCharCode(125), debutCle));
  check('…ni le contrat',
    !/contractId/.test(corpsCle));

  /**
   * L’ANCIENNE CLÉ SURVIT — pour ADOPTER, jamais pour créer.
   *
   * Sans elle, un client créé avant ce lot serait ignoré et l’on en créerait
   * un second pour la même personne morale : exactement le défaut qu’on
   * ferme. Sa seule présence ne suffit pas — le test suivant vérifie qu’elle
   * n’aboutit qu’à une adoption.
   */
  check('l’ancienne clé reste NOMMÉE pour l’adoption',
    /legacyCustomerOperationId/.test(autoriteClient));

  /**
   * Et la recherche du client existant reste faite PAR ACTE, jamais par
   * projet : `findBinding({projectId, resourceType: CUSTOMER})` rendrait le
   * premier client venu du projet, c’est-à-dire potentiellement celui d’une
   * autre entreprise.
   */
  const debut = adaptateurs.indexOf('async function lienClientAvecAdoption');
  check('la cascade de résolution existe', debut > 0);
  const corps = adaptateurs.slice(debut, adaptateurs.indexOf('\n}', debut));
  check('le client existant est cherché PAR ACTE', /findBindingByOperation/.test(corps));
  check('…et jamais par simple appartenance au projet',
    !/listOwnedResourceIds|findBinding\(\{[^}]*resourceType: CUSTOMER[^}]*\}\)/.test(corps));
  check('l’ancienne clé ne sert QU’À ADOPTER, jamais à créer',
    /adoptBindingOperation/.test(corps) && !/createCustomer/.test(corps));
  check('un lien RÉVOQUÉ n’est jamais adopté',
    /revokedAt\) return herite/.test(corps));
}
/* ========================================================================== */
section('9. LE PROJET NE NOMME PAS L’ACTE, ET N’ADOPTE RIEN (L6.2D)');
/* ========================================================================== */
{
  const catalogue = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeCapabilities.js'));
  const debut = catalogue.indexOf('const customerEnsureInput');
  check('le contrat d’entrée existe', debut > 0);
  const schema = catalogue.slice(debut, catalogue.indexOf('}).strict();', debut));

  /**
   * Deux absences, et chacune ferme une porte :
   *
   *   `operationId`  laisserait le projet nommer deux fois le même acte, donc
   *                  obtenir deux clients pour un contrat ;
   *   `customerId`   laisserait le projet DÉSIGNER la ressource à adopter — un
   *                  identifiant présenté n'est pas une preuve de propriété.
   */
  check('aucun operationId dans l’entrée', !/operationId/.test(schema));
  check('aucun customerId dans l’entrée', !/customerId/.test(schema));
  check('…et le schéma reste strict', /\}\)\.strict\(\)/.test(catalogue.slice(debut, debut + 900)));

  const registre = sansCommentaires(lire('backend/src/services/capabilities/capabilityRegistry.js'));
  check('l’identité est DÉRIVÉE côté Panel', /deriveOperationId: \(context, input\)/.test(registre));

  /**
   * La dérivation doit rester PURE. Une dérivation qui lirait la base serait
   * faite deux fois — ici et dans l'adaptateur — et les deux pourraient
   * diverger sans que rien ne le signale.
   */
  const derivation = registre.slice(registre.indexOf('deriveOperationId: (context, input)'), registre.indexOf('deriveOperationId: (context, input)') + 200);
  check('…et PURE : aucune lecture de base dans la dérivation',
    !/await|findOne|Model/.test(derivation));
}

/* ========================================================================== */
section('10. AUCUN CLIENT CRÉÉ LOCALEMENT (SB Auto)');
/* ========================================================================== */
{
  const voisin = path.resolve(RACINE, '..', 'SB Auto 06', 'backend', 'src', 'services');
  if (!fs.existsSync(voisin)) {
    check('SB Auto absent — contrôle sauté proprement', true);
  } else {
    const abonnement = sansCommentaires(fs.readFileSync(path.join(voisin, 'subscription.service.js'), 'utf8'));
    check('le service d’abonnement ne crée plus de client',
      !/provider\.createCustomer/.test(abonnement));
    check('…il demande la capacité', /ensureCustomerViaPanel/.test(abonnement));
    check('aucun repli local en cas d’échec',
      !/catch[\s\S]{0,200}createCustomer/.test(abonnement));

    /**
     * Le court-circuit `if (contract.stripe.customerId) return …` a disparu :
     * il rendait un identifiant sans jamais vérifier qu'il existe encore, ni à
     * qui il appartient. Le garder ferait dépendre le cas nominal d'une valeur
     * que personne ne vérifie.
     */
    check('aucun court-circuit sur le champ historique',
      !/if \(contract\.stripe\.customerId\) return/.test(abonnement));

    /**
     * Le champ historique reste RENSEIGNÉ — la facturation locale le relit
     * (`billing.service.js`). Depuis L6.2E, il est écrit à partir du client
     * que le PANEL rend avec la session d'abonnement : son sens a changé, il
     * porte une référence de l'autorité et non plus un identifiant fabriqué ici.
     */
    check('…mais le champ historique est toujours écrit',
      /contract\.stripe\.customerId = session\.customerId/.test(abonnement));
  }
}

/* ========================================================================== */
section('11. UN PRICE NE SE MODIFIE JAMAIS (L6.2E)');
/* ========================================================================== */
{
  /**
   * PRICE_MUTATION_PRIMITIVES = 0.
   *
   * Stripe interdit de changer le montant, la devise ou la périodicité d'un
   * Price : changer de tarif, c'est en créer un autre. Cette contrainte est
   * aussi la bonne sémantique métier — un abonnement souscrit à 249 € doit
   * continuer de référencer 249 €.
   *
   * L'invariant se lit sur les PRIMITIVES disponibles : si le transport n'offre
   * aucune mise à jour de Price, personne ne pourra en écrire une par
   * inadvertance. On ne défend pas une discipline, on retire l'outil.
   */
  /**
   * On cherche une ÉCRITURE ciblant un Price précis — c'est la seule forme
   * qu'aurait une mutation. Lire un Price (`GET /v1/prices/{id}`) est au
   * contraire indispensable à la reprise, et ne doit pas être confondu avec elle.
   */
  const ecrituresCiblees = [...transport.matchAll(/method: '(\w+)', path: `\/v1\/prices\/\$\{[^`]*`/g)]
    .map((m) => m[1]);
  check('le transport ne sait pas mettre à jour un Price',
    !/updatePrice/.test(transport) && ecrituresCiblees.every((m) => m === 'GET'));
  check('…ni archiver ou supprimer un Price', !/deletePrice|archivePrice/.test(transport));
  check('il ne sait que CRÉER et LIRE',
    /export async function createPrice/.test(transport)
    && /export async function retrievePrice/.test(transport));
}

/* ========================================================================== */
section('12. LA CLÉ DU TARIF PORTE LES TERMES, PAS LA VERSION (L6.2E)');
/* ========================================================================== */
{
  /**
   * L'audit du parc a établi que `signatureConfiguration.version` s'incrémente
   * à CHAQUE sauvegarde des zones de signature : c'est un compteur de document,
   * pas une version commerciale. Y adosser l'identité d'un tarif produit des
   * Price identiques mais démultipliés.
   *
   * La clé porte donc les TERMES — et chacun d'eux, sans quoi un changement
   * passerait inaperçu. La devise en particulier : la garde locale historique
   * l'oubliait, et réutilisait un Price pour une autre devise.
   */
  /**
   * ══ ÉPROUVÉ PAR LE COMPORTEMENT, PLUS PAR LE TEXTE DU FICHIER ════════════
   *
   * Cette vérification lisait la SOURCE au moyen d'expressions régulières. Elle
   * a rougi le jour où la fonction a gagné `intervalCount` — sans que la
   * propriété gardée ait bougé d'un iota : la clé porte toujours tous les
   * termes. Un test qui casse sur un refactor qu'il devrait ignorer finit par
   * être « corrigé » en relâchant son motif, et ne garde alors plus rien.
   *
   * On interroge donc la fonction : faire varier un terme DOIT changer la clé.
   * C'est ce que la doctrine dit, c'est indépendant de l'écriture, et cela
   * couvrira `intervalCount` et tout terme ajouté demain.
   */
  const { priceOperationId } = await import(
    '../backend/src/services/integratedApi/stripe/stripePriceAuthority.js'
  );
  const base = {
    environment: 'TEST', contractId: 'c-1', interval: 'month',
    intervalCount: 1, amount: 4900, currency: 'eur',
  };
  const cleBase = priceOperationId(base);

  const variations = {
    interval: { ...base, interval: 'year' },
    amount: { ...base, amount: 5900 },
    currency: { ...base, currency: 'usd' },
    intervalCount: { ...base, intervalCount: 3 },
    environment: { ...base, environment: 'PROD' },
    contractId: { ...base, contractId: 'c-2' },
  };
  for (const [terme, args] of Object.entries(variations)) {
    check(`la clé du Price distingue « ${terme} »`, priceOperationId(args) !== cleBase);
  }

  check('la même commande rend la MÊME clé', priceOperationId({ ...base }) === cleBase);
  check('…et le monde y figure', cleBase.startsWith('stripe-price:TEST:'));
  check('…mais PAS la version du contrat',
    !/version/i.test(cleBase) && !/stripe-price:[^`]*version/i.test(autoriteTarif));

  /**
   * Le Product, lui, ne porte PAS les termes : c'est un contenant, et les
   * tarifs successifs d'un contrat doivent s'y accrocher. L'y faire dépendre du
   * montant créerait un Product par changement de prix.
   */
  check('la clé du Product porte le contrat', /stripe-product:\$\{environment\}:\$\{contractId\}/.test(autoriteTarif));
  check('…et rien d’autre', !/stripe-product:[^`]*(amount|interval|currency)/.test(autoriteTarif));

  // La devise est normalisée : deux graphies produiraient deux Price identiques.
  check('la devise est normalisée dans la clé',
    /String\(currency\)\.toLowerCase\(\)/.test(autoriteTarif));
}

/* ========================================================================== */
section('13. LE MONTANT NE VIENT JAMAIS DU PROJET (L6.2E)');
/* ========================================================================== */
{
  const catalogue = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeCapabilities.js'));
  const debut = catalogue.indexOf('const priceEnsureInput');
  check('le contrat d’entrée du tarif existe', debut > 0);
  const schema = catalogue.slice(debut, catalogue.indexOf('}).strict();', debut));

  /**
   * L'entrée ne porte QUE la référence de contrat. Chaque champ absent ferme
   * une porte : un montant transmis puis comparé resterait un montant transmis,
   * et la comparaison finirait par devenir une tolérance.
   */
  for (const interdit of ['amount', 'currency', 'interval', 'priceId', 'productId', 'operationId']) {
    check(`aucun « ${interdit} » dans l’entrée du tarif`, !new RegExp(interdit).test(schema));
  }
  check('…seule la référence de contrat est acceptée', /contractRef/.test(schema));

  // Et les termes sont lus dans la projection, pas ailleurs.
  check('les termes viennent de la projection de contrat',
    /projection\.pricing\?\.subscription/.test(autoriteTarif));
}

/* ========================================================================== */
section('14. LE PARCOURS ABONNEMENT N’ÉCRIT PLUS CHEZ STRIPE (SB Auto)');
/* ========================================================================== */
{
  const voisin = path.resolve(RACINE, '..', 'SB Auto 06', 'backend', 'src', 'services');
  if (!fs.existsSync(voisin)) {
    check('SB Auto absent — contrôle sauté proprement', true);
  } else {
    const abonnement = sansCommentaires(fs.readFileSync(path.join(voisin, 'subscription.service.js'), 'utf8'));
    const service = sansCommentaires(fs.readFileSync(path.join(voisin, 'stripe', 'stripe.service.js'), 'utf8'));

    /**
     * LOCAL_RUNTIME_SUBSCRIPTION_CHECKOUT_WRITES = 0.
     *
     * Les trois écritures du parcours — client, produit/tarif, session — ont
     * disparu du service d'abonnement, et le constructeur de session
     * d'abonnement a disparu du service Stripe.
     */
    for (const ecriture of ['createCustomer', 'createProduct', 'createPrice']) {
      check(`aucun ${ecriture} local`, !new RegExp(`provider\.${ecriture}`).test(abonnement));
    }
    check('aucune session d’abonnement construite localement',
      !/createSubscriptionCheckout\(/.test(service));
    check('…et le service ne l’exporte plus',
      !/export async function createSubscriptionCheckout/.test(service));

    check('le parcours demande la capacité',
      /createSubscriptionCheckoutViaPanel/.test(abonnement));
    check('aucun repli local en cas d’échec',
      !/catch[\s\S]{0,200}provider\.create/.test(abonnement));

    /**
     * L6.3 — LE PILOTE A ÉTÉ RÉDUIT, ET C'EST LE POINT.
     *
     * Aux lots précédents on constatait que le verbe survivait « au cas où » :
     * plus aucun parcours ne l'appelait, mais la capacité technique restait.
     * C'était une porte fermée avec la clé sur la serrure.
     *
     * L6.3 retire les neuf verbes dont le Panel a repris la charge. On vérifie
     * ici les trois qui concernent cette section — la session, sa lecture, et
     * la création de client — parce que ce sont ceux que le parcours abonnement
     * pourrait rouvrir le plus naturellement.
     */
    /**
     * L6.3C — LE PILOTE N'EXISTE PLUS DU TOUT.
     *
     * Cet invariant a pris trois formes, et chacune disait où en était la
     * migration :
     *
     *   L6.2E  « le pilote reste complet »        le verbe survivait au cas où
     *   L6.3   « il n'expose plus ces trois-là »  la porte se refermait
     *   L6.3C  « il n'y a plus de porte »         le fichier a disparu
     *
     * On vérifie donc l'ABSENCE des fichiers. C'est plus fort qu'une liste de
     * verbes retirés, qu'un fichier vide satisferait aussi.
     */
    for (const parti of ['stripe.provider.js', 'stripe.stub.js']) {
      check(`le pilote voisin ${parti} n’existe plus`,
        !fs.existsSync(path.join(voisin, 'stripe', parti)));
    }
    const serviceStripe = sansCommentaires(
      fs.readFileSync(path.join(voisin, 'stripe', 'stripe.service.js'), 'utf8'),
    );
    check('…et le service voisin n’en fabrique plus aucun',
      !/getStripeProvider/.test(serviceStripe));
  }
}

/* ========================================================================== */
section('15. L’ADOPTION NE S’OBTIENT QUE PAR FILIATION (L6.2F)');
/* ========================================================================== */
{
  /**
   * SUBSCRIPTION_ADOPTION_BY_CLAIM = 0.
   *
   * L'abonnement est la première ressource adoptée du plan de contrôle. Toute
   * la légitimité de cette adoption tient à UNE chose : elle part d'une session
   * dont l'appartenance est déjà prouvée, et c'est Stripe qui désigne la
   * filiation.
   *
   * L'invariant se lit donc sur la SIGNATURE : la fonction ne doit pas pouvoir
   * recevoir un identifiant d'abonnement. Si elle le pouvait, un appelant
   * distrait — ou un futur endpoint d'administration — finirait par le lui
   * passer, et l'adoption redeviendrait une déclaration.
   */
  check('la fonction d’adoption ne prend PAS d’identifiant d’abonnement',
    !/adoptSubscriptionFromSession\(\{[^}]*subscriptionId/.test(adoption));
  check('…elle reçoit la SESSION telle que Stripe la rend',
    /adoptSubscriptionFromSession\(\{ environment, session, source \}\)/.test(adoption));
  check('…et extrait elle-même la filiation', /idOf\(session\.subscription\)/.test(adoption));

  /**
   * La preuve vient AVANT tout le reste : sans lien sur la session, on renonce.
   * On vérifie l'ORDRE, pas seulement la présence — une vérification placée
   * après la lecture des metadata ne protégerait plus de rien.
   */
  const posLien = adoption.indexOf('findBinding(');
  const posMetadata = adoption.indexOf('metadata?.panelProjectId');
  check('le lien de session est cherché AVANT de lire les metadata',
    posLien > 0 && posMetadata > posLien);
  check('…et l’absence de lien interrompt tout',
    /if \(!lienSession \|\| lienSession\.revokedAt\) return rien;/.test(adoption));

  /**
   * Le projet propriétaire vient du LIEN de la session, jamais des metadata.
   * On vérifie que la seule affectation de `projectId` en découle.
   */
  check('le propriétaire vient du lien de session',
    /const projectId = lienSession\.projectId;/.test(adoption));
  check('…et les metadata ne servent qu’à comparer',
    /claimMismatch = Boolean\(revendique && revendique !== projectId\)/.test(adoption));
}

/* ========================================================================== */
section('16. AUCUN ABONNEMENT N’EST CRÉÉ NI MUTÉ PAR NOUS (L6.2F)');
/* ========================================================================== */
{
  /**
   * Stripe crée les abonnements au paiement ; c'est ce fait qui rend l'adoption
   * nécessaire. Le jour où le transport saurait en créer un, l'adoption
   * cesserait d'être la seule voie — et la doctrine tomberait sans bruit.
   *
   * Les résiliations sont explicitement reportées à L6.2G : le transport ne doit
   * pas non plus savoir muter un abonnement tant que cette écriture n'a pas sa
   * propre stratégie d'idempotence et de convergence.
   */
  check('le transport ne sait pas CRÉER d’abonnement',
    !/path: '\/v1\/subscriptions'/.test(transport));
  /**
   * On isole les ÉCRITURES ciblant un abonnement précis. La lecture (`GET`) est
   * au contraire indispensable — c'est elle qui sert `billing.subscription.
   * retrieve` — et la confondre avec une mutation rendrait ce contrôle inutile.
   */
  const versAbonnement = [...transport.matchAll(/method: '(\w+)', path: `\/v1\/subscriptions\/\$\{[^`]*`/g)]
    .map((m) => m[1]);
  const ecrituresAbo = versAbonnement.filter((m) => m !== 'GET');
  /**
   * DEUX écritures ciblées depuis L6.2G, et deux seulement : le drapeau de fin
   * de période (`POST`) et la coupure immédiate (`DELETE`). Aucune autre mutation
   * d'abonnement n'a de raison d'exister — pas de changement de tarif, pas de
   * reprise, pas de pause. Le compte exact est l'invariant : il rend visible
   * toute écriture ajoutée sans stratégie de convergence.
   */
  check('…et deux écritures ciblées, les deux résiliations de L6.2G',
    ecrituresAbo.length === 2 && ecrituresAbo.includes('POST') && ecrituresAbo.includes('DELETE'));
  check('…la lecture, elle, existe bien', versAbonnement.includes('GET'));
  check('il sait en revanche en LIRE un', /export async function retrieveSubscription/.test(transport));
}

/* ========================================================================== */
section('17. LE PROJET NE LIT PLUS D’ABONNEMENT LOCALEMENT (SB Auto)');
/* ========================================================================== */
{
  const voisin = path.resolve(RACINE, '..', 'SB Auto 06', 'backend', 'src', 'services');
  if (!fs.existsSync(voisin)) {
    check('SB Auto absent — contrôle sauté proprement', true);
  } else {
    const abonnement = sansCommentaires(fs.readFileSync(path.join(voisin, 'subscription.service.js'), 'utf8'));

    check('aucune lecture locale d’abonnement',
      !/provider\.retrieveSubscription/.test(abonnement));
    check('…il demande la capacité', /readSubscriptionViaPanel/.test(abonnement));

    /**
     * LE REPLI PAR METADATA A DISPARU.
     *
     * `listSubscriptions` listait les abonnements d'un client et retenait celui
     * dont `metadata.contractId` correspondait : l'appartenance décidée par un
     * champ éditable, sur une liste demandée plus large que son dû. C'est
     * exactement ce que l'ownership remplace.
     */
    check('aucun listing d’abonnements', !/listSubscriptions/.test(abonnement));
    check('…et aucun rattachement par metadata',
      !/metadata\?\.contractId/.test(abonnement));

  }
}

/* ========================================================================== */
section('18. LA RÉSILIATION NE SE FAIT PLUS LOCALEMENT (L6.2G — SB Auto)');
/* ========================================================================== */
{
  const voisin = path.resolve(RACINE, '..', 'SB Auto 06', 'backend', 'src', 'services');
  if (!fs.existsSync(voisin)) {
    check('SB Auto absent — contrôle sauté proprement', true);
  } else {
    const contrat = sansCommentaires(fs.readFileSync(path.join(voisin, 'contract.service.js'), 'utf8'));
    const outils = sansCommentaires(fs.readFileSync(path.join(voisin, 'contractTestTools.service.js'), 'utf8'));
    const service = sansCommentaires(fs.readFileSync(path.join(voisin, 'stripe', 'stripe.service.js'), 'utf8'));

    /**
     * LOCAL_RUNTIME_SUBSCRIPTION_CANCELLATION_WRITES = 0.
     *
     * Les quatre appelants historiques passent désormais par la capacité. On le
     * lit sur les DEUX faces : plus aucune mutation locale, et la porte du
     * Panel effectivement empruntée.
     */
    for (const [nom, source] of [['contract.service', contrat], ['contractTestTools.service', outils]]) {
      check(`${nom} : aucune coupure locale`,
        !/(provider|stripeSvc|stripe)\.cancelSubscription(Now|AtPeriodEnd)/.test(source));
      check(`${nom} : la résiliation passe par le Panel`,
        /cancelSubscriptionViaPanel/.test(source));
    }

    /**
     * LE WRAPPER MORT A ÉTÉ SUPPRIMÉ, PAS SEULEMENT CONTOURNÉ.
     *
     * Un `cancelSubscriptionAtPeriodEnd` laissé en place sans appelant est une
     * invitation : le prochain développeur le trouve, l'appelle, et rouvre le
     * chemin local sans que rien ne l'en avertisse.
     */
    check('le wrapper local de résiliation à échéance a disparu',
      !/export (async )?function cancelSubscriptionAtPeriodEnd/.test(service));

    /**
     * LA COUPURE IMMÉDIATE RESTE la doctrine en TEST — ce lot déplace la porte,
     * il ne change pas la politique commerciale.
     */
    check('la doctrine « immédiate en TEST » est préservée',
      /CANCEL_NOW_CAPABILITY|mode: 'NOW'/.test(contrat));
  }
}

/* ========================================================================== */
section('19. ON NE COUPE JAMAIS SANS AVOIR LU L’ÉTAT (L6.2G — Panel)');
/* ========================================================================== */
{
  const adaptateurs = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeAdapters.js'));
  const transport = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeTransport.js'));
  const capacites = sansCommentaires(lire('backend/src/services/integratedApi/stripe/stripeCapabilities.js'));

  const bloc = adaptateurs.slice(adaptateurs.indexOf('async function cancelSubscription('));
  const corps = bloc.slice(0, bloc.indexOf('\n}\n') + 3);

  /**
   * L'ORDRE EST L'INVARIANT. Trois positions, dans cet ordre exact :
   *
   *   1. l'appartenance   — sinon la durée de réponse trahit l'existence
   *   2. la relecture     — sinon on rejoue une coupure que Stripe refusera
   *   3. la mutation      — et seulement si l'état dit qu'elle manque
   *
   * Une vérification présente mais mal placée ne protège de rien : c'est
   * pourquoi on compare des positions, et non des présences.
   */
  const posOwn = corps.indexOf('assertOwnedResource');
  const posLecture = corps.indexOf('retrieveSubscription');
  const posEtat = corps.indexOf('describeCancellationState');
  const posMutation = corps.indexOf('mutate(');
  check('l’appartenance est vérifiée en premier', posOwn > 0);
  check('…AVANT toute lecture chez Stripe', posLecture > posOwn);
  check('…l’état est qualifié après la lecture', posEtat > posLecture);
  check('…et la mutation vient en dernier', posMutation > posEtat);

  /** La convergence par l'état : un acte déjà inscrit est CONSTATÉ, jamais rejoué. */
  check('un acte déjà fait n’est jamais rejoué',
    /CANCELLATION_STATE\.ALREADY_DONE/.test(corps));
  check('…et l’incertitude ne devient pas une mutation',
    /INDETERMINATE/.test(corps) && /SUBSCRIPTION_STATE_UNREADABLE/.test(corps));

  /**
   * LE DÉFAUT DE L6.1, FERMÉ PAR LA STRUCTURE.
   *
   * `cancelSubscriptionNow` partait sans aucune clé d'idempotence. On vérifie
   * que le transport en EXIGE une, et qu'elle voyage jusqu'à l'en-tête.
   */
  const coupure = transport.slice(transport.indexOf('export async function cancelSubscriptionNow'), transport.indexOf('export async function cancelSubscriptionNow') + 800);
  check('la coupure immédiate reçoit une clé d’idempotence',
    /cancelSubscriptionNow\(\{[^}]*idempotencyKey/.test(coupure));
  const posFetch = coupure.indexOf('stripeFetch({');
  check('…et la transmet au transport',
    posFetch > 0 && coupure.indexOf('idempotencyKey', posFetch) > posFetch);
  /** …lequel en fait un en-tête. Sans ce dernier maillon, la clé mourrait ici. */
  check('…qui en fait l’en-tête Stripe',
    /'Idempotency-Key'\]?\s*=?\s*:?\s*idempotencyKey/.test(transport));

  /**
   * LE PROJET NE NOMME PAS L'ACTE. S'il le pouvait, il pourrait en fabriquer
   * deux — c'est-à-dire couper deux fois ce qui ne se coupe qu'une.
   */
  const contrat = capacites.slice(capacites.indexOf('subscriptionCancelInput'));
  check('le contrat d’entrée ne prend QUE l’abonnement',
    /subscriptionCancelInput = z\s*\.?\s*object\(\{\s*subscriptionId/.test(contrat.slice(0, 400)));
  check('…et il est strict', /\.strict\(\)/.test(contrat.slice(0, 600)));
  check('l’identité de l’acte est DÉRIVÉE par le Panel',
    /cancellationOperationId/.test(sansCommentaires(lire('backend/src/services/capabilities/capabilityRegistry.js'))));
}

finish();
