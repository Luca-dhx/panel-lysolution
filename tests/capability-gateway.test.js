// PASSERELLE DE CAPACITÉS — la mécanique, pièce par pièce (L3).
//
// Ce que cette suite prouve :
//
//   1. le registre est code-first, aligné avec L1, L1.75 et L8 ;
//   2. l'autorité vient du jeton, jamais de la charge utile ;
//   3. l'ordre des refus est celui qui garantit « zéro appel fournisseur » ;
//   4. l'entrée est stricte : provider, environment et clés sont REFUSÉS ;
//   5. les identifiants ne sortent ni en réponse, ni en journal, ni en erreur ;
//   6. un délai dépassé n'est pas un échec constaté.
//
// L'E2E (capability-gateway-e2e) prouve la même chose par le pont réel ; ici on
// isole la mécanique pour que chaque refus soit attribuable à UNE cause.
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
const grantsModule = await import('../backend/src/services/capabilities/capabilityGrants.js');
const adapters = await import('../backend/src/services/capabilities/providerAdapters.js');
const gateway = await import('../backend/src/services/capabilities/capabilityGateway.service.js');
const resolver = await import('../backend/src/services/capabilities/credentialResolver.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const commercial = await import('../backend/src/services/integratedApi/commercialReadiness.js');
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

/** Fiche de projet AUTHENTIFIÉE — ce que rend `requireBridgeAuth`. */
async function projet({ projectId, grants = [], commercialState = 'LIVE', environment = 'TEST' } = {}) {
  const at = new Date().toISOString();
  const record = {
    projectId,
    projectKey: projectId,
    projectName: `Projet ${projectId}`,
    createdAt: at,
    updatedAt: at,
    pairing: { status: 'PAIRED', bridgeTokenHash: 'h', pairedAt: at },
    runtime: { environment },
    capabilityGrants: grants,
    commercialState,
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
  check(`alignement L1 × L1.75 × L8 (${problemes.length} écart(s))`, problemes.length === 0);
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
  ].sort();
  check(`les capacités servies sont EXACTEMENT les ${SERVIES.length} attendues`,
    JSON.stringify(registry.listMigratedCapabilities().map((c) => c.code).sort())
    === JSON.stringify(SERVIES));
  check('email.send_template est désormais SERVIE',
    registry.getCapabilityDefinition(SEND).migrated === true);
  /**
   * Son idempotence reste `UNKNOWN_ON_TIMEOUT`, et c'est ce qui déclenche la
   * réservation au goulot de la passerelle : Brevo n'offre aucune clé sur
   * `/smtp/email`, donc son silence laisse l'envoi indécidable.
   */
  check('…avec une idempotence qui exige une réservation',
    registry.getCapabilityDefinition(SEND).idempotency === 'UNKNOWN_ON_TIMEOUT');
  /**
   * SEPT capacités Stripe sont servies ; une seule reste fermée.
   * Ce n'est pas une étape de calendrier : `billing.invoice.list` demanderait
   * une liste plus large que son dû, et son appartenance ne se prouve pas objet
   * par objet. Les sept autres s'ancrent toutes sur un lien prouvé — par
   * création (L6.2B/D/E) ou par filiation (L6.2F).
   */
  const stripeServies = registry.capabilitiesForProvider('STRIPE').filter((c) => c.migrated);
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

  // L'effet vient de L1.75, jamais recopié ici.
  check('l’effet de email.sender.verify est CONFIGURATION',
    registry.getCapabilityDefinition(VERIFY).effectNature === commercial.EFFECT.CONFIGURATION);
  check('l’effet de billing.checkout.create est FINANCIAL_WRITE',
    registry.getCapabilityDefinition(CHECKOUT).effectNature === commercial.EFFECT.FINANCIAL_WRITE);

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

  // L'ouverture est FERMÉE par défaut : une base muette ne doit pas ouvrir.
  const sansEtat = await projet({ projectId: 'projet-muet', commercialState: null });
  check('commercialState absent → PREOPENING (fermé par défaut)',
    contextModule.resolveCommercialState(sansEtat) === commercial.DEFAULT_COMMERCIAL_STATE);
  check('commercialState aberrant → PREOPENING',
    contextModule.resolveCommercialState({ commercialState: 'OUVERT_LOL' })
    === commercial.DEFAULT_COMMERCIAL_STATE);
}

/* ========================================================================== */
section('3. OCTROIS — fermés par défaut, et une seule autorité');
/* ========================================================================== */
{
  const nu = await projet({ projectId: 'projet-nu', grants: [] });
  check('un projet appairé n’a AUCUN octroi par défaut', grantsModule.grantedCodes(nu).length === 0);

  const refus = await invoquer(nu, VERIFY, ENTREE());
  check('sans octroi → CAPABILITY_NOT_GRANTED', refus.code === CODES.NOT_GRANTED);
  check('…et le refus est un 403', refus.error.statusCode === 403);
  check('…et l’issue journalisée est BLOCKED', refus.error.outcome === CAPABILITY_OUTCOMES.BLOCKED);

  // Un code inconnu ne peut pas être stocké : l'écran ne peut pas mentir.
  let invalide = null;
  try { await grantsModule.setCapabilityGrants('projet-nu', ['pwn.everything'], ACTEUR); }
  catch (err) { invalide = err; }
  check('accorder une capacité inconnue → refusé', invalide?.code === 'PANEL_CAPABILITY_UNKNOWN');

  const apres = await grantsModule.setCapabilityGrants('projet-nu', [VERIFY, SEND], ACTEUR);
  check('deux capacités accordées', apres.granted.length === 2);
  check('…et les DEUX sont réellement effectives depuis L8.4B',
    apres.capabilities.filter((c) => c.effective).length === 2);

  // Remplacement, pas fusion : la liste se lit d'un coup d'œil.
  const reduit = await grantsModule.setCapabilityGrants('projet-nu', [VERIFY], ACTEUR);
  check('l’écriture REMPLACE la liste', reduit.granted.length === 1 && reduit.granted[0] === VERIFY);
}

/* ========================================================================== */
section('4. ORDRE DES REFUS — la garantie « zéro appel fournisseur »');
/* ========================================================================== */
{
  const provider = fournisseur(async () => reponse(200, { companyName: 'X' }));

  // Capacité inconnue : refusée avant même de lire la fiche.
  const inconnue = await invoquer(await projet({ projectId: 'p1', grants: [VERIFY] }), 'pwn.everything', {}, provider);
  check('capacité inconnue → CAPABILITY_UNKNOWN', inconnue.code === CODES.UNKNOWN);
  check('…et un 404', inconnue.error.statusCode === 404);

  // PRÉ-OUVERTURE × écriture financière : refusée AVANT la disponibilité et
  // AVANT le coffre. C'est la jonction L1.75 × L2 × L3.
  const ferme = await projet({ projectId: 'p2', grants: [CHECKOUT], commercialState: 'PREOPENING' });
  const bloque = await invoquer(ferme, CHECKOUT, {}, provider);
  check('PREOPENING × FINANCIAL_WRITE → BLOCKED_PREOPENING', bloque.code === CODES.BLOCKED_PREOPENING);
  check('…issue BLOCKED', bloque.error.outcome === CAPABILITY_OUTCOMES.BLOCKED);
  check('…et le détail NOMME l’effet refusé', bloque.error.details?.effect === commercial.EFFECT.FINANCIAL_WRITE);

  // La même capacité, commerce OUVERT (LIVE) : le refus devient « pas migrée ».
  // C'est la preuve que le blocage venait bien de la politique, pas du hasard.
  /**
   * `billing.checkout.create` est SERVIE depuis L6.2B : le refus qu'on lit ici
   * n'est donc plus « pas migrée » mais « entrée non conforme » — la preuve
   * porte quand même, et même mieux : le commerce ouvert a laissé l'appel
   * DESCENDRE jusqu'au contrat d'entrée, là où la pré-ouverture l'arrêtait
   * avant tout. C'est exactement ce qu'on voulait démontrer.
   */
  const ouvert = await projet({ projectId: 'p3', grants: [CHECKOUT], commercialState: 'LIVE' });
  const passe = await invoquer(ouvert, CHECKOUT, {}, provider);
  check('LIVE × FINANCIAL_WRITE → la politique ne bloque plus',
    passe.code !== CODES.BLOCKED_PREOPENING);
  check('…le refus vient désormais du contrat d’entrée', passe.code === CODES.INPUT_INVALID);

  // Et une capacité Stripe encore fermée refuse toujours par NOT_MIGRATED.
  /**
   * L6.3B a SERVI `billing.invoice.list` : cette sonde a donc changé de sujet.
   * `billing.subscription.reconcile` reste fermée — elle attend une stratégie
   * de rejeu, pas un calendrier — et sert désormais de témoin.
   */
  const ferme2 = await projet({ projectId: 'p3b', grants: ['billing.subscription.reconcile'], commercialState: 'LIVE' });
  const pasMigre = await invoquer(ferme2, 'billing.subscription.reconcile', {}, provider);
  check('LIVE × non migrée → CAPABILITY_NOT_AVAILABLE', pasMigre.code === CODES.NOT_AVAILABLE);
  check('…motif NOT_MIGRATED', pasMigre.error.details?.reason === 'NOT_MIGRATED');

  // Une capacité de communication n'est PAS bloquée en pré-ouverture : une
  // instance doit pouvoir envoyer la réinitialisation qui l'ouvrira.
  const comm = await projet({ projectId: 'p4', grants: [SEND], commercialState: 'PREOPENING' });
  const communication = await invoquer(comm, SEND, {}, provider);
  /**
   * LA POLITIQUE N'A PAS BOUGÉ — c'est l'ÉTAPE ATTEINTE qui a changé.
   *
   * Avant L8.4B, la capacité n'était pas servie : le refus tombait à l'étape
   * « est-ce migré ? », avant toute validation d'entrée. Elle l'est désormais,
   * donc un corps vide est refusé une étape PLUS LOIN — pour entrée invalide,
   * et non pour pré-ouverture.
   *
   * Ce que l'assertion prouve reste le même, et c'est le point : une capacité
   * de COMMUNICATION_WRITE n'est PAS bloquée par la pré-ouverture. Une
   * instance doit pouvoir envoyer la réinitialisation qui l'ouvrira.
   */
  check('PREOPENING × COMMUNICATION_WRITE n’est PAS bloqué par la politique',
    communication.code === CODES.INPUT_INVALID);

  check('AUCUN appel fournisseur sur tous ces refus', provider.appels.length === 0);
}

/* ========================================================================== */
section('5. ENTRÉE STRICTE — le projet ne choisit ni monde ni fournisseur');
/* ========================================================================== */
{
  const provider = fournisseur(async () => reponse(200, { companyName: 'X' }));
  const fiche = await projet({ projectId: 'p5', grants: [VERIFY] });

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
  const fiche = await projet({ projectId: 'p6', grants: [VERIFY] });

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
  const fiche = await projet({ projectId: 'p7', grants: [VERIFY] });
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
  const fiche = await projet({ projectId: 'p8', grants: [VERIFY] });

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
  check('la demande de signature est UNKNOWN_ON_TIMEOUT',
    registry.getCapabilityDefinition('signature.request.create').idempotency
    === registry.IDEMPOTENCY.UNKNOWN_ON_TIMEOUT);
}

/* ========================================================================== */
section('10. ENVIRONNEMENT — résolu deux fois, jamais choisi');
/* ========================================================================== */
{
  const fiche = await projet({ projectId: 'p9', grants: [VERIFY] });
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
