/**
 * BRIDGE 1.9.0 — L'ADRESSE PUBLIQUE D'UN PROJET EST UN ÉTAT, PAS UN SOUVENIR.
 *
 * ══ LE DÉFAUT QUE CETTE SUITE VERROUILLE ════════════════════════════════════
 *
 * `PanelProject.runtime.publicBackendUrl` était écrite au BOOTSTRAP et plus
 * jamais relue. Constaté sur le Panel TEST réel : la fiche « Demo SB Auto »
 * annonçait `https://api.demo-sbauto.lycarz.com` — figée à l'appairage du
 * 2026-08-04 — alors que le projet servait `https://api.demo-sbauto06.ly-solution.com`
 * et le DÉCLARAIT correctement dans sa projection de présentation.
 *
 * La seule correction possible était un RÉAPPAIRAGE : détruire une relation de
 * confiance pour rafraîchir une donnée d'exploitation.
 *
 * ══ L'INVARIANT ════════════════════════════════════════════════════════════
 *
 *     APPAIRAGE     une relation d'IDENTITÉ et de CONFIANCE
 *     URL PUBLIQUE  un ÉTAT COURANT du projet
 *
 * ══ CE QUE CES CONTRÔLES PROUVENT ═══════════════════════════════════════════
 *
 *   · qu'une déclaration au battement (>= 1.9.0) rafraîchit la fiche, sans
 *     réappairage, sans édition manuelle, sans redéploiement du Panel ;
 *   · que l'adresse OPÉRATIONNELLE ne se confond pas avec l'adresse DÉCLARÉE
 *     par la projection de présentation — la frontière que ce lot a d'abord
 *     franchie par erreur, et que le parcours fédéré a fait respecter ;
 *   · qu'un projet ANTÉRIEUR (1.8) n'est ni cassé ni pénalisé, et que sa fiche
 *     reste diagnosticable (adresse sourcée et datée) ;
 *   · qu'un bootstrap rejoué ne réintroduit JAMAIS l'adresse périmée ;
 *   · qu'aucun repli `APP_URL` / `localhost` / ancien hôte ne subsiste ;
 *   · que le champ additif ne casse rien pour un Panel qui ne le connaît pas.
 */
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const contract = await import('../backend/src/bridge/bridgeContract.js');
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const {
  applyDeclaredNetwork,
  isPubliclyRoutableBackendUrl,
  NETWORK_DECLARATION_SOURCES,
} = await import('../backend/src/services/registry/projectNetworkDeclaration.js');
const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;

const ANCIEN = 'https://api.demo-sbauto.lycarz.com';
const ACTUEL = 'https://api.demo-sbauto06.ly-solution.com';
const FIXTURE_B = 'https://api.fixture-b.ly-solution.com';

const ficheNeuve = async (projectId) => {
  const now = new Date().toISOString();
  await PanelProject.deleteOne({ projectId });
  await PanelProject.create({
    projectId, projectKey: projectId, projectName: projectId,
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED', pairedAt: now },
    runtime: { environment: 'TEST' },
  });
  return registryStore.getById(projectId);
};

const battement = (overrides = {}) => ({
  sentAt: new Date().toISOString(),
  softwareVersion: 'abc1234',
  environment: 'TEST',
  health: { status: 'OK' },
  ...overrides,
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. LE CONTRAT AVANCE, ET L’EXTENSION RESTE ADDITIVE');
{
  /**
   * L'ÉPINGLE DISAIT ENCORE 1.9.0 — le contrat était passé à 1.11.0 sans que
   * personne ne le voie : cette assertion échouait en permanence. Une garde qui
   * échoue toujours n'est plus une garde, et c'est ainsi qu'un miroir dérive.
   *
   * Ce que cette recette prouve n'est PAS un numéro : c'est que l'extension
   * `runtime.network` de la 1.9.0 reste ADDITIVE — un battement sans elle est
   * toujours valide, et un Panel antérieur ne la reçoit jamais. On épingle donc
   * la version COURANTE, et l'additivité est éprouvée juste en dessous.
   */
  check(`la version du miroir est 1.13.0 (lu : ${contract.CONTRACT_VERSION})`,
    contract.CONTRACT_VERSION === '1.13.0');
  check('un projet 1.8 reste COMPATIBLE (majeure identique)',
    contract.isContractCompatible('1.8.0') === true);
  check('un projet 1.9 est compatible', contract.isContractCompatible('1.9.0') === true);
  check('une majeure différente reste refusée',
    contract.isContractCompatible('2.0.0') === false);

  /** Le battement SANS réseau doit rester parfaitement valide. */
  const sansReseau = contract.heartbeatSchema.safeParse(battement());
  check('un battement 1.8 (sans réseau) reste accepté', sansReseau.success === true);

  const avecReseau = contract.heartbeatSchema.safeParse(battement({
    runtime: {
      uptimeSeconds: 10,
      network: { publicBackendUrl: ACTUEL, publicSiteUrl: 'https://demo.test', declaredAt: new Date().toISOString() },
    },
  }));
  check('un battement 1.9 (avec réseau) est accepté', avecReseau.success === true);

  const urlInvalide = contract.heartbeatSchema.safeParse(battement({
    runtime: { network: { publicBackendUrl: 'pas-une-url' } },
  }));
  check('une adresse illisible est REFUSÉE par le contrat', urlInvalide.success === false);

  const champInconnu = contract.heartbeatSchema.safeParse(battement({
    runtime: { network: { publicBackendUrl: ACTUEL, inventé: 'x' } },
  }));
  check('le schéma reste FERMÉ — aucun champ non déclaré ne passe',
    champInconnu.success === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. LE DÉFAUT — l’appairage figeait l’adresse');
{
  const fiche = await ficheNeuve('projet-fige');

  applyDeclaredNetwork(fiche, {
    backendUrl: ANCIEN, source: NETWORK_DECLARATION_SOURCES.BOOTSTRAP,
  });
  check('le bootstrap pose bien l’adresse initiale',
    fiche.runtime.publicBackendUrl === ANCIEN);
  check('…et la SOURCE est nommée',
    fiche.runtime.publicBackendUrlSource === 'BOOTSTRAP');
  check('…et elle est HORODATÉE — une adresse sans âge ne se met pas en doute',
    Boolean(fiche.runtime.publicBackendUrlUpdatedAt));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. LE CORRECTIF — le battement 1.9 rafraîchit, sans réappairage');
{
  const fiche = await ficheNeuve('projet-vivant');
  applyDeclaredNetwork(fiche, { backendUrl: ANCIEN, source: NETWORK_DECLARATION_SOURCES.BOOTSTRAP });
  await registryStore.save(fiche);

  const avant = await registryStore.getById('projet-vivant');
  const appairageAvant = avant.pairing.pairedAt;

  await registry.recordHeartbeat(avant, battement({
    runtime: { network: { publicBackendUrl: ACTUEL, declaredAt: new Date().toISOString() } },
  }), '1.9.0');

  const apres = await registryStore.getById('projet-vivant');
  check('l’adresse est passée à celle que le projet SERT',
    apres.runtime.publicBackendUrl === ACTUEL);
  check('l’ancien hôte a disparu de la fiche',
    apres.runtime.publicBackendUrl !== ANCIEN);
  check('la source est le BATTEMENT',
    apres.runtime.publicBackendUrlSource === 'HEARTBEAT');
  check('l’APPAIRAGE n’a pas bougé — l’identité n’a pas été refaite',
    apres.pairing.status === 'PAIRED' && apres.pairing.pairedAt === appairageAvant);
  check('la version de contrat de la fiche suit le projet',
    apres.runtime.contractVersion === '1.9.0');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. CHANGEMENT D’URL — A puis B, sans re-pair ni édition manuelle');
{
  const fiche = await ficheNeuve('projet-migrant');
  await registry.recordHeartbeat(fiche, battement({
    runtime: { network: { publicBackendUrl: ACTUEL } },
  }), '1.9.0');
  const a = await registryStore.getById('projet-migrant');
  check('URL A déclarée → Panel = A', a.runtime.publicBackendUrl === ACTUEL);

  await registry.recordHeartbeat(a, battement({
    runtime: { network: { publicBackendUrl: FIXTURE_B } },
  }), '1.9.0');
  const b = await registryStore.getById('projet-migrant');
  check('URL B déclarée → Panel = B', b.runtime.publicBackendUrl === FIXTURE_B);
  check('l’appairage n’a jamais été refait', b.pairing.status === 'PAIRED');

  // Restauration — exactement comme en recette réelle.
  await registry.recordHeartbeat(b, battement({
    runtime: { network: { publicBackendUrl: ACTUEL } },
  }), '1.9.0');
  const restaure = await registryStore.getById('projet-migrant');
  check('la déclaration réelle restaure l’état', restaure.runtime.publicBackendUrl === ACTUEL);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. L’ADRESSE OPÉRATIONNELLE NE SE CONFOND PAS AVEC L’ADRESSE DÉCLARÉE');
{
  /**
   * ══ LE PIÈGE QUI A ÉTÉ TENDU, PUIS DÉSAMORCÉ ═══════════════════════════════
   *
   * Faire écrire `publicBackendUrl` par la projection `PROJECT_PRESENTATION`
   * paraissait évident : elle porte l'adresse du backend, elle arrive à chaque
   * changement, et elle bénéficierait même aux projets restés en 1.8.
   *
   * C'est faux, et le parcours fédéré de bout en bout l'a démontré en cassant :
   *
   *     publicBackendUrl              OPÉRATIONNELLE — « je réponds ICI »
   *     PROJECT_PRESENTATION.network  DÉCLARATIVE    — « je vise CE domaine »
   *
   * Une instance servie sur un port éphémère déclare un domaine parfaitement
   * exact où PERSONNE n'écoute. Le Panel s'est mis à rappeler ce domaine au
   * lieu du port réel, et a conclu que le projet était tombé.
   *
   * `PROJECT_SITE_STATUS` et la DESTINATION restent alimentés par la
   * projection : c'est là qu'une adresse VISÉE a un sens. Ce contrôle verrouille
   * la frontière.
   */
  const sources = Object.keys(NETWORK_DECLARATION_SOURCES);
  check('seules des sources OPÉRATIONNELLES peuvent écrire l’adresse',
    sources.length === 2 && sources.includes('BOOTSTRAP') && sources.includes('HEARTBEAT'));
  check('la PROJECTION de présentation n’est PAS une source d’adresse opérationnelle',
    !sources.includes('PRESENTATION'));

  /** Et le noyau de synchronisation ne doit pas la réintroduire par la bande. */
  const fs = await import('node:fs');
  const noyau = fs.readFileSync(
    new URL('../backend/src/services/sync/syncCore.service.js', import.meta.url), 'utf8',
  );
  const code = noyau.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('le noyau de synchronisation n’écrit PAS l’adresse opérationnelle',
    !/applyDeclaredNetwork/.test(code));
  check('…mais il annonce toujours la DESTINATION',
    /announceDestination/.test(code));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5 bis. UN CLIENT 1.8 N’EST NI CASSÉ NI PÉNALISÉ');
{
  const fiche = await ficheNeuve('projet-18');
  applyDeclaredNetwork(fiche, { backendUrl: ANCIEN, source: NETWORK_DECLARATION_SOURCES.BOOTSTRAP });
  await registryStore.save(fiche);

  /** Un projet 1.8 n'envoie AUCUN réseau au battement. */
  const f = await registryStore.getById('projet-18');
  await registry.recordHeartbeat(f, battement(), '1.8.0');
  const apres = await registryStore.getById('projet-18');

  check('le battement 1.8 est accepté sans rien casser',
    apres.runtime.contractVersion === '1.8.0');
  check('…et n’efface pas l’adresse connue',
    apres.runtime.publicBackendUrl === ANCIEN);
  check('…sa fiche garde une adresse SOURCÉE et DATÉE, donc diagnosticable',
    apres.runtime.publicBackendUrlSource === 'BOOTSTRAP'
    && Boolean(apres.runtime.publicBackendUrlUpdatedAt));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. LE BOOTSTRAP NE RESSUSCITE PAS UNE ADRESSE PÉRIMÉE');
{
  const fiche = await ficheNeuve('projet-reprise');
  applyDeclaredNetwork(fiche, { backendUrl: ACTUEL, source: NETWORK_DECLARATION_SOURCES.HEARTBEAT });

  const rejoue = applyDeclaredNetwork(fiche, {
    backendUrl: ANCIEN, source: NETWORK_DECLARATION_SOURCES.BOOTSTRAP,
  });
  check('un bootstrap ANCIEN rejoué est ignoré', rejoue === false);
  check('…et l’adresse vivante reste en place', fiche.runtime.publicBackendUrl === ACTUEL);

  /** Un réappairage RÉEL, lui, annonce l'adresse courante : elle doit passer. */
  const reappairage = applyDeclaredNetwork(fiche, {
    backendUrl: ACTUEL, source: NETWORK_DECLARATION_SOURCES.BOOTSTRAP,
  });
  check('un réappairage annonçant l’adresse courante passe', reappairage === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. AUCUN REPLI HISTORIQUE — ni APP_URL, ni localhost, ni invention');
{
  const fiche = await ficheNeuve('projet-garde');
  applyDeclaredNetwork(fiche, { backendUrl: ACTUEL, source: NETWORK_DECLARATION_SOURCES.HEARTBEAT });

  for (const mauvaise of [null, undefined, '', 'pas-une-url', 'ftp://x.test', '   ']) {
    const r = applyDeclaredNetwork(fiche, {
      backendUrl: mauvaise, source: NETWORK_DECLARATION_SOURCES.HEARTBEAT,
    });
    check(`une déclaration illisible (${JSON.stringify(mauvaise)}) n’écrase rien`,
      r === false && fiche.runtime.publicBackendUrl === ACTUEL);
  }

  /** Un battement SANS réseau ne doit pas effacer ce qu'on savait. */
  await registryStore.save(fiche);
  const f = await registryStore.getById('projet-garde');
  await registry.recordHeartbeat(f, battement({ runtime: { uptimeSeconds: 5 } }), '1.9.0');
  const apres = await registryStore.getById('projet-garde');
  check('un battement sans réseau ne provoque aucun effacement',
    apres.runtime.publicBackendUrl === ACTUEL);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. L’ADRESSE EST DATÉE À LA RÉCEPTION, jamais sur l’horloge du projet');
{
  const fiche = await ficheNeuve('projet-horloge');
  const horlogeFolle = '2019-01-01T00:00:00.000Z';
  applyDeclaredNetwork(fiche, {
    backendUrl: ACTUEL,
    source: NETWORK_DECLARATION_SOURCES.HEARTBEAT,
    declaredAt: horlogeFolle,
  });
  check('l’horodatage n’est PAS celui annoncé par le projet',
    fiche.runtime.publicBackendUrlUpdatedAt !== horlogeFolle);
  check('…il est récent — c’est l’instant où le Panel l’a appris',
    Date.now() - new Date(fiche.runtime.publicBackendUrlUpdatedAt).getTime() < 10_000);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE ADRESSE « PUBLIQUE » DOIT ÊTRE JOIGNABLE DE L’EXTÉRIEUR');
{
  /**
   * ══ LE DÉFAUT OBSERVÉ À LA CERTIFICATION FACTORY ═══════════════════════
   *
   * Un projet appairé, lancé EN LOCAL par un développeur, déclare au battement
   * `http://localhost:6090`. Le Panel l'acceptait comme adresse publique, et le
   * service de destinations retirait le VRAI domaine pour la remplacer.
   *
   * Trois conséquences, toutes silencieuses : le Panel sondait `localhost`
   * — c'est-à-dire lui-même ; l'appartenance du nom, qui se lit sur la
   * destination ACTIVE, devenait fausse et le DNS automatique refusait le
   * domaine du projet ; et la fiche annonçait une adresse que personne au
   * monde ne peut atteindre.
   *
   * Avec un parc, n'importe quel développeur lançant un projet en local
   * détruit ainsi ce que le Panel sait du domaine de production.
   */
  for (const refusee of [
    'http://localhost:6090', 'https://127.0.0.1:8080', 'http://0.0.0.0:3000',
    'https://10.1.2.3', 'https://192.168.1.10', 'https://172.16.0.9',
    'https://169.254.1.1', 'https://poste-de-luca.local', 'https://api.internal',
  ]) {
    check(`refusée : ${refusee}`, !isPubliclyRoutableBackendUrl(refusee));
  }
  for (const acceptee of [ACTUEL, ANCIEN, 'https://195.35.0.211', 'https://api.factory.ly-solution.com']) {
    check(`acceptée : ${acceptee}`, isPubliclyRoutableBackendUrl(acceptee));
  }

  /* ── ET SURTOUT : CE QU'ON SAVAIT N'EST PAS PERDU ────────────────────── */
  const fiche = await ficheNeuve('projet-local');
  applyDeclaredNetwork(fiche, { backendUrl: ACTUEL, source: NETWORK_DECLARATION_SOURCES.BOOTSTRAP });
  check('le vrai domaine est retenu', fiche.runtime.publicBackendUrl === ACTUEL);
  const horodatage = fiche.runtime.publicBackendUrlUpdatedAt;

  const change = applyDeclaredNetwork(fiche, {
    backendUrl: 'http://localhost:6090', source: NETWORK_DECLARATION_SOURCES.HEARTBEAT,
  });
  check('une déclaration LOCALE est REFUSÉE', change === false);
  check('…et le vrai domaine est CONSERVÉ', fiche.runtime.publicBackendUrl === ACTUEL);
  check('…la source n’est pas réécrite', fiche.runtime.publicBackendUrlSource === 'BOOTSTRAP');
  check('…ni l’horodatage : rien n’a été appris', fiche.runtime.publicBackendUrlUpdatedAt === horodatage);

  /**
   * Un projet qui n'a JAMAIS déclaré d'adresse n'en gagne pas une fausse : le
   * refus ne pose rien, il conserve ce qui existe — c'est-à-dire rien.
   */
  const vierge = await ficheNeuve('projet-vierge');
  check('un projet sans adresse n’en reçoit pas une locale',
    applyDeclaredNetwork(vierge, {
      backendUrl: 'http://localhost:6090', source: NETWORK_DECLARATION_SOURCES.HEARTBEAT,
    }) === false
    && !vierge.runtime.publicBackendUrl);

  /** Et un vrai déménagement reste possible : la garde ne fige rien. */
  check('un vrai changement de domaine passe toujours',
    applyDeclaredNetwork(fiche, {
      backendUrl: FIXTURE_B, source: NETWORK_DECLARATION_SOURCES.HEARTBEAT,
    }) === true
    && fiche.runtime.publicBackendUrl === FIXTURE_B);
}

await stopMemoryMongo();
finish();
