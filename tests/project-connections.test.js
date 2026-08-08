/**
 * APPAIRAGES — UNE FICHE, UNE INSTANCE, UNE LIGNE.
 *
 * ══ CE QUE CE FICHIER VERROUILLE ════════════════════════════════════════════
 *
 * La doctrine du Panel est désormais sans ambiguïté :
 *
 *     1 fiche Panel = 1 appairage = 1 projet distant = 1 environnement
 *                   = 1 destination = 1 état métier.
 *
 * Ce fichier remplace la suite qui éprouvait le contraire : le regroupement de
 * deux fiches par `logicalProjectKey`, les cartes TEST+PROD, le rattachement
 * automatique des fiches historiques, les liens profonds `?env=`.
 *
 * ══ POURQUOI CETTE SUITE A ÉTÉ REMPLACÉE, ET NON « ASSOUPLIE » ══════════════
 *
 * Elle vérifiait fidèlement un modèle qui ne pouvait pas exister. Une instance
 * de Panel ne sert QU'UN environnement : `pairing.bootstrap` refuse tout projet
 * dont l'environnement ne concorde pas (fail closed, et c'est une protection
 * qu'on garde — elle est éprouvée ici même). Une carte « recette + production »
 * ne pouvait donc jamais porter deux fiches vivantes : la seconde était
 * toujours une fiche jamais appairée, affichée comme un constat.
 *
 * Les invariants portent leur nom en toutes lettres — ils sont cherchables.
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const pairing = await import('../backend/src/services/pairing/pairing.service.js');
const {
  toPairingRow, toPairingRows, connectionStateOf, environmentOf, destinationOf,
  manageLink, matchesSearch, matchesFilter, filterCounts,
} = await import('@/lib/projectConnections');

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

/**
 * LE CODE EXÉCUTABLE, SANS LES COMMENTAIRES.
 *
 * Les fichiers refondus CITENT volontairement ce qu'ils ont supprimé —
 * « `pairEnvironmentLink` a disparu pour la même raison » — parce qu'un
 * commentaire qui explique une absence vaut mieux qu'un silence. Chercher ces
 * noms dans le fichier brut ferait donc échouer un contrôle sur la prose qui
 * en atteste. Seul le code est jugé ; c'est la même discipline que
 * `panel-instance-environment.test.js`.
 */
const codeSeul = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
  .replace(/\/\/[^\r\n]*/g, ' ');

/** Les règles CSS dont le sélecteur nomme la liste d'appairages. */
function reglesPairing(css) {
  const sansCommentaires = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return [...sansCommentaires.matchAll(/([^{}]*pairing[^{}]*)\{([^}]*)\}/g)]
    .map((m) => `${m[1]}{${m[2]}}`)
    .join('\n');
}

/** Le pont annonce sa clé — anti-collision technique, jamais un regroupement. */
const identiteAnnoncee = (projectKey = 'sb-auto-06', projectName = 'SB Auto 06') => ({
  projectKey, projectName, environment: null, softwareVersion: '1.0.0',
});

async function declarer({ url, name, environment = null, bridge = identiteAnnoncee() }) {
  return registre.declareProject({
    publicBackendUrl: url, projectName: name, bridgeIdentity: bridge, environment,
  });
}

/** La fiche telle que l'API la publie — la même lecture que l'écran. */
async function publique(projectId) {
  const record = await registryStore.getById(projectId);
  return registre.toPublicProject(record, Date.now(), {}, record.activeNetwork?.host ?? null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — une fiche non appairée ne déclare RIEN du projet');
{
  await registryStore.clear();
  const { record } = await declarer({
    url: 'https://api.demo-sbauto06.ly-solution.com',
    name: 'SB Auto 06',
    environment: 'TEST', // intention de saisie, purement anti-collision
  });
  const vue = await publique(record.projectId);

  check('UNPAIRED_PROJECT_HAS_NO_ENVIRONMENT', vue.environment === null);
  check('…y compris dans le descripteur', vue.descriptor.environment === null);
  check('UNPAIRED_PROJECT_HAS_NO_DESTINATION', vue.descriptor.primaryDomain === null);
  check('…ni aucune adresse résolue', vue.descriptor.urls === null);
  check('…et la raison est NOMMÉE, pas devinée',
    vue.descriptor.networkSource === 'NON_APPAIRE');
  check('NO_PROJECT_KEY_IN_PUBLIC_PROJECT : aucune identité logique publiée',
    !('logicalProjectKey' in vue));

  /**
   * L'intention saisie EXISTE toujours en base — elle départage deux clés
   * techniques identiques. Elle ne franchit simplement plus l'API.
   */
  const enBase = await registryStore.getById(record.projectId);
  check('l’environnement saisi reste en base, pour l’anti-collision seule',
    enBase.declaredEnvironment === 'TEST');
  check('…et aucune identité logique n’est écrite',
    (enBase.logicalProjectKey ?? null) === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — après appairage, l’environnement vient DU PROJET');
{
  await registryStore.clear();
  const { record, pairingCode } = await declarer({
    url: 'https://api.demo-sbauto06.ly-solution.com', name: 'SB Auto 06',
  });
  await pairing.bootstrap({
    contractVersion: '1.4.0',
    projectKey: 'sb-auto-06',
    projectName: 'SB Auto 06',
    environment: 'TEST',
    softwareVersion: '1.0.0',
    publicBackendUrl: 'https://api.demo-sbauto06.ly-solution.com',
    pairingCode,
  });

  const vue = await publique(record.projectId);
  check('PAIRED_PROJECT_SHOWS_DECLARED_ENVIRONMENT', vue.environment === 'TEST');
  check('…et il vient du battement, pas de la saisie',
    vue.runtime.environment === 'TEST');
  check('la destination est désormais connue',
    typeof vue.descriptor.primaryDomain === 'string' && vue.descriptor.primaryDomain.length > 0);
  check('…et son origine est annoncée',
    vue.descriptor.networkSource === 'DESTINATION_ACTIVE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — un Panel ne sert QU’UN environnement (fondement de la doctrine)');
{
  await registryStore.clear();
  const recette = await declarer({ url: 'https://api.iso-test.fr', name: 'Iso Recette' });
  await pairing.bootstrap({
    contractVersion: '1.4.0', projectKey: 'iso', projectName: 'Iso',
    environment: 'TEST', softwareVersion: '1.0.0',
    publicBackendUrl: 'https://api.iso-test.fr', pairingCode: recette.pairingCode,
  });

  const production = await declarer({ url: 'https://api.iso-prod.fr', name: 'Iso Production' });
  check('ONE_PANEL_SERVES_ONE_ENVIRONMENT : la production est refusée ici',
    await rejectsWith(
      () => Promise.resolve(pairing.bootstrap({
        contractVersion: '1.4.0', projectKey: 'iso', projectName: 'Iso',
        environment: 'PROD', softwareVersion: '1.0.0',
        publicBackendUrl: 'https://api.iso-prod.fr', pairingCode: production.pairingCode,
      })),
      'BRIDGE_ENVIRONMENT_MISMATCH',
    ));
  check('…et le refus nomme le VRAI problème, pas une collision de clé',
    (await registryStore.getById(production.record.projectId)).pairing.status === 'DECLARED');

  /**
   * C'est ce refus qui rend la doctrine mono-instance NÉCESSAIRE, et non
   * seulement souhaitable : une carte « TEST + PROD » ne pourrait, dans ce
   * Panel, jamais afficher deux fiches vivantes.
   */
  const fiches = await registryStore.list();
  check('un seul jeton existe sur cette instance',
    fiches.filter((f) => f.pairing.bridgeTokenHash).length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BACKEND — la clé technique reste unique, et ne scope AUCUNE donnée');
{
  await registryStore.clear();
  const a = await declarer({ url: 'https://api.a.fr', name: 'Homonyme A' });
  const b = await declarer({
    url: 'https://api.b.fr', name: 'Homonyme B', environment: 'PROD',
  });
  check('deux fiches, deux clés techniques',
    a.record.projectKey !== b.record.projectKey);
  check('…et deux identifiants métier distincts',
    a.record.projectId !== b.record.projectId);
  check('la même ADRESSE reste refusée', await rejectsWith(
    () => declarer({ url: 'https://api.a.fr', name: 'Doublon' }),
    'PANEL_PROJECT_ALREADY_DECLARED',
  ));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UI — une fiche, une ligne, aucun regroupement');
{
  const fiche = (over = {}) => ({
    projectId: over.projectId ?? 'p1',
    projectKey: over.projectKey ?? 'sb-auto-06',
    projectName: over.projectName ?? 'SB Auto 06',
    environment: over.environment ?? null,
    pairing: { status: over.status ?? 'DECLARED', pairedAt: null, revokedAt: null, pairingCodeExpiresAt: null },
    runtime: {
      environment: over.environment ?? null, softwareVersion: null, contractVersion: null,
      publicBackendUrl: null, lastHeartbeatAt: over.lastHeartbeatAt ?? null,
      lastBusinessSyncAt: over.lastBusinessSyncAt ?? null, lastHealth: null, bridgeStats: null,
    },
    liveness: over.liveness ?? 'NOT_PAIRED',
    secondsSinceLastHeartbeat: over.secondsSinceLastHeartbeat ?? null,
    descriptor: {
      primaryDomain: over.primaryDomain ?? null,
      urls: over.urls ?? null,
      networkSource: over.networkSource ?? 'NON_APPAIRE',
    },
    business: over.business ?? null,
    capabilities: { enabled: [], reserved: [], unknown: [], panelModules: [] },
  });

  const nonAppairee = fiche({ projectId: 'libre', projectName: 'Garage du Nord' });
  const appairee = fiche({
    projectId: 'sb', status: 'PAIRED', environment: 'TEST', liveness: 'ONLINE',
    primaryDomain: 'demo-sbauto06.ly-solution.com',
    lastHeartbeatAt: '2026-08-08T10:00:00.000Z',
    lastBusinessSyncAt: '2026-08-08T10:00:05.000Z',
    secondsSinceLastHeartbeat: 12,
    business: { presentation: { companyName: 'SB Auto 06', tagline: 'Lavage auto' } },
  });

  const lignes = toPairingRows([appairee, nonAppairee]);
  check('ONE_ROW_EQUALS_ONE_PANEL_PROJECT', lignes.length === 2);
  check('…une ligne par projectId, sans exception',
    new Set(lignes.map((l) => l.projectId)).size === 2);
  check('NO_TEST_PROD_GROUPING : aucune ligne ne porte deux fiches',
    lignes.every((l) => typeof l.project === 'object' && !Array.isArray(l.project)));
  check('l’ordre est stable et alphabétique',
    lignes[0].name === 'Garage du Nord' && lignes[1].name === 'SB Auto 06');

  const libre = toPairingRow(nonAppairee);
  check('UNPAIRED_PROJECT_HAS_NO_ENVIRONMENT (UI)', libre.environment === null);
  check('UNPAIRED_PROJECT_HAS_NO_DESTINATION (UI)', libre.destination === null);
  check('…et son état se dit « Non appairé »',
    libre.state.status === 'UNPAIRED' && libre.state.label === 'Non appairé');
  check('…sans être présentée comme un défaut', libre.needsAttention === false);
  check('…et son nom reste celui de la fiche', libre.name === 'Garage du Nord');

  const sb = toPairingRow(appairee);
  check('PAIRED_PROJECT_SHOWS_DECLARED_ENVIRONMENT (UI)', sb.environment === 'TEST');
  check('…sa destination est celle annoncée',
    sb.destination === 'demo-sbauto06.ly-solution.com');
  check('LIVE_BUSINESS_NAME_USES_PROJECTION : le nom vient de la projection poussée',
    sb.name === 'SB Auto 06' && appairee.projectName === 'SB Auto 06');
  check('…et les données métier reçues sont datées',
    sb.lastBusinessSyncAt === '2026-08-08T10:00:05.000Z');

  /** Aucune déduction : un projet appairé sans environnement reste inconnu. */
  const muette = fiche({ projectId: 'muette', status: 'PAIRED', liveness: 'NEVER_SEEN' });
  check('NO_ENVIRONMENT_FALLBACK : appairé mais silencieux → inconnu',
    environmentOf(muette) === null && destinationOf(muette) === null);
  check('…et son état est « Hors ligne », jamais « Non appairé »',
    connectionStateOf(muette).status === 'OFFLINE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UI — filtres, recherche et liens');
{
  const base = (id, paired, env, host, name) => ({
    projectId: id, projectKey: `cle-${id}`, projectName: name, environment: env,
    pairing: { status: paired ? 'PAIRED' : 'DECLARED', pairedAt: null, revokedAt: null, pairingCodeExpiresAt: null },
    runtime: {
      environment: env, softwareVersion: null, contractVersion: null, publicBackendUrl: null,
      lastHeartbeatAt: null, lastBusinessSyncAt: null, lastHealth: null, bridgeStats: null,
    },
    liveness: paired ? 'ONLINE' : 'NOT_PAIRED',
    secondsSinceLastHeartbeat: paired ? 5 : null,
    descriptor: { primaryDomain: host, urls: null, networkSource: host ? 'DESTINATION_ACTIVE' : 'NON_APPAIRE' },
    business: null,
    capabilities: { enabled: [], reserved: [], unknown: [], panelModules: [] },
  });

  const lignes = toPairingRows([
    base('a', true, 'TEST', 'demo-sbauto06.ly-solution.com', 'SB Auto 06'),
    base('b', false, null, null, 'Garage du Nord'),
  ]);
  const compteurs = filterCounts(lignes);
  check('les compteurs disent le parc', compteurs.all === 2 && compteurs.paired === 1 && compteurs.unpaired === 1);
  check('NO_ENVIRONMENT_FILTER : aucun filtre TEST/PROD',
    !('test' in compteurs) && !('prod' in compteurs));
  check('le filtre « appairées » ne garde que le lien établi',
    lignes.filter((l) => matchesFilter(l, 'paired')).map((l) => l.projectId).join() === 'a');
  check('le filtre « à appairer » garde l’autre',
    lignes.filter((l) => matchesFilter(l, 'unpaired')).map((l) => l.projectId).join() === 'b');

  const sb = lignes.find((l) => l.projectId === 'a');
  check('la recherche trouve par le nom', matchesSearch(sb, 'sb auto'));
  check('…par la destination', matchesSearch(sb, 'ly-solution'));
  check('…et par la clé technique collée d’un journal', matchesSearch(sb, 'cle-a'));
  check('une recherche vide ne filtre rien', matchesSearch(sb, '   '));

  check('NO_ENVIRONMENT_IN_LINKS : le lien de gestion ne porte pas d’environnement',
    manageLink('abc') === '/projects/abc?tab=dev');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SOURCES — la page Appairages tient ses promesses de forme');
{
  const page = codeSeul(lire('frontend/src/pages/PairingsPage.tsx'));
  const item = codeSeul(lire('frontend/src/components/connections.tsx'));
  const css = lire('frontend/src/components.css');
  const module = codeSeul(lire('frontend/src/lib/projectConnections.ts'));

  check('PAIRING_PAGE_FULL_WIDTH_LIST : une liste verticale, pas une grille',
    page.includes('pairing-list') && !page.includes('conn-grid'));
  check('…et l’item occupe toute la largeur',
    /\.pairing-item\s*\{[^}]*width:\s*100%/.test(css));
  check('…sans aucune table native', !/<table|<thead|<tbody/i.test(page + item));
  check('CUSTOM_SEARCH_IS_USED : la recherche maison, jamais un input nu',
    page.includes('<SearchField') && page.includes("from '@/components/SearchField'"));
  check('…et aucun select natif ne sert de filtre',
    !/<select/i.test(page) && !/<select/i.test(item));
  check('les filtres sont des boutons pressés, lisibles au clavier',
    /aria-pressed=\{filtre === f\.id\}/.test(page));

  check('NO_PROJECT_KEY_IN_PAIRINGS_UI : plus aucune identité logique lue',
    !/project\.logicalProjectKey|logicalProjectKey \?\?/.test(module + page + item));
  check('NO_TEST_PROD_GROUPING (sources) : plus de regroupement ni de sœurs',
    !/groupProjectsByLogicalProject|listSiblings|pairEnvironmentLink/.test(module + page + item));
  check('…ni de segment TEST/PROD dans l’item',
    !/'TEST'\s*:\s*'PROD'|Appairer la production/.test(item));

  /**
   * RESPONSIVE — la contrainte qui compte est l'absence de largeur FIXE :
   * c'est elle, et elle seule, qui produit un débordement horizontal.
   */
  const styles = reglesPairing(css);
  check('les styles de la liste existent bien', styles.includes('.pairing-item'));
  check('aucune largeur fixe dans la liste',
    !/\bwidth:\s*\d+(px|rem)/.test(styles.replace(/width:\s*100%/g, '')));
  check('…et toutes les colonnes peuvent rétrécir',
    (styles.match(/minmax\(0,/g) ?? []).length >= 2);
  check('un domaine long se tronque au lieu de pousser la page',
    /\.pairing-host\s*\{[^}]*text-overflow:\s*ellipsis/.test(styles));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SOURCES — la fiche projet est mono-instance');
{
  const brut = lire('frontend/src/pages/ProjectDetailPage.tsx');
  const detail = codeSeul(brut);

  check('PROJECT_DETAIL_IS_SINGLE_INSTANCE : plus aucun regroupement',
    !/groupProjectsByLogicalProject|SisterInstanceLink/.test(detail));
  check('PROJECT_DETAIL_SHOWS_ONLY_ONE_ENVIRONMENT : plus de boucle TEST/PROD',
    !/\(\['TEST', 'PROD'\] as const\)/.test(detail));
  check('PROJECT_DETAIL_SHOWS_ONLY_ONE_DESTINATION : la carte est au singulier',
    detail.includes('<Card title="Destination">') && !detail.includes('<Card title="Destinations">'));
  check('NO_SECOND_DESTINATION_PAIRING_CTA',
    !/Appairer la production|Appairer la recette|ajouter une destination/i.test(detail));
  check('UNPAIRED_PROJECT_ENVIRONMENT_IS_UNKNOWN : l’écran le DIT',
    detail.includes('— non connu —') && detail.includes('— non connue —'));
  check('MANIFEST_ONLY_AS_FALLBACK : le nom lit d’abord la projection poussée',
    lire('frontend/src/lib/projectPresentation.ts')
      .indexOf('business?.presentation?.companyName')
    < lire('frontend/src/lib/projectPresentation.ts')
      .indexOf('descriptor?.presentation?.companyName'));
}

await stopMemoryMongo();
finish();
