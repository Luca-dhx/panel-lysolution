// Conformité : les specs OpenAPI (docs/spec/), le miroir exécutable
// (bridgeContract.js), le client sortant et la surface montée racontent la
// même chose — le contrat ne peut pas dériver silencieusement.
// Lecture des specs par extraction textuelle (les YAML sont la référence).
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
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panelSpec = fs.readFileSync(path.join(root, 'docs/spec/PanelBridge.openapi.yaml'), 'utf8');
const projectSpec = fs.readFileSync(path.join(root, 'docs/spec/ProjectBridge.openapi.yaml'), 'utf8');

const contract = await import('../backend/src/bridge/bridgeContract.js');
const { PROJECTED_ENTITY_TYPES } = await import('../backend/src/services/sync/projectors.js');
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
  // 8 depuis L6.3A, qui ajoute le canal étroit du secret de vérification. Le
  // nombre est écrit en dur à dessein — un chemin qui apparaît sans qu'on l'ait
  // voulu doit faire échouer ce test, pas se fondre dans un comptage dynamique.
  // C'est la raison d'être de cette ligne : un canal qui livre un secret ne
  // doit jamais pouvoir apparaître discrètement.
  // 9 depuis L12.B, qui ajoute l'introspection d'identité fédérée — le seul
  // moyen pour un projet d'apprendre qu'une session développeur doit être
  // fermée. Comme le canal de vérification, elle est nommée ci-dessous : un
  // chemin de plus doit se déclarer, jamais se fondre dans un comptage.
  /**
   * 14 DEPUIS 1.11.0 — les cinq routes de LECTURE des modèles d'e-mail.
   *
   * Le nombre reste écrit en dur, et c'est délibéré : un chemin qui apparaît
   * sans qu'on l'ait voulu doit faire échouer ce test, pas se fondre dans un
   * comptage dynamique. Il disait encore 9 alors que le Panel en servait 14 —
   * la garde échouait donc en permanence, et une garde qui échoue toujours
   * n'est plus une garde. C'est ce qui a laissé le miroir dériver de deux
   * versions sans que personne ne le voie.
   */
  check(`la spec expose ${inSpec.length} chemins`, inSpec.length === 14);
  check('le canal de vérification est au contrat',
    inMirror.includes('/bridge/v1/webhooks/{provider}/verification-secret'));
  check('l’introspection d’identité fédérée est au contrat',
    inMirror.includes('/bridge/v1/federation/introspect'));
  check('miroir ↔ spec : ensembles identiques', JSON.stringify(inSpec) === JSON.stringify(inMirror));
  check('la passerelle de capacités est au contrat',
    inMirror.includes('/bridge/v1/capabilities/{code}/invoke'));
}

section('Chemins du contrat ProjectBridge (consommés par le Panel)');
{
  const inSpec = specPaths(projectSpec, /^ {2}(\/api\/project-bridge\/v1\/[^\s:]+):\s*$/gm).sort();
  const inMirror = Object.values(contract.PROJECT_API_ROUTES).sort();
  /**
   * 12 DEPUIS 1.13.0 — `/dead-letters` (les écritures garées) et
   * `/contracts/{contractId}/document`, qui était servi et consommé sans être
   * documenté nulle part. Le nombre reste écrit en dur : un chemin qui
   * apparaît sans qu'on l'ait voulu doit faire échouer ce test.
   */
  check(`la spec expose ${inSpec.length} chemins`, inSpec.length === 12);
  check('miroir ↔ spec : ensembles identiques', JSON.stringify(inSpec) === JSON.stringify(inMirror));
  check('GET /manifest présent (ajout 1.1.0)', inMirror.includes('/api/project-bridge/v1/manifest'));
}

section('Catalogues d’erreurs BRIDGE_*');
{
  const specCodes = new Set([...`${panelSpec}\n${projectSpec}`.matchAll(/BRIDGE_[A-Z_]+/g)].map((m) => m[0]));
  const mirrorCodes = Object.values(contract.BRIDGE_ERROR_CODES);
  check('chaque code du miroir existe dans les specs', mirrorCodes.every((code) => specCodes.has(code)));
  check('chaque code des specs existe dans le miroir', [...specCodes].every((code) => mirrorCodes.includes(code)));
  /**
   * ── CE QUI COMPTE EST LA RELATION, PAS UN NOMBRE ──────────────────────────
   * Ces contrôles comptaient 10 et 11. Un code ajouté au contrat les faisait
   * tomber tous les deux sans rien dire d'utile : le nombre n'est pas
   * l'invariant. Ce qui l'est : le sens PROJET porte exactement les codes du
   * sens PANEL, plus `ENTITY_TYPE_UNSUPPORTED`, et dans le même ordre.
   */
  check('le sens PANEL ne porte PAS ENTITY_TYPE_UNSUPPORTED',
    !contract.PANEL_BRIDGE_ERROR_ENUM.includes('BRIDGE_ENTITY_TYPE_UNSUPPORTED'));
  check('le sens PROJET le porte, lui',
    contract.PROJECT_BRIDGE_ERROR_ENUM.includes('BRIDGE_ENTITY_TYPE_UNSUPPORTED'));
  check('…et c’est la SEULE différence entre les deux',
    contract.PROJECT_BRIDGE_ERROR_ENUM.length === contract.PANEL_BRIDGE_ERROR_ENUM.length + 1
    && contract.PROJECT_BRIDGE_ERROR_ENUM
      .filter((c) => c !== 'BRIDGE_ENTITY_TYPE_UNSUPPORTED')
      .join() === contract.PANEL_BRIDGE_ERROR_ENUM.join());
  check('…placée juste après INVALID_PAYLOAD, comme dans les specs',
    contract.PROJECT_BRIDGE_ERROR_ENUM.indexOf('BRIDGE_ENTITY_TYPE_UNSUPPORTED')
      === contract.PROJECT_BRIDGE_ERROR_ENUM.indexOf('BRIDGE_INVALID_PAYLOAD') + 1);
}

section('Types d’entités synchronisées');
{
  /**
   * UN COMPTE EN DUR, ET C'EST VOULU : ce nombre est un cliquet. Ajouter un
   * type d'entité au contrat de pont engage les DEUX dépôts et les DEUX specs ;
   * le faire par inadvertance doit être impossible. Le test rougit, l'auteur
   * s'explique, le nombre monte.
   *
   * 15 depuis L8.4C — `EMAIL_DELIVERY_EVENT`, le chemin de retour des
   * livraisons d'e-mails, désormais que les webhooks Brevo suivent le compte
   * du Panel et n'atteignent plus le projet.
   *
   * 16 depuis L10.5 — `PAYMENT_REQUEST`, une PRESTATION À RÉGLER poussée par le
   * Panel. Elle ne pouvait emprunter ni `INVOICE` ni `PAYMENT` : ces deux-là
   * décrivent ce qui a EU LIEU — une facture émise, un encaissement constaté —
   * alors qu'une prestation décrit ce qui est RÉCLAMÉ, et qui ne sera peut-être
   * jamais payé. Les confondre aurait fait apparaître, dans l'historique de
   * facturation du client, des factures qui n'existent pas.
   *
   * 17 depuis L10.6 — `PAYMENT_DEFAULT_CAUSE`, une CAUSE de suspension et non un
   * état. Le Panel est l'autorité de la politique de grâce ; le projet reste
   * l'autorité de son accessibilité. Transporter un état aurait créé deux
   * maîtres pour la même question, et une régularisation aurait pu rouvrir un
   * site en maintenance technique.
   *
   * 18 depuis L10.6B-3 — `PAYMENT_DEFAULT_INCIDENT`, et il a fallu s'en
   * expliquer avant de l'ajouter. `PAYMENT_DEFAULT_CAUSE.active` est une ENTRÉE
   * du moteur de suspension du projet : elle est écrite dans
   * `siteStatus.paymentDefault`, et la réconciliation en tire l'accessibilité.
   *
   * Or un incident EXISTE avant que la cause ne devienne active — c'est très
   * exactement ce que le délai de grâce définit. Le faire voyager par la cause
   * imposait l'un de deux mensonges : `active: true` pendant la grâce (fermer le
   * site pendant la grâce, soit ce qu'elle empêche), ou `active: false` avec du
   * contexte (que l'applicateur de cause remet à néant dans ce cas précis).
   *
   * Et structurellement : `SiteStatus` est un singleton à une seule cause,
   * quand un projet peut connaître plusieurs incidents successifs.
   *
   * Deux types, deux rôles, jamais interchangeables :
   *   CAUSE     « faut-il fermer ? »    → entrée du moteur, singleton
   *   INCIDENT  « que se passe-t-il ? » → observation seule, collection
   */
  /**
   * VINGT depuis 1.8.0 : `PROJECT_EMAIL_TEMPLATE_USAGE` rejoint le miroir — le
   * projet déclare les modèles d'e-mail qu'il consomme, et le Panel s'y
   * conforme au lieu de deviner.
   *
   * DIX-NEUF depuis R10.5C : `SIGNATURE_EVENT` rejoint le miroir.
   *
   * Même raison d'être que `EMAIL_DELIVERY_EVENT` — après cutover, les webhooks
   * suivent le COMPTE, donc le Panel. Sans cette entité, un contrat signé
   * resterait « en cours » côté projet, et un projet éteint perdrait le fait.
   *
   * Le nombre reste écrit en dur : c’est lui qui force à relire le contrat
   * quand une entité s’ajoute, plutôt que de la voir apparaître en silence.
   */
  /**
   * VINGT ET UN depuis 1.10.0 : `CLIENT_COMPANY` rejoint le miroir — l'identité
   * JURIDIQUE du client d'un projet, poussée par le Panel vers ce projet et lui
   * seul. Distincte de `DEV_COMPANY`, qui porte l'identité du PRESTATAIRE et se
   * diffuse à tout le parc.
   */
  check('22 entityTypes au miroir', contract.SYNC_ENTITY_TYPES.length === 22);
  check('tous présents dans la spec PanelBridge',
    contract.SYNC_ENTITY_TYPES.every((t) => panelSpec.includes(`- ${t}`)));
  check('tous présents dans la spec ProjectBridge',
    contract.SYNC_ENTITY_TYPES.every((t) => projectSpec.includes(`- ${t}`)));
  // Ce que le Panel DÉCLARE appliquer doit être exactement ce qu'il SAIT
  // projeter : deux listes qui divergent, et un projet se voit refuser une
  // écriture que le Panel prétendait accepter.
  check('les types appliqués sont ceux de la table de projecteurs',
    JSON.stringify([...contract.APPLIED_ENTITY_TYPES].sort())
      === JSON.stringify([...PROJECTED_ENTITY_TYPES].sort()));
  /**
   * LE CATALOGUE APPLIQUÉ, ÉNUMÉRÉ — pas seulement compté.
   *
   * `PROJECT_SITE_STATUS` rejoint la table : l'accessibilité du site était le
   * dernier état métier exposé au Panel qui ne voyageait pas, et qu'un écran
   * allait donc lire directement chez le projet à chaque affichage.
   */
  /**
   * SEPT DEPUIS 1.11.0 — `PLATFORM_INCIDENT` a rejoint la table : un incident
   * technique durable rapporté par un projet, dont le Panel décide s'il alerte.
   * L'assertion en nommait six, et échouait donc depuis cet ajout.
   */
  check('les sept types appliqués sont nommés',
    contract.APPLIED_ENTITY_TYPES.length === 7
    && ['DIAGNOSTIC', 'PROJECT_PRESENTATION', 'CONTRACT', 'TEAM_MEMBER',
      'PROJECT_SITE_STATUS', 'PROJECT_EMAIL_TEMPLATE_USAGE', 'PLATFORM_INCIDENT']
      .every((t) => contract.APPLIED_ENTITY_TYPES.includes(t)));
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
  /**
   * 12 DEPUIS 1.13.0 — `listDeadLetters` (les écritures garées) et
   * `fetchDocument` (le document contractuel, qui existait sans être déclaré).
   *
   * Le nombre reste écrit en dur : une méthode qui apparaît sans qu'on l'ait
   * voulue doit faire échouer ce test, pas se fondre dans un comptage.
   */
  check('12 méthodes déclarées', PROJECT_BRIDGE_CLIENT_METHODS.length === 12,
    `${PROJECT_BRIDGE_CLIENT_METHODS.length}`);
  const client = new ProjectBridgeClient({ baseUrl: 'https://exemple.invalid', bridgeToken: 'x' });
  check('chaque méthode existe sur le client',
    PROJECT_BRIDGE_CLIENT_METHODS.every((m) => typeof client[m] === 'function'));
  check('autant de méthodes que de chemins ProjectBridge',
    PROJECT_BRIDGE_CLIENT_METHODS.length === Object.keys(contract.PROJECT_API_ROUTES).length);
}

section('Client sortant : la version de contrat part SUR LE FIL, à chaque appel');
{
  // Vérifier que les méthodes EXISTENT ne prouve rien sur ce qui circule :
  // un projet qui reçoit « aucune » version répond 409 et le pont paraît
  // rompu côté serveur alors que la faute est à l'émission. On capture donc
  // le fetch et on inspecte les en-têtes RÉELLEMENT transmis.
  const sent = [];
  const fetchImpl = (url, init) => {
    sent.push({ url: String(url), headers: init?.headers ?? {} });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
      headers: new Headers({ [contract.CONTRACT_VERSION_HEADER]: contract.CONTRACT_VERSION }),
    });
  };

  // Un jeu d'arguments par méthode : le contrat en compte 10, toutes doivent
  // être exercées — une méthode ajoutée sans argument ici fera échouer le
  // compte plus bas, jamais passer silencieusement.
  const invocations = {
    ping: (c) => c.ping(),
    getIdentity: (c) => c.getIdentity(),
    getHealth: (c) => c.getHealth(),
    getAccounts: (c) => c.getAccounts(),
    getManifest: (c) => c.getManifest(),
    deliverChanges: (c) => c.deliverChanges([]),
    readLocalChanges: (c) => c.readLocalChanges({ cursor: null, limit: 10 }),
    listOperations: (c) => c.listOperations(),
    invokeOperation: (c) => c.invokeOperation('op.test', { invocationId: 'i-1', params: {} }),
    notifyUnpair: (c) => c.notifyUnpair(),
    listDeadLetters: (c) => c.listDeadLetters(),
    fetchDocument: (c) => c.fetchDocument('/api/project-bridge/v1/contracts/c1/document'),
  };

  check('un jeu d’arguments pour CHAQUE méthode du contrat',
    PROJECT_BRIDGE_CLIENT_METHODS.every((m) => typeof invocations[m] === 'function')
    && Object.keys(invocations).length === PROJECT_BRIDGE_CLIENT_METHODS.length);

  const headerOf = (entry) => {
    // Insensible à la casse : le client a le droit de choisir sa graphie,
    // c'est le nom canonique qui compte, pas sa capitalisation.
    const found = Object.entries(entry.headers)
      .find(([k]) => k.toLowerCase() === contract.CONTRACT_VERSION_HEADER);
    return found?.[1] ?? null;
  };

  for (const method of PROJECT_BRIDGE_CLIENT_METHODS) {
    sent.length = 0;
    const client = new ProjectBridgeClient({
      baseUrl: 'https://exemple.invalid',
      bridgeToken: 'jeton-de-test',
      fetchImpl,
    });
    await invocations[method](client);
    check(`${method}() émet ${contract.CONTRACT_VERSION_HEADER}: ${contract.CONTRACT_VERSION}`,
      sent.length === 1 && headerOf(sent[0]) === contract.CONTRACT_VERSION);
  }

  // `probe()` n'est pas un chemin du contrat mais emprunte le réseau : c'est
  // le tout premier appel d'un appairage, celui qui doit surtout pas partir nu.
  sent.length = 0;
  const prober = new ProjectBridgeClient({ baseUrl: 'https://exemple.invalid', fetchImpl });
  await prober.probe();
  check(`probe() émet ${contract.CONTRACT_VERSION_HEADER}: ${contract.CONTRACT_VERSION}`,
    sent.length === 1 && headerOf(sent[0]) === contract.CONTRACT_VERSION);

  // Garde anti-régression structurelle : aucun appel réseau du client ne doit
  // pouvoir être ajouté sans l'en-tête. On le vérifie sur la SOURCE, car un
  // futur `fetch` oublié n'apparaîtrait dans aucun des appels ci-dessus.
  const clientSource = fs.readFileSync(
    path.join(root, 'backend/src/bridge/ProjectBridgeClient.js'), 'utf8',
  );
  const fetchCalls = clientSource.match(/this\.fetchImpl\(/g)?.length ?? 0;
  const headerMentions = clientSource.match(/CONTRACT_VERSION_HEADER\]:\s*CONTRACT_VERSION/g)?.length ?? 0;
  check(`chaque appel réseau du client pose l’en-tête (${fetchCalls} appels, ${headerMentions} poses)`,
    fetchCalls > 0 && headerMentions >= fetchCalls);
}

section('Exclusivité architecturale : chaque axe réseau a UN client, et un seul');
{
  /**
   * ══ LA TABLE FERMÉE DES SORTIES RÉSEAU ═══════════════════════════════════
   *
   * Le Panel a deux axes sortants. Chacun a exactement un fichier autorisé à
   * ouvrir une socket, et ce fichier ne fait que cela : la décision vit
   * ailleurs, le transport vit ici.
   *
   * La règle ne nommait qu'un fichier — celui du pont projet — et interdisait
   * `fetch` partout ailleurs. Son INTENTION était juste ; sa portée était
   * fausse dans les deux sens :
   *
   *   · trop étroite — elle ne détectait que `fetch(`. Un `axios`, un
   *     `http.request` ou un `undici` ouvraient une socket sans être vus ;
   *   · mal ciblée — elle traitait le relais média Panel → Panel comme une
   *     violation du pont PROJET, alors que c'est un autre axe. Le service
   *     métier gardait donc sa propre socket, et la règle « échouait » sans
   *     jamais désigner la correction à faire.
   *
   * La table est FERMÉE : ajouter un client oblige à venir écrire ici quel axe
   * il sert, ce qui est exactement la décision qu'on veut rendre délibérée.
   */
  const srcDir = path.join(root, 'backend', 'src');
  const CLIENTS_RESEAU = [
    { fichier: path.join('bridge', 'ProjectBridgeClient.js'), axe: 'Panel → projet appairé (contrat ProjectBridge)' },
    { fichier: path.join('bridge', 'MediaAuthorityClient.js'), axe: 'Panel → autre instance du Panel (relais des médias)' },
  ];

  /**
   * TOUTES les façons d'ouvrir une socket sortante, pas seulement `fetch`.
   * Une règle qui n'en connaît qu'une se contourne sans le vouloir.
   */
  const SORTIES_RESEAU = [
    /\bfetch\s*\(/,
    /\baxios\b/,
    /\bgot\s*\(/,
    /from\s+['"]undici['"]/,
    /\bhttps?\.request\s*\(/,
    /\bXMLHttpRequest\b/,
    /new\s+WebSocket\s*\(/,
  ];

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const relPath = path.relative(srcDir, full);
        if (CLIENTS_RESEAU.some((c) => relPath === c.fichier)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (SORTIES_RESEAU.some((motif) => motif.test(content))) offenders.push(relPath);
      }
    }
  };
  walk(srcDir);
  check(`aucune sortie réseau hors des clients déclarés${offenders.length ? ` (trouvé : ${offenders.join(', ')})` : ''}`,
    offenders.length === 0);

  // La table doit rester COURTE, et chacun de ses fichiers exister vraiment :
  // une entrée obsolète rouvrirait une porte que plus personne ne surveille.
  check('exactement deux axes réseau sortants, pas un de plus',
    CLIENTS_RESEAU.length === 2);
  for (const { fichier, axe } of CLIENTS_RESEAU) {
    check(`le client de l'axe « ${axe} » existe`,
      fs.existsSync(path.join(srcDir, fichier)));
  }
  // …et chacun ouvre RÉELLEMENT une socket : un client qui n'émet plus rien
  // n'a plus de raison d'occuper une place dans la table.
  for (const { fichier } of CLIENTS_RESEAU) {
    const source = fs.readFileSync(path.join(srcDir, fichier), 'utf8');
    check(`${path.basename(fichier)} porte bien le transport de son axe`,
      /this\.fetchImpl\s*\(/.test(source));
  }

  const envReaders = [];
  const walkEnv = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkEnv(full);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        const relFromSrc = path.relative(srcDir, full).split(path.sep)[0];
        // Moteurs standards embarqués : hors du périmètre applicatif.
        if (relFromSrc === 'deployment-engine' || relFromSrc === 'duplication-engine') continue;
        // `deploy-worker.js` est un point d'entrée détaché : il lit ses
        // PARAMÈTRES D'INVOCATION dans l'environnement (jamais dans argv,
        // qui exposerait le mot de passe SSH à `ps aux`). Sa configuration,
        // elle, passe bien par config/env.js. Voir architecture.test.js.
        // `deploy-drive.js` relève du MÊME cas : point d'entrée console qui
        // pilote le moteur officiel, et dont le seul `process.env` lu est le
        // mot de passe SSH d'invocation. Le jumeau de ce contrôle
        // (architecture.test.js) l'a déjà admis ; celui-ci ne l'avait pas suivi.
        const isEntryPoint = full.endsWith(path.join('scripts', 'deploy-worker.js'))
          || full.endsWith(path.join('scripts', 'deploy-drive.js'));
        if (/process\.env[.[]/.test(content)
          && !full.endsWith(path.join('config', 'env.js'))
          && !isEntryPoint) {
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

await stopMemoryMongo();
finish();
