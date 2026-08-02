// IDENTITÉ TECHNIQUE DES PROJETS — la clé n'est plus saisie, elle est générée.
//
// Ce que ce fichier verrouille, et que rien ne verrouillait avant : qu'AUCUN
// chemin ne permette à un client de choisir l'identifiant du registre, que la
// génération soit déterministe, et qu'un même projet ne puisse pas entrer deux
// fois — par l'adresse, par la clé dérivée, ou par l'identité du pont.
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const identity = await import('../backend/src/services/registry/projectIdentity.js');
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { createApp } = await import('../backend/src/app.js');
const { config } = await import('../backend/src/config/env.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');

const { generateProjectKey, normalizeBackendUrl, slugify } = identity;

/* ══════════════════════════════════════════════════════════════════════════ */
section('Normalisation d’adresse — une adresse, une seule chaîne');
{
  const canonical = 'https://api.exemple.test';
  check('barre finale ignorée', normalizeBackendUrl('https://api.exemple.test/') === canonical);
  check('casse de l’hôte ignorée', normalizeBackendUrl('https://API.Exemple.TEST') === canonical);
  check('port 443 implicite en https', normalizeBackendUrl('https://api.exemple.test:443') === canonical);
  check('port 80 implicite en http', normalizeBackendUrl('http://api.exemple.test:80') === 'http://api.exemple.test');
  check('port explicite non standard CONSERVÉ',
    normalizeBackendUrl('https://api.exemple.test:8443') === 'https://api.exemple.test:8443');
  check('chemin conservé (un projet peut vivre sous un préfixe)',
    normalizeBackendUrl('https://h.test/api/') === 'https://h.test/api');
  check('non-URL refusée', normalizeBackendUrl('pas-une-url') === null);
  check('protocole non http(s) refusé', normalizeBackendUrl('ftp://h.test') === null);
  check('vide/absent refusé', normalizeBackendUrl('') === null && normalizeBackendUrl(null) === null);
}

section('Slug — même algorithme que celui des projets');
{
  check('espaces et casse', slugify('Mon Projet 06') === 'mon-projet-06');
  check('accents dépliés', slugify('Éléonore & Fils') === 'eleonore-fils');
  check('séparateurs répétés réduits', slugify('  a---b  ') === 'a-b');
  check('ponctuation évacuée', slugify('A.B_C!') === 'a-b-c');
}

section('Génération de clé — ordre de préférence et déterminisme');
{
  const full = {
    bridgeIdentity: { projectKey: 'cle-du-projet', projectName: 'Nom Du Projet' },
    projectName: 'Nom Saisi',
    publicBackendUrl: 'https://api.exemple.test',
  };
  check('1. la clé annoncée par le pont l’emporte sur tout',
    generateProjectKey(full).projectKey === 'cle-du-projet');
  check('…et la source est tracée', generateProjectKey(full).source === 'BRIDGE_KEY');

  check('2. à défaut, le nom que le projet se donne',
    generateProjectKey({ ...full, bridgeIdentity: { projectName: 'Nom Du Projet' } }).projectKey === 'nom-du-projet');
  check('3. à défaut, le nom saisi',
    generateProjectKey({ ...full, bridgeIdentity: null }).projectKey === 'nom-saisi');
  check('4. à défaut, l’hôte de l’adresse',
    generateProjectKey({ publicBackendUrl: 'https://api.exemple.test' }).projectKey === 'api-exemple-test');
  check('rien d’exploitable → null (jamais une clé inventée)',
    generateProjectKey({}) === null && generateProjectKey({ projectName: '!!' }) === null);

  // DÉTERMINISME : c'est lui qui rend « deux clics » inoffensif et qui permet
  // de rejouer une déclaration sans produire un second projet.
  const runs = Array.from({ length: 25 }, () => generateProjectKey(full).projectKey);
  check('25 appels identiques → 25 fois la même clé', new Set(runs).size === 1);
  const generatorSource = (await import('node:fs')).readFileSync(
    new URL('../backend/src/services/registry/projectIdentity.js', import.meta.url), 'utf8',
  );
  check('aucune horloge ni aléa dans la génération',
    !/Date\.now|Math\.random|crypto\.randomUUID/.test(generatorSource));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Déclaration — la clé vient du serveur, jamais du client');
{
  await registryStore.clear();

  const first = await registry.declareProject({
    publicBackendUrl: 'https://api.projet-un.test',
    bridgeIdentity: { projectKey: 'projet-un', projectName: 'Projet Un' },
  });
  check('clé issue de l’identité annoncée', first.record.projectKey === 'projet-un');
  check('…source tracée BRIDGE_KEY', first.record.projectKeySource === 'BRIDGE_KEY');
  check('nom repris du projet, sans saisie', first.record.projectName === 'Projet Un');
  check('adresse stockée NORMALISÉE dès la déclaration',
    first.record.runtime.publicBackendUrl === 'https://api.projet-un.test');

  const named = await registry.declareProject({
    publicBackendUrl: 'https://api.projet-deux.test/',
    projectName: '  Projet Deux  ',
  });
  check('sans pont : clé dérivée du nom saisi', named.record.projectKey === 'projet-deux');
  check('…nom rogné', named.record.projectName === 'Projet Deux');

  const anonymous = await registry.declareProject({ publicBackendUrl: 'https://api.projet-trois.test' });
  check('sans pont ni nom : clé dérivée de l’adresse',
    anonymous.record.projectKey === 'api-projet-trois-test');
  check('…et le nom retombe sur l’hôte', anonymous.record.projectName === 'api.projet-trois.test');
}

section('Anti-doublons — un projet n’entre qu’une fois');
{
  const rejected = async (input) => {
    try {
      await registry.declareProject(input);
      return null;
    } catch (err) {
      return err.code ?? err.details?.code ?? null;
    }
  };
  const DUP = 'PANEL_PROJECT_ALREADY_DECLARED';

  check('même adresse → refus',
    (await rejected({ publicBackendUrl: 'https://api.projet-un.test' })) === DUP);
  check('même adresse déguisée (casse, port, barre) → refus',
    (await rejected({ publicBackendUrl: 'https://API.Projet-Un.test:443/' })) === DUP);
  check('adresse neuve mais clé dérivée déjà prise → refus',
    (await rejected({ publicBackendUrl: 'https://autre.test', projectName: 'Projet Un' })) === DUP);
  check('adresse neuve mais identité de pont déjà connue → refus',
    (await rejected({
      publicBackendUrl: 'https://encore-autre.test',
      projectName: 'Sans Rapport',
      bridgeIdentity: { projectKey: 'projet-un', projectName: 'Projet Un' },
    })) === DUP);
  check('adresse invalide → refus explicite, pas un doublon',
    (await rejected({ publicBackendUrl: 'ftp://h.test' })) === 'PANEL_PROJECT_URL_INVALID');

  const total = (await registryStore.list()).length;
  check('le registre contient toujours 3 projets, pas un de plus', total === 3);
}

section('Migration — les fiches antérieures gardent leur clé');
{
  // Une fiche créée avant la génération automatique : clé libre, aucune source
  // enregistrée, aucune URL. Elle doit rester lisible et utilisable telle
  // quelle — on ne réécrit pas l'existant.
  const legacy = {
    projectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    projectKey: 'ancienne-cle-saisie-a-la-main',
    projectName: 'Projet Historique',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pairing: {
      status: 'DECLARED', pairingCodeHash: null, pairingCodeExpiresAt: null,
      bridgeTokenHash: null, bridgeTokenEncrypted: null, pairedAt: null, revokedAt: null,
    },
    runtime: {
      environment: null, softwareVersion: null, contractVersion: null,
      publicBackendUrl: null, lastHeartbeatAt: null, lastHealth: null, bridgeStats: null,
    },
    manifest: null,
    manifestSource: null,
  };
  await registryStore.insert(legacy);
  const reread = await registryStore.getById(legacy.projectId);
  check('clé historique conservée intacte', reread.projectKey === 'ancienne-cle-saisie-a-la-main');
  check('source inconnue → null, jamais une valeur inventée', (reread.projectKeySource ?? null) === null);
  check('la projection publique la rend toujours',
    registry.toPublicProject(reread).projectKey === 'ancienne-cle-saisie-a-la-main');
  check('une fiche sans adresse ne bloque pas les recherches par adresse',
    (await registryStore.getByBackendUrl('https://api.projet-un.test'))?.projectKey === 'projet-un');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Surface HTTP — POST /api/projects ignore tout projectKey reçu');
{
  await registryStore.clear();
  await seedFromEnv();
  const { call, close } = await startServer(createApp());
  const login = await call('POST', '/api/auth/login', {
    body: { email: config.seedDevEmail, password: config.seedDevPassword },
  });
  const AUTH = { authorization: `Bearer ${login.json.data.token}` };

  // Le client tente d'imposer un identifiant. Le serveur doit le jeter.
  const forced = await call('POST', '/api/projects', {
    headers: AUTH,
    body: {
      url: 'https://api.impose.test',
      projectName: 'Projet Imposé',
      projectKey: 'cle-choisie-par-le-client',
    },
  });
  check('déclaration acceptée', forced.status === 201);
  check('la clé du client est IGNORÉE',
    forced.json?.data?.project?.projectKey !== 'cle-choisie-par-le-client');
  check('…et vaut celle dérivée par le serveur',
    forced.json?.data?.project?.projectKey === 'projet-impose');

  // Deux clics sur le même bouton : le second ne crée rien.
  const again = await call('POST', '/api/projects', {
    headers: AUTH, body: { url: 'https://api.impose.test', projectName: 'Projet Imposé' },
  });
  check('deux clics → un seul projet',
    again.status === 409 && again.json?.code === 'PANEL_PROJECT_ALREADY_DECLARED');
  check('…et le refus nomme le projet déjà déclaré',
    again.json?.details?.projectName === 'Projet Imposé');
  check('le registre ne contient qu’une fiche', (await registryStore.list()).length === 1);

  // Sans adresse, il n'y a rien à déclarer : le refus doit le dire.
  const noUrl = await call('POST', '/api/projects', {
    headers: AUTH, body: { projectName: 'Sans Adresse' },
  });
  check('déclaration sans adresse → 400 explicite',
    noUrl.status === 400 && noUrl.json?.code === 'PANEL_PROJECT_URL_INVALID');

  await close();
}

section('Aucune surface n’accepte plus une clé saisie');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // Le contrôleur ne doit LIRE projectKey nulle part dans req.body.
  const controller = fs.readFileSync(
    path.join(root, 'backend/src/controllers/projects.controller.js'), 'utf8',
  );
  check('le contrôleur ne déstructure jamais projectKey du corps',
    !/const\s*\{[^}]*projectKey[^}]*\}\s*=\s*req\.body/.test(controller));

  // Le service ne doit pas accepter de clé en paramètre.
  const service = fs.readFileSync(
    path.join(root, 'backend/src/services/registry/projectRegistry.service.js'), 'utf8',
  );
  const signature = service.match(/export async function declareProject\(([\s\S]*?)\)\s*\{/)?.[1] ?? '';
  check('declareProject n’a plus de paramètre projectKey', !/projectKey/.test(signature));

  // L'écran de déclaration ne doit plus proposer de champ clé.
  const page = fs.readFileSync(path.join(root, 'frontend/src/pages/ProjectsPage.tsx'), 'utf8');
  check('le formulaire n’a plus de champ « clé »', !/Clé du projet|setProjectKey/.test(page));
  check('…et le client d’API n’envoie plus de projectKey',
    !/projectKey/.test(fs.readFileSync(path.join(root, 'frontend/src/lib/api.ts'), 'utf8')));
}

await stopMemoryMongo();
finish();
