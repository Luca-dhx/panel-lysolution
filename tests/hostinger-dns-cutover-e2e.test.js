// LE DNS D'UN DÉPLOIEMENT, DE BOUT EN BOUT — L9.1, la bascule réelle.
//
// ══ CE QUE CE TEST REFUSE DE RACCOURCIR ══════════════════════════════════════
//
//   · un vrai Panel, sur un vrai port, avec son coffre CHIFFRÉ ;
//   · une vraie instance SB Auto, dans SON processus, avec SA base ;
//   · un vrai appairage, donc un vrai bridgeToken ;
//   · `resolveDnsProvider` RÉEL — la décision de repli comprise ;
//   · `CapabilityDnsProvider` RÉEL, appelé dans l'ORDRE DU MOTEUR ;
//   · un faux Hostinger qui parle HTTP pour de bon, et note QUEL jeton arrive.
//
// Le test n'appelle jamais la passerelle du Panel en direct. Il entre par où
// entre le déploiement : le projet demande un verbe, et l'on regarde ce qui
// ressort chez le fournisseur.
//
// ══ CE QU'IL DOIT PROUVER ════════════════════════════════════════════════════
//
//   1. le DNS d'un déploiement part avec la clé DU PANEL, jamais celle du projet
//   2. le jeu d'identifiants est GLOBAL — sans monde, donc partagé TEST/PROD
//   3. le projet A ne touche pas le domaine de B, et le refus précède l'appel
//   4. resolve → read → ensure, dans cet ordre, et la lecture est réduite
//   5. un silence sur le PUT ne produit NI rejeu, NI repli sur la clé locale
//   6. aucun secret ne traverse le pont, dans aucun sens
//   7. le moteur de déploiement reste l'autorité d'orchestration
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
const JETON_PANEL = 'HOSTINGER-L91-PANEL-GLOBAL-JAMAIS-AILLEURS-0001';
/** La clé que le PROJET détient encore. Elle ne doit plus JAMAIS sortir. */
const JETON_PROJET_LEGACY = 'HOSTINGER-L91-PROJET-LEGACY-QUI-NE-DOIT-PLUS-0002';
const SENTINELLES = [JETON_PANEL, JETON_PROJET_LEGACY];

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const VERBES = ['dns.zone.resolve', 'dns.records.read', 'dns.record.ensure'];

/** Le domaine de CE projet, et celui d'un client voisin du même compte. */
const ZONE = 'garage-e2e.fr';
const ZONE_VOISINE = 'garage-voisin.fr';
const HOTE = `app.${ZONE}`;

const propre = (valeur) => {
  const texte = typeof valeur === 'string' ? valeur : JSON.stringify(valeur ?? null);
  return !SENTINELLES.some((s) => texte.includes(s));
};

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX HOSTINGER QUI PARLE VRAIMENT HTTP.
   C'est la seule façon de constater QUEL jeton sort réellement, et d'où.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
/** Le PUT reste-t-il sans réponse ? — pour éprouver le silence, pas l'erreur. */
let putMuet = false;
const suspendues = new Set();

const fauxHostinger = http.createServer((req, res) => {
  let corps = '';
  req.on('data', (c) => { corps += c; });
  req.on('end', () => {
    const chemin = req.url;
    appels.push({
      methode: req.method,
      chemin,
      jeton: req.headers.authorization ?? null,
      corps: corps ? JSON.parse(corps) : null,
    });

    if (req.method === 'PUT' && putMuet) {
      // AUCUNE réponse. Le silence est la seule façon de produire une issue
      // réellement indécidable : une erreur, elle, prouverait que rien n'a été
      // écrit — et c'est précisément ce qu'on ne peut pas savoir.
      suspendues.add(res);
      return;
    }

    const json = (statut, valeur) => {
      res.writeHead(statut, { 'content-type': 'application/json', 'x-request-id': 'corr-l91' });
      res.end(JSON.stringify(valeur));
    };

    if (chemin === '/api/domains/v1/portfolio') {
      // LE PORTEFEUILLE DU COMPTE : il contient les domaines de TOUS les
      // clients. C'est exactement ce qui ne doit jamais redescendre au projet.
      return json(200, [{ domain: ZONE }, { domain: ZONE_VOISINE }, { domain: 'client-tiers.fr' }]);
    }
    if (req.method === 'GET' && chemin.startsWith('/api/dns/v1/zones/')) {
      return json(200, [
        { name: 'app', type: 'A', ttl: 300, records: [{ content: '9.9.9.9' }] },
        { name: 'autre-client', type: 'A', ttl: 300, records: [{ content: '8.8.8.8' }] },
        { name: '*', type: 'A', ttl: 300, records: [{ content: '7.7.7.7' }] },
      ]);
    }
    if (req.method === 'PUT' && chemin.startsWith('/api/dns/v1/zones/')) {
      return json(200, { message: 'ok' });
    }
    return json(404, { message: 'route non simulée' });
  });
});
await new Promise((resolve) => fauxHostinger.listen(0, '127.0.0.1', resolve));
const HOSTINGER_BASE = `http://127.0.0.1:${fauxHostinger.address().port}`;

const appelsHostinger = () => appels.length;
const dernier = () => appels.at(-1);

/* ══════════════════════════════════════════════════════════════════════════
   LE PANEL RÉEL.
   ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const destinations = await import('../backend/src/services/registry/projectDestination.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const grantsModule = await import('../backend/src/services/capabilities/capabilityGrants.js');
const credentialResolver = await import('../backend/src/services/capabilities/credentialResolver.js');
const capabilityRegistry = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { default: CredentialSet } = await import('../backend/src/models/PanelIntegratedApiCredentialSet.model.js');
const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l91.test' }, { requirePublic: false });

const { base: panelUrl, close: closePanel } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   1. LE COFFRE — UN SEUL JEU, SANS MONDE.
   ══════════════════════════════════════════════════════════════════════════ */
section('1. Le Panel détient UN jeu Hostinger, et il n’a pas d’environnement');
{
  await controlPlane.saveCredentialSet('HOSTINGER', null, {
    values: { apiToken: JETON_PANEL, baseUrl: HOSTINGER_BASE },
  }, ACTEUR);

  const brut = await CredentialSet.collection.find({ provider: 'HOSTINGER' }).toArray();
  check('un seul jeu Hostinger existe', brut.length === 1);
  check('…et il est rangé SANS environnement',
    brut[0].environment === null || brut[0].environment === undefined);
  check('aucun jeton en clair, même au repos', propre(brut));

  /**
   * La passerelle exige un jeu PROUVÉ, pas un jeu saisi. On valide donc comme
   * en exploitation — et l'appel part réellement chez le faux Hostinger.
   */
  const verdict = await controlPlane.validateCredentialSet('HOSTINGER', null, { actor: ACTEUR });
  check('le jeu est validé par un appel RÉEL', verdict.validation.status === 'VALID');
  check('…et c’est le jeton du Panel qui est parti',
    dernier().jeton === `Bearer ${JETON_PANEL}`);
  check('…sur la route du portefeuille', dernier().chemin === '/api/domains/v1/portfolio');
}

/* ══════════════════════════════════════════════════════════════════════════
   2. UNE INSTANCE RÉELLE, APPAIRÉE, QUI GARDE ENCORE SA CLÉ LEGACY.
   ══════════════════════════════════════════════════════════════════════════ */
const instance = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l91_dns', env: 'TEST', projectName: 'SB Auto L9.1',
});

let projectId;
let jetonDev;

section('2. Appairage réel, destination arbitrée, et une clé locale qui traîne');
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
  check('le projet est appairé', typeof projectId === 'string');
  await instance.heartbeat();

  /**
   * LA DESTINATION EST ARBITRÉE CÔTÉ PANEL — c'est toute la doctrine
   * d'appartenance. Le projet ne peut pas se déclarer propriétaire d'un nom :
   * la relation `projectId → hôte` naît ici, et c'est elle qui fera foi.
   */
  /**
   * Le projet possède UN HÔTE DANS la zone, pas la zone entière — c'est le cas
   * qui compte : plusieurs clients partagent `garage-e2e.fr`. Lui donner
   * l'apex rendrait la réduction de lecture invisible, et l'on croirait
   * l'avoir éprouvée.
   */
  await destinations.announceDestination({
    record: await registryStore.getById(projectId),
    urls: {
      website: `https://${HOTE}`,
      manager: `https://manager-${HOTE}`,
      backend: `https://api-${HOTE}`,
    },
    source: 'PRESENTATION',
  });
  const fiche = await registryStore.getById(projectId);
  check('la destination active est l’hôte du projet', fiche.activeNetwork?.host === HOTE);

  jetonDev = await instance.managerToken();
  const pose = await fetch(`${instance.publicBackendUrl}/api/integrated-apis/HOSTINGER/modes/TEST`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${jetonDev}`, 'content-type': 'application/json' },
    body: JSON.stringify({ credentials: { apiToken: JETON_PROJET_LEGACY } }),
  });
  check('la clé Hostinger legacy du projet est bien en place chez lui', pose.status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. SANS OCTROI — le chemin se FERME, il ne retombe pas sur la clé locale.
   ══════════════════════════════════════════════════════════════════════════ */
section('3. Sans octroi : AUCUN repli local — le chemin se ferme');
{
  const avant = appelsHostinger();
  const chemin = await instance.resolveDns({ siteHost: HOTE });

  check('aucun provider n’est retenu', chemin.available === false);
  check('…et surtout PAS la clé locale', chemin.path === 'NONE');
  check('le motif nomme le refus du Panel',
    chemin.reason === 'PANEL_REFUSED:CAPABILITY_NOT_GRANTED');
  check('aucune clé locale n’a été sortie du coffre du projet',
    chemin.apiTokenPresent === false);

  /**
   * LE POINT DUR DU LOT. L'ancienne politique — liste noire — laissait tout ce
   * qui n'était pas nommé retomber sur la clé du projet. Ici le Panel a dit
   * « non » : contourner ce non annulerait le contrôle qu'on vient d'installer.
   */
  check('AUCUN appel Hostinger n’a eu lieu', appelsHostinger() === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. AVEC OCTROI — la clé DU PANEL part, dans l'ORDRE DU MOTEUR.
   ══════════════════════════════════════════════════════════════════════════ */
section('4. Avec octroi : resolve → read → ensure, avec la clé du Panel');
{
  await grantsModule.setCapabilityGrants(projectId, VERBES, ACTEUR);

  const chemin = await instance.resolveDns({ siteHost: HOTE });
  check('la voie du Panel est retenue', chemin.path === 'PANEL_CAPABILITY');
  check('…et le rapport le NOMME', chemin.providerName === 'hostinger (via Panel)');
  check('…sans aucune clé locale', chemin.apiTokenPresent === false);

  const debut = appelsHostinger();
  const { etapes } = await instance.dnsSequence({
    zone: ZONE, name: 'app', type: 'A', content: '1.2.3.4', ttl: 600,
  });

  check('les trois étapes du moteur ont été jouées', etapes.length === 3);
  check('…dans l’ordre : planifier, puis muter',
    etapes.map((e) => e.etape).join('>') === 'findBestZone>listRecords>ensureRecord');
  check('…et toutes réussissent', etapes.every((e) => e.ok));

  check('la zone résolue est celle du projet', etapes[0].data?.zone === ZONE);
  check('…et sa provenance est le portefeuille du compte', etapes[0].data?.source === 'managed');

  /**
   * LA LECTURE EST RÉDUITE. La zone héberge un autre client ; le projet ne doit
   * voir que ses propres hôtes, PLUS la wildcard — dont le moteur a besoin pour
   * constater qu'un hôte est déjà couvert, et sans laquelle il écrirait un
   * enregistrement inutile.
   */
  const noms = (etapes[1].data ?? []).map((r) => r.name).sort();
  check('le projet voit son propre enregistrement', noms.includes('app'));
  check('…et la wildcard', noms.includes('*'));
  check('…mais PAS celui de l’autre client', !noms.includes('autre-client'));
  check('…et rien d’autre', noms.length === 2);

  check('l’écriture est constatée', etapes[2].data?.written === true);
  check('…et porte le corrélat du fournisseur', etapes[2].data?.correlationId === 'corr-l91');

  /* ── CE QUI EST RÉELLEMENT SORTI ─────────────────────────────────────── */
  const sortis = appels.slice(debut);
  check('tous les appels portent le jeton DU PANEL',
    sortis.every((a) => a.jeton === `Bearer ${JETON_PANEL}`));
  check('…et JAMAIS celui du projet',
    sortis.every((a) => a.jeton !== `Bearer ${JETON_PROJET_LEGACY}`));

  const put = sortis.filter((a) => a.methode === 'PUT');
  check('une seule écriture est partie', put.length === 1);
  check('…sur la zone du projet', put[0].chemin === `/api/dns/v1/zones/${ZONE}`);
  check('…avec UN SEUL enregistrement', put[0].corps?.zone?.length === 1);
  check('…nommé RELATIVEMENT à la zone', put[0].corps.zone[0].name === 'app');
  check('…avec le TTL demandé', put[0].corps.zone[0].ttl === 600);
  check('…et un overwrite borné à ce couple', put[0].corps.overwrite === true);

  check('rien de ce qui revient au projet ne porte un secret', propre(etapes));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. PROJET A, DOMAINE B — le refus précède l'appel.
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Un jeton global n’est pas une autorisation globale');
{
  const avant = appelsHostinger();
  const vol = await instance.resolveDns({ siteHost: `app.${ZONE_VOISINE}` });

  check('le domaine du voisin est refusé', vol.available === false);
  check('…et le chemin se ferme, sans repli', vol.path === 'NONE');
  check('…pour appartenance, pas pour panne',
    vol.reason === 'PANEL_REFUSED:CAPABILITY_NOT_GRANTED');
  check('AUCUN appel Hostinger : le refus précède le réseau',
    appelsHostinger() === avant);

  // Le domaine voisin est pourtant AU PORTEFEUILLE du compte : c'est bien
  // l'appartenance, et non l'ignorance, qui a refusé.
  check('le voisin est pourtant géré par le même compte',
    appels.some((a) => a.chemin === '/api/domains/v1/portfolio'));
}

/* ══════════════════════════════════════════════════════════════════════════
   6. LE JEU EST GLOBAL — un projet PROD lirait LE MÊME.
   ══════════════════════════════════════════════════════════════════════════ */
section('6. TEST_AND_PROD_SHARE_GLOBAL_CREDENTIAL — par le résolveur réel');
{
  /**
   * Deux instances vivantes ne peuvent pas le prouver : un Panel sert UN monde
   * (doctrine L2), et un projet PROD appairé à un Panel de recette est refusé
   * avant d'atteindre le moindre credential. On interroge donc le résolveur
   * RÉEL avec les deux contextes, et l'on compare le jeu qu'il désigne.
   */
  const definition = capabilityRegistry.getCapabilityDefinition('dns.record.ensure');
  const enTest = await credentialResolver.resolveCredentialsForCapability(
    { projectId, environment: 'TEST', requestId: 'r1' }, definition,
  );
  const enProd = await credentialResolver.resolveCredentialsForCapability(
    { projectId, environment: 'PROD', requestId: 'r2' }, definition,
  );

  check('TEST et PROD désignent le MÊME jeu',
    enTest.credentialSetId === enProd.credentialSetId);
  check('…dont l’environnement est null, pas « TEST »', enTest.environment === null);
  check('…et le jeton servi est le même', enTest.values.apiToken === enProd.values.apiToken);
  check('…celui du Panel', enTest.values.apiToken === JETON_PANEL);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. LE SILENCE SUR UNE ÉCRITURE — ni rejeu, ni repli.
   ══════════════════════════════════════════════════════════════════════════ */
section('7. Un PUT sans réponse : aucune reprise, aucun retour à la clé locale');
{
  // Chaque déploiement résout son chemin avant d'écrire ; la tentative sur le
  // domaine du voisin, refusée, n'a laissé aucun provider derrière elle.
  const rouvert = await instance.resolveDns({ siteHost: HOTE });
  check('le chemin est de nouveau celui du Panel', rouvert.path === 'PANEL_CAPABILITY');

  putMuet = true;
  const debut = appelsHostinger();

  const { etapes } = await instance.dnsSequence({
    zone: ZONE, name: 'app', type: 'A', content: '5.6.7.8', ttl: 600,
  });
  const ensure = etapes.find((e) => e.etape === 'ensureRecord');

  check('l’écriture n’aboutit pas', ensure?.ok === false);
  check('…et n’est PAS déclarée rejouable', ensure?.retryable === false);

  const put = appels.slice(debut).filter((a) => a.methode === 'PUT');
  check('UNE seule écriture est partie, malgré le silence', put.length === 1);
  check('…et elle portait le jeton du Panel', put[0].jeton === `Bearer ${JETON_PANEL}`);

  /**
   * ET LE PROJET NE REPREND PAS LA MAIN. Une résolution demandée après
   * l'incident ne doit pas rouvrir la voie locale : l'écriture a peut-être eu
   * lieu, et la rejouer par un autre chemin la doublerait.
   */
  putMuet = false;
  for (const suspendue of suspendues) { try { suspendue.destroy(); } catch { /* déjà partie */ } }
  suspendues.clear();

  const apres = await instance.resolveDns({ siteHost: HOTE });
  check('la voie du Panel reste la voie retenue', apres.path === 'PANEL_CAPABILITY');
  check('…et aucune clé locale n’a jamais été sortie', apres.apiTokenPresent === false);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. AUCUN SECRET NE TRAVERSE, DANS AUCUN SENS.
   ══════════════════════════════════════════════════════════════════════════ */
section('8. NO_SECRET_BRIDGE — ni descendant, ni remontant');
{
  const dump = await instance.dbDump();
  const texte = JSON.stringify(dump);
  check('le jeton du PANEL n’est jamais arrivé dans la base du projet',
    !texte.includes(JETON_PANEL));

  // La clé legacy du projet est encore chez lui — chiffrée, et c'est normal :
  // ce lot cesse de s'en servir, il ne la supprime pas.
  check('…et sa propre clé n’y est pas en clair non plus',
    !texte.includes(JETON_PROJET_LEGACY));

  const jetons = new Set(appels.map((a) => a.jeton));
  check('UN SEUL jeton a jamais atteint Hostinger',
    jetons.size === 1 && jetons.has(`Bearer ${JETON_PANEL}`));
}

/* ══════════════════════════════════════════════════════════════════════════
   9. LE MOTEUR RESTE L'AUTORITÉ D'ORCHESTRATION.
   ══════════════════════════════════════════════════════════════════════════ */
section('9. DEPLOYMENT_ENGINE_REMAINS_AUTHORITY — le provider n’orchestre rien');
{
  const fs = await import('node:fs');
  const { SBAUTO_BACKEND } = await import('./helpers/sbauto-remote.js');
  const lire = (rel) => fs.readFileSync(`${SBAUTO_BACKEND}/${rel}`, 'utf8');
  const sansCommentaires = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  const provider = sansCommentaires(lire('src/integrations/hostinger/capabilityDnsProvider.js'));
  check('le provider ne connaît aucune notion de conflit', !/conflict/i.test(provider));
  check('…ni de plan', !/dnsPlan|dryRun/.test(provider));
  check('…et n’importe pas le moteur', !/DeploymentEngine/.test(provider));

  /**
   * L'INTERFACE EST RESPECTÉE À LA LETTRE — c'est la couture qui permet de
   * changer de chemin sans toucher au pipeline. Une méthode manquante ne se
   * verrait qu'au milieu de la phase DNS d'un déploiement réel.
   */
  const base = sansCommentaires(lire('src/deployment-engine/dns/DnsProvider.js'));
  const attendues = [...base.matchAll(/async (\w+)\(/g)].map((m) => m[1]);
  check('toutes les méthodes de l’interface sont implémentées',
    attendues.every((m) => new RegExp(`async ${m}\\(`).test(provider)));
  check('…y compris findBestZone, que la classe de base documente',
    /async findBestZone\(/.test(provider));

  // Le contrôleur passe le provider au moteur — il ne pilote pas le DNS.
  const controleur = sansCommentaires(lire('src/controllers/deployment.controller.js'));
  check('le contrôleur INJECTE le provider, il ne l’appelle pas',
    /dnsProvider: hz\.available \? hz\.provider : null/.test(controleur)
    && !/hz\.provider\.(ensureRecord|listRecords|findBestZone)/.test(controleur));
}

await instance.stop();
await closePanel();
await new Promise((resolve) => fauxHostinger.close(resolve));
await stopMemoryMongo();
finish();
