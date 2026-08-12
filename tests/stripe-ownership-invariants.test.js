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
section('8. LE CLIENT N’EST PAS UN SINGLETON DU PROJET (L6.2D)');
/* ========================================================================== */
{
  /**
   * CUSTOMER_OWNERSHIP_IS_NOT_PROJECT_SINGLETON.
   *
   * L'audit du parc établit la cardinalité RÉELLE : un client Stripe par
   * CONTRAT, pas par projet. Trois faits indépendants la prouvent — la clé
   * d'idempotence historique `customer-<contractId>-<mode>`, le stockage sur
   * `Contract.stripe.customerId`, et la lecture inverse de la facturation qui
   * suppose au plus un contrat par client.
   *
   * L'invariant se lit donc sur la DÉRIVATION de l'identité d'acte : elle doit
   * porter le contrat. Une dérivation qui porterait le projet fusionnerait les
   * historiques de facturation de contrats distincts.
   */
  check('l’identité d’acte du client porte le CONTRAT',
    /customerOperationId\(\{ environment, contractId \}\)/.test(autoriteClient));
  check('…et le MONDE', /stripe-customer:\$\{environment\}:\$\{contractId\}/.test(autoriteClient));
  check('…mais PAS le projet',
    !/stripe-customer:[^`]*projectId/.test(autoriteClient));

  /**
   * Et la recherche du client existant doit être faite PAR ACTE, jamais par
   * projet : `findBinding({projectId, resourceType: CUSTOMER})` rendrait le
   * premier client venu du projet, c'est-à-dire potentiellement celui d'un
   * autre contrat.
   */
  const debut = adaptateurs.indexOf('async function customerEnsure');
  check('la capacité existe', debut > 0);
  const corps = adaptateurs.slice(debut, adaptateurs.indexOf('\n}', debut));
  check('le client existant est cherché PAR ACTE', /findBindingByOperation/.test(corps));
  check('…et jamais par simple appartenance au projet',
    !/listOwnedResourceIds|findBinding\(\{[^}]*resourceType: CUSTOMER[^}]*\}\)/.test(corps));
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
  for (const terme of ['interval', 'amount', 'currency']) {
    check(`la clé du Price porte « ${terme} »`,
      new RegExp(`priceOperationId[\s\S]{0,300}\$\{${terme}`).test(autoriteTarif)
      || new RegExp(`\{ environment, contractId, interval, amount, currency \}`).test(autoriteTarif));
  }
  check('…et le monde', /stripe-price:\$\{environment\}/.test(autoriteTarif));
  check('…mais PAS la version du contrat',
    !/stripe-price:[^`]*version/i.test(autoriteTarif));

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
     * Le pilote garde `createCheckoutSession` : plus aucun parcours ne
     * l'appelle, mais on ne retire pas un pilote encore requis par d'autres
     * verbes (portail, résiliations, lectures).
     */
    const pilote = sansCommentaires(fs.readFileSync(path.join(voisin, 'stripe', 'stripe.provider.js'), 'utf8'));
    check('le pilote reste complet', /async createCheckoutSession/.test(pilote));
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
  check('…et une seule écriture ciblée : la résiliation différée de L6.1',
    ecrituresAbo.length === 1 && ecrituresAbo[0] === 'POST');
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

    // Les résiliations restent locales — périmètre assumé, pas un oubli.
    const contrat = sansCommentaires(fs.readFileSync(path.join(voisin, 'contract.service.js'), 'utf8'));
    check('les résiliations restent locales — L6.2G',
      /cancelSubscriptionAtPeriodEnd|cancelSubscriptionNow/.test(contrat));
  }
}

finish();
