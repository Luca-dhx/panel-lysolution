/**
 * CONTRAT ACTUEL ET HISTORIQUE — côté Panel.
 *
 * ── LE DÉFAUT QU'IL VERROUILLE ──────────────────────────────────────────────
 * La fiche affichait l'abonnement, les frais de mise en service, l'activation,
 * la signature, le document et un bouton « Télécharger » d'un contrat RÉSILIÉ,
 * sous une pastille « Contrat terminé ». L'état contractuel du moment et le
 * détail d'un contrat mort se mélangeaient dans la même carte.
 *
 * Le Panel ne DÉDUIT rien : c'est le projet qui dit s'il a un contrat en cours.
 * Ces contrôles vérifient que le Panel reçoit cette distinction, la conserve,
 * et l'affiche telle quelle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const { applyIncoming } = await import('../backend/src/services/sync/syncCore.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { PanelProjectContract } = await import(
  '../backend/src/models/PanelProjectProjection.model.js'
);

const PROJECT_ID = 'projet-contrat';
const ENTITY = '22222222-3333-5444-a555-666666666666';

await registryStore.clear();
await registryStore.insert({
  projectId: PROJECT_ID,
  projectKey: 'projet-contrat',
  projectName: 'Projet Contrat',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  pairing: { status: 'PAIRED', pairingCodeHash: null, pairingCodeExpiresAt: null, bridgeTokenHash: 'x', bridgeTokenEncrypted: 'y', pairedAt: '2026-01-02T00:00:00.000Z', revokedAt: null },
  runtime: { environment: 'TEST', softwareVersion: '1.0.0', contractVersion: '1.4.0', publicBackendUrl: 'https://api.projet.test', lastHeartbeatAt: new Date().toISOString(), lastHealth: null, bridgeStats: null },
  manifest: null,
  manifestSource: null,
});

const pousser = (writeId, payload, modifiedAt) => applyIncoming(PROJECT_ID, [{
  writeId,
  entityType: 'CONTRACT',
  entityId: ENTITY,
  deleted: false,
  payload,
  modifiedAt,
  emitter: 'PROJECT',
}]);

const document = (statut = 'SIGNED') => ({
  available: true,
  status: statut,
  downloadAvailable: statut !== 'UNAVAILABLE',
  filename: 'contrat.pdf',
});

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Un contrat en cours est projeté comme le contrat actuel');
{
  const res = await pousser('w-actif', {
    hasCurrentContract: true,
    sourceContractId: 'c-actif',
    status: 'ACTIVE',
    reference: 'CTR-2026-001',
    document: document(),
    pricing: { subscription: { amountIncludingTax: 9900, currency: 'EUR', interval: 'month' } },
  }, '2026-02-01T10:00:00.000Z');
  check('l’écriture est appliquée', res.results[0].status === 'APPLIED');

  const c = await PanelProjectContract.findOne({ projectId: PROJECT_ID }).lean();
  check('le Panel sait qu’il y a un contrat actuel', c.hasCurrent === true);
  check('…avec son statut', c.status === 'ACTIVE');
  check('…son abonnement', c.pricing.subscription.amountIncludingTax === 9900);
  check('…et son document', c.document.downloadAvailable === true);
  check('l’historique est vide', (c.previousContracts ?? []).length === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Résiliation : plus aucun contrat actuel, tout passe à l’histoire');
{
  const res = await pousser('w-resilie', {
    hasCurrentContract: false,
    previousContracts: [{
      sourceContractId: 'c-actif',
      status: 'ENDED',
      reference: 'CTR-2026-001',
      activatedAt: '2026-02-01T10:00:00.000Z',
      endedAt: '2026-08-04T09:00:00.000Z',
      document: document(),
      pricing: { subscription: { amountIncludingTax: 9900, currency: 'EUR', interval: 'month' } },
    }],
  }, '2026-08-04T09:00:00.000Z');
  check('l’écriture est appliquée', res.results[0].status === 'APPLIED');

  const c = await PanelProjectContract.findOne({ projectId: PROJECT_ID }).lean();
  check('LE POINT CENTRAL : plus de contrat actuel', c.hasCurrent === false);
  check('…aucun statut courant à afficher', c.status === null);
  check('…aucun identifiant de contrat courant', c.sourceContractId === null);

  // Ce qui polluait la carte : l'abonnement, les frais, le document.
  check('…aucun abonnement courant', c.pricing.subscription === null);
  check('…aucun frais de mise en service courant', c.pricing.launchFee === null);
  check('…aucun document courant téléchargeable', c.document.downloadAvailable === false);

  check('le contrat résilié est dans l’historique', c.previousContracts.length === 1);
  check('…avec sa référence', c.previousContracts[0].reference === 'CTR-2026-001');
  check('…son statut terminal', c.previousContracts[0].status === 'ENDED');
  check('…sa date de fin', c.previousContracts[0].endedAt === '2026-08-04T09:00:00.000Z');
  check('…son montant', c.previousContracts[0].pricing.subscription.amountIncludingTax === 9900);
  check('…et son document, toujours téléchargeable',
    c.previousContracts[0].document.downloadAvailable === true);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Plusieurs anciens contrats : l’ordre du projet est conservé');
{
  await pousser('w-plusieurs', {
    hasCurrentContract: false,
    previousContracts: [
      { sourceContractId: 'c-2', status: 'CANCELLED', reference: 'CTR-2', endedAt: '2026-07-01T00:00:00.000Z' },
      { sourceContractId: 'c-1', status: 'ENDED', reference: 'CTR-1', endedAt: '2025-01-01T00:00:00.000Z' },
    ],
  }, '2026-08-05T09:00:00.000Z');

  const c = await PanelProjectContract.findOne({ projectId: PROJECT_ID }).lean();
  check('les deux sont conservés', c.previousContracts.length === 2);
  check('…dans l’ordre reçu, du plus récent au plus ancien',
    c.previousContracts.map((p) => p.reference).join('|') === 'CTR-2|CTR-1');
  check('…et aucun n’est promu contrat actuel', c.hasCurrent === false && c.status === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Un nouveau contrat reprend la place du courant');
{
  await pousser('w-nouveau', {
    hasCurrentContract: true,
    sourceContractId: 'c-3',
    status: 'ACTIVE',
    reference: 'CTR-3',
    document: document('GENERATED'),
    previousContracts: [
      { sourceContractId: 'c-2', status: 'CANCELLED', reference: 'CTR-2', endedAt: '2026-07-01T00:00:00.000Z' },
    ],
  }, '2026-09-01T09:00:00.000Z');

  const c = await PanelProjectContract.findOne({ projectId: PROJECT_ID }).lean();
  check('le nouveau contrat est le courant', c.hasCurrent === true && c.status === 'ACTIVE');
  check('…et l’histoire est remplacée d’un bloc, pas empilée',
    c.previousContracts.length === 1 && c.previousContracts[0].reference === 'CTR-2');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. L’écran ne mélange plus les deux');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const carte = lire('frontend/src/components/ContractCard.tsx');
  const liste = lire('frontend/src/pages/ProjectsPage.tsx');
  const css = lire('frontend/src/components.css');

  check('sans contrat actuel, la carte le DIT',
    /contract\.hasCurrent === false \|\| !contract\.status/.test(carte)
    && carte.includes('Aucun contrat actif'));
  check('…et donne la date de fin du dernier contrat',
    /Le dernier contrat a pris fin le \{formatDateTime\(dernier\.endedAt\)\}/.test(carte));

  // Le retour en arrière : ces blocs ne doivent PAS être rendus sans courant.
  const bloqueSansCourant = carte.slice(
    carte.indexOf('if (contract.hasCurrent === false'),
    carte.indexOf('const doc = contract.document;'),
  );
  check('aucun abonnement dans la carte sans contrat actuel',
    !/Abonnement/.test(bloqueSansCourant));
  check('aucun frais de mise en service', !/Mise en service/.test(bloqueSansCourant));
  check('aucun document ni bouton de téléchargement',
    !/Télécharger/.test(bloqueSansCourant));
  check('aucune pastille d’état contractuel trompeuse',
    !/toneBadgeClass\(statut\.tone\)/.test(bloqueSansCourant));

  check('l’historique est une section à part', carte.includes('Historique des contrats'));
  check('…dépliable au clic', /aria-expanded=\{deplie\}/.test(carte));
  check('…avec référence, état, dates et montant en ligne compacte',
    /contract-history-ref/.test(carte) && /contract-history-line/.test(carte));
  check('…et le détail complet à l’ouverture',
    /Terminé le/.test(carte) && /Motif/.test(carte));
  // « Signé le » a quitté la liste : il vit désormais dans la fiche de fichier,
  // avec le nom, le format et le nombre de pages.
  check('…la date de signature accompagne le FICHIER',
    /signé le \$\{formatDateTime\(signedAt\)\}/.test(carte));
  // La décision ne vit plus dans le JSX : elle vient du calcul central, qui
  // sépare le document, la connexion et la fraîcheur. Cf.
  // `contract-document-matrix.test.js`, qui l'éprouve à l'exécution.
  check('le téléchargement d’un contrat passé reste possible',
    /<DocumentFile[\s\S]{0,300}presentation=\{docEtat\}/.test(carte)
    && /presentation\.showDownload \? \([\s\S]{0,300}Télécharger/.test(carte));
  check('…mais seulement si le projet peut le servir',
    /const docEtat = getContractDocumentPresentation\(\{[\s\S]{0,220}freshness: fraicheur,[\s\S]{0,120}paired: project\.pairing\.status === 'PAIRED'/
      .test(carte.slice(carte.indexOf('function ContractHistory'))));
  check('…sinon on affiche la raison RÉELLE, pas un message figé',
    /presentation\.message \? <p className="doc-file-note">\{presentation\.message\}<\/p>/.test(carte)
    && !carte.includes('Document momentanément indisponible.'));

  check('la liste des projets n’affiche plus l’état d’un contrat terminé',
    /contract\?\.status && contract\.hasCurrent !== false/.test(liste));
  check('« Aucun contrat actif » a son style', css.includes('.contract-none'));
  check('…et l’historique aussi', css.includes('.contract-history-line'));
}

await stopMemoryMongo();
finish();
