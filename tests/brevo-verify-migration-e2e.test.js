// LA MIGRATION BREVO, PAR L'ÉCRAN RÉEL — L8.2, étape « verify ».
//
// ══ CE QUE CE TEST FAIT, ET CE QU'IL REFUSE DE RACCOURCIR ════════════════════
//
//   · un vrai Panel, sur un vrai port, avec son coffre chiffré ;
//   · une vraie instance SB Auto, dans SON processus, avec SA base ;
//   · un vrai appairage, donc un vrai bridgeToken ;
//   · un appel HTTP sur LA ROUTE DU MANAGER — celle que le bouton actionne,
//     avec un vrai jeton DEV signé par le service d'authentification du projet ;
//   · un faux Brevo qui parle HTTP pour de bon, et note QUELLE clé arrive.
//
// Aucune étape n'est simulée côté projet. Le test n'appelle ni
// `testProviderConnection`, ni `PanelBridge`, ni le moindre service interne : il
// entre par où entre un opérateur, et regarde ce qui ressort à l'autre bout.
//
// ══ CE QU'IL DOIT PROUVER ════════════════════════════════════════════════════
//
//   1. le bouton « Connexion plateforme Brevo » atteint la clé DU PANEL ;
//   2. la clé LOCALE du projet n'est jamais lue, jamais envoyée ;
//   3. le projet ne peut pas choisir le monde — même en le demandant ;
//   4. Panel absent ou octroi manquant → refus NOMMÉ, et AUCUN repli local ;
//   5. l'état « vérifié » du credential local n'est pas estampillé par un test
//      qui ne l'a pas éprouvé ;
//   6. aucun secret, d'aucun côté, dans aucune réponse ni aucune base.
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
   SENTINELLES — improbables par construction. Une occurrence hors du coffre
   du Panel est une fuite, jamais une coïncidence.
   ══════════════════════════════════════════════════════════════════════════ */
const CLE_PANEL_TEST = ['xkeysib', 'L82PANELTESTJAMAISAILLEURS00001'].join('-');
const CLE_PANEL_PROD = ['xkeysib', 'L82PANELPRODJAMAISATTEINTE00002'].join('-');
/** La clé que le PROJET détient encore. Elle ne doit plus JAMAIS sortir. */
const CLE_PROJET_LEGACY = ['xkeysib', 'L82PROJETLEGACYQUINEDOITPLUS003'].join('-');
const TOUTES = [CLE_PANEL_TEST, CLE_PANEL_PROD, CLE_PROJET_LEGACY];

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const VERIFY = 'email.sender.verify';

const propre = (valeur) => {
  const texte = typeof valeur === 'string' ? valeur : JSON.stringify(valeur ?? null);
  return !TOUTES.some((s) => texte.includes(s));
};

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX BREVO QUI PARLE VRAIMENT HTTP.
   C'est la seule façon de constater QUELLE clé sort réellement, et d'où.
   ══════════════════════════════════════════════════════════════════════════ */
const appelsBrevo = [];
const fauxBrevo = http.createServer((req, res) => {
  appelsBrevo.push({ url: req.url, apiKey: req.headers['api-key'] ?? null });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ companyName: 'L.Y Solution', email: 'ops@ly.fr' }));
});
await new Promise((resolve) => fauxBrevo.listen(0, '127.0.0.1', resolve));
const BREVO_BASE = `http://127.0.0.1:${fauxBrevo.address().port}/v3`;

const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const grantsModule = await import('../backend/src/services/capabilities/capabilityGrants.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { default: CredentialSet } = await import('../backend/src/models/PanelIntegratedApiCredentialSet.model.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l82.test' }, { requirePublic: false });

const { base: panelUrl, close: closePanel } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   1. LE COFFRE DU PANEL — deux mondes, deux clés.
   ══════════════════════════════════════════════════════════════════════════ */
section('1. Le Panel détient les clés Brevo des deux mondes');
{
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: CLE_PANEL_TEST, baseUrl: BREVO_BASE },
  }, ACTEUR);
  await controlPlane.saveCredentialSet('BREVO', 'PROD', {
    values: { apiKey: CLE_PANEL_PROD, baseUrl: BREVO_BASE },
  }, ACTEUR);

  const brut = await CredentialSet.collection.find({}).toArray();
  check('les deux jeux sont au coffre', brut.filter(
    (d) => d.provider === 'BREVO' && Object.keys(d.credentialsEncrypted ?? {}).length,
  ).length === 2);
  check('aucune clé en clair, même au repos', propre(brut));

  /**
   * LA PASSERELLE EXIGE UNE CLÉ PROUVÉE, PAS UNE CLÉ SAISIE.
   *
   * « Renseignée » ne veut rien dire tant que personne ne l'a essayée : agir
   * avec une clé jamais validée, c'est découvrir sa validité au moment où
   * l'action compte. L'opérateur valide donc, comme en exploitation — et
   * l'appel part réellement chez le faux Brevo.
   */
  const verdict = await controlPlane.validateCredentialSet('BREVO', 'TEST', { actor: ACTEUR });
  check('le jeu TEST est validé par un appel réel', verdict.validation.status === 'VALID');
  check('…et c’est bien la clé du Panel qui est partie',
    appelsBrevo.at(-1).apiKey === CLE_PANEL_TEST);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. UNE INSTANCE RÉELLE, APPAIRÉE, QUI GARDE ENCORE SA CLÉ LEGACY.
   ══════════════════════════════════════════════════════════════════════════ */
const instance = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l82_brevo', env: 'TEST', projectName: 'SB Auto L8.2',
});

let projectId;
let jetonDev;

section('2. Appairage réel, et le projet conserve sa clé Brevo locale');
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
  await instance.heartbeat();

  jetonDev = await instance.managerToken();
  check('un vrai jeton DEV du projet est émis', typeof jetonDev === 'string' && jetonDev.length > 40);

  // COEXISTENCE (phase 2 du lot) : la clé locale reste EN PLACE. Ce lot ne la
  // supprime pas — il cesse simplement de s'en servir pour vérifier.
  const pose = await appelProjet('PUT', '/api/integrated-apis/BREVO/modes/TEST', {
    credentials: { apiKey: CLE_PROJET_LEGACY },
  });
  check('la clé legacy du projet est bien enregistrée chez lui', pose.status === 200);
}

/** Appel HTTP sur la VRAIE surface du Manager, avec un vrai jeton DEV. */
async function appelProjet(method, chemin, corps) {
  const res = await fetch(`${instance.publicBackendUrl}${chemin}`, {
    method,
    headers: {
      authorization: `Bearer ${jetonDev}`,
      ...(corps !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Le bouton « Connexion plateforme Brevo », exactement. */
const testerBrevo = (mode = 'TEST') =>
  appelProjet('POST', `/api/integrated-apis/BREVO/modes/${mode}/test`);

/* ══════════════════════════════════════════════════════════════════════════
   3. SANS OCTROI — le bouton refuse, et NE RETOMBE PAS sur la clé locale.
   ══════════════════════════════════════════════════════════════════════════ */
section('3. Sans octroi : refus NOMMÉ, et aucun repli local');
{
  const avant = appelsBrevo.length;
  const { status, json } = await testerBrevo();

  check('la route répond', status === 200);
  check('le diagnostic est en ÉCHEC', json?.data?.status === 'FAILED');
  check('l’autorité annoncée est la PLATEFORME', json?.data?.authority === 'PANEL');
  check('le message nomme l’octroi manquant',
    /accordé/i.test(json?.data?.message ?? ''));
  check('le code de capacité est conservé',
    json?.data?.details?.capabilityErrorCode === 'CAPABILITY_NOT_GRANTED');

  // LE POINT DUR DU LOT : aucun repli. Un repli aurait appelé Brevo avec la
  // clé locale et affiché « connexion réussie » — le pire des diagnostics.
  check('AUCUN appel Brevo n’a eu lieu', appelsBrevo.length === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. AVEC OCTROI — la clé DU PANEL part, celle du projet ne bouge pas.
   ══════════════════════════════════════════════════════════════════════════ */
section('4. Avec octroi : c’est la clé du Panel qui atteint Brevo');
{
  await grantsModule.setCapabilityGrants(projectId, [VERIFY], ACTEUR);

  const avant = appelsBrevo.length;
  const { status, json } = await testerBrevo();
  const data = json?.data;

  check('la route répond', status === 200);
  check('le diagnostic est un SUCCÈS', data?.status === 'SUCCESS');
  check('le message dit « Connexion plateforme Brevo »',
    /connexion plateforme brevo/i.test(data?.message ?? ''));
  check('le compte lu chez le fournisseur est rendu',
    data?.details?.account === 'L.Y Solution');
  check('l’autorité est la PLATEFORME', data?.authority === 'PANEL');

  check('UN appel Brevo a eu lieu', appelsBrevo.length === avant + 1);
  const appel = appelsBrevo.at(-1);
  check('…c’est la clé du PANEL, monde TEST', appel.apiKey === CLE_PANEL_TEST);
  check('…JAMAIS la clé locale du projet', appel.apiKey !== CLE_PROJET_LEGACY);
  check('…ni celle de l’autre monde', appel.apiKey !== CLE_PANEL_PROD);
  check('…sur la route de lecture de compte', appel.url === '/v3/account');

  check('la réponse rendue à l’écran est PROPRE', propre(json));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LE PROJET NE CHOISIT PAS LE MONDE.
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Demander PROD depuis une instance TEST ne change rien');
{
  const avant = appelsBrevo.length;
  const { json } = await testerBrevo('PROD');
  const data = json?.data;

  check('l’appel aboutit quand même', data?.status === 'SUCCESS');
  check('le monde SERVI est celui de l’instance', data?.details?.environment === 'TEST');
  check('…et le rapport le dit, plutôt que de répéter la demande',
    data?.mode === 'TEST' && data?.details?.requestedMode === 'PROD');
  check('UN appel Brevo, et un seul', appelsBrevo.length === avant + 1);
  check('LA CLÉ PROD N’A JAMAIS ÉTÉ ATTEINTE',
    appelsBrevo.at(-1).apiKey === CLE_PANEL_TEST);
  check('aucun appel du parcours n’a jamais porté la clé PROD',
    appelsBrevo.every((a) => a.apiKey !== CLE_PANEL_PROD));
}

/* ══════════════════════════════════════════════════════════════════════════
   6. L'ÉTAT LOCAL N'EST PAS ESTAMPILLÉ PAR UN TEST QUI NE L'A PAS ÉPROUVÉ.
   ══════════════════════════════════════════════════════════════════════════ */
section('6. Le credential local n’est ni « vérifié », ni infirmé');
{
  const { json } = await appelProjet('GET', '/api/integrated-apis/BREVO');
  const modeTest = json?.data?.modes?.TEST;

  check('le credential local est toujours configuré', modeTest?.configured === true);
  /**
   * LE MENSONGE QU'ON REFUSE D'ÉCRIRE : un « vérifié » daté sur une clé que
   * personne n'a essayée. Un opérateur la croirait bonne, et la garderait.
   */
  check('il n’est PAS marqué vérifié par un test qu’il n’a pas subi',
    modeTest?.verified !== true);
  check('la vue du projet ne contient aucune clé', propre(json));
}

/* ══════════════════════════════════════════════════════════════════════════
   7. PANEL INJOIGNABLE — le diagnostic devient indisponible, PAS faux.
   ══════════════════════════════════════════════════════════════════════════ */
section('7. Panel éteint : le bouton dit qu’il ne peut pas savoir');
{
  await closePanel();

  const avant = appelsBrevo.length;
  const { json } = await testerBrevo();
  const data = json?.data;

  check('le diagnostic est en ÉCHEC', data?.status === 'FAILED');
  check('l’autorité reste la PLATEFORME', data?.authority === 'PANEL');
  check('AUCUN appel Brevo — pas de repli sur la clé locale',
    appelsBrevo.length === avant);
  check('le message ne prétend PAS que Brevo est en panne',
    !/brevo (est )?(en panne|indisponible)/i.test(data?.message ?? ''));
  check('la réponse reste propre', propre(json));
}

/* ══════════════════════════════════════════════════════════════════════════
   8. AUCUN SECRET NULLE PART — la preuve par la base du projet.
   ══════════════════════════════════════════════════════════════════════════ */
section('8. Ni le Panel ni le projet ne laissent fuir une clé');
{
  const dump = await instance.dbDump();
  const texte = JSON.stringify(dump);

  // La clé LEGACY est encore là, chiffrée : ce lot ne la supprime pas (phase 2).
  check('aucune clé du PANEL n’a atterri chez le projet',
    !texte.includes(CLE_PANEL_TEST) && !texte.includes(CLE_PANEL_PROD));
  check('la clé legacy du projet reste CHIFFRÉE, jamais en clair',
    !texte.includes(CLE_PROJET_LEGACY));

  const coffre = await CredentialSet.collection.find({}).toArray();
  check('le coffre du Panel ne contient aucune valeur lisible', propre(coffre));
}

await instance.stop();
await new Promise((resolve) => fauxBrevo.close(resolve));
await stopMemoryMongo();
finish();
