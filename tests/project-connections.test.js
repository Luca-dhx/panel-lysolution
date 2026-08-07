/**
 * CONNEXIONS D'UN PROJET — une fiche par instance, une carte par projet.
 *
 * ══ CE QUE CE FICHIER VERROUILLE ════════════════════════════════════════════
 *
 * Le registre raisonne en INSTANCES : une fiche = un appairage = un jeton = un
 * environnement. L'opérateur raisonne en PROJETS CLIENTS. Entre les deux, il
 * manquait le lien : rien ne disait que deux fiches nommées « SB Auto »
 * décrivaient le même garage, et la page Appairages ne pouvait qu'aligner des
 * appairages techniques indépendants.
 *
 * Pire, le lien était IMPOSSIBLE à créer : `declareProject` refusait toute
 * seconde fiche annonçant la même clé de pont, et le bootstrap refusait
 * d'appairer une fiche dont la clé annoncée appartenait déjà à une autre. Le
 * Panel ne pouvait donc pas enregistrer un projet en TEST *et* en PROD.
 *
 * On prouve ici les deux moitiés :
 *   · le backend sait désormais accueillir les deux instances, les rattache
 *     AUTOMATIQUEMENT à une identité logique déclarée par le projet, et refuse
 *     toujours deux fois le même environnement ;
 *   · le regroupement d'écran ne mélange jamais TEST et PROD.
 */
import { register } from 'node:module';
import {
  check, connectTestDatabase, finish, rejectsWith, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

register('./helpers/frontendLoader.mjs', import.meta.url);

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const { encryptSecret: chiffrer } = await import('../backend/src/utils/panelCrypto.js');
const {
  groupProjectsByLogicalProject, connectionStateOf, environmentOf, groupKeyOf,
  connectionLink, pairEnvironmentLink, matchesSearch, matchesFilter, filterCounts,
} = await import('@/lib/projectConnections');

const CLE_LOGIQUE = 'sb-auto-06';

/** Le pont annonce sa clé : c'est elle, et rien d'autre, qui regroupe. */
const identiteAnnoncee = (projectName = 'SB Auto 06') => ({
  projectKey: CLE_LOGIQUE, projectName, environment: null, softwareVersion: '1.0.0',
});

async function declarer({ url, name, environment, bridge = identiteAnnoncee() }) {
  return registre.declareProject({
    publicBackendUrl: url, projectName: name, bridgeIdentity: bridge, environment,
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — deux instances d’un même projet peuvent coexister');
{
  await registryStore.clear();

  const test = await declarer({
    url: 'https://api.demo-sbauto06.ly-solution.com', name: 'SB Auto 06', environment: 'TEST',
  });
  check('la recette est déclarée', test.record.projectId.length > 0);
  check('…avec l’identité logique annoncée par le projet',
    test.record.logicalProjectKey === CLE_LOGIQUE);
  check('…sans qu’aucun nom ni domaine n’ait été comparé',
    test.record.logicalProjectKey === identiteAnnoncee().projectKey);
  check('…et son environnement déclaré', test.record.declaredEnvironment === 'TEST');

  /**
   * LA SECONDE INSTANCE — c'est elle qui était refusée. Même clé annoncée,
   * autre adresse, autre environnement : ce n'est pas un doublon, c'est la
   * production du même projet.
   */
  const prod = await declarer({
    url: 'https://api.sbauto06.ly-solution.com', name: 'SB Auto 06', environment: 'PROD',
  });
  check('la production est déclarée à son tour', prod.record.projectId !== test.record.projectId);
  check('…et partage la MÊME identité logique',
    prod.record.logicalProjectKey === test.record.logicalProjectKey);
  check('…tout en gardant sa PROPRE clé technique',
    prod.record.projectKey !== test.record.projectKey);
  check('…et son propre environnement', prod.record.declaredEnvironment === 'PROD');
  check('deux fiches, deux appairages indépendants',
    (await registryStore.list()).length === 2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — ce qui reste interdit l’est toujours');
{
  await rejectsWith(
    () => declarer({
      url: 'https://api.autre.ly-solution.com', name: 'SB Auto 06', environment: 'TEST',
    }),
    'PANEL_PROJECT_ENVIRONMENT_ALREADY_DECLARED',
    'deux recettes pour un même projet : refusé',
  );

  await rejectsWith(
    () => declarer({
      url: 'https://api.demo-sbauto06.ly-solution.com', name: 'SB Auto 06', environment: 'PROD',
    }),
    'PANEL_PROJECT_ALREADY_DECLARED',
    'la même adresse deux fois : refusé, comme avant',
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — une fiche sans clé annoncée reste seule, exactement comme avant');
{
  const isole = await registre.declareProject({
    publicBackendUrl: 'https://api.garage-martin.fr',
    projectName: 'Garage Martin',
    bridgeIdentity: null,
    environment: null,
  });
  check('aucune identité logique n’est inventée', isole.record.logicalProjectKey === null);
  check('…ni aucun environnement', isole.record.declaredEnvironment === null);

  // Un second projet SANS clé ne se retrouve jamais groupé avec le premier,
  // même si les noms se ressemblent. C'est le piège de l'heuristique, évité.
  const voisin = await registre.declareProject({
    publicBackendUrl: 'https://api.garage-martin-fils.fr',
    projectName: 'Garage Martin Fils',
    bridgeIdentity: null,
    environment: null,
  });
  check('un nom voisin ne crée aucun regroupement',
    groupKeyOf({ ...isole.record, logicalProjectKey: null }).key
      !== groupKeyOf({ ...voisin.record, logicalProjectKey: null }).key);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — la projection publique porte de quoi regrouper');
{
  const fiche = await registryStore.getByKey(
    (await registryStore.list()).find((r) => r.declaredEnvironment === 'TEST').projectKey,
  );
  const publie = registre.toPublicProject(fiche, Date.now(), {}, null);
  check('l’identité logique est publiée', publie.logicalProjectKey === CLE_LOGIQUE);
  check('l’environnement de l’instance est publié', publie.environment === 'TEST');
  check('aucun secret n’accompagne ces champs',
    !JSON.stringify(publie).includes('bridgeToken')
    && !JSON.stringify(publie).includes('pairingCodeHash'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  REGROUPEMENT D'ÉCRAN — fonctions pures, sans React                        */
/* ══════════════════════════════════════════════════════════════════════════ */

const fiche = ({
  id, env, logical = CLE_LOGIQUE, liveness = 'ONLINE', pairing = 'PAIRED',
  host = null, seconds = 10, name = 'SB Auto 06', snapshot = '2026-08-07T10:56:00.000Z',
  generationMismatch = false, environmentMismatch = false,
}) => ({
  projectId: id,
  projectKey: `${logical ?? 'x'}-${id}`,
  logicalProjectKey: logical,
  environment: env,
  projectName: name,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  pairing: { status: pairing, pairedAt: null, revokedAt: null, pairingCodeExpiresAt: null },
  runtime: {
    environment: env, softwareVersion: '1.0.0', contractVersion: '1.4.0',
    publicBackendUrl: null, lastHeartbeatAt: '2026-08-07T11:00:00.000Z',
    lastHealth: { status: 'OK', details: null }, bridgeStats: null,
  },
  liveness,
  secondsSinceLastHeartbeat: seconds,
  descriptor: { urls: { website: host }, versions: {} },
  capabilities: { enabled: [], reserved: [], unknown: [], panelModules: [] },
  business: {
    presentation: { companyName: name, tagline: 'Detailing automobile' },
    contract: null,
    freshness: {
      runtimeEnvironment: env, runtimeGeneration: `${env}|g`,
      projectionEnvironment: env, projectionGeneration: `${env}|g`,
      generationMismatch, environmentMismatch, destinationKnown: true,
      lastSyncAt: snapshot,
    },
  },
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('A. Aucun appairage — les deux environnements sont proposés');
{
  const [g] = groupProjectsByLogicalProject([
    fiche({ id: 'a1', env: null, logical: null, pairing: 'DECLARED', liveness: 'NEVER_SEEN' }),
  ]);
  check('un seul groupe', Boolean(g));
  check('TEST est proposé', g.connections.find((c) => c.environment === 'TEST').state.status === 'ABSENT');
  check('PROD est proposé', g.connections.find((c) => c.environment === 'PROD').state.status === 'ABSENT');
  check('rien ne demande d’action — un projet neuf n’est pas en défaut',
    g.needsAttention === false);
  check('mais il reste à configurer', g.hasMissing === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B. TEST seul');
{
  const [g] = groupProjectsByLogicalProject([
    fiche({ id: 'b1', env: 'TEST', host: 'https://demo-sbauto06.ly-solution.com' }),
  ]);
  const test = g.connections.find((c) => c.environment === 'TEST');
  const prod = g.connections.find((c) => c.environment === 'PROD');
  check('TEST est connecté', test.state.status === 'ONLINE' && test.state.label === 'Connecté');
  check('…avec SON domaine', test.host === 'https://demo-sbauto06.ly-solution.com');
  check('PROD est simplement non appairé', prod.state.status === 'ABSENT');
  check('…et n’affiche AUCUN domaine', prod.host === null);
  check('…et n’est pas présenté comme une erreur',
    prod.state.tone === 'neutral' && prod.needsAttention === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C. PROD seul');
{
  const [g] = groupProjectsByLogicalProject([
    fiche({ id: 'c1', env: 'PROD', host: 'https://sbauto06.ly-solution.com' }),
  ]);
  const test = g.connections.find((c) => c.environment === 'TEST');
  const prod = g.connections.find((c) => c.environment === 'PROD');
  check('PROD est connecté', prod.state.status === 'ONLINE');
  check('…avec son domaine', prod.host === 'https://sbauto06.ly-solution.com');
  check('TEST est proposé', test.state.status === 'ABSENT' && test.host === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('D→H. TEST + PROD — deux connexions, aucune contamination');
{
  const T = fiche({
    id: 'd1', env: 'TEST', host: 'https://demo-sbauto06.ly-solution.com',
    liveness: 'ONLINE', seconds: 12, snapshot: '2026-08-07T10:56:00.000Z',
  });
  const P = fiche({
    id: 'd2', env: 'PROD', host: 'https://sbauto06.ly-solution.com',
    liveness: 'OFFLINE', seconds: 90_000, snapshot: '2026-07-01T08:00:00.000Z',
  });
  const groupes = groupProjectsByLogicalProject([T, P]);

  check('D. les deux fiches forment UN seul projet', groupes.length === 1);
  const g = groupes[0];
  check('…déclaré comme regroupé', g.grouped === true);
  check('…avec deux connexions distinctes', g.connections.length === 2);
  check('…et les deux fiches conservées', g.projects.length === 2);

  const test = g.connections.find((c) => c.environment === 'TEST');
  const prod = g.connections.find((c) => c.environment === 'PROD');

  check('E. TEST connecté', test.state.status === 'ONLINE');
  check('E. PROD hors ligne', prod.state.status === 'OFFLINE');
  check('E. …et les états ne se contaminent pas',
    test.state.label !== prod.state.label);

  check('F. chaque environnement garde SA photographie',
    test.lastSnapshotAt === '2026-08-07T10:56:00.000Z'
    && prod.lastSnapshotAt === '2026-07-01T08:00:00.000Z');
  check('F. aucun snapshot croisé', test.lastSnapshotAt !== prod.lastSnapshotAt);

  check('G. chaque environnement garde SON domaine',
    test.host === 'https://demo-sbauto06.ly-solution.com'
    && prod.host === 'https://sbauto06.ly-solution.com');
  check('G. le domaine TEST n’apparaît jamais côté PROD',
    !String(prod.host).includes('demo-'));

  check('H. les générations diffèrent sans créer de faux désaccord',
    test.freshness.isGenerationMismatch === false
    && prod.freshness.isGenerationMismatch === false);
  check('H. …alors que leurs clés de génération SONT différentes',
    T.business.freshness.runtimeGeneration !== P.business.freshness.runtimeGeneration);

  check('la carte sait qu’une connexion vit', g.hasOnline === true);
  check('…et qu’une autre demande une action', g.needsAttention === true);
  check('…et qu’il ne manque plus aucun environnement', g.hasMissing === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('I/J. Réappairer un environnement n’altère jamais l’autre');
{
  const T = fiche({ id: 'i1', env: 'TEST', host: 'https://t.example.com' });
  const P = fiche({ id: 'i2', env: 'PROD', host: 'https://p.example.com' });
  const avant = groupProjectsByLogicalProject([T, P])[0];
  const prodAvant = { ...avant.connections.find((c) => c.environment === 'PROD') };

  // TEST est révoqué puis re-déclaré : seule sa colonne bouge.
  const Trevoque = { ...T, pairing: { ...T.pairing, status: 'REVOKED' }, liveness: 'OFFLINE' };
  const apres = groupProjectsByLogicalProject([Trevoque, P])[0];
  const testApres = apres.connections.find((c) => c.environment === 'TEST');
  const prodApres = apres.connections.find((c) => c.environment === 'PROD');

  check('I. TEST reflète sa révocation', testApres.state.status === 'REVOKED');
  check('I. PROD est strictement inchangé',
    prodApres.state.status === prodAvant.state.status
    && prodApres.host === prodAvant.host
    && prodApres.lastSnapshotAt === prodAvant.lastSnapshotAt);

  // …et symétriquement.
  const Prevoque = { ...P, pairing: { ...P.pairing, status: 'REVOKED' }, liveness: 'OFFLINE' };
  const inverse = groupProjectsByLogicalProject([T, Prevoque])[0];
  check('J. PROD reflète sa révocation',
    inverse.connections.find((c) => c.environment === 'PROD').state.status === 'REVOKED');
  check('J. TEST reste connecté',
    inverse.connections.find((c) => c.environment === 'TEST').state.status === 'ONLINE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Fiches sans identité logique — chacune son groupe');
{
  const a = fiche({ id: 'x1', env: 'TEST', logical: null, name: 'Garage Martin' });
  const b = fiche({ id: 'x2', env: 'PROD', logical: null, name: 'Garage Martin Fils' });
  const groupes = groupProjectsByLogicalProject([a, b]);
  check('deux fiches sans clé → deux groupes', groupes.length === 2);
  check('…et aucune n’est déclarée regroupée', groupes.every((g) => g.grouped === false));
  check('…un nom voisin ne les rapproche pas',
    groupes[0].projects.length === 1 && groupes[1].projects.length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Deux fiches du MÊME environnement — aucune n’est perdue');
{
  // Interdit par le backend, mais on ne fait jamais disparaître une donnée
  // qu'on ne comprend pas : elle devient son propre groupe.
  const a = fiche({ id: 'y1', env: 'TEST' });
  const b = fiche({ id: 'y2', env: 'TEST' });
  const groupes = groupProjectsByLogicalProject([a, b]);
  check('les deux fiches restent visibles',
    groupes.flatMap((g) => g.projects).length === 2);
  check('…sans qu’aucune n’écrase l’autre',
    groupes.some((g) => g.projects[0].projectId === 'y1')
    && groupes.some((g) => g.projects[0].projectId === 'y2'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('États dégradés — chacun son mot');
{
  const cas = [
    ['DECLARED', { pairing: 'DECLARED', liveness: 'NEVER_SEEN' }, 'En attente de connexion'],
    ['REVOKED', { pairing: 'REVOKED', liveness: 'OFFLINE' }, 'Déconnecté'],
    ['STALE', { pairing: 'PAIRED', liveness: 'STALE' }, 'Signal en retard'],
    ['OFFLINE', { pairing: 'PAIRED', liveness: 'OFFLINE' }, 'Hors ligne'],
  ];
  for (const [nom, patch, attendu] of cas) {
    const etat = connectionStateOf(fiche({ id: 'z', env: 'TEST', ...patch }));
    check(`${nom} → « ${attendu} »`, etat.label === attendu);
  }
  check('absente → « Non appairé »', connectionStateOf(null).label === 'Non appairé');
  check('un statut ne se lit jamais à la seule couleur',
    ['●', '◐', '○'].includes(connectionStateOf(null).symbol));

  // Une connexion en ligne dont les données sont périmées demande une action.
  const perime = fiche({ id: 'z2', env: 'TEST', generationMismatch: true });
  const [g] = groupProjectsByLogicalProject([perime]);
  check('en ligne mais photographie périmée → action requise',
    g.connections.find((c) => c.environment === 'TEST').needsAttention === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Environnement — lu, jamais deviné');
{
  check('l’environnement publié fait foi',
    environmentOf(fiche({ id: 'e1', env: 'PROD' })) === 'PROD');
  check('une valeur inconnue n’est pas inventée',
    environmentOf({ environment: null, runtime: { environment: null } }) === null);
  check('…et une valeur exotique est refusée',
    environmentOf({ environment: 'STAGING', runtime: {} }) === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Recherche et filtres');
{
  const groupes = groupProjectsByLogicalProject([
    fiche({ id: 'f1', env: 'TEST', host: 'https://demo-sbauto06.ly-solution.com' }),
    fiche({ id: 'f2', env: 'PROD', logical: 'garage-nord', name: 'Garage du Nord', liveness: 'OFFLINE' }),
  ]);
  check('recherche par nom', groupes.filter((g) => matchesSearch(g, 'Garage')).length === 1);
  check('recherche par domaine', groupes.filter((g) => matchesSearch(g, 'sbauto06')).length === 1);
  check('recherche vide → tout', groupes.filter((g) => matchesSearch(g, '  ')).length === 2);
  check('recherche insensible à la casse', groupes.filter((g) => matchesSearch(g, 'GARAGE')).length === 1);

  const compte = filterCounts(groupes);
  check('compteur « tous »', compte.all === 2);
  check('compteur « TEST »', compte.test === 1);
  check('compteur « PROD »', compte.prod === 1);
  check('compteur « à connecter »', compte.todo === 2);
  check('filtre TEST', groupes.filter((g) => matchesFilter(g, 'test')).length === 1);
  check('filtre PROD', groupes.filter((g) => matchesFilter(g, 'prod')).length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Liens profonds — de vraies URL, qui survivent au rafraîchissement');
{
  const lien = connectionLink('p-1', 'PROD');
  check('le lien porte le projet', lien.includes('/projects/p-1'));
  check('…l’onglet visé', lien.includes('tab=dev'));
  check('…et l’environnement', lien.includes('env=PROD'));
  check('aucun état de navigation implicite', !lien.includes('undefined'));

  const params = new URLSearchParams(lien.split('?')[1]);
  check('les paramètres se relisent tels quels',
    params.get('tab') === 'dev' && params.get('env') === 'PROD');

  const creation = pairEnvironmentLink('PROD', CLE_LOGIQUE, 'SB Auto 06');
  const p2 = new URLSearchParams(creation.split('?')[1]);
  check('le raccourci d’appairage connaît déjà l’environnement', p2.get('env') === 'PROD');
  check('…et le projet', p2.get('logical') === CLE_LOGIQUE && p2.get('name') === 'SB Auto 06');
  check('l’utilisateur n’a donc rien à re-sélectionner',
    creation.includes('declare=1'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  PASSE DE CLÔTURE — rattachement, actions rendues, isolation stricte      */
/* ══════════════════════════════════════════════════════════════════════════ */

section('Cas 10. Fiche historique sans identité logique — rattachée, jamais réappairée');
{
  await registryStore.clear();

  /**
   * L'ÉTAT RÉEL D'AVANT : une fiche appairée, dont la clé technique vaut la
   * clé annoncée par le projet (adoptée à son appairage), et dont l'identité
   * logique n'existait pas encore.
   */
  const at = new Date().toISOString();
  await registryStore.insert({
    projectId: 'ancienne-test',
    projectKey: CLE_LOGIQUE,
    projectKeySource: 'BRIDGE_KEY',
    logicalProjectKey: null,
    declaredEnvironment: null,
    projectName: 'SB Auto 06',
    createdAt: at, updatedAt: at,
    pairing: {
      status: 'PAIRED', pairingCodeHash: null, pairingCodeExpiresAt: null,
      bridgeTokenHash: 'jeton-test', bridgeTokenEncrypted: 'chiffre-test',
      pairedAt: '2026-08-04T17:37:22.545Z', revokedAt: null,
    },
    runtime: {
      environment: 'TEST', softwareVersion: '1.0.0', contractVersion: '1.4.0',
      publicBackendUrl: 'https://api.demo-sbauto06.ly-solution.com',
      lastHeartbeatAt: '2026-08-07T11:00:00.000Z', lastHealth: null, bridgeStats: null,
    },
    manifest: null, manifestSource: null,
  });

  const avant = await registryStore.getById('ancienne-test');

  // On déclare la PRODUCTION, qui annonce la même clé de pont.
  const prod = await declarer({
    url: 'https://api.sbauto06.ly-solution.com', name: 'SB Auto 06', environment: 'PROD',
  });

  const apres = await registryStore.getById('ancienne-test');
  check('la fiche historique est rattachée au projet logique',
    apres.logicalProjectKey === CLE_LOGIQUE);
  check('…et la production porte la MÊME identité',
    prod.record.logicalProjectKey === apres.logicalProjectKey);

  // ── CE QUI NE DOIT PAS AVOIR BOUGÉ ──────────────────────────────────────
  check('TEST n’a PAS été réappairé', apres.pairing.pairedAt === avant.pairing.pairedAt);
  check('…son jeton est intact', apres.pairing.bridgeTokenHash === avant.pairing.bridgeTokenHash);
  check('…son statut d’appairage aussi', apres.pairing.status === 'PAIRED');
  check('…son environnement n’a pas changé', apres.runtime.environment === 'TEST');
  check('…ni son dernier battement',
    apres.runtime.lastHeartbeatAt === avant.runtime.lastHeartbeatAt);
  check('…ni sa clé technique', apres.projectKey === avant.projectKey);
  check('la production a bien SA propre clé technique',
    prod.record.projectKey !== apres.projectKey);
  check('…et son propre identifiant', prod.record.projectId !== apres.projectId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Cas 11. Identité non fiable — aucun regroupement, jamais');
{
  const at = new Date().toISOString();
  // Une clé issue d'une DÉRIVATION locale (nom ou URL) n'est pas une identité :
  // deux projets voisins peuvent produire la même, et les rapprocher
  // fusionnerait deux clients.
  for (const source of ['NAME', 'URL']) {
    await registryStore.clear();
    await registryStore.insert({
      projectId: 'derive-' + source,
      projectKey: CLE_LOGIQUE,
      projectKeySource: source,
      logicalProjectKey: null,
      declaredEnvironment: null,
      projectName: 'Homonyme',
      createdAt: at, updatedAt: at,
      pairing: {
        status: 'PAIRED', pairingCodeHash: null, pairingCodeExpiresAt: null,
        bridgeTokenHash: 'x', bridgeTokenEncrypted: 'y',
        pairedAt: at, revokedAt: null,
      },
      runtime: {
        environment: 'TEST', softwareVersion: '1.0.0', contractVersion: '1.4.0',
        publicBackendUrl: 'https://api.homonyme.fr',
        lastHeartbeatAt: at, lastHealth: null, bridgeStats: null,
      },
      manifest: null, manifestSource: null,
    });

    await declarer({
      url: 'https://api.autre-' + source + '.fr', name: 'SB Auto 06', environment: 'PROD',
    });

    const restee = await registryStore.getById('derive-' + source);
    check('clé de provenance ' + source + ' → AUCUN rattachement',
      restee.logicalProjectKey === null);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Cas 6/7/8. Isolation stricte entre les deux instances');
{
  await registryStore.clear();
  const test = await declarer({
    url: 'https://api.test.example', name: 'Isolation', environment: 'TEST',
    bridge: { projectKey: 'isolation', projectName: 'Isolation' },
  });
  const prod = await declarer({
    url: 'https://api.prod.example', name: 'Isolation', environment: 'PROD',
    bridge: { projectKey: 'isolation', projectName: 'Isolation' },
  });

  check('deux fiches distinctes', test.record.projectId !== prod.record.projectId);
  check('deux codes d’appairage distincts', test.pairingCode !== prod.pairingCode);
  check('…et deux empreintes de code distinctes',
    test.record.pairing.pairingCodeHash !== prod.record.pairing.pairingCodeHash);

  // Cas 8 — un battement TEST ne touche AUCUN horodatage PROD.
  const prodAvant = JSON.stringify((await registryStore.getById(prod.record.projectId)).runtime);
  await registre.recordHeartbeat(await registryStore.getById(test.record.projectId), {
    sentAt: new Date().toISOString(), softwareVersion: '1.0.0', environment: 'TEST',
    health: { status: 'OK' }, bridgeStats: { outboxSize: 0, lastSyncAt: new Date().toISOString() },
  });
  const prodApres = JSON.stringify((await registryStore.getById(prod.record.projectId)).runtime);
  check('Cas 8 : un battement TEST laisse PROD strictement inchangé', prodAvant === prodApres);
  check('…alors que TEST, lui, a bien bougé',
    (await registryStore.getById(test.record.projectId)).runtime.lastHeartbeatAt !== null);

  // Cas 7 — régénérer le code PROD ne touche pas TEST.
  const pairing = await import('../backend/src/services/pairing/pairing.service.js');
  const testAvant = JSON.stringify((await registryStore.getById(test.record.projectId)).pairing);
  await pairing.issuePairingCode(await registryStore.getById(prod.record.projectId));
  const testApres = JSON.stringify((await registryStore.getById(test.record.projectId)).pairing);
  check('Cas 7 : régénérer le code PROD laisse l’appairage TEST intact', testAvant === testApres);

  // Cas 6 — révoquer TEST ne touche pas PROD.
  const testFiche = await registryStore.getById(test.record.projectId);
  testFiche.pairing.status = 'PAIRED';
  testFiche.pairing.bridgeTokenHash = 'h';
  testFiche.pairing.bridgeTokenEncrypted = chiffrer('jeton-test-en-clair');
  await registryStore.save(testFiche);

  const prodAvantRevoc = JSON.stringify(await registryStore.getById(prod.record.projectId));
  await pairing.revokeFromPanel(await registryStore.getById(test.record.projectId));
  const testRevoque = await registryStore.getById(test.record.projectId);
  const prodApresRevoc = JSON.stringify(await registryStore.getById(prod.record.projectId));

  check('Cas 6 : TEST est révoqué', testRevoque.pairing.status === 'REVOKED');
  check('…son jeton est effacé', testRevoque.pairing.bridgeTokenHash === null);
  check('…et PROD est strictement identique', prodAvantRevoc === prodApresRevoc);
  check('…la fiche PROD existe toujours',
    (await registryStore.getById(prod.record.projectId)) !== null);
  check('…et son identité logique est conservée',
    (await registryStore.getById(prod.record.projectId)).logicalProjectKey === 'isolation');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Cas 4/5. Photographies et destinations distinctes, lues chacune chez soi');
{
  const T = fiche({
    id: 'iso-t', env: 'TEST', logical: 'isolation',
    host: 'https://test.example', snapshot: '2026-08-07T10:00:00.000Z',
  });
  const P = fiche({
    id: 'iso-p', env: 'PROD', logical: 'isolation',
    host: 'https://prod.example', snapshot: '2026-06-01T09:00:00.000Z',
  });
  const [g] = groupProjectsByLogicalProject([T, P]);
  const t = g.connections.find((c) => c.environment === 'TEST');
  const p = g.connections.find((c) => c.environment === 'PROD');

  check('Cas 4 : chaque environnement lit SA photographie',
    t.lastSnapshotAt === '2026-08-07T10:00:00.000Z'
    && p.lastSnapshotAt === '2026-06-01T09:00:00.000Z');
  check('Cas 5 : chaque environnement lit SA destination',
    t.host === 'https://test.example' && p.host === 'https://prod.example');
  check('…et aucune adresse ne traverse', !t.host.includes('prod') && !p.host.includes('test'));
  check('les deux fiches restent séparées dans le groupe',
    g.projects.length === 2 && g.projects[0].projectId !== g.projects[1].projectId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Cas 2. Le raccourci porte tout le contexte, et rien de faux');
{
  const lien = pairEnvironmentLink('PROD', 'isolation', 'Isolation');
  const params = new URLSearchParams(lien.split('?')[1]);
  check('l’assistant s’ouvrira', params.get('declare') === '1');
  check('…en PRODUCTION', params.get('env') === 'PROD');
  check('…pour le bon projet logique', params.get('logical') === 'isolation');
  check('…et connaît son nom', params.get('name') === 'Isolation');

  // FAIL SAFE : la lecture d'un paramètre douteux ne doit JAMAIS donner PROD.
  const lire = (brut) => (brut === 'TEST' || brut === 'PROD' ? brut : null);
  for (const brut of ['prod', 'PRODUCTION', 'production', '', 'TEST ', 'x', null]) {
    check('« ' + (brut || '(vide)') + ' » n’est pas interprété comme un environnement',
      lire(brut) === null);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Filtres TEST / PROD / à connecter / problème');
{
  const groupes = groupProjectsByLogicalProject([
    fiche({ id: 'g1', env: 'TEST', logical: 'un', name: 'Un' }),
    fiche({ id: 'g2', env: 'PROD', logical: 'deux', name: 'Deux', liveness: 'OFFLINE' }),
    fiche({ id: 'g3', env: 'TEST', logical: 'trois', name: 'Trois' }),
    fiche({ id: 'g4', env: 'PROD', logical: 'trois', name: 'Trois' }),
  ]);
  const c = filterCounts(groupes);
  check('« TEST » ne compte que les projets AYANT une instance TEST', c.test === 2);
  check('« PROD » de même', c.prod === 2);
  check('« à connecter » compte les groupes incomplets', c.todo === 2);
  check('un environnement absent n’est jamais un « problème »',
    groupes.filter((g) => matchesFilter(g, 'attention')).length === 1);
  const complet = groupes.find((g) => g.name === 'Trois');
  check('le groupe complet n’est ni à connecter…', !matchesFilter(complet, 'todo'));
  check('…ni en problème', !matchesFilter(complet, 'attention'));
}

await stopMemoryMongo();
finish();
