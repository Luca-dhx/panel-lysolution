// Conformité : les specs OpenAPI (docs/spec/), le miroir exécutable
// (bridgeContract.js), le client sortant et la surface montée racontent la
// même chose — le contrat ne peut pas dériver silencieusement.
// Lecture des specs par extraction textuelle (les YAML sont la référence).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section, setTestEnv, startServer } from './helpers/harness.js';

setTestEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panelSpec = fs.readFileSync(path.join(root, 'docs/spec/PanelBridge.openapi.yaml'), 'utf8');
const projectSpec = fs.readFileSync(path.join(root, 'docs/spec/ProjectBridge.openapi.yaml'), 'utf8');

const contract = await import('../backend/src/bridge/bridgeContract.js');
const { PROJECT_BRIDGE_CLIENT_METHODS, ProjectBridgeClient } = await import(
  '../backend/src/bridge/ProjectBridgeClient.js'
);

function specPaths(spec, prefixRe) {
  return [...spec.matchAll(prefixRe)].map((m) => m[1]);
}

section('Version du contrat');
{
  check('les deux specs déclarent la version du miroir',
    panelSpec.includes(`version: ${contract.CONTRACT_VERSION}`)
    && projectSpec.includes(`version: ${contract.CONTRACT_VERSION}`));
  check('l’en-tête du miroir est celui des specs',
    contract.CONTRACT_VERSION_HEADER === 'x-bridge-contract-version'
    && panelSpec.includes('X-Bridge-Contract-Version'));
}

section('Chemins du contrat PanelBridge (servis par le Panel)');
{
  const inSpec = specPaths(panelSpec, /^ {2}(\/bridge\/v1\/[^\s:]+):\s*$/gm).sort();
  const inMirror = Object.values(contract.PANEL_API_ROUTES).sort();
  check(`la spec expose ${inSpec.length} chemins`, inSpec.length === 6);
  check('miroir ↔ spec : ensembles identiques', JSON.stringify(inSpec) === JSON.stringify(inMirror));
}

section('Chemins du contrat ProjectBridge (consommés par le Panel)');
{
  const inSpec = specPaths(projectSpec, /^ {2}(\/api\/project-bridge\/v1\/[^\s:]+):\s*$/gm).sort();
  const inMirror = Object.values(contract.PROJECT_API_ROUTES).sort();
  check(`la spec expose ${inSpec.length} chemins`, inSpec.length === 9);
  check('miroir ↔ spec : ensembles identiques', JSON.stringify(inSpec) === JSON.stringify(inMirror));
  check('GET /manifest présent (ajout 1.1.0)', inMirror.includes('/api/project-bridge/v1/manifest'));
}

section('Catalogues d’erreurs BRIDGE_*');
{
  const specCodes = new Set([...`${panelSpec}\n${projectSpec}`.matchAll(/BRIDGE_[A-Z_]+/g)].map((m) => m[0]));
  const mirrorCodes = Object.values(contract.BRIDGE_ERROR_CODES);
  check('chaque code du miroir existe dans les specs', mirrorCodes.every((code) => specCodes.has(code)));
  check('chaque code des specs existe dans le miroir', [...specCodes].every((code) => mirrorCodes.includes(code)));
  check('enum PanelBridge : 10 codes, sans ENTITY_TYPE_UNSUPPORTED',
    contract.PANEL_BRIDGE_ERROR_ENUM.length === 10
    && !contract.PANEL_BRIDGE_ERROR_ENUM.includes('BRIDGE_ENTITY_TYPE_UNSUPPORTED'));
  check('enum ProjectBridge : 11 codes, avec ENTITY_TYPE_UNSUPPORTED',
    contract.PROJECT_BRIDGE_ERROR_ENUM.length === 11
    && contract.PROJECT_BRIDGE_ERROR_ENUM.includes('BRIDGE_ENTITY_TYPE_UNSUPPORTED'));
}

section('Types d’entités synchronisées');
{
  check('12 entityTypes au miroir', contract.SYNC_ENTITY_TYPES.length === 12);
  check('tous présents dans la spec PanelBridge',
    contract.SYNC_ENTITY_TYPES.every((t) => panelSpec.includes(`- ${t}`)));
  check('tous présents dans la spec ProjectBridge',
    contract.SYNC_ENTITY_TYPES.every((t) => projectSpec.includes(`- ${t}`)));
  check('Phase 2B : seul DIAGNOSTIC est appliqué',
    contract.APPLIED_ENTITY_TYPES.length === 1 && contract.APPLIED_ENTITY_TYPES[0] === 'DIAGNOSTIC');
  check('statuts d’accusé conformes', ['APPLIED', 'DUPLICATE', 'IGNORED', 'REJECTED'].every(
    (s) => contract.ACK_STATUS[s] === s && panelSpec.includes(s),
  ));
}

section('DTO du miroir : mêmes exigences que les specs');
{
  const bootstrapOk = contract.bootstrapRequestSchema.safeParse({
    contractVersion: '1.0.0', projectKey: 'abc', projectName: 'ABC',
    environment: 'TEST', softwareVersion: '1.0.0', pairingCode: 'X',
  });
  check('BootstrapRequest minimal accepté (publicBackendUrl optionnel)', bootstrapOk.success);
  check('BootstrapRequest strict : champ inconnu refusé',
    !contract.bootstrapRequestSchema.safeParse({
      contractVersion: '1.0.0', projectKey: 'abc', projectName: 'ABC',
      environment: 'TEST', softwareVersion: '1.0.0', pairingCode: 'X', extra: 1,
    }).success);
  check('projectKey < 3 caractères refusé (minLength de la spec)',
    !contract.bootstrapRequestSchema.safeParse({
      contractVersion: '1.0.0', projectKey: 'ab', projectName: 'ABC',
      environment: 'TEST', softwareVersion: '1.0.0', pairingCode: 'X',
    }).success);
  check('SyncPushRequest : maxItems 500 respecté',
    !contract.syncPushRequestSchema.safeParse({
      changes: Array.from({ length: 501 }, () => ({
        writeId: crypto.randomUUID(), entityType: 'DIAGNOSTIC', entityId: crypto.randomUUID(),
        deleted: false, payload: null, modifiedAt: new Date().toISOString(), emitter: 'PROJECT',
      })),
    }).success);
  check('SyncChange : writeId non-UUID refusé',
    !contract.syncChangeSchema.safeParse({
      writeId: 'nope', entityType: 'DIAGNOSTIC', entityId: crypto.randomUUID(),
      deleted: false, payload: null, modifiedAt: new Date().toISOString(), emitter: 'PROJECT',
    }).success);
}

section('ProjectManifest (ajout 1.1.0) : identique aux deux specs, miroir conforme');
{
  check('schéma ProjectManifest présent dans les DEUX specs',
    panelSpec.includes('ProjectManifest:') && projectSpec.includes('ProjectManifest:'));
  check('BootstrapRequest.manifest documenté dans la spec PanelBridge',
    panelSpec.includes('manifest:'));
  check('GET /manifest documenté dans la spec ProjectBridge',
    projectSpec.includes('/api/project-bridge/v1/manifest:'));
  check('historique de version 1.1.0 documenté dans les deux specs',
    panelSpec.includes('1.1.0') && projectSpec.includes('1.1.0'));

  const canonicalManifest = {
    manifestVersion: contract.MANIFEST_FORMAT_VERSION,
    project: { key: 'sb-auto-06', name: 'SB Auto 06', environment: 'TEST', softwareVersion: 'abc1234' },
    bridge: { contractVersion: contract.CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: contract.CONTRACT_VERSION, projectBridge: contract.CONTRACT_VERSION },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [{ id: 'panel-bridge', title: 'Pont Panel', status: 'ACTIVE' }],
    features: [{ id: 'sync.diagnostic', status: 'AVAILABLE' }, { id: 'sync.contracts', status: 'RESERVED' }],
  };
  check('manifeste canonique accepté par le miroir',
    contract.projectManifestSchema.safeParse(canonicalManifest).success);
  check('les 7 champs racine sont requis',
    ['manifestVersion', 'project', 'bridge', 'contracts', 'sync', 'modules', 'features'].every((field) => {
      const clone = { ...canonicalManifest };
      delete clone[field];
      return !contract.projectManifestSchema.safeParse(clone).success;
    }));
  check('bootstrap AVEC manifeste accepté (champ optionnel ≥ 1.1.0)',
    contract.bootstrapRequestSchema.safeParse({
      contractVersion: contract.CONTRACT_VERSION, projectKey: 'sb-auto-06', projectName: 'SB Auto 06',
      environment: 'TEST', softwareVersion: 'abc1234', pairingCode: 'X',
      manifest: canonicalManifest,
    }).success);
  check('statuts de modules/features conformes aux enums de la spec',
    panelSpec.includes('[ACTIVE, OPTIONAL]') && panelSpec.includes('[AVAILABLE, RESERVED]'));
}

section('Client sortant : une méthode par opération du contrat');
{
  check('9 méthodes déclarées', PROJECT_BRIDGE_CLIENT_METHODS.length === 9);
  const client = new ProjectBridgeClient({ baseUrl: 'https://exemple.invalid', bridgeToken: 'x' });
  check('chaque méthode existe sur le client',
    PROJECT_BRIDGE_CLIENT_METHODS.every((m) => typeof client[m] === 'function'));
  check('autant de méthodes que de chemins ProjectBridge',
    PROJECT_BRIDGE_CLIENT_METHODS.length === Object.keys(contract.PROJECT_API_ROUTES).length);
}

section('Exclusivité architecturale : un seul fichier parle réseau aux projets');
{
  const srcDir = path.join(root, 'backend', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        if (/\bfetch\s*\(/.test(content) && !full.endsWith('ProjectBridgeClient.js')) {
          offenders.push(path.relative(srcDir, full));
        }
      }
    }
  };
  walk(srcDir);
  check(`aucun fetch hors ProjectBridgeClient.js${offenders.length ? ` (trouvé : ${offenders.join(', ')})` : ''}`,
    offenders.length === 0);

  const envReaders = [];
  const walkEnv = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkEnv(full);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        if (/process\.env[.[]/.test(content) && !full.endsWith(path.join('config', 'env.js'))) {
          envReaders.push(path.relative(srcDir, full));
        }
      }
    }
  };
  walkEnv(srcDir);
  check('seul config/env.js lit process.env', envReaders.length === 0);
}

section('La surface montée honore les chemins du miroir');
{
  const { createApp } = await import('../backend/src/app.js');
  const { call, close } = await startServer(createApp());
  const H = { [contract.CONTRACT_VERSION_HEADER]: contract.CONTRACT_VERSION };

  const ping = await call('GET', contract.PANEL_API_ROUTES.ping, { headers: H });
  check('ping monté au chemin du contrat', ping.status === 200);

  const bootstrap = await call('POST', contract.PANEL_API_ROUTES.pairings, { headers: H, body: {} });
  check('pairings monté (DTO vide → 400, pas 404)', bootstrap.status === 400);

  const heartbeat = await call('POST', contract.PANEL_API_ROUTES.heartbeats, { headers: H, body: {} });
  check('heartbeats monté (sans token → 401, pas 404)', heartbeat.status === 401);

  const push = await call('POST', contract.PANEL_API_ROUTES.syncPush, { headers: H, body: {} });
  const pull = await call('GET', contract.PANEL_API_ROUTES.syncPull, { headers: H });
  const unpair = await call('DELETE', contract.PANEL_API_ROUTES.pairingCurrent, { headers: H });
  check('sync/push, sync/pull, pairings/current montés',
    push.status === 401 && pull.status === 401 && unpair.status === 401);

  await close();
}

finish();
