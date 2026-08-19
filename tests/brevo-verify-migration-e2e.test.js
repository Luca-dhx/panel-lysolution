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
//   4. Panel absent ou refus du Panel → aucun repli sur la clé locale ;
//   5. le projet n'expose PLUS AUCUNE surface de credential fournisseur ;
//   6. aucun secret, d'aucun côté, dans aucune réponse ni aucune base.
//
// ══ CE QUI A CHANGÉ DEPUIS L'ÉCRITURE DE CETTE SUITE ════════════════════════
//
// Elle éprouvait une COEXISTENCE : le projet gardait une clé Brevo locale, et
// l'on prouvait qu'elle ne servait jamais. Le lot L6.4 a supprimé la clé ET sa
// surface — `/api/integrated-apis/*` n'existe plus, le bouton « Connexion
// plateforme Brevo » non plus.
//
// L'invariant n'a pas disparu : il est devenu STRUCTUREL. On ne prouve donc
// plus « la clé locale n'est pas lue » mais « il n'y a plus de clé locale à
// lire, ni de porte par où en poser une ». La chaîne réelle est éprouvée par
// le seul chemin qui subsiste — l'envoi d'un modèle, qui traverse la capacité
// du Panel — et c'est celui qu'un opérateur actionne aujourd'hui.
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
/**
 * LA CLÉ QUE LE PROJET DÉTENAIT — sentinelle historique, conservée à dessein.
 *
 * Plus rien ne peut la poser : la surface a disparu. On la garde comme motif
 * de fuite : si elle réapparaissait un jour dans une réponse ou une base, ce
 * serait qu'une surface locale a été rouverte.
 */
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

  /**
   * ══ LA SURFACE LOCALE N'EXISTE PLUS — ET C'EST LA PREUVE LA PLUS FORTE ════
   *
   * Cette section posait une clé Brevo dans le projet pour prouver ensuite
   * qu'elle ne servait pas. Depuis L6.4 il n'y a plus de clé NI DE PORTE : on
   * vérifie donc que la porte est bien murée. Un 404 ici vaut mieux que tous
   * les « elle n'a pas servi » du monde — on ne peut pas mal utiliser ce qui
   * n'existe pas.
   */
  const pose = await appelProjet('PUT', '/api/integrated-apis/BREVO/modes/TEST', {
    credentials: { apiKey: CLE_PROJET_LEGACY },
  });
  check('le projet n’expose AUCUNE surface d’écriture de credential', pose.status === 404);

  const lecture = await appelProjet('GET', '/api/integrated-apis/BREVO');
  check('…ni de surface de LECTURE', lecture.status === 404);
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

/**
 * CE QUE LE BOUTON FAISAIT, ET QUI EXISTE TOUJOURS.
 *
 * L'écran « Connexion plateforme Brevo » a disparu avec la surface locale de
 * credentials (L6.4) : sa route n'existe plus, et le service qui la servait
 * n'a plus d'appelant. Ce qu'il FAISAIT, en revanche, n'a pas bougé d'un
 * octet — il invoquait `email.sender.verify` auprès du Panel, avec le jeton de
 * pont du projet.
 *
 * On invoque donc cette capacité DEPUIS L'INSTANCE DU PROJET, dans son
 * processus, avec son jeton réel. C'est le même trajet, la même clé, la même
 * question : « laquelle sort ? ». Ce que le test perd, c'est le rendu d'écran ;
 * ce qu'il garde, c'est tout ce qui touche aux secrets.
 */
async function verifierExpediteur() {
  return instance.invokeCapability({
    code: VERIFY,
    input: { operationId: `verify-${Date.now()}-${Math.random().toString(16).slice(2, 10)}` },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LE BOUTON MARCHE SANS RIEN ACCORDER — et la clé locale reste inerte.
   ══════════════════════════════════════════════════════════════════════════ */
section('3. La capacité atteint Brevo avec la clé DU PANEL');
{
  /**
   * ── CE QUE CETTE SECTION PROUVAIT, ET CE QU'ELLE PROUVE MAINTENANT ────────
   *
   * Elle a déjà survécu à la suppression des octrois. Elle survit à celle de la
   * surface locale. Ce qui reste est l'invariant réel du lot, et il n'a jamais
   * changé : le succès vient de la clé DU PANEL, et aucune clé de projet
   * n'atteint le fournisseur.
   */
  const avant = appelsBrevo.length;
  const resultat = await verifierExpediteur();

  check('la capacité répond', Boolean(resultat));
  check('elle n’est pas refusée', resultat?.outcome !== 'REFUSED');

  const sortis = appelsBrevo.slice(avant);
  check('un appel Brevo a bien eu lieu', sortis.length >= 1);
  check('…avec la clé du PANEL', sortis.every((a) => a.apiKey === CLE_PANEL_TEST));
  check('…et JAMAIS la clé locale du projet',
    sortis.every((a) => a.apiKey !== CLE_PROJET_LEGACY));
  check('…ni celle de l’autre monde',
    sortis.every((a) => a.apiKey !== CLE_PANEL_PROD));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. AVEC OCTROI — la clé DU PANEL part, celle du projet ne bouge pas.
   ══════════════════════════════════════════════════════════════════════════ */
section('4. Le monde et la route sont ceux du PANEL, pas ceux du projet');
{
  /**
   * Les octrois n'existent plus, le monde ne se demande plus : ce qui reste à
   * établir est que l'appel sortant est bien celui du Panel — sa clé, son
   * monde, sa route de lecture de compte — et qu'il est UNIQUE. Un second
   * appel signifierait un repli quelque part, et c'est exactement ce qu'on
   * traque depuis le début de cette suite.
   */
  const avant = appelsBrevo.length;
  const resultat = await verifierExpediteur();

  check('la capacité répond', Boolean(resultat));
  check('UN SEUL appel Brevo a eu lieu', appelsBrevo.length === avant + 1);

  const appel = appelsBrevo.at(-1);
  check('…c’est la clé du PANEL, monde TEST', appel.apiKey === CLE_PANEL_TEST);
  check('…JAMAIS la clé locale du projet', appel.apiKey !== CLE_PROJET_LEGACY);
  check('…ni celle de l’autre monde', appel.apiKey !== CLE_PANEL_PROD);
  check('…sur la route de lecture de compte', appel.url === '/v3/account');

  check('le résultat rendu au projet est PROPRE', propre(resultat));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LE PROJET NE CHOISIT PAS LE MONDE.
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Le monde ne se demande plus — il n’y a plus de paramètre pour cela');
{
  /**
   * La section précédente envoyait `mode=PROD` sur la route du projet, et
   * vérifiait que le Panel l'ignorait. Cette route n'existe plus, et avec elle
   * le paramètre : le monde est désormais celui du RUNTIME du Panel, sans
   * qu'aucun appelant puisse le nommer. La garde devient donc structurelle.
   */
  check('aucune clé PROD n’a jamais atteint le fournisseur',
    appelsBrevo.every((a) => a.apiKey !== CLE_PANEL_PROD));
  check('toutes les clés sorties sont celle du monde TEST',
    appelsBrevo.every((a) => a.apiKey === null || a.apiKey === CLE_PANEL_TEST));
}

/* ══════════════════════════════════════════════════════════════════════════
   6. L'ÉTAT LOCAL N'EST PAS ESTAMPILLÉ PAR UN TEST QUI NE L'A PAS ÉPROUVÉ.
   ══════════════════════════════════════════════════════════════════════════ */
section('6. Il n’y a plus d’état local de credential à estampiller');
{
  /**
   * On refusait d'écrire « vérifié » sur une clé que personne n'avait essayée.
   * Le mensonge est devenu impossible à formuler : l'état local n'existe plus.
   * On vérifie donc que la surface qui le portait a bien disparu, plutôt que
   * de vérifier la valeur d'un champ qui n'a plus de support.
   */
  const { status, json } = await appelProjet('GET', '/api/integrated-apis/BREVO');
  check('la surface d’état des credentials n’existe plus', status === 404);
  check('sa réponse ne contient aucune sentinelle', propre(json));
}

/* ══════════════════════════════════════════════════════════════════════════
   7. PANEL INJOIGNABLE — le diagnostic devient indisponible, PAS faux.
   ══════════════════════════════════════════════════════════════════════════ */
section('7. Panel éteint : AUCUN repli, et le refus le dit');
{
  /**
   * ══ LA SECTION LA PLUS IMPORTANTE DE TOUTE LA SUITE ══════════════════════
   *
   * C'est ici que se jouait le vrai risque du lot d'origine : un Panel
   * injoignable, et un projet qui « se débrouille » avec sa clé locale. L'écran
   * aurait affiché un vert obtenu par le chemin qu'on venait de fermer.
   *
   * La clé locale n'existe plus, mais la garde reste indispensable : elle
   * vérifie qu'AUCUN appel ne part quand le Panel est éteint. Un repli qui
   * réapparaîtrait — clé d'environnement, valeur codée en dur, cache — se
   * verrait ici, et nulle part ailleurs.
   */
  await closePanel();

  const avant = appelsBrevo.length;
  const resultat = await verifierExpediteur().catch((err) => ({ erreur: err?.code ?? String(err) }));

  check('AUCUN appel Brevo — aucun repli, d’aucune sorte',
    appelsBrevo.length === avant);
  check('le projet n’obtient pas un succès fabriqué',
    !resultat || resultat.outcome !== 'SUCCEEDED');
  check('la réponse reste propre', propre(resultat));
}

/* ══════════════════════════════════════════════════════════════════════════
   8. AUCUN SECRET NULLE PART — la preuve par la base du projet.
   ══════════════════════════════════════════════════════════════════════════ */
section('8. Ni le Panel ni le projet ne laissent fuir une clé');
{
  const dump = await instance.dbDump();
  const texte = JSON.stringify(dump);

  check('aucune clé du PANEL n’a atterri chez le projet',
    !texte.includes(CLE_PANEL_TEST) && !texte.includes(CLE_PANEL_PROD));
  /**
   * La sentinelle legacy ne peut plus être posée — la surface a disparu (L6.4).
   * On la cherche quand même : sa réapparition signifierait qu'une surface
   * locale a été rouverte quelque part.
   */
  check('aucune clé de projet, en clair ou non', !texte.includes(CLE_PROJET_LEGACY));

  const coffre = await CredentialSet.collection.find({}).toArray();
  check('le coffre du Panel ne contient aucune valeur lisible', propre(coffre));
}

await instance.stop();
await new Promise((resolve) => fauxBrevo.close(resolve));
await stopMemoryMongo();
finish();
