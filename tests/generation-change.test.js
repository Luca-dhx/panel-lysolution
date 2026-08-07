/**
 * CHANGEMENT DE GÉNÉRATION — PROD → TEST sur la même destination.
 *
 * ── LE SCÉNARIO RÉEL ────────────────────────────────────────────────────────
 * Une destination déployée en PROD publie son identité, son contrat ACTIVE et
 * son équipe. Elle est redéployée en TEST : autre base, autre contrat (résilié
 * aussitôt), autre équipe. Le `projectId` du registre, lui, ne bouge pas.
 *
 * Le Panel continuait d'afficher PROD comme l'état courant : le contrat TEST,
 * plus ANCIEN en date, était écarté par le dernier-écrit-gagne ; les membres
 * PROD n'étaient enterrés par personne, la nouvelle instance ne les connaissant
 * pas ; et rien à l'écran ne distinguait une donnée constatée d'une relique.
 *
 * Ces contrôles verrouillent le comportement inverse.
 */
import { register } from 'node:module';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

// La règle de fraîcheur vit dans le frontend : on branche la résolution des
// alias `@/` pour l'exécuter telle quelle, sans la réécrire ici.
register('./helpers/frontendLoader.mjs', import.meta.url);

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { applyIncoming } = await import('../backend/src/services/sync/syncCore.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { toPublicProject, loadBusinessProjections, loadProjectTeam } = await import(
  '../backend/src/services/registry/projectRegistry.service.js'
);
const { currentGeneration } = await import('../backend/src/services/sync/projectGeneration.js');
const {
  PanelProjectContract,
  PanelProjectMember,
  PanelProjectPresentation,
} = await import('../backend/src/models/PanelProjectProjection.model.js');

const PROJECT_ID = 'projet-redeploye';
const ENTITY = '11111111-2222-5333-a444-555555555555';

const fiche = (environment, pairedAt) => ({
  projectId: PROJECT_ID,
  projectKey: 'projet-redeploye',
  projectName: 'Projet redéployé',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  pairing: {
    status: 'PAIRED',
    pairingCodeHash: null,
    pairingCodeExpiresAt: null,
    bridgeTokenHash: 'x',
    bridgeTokenEncrypted: 'y',
    pairedAt,
    revokedAt: null,
  },
  runtime: {
    environment,
    softwareVersion: '1.0.0',
    contractVersion: '1.4.0',
    publicBackendUrl: 'https://api.projet.test',
    lastHeartbeatAt: new Date().toISOString(),
    lastHealth: null,
    bridgeStats: null,
  },
  manifest: null,
  manifestSource: null,
});

const ecriture = (writeId, entityType, payload, modifiedAt, entityId = ENTITY) => ({
  writeId,
  entityType,
  entityId,
  deleted: payload === null,
  payload,
  modifiedAt,
  emitter: 'PROJECT',
});

const contrat = (status) => ({
  sourceContractId: `contrat-${status}`,
  status,
  document: { available: false, status: 'NONE', downloadAvailable: false },
});

const membre = (email, role = 'ADMIN') => ({
  sourceUserId: `u-${email}`,
  email,
  name: email.split('@')[0],
  role,
});

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Génération PROD — la photographie initiale');
{
  await registryStore.clear();
  await registryStore.insert(fiche('PROD', '2026-02-01T10:00:00.000Z'));

  const res = await applyIncoming(PROJECT_ID, [
    ecriture('w-prod-contrat', 'CONTRACT', contrat('ACTIVE'), '2026-06-01T12:00:00.000Z'),
    ecriture('w-prod-m1', 'TEAM_MEMBER', membre('patron@prod.test'), '2026-06-01T12:00:00.000Z', 'm-prod-1'),
    ecriture('w-prod-m2', 'TEAM_MEMBER', membre('compta@prod.test'), '2026-06-01T12:00:00.000Z', 'm-prod-2'),
  ]);
  check('les trois écritures sont appliquées',
    res.results.every((r) => r.status === 'APPLIED'));

  const c = await PanelProjectContract.findOne({ projectId: PROJECT_ID }).lean();
  check('le contrat PROD est projeté', c.status === 'ACTIVE');
  check('…et porte SA génération', c.sourceEnvironment === 'PROD');
  /**
   * La clé est nommée par environnement, appairage ET destination. Ce projet
   * n'a aucune destination active : le comparant doit donc le DIRE (`null`),
   * pas omettre l'argument — omettre veut désormais dire « je ne sais pas »,
   * ce qui n'est pas la même chose et ne se compare pas pareil.
   */
  check('…nommée par environnement, appairage et destination',
    c.sourceGeneration
      === currentGeneration(fiche('PROD', '2026-02-01T10:00:00.000Z'), null).generation);
  check('l’équipe PROD compte deux membres',
    (await PanelProjectMember.countDocuments({ projectId: PROJECT_ID })) === 2);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Redéploiement en TEST — le contrat résilié REMPLACE l’actif');
{
  // La même destination, réappairée en TEST : nouvelle génération.
  await registryStore.save(fiche('TEST', '2026-08-04T09:00:00.000Z'));

  // Le contrat TEST est plus ANCIEN en date que le contrat PROD : c'est
  // exactement le cas qui était écarté par le dernier-écrit-gagne.
  const res = await applyIncoming(PROJECT_ID, [
    ecriture('w-test-contrat', 'CONTRACT', contrat('ENDED'), '2026-03-15T08:00:00.000Z'),
  ]);
  check('l’écriture TEST est APPLIQUÉE malgré sa date antérieure',
    res.results[0].status === 'APPLIED');

  const c = await PanelProjectContract.findOne({ projectId: PROJECT_ID }).lean();
  check('le contrat affiché est celui de TEST', c.status === 'ENDED');
  check('…plus aucun ACTIVE trompeur', c.status !== 'ACTIVE');
  check('…et il porte la génération TEST', c.sourceEnvironment === 'TEST');
  check('le contrat PROD a bien été remplacé, pas ajouté',
    (await PanelProjectContract.countDocuments({ projectId: PROJECT_ID })) === 1);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Le roster TEST remplace le roster PROD');
{
  const res = await applyIncoming(PROJECT_ID, [
    ecriture('w-test-m1', 'TEAM_MEMBER', membre('dev@test.test'), '2026-03-15T08:00:00.000Z', 'm-test-1'),
  ]);
  check('le membre TEST est appliqué', res.results[0].status === 'APPLIED');

  const membres = await PanelProjectMember.find({ projectId: PROJECT_ID }).lean();
  check('l’équipe ne contient plus qu’un membre', membres.length === 1);
  check('…celui de TEST', membres[0].email === 'dev@test.test');
  check('…et aucun compte PROD ne subsiste',
    membres.every((m) => !m.email.endsWith('@prod.test')));
  check('les deux mondes ne se mélangent jamais',
    membres.every((m) => m.sourceEnvironment === 'TEST'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. À l’intérieur d’une génération, le dernier-écrit-gagne tient');
{
  const res = await applyIncoming(PROJECT_ID, [
    ecriture('w-test-vieux', 'CONTRACT', contrat('ACTIVE'), '2026-03-01T08:00:00.000Z'),
  ]);
  check('une écriture plus ancienne de la MÊME génération est ignorée',
    res.results[0].status === 'IGNORED');
  check('…et le contrat ne bouge pas',
    (await PanelProjectContract.findOne({ projectId: PROJECT_ID }).lean()).status === 'ENDED');

  const plusRecent = await applyIncoming(PROJECT_ID, [
    ecriture('w-test-recent', 'CONTRACT', contrat('CANCELLED'), '2026-09-01T08:00:00.000Z'),
  ]);
  check('une écriture plus récente passe', plusRecent.results[0].status === 'APPLIED');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. La fiche projet dit d’où viennent ses données');
{
  // Retour à une projection PROD sur un runtime TEST — la situation exacte
  // rencontrée avant que la nouvelle instance ne publie quoi que ce soit.
  await PanelProjectPresentation.deleteMany({ projectId: PROJECT_ID });
  await PanelProjectContract.updateOne(
    { projectId: PROJECT_ID },
    { $set: { sourceEnvironment: 'PROD', sourceGeneration: 'PROD|2026-02-01T10:00:00.000Z' } },
  );

  const record = await registryStore.getById(PROJECT_ID);
  const projections = await loadBusinessProjections([PROJECT_ID]);
  const publie = toPublicProject(record, Date.now(), projections.get(PROJECT_ID));
  const f = publie.business.freshness;

  check('la fiche expose la fraîcheur', Boolean(f));
  check('…l’environnement de la projection', f.projectionEnvironment === 'PROD');
  check('…celui déclaré aujourd’hui', f.runtimeEnvironment === 'TEST');
  check('…et les deux générations, différentes',
    f.projectionGeneration !== f.runtimeGeneration);
  check('…avec la date de dernière synchronisation', typeof f.lastSyncAt === 'string');
  check('aucun chemin ni secret dans ces faits',
    !JSON.stringify(f).includes('bridgeToken'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Une génération inconnue ne périme rien');
{
  // Les projections reçues AVANT cette notion n'ont pas de génération : elles
  // ne doivent pas être déclarées périmées d'office.
  await registryStore.clear();
  await registryStore.insert(fiche('PROD', '2026-02-01T10:00:00.000Z'));
  await PanelProjectContract.deleteMany({});
  await PanelProjectMember.deleteMany({});

  await applyIncoming(PROJECT_ID, [
    ecriture('w-legacy', 'CONTRACT', contrat('ACTIVE'), '2026-06-01T12:00:00.000Z'),
  ]);
  await PanelProjectContract.updateOne(
    { projectId: PROJECT_ID },
    { $unset: { sourceGeneration: '', sourceEnvironment: '' } },
  );
  const { PanelSyncEntityState } = await import('../backend/src/models/PanelSyncState.model.js');
  await PanelSyncEntityState.updateMany({ projectId: PROJECT_ID }, { $unset: { generation: '' } });

  const res = await applyIncoming(PROJECT_ID, [
    ecriture('w-legacy-vieux', 'CONTRACT', contrat('ENDED'), '2026-01-01T12:00:00.000Z'),
  ]);
  check('sans génération connue, le dernier-écrit-gagne reste la règle',
    res.results[0].status === 'IGNORED');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. L’équipe se lit toujours par projet');
{
  const team = await loadProjectTeam(PROJECT_ID);
  check('aucun membre d’un autre projet ne s’y invite',
    team.every((m) => m.projectId === PROJECT_ID));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. La règle de fraîcheur — une seule, exécutée');
{
  const { getProjectDataFreshness, actionsDistantesPossibles } = await import(
    '@/lib/projectFreshness'
  );
  /**
   * LES VERDICTS VIENNENT DU BACKEND — l'écran ne compare plus les clés.
   *
   * Il le faisait, par inégalité de chaînes, sans savoir qu'une case de la clé
   * peut valoir « je ne sais pas » : il lisait alors une ignorance comme un
   * désaccord et périmait des données fraîches. Ces doubles portent donc la
   * charge utile RÉELLE de `describeFreshness`, verdicts compris.
   */
  const projet = (liveness, projectionEnv, runtimeEnv, generations = ['g1', 'g1']) => ({
    liveness,
    runtime: { lastHeartbeatAt: '2026-08-04T09:00:00.000Z' },
    business: {
      freshness: {
        projectionEnvironment: projectionEnv,
        runtimeEnvironment: runtimeEnv,
        projectionGeneration: generations[0],
        runtimeGeneration: generations[1],
        generationMismatch: generations[0] !== generations[1],
        environmentMismatch: Boolean(
          projectionEnv && runtimeEnv && projectionEnv !== runtimeEnv,
        ),
        destinationKnown: true,
        lastSyncAt: '2026-06-01T12:00:00.000Z',
      },
    },
  });

  const enLigne = getProjectDataFreshness(projet('ONLINE', 'TEST', 'TEST'));
  check('projet en ligne, même environnement → données fraîches',
    enLigne.isBusinessDataFresh === true && enLigne.connection === 'ONLINE');
  check('…et les actions distantes sont possibles',
    actionsDistantesPossibles(enLigne) === true);

  const horsLigne = getProjectDataFreshness(projet('OFFLINE', 'TEST', 'TEST'));
  check('projet injoignable → données NON fraîches',
    horsLigne.isBusinessDataFresh === false && horsLigne.connection === 'OFFLINE');
  check('…aucune action distante', actionsDistantesPossibles(horsLigne) === false);
  check('…mais le dernier contact reste lisible',
    horsLigne.lastContactAt === '2026-08-04T09:00:00.000Z');
  check('…ainsi que la dernière synchronisation',
    horsLigne.lastFullSyncAt === '2026-06-01T12:00:00.000Z');

  const croise = getProjectDataFreshness(projet('ONLINE', 'PROD', 'TEST', ['g1', 'g2']));
  check('projection PROD sur runtime TEST → incohérence signalée',
    croise.isEnvironmentMismatch === true && croise.isGenerationMismatch === true);
  check('…données non fraîches malgré un projet EN LIGNE',
    croise.isBusinessDataFresh === false);
  check('…et aucune action distante', actionsDistantesPossibles(croise) === false);

  const inconnu = getProjectDataFreshness(projet('ONLINE', null, 'TEST'));
  check('un environnement inconnu n’est pas un conflit',
    inconnu.isEnvironmentMismatch === false);

  const perime = getProjectDataFreshness(projet('STALE', 'TEST', 'TEST'));
  check('un signal périmé n’est pas « en ligne »',
    perime.connection === 'STALE' && perime.isBusinessDataFresh === false);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('9. Les écrans obéissent à cette règle, et à elle seule');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

  const fiche = lire('frontend/src/pages/ProjectDetailPage.tsx');
  const bandeau = lire('frontend/src/components/FreshnessBanner.tsx');
  const contrat = lire('frontend/src/components/ContractCard.tsx');
  const css = lire('frontend/src/components.css');

  check('la fiche calcule la fraîcheur UNE fois',
    (fiche.match(/getProjectDataFreshness\(project\)/g) || []).length === 1);
  check('le bandeau est rendu AVANT toute donnée métier',
    fiche.indexOf('<FreshnessBanner') < fiche.indexOf('<OverviewTab'));
  check('…et disparaît quand tout va bien',
    /if \(fraicheur\.isBusinessDataFresh\) return null;/.test(bandeau));

  check('le bandeau nomme le projet injoignable',
    bandeau.includes('Projet actuellement injoignable'));
  check('…prévient que les données peuvent être obsolètes',
    bandeau.includes('Les informations affichées ci-dessous peuvent être obsolètes.'));
  /**
   * DEUX RUPTURES, DEUX TITRES — et ils ne se confondent plus.
   *
   * Le bandeau annonçait « Données de l'environnement précédent » sur un
   * changement d'INSTANCE, puis listait deux environnements identiques. Le
   * lecteur cherchait un changement qui n'avait pas eu lieu.
   */
  check('…nomme un désaccord d’ENVIRONNEMENT pour ce qu’il est',
    bandeau.includes('Données d’un autre environnement'));
  check('…et un changement d’INSTANCE pour ce qu’il est',
    bandeau.includes('Données de l’instance précédente'));
  check('…sans jamais reparler d’environnement précédent quand il n’a pas changé',
    !bandeau.includes('Données de l’environnement précédent'));
  check('…et donne les quatre repères',
    bandeau.includes('Dernier contact')
    && bandeau.includes('Dernière photographie reçue')
    && bandeau.includes('Environnement de la dernière photographie')
    && bandeau.includes('Environnement actuellement déclaré'));
  check('il porte une icône d’avertissement', /<Icon name="plug"/.test(bandeau));
  check('…et un style d’alerte forte, pas un texte perdu',
    /\.freshness-banner \{[\s\S]{0,400}border-left-width: 4px/.test(css));
  check('…responsive', /\.freshness-banner-facts \{[\s\S]{0,200}auto-fit/.test(css));

  check('une valeur incertaine devient « dernier état connu »',
    bandeau.includes('Dernier état connu'));
  check('…et porte la mention d’obsolescence',
    bandeau.includes('Donnée potentiellement obsolète'));
  check('le contrat annonce l’attente de synchronisation',
    contrat.includes('Statut actuel : en attente de synchronisation'));
  check('l’équipe aussi', fiche.includes('Équipe actuelle : en attente de synchronisation'));

  // Génération/environnement divergents : ni téléchargement, ni action
  // distante. La règle est portée par la présentation centrale, et non plus
  // recopiée dans chaque bloc JSX.
  check('les actions contractuelles suivent la même règle',
    /!doc0\.showRemoteActions \? \(/.test(contrat)
    && /raisonActionsIndisponibles\(fraicheur, project\)/.test(contrat));
  check('…et le téléchargement en dépend',
    /<DocumentFile[\s\S]{0,200}presentation=\{doc0\}/.test(contrat)
    && /presentation\.showDownload \? \(/.test(contrat)
    && /freshness: fraicheur,/.test(contrat));
}

await stopMemoryMongo();
finish();
