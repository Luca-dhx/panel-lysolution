// OUVERTURE COMMERCIALE — LE GESTE, ET SA JONCTION AVEC LA PASSERELLE (L3.1).
//
// ══ CE QUE CE FICHIER FERME ═════════════════════════════════════════════════
//
// L1.75 a défini la doctrine, L3 a branché la passerelle dessus — mais personne
// n'écrivait jamais l'état. Le champ existait, la passerelle le lisait, il
// valait éternellement `null` : une porte fermée dont on n'avait pas fabriqué
// la clé.
//
// On prouve ici le cycle complet, sur les VRAIS services :
//
//   PREOPENING → un geste DEV → contrôles → LIVE → la passerelle laisse passer
//   LIVE       → un geste DEV → PREOPENING → la passerelle refuse de nouveau
//
// ══ ET SURTOUT : CE QUE L'OUVERTURE NE FAIT PAS ═════════════════════════════
//
// Elle ne touche JAMAIS au monde fournisseur. L'environnement est relevé avant
// et après chaque bascule, et il ne bouge pas d'un caractère.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
/**
 * APRÈS le harnais, et AVANT tout import du backend : ce processus est une
 * instance de PRODUCTION.
 *
 * C'est indispensable ici. La passerelle refuse un projet dont l'environnement
 * ne concorde pas avec celui du Panel : éprouver « PROD + PREOPENING » depuis
 * un Panel de recette ne testerait que ce refus-là, et jamais l'ouverture
 * commerciale.
 *
 * Les identifiants de seed sont remplacés parce que `config/env.js` refuse de
 * démarrer en PROD avec ceux du développement — ce qui prouve, au passage,
 * qu'on est bien dans le monde qu'on prétend éprouver.
 */
process.env.ENV = 'PROD';
process.env.DB_PROD = 'panel_prod_commercial_runtime';
process.env.SEED_DEV_EMAIL = 'exploitation@ly-solution.test';
process.env.SEED_DEV_PASSWORD = 'commercial-runtime-2026-XyZ';

await startMemoryMongo();
await connectTestDatabase();

const service = await import('../backend/src/services/capabilities/commercialReadiness.service.js');
const commercial = await import('../backend/src/services/integratedApi/commercialReadiness.js');
const gateway = await import('../backend/src/services/capabilities/capabilityGateway.service.js');
const registry = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const errors = await import('../backend/src/services/capabilities/capabilityErrors.js');
const environmentModule = await import('../backend/src/services/integratedApi/environment.js');
const providerRegistry = await import('../backend/src/services/integratedApi/providerRegistry.js');
const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;
const { PanelEvent, EVENT_TYPES } = await import('../backend/src/models/PanelSupervision.model.js');

const { CAPABILITY_ERROR_CODES: CODES } = errors;
const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };

/** Compte les sorties fournisseur. Doit rester à zéro tant qu'on est fermé. */
let appelsFournisseur = 0;
const fournisseur = async () => {
  appelsFournisseur += 1;
  return { ok: true, status: 200, text: async () => JSON.stringify({}) };
};

/** Une capacité financière et une capacité légale, prises du registre réel. */
const FINANCIERE = registry.listCapabilityDefinitions()
  .find((c) => c.effectNature === commercial.EFFECT.FINANCIAL_WRITE)?.code;
const LEGALE = registry.listCapabilityDefinitions()
  .find((c) => c.effectNature === commercial.EFFECT.LEGAL_WRITE)?.code;

async function projet(projectId, {
  environment = 'PROD', paired = true, destination = true, commercialState = null,
} = {}) {
  const at = new Date().toISOString();
  await registryStore.remove(projectId);
  await registryStore.insert({
    projectId,
    projectKey: projectId,
    projectName: `Instance ${projectId}`,
    createdAt: at,
    updatedAt: at,
    pairing: paired ? { status: 'PAIRED', bridgeTokenHash: 'h', pairedAt: at } : { status: 'DECLARED' },
    runtime: { environment },
    capabilityGrants: [FINANCIERE, LEGALE].filter(Boolean),
    commercialState,
  });
  if (destination) {
    const destinations = await import('../backend/src/services/registry/projectDestination.service.js');
    await destinations.announceDestination({
      record: await registryStore.getById(projectId),
      urls: {
        website: `https://${projectId}.test`,
        manager: `https://manager.${projectId}.test`,
        backend: `https://api.${projectId}.test`,
      },
      source: 'PRESENTATION',
    });
  }
  return registryStore.getById(projectId);
}

async function invoquer(record, code) {
  try {
    await gateway.invokeCapability({ code, panelProject: record, payload: {}, fetchImpl: fournisseur });
    return { code: null };
  } catch (err) {
    return { code: err?.code ?? 'UNEXPECTED' };
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PROJECT_INSTANCE_IS_AUTHORITY — l’autorité a changé de camp, et on le dit');
{
  /**
   * La note de cadrage de L1.75 annonçait « stocké côté instance, projeté vers
   * le Panel ». L3 a tranché l'inverse, avec un argument plus fort : un projet
   * ne doit pas pouvoir DÉCLARER son propre droit de dépenser.
   *
   * Ce bloc verrouille la décision retenue — le Panel décide — et vérifie que
   * l'état n'entre jamais par une charge utile venue du projet.
   */
  const contexte = await import('../backend/src/services/capabilities/invocationContext.js');
  const record = await projet('p-autorite', { commercialState: 'PREOPENING' });

  const contextForge = contexte.buildInvocationContext({
    panelProject: record,
    // Le projet tente de s'ouvrir lui-même dans la charge utile.
    payload: { commercialState: 'LIVE', state: 'LIVE' },
  });
  check('un état envoyé par le projet est IGNORÉ',
    contextForge.commercialState === 'PREOPENING');

  const source = contexte.buildInvocationContext.toString();
  check('le contexte lit la fiche du Panel, jamais la charge utile',
    /panelProject/.test(source));
}

section('Persistance et transitions — aucune ouverture automatique');
{
  const record = await projet('p-cycle');
  const vue = service.describeCommercialReadiness(record);
  check('sans décision, l’état effectif est PREOPENING', vue.state === 'PREOPENING');
  check('…et la vue dit que personne n’a tranché', vue.neverDecided === true);
  check('les contrôles passent sur une instance saine', vue.readyToGoLive === true);
  check('la vue nomme ce que la pré-ouverture interdit',
    vue.blockedInPreopening.length === 4);

  const ouvert = await service.setCommercialReadiness('p-cycle', 'LIVE', {
    actor: ACTEUR, reason: 'Recette validée par le client.',
  });
  check('PREOPENING → LIVE accepté', ouvert.state === 'LIVE');
  check('la décision est datée', typeof ouvert.decidedAt === 'string');
  check('…attribuée', ouvert.decidedBy === 'u-dev');
  check('…et motivée', ouvert.decisionReason === 'Recette validée par le client.');
  check('…et ce n’est plus « jamais décidé »', ouvert.neverDecided === false);

  // Idempotence : réaffirmer n'est pas une erreur, et n'écrit pas de trace.
  const avantEvenements = await PanelEvent.countDocuments({ projectId: 'p-cycle' });
  const encore = await service.setCommercialReadiness('p-cycle', 'LIVE', { actor: ACTEUR });
  check('réaffirmer LIVE est idempotent', encore.state === 'LIVE');
  check('…sans produire de second événement',
    (await PanelEvent.countDocuments({ projectId: 'p-cycle' })) === avantEvenements);

  const referme = await service.setCommercialReadiness('p-cycle', 'PREOPENING', { actor: ACTEUR });
  check('LIVE → PREOPENING accepté (frein d’urgence)', referme.state === 'PREOPENING');

  let refus = null;
  try {
    await service.setCommercialReadiness('p-cycle', 'OUVERT', { actor: ACTEUR });
  } catch (err) { refus = err.code; }
  check('un état inventé est refusé', refus === 'PANEL_COMMERCIAL_STATE_INVALID');
}

section('Les contrôles gardent l’OUVERTURE, jamais la fermeture');
{
  const nonAppaire = await projet('p-nonpaire', { paired: false, destination: false });
  const vue = service.describeCommercialReadiness(nonAppaire);
  check('une fiche non appairée n’est pas ouvrable', vue.readyToGoLive === false);
  check('…et le contrôle qui manque est nommé',
    vue.checks.find((c) => c.code === 'PAIRED')?.passed === false);

  let refus = null;
  try {
    await service.setCommercialReadiness('p-nonpaire', 'LIVE', { actor: ACTEUR });
  } catch (err) { refus = err; }
  check('l’ouverture est refusée avec un motif explicite',
    refus?.code === 'PANEL_COMMERCIAL_READINESS_INCOMPLETE');
  check('…et le refus liste les contrôles manquants',
    Array.isArray(refus?.details?.checks) && refus.details.checks.length > 0);

  // REFERMER n'exige rien : exiger la bonne santé pour cesser de facturer
  // serait exactement le mauvais sens.
  await registryStore.setCommercialState('p-nonpaire', {
    state: 'LIVE', at: new Date().toISOString(),
  });
  const referme = await service.setCommercialReadiness('p-nonpaire', 'PREOPENING', { actor: ACTEUR });
  check('refermer une instance en mauvaise santé reste possible', referme.state === 'PREOPENING');
}

section('PREOPENING_BLOCKS_FINANCIAL_WRITE — et zéro appel fournisseur');
{
  const record = await projet('p-bloc', { commercialState: 'PREOPENING' });
  appelsFournisseur = 0;

  const financier = await invoquer(record, FINANCIERE);
  check(`${FINANCIERE} est bloquée en pré-ouverture`,
    financier.code === CODES.BLOCKED_PREOPENING);

  const legal = await invoquer(record, LEGALE);
  check(`PREOPENING_BLOCKS_LEGAL_WRITE — ${LEGALE} est bloquée`,
    legal.code === CODES.BLOCKED_PREOPENING);

  check('AUCUN appel fournisseur n’a eu lieu', appelsFournisseur === 0);
}

section('LIVE_ALLOWS_POLICY_TO_CONTINUE — le geste débloque réellement');
{
  const environnementAvant = environmentModule.resolveIntegratedApiEnvironment({
    providerDefinition: providerRegistry.getProviderDefinition('STRIPE'),
    runtimeEnvironment: 'PROD',
  });

  await service.setCommercialReadiness('p-bloc', 'LIVE', { actor: ACTEUR });
  const record = await registryStore.getById('p-bloc');
  check('l’instance est ouverte', service.effectiveCommercialState(record) === 'LIVE');

  appelsFournisseur = 0;
  const apres = await invoquer(record, FINANCIERE);
  /**
   * On ne prétend PAS que l'appel réussit : aucun fournisseur n'est migré, et
   * les identifiants ne sont pas renseignés ici. Ce qui compte est que la
   * politique commerciale ne soit PLUS la cause du refus — la passerelle est
   * allée plus loin dans sa chaîne.
   */
  check('la politique commerciale n’est plus la cause du refus',
    apres.code !== CODES.BLOCKED_PREOPENING);
  check('…et le refus vient d’une étape ULTÉRIEURE (non migrée / non configurée)',
    apres.code === CODES.NOT_AVAILABLE
    || apres.code === CODES.CREDENTIALS_MISSING
    // L6.2B — `billing.checkout.create` est SERVIE : la passerelle descend
    // désormais jusqu'au contrat d'entrée. L'étape est plus tardive encore, et
    // la démonstration en sort renforcée, pas affaiblie.
    || apres.code === CODES.INPUT_INVALID);

  const environnementApres = environmentModule.resolveIntegratedApiEnvironment({
    providerDefinition: providerRegistry.getProviderDefinition('STRIPE'),
    runtimeEnvironment: 'PROD',
  });
  check('COMMERCIAL_READINESS_IS_NOT_ENVIRONMENT — le monde n’a pas bougé',
    environnementAvant === 'PROD' && environnementApres === 'PROD');
}

section('PREOPENING_NEVER_SELECTS_TEST_PROVIDER · LIVE_NEVER_SELECTS_PROD_FROM_TEST');
{
  const stripe = providerRegistry.getProviderDefinition('STRIPE');
  const monde = (runtime) => environmentModule.resolveIntegratedApiEnvironment({
    providerDefinition: stripe, runtimeEnvironment: runtime,
  });

  for (const etat of ['PREOPENING', 'LIVE']) {
    check(`PROD + ${etat} → monde PROD`, monde('PROD') === 'PROD');
    check(`TEST + ${etat} → monde TEST`, monde('TEST') === 'TEST');
    void etat;
  }

  // La preuve mécanique : le résolveur n'a aucun paramètre d'ouverture.
  const source = environmentModule.resolveIntegratedApiEnvironment.toString();
  check('le résolveur ne connaît aucun état commercial',
    !/commercial|preopening|live/i.test(source));
  check('ACTIVE_MODE_IS_IRRELEVANT — ni activeMode', !/activeMode/i.test(source));
}

section('SITE_STATUS_IS_INDEPENDENT — deux machines, deux questions');
{
  // L'ouverture commerciale ne lit ni n'écrit l'état du site. Si elle le
  // faisait, refermer une instance suspendrait son site — et la suspension
  // contractuelle, qui se lève en PAYANT, deviendrait un interblocage.
  const source = service.setCommercialReadiness.toString()
    + service.describeReadinessChecks.toString();
  check('le service ne lit aucun état de site',
    !/siteStatus|suspension|contractProtection/i.test(source));
  check('…et aucun état de contrat', !/contract\b/i.test(source.replace(/contractProtection/gi, '')));
  check('aucun SUSPENDED dans le vocabulaire',
    !commercial.COMMERCIAL_STATE_VALUES.includes('SUSPENDED'));
}

section('La décision laisse une trace imputable');
{
  const evenements = await PanelEvent.find({ projectId: 'p-bloc' }).lean();
  const ouverture = evenements.find((e) => e.type === EVENT_TYPES.COMMERCIAL_OPENED);
  check('l’ouverture est journalisée', Boolean(ouverture));
  check('…avec l’état précédent et le suivant',
    ouverture?.data?.previous === 'PREOPENING' && ouverture?.data?.next === 'LIVE');
  check('…avec l’acteur', ouverture?.data?.actor === 'u-dev');
  check('…et l’environnement RAPPELÉ, jamais modifié',
    ouverture?.data?.environment === 'PROD');
  check('l’ouverture est signalée comme un fait notable',
    ouverture?.severity === 'WARNING');

  const fermeture = await PanelEvent.findOne({
    projectId: 'p-cycle', type: EVENT_TYPES.COMMERCIAL_CLOSED,
  }).lean();
  check('la fermeture est journalisée aussi', Boolean(fermeture));
  check('aucun secret dans la trace',
    !JSON.stringify(evenements).match(/sk_(test|live)_|xkeysib-|whsec_/));
}

section('Le service ne choisit AUCUN monde — la preuve par la signature');
{
  const source = service.setCommercialReadiness.toString();
  check('aucune mention de TEST/PROD', !/['"](TEST|PROD)['"]/.test(source));
  check('aucune mention de credential', !/credential/i.test(source));
  check('aucun appel au résolveur d’environnement',
    !/resolveIntegratedApiEnvironment|resolveProviderEnvironment/.test(source));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('E2E — LE GESTE RÉEL : écran DEV → HTTP → persistance → passerelle');
{
  /**
   * ── POURQUOI PAR LE VRAI ROUTEUR ────────────────────────────────────────────
   *
   * Les blocs précédents appellent le service. C'est utile, mais un service
   * appelé directement n'a ni garde d'accès, ni contrôleur, ni sérialisation —
   * or c'est PRÉCISÉMENT là qu'une ouverture commerciale peut fuir : une route
   * oubliée (le cas au moment d'écrire ces lignes), un `requirePanelDev`
   * absent, un corps mal lu. On monte donc le routeur réel et l'on actionne le
   * bouton comme l'écran le ferait, jeton en main.
   */
  const express = (await import('../backend/node_modules/express/index.js')).default;
  const projectsRoutes = (await import('../backend/src/routes/projects.routes.js')).default;
  const { errorHandler } = await import('../backend/src/middlewares/error.middleware.js');
  const users = await import('../backend/src/services/auth/panelUsers.service.js');
  const { issueUserToken } = await import('../backend/src/services/auth/panelToken.service.js');
  const { startServer } = await import('./helpers/harness.js');

  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRoutes);
  app.use(errorHandler);
  const http = await startServer(app);

  const dev = await users.createUser({
    email: 'ouverture-dev@panel.test',
    password: 'ouverture-dev-2026-XyZ',
    displayName: 'Exploitation',
    role: users.PANEL_ROLES.DEV,
  });
  const admin = await users.createUser({
    email: 'ouverture-admin@panel.test',
    password: 'ouverture-admin-2026-XyZ',
    displayName: 'Gestion',
    role: users.PANEL_ROLES.ADMIN,
  });
  const porteur = (u) => ({ authorization: `Bearer ${issueUserToken(u)}` });

  const record = await projet('p-e2e', { commercialState: 'PREOPENING' });

  // ── L'ACCÈS ───────────────────────────────────────────────────────────────
  const anonyme = await http.call('GET', '/api/projects/p-e2e/commercial-readiness');
  check('sans jeton, la lecture est refusée', anonyme.status === 401);

  const lectureAdmin = await http.call('GET', '/api/projects/p-e2e/commercial-readiness', {
    headers: porteur(admin),
  });
  check('un ADMIN peut CONSTATER l’ouverture', lectureAdmin.status === 200);
  check('…et la vue nomme l’environnement À CÔTÉ de l’état',
    lectureAdmin.json?.data?.environment === 'PROD'
    && lectureAdmin.json?.data?.state === 'PREOPENING');

  const ecritureAdmin = await http.call('PUT', '/api/projects/p-e2e/commercial-readiness', {
    headers: porteur(admin), body: { state: 'LIVE' },
  });
  check('un ADMIN ne peut PAS ouvrir', ecritureAdmin.status === 403);
  check('…et le refus est celui de la garde DEV',
    ecritureAdmin.json?.code === 'PANEL_FORBIDDEN');
  check('…et rien n’a été écrit',
    (await registryStore.getById('p-e2e')).commercialState === 'PREOPENING');

  // ── LA PASSERELLE, AVANT ──────────────────────────────────────────────────
  appelsFournisseur = 0;
  const avant = await invoquer(await registryStore.getById('p-e2e'), FINANCIERE);
  check('avant le geste, la capacité financière est bloquée',
    avant.code === CODES.BLOCKED_PREOPENING);
  check('…et aucun appel fournisseur n’a eu lieu', appelsFournisseur === 0);

  // ── LE GESTE ──────────────────────────────────────────────────────────────
  const ouverture = await http.call('PUT', '/api/projects/p-e2e/commercial-readiness', {
    headers: porteur(dev), body: { state: 'LIVE', reason: 'Recette client signée.' },
  });
  check('un DEV ouvre, par la route réelle', ouverture.status === 200);
  check('…la réponse rend la vue complète', ouverture.json?.data?.state === 'LIVE');
  check('…imputée au DEV authentifié', ouverture.json?.data?.decidedBy === dev.userId);
  check('…et motivée', ouverture.json?.data?.decisionReason === 'Recette client signée.');

  // ── LA PERSISTANCE ────────────────────────────────────────────────────────
  const persiste = await registryStore.getById('p-e2e');
  check('l’état est PERSISTÉ sur la fiche', persiste.commercialState === 'LIVE');
  check('…avec sa date', typeof persiste.commercialStateUpdatedAt === 'string');

  // ── LA PASSERELLE, APRÈS ──────────────────────────────────────────────────
  appelsFournisseur = 0;
  const apres = await invoquer(persiste, FINANCIERE);
  check('après le geste, la pré-ouverture n’est plus la cause du refus',
    apres.code !== CODES.BLOCKED_PREOPENING);
  check('…et le refus vient d’une étape ULTÉRIEURE',
    apres.code === CODES.NOT_AVAILABLE
    || apres.code === CODES.CREDENTIALS_MISSING
    // L6.2B — `billing.checkout.create` est SERVIE : la passerelle descend
    // désormais jusqu'au contrat d'entrée. L'étape est plus tardive encore, et
    // la démonstration en sort renforcée, pas affaiblie.
    || apres.code === CODES.INPUT_INVALID);
  check('COMMERCIAL_READINESS_IS_NOT_ENVIRONMENT — la fiche est restée en PROD',
    persiste.runtime?.environment === 'PROD' && record.runtime?.environment === 'PROD');

  // ── LE RETOUR ─────────────────────────────────────────────────────────────
  const retour = await http.call('PUT', '/api/projects/p-e2e/commercial-readiness', {
    headers: porteur(dev), body: { state: 'PREOPENING', reason: 'Incident de facturation.' },
  });
  check('le frein d’urgence passe par la même route', retour.status === 200);
  check('…et referme réellement', retour.json?.data?.state === 'PREOPENING');
  appelsFournisseur = 0;
  const rebloque = await invoquer(await registryStore.getById('p-e2e'), FINANCIERE);
  check('la passerelle refuse de nouveau', rebloque.code === CODES.BLOCKED_PREOPENING);
  check('…sans aucun appel fournisseur', appelsFournisseur === 0);

  // ── LE REFUS MÉTIER TRAVERSE LA ROUTE ─────────────────────────────────────
  await projet('p-e2e-nu', { paired: false, destination: false });
  const incomplet = await http.call('PUT', '/api/projects/p-e2e-nu/commercial-readiness', {
    headers: porteur(dev), body: { state: 'LIVE' },
  });
  check('un prérequis manquant refuse l’ouverture, en HTTP', incomplet.status === 409);
  check('…avec un code explicite',
    incomplet.json?.code === 'PANEL_COMMERCIAL_READINESS_INCOMPLETE');
  check('…et les contrôles manquants NOMMÉS à l’écran',
    Array.isArray(incomplet.json?.details?.checks) && incomplet.json.details.checks.length > 0);

  await http.close();
}

section('PANEL_IS_AUTHORITY — aucune surface ne laisse un projet s’ouvrir lui-même');
{
  /**
   * L'invariant retourné de la mission (`PANEL_OBSERVES_PROJECTED_STATE`).
   *
   * L3 a inversé l'autorité annoncée en L1.75, et l'argument est plus fort :
   * un projet ne doit pas pouvoir DÉCLARER son propre droit de dépenser. La
   * contrepartie de cette inversion est une obligation — AUCUNE surface tournée
   * vers le projet ne doit accepter cet état. On le vérifie sur les fichiers,
   * parce qu'une route ajoutée demain doit faire rougir cette suite.
   */
  const fs = await import('node:fs');
  const lire = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const sansCommentaires = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  for (const surface of ['bridge.routes.js', 'public.routes.js']) {
    check(`aucune écriture d’ouverture sur ${surface}`,
      !/commercial/i.test(sansCommentaires(lire(`../backend/src/routes/${surface}`))));
  }

  const projets = sansCommentaires(lire('../backend/src/routes/projects.routes.js'));
  check('la lecture de l’ouverture est ouverte à tout compte du Panel',
    /router\.get\('\/:projectId\/commercial-readiness'/.test(projets));
  check('…et l’ÉCRITURE est gardée par requirePanelDev',
    /router\.put\(\s*'\/:projectId\/commercial-readiness',\s*requirePanelDev/.test(projets));

  const contexte = sansCommentaires(
    lire('../backend/src/services/capabilities/invocationContext.js'),
  );
  check('le contexte d’invocation ne lit l’ouverture QUE sur la fiche du Panel',
    /resolveCommercialState\(panelProject\)/.test(contexte)
    && !/payload[^\n]*commercial/i.test(contexte));
}

await stopMemoryMongo();
finish();
