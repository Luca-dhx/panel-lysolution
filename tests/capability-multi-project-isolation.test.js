// ISOLATION ENTRE PROJETS — ce qui protège vraiment, maintenant que les cases
// à cocher ont disparu.
//
// ── LA QUESTION À LAQUELLE CETTE SUITE RÉPOND ───────────────────────────────
//
// « Puisque tout projet appairé peut demander toutes les actions servies,
//   qu'est-ce qui empêche le projet A de rembourser le paiement du projet B ? »
//
// La réponse est : rien de ce qui a été supprimé. Les octrois répondaient à
// « ce projet peut-il demander CE VERBE ? » — une question qui ne regarde même
// pas la ressource visée. Un projet A à qui l'on avait coché `billing.refund`
// pouvait déjà, du point de vue de l'octroi, présenter le `pi_…` du projet B ;
// ce qui l'en empêchait était, déjà, l'APPARTENANCE.
//
// Cette suite éprouve donc l'appartenance, sur les quatre familles de
// ressources du parc, et vérifie qu'elle ne dépend d'aucun octroi.
//
// ── POURQUOI ELLE VISE LES AUTORITÉS, ET PAS SEULEMENT LA PASSERELLE ────────
//
// Un test qui passerait par `invokeCapability` prouverait que le refus tombe
// aujourd'hui. Il ne dirait pas POURQUOI, ni si une seule des quatre familles
// est réellement gardée. On interroge donc les autorités d'appartenance
// elles-mêmes — celles que les adaptateurs appellent — puis on vérifie qu'un
// adaptateur les invoque bien.
import { existsSync } from 'node:fs';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;
const stripeOwnership = await import('../backend/src/services/integratedApi/stripe/stripeResourceOwnership.js');
const stripeBinding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const dnsOwnership = await import('../backend/src/services/capabilities/resourceOwnership.js');
const signatureOwnership = await import('../backend/src/services/integratedApi/yousign/signatureOwnership.js');
const registry = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const stripeCatalogue = await import('../backend/src/services/integratedApi/stripe/stripeCapabilities.js');
const hostingerCatalogue = await import('../backend/src/services/integratedApi/hostinger/hostingerCapabilities.js');
const PanelProjectDestination = (await import('../backend/src/models/PanelProjectDestination.model.js')).default;

const { STRIPE_RESOURCE_KINDS, OWNERSHIP_CODES: STRIPE_CODES } = stripeOwnership;
const { OWNERSHIP_CODES: DNS_CODES } = dnsOwnership;

const PROJET_A = 'projet-a-isolation';
const PROJET_B = 'projet-b-isolation';

/**
 * Deux fiches NUES — c'est le cœur de la démonstration.
 *
 * Ni `capabilityGrants`, ni `commercialState` : les champs n'existent plus. Si
 * l'isolation dépendait d'eux, elle serait déjà tombée avant la première
 * assertion de cette suite.
 */
async function projet(projectId) {
  const at = new Date().toISOString();
  await registryStore.remove(projectId);
  await registryStore.insert({
    projectId,
    projectKey: projectId,
    projectName: `Projet ${projectId}`,
    createdAt: at,
    updatedAt: at,
    pairing: { status: 'PAIRED', bridgeTokenHash: 'h', pairedAt: at },
    runtime: { environment: 'TEST' },
  });
  return registryStore.getById(projectId);
}

const ficheA = await projet(PROJET_A);
const ficheB = await projet(PROJET_B);

/* ========================================================================== */
section('0. LE POINT DE DÉPART — deux fiches sans aucune autorisation stockée');
/* ========================================================================== */
{
  for (const [nom, fiche] of [['A', ficheA], ['B', ficheB]]) {
    check(`projet ${nom} — aucun octroi stocké`, fiche.capabilityGrants === undefined);
    check(`projet ${nom} — aucun état d’ouverture stocké`, fiche.commercialState === undefined);
    check(`projet ${nom} — appairé`, fiche.pairing.status === 'PAIRED');
  }
  check('le module d’octrois n’existe plus',
    !existsSync(new URL('../backend/src/services/capabilities/capabilityGrants.js', import.meta.url)));
}

/* ========================================================================== */
section('1. STRIPE — A ne peut pas atteindre le contrat de B');
/* ========================================================================== */
{
  /**
   * B possède un client, un abonnement et une intention de paiement. Ils sont
   * liés par le REGISTRE D'APPARTENANCE, la même autorité que celle qu'écrivent
   * les adaptateurs quand ils créent une ressource.
   */
  const ressources = [
    [STRIPE_RESOURCE_KINDS.CUSTOMER, 'cus_BBBBBBBBBBBBBB'],
    [STRIPE_RESOURCE_KINDS.SUBSCRIPTION, 'sub_BBBBBBBBBBBBBB'],
    [STRIPE_RESOURCE_KINDS.PAYMENT_INTENT, 'pi_BBBBBBBBBBBBBB'],
    [STRIPE_RESOURCE_KINDS.CHECKOUT_SESSION, 'cs_BBBBBBBBBBBBBB'],
  ];
  for (const [kind, resourceId] of ressources) {
    await stripeBinding.bindResource({
      projectId: PROJET_B, environment: 'TEST', resourceType: kind, resourceId,
    });
  }

  for (const [kind, resourceId] of ressources) {
    const pourB = await stripeOwnership.describeResourceOwnership({
      projectId: PROJET_B, environment: 'TEST', kind, resourceId,
    });
    check(`B accède à sa propre ressource ${kind}`, pourB.allowed === true);

    const pourA = await stripeOwnership.describeResourceOwnership({
      projectId: PROJET_A, environment: 'TEST', kind, resourceId,
    });
    check(`A est REFUSÉ sur la ressource ${kind} de B`, pourA.allowed === false);
    check(`…motif NOT_OWNED`, pourA.code === STRIPE_CODES.NOT_OWNED);
    /**
     * LE REFUS NE DOIT RIEN APPRENDRE.
     *
     * Nommer le propriétaire ferait de cette API un annuaire : on présenterait
     * des identifiants au hasard, et le refus dirait à qui ils appartiennent.
     */
    check(`…et ne nomme PAS le propriétaire réel`, pourA.boundProjectId === null);
  }

  /**
   * L'IDENTIFIANT INVENTÉ — le cas que la mission nomme explicitement :
   * « une ressource identifiée uniquement par un ID externe, sans validation
   * de ownership ».
   */
  const invente = await stripeOwnership.describeResourceOwnership({
    projectId: PROJET_A,
    environment: 'TEST',
    kind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
    resourceId: 'sub_JEVIENSDELINVENTER',
  });
  check('un identifiant Stripe inventé est REFUSÉ', invente.allowed === false);
  check('…motif NO_BINDING (le Panel ne le connaît pas)',
    invente.code === STRIPE_CODES.NO_BINDING);

  /** Un identifiant malformé est refusé AVANT toute interrogation. */
  const malforme = await stripeOwnership.describeResourceOwnership({
    projectId: PROJET_A,
    environment: 'TEST',
    kind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
    resourceId: 'cus_CONFUSION',
  });
  check('un « cus_ » présenté comme abonnement est REFUSÉ',
    malforme.code === STRIPE_CODES.MALFORMED_ID);

  /**
   * LE MONDE FAIT PARTIE DE L'APPARTENANCE.
   *
   * La ressource de B existe en TEST. Interrogée depuis PROD, elle n'est pas
   * « à quelqu'un d'autre » : elle n'existe pas dans ce monde-là, et agir
   * dessus reviendrait à toucher un objet de recette en production.
   */
  const autreMonde = await stripeOwnership.describeResourceOwnership({
    projectId: PROJET_B,
    environment: 'PROD',
    kind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
    resourceId: 'sub_BBBBBBBBBBBBBB',
  });
  check('B est REFUSÉ sur sa propre ressource depuis l’autre monde',
    autreMonde.allowed === false);

  /** Un lien RÉVOQUÉ n'autorise plus, sans libérer l'identifiant. */
  await stripeBinding.revokeBinding({
    environment: 'TEST',
    resourceType: STRIPE_RESOURCE_KINDS.CUSTOMER,
    resourceId: 'cus_BBBBBBBBBBBBBB',
    reason: 'test',
  });
  const revoque = await stripeOwnership.describeResourceOwnership({
    projectId: PROJET_B,
    environment: 'TEST',
    kind: STRIPE_RESOURCE_KINDS.CUSTOMER,
    resourceId: 'cus_BBBBBBBBBBBBBB',
  });
  check('un lien révoqué n’autorise plus B', revoque.allowed === false);
  const volApresRevocation = await stripeOwnership.describeResourceOwnership({
    projectId: PROJET_A,
    environment: 'TEST',
    kind: STRIPE_RESOURCE_KINDS.CUSTOMER,
    resourceId: 'cus_BBBBBBBBBBBBBB',
  });
  check('…et ne libère pas la ressource au profit de A',
    volApresRevocation.allowed === false);

  /** La variante levante — celle qu'un adaptateur appelle — refuse aussi. */
  let leve = null;
  try {
    await stripeOwnership.assertResourceOwnership({
      projectId: PROJET_A,
      environment: 'TEST',
      kind: STRIPE_RESOURCE_KINDS.PAYMENT_INTENT,
      resourceId: 'pi_BBBBBBBBBBBBBB',
    });
  } catch (err) { leve = err; }
  check('assertResourceOwnership LÈVE pour A', leve !== null);
  check('…avec un 403', leve?.statusCode === 403);
  check('…et son message ne nomme pas le projet B',
    !String(leve?.message ?? '').includes(PROJET_B));
}

/* ========================================================================== */
section('2. DNS — A ne peut pas manipuler le domaine de B');
/* ========================================================================== */
{
  const at = new Date().toISOString();
  await PanelProjectDestination.create({
    projectId: PROJET_B,
    destinationId: 'dest-b',
    environment: 'TEST',
    host: 'b.exemple.test',
    status: 'ACTIVE',
    announcedAt: at,
    createdAt: at,
    updatedAt: at,
  });

  const pourB = await dnsOwnership.describeHostnameOwnership(PROJET_B, 'b.exemple.test');
  check('B administre son propre nom d’hôte', pourB.allowed === true);

  const pourA = await dnsOwnership.describeHostnameOwnership(PROJET_A, 'b.exemple.test');
  check('A est REFUSÉ sur le nom d’hôte de B', pourA.allowed === false);
  check('…motif NO_DESTINATION (A n’en possède aucun)',
    pourA.code === DNS_CODES.NO_DESTINATION);

  /**
   * LA ZONE PARENTE N'EST PAS COUVERTE PAR UN SOUS-DOMAINE.
   *
   * C'est le refus qui compte le plus : c'est la ZONE, et non l'hôte, qui donne
   * le pouvoir. Un projet qui possède `b.exemple.test` et obtiendrait
   * `exemple.test` pourrait réécrire les enregistrements de tous les autres.
   */
  const zoneParente = await dnsOwnership.describeHostnameOwnership(PROJET_B, 'exemple.test');
  check('B ne peut PAS remonter à la zone parente', zoneParente.allowed === false);

  /** Un frère, en revanche, appartient à qui possède le parent — pas à B. */
  const frere = await dnsOwnership.describeHostnameOwnership(PROJET_B, 'autre.exemple.test');
  check('B ne peut PAS atteindre un domaine frère', frere.allowed === false);
  check('…motif NOT_OWNED', frere.code === DNS_CODES.NOT_OWNED);

  /** Un sous-domaine de ce que B possède reste bien à B. */
  const sousDomaine = await dnsOwnership.describeHostnameOwnership(PROJET_B, 'www.b.exemple.test');
  check('B administre ses propres sous-domaines', sousDomaine.allowed === true);
}

/* ========================================================================== */
section('3. SIGNATURE — A ne peut pas télécharger le document de B');
/* ========================================================================== */
{
  /**
   * B ouvre une demande de signature. Le lien est écrit AVANT l'appel au
   * fournisseur — c'est la doctrine du lot R10.5C : une réservation occupe la
   * place, et l'identifiant réel de Yousign la remplace à l'acceptation.
   */
  const RESOURCE_B = 'sr-BBBBBBBBBBBBBBBB';
  await signatureOwnership.claimSignatureRequest({
    projectId: PROJET_B,
    environment: 'TEST',
    contractRef: 'contrat-b',
    operationId: 'op-signature-b-0001',
  });
  await signatureOwnership.attachResource({
    operationId: 'op-signature-b-0001',
    resourceId: RESOURCE_B,
    documentId: 'doc-BBBBBBBBBBBBBBBB',
  });

  const pourB = await signatureOwnership.describeOwnership({
    projectId: PROJET_B, environment: 'TEST', resourceId: RESOURCE_B,
  });
  check('B accède à sa propre demande de signature', pourB.owned === true);

  const pourA = await signatureOwnership.describeOwnership({
    projectId: PROJET_A, environment: 'TEST', resourceId: RESOURCE_B,
  });
  check('A est REFUSÉ sur la signature de B', pourA.owned === false);
  /**
   * LE REFUS EST INDISCERNABLE D'UN IDENTIFIANT INCONNU pour le projet.
   *
   * Le code interne distingue `NOT_OWNED` de `UNKNOWN_RESOURCE` — notre journal
   * en a besoin — mais le lien lui-même n'est PAS rendu : sans quoi la capacité
   * deviendrait un oracle d'existence.
   */
  check('…et le lien du propriétaire n’est pas rendu', pourA.binding === null);
  check('…et le verdict ne nomme pas le projet B',
    !JSON.stringify(pourA).includes(PROJET_B));

  /** Une signature TEST n'est pas atteignable depuis PROD. */
  const autreMonde = await signatureOwnership.describeOwnership({
    projectId: PROJET_B, environment: 'PROD', resourceId: RESOURCE_B,
  });
  check('B est REFUSÉ sur sa signature depuis l’autre monde', autreMonde.owned === false);

  /** Un identifiant de signature inventé n'ouvre rien. */
  const invente = await signatureOwnership.describeOwnership({
    projectId: PROJET_A, environment: 'TEST', resourceId: 'sr-JEVIENSDELINVENTER',
  });
  check('un identifiant de signature inventé est REFUSÉ', invente.owned === false);
  check('…motif UNKNOWN_RESOURCE',
    invente.code === signatureOwnership.SIGNATURE_OWNERSHIP_CODES.UNKNOWN_RESOURCE);
}

/* ========================================================================== */
section('4. LE CONTRAT DU REGISTRE — l’appartenance est EXIGÉE, pas optionnelle');
/* ========================================================================== */
{
  /**
   * LA GARDE STRUCTURELLE, ET C'EST ELLE QUI SURVIT AUX LOTS SUIVANTS.
   *
   * Les sections précédentes prouvent que les autorités refusent. Celle-ci
   * prouve qu'AUCUNE capacité servie ne peut manipuler une ressource sans
   * passer par elles — y compris celles qu'on ajoutera demain.
   */
  for (const [code, definition] of Object.entries(stripeCatalogue.STRIPE_CAPABILITIES)) {
    if (!definition.resourceKind) continue;
    check(`${code} — exige la preuve d’appartenance`,
      definition.requiresResourceOwnership === true);
  }

  for (const [code, definition] of Object.entries(hostingerCatalogue.HOSTINGER_CAPABILITIES)) {
    check(`${code} — exige la preuve d’appartenance`,
      definition.requiresResourceOwnership === true);
  }

  /**
   * AUCUNE ENTRÉE NE PERMET DE DÉSIGNER UN AUTRE PROJET.
   *
   * L'appartenance ne servirait à rien si le projet pouvait dire QUI il est :
   * il lui suffirait de se présenter comme B. Les schémas sont `strict()`, donc
   * un champ d'identité y serait REFUSÉ — mais un champ qu'on aurait ajouté
   * délibérément passerait. On l'interdit ici, pour toutes les capacités.
   */
  const INTERDITS = ['projectId', 'project_id', 'projectKey', 'tenantId', 'ownerId'];
  for (const definition of registry.listCapabilityDefinitions()) {
    const shape = definition.inputSchema?._def?.schema?.shape
      ?? definition.inputSchema?.shape
      ?? {};
    for (const champ of INTERDITS) {
      check(`${definition.code} — « ${champ} » n’est pas une entrée`,
        !Object.hasOwn(shape, champ));
    }
  }
}

await stopMemoryMongo();
finish();
