/**
 * ACTIONS CONTRACTUELLES DEPUIS LE PANEL — demander, jamais décider.
 *
 * Ce que ces contrôles verrouillent : que la résiliation immédiate reste
 * impossible sur un projet de production, y compris en appelant l'API
 * directement ; que toute demande laisse une trace même quand elle échoue ;
 * et que le Panel ne modifie JAMAIS sa propre projection du contrat.
 */
import http from 'node:http';
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

const { createApp } = await import('../backend/src/app.js');
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const { PanelProjectContract } = await import(
  '../backend/src/models/PanelProjectProjection.model.js'
);
const { PanelContractAction } = await import(
  '../backend/src/models/PanelContractAction.model.js'
);
const { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } = await import(
  '../backend/src/bridge/bridgeContract.js'
);

await seedFromEnv();
const { call, close } = await startServer(createApp());

/* ── Un PROJET de mensonge, mais un vrai serveur HTTP ────────────────────── */
const recu = { invocations: [], documents: 0 };
const projet = http.createServer((req, res) => {
  const envoyer = (code, corps) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corps));
  };
  if (req.url.endsWith('/operations')) {
    return envoyer(200, {
      success: true,
      data: {
        contractVersion: CONTRACT_VERSION,
        operations: [
          { id: 'contract.cancel_at_period_end', label: 'Programmer la résiliation', available: true },
          { id: 'contract.cancel_now', label: 'Résilier immédiatement', available: true },
        ],
      },
    });
  }
  if (req.url.includes('/operations/') && req.method === 'POST') {
    let corps = '';
    req.on('data', (c) => { corps += c; });
    return req.on('end', () => {
      recu.invocations.push({ url: req.url, body: JSON.parse(corps || '{}') });
      envoyer(200, {
        success: true,
        data: {
          operationId: 'contract.cancel_at_period_end',
          status: 'SUCCEEDED',
          contract: {
            previousStatus: 'ACTIVE',
            newStatus: 'CANCEL_AT_PERIOD_END',
            endsAt: '2026-09-01T00:00:00.000Z',
          },
        },
      });
    });
  }
  if (req.url.includes('/document')) {
    recu.documents += 1;
    res.writeHead(200, { 'content-type': 'application/pdf' });
    return res.end(Buffer.from('%PDF-1.4 faux document'));
  }
  return envoyer(404, { success: false });
});
await new Promise((r) => projet.listen(0, '127.0.0.1', r));
const projetUrl = `http://127.0.0.1:${projet.address().port}`;

/* ── Un projet APPAIRÉ, en TEST ──────────────────────────────────────────── */
const declare = await registry.declareProject({
  publicBackendUrl: projetUrl,
  projectName: 'Garage de recette',
});
const projectId = declare.record.projectId;
const paire = await call('POST', '/bridge/v1/pairings', {
  headers: { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION },
  body: {
    contractVersion: CONTRACT_VERSION,
    projectKey: 'garage-recette',
    projectName: 'Garage de recette',
    environment: 'TEST',
    softwareVersion: '1.0.0',
    publicBackendUrl: projetUrl,
    pairingCode: declare.pairingCode,
  },
});
const bridgeToken = paire.json.data.bridgeToken;

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

// Une projection de contrat AVEC document, poussée par le pont — le chemin normal.
await call('POST', '/bridge/v1/sync/push', {
  headers: { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION, authorization: `Bearer ${bridgeToken}` },
  body: {
    changes: [{
      writeId: crypto.randomUUID(),
      entityType: 'CONTRACT',
      entityId: crypto.randomUUID(),
      deleted: false,
      modifiedAt: new Date().toISOString(),
      emitter: 'PROJECT',
      payload: {
        sourceContractId: 'ctr-1',
        status: 'ACTIVE',
        reference: 'CTR-2026-0001',
        document: {
          available: true,
          kind: 'SIGNED',
          filename: 'contrat-CTR-2026-0001.pdf',
          pageCount: 4,
          version: 2,
          signatureStatus: 'DONE',
          downloadPath: '/api/project-bridge/v1/contracts/ctr-1/document',
        },
      },
    }],
  },
});

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Le document est DÉCRIT, jamais stocké');
{
  const fiche = await call('GET', `/api/projects/${projectId}`, { headers: AUTH });
  const doc = fiche.json?.data?.project?.business?.contract?.document;
  check('la fiche annonce un document disponible', doc?.available === true);
  check('…signé', doc.kind === 'SIGNED' && doc.signatureStatus === 'DONE');
  check('…avec son nom lisible', doc.filename === 'contrat-CTR-2026-0001.pdf');
  check('aucun chemin disque n’apparaît dans la fiche',
    !/storage[/\\]contracts/.test(JSON.stringify(fiche.json)));
}

section('2. Le PDF est relayé depuis le PROJET, pas servi depuis le Panel');
{
  const avant = recu.documents;
  const res = await call('GET', `/api/projects/${projectId}/contract/document`, { headers: AUTH });
  check('le téléchargement répond 200', res.status === 200);
  check('…en PDF', (res.headers.get('content-type') || '').includes('application/pdf'));
  check('…et c’est bien le PROJET qui a servi le fichier', recu.documents === avant + 1);

  const sansJwt = await call('GET', `/api/projects/${projectId}/contract/document`);
  check('sans authentification : refusé', sansJwt.status === 401);
}

section('3. Catalogue : le Panel demande au projet ce qu’il accepte');
{
  const res = await call('GET', `/api/projects/${projectId}/contract/operations`, { headers: AUTH });
  check('le catalogue est relayé', res.json?.data?.operations?.length === 2);
  check('…et le projet est joignable', res.json.data.reachable === true);
  check('l’environnement du projet est annoncé', res.json.data.environment === 'TEST');
}

section('4. TEST : la résiliation immédiate est permise, et tracée');
{
  const avantProjection = await PanelProjectContract.findOne({ projectId }).lean();
  const res = await call('POST', `/api/projects/${projectId}/contract/cancel`, {
    headers: AUTH,
    body: { operationId: 'contract.cancel_now', reason: 'Recette' },
  });
  check('la demande aboutit', res.status === 200);
  check('…et le PROJET a bien été invoqué',
    recu.invocations.at(-1)?.url.includes('contract.cancel_now'));
  check('…avec un invocationId (idempotence)',
    typeof recu.invocations.at(-1)?.body?.invocationId === 'string');
  check('…et le motif transmis', recu.invocations.at(-1)?.body?.params?.reason === 'Recette');

  const journal = await PanelContractAction.findOne({ projectId, operationId: 'contract.cancel_now' }).lean();
  check('l’action est journalisée', !!journal);
  check('…avec son initiateur', typeof journal.actor?.email === 'string' && journal.actor.email.length > 0);
  check('…l’ancienne et la nouvelle valeur',
    journal.contract.previousStatus === 'ACTIVE' && journal.contract.newStatus === 'CANCEL_AT_PERIOD_END');
  check('…le motif', journal.reason === 'Recette');
  check('…le résultat', journal.outcome === 'SUCCEEDED');
  check('…et l’environnement', journal.environment === 'TEST');

  // LE POINT CENTRAL : le Panel n'a pas touché à sa projection.
  const apres = await PanelProjectContract.findOne({ projectId }).lean();
  check('le Panel n’a PAS modifié sa projection du contrat',
    apres.status === avantProjection.status && apres.status === 'ACTIVE');
}

section('5. PROD : la résiliation immédiate est IMPOSSIBLE, même par l’API');
{
  const fiche = await registryStore.getById(projectId);
  fiche.runtime.environment = 'PROD';
  await registryStore.save(fiche);

  const avant = recu.invocations.length;
  const res = await call('POST', `/api/projects/${projectId}/contract/cancel`, {
    headers: AUTH,
    body: { operationId: 'contract.cancel_now', reason: 'Tentative' },
  });
  check('l’appel direct est REFUSÉ (403)', res.status === 403);
  check('…avec un code explicite',
    res.json?.code === 'PANEL_CONTRACT_IMMEDIATE_CANCEL_FORBIDDEN');
  check('…et le projet n’a JAMAIS été appelé', recu.invocations.length === avant);
  check('…aucune trace d’action réussie',
    (await PanelContractAction.countDocuments({ projectId, environment: 'PROD' })) === 0);

  // La résiliation à l'échéance, elle, reste possible en production.
  const echeance = await call('POST', `/api/projects/${projectId}/contract/cancel`, {
    headers: AUTH,
    body: { operationId: 'contract.cancel_at_period_end' },
  });
  check('la résiliation À L’ÉCHÉANCE reste possible en PROD', echeance.status === 200);
}

section('6. Une action inconnue ne part jamais');
{
  const avant = recu.invocations.length;
  const res = await call('POST', `/api/projects/${projectId}/contract/cancel`, {
    headers: AUTH, body: { operationId: 'contract.delete_everything' },
  });
  check('opération hors liste : refusée', res.status === 400);
  check('…et rien n’a été transmis au projet', recu.invocations.length === avant);
}

section('7. Projet injoignable : l’échec est tracé, pas avalé');
{
  const fiche = await registryStore.getById(projectId);
  fiche.runtime.publicBackendUrl = 'http://127.0.0.1:1';
  await registryStore.save(fiche);

  const res = await call('POST', `/api/projects/${projectId}/contract/cancel`, {
    headers: AUTH, body: { operationId: 'contract.cancel_at_period_end', reason: 'Hors ligne' },
  });
  check('la demande échoue franchement', res.status >= 400);
  const journal = await PanelContractAction.findOne({ projectId, reason: 'Hors ligne' }).lean();
  check('…mais la tentative est journalisée', !!journal);
  check('…avec son échec', journal.outcome === 'FAILED');
  check('…et le motif technique conservé', typeof journal.errorMessage === 'string');

  const catalogue = await call('GET', `/api/projects/${projectId}/contract/operations`, { headers: AUTH });
  check('le catalogue dit « injoignable » plutôt que de casser',
    catalogue.status === 200 && catalogue.json.data.reachable === false);
}

await close();
await new Promise((r) => projet.close(r));
await stopMemoryMongo();
finish();
