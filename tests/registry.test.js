// Le registre + l'appairage au niveau service : un projet conforme au
// Manager Standard peut être déclaré, appairé, supervisé, révoqué, ré-appairé.
// Contrat 1.1.0 : le Manifest officiel voyage avec le bootstrap.
import {
  check,
  connectTestDatabase,
  finish,
  rejectsWith,
  section,
  setTestEnv,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
process.env.HEARTBEAT_INTERVAL_S = '300';
await startMemoryMongo();
await connectTestDatabase();

const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const pairing = await import('../backend/src/services/pairing/pairing.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { CONTRACT_VERSION } = await import('../backend/src/bridge/bridgeContract.js');

function conformManifest(overrides = {}) {
  return {
    manifestVersion: '1.0.0',
    project: {
      key: 'garage-exemple',
      name: 'Garage Exemple',
      // Le Panel de test sert TEST : un projet PROD serait refusé au bootstrap
      // (BRIDGE_ENVIRONMENT_MISMATCH), ce qu'un test dédié vérifie séparément.
      environment: 'TEST',
      softwareVersion: 'abc1234',
      ...(overrides.project ?? {}),
    },
    bridge: { contractVersion: CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: CONTRACT_VERSION, projectBridge: CONTRACT_VERSION },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [{ id: 'panel-bridge', title: 'Pont Panel', status: 'ACTIVE' }],
    features: [
      { id: 'sync.diagnostic', status: 'AVAILABLE' },
      { id: 'sync.contracts', status: 'AVAILABLE' },
      { id: 'sync.invoicing', status: 'RESERVED' },
    ],
  };
}

function bootstrapDto(pairingCode, overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    publicBackendUrl: 'https://garage-exemple.test',
    projectName: 'Garage Exemple',
    environment: 'TEST',
    softwareVersion: '1.4.2',
    publicBackendUrl: 'https://api.garage-exemple.fr',
    pairingCode,
    ...overrides,
  };
}

await registryStore.clear();

section('Déclaration d’un projet conforme au Manager Standard');
let declared;
{
  declared = await registry.declareProject({
    publicBackendUrl: 'https://garage-exemple.test',
    projectName: 'Garage Exemple',
    manifest: conformManifest(),
  });
  check('fiche créée en DECLARED', declared.record.pairing.status === 'DECLARED');
  check('projectId UUID délivré', /^[0-9a-f-]{36}$/.test(declared.record.projectId));
  check('code au format lisible PAIR-XXXX-XXXX-XXXX', /^PAIR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(declared.pairingCode));
  check('le code n’est stocké qu’en hash', declared.record.pairing.pairingCodeHash !== declared.pairingCode
    && /^[0-9a-f]{64}$/.test(declared.record.pairing.pairingCodeHash));
  check('expiration posée', typeof declared.pairingCodeExpiresAt === 'string');
  check('manifest validé et conservé', declared.record.manifest.project.key === 'garage-exemple');
  check('manifest saisi manuellement → source MANUAL', declared.record.manifestSource === 'MANUAL');
}

section('Garde-fous de déclaration');
{
  // ── ANTI-DOUBLONS ────────────────────────────────────────────────────────
  // Trois portes mènent au même projet ; les trois doivent être fermées, et
  // avec le MÊME code : c'est le même fait, pas trois incidents différents.
  check('même adresse → refus', await rejectsWith(
    () => registry.declareProject({ publicBackendUrl: 'https://garage-exemple.test', projectName: 'Doublon' }),
    'PANEL_PROJECT_ALREADY_DECLARED',
  ));
  check('même adresse écrite autrement (casse, port, barre finale) → refus', await rejectsWith(
    () => registry.declareProject({ publicBackendUrl: 'https://Garage-Exemple.TEST:443/', projectName: 'Doublon' }),
    'PANEL_PROJECT_ALREADY_DECLARED',
  ));
  check('autre adresse mais même clé dérivée → refus', await rejectsWith(
    () => registry.declareProject({ publicBackendUrl: 'https://autre-adresse.test', projectName: 'Garage Exemple' }),
    'PANEL_PROJECT_ALREADY_DECLARED',
  ));
  check('autre adresse mais même identité annoncée par le pont → refus', await rejectsWith(
    () => registry.declareProject({
      publicBackendUrl: 'https://encore-une-autre.test',
      projectName: 'Nom Sans Rapport',
      bridgeIdentity: { projectKey: 'garage-exemple', projectName: 'Garage Exemple' },
    }),
    'PANEL_PROJECT_ALREADY_DECLARED',
  ));

  check('URL absente ou non http(s) refusée', await rejectsWith(
    () => registry.declareProject({ publicBackendUrl: 'pas-une-url', projectName: 'X' }),
    'PANEL_PROJECT_URL_INVALID',
  ));
  check('manifest invalide refusé à la déclaration', await rejectsWith(
    () => registry.declareProject({ publicBackendUrl: 'https://autre-projet.test', projectName: 'X', manifest: { nope: true } }),
    'PANEL_MANIFEST_INVALID',
  ));
}

section('Bootstrap (appairage) — avec Manifest 1.1 joint');
let bootstrapResult;
{
  check('Manifest joint dont project.key diverge → refus AVANT consommation du code', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(declared.pairingCode, {
      manifest: conformManifest({ project: { key: 'cle-volee' } }),
    }))),
    'BRIDGE_INVALID_PAYLOAD',
  ));

  bootstrapResult = await pairing.bootstrap(bootstrapDto(declared.pairingCode, {
    manifest: conformManifest(),
  }));
  check('le code n’a PAS été grillé par le refus précédent', typeof bootstrapResult.bridgeToken === 'string');
  check('bridgeToken délivré', bootstrapResult.bridgeToken.length === 64);
  check('projectId du registre renvoyé', bootstrapResult.projectId === declared.record.projectId);
  check('identité du Panel renvoyée', bootstrapResult.panel.contractVersion === CONTRACT_VERSION);

  const record = await registryStore.getById(declared.record.projectId);
  check('fiche PAIRED', record.pairing.status === 'PAIRED');
  check('Manifest du bootstrap conservé', record.manifest.project.key === 'garage-exemple');
  check('Manifest reçu par le pont → source BRIDGE', record.manifestSource === 'BRIDGE');
  check('token stocké en hash, jamais en clair', record.pairing.bridgeTokenHash !== bootstrapResult.bridgeToken);
  check('copie chiffrée présente pour les appels sortants', typeof record.pairing.bridgeTokenEncrypted === 'string');
  check('copie chiffrée déchiffrable par le seul chemin prévu',
    pairing.getOutboundBridgeToken(record) === bootstrapResult.bridgeToken);
  check('code consommé', record.pairing.pairingCodeHash === null);
  check('runtime déclaré enregistré', record.runtime.softwareVersion === '1.4.2'
    && record.runtime.publicBackendUrl === 'https://api.garage-exemple.fr');
  check('rejouer le même code échoue (usage unique)', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(declared.pairingCode))),
    'BRIDGE_PAIRING_CODE_INVALID',
  ));
}

section('Le Manifest du pont fait foi : la saisie manuelle est verrouillée');
{
  check('PUT manuel refusé quand la source est BRIDGE', await rejectsWith(
    () => registry.updateManifest(declared.record.projectId, conformManifest()),
    'PANEL_MANIFEST_BRIDGE_AUTHORITATIVE',
  ));
}

section('Authentification par bridgeToken');
{
  const record = await pairing.authenticateBridgeToken(bootstrapResult.bridgeToken);
  check('token valide → fiche du projet', record?.projectKey === 'garage-exemple');
  check('token inconnu → null', (await pairing.authenticateBridgeToken('f'.repeat(64))) === null);
  check('token vide → null', (await pairing.authenticateBridgeToken('')) === null);
}

section('Conformité Manager Standard');
{
  const record = await registryStore.getById(declared.record.projectId);
  const conformity = registry.describeConformity(record);
  check('manifest présent', conformity.hasManifest === true);
  check('identité manifest ↔ registre cohérente', conformity.identityConsistent === true);
  check('appairé', conformity.paired === true);
  const tampered = {
    ...record,
    manifest: { ...record.manifest, project: { ...record.manifest.project, key: 'autre-cle' } },
  };
  check('divergence d’identité détectée', registry.describeConformity(tampered).identityConsistent === false);
}

section('Vivacité (dérivée, jamais stockée)');
{
  const record = await registryStore.getById(declared.record.projectId);
  check('appairé sans heartbeat : NEVER_SEEN', registry.deriveLiveness(record) === 'NEVER_SEEN');
  await registry.recordHeartbeat(record, {
    sentAt: new Date().toISOString(),
    softwareVersion: '1.4.3',
    environment: 'TEST',
    health: { status: 'OK', details: null },
    bridgeStats: { outboxSize: 0 },
  });
  const now = Date.now();
  check('heartbeat frais : ONLINE', registry.deriveLiveness(record, now) === 'ONLINE');
  check('après 2×intervalle : STALE', registry.deriveLiveness(record, now + 2 * 300_000 + 1000) === 'STALE');
  check('après 6×intervalle : OFFLINE', registry.deriveLiveness(record, now + 6 * 300_000 + 1000) === 'OFFLINE');
  check('version logicielle mise à jour par le heartbeat', record.runtime.softwareVersion === '1.4.3');

  /**
   * ══ LA VERSION DE CONTRAT NE FIGE PAS À L'APPAIRAGE ═══════════════════════
   *
   * Elle était relevée une fois, au moment de l'appairage, et plus jamais. Un
   * projet monté de 1.4.0 à 1.8.0 restait donc affiché en 1.4.0 dans le Panel —
   * alors qu'il annonçait 1.8.0 dans l'en-tête de CHAQUE requête, sous les yeux
   * de la garde de compatibilité qui la lisait déjà pour la juger.
   *
   * Ce que cela coûtait : l'écran qui sert à décider d'une montée de version
   * disait le contraire de la réalité, et rien ne le contredisait.
   */
  record.runtime.contractVersion = '1.4.0';
  await registry.recordHeartbeat(record, {
    sentAt: new Date().toISOString(),
    softwareVersion: '1.4.3',
    environment: 'TEST',
    health: { status: 'OK', details: null },
    bridgeStats: { outboxSize: 0 },
  }, '1.8.0');
  check('la version de contrat suit le projet, heartbeat après heartbeat',
    record.runtime.contractVersion === '1.8.0');

  /**
   * ET UN APPELANT QUI NE LA TRANSMET PAS N'EFFACE RIEN.
   *
   * `null` est l'absence d'information, pas l'information « aucune version ».
   * Les confondre ferait oublier au Panel ce que le pont venait de lui apprendre,
   * au premier appelant qui ne passe pas l'en-tête (façade, test, script).
   */
  await registry.recordHeartbeat(record, {
    sentAt: new Date().toISOString(),
    softwareVersion: '1.4.3',
    environment: 'TEST',
    health: { status: 'OK', details: null },
    bridgeStats: { outboxSize: 0 },
  });
  check('une absence de version ne remplace pas celle qu’on savait',
    record.runtime.contractVersion === '1.8.0');
  const publicView = registry.toPublicProject(record, now);
  check('projection publique sans aucun hash ni secret',
    !JSON.stringify(publicView).includes('Hash') && !JSON.stringify(publicView).includes('Encrypted'));
  check('projection publique : features AVAILABLE interprétées',
    publicView.capabilities.enabled.includes('sync.contracts'));
  check('projection publique : features RESERVED visibles mais inertes',
    publicView.capabilities.reserved.includes('sync.invoicing')
    && !publicView.capabilities.enabled.includes('sync.invoicing'));
  check('module Panel dérivé des features', publicView.capabilities.panelModules.includes('contracts'));
  check('source du manifest exposée', publicView.manifestSource === 'BRIDGE');
}

section('Révocation et ré-appairage');
{
  const record = await registryStore.getById(declared.record.projectId);
  check('suppression refusée tant que PAIRED', await rejectsWith(
    () => Promise.resolve(registry.removeProject(record.projectId)),
    'PANEL_PROJECT_STILL_PAIRED',
  ));
  await pairing.revokeFromPanel(record);
  check('fiche REVOKED', record.pairing.status === 'REVOKED');
  check('ancien token mort', (await pairing.authenticateBridgeToken(bootstrapResult.bridgeToken)) === null);
  check('vivacité : NOT_PAIRED', registry.deriveLiveness(record) === 'NOT_PAIRED');
  check('manifest conservé après révocation', record.manifest !== null);

  const reissued = await pairing.issuePairingCode(record);
  check('nouveau code émis après révocation', /^PAIR-/.test(reissued.code));
  const second = await pairing.bootstrap(bootstrapDto(reissued.code, { softwareVersion: '1.5.0' }));
  check('ré-appairage réussi', (await registryStore.getById(record.projectId)).pairing.status === 'PAIRED');
  check('nouveau token différent de l’ancien', second.bridgeToken !== bootstrapResult.bridgeToken);
  check('bootstrap 1.1 SANS manifest accepté (champ optionnel)',
    (await registryStore.getById(record.projectId)).manifest !== null);

  await pairing.revokeFromPanel(record);
  const removal = await registry.removeProject(record.projectId);
  check('retrait du parc après révocation', removal.removed === true
    && (await registryStore.getById(record.projectId)) === null);
}

section('Réconciliation de la clé, codes expirés, majeure inconnue');
{
  // ── RÉCONCILIATION ───────────────────────────────────────────────────────
  // Le PROJET est propriétaire de sa clé ; le Panel ne fait que la
  // pré-calculer. Une divergence n'est donc plus un refus (elle l'était, sous
  // le motif trompeur « code invalide », que l'utilisateur ne pouvait lever
  // qu'en devinant la clé) : le Panel ADOPTE ce que le projet annonce. Le
  // secret prouvant l'identité reste le code d'appairage, à usage unique.
  const reconciling = await registry.declareProject({
    publicBackendUrl: 'https://projet-r.test', projectName: 'Projet R',
  });
  check('la clé pré-calculée vient du nom', reconciling.record.projectKey === 'projet-r');
  await pairing.bootstrap(bootstrapDto(reconciling.pairingCode, { projectKey: 'cle-reelle-du-projet' }));
  const reconciled = await registryStore.getById(reconciling.record.projectId);
  check('bootstrap avec une AUTRE clé : le Panel adopte celle du projet',
    reconciled.projectKey === 'cle-reelle-du-projet');
  check('…et trace d’où elle vient', reconciled.projectKeySource === 'RECONCILED');
  check('…l’appairage aboutit', reconciled.pairing.status === 'PAIRED');

  // Ce qui reste INTERDIT : marcher sur la clé d'un autre projet du registre.
  const victim = await registry.declareProject({
    publicBackendUrl: 'https://projet-v.test', projectName: 'Projet V',
  });
  check('adopter la clé D’UN AUTRE projet reste refusé', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(victim.pairingCode, { projectKey: 'cle-reelle-du-projet' }))),
    'BRIDGE_INVALID_PAYLOAD',
  ));

  const other = await registry.declareProject({ publicBackendUrl: 'https://projet-b.test', projectName: 'Projet B' });
  const record = await registryStore.getById(other.record.projectId);
  record.pairing.pairingCodeExpiresAt = new Date(Date.now() - 1000).toISOString();
  await registryStore.save(record);
  check('code expiré refusé', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(other.pairingCode, { projectKey: 'projet-b' }))),
    'BRIDGE_PAIRING_CODE_INVALID',
  ));
  check('version majeure de contrat inconnue refusée au bootstrap', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(other.pairingCode, { projectKey: 'projet-b', contractVersion: '2.0.0' }))),
    'BRIDGE_CONTRACT_VERSION_UNSUPPORTED',
  ));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le code d’appairage n’est consommé QU’AU succès, et une seule fois');
{
  const codeAlive = async (projectId) =>
    Boolean((await registryStore.getById(projectId)).pairing.pairingCodeHash);

  // 1. UN CODE REFUSÉ N'EST PAS BRÛLÉ. Le contraire condamnerait l'opérateur à
  //    redemander un code au moindre faux pas de frappe.
  {
    const p = await registry.declareProject({
      publicBackendUrl: 'https://code-a.test', projectName: 'Code A',
    });
    check('avant tout essai, le code est en place', await codeAlive(p.record.projectId));
    check('un code inconnu est refusé', await rejectsWith(
      () => Promise.resolve(pairing.bootstrap(bootstrapDto('PAIR-FAUX-FAUX-FAUX', { projectKey: 'code-a' }))),
      'BRIDGE_PAIRING_CODE_INVALID',
    ));
    check('…et n’a RIEN consommé', await codeAlive(p.record.projectId));
    await pairing.bootstrap(bootstrapDto(p.pairingCode, { projectKey: 'code-a' }));
    check('…le vrai code fonctionne toujours ensuite',
      (await registryStore.getById(p.record.projectId)).pairing.status === 'PAIRED');
  }

  // 2. UN ÉCHEC EN COURS D'APPAIRAGE NE CONSOMME PAS NON PLUS. Le Manifest est
  //    validé avant l'écriture : un projet mal configuré peut se reprendre.
  {
    const p = await registry.declareProject({
      publicBackendUrl: 'https://code-b.test', projectName: 'Code B',
    });
    check('un Manifest non conforme est refusé', await rejectsWith(
      () => Promise.resolve(pairing.bootstrap(
        bootstrapDto(p.pairingCode, { projectKey: 'code-b', manifest: { nimporte: 'quoi' } }),
      )),
      'BRIDGE_INVALID_PAYLOAD',
    ));
    check('…sans bruler le code', await codeAlive(p.record.projectId));
    await pairing.bootstrap(bootstrapDto(p.pairingCode, { projectKey: 'code-b' }));
    check('…et le meme code aboutit au second essai',
      (await registryStore.getById(p.record.projectId)).pairing.status === 'PAIRED');
  }

  // 3. LE SUCCÈS CONSOMME, EXACTEMENT UNE FOIS.
  {
    const p = await registry.declareProject({
      publicBackendUrl: 'https://code-c.test', projectName: 'Code C',
    });
    await pairing.bootstrap(bootstrapDto(p.pairingCode, { projectKey: 'code-c' }));
    check('après succès, le code a disparu de la fiche', !(await codeAlive(p.record.projectId)));
    check('le rejouer est refusé', await rejectsWith(
      () => Promise.resolve(pairing.bootstrap(bootstrapDto(p.pairingCode, { projectKey: 'code-c' }))),
      'BRIDGE_PAIRING_CODE_INVALID',
    ));
  }

  // 4. CONSOMMATION ATOMIQUE. Deux bootstraps SIMULTANÉS porteurs du même code
  //    passaient les mêmes contrôles sur la même fiche encore intacte : les
  //    deux réussissaient, et le second écrasait le bridgeToken du premier —
  //    qui restait appairé avec un jeton mort, sans que rien ne le signale.
  {
    const p = await registry.declareProject({
      publicBackendUrl: 'https://code-d.test', projectName: 'Code D',
    });
    const attempt = (softwareVersion) => pairing
      .bootstrap(bootstrapDto(p.pairingCode, { projectKey: 'code-d', softwareVersion }))
      .then(() => 'OK', (err) => err.code ?? 'ERREUR');

    const issues = await Promise.all([attempt('X'), attempt('Y')]);
    check(`un SEUL des deux appairages simultanés aboutit — [${issues.join(', ')}]`,
      issues.filter((r) => r === 'OK').length === 1);
    check('…le perdant est refusé comme un code déjà utilisé',
      issues.includes('BRIDGE_PAIRING_CODE_INVALID'));

    const rec = await registryStore.getById(p.record.projectId);
    check('la fiche porte un seul appairage cohérent',
      rec.pairing.status === 'PAIRED' && Boolean(rec.pairing.bridgeTokenHash));
    check('…et le code est consommé', !(await codeAlive(p.record.projectId)));
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LIGNÉE DE RUNTIME — un redémarrage n’est pas une rivalité');
{
  const { observerBattement, prolonge } = await import(
    '../backend/src/services/registry/runtimeLineage.js');

  const T0 = Date.parse('2026-08-23T10:00:00.000Z');
  const t = (s) => new Date(T0 + s * 1000).toISOString();

  /* ── Une seule instance : la lignée se prolonge, rien n’est signalé ────── */
  let e = { lignee: null, ecartee: null, rival: null };
  e = observerBattement({ ...e, battement: { softwareVersion: 'abc1234', uptimeSeconds: 1000, at: t(0) } });
  check('le premier battement pose la lignée', e.lignee.uptimeSeconds === 1000);
  check('…sans rien conclure', e.rival === null && e.evenement === null);

  e = observerBattement({ ...e, battement: { softwareVersion: 'abc1234', uptimeSeconds: 1060, at: t(60) } });
  check('un battement cohérent la PROLONGE', e.rival === null && e.lignee.uptimeSeconds === 1060);
  check('…et n’écarte rien', e.ecartee === null);

  /* ── Un REDÉMARRAGE : le compteur repart, et rien n’est signalé ────────── */
  e = observerBattement({ ...e, battement: { softwareVersion: 'def5678', uptimeSeconds: 5, at: t(120) } });
  check('UN REDÉMARRAGE n’est pas une rivalité', e.rival === null, JSON.stringify(e.rival));
  check('…la lignée précédente est mise de côté, pas jetée', e.ecartee?.uptimeSeconds === 1060);
  e = observerBattement({ ...e, battement: { softwareVersion: 'def5678', uptimeSeconds: 65, at: t(180) } });
  check('…et la nouvelle se prolonge normalement', e.rival === null && e.lignee.uptimeSeconds === 65);
  check('…l’ancienne, jamais revenue, est oubliée', e.ecartee === null);

  /* ── DEUX RUNTIMES : la lignée abandonnée RESSUSCITE ───────────────────── */
  let r = { lignee: null, ecartee: null, rival: null };
  r = observerBattement({ ...r, battement: { softwareVersion: 'deploye', uptimeSeconds: 3000, at: t(0) } });
  r = observerBattement({ ...r, battement: { softwareVersion: 'local', uptimeSeconds: 90000, at: t(30) } });
  check('la seconde déclaration ne prolonge rien : on met de côté', r.rival === null);
  r = observerBattement({ ...r, battement: { softwareVersion: 'deploye', uptimeSeconds: 3060, at: t(60) } });
  check('LA LIGNÉE ABANDONNÉE RESSUSCITE → DEUX RUNTIMES', r.rival !== null);
  check('…l’événement est levé UNE fois', r.evenement === 'RIVAL_DETECTE');
  check('…les deux identités sont nommées',
    r.rival.identities.map((i) => i.softwareVersion).sort().join(',') === 'deploye,local');
  check('…et le compte de bascules démarre à 1', r.rival.alternations === 1);

  r = observerBattement({ ...r, battement: { softwareVersion: 'local', uptimeSeconds: 90060, at: t(90) } });
  r = observerBattement({ ...r, battement: { softwareVersion: 'deploye', uptimeSeconds: 3120, at: t(120) } });
  check('les bascules suivantes montent le compte', r.rival.alternations === 3, `${r.rival.alternations}`);
  check('…sans relever l’événement à chaque tour', r.evenement === null);

  /* ── LA RIVALE DISPARAÎT : le constat se referme ───────────────────────── */
  let seul = r;
  const oublis = [];
  for (const s of [180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780]) {
    seul = observerBattement({ ...seul, battement: { softwareVersion: 'deploye', uptimeSeconds: 3000 + s, at: t(s) } });
    if (seul.evenement) oublis.push({ s, e: seul.evenement });
  }
  check('la rivale n’étant plus revenue, le constat se REFERME', seul.rival === null);
  check('…et l’oubli est un événement, pas un silence',
    oublis.length === 1 && oublis[0].e === 'RIVAL_OUBLIE', JSON.stringify(oublis));
  check('…prononcé une SEULE fois, pas à chaque battement ensuite', oublis.length === 1);

  /* ── SANS TEMPS DE FONCTIONNEMENT, ON NE CONCLUT RIEN ──────────────────── */
  let muet = { lignee: null, ecartee: null, rival: null };
  muet = observerBattement({ ...muet, battement: { softwareVersion: 'v1', uptimeSeconds: undefined, at: t(0) } });
  muet = observerBattement({ ...muet, battement: { softwareVersion: 'v2', uptimeSeconds: undefined, at: t(60) } });
  check('un projet qui ne déclare pas son uptime ne déclenche AUCUNE alerte',
    muet.rival === null && muet.evenement === null);

  check('la tolérance absorbe une cadence irrégulière',
    prolonge({ uptimeSeconds: 1000, at: t(0) }, { uptimeSeconds: 1055, at: t(60) }));
  check('…mais pas un écart de plusieurs heures',
    !prolonge({ uptimeSeconds: 1000, at: t(0) }, { uptimeSeconds: 90000, at: t(60) }));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE CONSTAT DE RIVALITÉ REMONTE À LA FICHE, PAS SEULEMENT EN BASE');
{
  /**
   * On relit LA FICHE ENCORE PRÉSENTE au registre : les sections précédentes
   * révoquent et ré-appairent, et s'accrocher à un identifiant capturé au début
   * ferait échouer ce test pour une raison qui n'est pas la sienne.
   */
  const toutes = await registryStore.list();
  const record = toutes[0];
  check('une fiche est disponible pour cette section', Boolean(record?.projectId));
  const battement = (softwareVersion, uptimeSeconds) => ({
    sentAt: new Date().toISOString(),
    softwareVersion,
    environment: 'TEST',
    health: { status: 'OK', details: null },
    bridgeStats: { outboxSize: 0 },
    runtime: { uptimeSeconds },
  });

  await registry.recordHeartbeat(record, battement('deploye', 3000), '1.13.0');
  await registry.recordHeartbeat(record, battement('local', 90000), '1.10.0');
  await registry.recordHeartbeat(record, battement('deploye', 3001), '1.13.0');

  check('la fiche PORTE le constat', record.runtime.rivalRuntime !== null);
  const vue = registry.toPublicProject(record, Date.now());
  check('…et la projection publique le rend',
    vue.descriptor.rivalRuntime?.identities?.length === 2);
  check('…avec le nombre de bascules', vue.descriptor.rivalRuntime.alternations >= 1);
  check('…sans jeton ni adresse dans le constat',
    !JSON.stringify(vue.descriptor.rivalRuntime).toLowerCase().includes('token')
    && !JSON.stringify(vue.descriptor.rivalRuntime).includes('http'));

  /**
   * ── ET LA VERSION DE CONTRAT SUIT LE DERNIER QUI A PARLÉ ────────────────
   *
   * C'est exactement ce qui rendait le défaut invisible : chaque battement
   * était valide, et la fiche affichait paisiblement l'état de l'un ou de
   * l'autre. Elle le dit MAINTENANT.
   */
  check('la version reflète le dernier battement', record.runtime.contractVersion === '1.13.0');
}

await stopMemoryMongo();
finish();
