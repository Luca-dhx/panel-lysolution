// PASSERELLE DE CAPACITÉS — la mécanique, pièce par pièce (L3).
//
// Ce que cette suite prouve :
//
//   1. le registre est code-first, aligné avec L1 et L8 ;
//   2. l'autorité vient du jeton, jamais de la charge utile ;
//   3. l'ordre des refus est celui qui garantit « zéro appel fournisseur » ;
//   4. l'entrée est stricte : provider, environment et clés sont REFUSÉS ;
//   5. les identifiants ne sortent ni en réponse, ni en journal, ni en erreur ;
//   6. un délai dépassé n'est pas un échec constaté.
//
// L'E2E (capability-gateway-e2e) prouve la même chose par le pont réel ; ici on
// isole la mécanique pour que chaque refus soit attribuable à UNE cause.
import { existsSync } from 'node:fs';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const registry = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const errors = await import('../backend/src/services/capabilities/capabilityErrors.js');
const contextModule = await import('../backend/src/services/capabilities/invocationContext.js');
const adapters = await import('../backend/src/services/capabilities/providerAdapters.js');
const gateway = await import('../backend/src/services/capabilities/capabilityGateway.service.js');
const resolver = await import('../backend/src/services/capabilities/credentialResolver.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;

const { CAPABILITY_ERROR_CODES: CODES, CAPABILITY_OUTCOMES } = errors;

/** Sentinelle : une occurrence hors du coffre est une fuite, jamais un hasard. */
const SENTINELLE = 'xkeysib-GATEWAYSENTINEL00000000000000000001';
const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };

const VERIFY = 'email.sender.verify';
const SEND = 'email.send_template';
const CHECKOUT = 'billing.checkout.create';

/** Entrée valide minimale de `email.sender.verify`. */
const ENTREE = () => ({ recipient: { email: 'ops@garage.fr' }, operationId: 'op-0000000001' });

/**
 * Fiche de projet AUTHENTIFIÉE — ce que rend `requireBridgeAuth`.
 *
 * Elle ne porte plus ni `capabilityGrants` ni `commercialState` : les deux
 * champs ont quitté le schéma. Une fiche minimale — appairée, avec un
 * environnement — suffit désormais à invoquer, et c'est précisément ce que la
 * simplification voulait obtenir.
 */
async function projet({ projectId, environment = 'TEST' } = {}) {
  const at = new Date().toISOString();
  const record = {
    projectId,
    projectKey: projectId,
    projectName: `Projet ${projectId}`,
    createdAt: at,
    updatedAt: at,
    pairing: { status: 'PAIRED', bridgeTokenHash: 'h', pairedAt: at },
    runtime: { environment },
  };
  await registryStore.remove(projectId);
  await registryStore.insert(record);
  return registryStore.getById(projectId);
}

/** Faux fournisseur : compte les appels, et rend ce qu'on lui dit. */
function fournisseur(handler) {
  const appels = [];
  const impl = async (url, options) => {
    appels.push({ url, apiKey: options?.headers?.['api-key'] ?? null });
    return handler(url, options);
  };
  impl.appels = appels;
  return impl;
}

const reponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body ?? {}),
});

async function invoquer(fiche, code, payload, fetchImpl) {
  try {
    const data = await gateway.invokeCapability({
      code, panelProject: fiche, payload, fetchImpl,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, code: err?.code ?? null, error: err };
  }
}

await seedIntegratedApiCredentialSets();

/* ========================================================================== */
section('1. REGISTRE — code-first, et aligné avec les trois autorités');
/* ========================================================================== */
{
  const problemes = registry.assertRegistryAlignment();
  check(`alignement L1 × L8 (${problemes.length} écart(s))`, problemes.length === 0);
  problemes.forEach((p) => console.error(`      · ${p}`));

  const adapt = adapters.assertAdapterAlignment(registry.listCapabilityDefinitions());
  check(`adaptateurs ↔ registre (${adapt.length} écart(s))`, adapt.length === 0);
  adapt.forEach((p) => console.error(`      · ${p}`));

  check('le registre est gelé', Object.isFrozen(registry.CAPABILITY_DEFINITIONS));
  const avant = registry.CAPABILITY_CODES.length;
  try { registry.CAPABILITY_DEFINITIONS['pwn.everything'] = {}; } catch { /* strict */ }
  check('aucune capacité ne s’ajoute à chaud',
    Object.keys(registry.CAPABILITY_DEFINITIONS).length === avant);

  /**
   * L'INVENTAIRE DES CAPACITÉS SERVIES — nommé, donc surveillé.
   *
   * Cette ligne disait « une seule, et c'est la lecture Brevo ». C'était vrai
   * au lot L3 et c'est devenu faux au lot L9.1, qui en a migré trois autres.
   * Compter n'était pas le bon contrôle : un compte à jour ne dit pas LESQUELLES
   * sont servies, et une capacité migrée par erreur passerait inaperçue tant
   * qu'une autre serait retirée le même jour.
   *
   * On énumère donc. Toute migration future fait rougir cette ligne — c'est
   * exactement ce qu'on veut d'un chemin qui atteint un fournisseur réel.
   */
  const SERVIES = [
    // L8.2 — la lecture Brevo, première capacité réellement basculée.
    VERIFY,
    // L8.4B — l'ENVOI, et seulement parce que le chemin retour existe : les
    // webhooks de livraison suivent le compte Brevo, donc le Panel. L'activer
    // sans `emailDeliveryDispatch` aurait figé chaque suivi sur « envoyé ».
    SEND,
    // L9.1 — les trois verbes DNS d'un déploiement.
    'dns.zone.resolve', 'dns.records.read', 'dns.record.ensure',
    // L6.2B — la PREMIÈRE écriture financière servie. Elle ne consomme aucun
    // objet Stripe préexistant : elle en crée un, et le lie aussitôt.
    CHECKOUT,
    // L6.2C — sa LECTURE, première capacité dont l'autorisation repose sur une
    // appartenance prouvée plutôt que sur le seul octroi.
    'billing.checkout.retrieve',
    // L6.2D — le CLIENT d'un contrat, dont l'identité d'acte est dérivée par le
    // Panel au lieu d'être nommée. L6.2E — son TARIF, même doctrine.
    'billing.customer.ensure',
    'billing.price.ensure',
    // L6.2F — la lecture d'un abonnement, servie parce qu'il est ADOPTABLE.
    'billing.subscription.retrieve',
    // L6.2G — les deux RÉSILIATIONS. Elles ferment le seul défaut d'idempotence
    // qui restait dans le parc : la coupure immédiate partait sans clé, et
    // possédait plusieurs appelants.
    'billing.subscription.cancel_at_period_end',
    'billing.subscription.cancel_now',
    /**
     * L10.4 — LA PREMIÈRE CAPACITÉ SERVIE QUI NE MIGRE AUCUN CODE EXISTANT.
     *
     * Toutes les autres ont repris un appel qu'un projet faisait déjà. Celle-ci
     * n'en remplace aucun : son appelant est le Panel lui-même, en source
     * `PANEL_INTERNAL`, depuis l'onglet Finances d'un projet.
     */
    'billing.refund',
    /**
     * L6.3A — LE PROVISIONNEMENT DE L'ENDPOINT WEBHOOK DU PROJET.
     *
     * La seule capacité Stripe qui ne touche pas à l'argent : elle garantit le
     * CHEMIN par lequel le projet apprend que de l'argent a bougé. Sans elle, le
     * projet devait garder une clé d'API pour enregistrer sa propre adresse —
     * donc le pouvoir d'appeler Stripe pour tout le reste.
     */
    'webhook.endpoint.ensure',
    /**
     * L6.3B — LES TROIS VERBES QUI FERMENT LA SURFACE LOCALE DU PROJET.
     *
     * Ils ne migrent aucun parcours financier de plus : ils retirent au projet
     * ses dernières LECTURES Stripe et son écran de portail. C'est ce qui
     * rendra possible, au lot suivant, de lui retirer sa clé.
     */
    'billing.invoice.list',
    'billing.invoice.retrieve',
    'billing.portal.create',
    /**
     * R10.5C — LES CINQ ACTES DE SIGNATURE.
     *
     * Cinq, et non onze : l’API Yousign expose onze endpoints, mais ouvrir une
     * signature suppose d’en enchaîner cinq (demande, document, signataires,
     * champs, activation). Les exposer séparément aurait laissé un projet
     * s’arrêter au milieu d’une préparation — précisément l’état que le
     * tout-ou-rien s’échine à ne jamais rendre observable.
     *
     * Ce sont aussi les premières capacités dont l’appartenance repose sur un
     * lien écrit AVANT l’appel fournisseur, et non sur une metadata rendue par
     * lui.
     */
    'signature.request.open',
    'signature.request.retrieve',
    'signature.signer.retrieve',
    'signature.document.download',
    'signature.request.cancel',
  ].sort();
  /**
   * DÉCLARÉES ET SERVIES SONT DÉSORMAIS LA MÊME LISTE.
   *
   * Cette assertion comparait `listMigratedCapabilities()` — les capacités
   * portant `migrated: true` — à la liste attendue. Le booléen ayant disparu,
   * elle compare l'INVENTAIRE COMPLET : figurer au registre, c'est être servie.
   *
   * `billing.subscription.reconcile` a quitté cette liste sans y être
   * remplacée : elle était déclarée et servie par personne.
   */
  check(`les capacités servies sont EXACTEMENT les ${SERVIES.length} attendues`,
    JSON.stringify(registry.listCapabilityDefinitions().map((c) => c.code).sort())
    === JSON.stringify(SERVIES));
  check('aucune capacité ne porte de drapeau de migration',
    registry.listCapabilityDefinitions().every((c) => !('migrated' in c) && !('migrationNote' in c)));
  /**
   * Son idempotence reste `UNKNOWN_ON_TIMEOUT`, et c'est ce qui déclenche la
   * réservation au goulot de la passerelle : Brevo n'offre aucune clé sur
   * `/smtp/email`, donc son silence laisse l'envoi indécidable.
   */
  check('…avec une idempotence qui exige une réservation',
    registry.getCapabilityDefinition(SEND).idempotency === 'UNKNOWN_ON_TIMEOUT');
  /**
   * DOUZE capacités Stripe, et plus aucune « fermée ».
   *
   * La treizième — `billing.subscription.reconcile` — a été retirée du
   * registre. Elle s'ancrait sur un lien prouvé comme les autres ; ce qui lui
   * manquait, c'était un exécutant, et sa lecture est déjà couverte par
   * `billing.subscription.retrieve`.
   */
  const stripeServies = registry.capabilitiesForProvider('STRIPE');
  check('douze capacités Stripe sont servies', stripeServies.length === 12);
  /**
   * La huitième — le remboursement — s'ancre elle aussi sur un lien prouvé, et
   * par la même filiation : l'intention de paiement est adoptée à la projection
   * du revenu, depuis la session ou l'abonnement possédé qui l'a produite.
   */
  check('…dont le remboursement, ancré sur une intention adoptée (L10.4)',
    stripeServies.some((c) => c.code === 'billing.refund'));
  /**
   * QUATRE capacités dérivent leur identité d'acte : les deux `ensure` (L6.2D/E)
   * et les deux résiliations (L6.2G). Le point commun n'est pas le verbe, c'est
   * qu'UNE SEULE réponse est correcte — garantir un client, ou couper un
   * abonnement. Laisser le projet nommer l'acte lui permettrait d'en obtenir
   * deux, c'est-à-dire de couper deux fois ce qui ne se coupe qu'une.
   */
  const derivees = registry.listCapabilityDefinitions().filter((c) => c.deriveOperationId);
  check('quatre capacités dérivent leur identité d’acte', derivees.length === 4);
  check('…le client d’un contrat', derivees.some((c) => c.code === 'billing.customer.ensure'));
  check('…et son tarif', derivees.some((c) => c.code === 'billing.price.ensure'));
  const client = derivees.find((c) => c.code === 'billing.customer.ensure');
  check('…la dérivation est PURE (contexte + entrée, sans base)',
    client.deriveOperationId({ environment: 'TEST' }, { contractRef: 'c-1' })
    === 'stripe-customer:TEST:c-1');
  check('…et le monde en fait partie',
    client.deriveOperationId({ environment: 'PROD' }, { contractRef: 'c-1' })
    !== client.deriveOperationId({ environment: 'TEST' }, { contractRef: 'c-1' }));
  /**
   * Deux verbes distincts pour un même contrat ne doivent JAMAIS partager une
   * identité d'acte : le registre d'opérations les confondrait, et le second
   * verbe croirait converger vers la ressource du premier.
   */
  const tarif = derivees.find((c) => c.code === 'billing.price.ensure');
  check('…et deux verbes ne partagent pas une identité',
    tarif.deriveOperationId({ environment: 'TEST' }, { contractRef: 'c-1' })
    !== client.deriveOperationId({ environment: 'TEST' }, { contractRef: 'c-1' }));
  const creation = stripeServies.find((c) => c.code === CHECKOUT);
  const lecture = stripeServies.find((c) => c.code === 'billing.checkout.retrieve');
  check('…l’ouverture de session', Boolean(creation));
  check('…et sa lecture', Boolean(lecture));
  check('l’ÉCRITURE porte une idempotence fournisseur',
    creation?.idempotency === 'PROVIDER_IDEMPOTENT');
  check('…et une poignée de corrélation', creation?.correlationField === 'checkoutSessionId');
  /**
   * La LECTURE n'a ni l'une ni l'autre, et c'est le bon contrat : rejouer un
   * `GET` ne produit aucun second acte, donc rien à dédupliquer et aucun objet
   * à corréler. Lui imposer les deux obligerait à les inventer.
   */
  check('la LECTURE se rejoue sans conséquence', lecture?.idempotency === 'SAFE_RETRY');
  check('…et ne réserve donc aucune opération', lecture?.correlationField === null);

  /**
   * LA NATURE DE L'EFFET A DISPARU DU REGISTRE.
   *
   * Deux assertions vérifiaient ici que `effectNature` valait CONFIGURATION
   * pour la vérification Brevo et FINANCIAL_WRITE pour l'ouverture de session.
   * Cette taxinomie n'avait qu'un lecteur, la politique de pré-ouverture, et
   * disparaît avec elle. On vérifie donc l'inverse : qu'elle ne subsiste nulle
   * part, faute de quoi elle finirait par se voir rebrancher.
   */
  check('aucune capacité ne porte de nature d’effet',
    registry.listCapabilityDefinitions().every((c) => !('effectNature' in c)));
  check('…et la vue publique non plus',
    registry.describeCapabilities().every((c) => !('effectNature' in c) && !('migrated' in c)));

  // La vue publique ne doit rien apprendre du fournisseur.
  const vue = registry.describeCapability(VERIFY);
  check('la vue publique n’expose aucun chemin d’API',
    !JSON.stringify(vue).includes('/account') && !JSON.stringify(vue).includes('brevo.com'));
  check('capacité inconnue → null', registry.getCapabilityDefinition('pwn.everything') === null);
}

/* ========================================================================== */
section('2. CONTEXTE — l’autorité vient du jeton, pas du corps');
/* ========================================================================== */
{
  const fiche = await projet({ projectId: 'projet-a' });

  const ctx = contextModule.buildInvocationContext({ panelProject: fiche, payload: {} });
  check('projectId repris de la fiche authentifiée', ctx.projectId === 'projet-a');
  check('environnement pris sur le runtime du Panel', ctx.environment === 'TEST');
  check('un requestId est toujours posé', typeof ctx.requestId === 'string' && ctx.requestId.length > 10);

  // Redondance tolérée, divergence refusée : les deux ne se valent pas.
  const redondant = contextModule.buildInvocationContext({
    panelProject: fiche, payload: { projectId: 'projet-a' },
  });
  check('projectId redondant mais identique → accepté', redondant.projectId === 'projet-a');

  for (const champ of ['projectId', 'project_id', 'projectKey']) {
    let refus = null;
    try {
      contextModule.buildInvocationContext({ panelProject: fiche, payload: { [champ]: 'projet-b' } });
    } catch (err) { refus = err; }
    check(`« ${champ} » divergent → PROJECT_SCOPE_MISMATCH`,
      refus?.code === CODES.PROJECT_SCOPE_MISMATCH);
    check(`« ${champ} » divergent → 403`, refus?.statusCode === 403);
  }

  // La projection d'audit ne doit pas emporter la fiche (hachages d'appairage).
  const decrit = contextModule.describeContext(ctx);
  check('la projection d’audit ne porte pas la fiche', !('panelProject' in decrit));
  check('…et ne porte aucun hachage d’appairage', !JSON.stringify(decrit).includes('bridgeToken'));

  // Une fiche qui déclare l'autre monde est refusée, même authentifiée.
  const etranger = await projet({ projectId: 'projet-prod', environment: 'PROD' });
  let mismatch = null;
  try { contextModule.buildInvocationContext({ panelProject: etranger }); } catch (err) { mismatch = err; }
  check('fiche déclarant PROD sur un Panel TEST → ENVIRONMENT_MISMATCH',
    mismatch?.code === CODES.ENVIRONMENT_MISMATCH);

  // `null` = jamais parlé. Ce n'est pas un désaccord.
  const neuf = await projet({ projectId: 'projet-neuf', environment: null });
  check('fiche sans environnement déclaré → accepté, servi en TEST',
    contextModule.buildInvocationContext({ panelProject: neuf }).environment === 'TEST');

  /**
   * LE CONTEXTE NE PORTE PLUS D'ÉTAT D'OUVERTURE.
   *
   * Trois assertions vérifiaient ici que `commercialState` absent ou aberrant
   * retombait sur PREOPENING — le défaut fermé. La notion ayant disparu, ce
   * qu'on vérifie est qu'elle n'a laissé aucun résidu dans le contexte : un
   * champ survivant serait relu un jour, et sa valeur par défaut refermerait
   * silencieusement ce que la simplification vient d'ouvrir.
   */
  check('le contexte ne porte aucun état d’ouverture', !('commercialState' in ctx));
  check('…ni la projection d’audit', !('commercialState' in decrit));
  check('resolveCommercialState n’existe plus',
    contextModule.resolveCommercialState === undefined);

  /**
   * UNE FICHE NUE SUFFIT — c'est le cœur de la simplification.
   *
   * Ni octroi, ni état d'ouverture : un projet appairé, dont le monde concorde,
   * obtient un contexte d'invocation complet.
   */
  const nue = await projet({ projectId: 'projet-nu-context' });
  const ctxNu = contextModule.buildInvocationContext({ panelProject: nue, payload: {} });
  check('une fiche sans octroi ni état d’ouverture produit un contexte valide',
    ctxNu.projectId === 'projet-nu-context' && ctxNu.environment === 'TEST');
}

/* ========================================================================== */
section('3. AUCUN OCTROI — un projet appairé peut demander ce qui est servi');
/* ========================================================================== */
{
  /**
   * CETTE SECTION A CHANGÉ DE SENS, ET C'EST L'OBJET DE LA MISSION.
   *
   * Elle prouvait « fermé par défaut » : un projet appairé sans octroi recevait
   * `CAPABILITY_NOT_GRANTED`. Elle prouve désormais l'inverse — qu'aucune liste
   * ne conditionne l'invocation — et surtout que le refus qui la remplaçait
   * n'existe plus nulle part.
   *
   * Ce que la fermeture par défaut protégeait réellement — l'accès aux
   * ressources d'autrui — est éprouvé par
   * `capability-multi-project-isolation.test.js`, qui vise l'appartenance.
   */
  const nu = await projet({ projectId: 'projet-nu' });

  check('le module d’octrois n’existe plus',
    !existsSync(new URL('../backend/src/services/capabilities/capabilityGrants.js', import.meta.url)));
  check('le vocabulaire de refus ne porte plus NOT_GRANTED',
    CODES.NOT_GRANTED === undefined);
  check('…ni BLOCKED_PREOPENING', CODES.BLOCKED_PREOPENING === undefined);

  /**
   * L'APPEL TRAVERSE TOUTES LES GARDES D'AUTORISATION.
   *
   * Le coffre est encore vide à ce stade de la suite — il n'est peuplé qu'en
   * section 6 — donc l'invocation s'arrête aux identifiants. C'est précisément
   * ce qui rend cette assertion probante : `CREDENTIALS_MISSING` est la
   * DERNIÈRE étape de la passerelle, et l'atteindre prouve que rien en amont
   * n'a refusé. Avant la simplification, ce même appel mourait deux étapes plus
   * haut, sur `CAPABILITY_NOT_GRANTED`.
   *
   * La preuve POSITIVE — un projet nu qui exécute réellement chez le
   * fournisseur — est en section 6, une fois le coffre peuplé : la fiche `p6`
   * n'a elle non plus ni octroi ni état d'ouverture.
   */
  const provider = fournisseur(async () => reponse(200, { companyName: 'Garage Test' }));
  const passe = await invoquer(nu, VERIFY, ENTREE(), provider);
  check('un projet sans aucun octroi n’est plus refusé pour défaut de droit',
    passe.code !== 'CAPABILITY_NOT_GRANTED');
  check('…il traverse jusqu’à la dernière étape, le coffre',
    passe.code === CODES.CREDENTIALS_MISSING);
  check('…et aucun appel fournisseur n’est parti pour autant',
    provider.appels.length === 0);
}

/* ========================================================================== */
section('4. ORDRE DES REFUS — la garantie « zéro appel fournisseur »');
/* ========================================================================== */
{
  const provider = fournisseur(async () => reponse(200, { companyName: 'X' }));

  // Capacité inconnue : refusée avant même de lire la fiche.
  const inconnue = await invoquer(await projet({ projectId: 'p1' }), 'pwn.everything', {}, provider);
  check('capacité inconnue → CAPABILITY_UNKNOWN', inconnue.code === CODES.UNKNOWN);
  check('…et un 404', inconnue.error.statusCode === 404);
  check('…sans avoir touché le fournisseur', provider.appels.length === 0);

  /**
   * LA CAPACITÉ RETIRÉE EST DÉSORMAIS INCONNUE, ET NON « INDISPONIBLE ».
   *
   * `billing.subscription.reconcile` répondait `CAPABILITY_NOT_AVAILABLE` avec
   * le motif `NOT_MIGRATED` : elle EXISTAIT au registre, et refusait. C'était
   * l'état « déclarée, mais pas servie » que la mission devait supprimer.
   *
   * Elle ne figure plus nulle part, donc le refus change de nature — c'est le
   * même que pour un code inventé. C'est exactement ce qu'on voulait : pas
   * d'état intermédiaire entre « exposée et servie » et « inexistante ».
   */
  const retiree = await invoquer(
    await projet({ projectId: 'p3b' }), 'billing.subscription.reconcile', {}, provider,
  );
  check('la capacité retirée → CAPABILITY_UNKNOWN (et non NOT_AVAILABLE)',
    retiree.code === CODES.UNKNOWN);
  check('…et aucun motif NOT_MIGRATED ne subsiste',
    retiree.error.details?.reason !== 'NOT_MIGRATED');

  /**
   * L'ÉCRITURE FINANCIÈRE DESCEND JUSQU'AU CONTRAT D'ENTRÉE.
   *
   * Elle était refusée en amont par la pré-ouverture, avec
   * `BLOCKED_PREOPENING`, tant qu'un opérateur n'avait pas basculé la fiche en
   * LIVE. Ce refus n'existe plus : l'appel atteint la validation d'entrée, et
   * c'est elle — puis l'appartenance, vérifiée par l'adaptateur — qui décide.
   */
  const financiere = await invoquer(await projet({ projectId: 'p2' }), CHECKOUT, {}, provider);
  check('écriture financière → plus aucun refus d’ouverture commerciale',
    financiere.code === CODES.INPUT_INVALID);
  check('…et toujours zéro appel fournisseur sur une entrée invalide',
    provider.appels.length === 0);

  check('AUCUN appel fournisseur sur tous ces refus', provider.appels.length === 0);
}

/* ========================================================================== */
section('5. ENTRÉE STRICTE — le projet ne choisit ni monde ni fournisseur');
/* ========================================================================== */
{
  const provider = fournisseur(async () => reponse(200, { companyName: 'X' }));
  const fiche = await projet({ projectId: 'p5' });

  const interdits = [
    ['environment', { ...ENTREE(), environment: 'PROD' }],
    ['mode', { ...ENTREE(), mode: 'PROD' }],
    ['provider', { ...ENTREE(), provider: 'STRIPE' }],
    ['apiKey', { ...ENTREE(), apiKey: SENTINELLE }],
    ['baseUrl', { ...ENTREE(), baseUrl: 'https://evil.test/v3' }],
    ['credentials', { ...ENTREE(), credentials: { apiKey: SENTINELLE } }],
  ];
  for (const [champ, payload] of interdits) {
    const r = await invoquer(fiche, VERIFY, payload, provider);
    check(`« ${champ} » dans l’entrée → CAPABILITY_INPUT_INVALID`, r.code === CODES.INPUT_INVALID);
  }

  const manquant = await invoquer(fiche, VERIFY, { recipient: { email: 'a@b.fr' } }, provider);
  check('operationId manquant → INPUT_INVALID', manquant.code === CODES.INPUT_INVALID);
  check('le diagnostic NOMME le chemin fautif',
    manquant.error.details?.issues?.some((i) => i.path === 'operationId'));
  // Un message d'erreur voyage : il ne doit jamais recopier la valeur reçue.
  check('…et ne recopie AUCUNE valeur reçue',
    !JSON.stringify(manquant.error.details).includes('a@b.fr'));

  const adresse = await invoquer(fiche, VERIFY, { recipient: { email: 'pas-une-adresse' }, operationId: 'op-0000000001' }, provider);
  check('adresse illisible → INPUT_INVALID', adresse.code === CODES.INPUT_INVALID);

  check('AUCUN appel fournisseur pour une entrée refusée', provider.appels.length === 0);
}

/* ========================================================================== */
section('6. IDENTIFIANTS — le coffre L1, et une doctrine de disponibilité');
/* ========================================================================== */
{
  const provider = fournisseur(async () => reponse(200, { companyName: 'L.Y Solution' }));
  const fiche = await projet({ projectId: 'p6' });

  // Le seed crée des jeux VIDES : leur existence ne prouve rien.
  const vide = await invoquer(fiche, VERIFY, ENTREE(), provider);
  check('jeu non configuré → CAPABILITY_CREDENTIALS_MISSING', vide.code === CODES.CREDENTIALS_MISSING);
  check('…motif NOT_CONFIGURED', vide.error.details?.reason === 'NOT_CONFIGURED');

  // Configuré mais jamais testé : on refuse quand même. Une clé jamais prouvée
  // peut être une faute de frappe, et l'erreur sortirait alors chez Brevo.
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: SENTINELLE, baseUrl: 'https://faux-brevo.test/v3' },
  }, ACTEUR);
  const nonValide = await invoquer(fiche, VERIFY, ENTREE(), provider);
  check('jeu configuré mais non validé → CREDENTIALS_MISSING', nonValide.code === CODES.CREDENTIALS_MISSING);
  check('…motif NOT_VALIDATED', nonValide.error.details?.reason === 'NOT_VALIDATED');

  // On valide par le VRAI chemin du plan de contrôle (L1), fournisseur simulé.
  await controlPlane.validateCredentialSet('BREVO', 'TEST', {
    actor: ACTEUR,
    fetchImpl: async () => reponse(200, { companyName: 'L.Y Solution', email: 'ops@ly.fr' }),
  });

  const succes = await invoquer(fiche, VERIFY, ENTREE(), provider);
  check('jeu VALID → la capacité s’exécute', succes.ok === true);
  check('…issue SUCCEEDED', succes.data.outcome === CAPABILITY_OUTCOMES.SUCCEEDED);
  check('…et le constat métier est rendu', succes.data.result.reachable === true);
  check('…avec le nom public du compte', succes.data.result.accountLabel === 'L.Y Solution');
  check('…et l’operationId est rendu au projet', succes.data.operationId === 'op-0000000001');

  // LE point : c'est bien LA clé du coffre qui est partie, et l'URL du coffre.
  check('l’adaptateur a reçu la clé du COFFRE', provider.appels.at(-1).apiKey === SENTINELLE);
  check('…et l’URL de base du coffre', provider.appels.at(-1).url === 'https://faux-brevo.test/v3/account');

  // Une clé remplacée après validation retire la preuve : on refuse.
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: 'xkeysib-UNEAUTRECLENONVALIDEE000000000000' },
  }, ACTEUR);
  const perimee = await invoquer(fiche, VERIFY, ENTREE(), provider);
  check('clé remplacée après validation → refusé', perimee.code === CODES.CREDENTIALS_MISSING);

  // On remet l'état valide pour la suite.
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: SENTINELLE, baseUrl: 'https://faux-brevo.test/v3' },
  }, ACTEUR);
  await controlPlane.validateCredentialSet('BREVO', 'TEST', {
    actor: ACTEUR, fetchImpl: async () => reponse(200, { companyName: 'L.Y Solution' }),
  });
}

/* ========================================================================== */
section('7. AUCUN SECRET NE SORT — réponse, journal, erreur');
/* ========================================================================== */
{
  const fiche = await projet({ projectId: 'p7' });
  const journal = [];
  const original = console.log;
  console.log = (...args) => { journal.push(args.join(' ')); };
  let succes;
  try {
    succes = await invoquer(fiche, VERIFY, ENTREE(),
      fournisseur(async () => reponse(200, { companyName: 'L.Y Solution' })));
  } finally {
    console.log = original;
  }

  const rendu = JSON.stringify(succes.data);
  check('aucune clé dans la réponse', !rendu.includes(SENTINELLE) && !rendu.includes('xkeysib-'));
  check('aucune URL de fournisseur dans la réponse', !rendu.includes('faux-brevo.test'));
  check('aucun secret dans le journal',
    !journal.join('\n').includes(SENTINELLE) && !/xkeysib-/.test(journal.join('\n')));
  check('le journal porte bien la capacité et l’environnement',
    journal.join('\n').includes(VERIFY) && journal.join('\n').includes('TEST'));
  check('…et l’identifiant de requête, pour le support',
    journal.join('\n').includes(succes.data.requestId));

  // Le fournisseur écho la clé dans son erreur : elle ne doit pas ressortir.
  const bavard = await invoquer(fiche, VERIFY, ENTREE(),
    fournisseur(async () => reponse(401, { message: `Key ${SENTINELLE} rejected` })));
  check('fournisseur 401 → CAPABILITY_PROVIDER_UNAVAILABLE', bavard.code === CODES.PROVIDER_UNAVAILABLE);
  check('…et le message du fournisseur n’est PAS relayé',
    !bavard.error.message.includes(SENTINELLE) && !bavard.error.message.includes('rejected'));
  check('…seul son statut HTTP est conservé', bavard.error.details?.httpStatus === 401);
}

/* ========================================================================== */
section('8. ÉCHECS FOURNISSEUR — et le silence, qui n’est pas un échec');
/* ========================================================================== */
{
  const fiche = await projet({ projectId: 'p8' });

  for (const status of [400, 401, 403, 429, 500, 503]) {
    const r = await invoquer(fiche, VERIFY, ENTREE(),
      fournisseur(async () => reponse(status, { message: 'non' })));
    check(`fournisseur ${status} → PROVIDER_UNAVAILABLE`, r.code === CODES.PROVIDER_UNAVAILABLE);
    check(`fournisseur ${status} → issue FAILED`, r.error.outcome === CAPABILITY_OUTCOMES.FAILED);
  }

  // Délai dépassé : l'action a PEUT-ÊTRE eu lieu. Le dire est tout l'enjeu.
  const abandon = await invoquer(fiche, VERIFY, ENTREE(), fournisseur(async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }));
  check('délai dépassé → CAPABILITY_TIMEOUT', abandon.code === CODES.TIMEOUT);
  check('…issue UNKNOWN, jamais FAILED', abandon.error.outcome === CAPABILITY_OUTCOMES.UNKNOWN);
  check('…et le rejeu n’est PAS déclaré sûr', abandon.error.replaySafe === false);
  check('…504, pour que le projet distingue « il n’a rien dit »', abandon.error.statusCode === 504);

  // Réseau coupé : même raisonnement.
  const coupe = await invoquer(fiche, VERIFY, ENTREE(),
    fournisseur(async () => { throw new TypeError('fetch failed'); }));
  check('réseau coupé → issue UNKNOWN', coupe.error.outcome === CAPABILITY_OUTCOMES.UNKNOWN);

  // Un refus ordinaire, lui, est rejouable sans risque.
  const refus = await invoquer(fiche, VERIFY, ENTREE(),
    fournisseur(async () => reponse(500, { message: 'oops' })));
  check('un 500 reste rejouable sans risque de doublon', refus.error.replaySafe === true);

  // Réponse hors contrat de NOTRE adaptateur : on ne la rend pas.
  const horsContrat = await invoquer(fiche, VERIFY, ENTREE(),
    fournisseur(async () => reponse(200, { compagnie: 'inattendue' })));
  check('2xx exploitable → toujours un constat conforme', horsContrat.ok === true);
  check('…et le constat ne porte que les champs du contrat',
    Object.keys(horsContrat.data.result).sort().join(',') === 'accountLabel,checkedAt,provider,reachable');
}

/* ========================================================================== */
section('9. IDEMPOTENCE — une stratégie par capacité, jamais une seule');
/* ========================================================================== */
{
  const strategies = new Set(registry.listCapabilityDefinitions().map((c) => c.idempotency));
  check('plusieurs stratégies coexistent', strategies.size >= 3);
  check('la lecture Brevo est rejouable sans risque',
    registry.getCapabilityDefinition(VERIFY).idempotency === registry.IDEMPOTENCY.SAFE_RETRY);
  // Brevo n'offre aucune clé d'idempotence sur /smtp/email (audit L8 §7).
  check('l’envoi Brevo est UNKNOWN_ON_TIMEOUT',
    registry.getCapabilityDefinition(SEND).idempotency === registry.IDEMPOTENCY.UNKNOWN_ON_TIMEOUT);
  // Stripe, lui, déduplique côté fournisseur.
  check('les écritures Stripe sont PROVIDER_IDEMPOTENT',
    registry.getCapabilityDefinition(CHECKOUT).idempotency === registry.IDEMPOTENCY.PROVIDER_IDEMPOTENT);
  // Une demande de signature engage une personne réelle : jamais rejouée seule.
  check('l’ouverture de signature est UNKNOWN_ON_TIMEOUT',
    registry.getCapabilityDefinition('signature.request.open').idempotency
    === registry.IDEMPOTENCY.UNKNOWN_ON_TIMEOUT);
}

/* ========================================================================== */
section('10. ENVIRONNEMENT — résolu deux fois, jamais choisi');
/* ========================================================================== */
{
  const fiche = await projet({ projectId: 'p9' });
  const ctx = contextModule.buildInvocationContext({ panelProject: fiche });
  const definition = registry.getCapabilityDefinition(VERIFY);

  check('Brevo est à portée ENVIRONMENT → le monde du runtime',
    resolver.resolveCredentialEnvironment(ctx, definition) === 'TEST');

  // Hostinger est PANEL_GLOBAL : lui inventer un monde dédoublerait un compte.
  check('Hostinger (PANEL_GLOBAL) → aucun environnement',
    resolver.resolveCredentialEnvironment(ctx, registry.getCapabilityDefinition('dns.record.ensure')) === null);

  // Un contexte fabriqué qui prétendrait PROD est refusé par la seconde
  // résolution — défense en profondeur, et c'est elle qu'on éprouve ici.
  let divergent = null;
  try {
    resolver.resolveCredentialEnvironment({ ...ctx, environment: 'PROD' }, definition);
  } catch (err) { divergent = err; }
  check('contexte PROD sur un Panel TEST → ENVIRONMENT_MISMATCH',
    divergent?.code === CODES.ENVIRONMENT_MISMATCH);

  // Le jeu PROD existe dans le coffre et ne doit JAMAIS être atteint d'ici.
  await controlPlane.saveCredentialSet('BREVO', 'PROD', {
    values: { apiKey: 'xkeysib-CLEDEPRODUCTIONJAMAISATTEINTE0001' },
  }, ACTEUR);
  const provider = fournisseur(async () => reponse(200, { companyName: 'L.Y Solution' }));
  await invoquer(fiche, VERIFY, ENTREE(), provider);
  check('la clé PROD n’est jamais partie depuis un Panel TEST',
    provider.appels.every((a) => a.apiKey === SENTINELLE));
}

await stopMemoryMongo();
finish();
