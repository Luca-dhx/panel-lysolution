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
   3. UN PROJET APPAIRÉ AGIT — par le pont réel, sans rien à cocher.
   ══════════════════════════════════════════════════════════════════════════ */
section('3. Un projet appairé invoque sans octroi préalable');
{
  /**
   * ── CE QUE CETTE SECTION PROUVAIT, ET CE QU'ELLE PROUVE MAINTENANT ────────
   *
   * Elle s'intitulait « Un projet appairé ne peut RIEN sans octroi » et
   * vérifiait le refus `CAPABILITY_NOT_GRANTED` : un projet techniquement prêt,
   * authentifié par le pont, avec la clé dans le coffre du Panel, était refusé
   * parce qu'un opérateur n'avait pas coché une case sur sa fiche.
   *
   * C'est exactement ce que la simplification supprime, et cette section est
   * donc devenue son meilleur témoin : le MÊME appel, sur le MÊME projet,
   * traverse désormais jusqu'au fournisseur.
   */
  const avant = appelsFournisseur.length;
  const succesSansOctroi = await instance.invokeCapability({
    code: VERIFY,
    input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000001' },
  });
  check('un projet appairé invoque sans aucun octroi', succesSansOctroi.ok === true);
  check('…et l’appel a RÉELLEMENT atteint le fournisseur',
    appelsFournisseur.length === avant + 1);
  check('…aucun refus d’octroi n’existe plus',
    succesSansOctroi.code !== 'CAPABILITY_NOT_GRANTED');

  /**
   * LE REFUS QUI SUBSISTE TRAVERSE LE PONT TEL QUEL.
   *
   * On l'éprouve sur une capacité INCONNUE — le seul refus de cette famille qui
   * reste. Sans cela, le projet ne saurait pas pourquoi il est refusé, et un
   * opérateur chercherait au mauvais endroit.
   */
  const inconnue = await instance.invokeCapability({
    code: 'pwn.everything',
    input: { operationId: 'op-e2e-000002' },
  });
  check('une capacité inconnue reste refusée', inconnue.ok === false);
  check('…et le code n’a pas été aplati en BRIDGE_INTERNAL',
    String(inconnue.code ?? '').startsWith('CAPABILITY_'));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. UNE CAPACITÉ ACCORDÉE — le chemin complet, de bout en bout.
   ══════════════════════════════════════════════════════════════════════════ */
let succes;
section('4. Le chemin complet : projet → pont → passerelle → coffre → fournisseur');
{

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
   6. L'IDENTITÉ NE SE PARTAGE PAS — l'existence de B n'ouvre rien pour A.
   ══════════════════════════════════════════════════════════════════════════ */
section('6. Chaque invocation reste attribuée au projet qui parle');
{
  /**
   * ── CE QUE CETTE SECTION PROUVAIT, ET CE QU'ELLE PROUVE MAINTENANT ────────
   *
   * Elle éprouvait que les OCTROIS ne se partageaient pas : on retirait
   * l'octroi de A, on laissait celui de B, et A était refusé. C'était une
   * propriété du stockage des cases à cocher — pas de l'isolation réelle.
   *
   * Les octrois n'existent plus. Ce qui reste à prouver, et qui compte
   * davantage, c'est que l'invocation de A est ATTRIBUÉE à A : c'est cette
   * attribution qui fonde ensuite toute vérification d'appartenance. Un second
   * projet au registre n'y change rien, et ne prête son identité à personne.
   *
   * L'isolation des RESSOURCES entre projets est éprouvée exhaustivement par
   * `capability-multi-project-isolation.test.js`.
   */
  const autre = await registre.declareProject({
    publicBackendUrl: 'http://127.0.0.1:59999',
    projectName: 'SB Auto L3 — projet B',
    environment: 'TEST',
  });
  const projectIdB = autre.record.projectId;
  check('un second projet existe au registre', typeof projectIdB === 'string');

  const succesA = await instance.invokeCapability({
    code: VERIFY,
    input: { recipient: { email: 'ops@garage.fr' }, operationId: 'op-e2e-000006' },
  });
  check('A invoque pour son propre compte', succesA.ok === true);

  /**
   * ET L'INVOCATION EST JOURNALISÉE AU NOM DE A, JAMAIS DE B.
   *
   * C'est l'attribution qui compte : si le journal — et donc le contexte —
   * pouvait confondre deux projets, toute vérification d'appartenance en aval
   * s'appliquerait au mauvais périmètre.
   */
  const invocationsB = await PanelEvent.countDocuments({
    projectId: projectIdB, type: 'CAPABILITY_INVOKED',
  });
  check('…et B ne porte AUCUNE invocation', invocationsB === 0);

  const invocationsA = await PanelEvent.countDocuments({
    projectId, type: 'CAPABILITY_INVOKED',
  });
  check('…tandis que A porte les siennes', invocationsA > 0);
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

  const nonMigree = await instance.invokeCapability({
    code: 'email.send_template',
    input: { templateRef: 'X', recipient: { email: 'a@b.fr' }, operationId: 'op-e2e-000007' },
  });
  /**
   * Depuis L8.4B la capacité est SERVIE : le refus ne vient plus du registre.
   * L'expéditeur est résolu AVANT le modèle — un modèle valide dont
   * l'expéditeur manque ne doit pas être rendu pour rien, et l'erreur doit
   * nommer la vraie cause.
   *
   * ══ CE QUI A CHANGÉ EN R10.4 ═══════════════════════════════════════════════
   *
   * La cause n'est plus « ce PROJET n'a pas d'identité » mais « le PARC n'a pas
   * d'expéditeur ». L'adresse d'expédition est devenue unique et globale : son
   * absence bloque tout le monde d'un coup, et le code le dit
   * (`PANEL_GLOBAL_SENDER_NOT_CONFIGURED`).
   *
   * C'est plus juste, et c'est surtout mieux ACTIONNABLE : l'ancien message
   * envoyait chercher une configuration dans la fiche du projet appelant, qui
   * n'y peut plus rien.
   *
   * Classé NOT_AVAILABLE et non « fournisseur indisponible » : rien n'a été
   * tenté chez Brevo, et c'est une CONFIGURATION qui manque — actionnable par
   * un humain, pas réparable en réessayant.
   */
  check('sans expéditeur global → CAPABILITY_NOT_AVAILABLE',
    nonMigree.code === 'CAPABILITY_NOT_AVAILABLE');
  check('…et le motif nomme la configuration manquante',
    nonMigree.panelDetails?.reason === 'PANEL_GLOBAL_SENDER_NOT_CONFIGURED');

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
  /**
   * ET LA FICHE NE PORTE AUCUNE AUTORISATION STOCKÉE.
   *
   * Ce contrôle vérifiait l'inverse — que l'octroi avait bien été enregistré.
   * On garde la sonde en la retournant : le champ ne doit plus exister, sans
   * quoi il serait relu un jour.
   */
  check('la fiche ne porte plus d’octrois', fiche.capabilityGrants === undefined);
  check('…ni d’état d’ouverture commerciale', fiche.commercialState === undefined);
}

await instance.stop();
await new Promise((resolve) => fauxBrevo.close(resolve));
await closePanel();
await stopMemoryMongo();
finish();
