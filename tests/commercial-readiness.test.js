// OUVERTURE COMMERCIALE — les invariants du lot L1.75.
//
// Le lot répond à une découverte de l'inventaire L1.5 : une instance
// techniquement en PROD avait été validée de bout en bout avec un Stripe de
// TEST. La capacité était utile ; le moyen (choisir le monde à la main) est
// précisément ce que L2 supprime.
//
// Ce fichier vérifie que le remplaçant ne réintroduit PAS le moyen supprimé.
// L'invariant central tient en une ligne :
//
//     l'ouverture commerciale ne choisit JAMAIS un environnement fournisseur.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv(); // ENV=TEST

const commercial = await import('../backend/src/services/integratedApi/commercialReadiness.js');
const {
  COMMERCIAL_STATE, COMMERCIAL_STATE_VALUES, DEFAULT_COMMERCIAL_STATE,
  EFFECT, CAPABILITY_EFFECTS, DECISION, COMMERCIAL_PREOPENING,
  canExecute, isAllowed, capabilitiesBlockedInPreopening, describePolicy,
} = commercial;

const environnement = await import('../backend/src/services/integratedApi/environment.js');
const registre = await import('../backend/src/services/integratedApi/providerRegistry.js');

section('TECHNICAL_ENVIRONMENT_IS_NOT_COMMERCIAL_READINESS');
{
  // Deux vocabulaires disjoints. S'ils se recouvraient, quelqu'un finirait par
  // écrire `commercialState === 'TEST'`.
  check('les états d’ouverture sont PREOPENING et LIVE',
    COMMERCIAL_STATE_VALUES.length === 2
    && COMMERCIAL_STATE_VALUES.includes('PREOPENING')
    && COMMERCIAL_STATE_VALUES.includes('LIVE'));
  check('aucun état d’ouverture ne s’appelle TEST ou PROD',
    !COMMERCIAL_STATE_VALUES.includes('TEST') && !COMMERCIAL_STATE_VALUES.includes('PROD'));
  check('le défaut est PREOPENING — fail closed',
    DEFAULT_COMMERCIAL_STATE === COMMERCIAL_STATE.PREOPENING);
}

section('COMMERCIAL_STATE_DOES_NOT_SELECT_PROVIDER_MODE');
{
  /**
   * L'invariant le plus important du lot, et il se vérifie sur la SIGNATURE
   * autant que sur le comportement : une fonction qui ne reçoit ni ne rend
   * d'environnement ne peut pas en choisir un.
   */
  const source = canExecute.toString();
  check('canExecute ne mentionne ni TEST ni PROD', !/['"](TEST|PROD)['"]/.test(source));
  check('…ni « environment »', !/environment/i.test(source));
  check('…ni « credential »', !/credential/i.test(source));
  check('…ni « baseUrl » ou « endpoint »', !/baseUrl|endpoint/i.test(source));

  // Et sur le résultat : aucune clé de sortie ne désigne un monde.
  for (const etat of COMMERCIAL_STATE_VALUES) {
    const r = canExecute({ capability: 'billing.refund', commercialState: etat });
    const clefs = Object.keys(r);
    check(`(${etat}) la décision ne rend aucun environnement`,
      !clefs.some((k) => /environment|mode|credential|provider/i.test(k)));
  }

  // Le module entier ne connaît aucun fournisseur nommé : la politique porte
  // sur des CAPACITÉS métier, pas sur des comptes.
  const module = describePolicy.toString() + JSON.stringify(describePolicy());
  check('la politique ne nomme aucun fournisseur',
    !/STRIPE|BREVO|YOUSIGN|HOSTINGER/.test(module));
}

section('PROD_PREOPENING_BLOCKS_REAL_PAYMENT');
{
  const preopening = COMMERCIAL_STATE.PREOPENING;

  for (const capacite of ['billing.checkout.create', 'billing.refund', 'billing.subscription.cancel_at_period_end']) {
    const r = canExecute({ capability: capacite, commercialState: preopening });
    check(`${capacite} est REFUSÉE en pré-ouverture`, r.decision === DECISION.BLOCKED_PREOPENING);
    check(`…avec le code canonique`, r.code === COMMERCIAL_PREOPENING);
    check(`…et l’effet nommé`, r.effect === EFFECT.FINANCIAL_WRITE);
  }

  const signature = canExecute({ capability: 'signature.request.create', commercialState: preopening });
  check('demander une signature est REFUSÉE en pré-ouverture',
    signature.decision === DECISION.BLOCKED_PREOPENING && signature.effect === EFFECT.LEGAL_WRITE);
}

section('La pré-ouverture n’est pas une coupure réseau');
{
  const preopening = COMMERCIAL_STATE.PREOPENING;
  // Une instance qu'on ne peut pas configurer serait contournée — et la
  // pré-ouverture deviendrait décorative.
  const permises = [
    ['billing.invoice.list', EFFECT.READ_ONLY],
    ['billing.subscription.reconcile', EFFECT.READ_ONLY],
    ['billing.customer.ensure', EFFECT.REVERSIBLE_EXTERNAL_WRITE],
    ['email.sender.verify', EFFECT.CONFIGURATION],
    ['email.send_template', EFFECT.COMMUNICATION_WRITE],
    ['signature.document.download', EFFECT.READ_ONLY],
    ['dns.record.ensure', EFFECT.INFRASTRUCTURE_WRITE],
  ];
  for (const [capacite, effet] of permises) {
    const r = canExecute({ capability: capacite, commercialState: preopening });
    check(`${capacite} reste AUTORISÉE`, r.decision === DECISION.ALLOWED && r.effect === effet);
  }
  check('la réinitialisation de mot de passe reste possible (envoi d’e-mail)',
    isAllowed({ capability: 'email.send_template', commercialState: preopening }));
  check('le déploiement reste possible (DNS)',
    isAllowed({ capability: 'dns.record.ensure', commercialState: preopening }));
}

section('LIVE autorise ce que la pré-ouverture refusait — et rien de plus');
{
  const live = COMMERCIAL_STATE.LIVE;
  for (const capacite of Object.keys(CAPABILITY_EFFECTS)) {
    check(`${capacite} est autorisée en LIVE`,
      canExecute({ capability: capacite, commercialState: live }).decision === DECISION.ALLOWED);
  }
  // LIVE n'ouvre rien d'inconnu : la table reste fermée.
  check('une capacité hors table reste refusée même en LIVE',
    canExecute({ capability: 'billing.wire_transfer', commercialState: live }).decision
    === DECISION.UNKNOWN_CAPABILITY);
}

section('FAIL CLOSED — l’inconnu ne vaut jamais autorisation');
{
  check('capacité inconnue → refus nommé',
    canExecute({ capability: 'inventee.action' }).decision === DECISION.UNKNOWN_CAPABILITY);
  check('état inconnu → refus nommé',
    canExecute({ capability: 'billing.invoice.list', commercialState: 'OUVERT' }).decision
    === DECISION.INVALID_STATE);
  check('état absent → défaut PREOPENING, donc paiement refusé',
    canExecute({ capability: 'billing.checkout.create' }).decision === DECISION.BLOCKED_PREOPENING);
  check('appel sans argument → refus, jamais une exception',
    canExecute().decision === DECISION.UNKNOWN_CAPABILITY);
  check('« TEST » n’est pas un état d’ouverture acceptable',
    canExecute({ capability: 'billing.refund', commercialState: 'TEST' }).decision
    === DECISION.INVALID_STATE);
}

section('INDÉPENDANCE DES DEUX DÉCISIONS — le contrat avec L2');
{
  /**
   * `environmentResolver.resolve()` et `commercialPolicy.canExecute()` doivent
   * pouvoir se tromper séparément. Ici : le runtime dit PROD, l'ouverture dit
   * non — et la première réponse ne bouge pas d'un iota.
   */
  const stripe = registre.getProviderDefinition('STRIPE');

  const mondeAvant = environnement.resolveIntegratedApiEnvironment({
    providerDefinition: stripe, runtimeEnvironment: 'PROD',
  });
  const refus = canExecute({
    capability: 'billing.checkout.create', commercialState: COMMERCIAL_STATE.PREOPENING,
  });
  const mondeApres = environnement.resolveIntegratedApiEnvironment({
    providerDefinition: stripe, runtimeEnvironment: 'PROD',
  });

  check('le runtime PROD résout le monde PROD', mondeAvant === 'PROD');
  check('l’ouverture refuse l’action', refus.decision === DECISION.BLOCKED_PREOPENING);
  check('PROD_PREOPENING_NEVER_SELECTS_TEST_PROVIDER — le monde reste PROD',
    mondeApres === 'PROD');

  const mondeLive = environnement.resolveIntegratedApiEnvironment({
    providerDefinition: stripe, runtimeEnvironment: 'PROD',
  });
  check('PROD_LIVE_SELECTS_PROD_PROVIDER', mondeLive === 'PROD'
    && canExecute({ capability: 'billing.checkout.create', commercialState: COMMERCIAL_STATE.LIVE })
      .decision === DECISION.ALLOWED);

  check('TEST_ALWAYS_SELECTS_TEST_PROVIDER',
    ['PREOPENING', 'LIVE'].every(() => environnement.resolveIntegratedApiEnvironment({
      providerDefinition: stripe, runtimeEnvironment: 'TEST',
    }) === 'TEST'));
}

section('MISSING_PROD_CREDENTIAL_NEVER_FALLS_BACK_TO_TEST');
{
  /**
   * L'ouverture commerciale ne doit jamais servir de porte de sortie à une
   * configuration incomplète. Le résolveur d'environnement ne connaît qu'un
   * refus, et il ne consulte pas l'ouverture.
   */
  const refuse = (fn, code) => { try { fn(); return false; } catch (e) { return e?.code === code; } };
  check('demander PROD depuis une instance TEST reste refusé',
    refuse(() => environnement.assertEnvironmentServed('PROD'),
      environnement.INTEGRATED_API_ENVIRONMENT_MISMATCH));
  check('…et le refus ne dépend d’aucun état d’ouverture',
    !/commercial|preopening|live/i.test(environnement.assertEnvironmentServed.toString()));
  check('aucun repli TEST n’existe dans le résolveur',
    !/fallback|repli.*TEST/i.test(environnement.resolveIntegratedApiEnvironment.toString()));
}

section('SITE_SUSPENSION_IS_NOT_PROVIDER_ENVIRONMENT');
{
  // Décision §4 : pas de troisième état. La suspension appartient à
  // `SiteStatus`, dont les sources sont TECHNICAL et CONTRACT.
  check('aucun état SUSPENDED dans l’ouverture commerciale',
    !COMMERCIAL_STATE_VALUES.includes('SUSPENDED'));
  check('aucune décision BLOCKED_SUSPENDED',
    !Object.values(DECISION).includes('BLOCKED_SUSPENDED'));
  /**
   * L'INTERBLOCAGE ÉVITÉ, en une assertion : `SiteStatus` se met à SUSPENDED
   * quand aucun contrat n'est honoré, et l'on en sort en PAYANT. Un SUSPENDED
   * commercial qui bloquerait le paiement rendrait la sortie impossible.
   */
  check('le paiement reste possible en LIVE — c’est lui qui lève une suspension contractuelle',
    isAllowed({ capability: 'billing.checkout.create', commercialState: COMMERCIAL_STATE.LIVE }));
}

section('HISTORICAL_PROD_TEST_PAYMENT_IS_EXPLAINED');
{
  /**
   * LE FAIT, tel que l'inventaire L1.5 l'a relevé dans `sbauto06_prod` :
   *
   *   Payment · status PAID · environment PROD · providerMode TEST · 2026-07-16
   *
   * Sous la doctrine cible, ce couple devient impossible : le monde suit le
   * runtime. Ce que la combinaison PERMETTAIT — valider une instance de
   * production sans débiter personne — est désormais porté par l'ouverture
   * commerciale, qui refuse l'action au lieu de changer de compte.
   */
  const historique = { environment: 'PROD', providerMode: 'TEST', status: 'PAID' };

  check('le couple historique est bien celui que L2 rendra impossible',
    historique.environment === 'PROD' && historique.providerMode === 'TEST');

  // Le remplaçant : même intention, autre moyen.
  const remplacant = canExecute({
    capability: 'billing.checkout.create',
    commercialState: COMMERCIAL_STATE.PREOPENING,
  });
  check('le remplaçant REFUSE l’action au lieu de changer de monde',
    remplacant.decision === DECISION.BLOCKED_PREOPENING);
  check('…et ne propose aucun mode de repli',
    remplacant.effect === EFFECT.FINANCIAL_WRITE && !('providerMode' in remplacant));
}

section('La politique est une table fermée, relisible');
{
  const policy = describePolicy();
  check('chaque capacité porte un effet connu',
    policy.capabilities.every((c) => Object.values(EFFECT).includes(c.effect)));
  check('chaque capacité dit si elle passe en pré-ouverture',
    policy.capabilities.every((c) => typeof c.allowedInPreopening === 'boolean'));
  check('les effets interdits sont FINANCIAL_WRITE et LEGAL_WRITE',
    policy.forbiddenEffectsInPreopening.length === 2
    && policy.forbiddenEffectsInPreopening.includes(EFFECT.FINANCIAL_WRITE)
    && policy.forbiddenEffectsInPreopening.includes(EFFECT.LEGAL_WRITE));

  const bloquees = capabilitiesBlockedInPreopening();
  check('4 capacités sont bloquées en pré-ouverture', bloquees.length === 4);
  check('…et ce sont bien les financières et la signature',
    bloquees.every((b) => [EFFECT.FINANCIAL_WRITE, EFFECT.LEGAL_WRITE].includes(b.effect)));

  check('la table est gelée', Object.isFrozen(CAPABILITY_EFFECTS));
  check('les capacités de la politique existent au catalogue du registre', (() => {
    const declarees = new Set(registre.listProviderDefinitions().flatMap((d) => d.capabilities));
    return Object.keys(CAPABILITY_EFFECTS).every((c) => declarees.has(c));
  })());
  check('…et toute capacité déclarée au registre a une politique', (() => {
    const declarees = registre.listProviderDefinitions().flatMap((d) => d.capabilities);
    return declarees.every((c) => Object.hasOwn(CAPABILITY_EFFECTS, c));
  })());
}

section('AUCUNE PERSISTANCE EN L1.75');
{
  // La notion est une primitive, pas encore un état stocké : le parc ne compte
  // aucune instance PROD vivante, donc personne à protéger aujourd'hui.
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(
    new URL('../backend/src/services/integratedApi/commercialReadiness.js', import.meta.url), 'utf8',
  );
  check('aucun modèle mongoose importé', !/mongoose|\.model\.js/.test(source));
  check('aucune écriture en base', !/save\(|updateOne|insertOne|findOne/.test(source));
  check('aucun branchement fournisseur', !/fetch\(|stripe|brevo|yousign/i.test(source.replace(/^\s*\/\/.*$/gm, '')));
}

finish();
