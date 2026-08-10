// LA PASSERELLE, PAR LE PONT RÉEL — l'E2E qui justifie tout le lot (L3).
//
// ══ CE QUE CE TEST FAIT ══════════════════════════════════════════════════════
//
//   · un vrai Panel, sur un vrai port, avec sa vraie base ;
//   · une vraie instance SB Auto, dans SON processus, avec SA base ;
//   · un vrai appairage — donc un vrai bridgeToken ;
//   · un vrai jeu d'identifiants CHIFFRÉ dans le coffre du Panel ;
//   · un faux Brevo qui parle HTTP pour de bon, et note QUELLE clé arrive.
//
// Le test n'appelle JAMAIS `invokeCapability`, `resolveCredentials` ni le
// moindre service interne du Panel. Il entre par où entre le projet :
// `PanelBridge.invokeCapability` → `HttpPanelClient` → réseau → `/bridge/v1`.
// Un test qui court-circuiterait le transport ne prouverait que la bonne foi du
// raccourci.
//
// ══ CE QU'IL DOIT PROUVER ════════════════════════════════════════════════════
//
//   1. un projet TEST atteint les identifiants TEST — et JAMAIS ceux de PROD ;
//   2. la charge utile ne peut pas choisir le monde opposé ;
//   3. un projet ne peut pas se faire passer pour un autre ;
//   4. aucun secret n'apparaît dans la réponse, ni dans la base du projet ;
//   5. sans octroi, rien ne part.
import http from 'node:http';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

/* ══════════════════════════════════════════════════════════════════════════
   LES SENTINELLES — improbables par construction. Une occurrence hors du
   coffre est une fuite, jamais une coïncidence.
   ══════════════════════════════════════════════════════════════════════════ */
const CLE_TEST = 'xkeysib-L3SENTINELLETESTJAMAISAILLEURS000001';
const CLE_PROD = 'xkeysib-L3SENTINELLEPRODJAMAISATTEINTE0000002';
const TOUTES = [CLE_TEST, CLE_PROD];

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const VERIFY = 'email.sender.verify';

const propre = (valeur) => {
  const texte = typeof valeur === 'string' ? valeur : JSON.stringify(valeur ?? null);
  return !TOUTES.some((s) => texte.includes(s));
};

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX BREVO QUI PARLE VRAIMENT HTTP.
   Pas un `fetchImpl` injecté : un serveur, un port, des en-têtes réels. C'est
   la seule façon de constater QUELLE clé sort réellement du Panel.
   ══════════════════════════════════════════════════════════════════════════ */
const appelsFournisseur = [];
const fauxBrevo = http.createServer((req, res) => {
  appelsFournisseur.push({ url: req.url, apiKey: req.headers['api-key'] ?? null });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ companyName: 'L.Y Solution', email: 'ops@ly.fr' }));
});
await new Promise((resolve) => fauxBrevo.listen(0, '127.0.0.1', resolve));
const BREVO_BASE = `http://127.0.0.1:${fauxBrevo.address().port}/v3`;

const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const grantsModule = await import('../backend/src/services/capabilities/capabilityGrants.js');
const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { default: CredentialSet } = await import('../backend/src/models/PanelIntegratedApiCredentialSet.model.js');
const { PanelEvent } = await import('../backend/src/models/PanelSupervision.model.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l3.test' }, { requirePublic: false });

const { base: panelUrl, close: closePanel } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   1. LE COFFRE — deux mondes, deux clés, et une seule sera atteinte.
   ══════════════════════════════════════════════════════════════════════════ */
section('1. Le coffre du Panel porte les DEUX mondes');
{
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: CLE_TEST, baseUrl: BREVO_BASE },
  }, ACTEUR);
  await controlPlane.saveCredentialSet('BREVO', 'PROD', {
    values: { apiKey: CLE_PROD, baseUrl: BREVO_BASE },
  }, ACTEUR);

  const brut = await CredentialSet.collection.find({}).toArray();
  check('les deux jeux sont enregistrés',
    brut.filter((d) => d.provider === 'BREVO' && Object.keys(d.credentialsEncrypted ?? {}).length).length === 2);
  check('…et AUCUNE clé n’apparaît en clair, même au repos', propre(brut));

  // Validation par le VRAI chemin L1 — un appel HTTP réel au faux fournisseur.
  const verdict = await controlPlane.validateCredentialSet('BREVO', 'TEST', { actor: ACTEUR });
  check('le jeu TEST est validé par un appel réel', verdict.validation.status === 'VALID');
  check('…et c’est bien la clé TEST qui est partie',
    appelsFournisseur.at(-1).apiKey === CLE_TEST);
  check('…sur l’URL de base du coffre', appelsFournisseur.at(-1).url === '/v3/account');
}

/* ══════════════════════════════════════════════════════════════════════════
   2. UNE INSTANCE RÉELLE, APPAIRÉE.
   ══════════════════════════════════════════════════════════════════════════ */
const instance = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l3_capabilities', env: 'TEST', projectName: 'SB Auto L3',
});

let projectId;
section('2. Appairage réel — le jeton est la seule autorité');
{
  const declared = await registre.declareProject({
    publicBackendUrl: instance.publicBackendUrl,
    projectName: instance.projectName,
    environment: 'TEST',
  });
  const reponse = await instance.pair({
    panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: instance.publicBackendUrl,
  });
  projectId = reponse.projectId;
  instance.projectId = projectId;
  check('le projet est appairé', typeof projectId === 'string');
  check('la réponse d’appairage est PROPRE', propre(reponse));
  await instance.heartbeat();
}

/* ══════════════════════════════════════════════════════════════════════════
   2 bis. LA ROUTE EST DERRIÈRE LA GARDE — sans jeton, elle n'existe pas.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 bis. Sans jeton d’appairage, la passerelle ne répond rien');
{
  const avant = appelsFournisseur.length;
  const sansJeton = await fetch(`${panelUrl}/bridge/v1/capabilities/${VERIFY}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-contract-version': '1.5.0' },
    body: JSON.stringify({ recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-anon01' }),
  });
  const corps = await sansJeton.json().catch(() => null);
  check('401', sansJeton.status === 401);
  check('…et c’est le pont qui refuse, pas la passerelle',
    corps?.code === 'BRIDGE_UNAUTHORIZED');
  check('…aucun appel fournisseur', appelsFournisseur.length === avant);

  // Un jeton inventé ne vaut pas mieux qu'aucun jeton.
  const faux = await fetch(`${panelUrl}/bridge/v1/capabilities/${VERIFY}/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bridge-contract-version': '1.5.0',
      authorization: 'Bearer jeton-inventé-de-toutes-pièces',
    },
    body: JSON.stringify({ recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-anon02' }),
  });
  check('jeton inventé → 401', faux.status === 401);
  check('…toujours aucun appel fournisseur', appelsFournisseur.length === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. SANS OCTROI, RIEN NE PART — fermé par défaut.
   ══════════════════════════════════════════════════════════════════════════ */
section('3. Un projet appairé ne peut RIEN sans octroi');
{
  const avant = appelsFournisseur.length;
  const refus = await instance.invokeCapability({
    code: VERIFY,
    input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000001' },
  });
  check('refusé', refus.ok === false);
  check('…code CAPABILITY_NOT_GRANTED', refus.code === 'CAPABILITY_NOT_GRANTED');
  check('…en 403', refus.httpStatus === 403);
  check('…et AUCUN appel fournisseur', appelsFournisseur.length === avant);

  // Le code traverse le pont TEL QUEL : sans cela, le projet ne saurait pas
  // pourquoi il est refusé, et un opérateur chercherait au mauvais endroit.
  check('le code n’a pas été aplati en BRIDGE_INTERNAL', refus.code.startsWith('CAPABILITY_'));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. UNE CAPACITÉ ACCORDÉE — le chemin complet, de bout en bout.
   ══════════════════════════════════════════════════════════════════════════ */
let succes;
section('4. Le chemin complet : projet → pont → passerelle → coffre → fournisseur');
{
  await grantsModule.setCapabilityGrants(projectId, [VERIFY], ACTEUR);

  const avant = appelsFournisseur.length;
  succes = await instance.invokeCapability({
    code: VERIFY,
    input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000002' },
  });

  check('la capacité s’exécute', succes.ok === true);
  check('…issue SUCCEEDED', succes.data.outcome === 'SUCCEEDED');
  check('…le constat métier est rendu', succes.data.result.reachable === true);
  check('…avec le nom public du compte', succes.data.result.accountLabel === 'L.Y Solution');
  check('…l’operationId du projet lui est rendu', succes.data.operationId === 'op-e2e-000002');
  check('…et un requestId, pour le support', typeof succes.data.requestId === 'string');

  check('UN appel fournisseur a bien eu lieu', appelsFournisseur.length === avant + 1);
  // LE POINT CENTRAL : le projet n'a jamais tenu cette clé, et c'est elle qui part.
  check('la clé partie est celle du COFFRE, en TEST', appelsFournisseur.at(-1).apiKey === CLE_TEST);
  check('la clé PROD n’est JAMAIS partie', appelsFournisseur.every((a) => a.apiKey !== CLE_PROD));

  check('l’environnement rendu est celui de l’instance', succes.data.environment === 'TEST');
  check('le fournisseur est nommé pour le diagnostic', succes.data.provider === 'BREVO');
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LA CHARGE UTILE NE CHOISIT NI LE MONDE, NI LE PROJET.
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Le projet ne peut choisir ni son monde ni son identité');
{
  const avant = appelsFournisseur.length;

  for (const [libelle, champ, valeur] of [
    ['environment', 'environment', 'PROD'],
    ['mode', 'mode', 'PROD'],
    ['provider', 'provider', 'STRIPE'],
    ['baseUrl', 'baseUrl', 'https://evil.test/v3'],
    ['apiKey', 'apiKey', CLE_PROD],
  ]) {
    const r = await instance.invokeCapability({
      code: VERIFY,
      input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000003', [champ]: valeur },
    });
    check(`« ${libelle} » dans la charge utile → refusé`, r.ok === false);
    check(`…code CAPABILITY_INPUT_INVALID`, r.code === 'CAPABILITY_INPUT_INVALID');
  }

  // Usurpation : le projet authentifié en désigne un autre.
  const usurpation = await instance.invokeCapability({
    code: VERIFY,
    input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000004', projectId: 'un-autre-projet' },
  });
  check('projectId étranger → CAPABILITY_PROJECT_SCOPE_MISMATCH',
    usurpation.code === 'CAPABILITY_PROJECT_SCOPE_MISMATCH');
  check('…en 403', usurpation.httpStatus === 403);

  // Une usurpation refusée doit LAISSER UNE TRACE : c'est la ligne qu'un
  // opérateur viendra chercher en premier, et le seul signal qui distingue un
  // client mal écrit d'une tentative délibérée.
  const traces = await PanelEvent.find({ projectId, type: 'CAPABILITY_REFUSED' }).lean();
  check('l’usurpation est journalisée',
    traces.some((e) => e.data?.errorCode === 'CAPABILITY_PROJECT_SCOPE_MISMATCH'));
  const trace = traces.find((e) => e.data?.errorCode === 'CAPABILITY_PROJECT_SCOPE_MISMATCH');
  check('…au nom du projet AUTHENTIFIÉ, pas de celui qu’il prétendait',
    trace.projectId === projectId && !JSON.stringify(trace).includes('un-autre-projet'));
  check('…et sans monde résolu, puisque le refus précède la résolution',
    trace.data.environment === null);

  /**
   * Redondance : le projet répète SON PROPRE identifiant. Refusé aussi — mais
   * pour une raison DIFFÉRENTE, et la distinction n'est pas cosmétique.
   *
   * Le contrat métier de cette capacité ne comporte pas de `projectId` : il
   * n'a rien à y faire, puisque le jeton le porte déjà. Le schéma strict le
   * refuse donc comme n'importe quelle clé inconnue.
   *
   * Un identifiant DIVERGENT, lui, est arrêté BIEN PLUS TÔT — avant même la
   * lecture du contrat — parce que ce n'est pas une maladresse de format mais
   * une tentative de désigner autrui. Deux refus, deux codes, deux gravités.
   */
  const redondant = await instance.invokeCapability({
    code: VERIFY,
    input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000005', projectId },
  });
  check('projectId redondant → refusé par le contrat strict', redondant.code === 'CAPABILITY_INPUT_INVALID');
  check('…et non comme une usurpation', redondant.code !== 'CAPABILITY_PROJECT_SCOPE_MISMATCH');

  check('AUCUN de ces refus n’a touché le fournisseur', appelsFournisseur.length === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. LES OCTROIS SONT PAR PROJET — B n'ouvre rien à A.
   ══════════════════════════════════════════════════════════════════════════ */
section('6. Les octrois ne se partagent pas entre projets');
{
  // Un SECOND projet au registre, avec le même octroi. Il n'est pas appairé :
  // ce qu'on éprouve ici, c'est que son octroi n'ouvre RIEN pour l'autre.
  const autre = await registre.declareProject({
    publicBackendUrl: 'http://127.0.0.1:59999',
    projectName: 'SB Auto L3 — projet B',
    environment: 'TEST',
  });
  const projectIdB = autre.record.projectId;
  await grantsModule.setCapabilityGrants(projectIdB, [VERIFY], ACTEUR);

  // On retire l'octroi de A. B garde le sien.
  await grantsModule.setCapabilityGrants(projectId, [], ACTEUR);

  const avant = appelsFournisseur.length;
  const refus = await instance.invokeCapability({
    code: VERIFY,
    input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000006' },
  });
  check('A refusé, bien que B soit autorisé', refus.code === 'CAPABILITY_NOT_GRANTED');
  check('…et aucun appel fournisseur', appelsFournisseur.length === avant);

  const grantsB = await grantsModule.getCapabilityGrants(projectIdB);
  check('B conserve bien son octroi', grantsB.granted.includes(VERIFY));

  await grantsModule.setCapabilityGrants(projectId, [VERIFY], ACTEUR);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. CAPACITÉ INCONNUE, ET CAPACITÉ NON MIGRÉE.
   ══════════════════════════════════════════════════════════════════════════ */
section('7. Fail closed sur l’inconnu, refus explicite sur le non-migré');
{
  const avant = appelsFournisseur.length;

  const inconnue = await instance.invokeCapability({ code: 'pwn.everything', input: {} });
  check('capacité inconnue → CAPABILITY_UNKNOWN', inconnue.code === 'CAPABILITY_UNKNOWN');
  check('…en 404', inconnue.httpStatus === 404);

  await grantsModule.setCapabilityGrants(projectId, [VERIFY, 'email.send_template'], ACTEUR);
  const nonMigree = await instance.invokeCapability({
    code: 'email.send_template',
    input: { templateRef: 'X', recipient: { email: 'a@b.fr' }, operationId: 'op-e2e-000007' },
  });
  check('capacité accordée mais non migrée → CAPABILITY_NOT_AVAILABLE',
    nonMigree.code === 'CAPABILITY_NOT_AVAILABLE');
  check('…et le motif est lisible côté projet', nonMigree.panelDetails?.reason === 'NOT_MIGRATED');

  check('aucun appel fournisseur sur ces deux refus', appelsFournisseur.length === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. AUCUN SECRET NULLE PART — la preuve par la recherche.
   ══════════════════════════════════════════════════════════════════════════ */
section('8. Les sentinelles ne sont NULLE PART hors du coffre');
{
  check('…ni dans la réponse rendue au projet', propre(succes.data));
  check('…ni dans l’état du projet', propre(await instance.state()));
  check('…ni dans son identité', propre(await instance.identity()));

  // TOUTE la base du projet, collection par collection.
  const dump = await instance.dbDump();
  check('…ni dans AUCUNE collection de la base du projet', propre(dump));

  // Le journal d'invocation du Panel : il doit être lisible sans précaution.
  const evenements = await PanelEvent.find({ projectId }).lean();
  check('…ni dans la chronologie du Panel', propre(evenements));
  check('la chronologie porte bien les invocations',
    evenements.some((e) => e.type === 'CAPABILITY_INVOKED'));
  check('…et les refus, séparément',
    evenements.some((e) => e.type === 'CAPABILITY_REFUSED'));
  const invoque = evenements.find((e) => e.type === 'CAPABILITY_INVOKED');
  check('un événement d’invocation porte capacité, fournisseur et environnement',
    invoque.data.capability === VERIFY && invoque.data.provider === 'BREVO'
    && invoque.data.environment === 'TEST');
  check('…une durée et une issue', Number.isFinite(invoque.data.durationMs) && invoque.data.outcome === 'SUCCEEDED');
  check('…et AUCUNE entrée métier (pas d’adresse de destinataire)',
    !JSON.stringify(evenements).includes('ops@garage.fr'));

  // La fiche du Panel n'a pas non plus à porter de secret.
  const fiche = await registryStore.getById(projectId);
  check('…ni dans la fiche du projet côté Panel', propre(fiche));
  check('la fiche porte bien les octrois', (fiche.capabilityGrants ?? []).includes(VERIFY));
}

await instance.stop();
await new Promise((resolve) => fauxBrevo.close(resolve));
await closePanel();
await stopMemoryMongo();
finish();
