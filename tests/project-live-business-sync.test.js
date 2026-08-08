/**
 * L'ÉTAT MÉTIER D'UN PROJET EST VIVANT — pas une photographie d'appairage.
 *
 * ══ L'INCIDENT ══════════════════════════════════════════════════════════════
 *
 * Dans le Manager de SB Auto, le nom de l'entreprise passe de « sbauto06 » à
 * « sbauto07 ». Le Manager l'affiche. Le Panel affiche « Connecté » en vert.
 * Et la fiche continue d'annoncer l'ancien nom — indéfiniment, sans qu'aucun
 * badge ne dise que ce qu'on lit est périmé.
 *
 * ══ LA CAUSE, ET ELLE ÉTAIT DÉJÀ CONNUE UN CHAMP PLUS LOIN ══════════════════
 *
 * Le nom se lisait dans `manifest.presentation.companyName`. Un manifeste est
 * une photographie prise à l'APPAIRAGE, relue seulement sur action d'un
 * opérateur (`REFRESH_MANIFEST`, `DISCOVER_PROJECT`). Renommer l'entreprise ne
 * le touche jamais.
 *
 * Le projet, lui, faisait son travail : un `post('save')` sur `Company`
 * déclenche `PROJECT_PRESENTATION`, l'outbox la livre, le Panel la projette
 * dans `PanelProjectPresentation`. La donnée fraîche était donc EN BASE côté
 * Panel — et personne ne la lisait.
 *
 * C'est mot pour mot le défaut corrigé sur les URLs : deux sources pour une
 * même vérité, dont une seule vivante. La correction est la même — la
 * projection fait autorité, le manifeste devient un repli.
 *
 * ══ CE QUE CE FICHIER VERROUILLE ════════════════════════════════════════════
 *
 *   · la projection poussée prime sur le manifeste ;
 *   · le manifeste reste le repli d'un projet qui ne pousse pas encore ;
 *   · un battement de cœur frais ne rend PAS l'état métier frais ;
 *   · TEST et PROD ne se contaminent jamais ;
 *   · une modification purement locale au Panel ne déclenche rien.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { applyIncoming, resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { PanelProjectPresentation } = await import('../backend/src/models/PanelProjectProjection.model.js');

const at = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/** Une instance appairée, telle que le registre la porte. */
async function instance({ id, environment, projectName, manifestName }) {
  const t = at();
  await registryStore.insert({
    projectId: id,
    projectKey: `sb-${environment.toLowerCase()}`,
    projectKeySource: 'BRIDGE_KEY',
    logicalProjectKey: 'sb-auto',
    declaredEnvironment: environment,
    projectName,
    createdAt: t, updatedAt: t,
    pairing: {
      status: 'PAIRED', pairingCodeHash: null, pairingCodeExpiresAt: null,
      bridgeTokenHash: `h-${id}`, bridgeTokenEncrypted: `c-${id}`, pairedAt: t, revokedAt: null,
    },
    runtime: {
      environment, softwareVersion: '1.0.0', contractVersion: '1.4.0',
      publicBackendUrl: `https://api.${environment.toLowerCase()}.test`,
      lastHeartbeatAt: t, lastHealth: null, bridgeStats: null,
    },
    // LE MANIFESTE : figé à l'appairage, avec l'ANCIEN nom.
    manifest: manifestName ? {
      manifestVersion: '1.0.0',
      project: { key: `sb-${environment.toLowerCase()}`, name: manifestName, environment, softwareVersion: '1.0.0' },
      presentation: { companyName: manifestName },
    } : null,
    manifestSource: manifestName ? 'BRIDGE' : null,
  });
  return id;
}

/**
 * LE PROJET POUSSE SA PRÉSENTATION — par le VRAI chemin de synchronisation.
 *
 * On n'écrit pas dans `PanelProjectPresentation` : on livre une écriture
 * `PROJECT_PRESENTATION` à `applyIncoming`, exactement comme le pont le fait.
 * Ce qui est vérifié ensuite est donc bien ce que le protocole produit.
 */
async function pousserPresentation(projectId, companyName, extra = {}) {
  const resultat = await applyIncoming(projectId, [{
    writeId: uuid(),
    entityType: 'PROJECT_PRESENTATION',
    entityId: 'presentation',
    deleted: false,
    modifiedAt: at(),
    emitter: 'PROJECT',
    payload: {
      companyName,
      project: { name: companyName },
      network: { website: 'https://demo.exemple.test', manager: 'https://manager.demo.exemple.test' },
      ...extra,
    },
  }]);
  return resultat.results[0];
}

const fiche = async (id) => registre.describeProject(await registryStore.getById(id));

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA PROJECTION POUSSÉE FAIT AUTORITÉ — le manifeste devient un repli');
{
  await resetSyncCore();
  await registryStore.clear();
  await PanelProjectPresentation.deleteMany({});
  await instance({ id: 'sb-test', environment: 'TEST', projectName: 'sbauto06', manifestName: 'sbauto06' });

  const avant = await fiche('sb-test');
  check('avant toute projection, le manifeste sert', avant.name === 'sbauto06');
  check('…et l’écran sait d’où ça vient', avant.presentationSource === 'MANIFEST');

  /* — LA MODIFICATION CÔTÉ PROJET, PAR LE VRAI CHEMIN — */
  const accuse = await pousserPresentation('sb-test', 'sbauto07');
  check('l’écriture est appliquée par le noyau de synchronisation', accuse.status === 'APPLIED');

  const apres = await fiche('sb-test');
  check('LA FICHE AFFICHE LE NOUVEAU NOM', apres.name === 'sbauto07');
  check('…sans qu’aucun manifeste n’ait été relu',
    (await registryStore.getById('sb-test')).manifest.presentation.companyName === 'sbauto06');
  check('…et la source est nommée', apres.presentationSource === 'PROJECTION');
  check('…avec la date produite par le PROJET',
    typeof apres.presentationModifiedAt === 'string');
  check('la présentation exposée est la vivante',
    apres.presentation?.companyName === 'sbauto07');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('OFFLINE A → B → C : le Panel converge sur la DERNIÈRE vérité');
{
  await resetSyncCore();
  await registryStore.clear();
  await PanelProjectPresentation.deleteMany({});
  await instance({ id: 'sb-test', environment: 'TEST', projectName: 'A', manifestName: 'A' });

  await pousserPresentation('sb-test', 'B');
  const b = await fiche('sb-test');
  check('B est appliqué', b.name === 'B');

  await pousserPresentation('sb-test', 'C');
  const c = await fiche('sb-test');
  check('LE PANEL FINIT SUR C', c.name === 'C');
  check('…jamais bloqué sur B', c.name !== 'B');
  check('…et jamais revenu à A', c.name !== 'A');
  check('une seule projection subsiste',
    (await PanelProjectPresentation.countDocuments({ projectId: 'sb-test' })) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN BATTEMENT FRAIS NE REND PAS L’ÉTAT MÉTIER FRAIS');
{
  await resetSyncCore();
  await registryStore.clear();
  await PanelProjectPresentation.deleteMany({});
  await instance({ id: 'sb-test', environment: 'TEST', projectName: 'sbauto06', manifestName: 'sbauto06' });

  /**
   * Le projet bat du cœur — il est vivant, la connexion est bonne. Mais il n'a
   * poussé AUCUNE présentation : le Panel n'a que le manifeste d'appairage.
   * « Connecté » décrit la connexion, jamais la fraîcheur des données.
   */
  const record = await registryStore.getById('sb-test');
  await registre.recordHeartbeat(record, {
    sentAt: at(), softwareVersion: '1.0.1', environment: 'TEST',
    health: { status: 'OK', details: null },
  });

  const vue = await fiche('sb-test');
  check('le projet est bien en ligne', registre.deriveLiveness(await registryStore.getById('sb-test')) === 'ONLINE');
  check('…mais l’état métier vient encore du manifeste', vue.presentationSource === 'MANIFEST');
  check('…et le Panel ne prétend PAS l’avoir reçu du projet',
    vue.presentationModifiedAt === null);

  // Le projet pousse enfin sa photographie : l'état devient vivant.
  await pousserPresentation('sb-test', 'sbauto07');
  const apres = await fiche('sb-test');
  check('après la projection, la source bascule', apres.presentationSource === 'PROJECTION');
  check('…et le nom suit', apres.name === 'sbauto07');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('TEST / PROD — deux instances, aucune contamination');
{
  await resetSyncCore();
  await registryStore.clear();
  await PanelProjectPresentation.deleteMany({});
  await instance({ id: 'sb-test', environment: 'TEST', projectName: 'SB Auto TEST', manifestName: 'SB Auto TEST' });
  await instance({ id: 'sb-prod', environment: 'PROD', projectName: 'SB Auto PROD', manifestName: 'SB Auto PROD' });

  await pousserPresentation('sb-test', 'SB Auto TEST modifié');

  const test = await fiche('sb-test');
  const prod = await fiche('sb-prod');
  check('la recette est mise à jour', test.name === 'SB Auto TEST modifié');
  check('LA PRODUCTION EST STRICTEMENT INCHANGÉE', prod.name === 'SB Auto PROD');
  check('…elle lit toujours son manifeste', prod.presentationSource === 'MANIFEST');

  // Et dans l'autre sens.
  await pousserPresentation('sb-prod', 'SB Auto PROD modifié');
  const test2 = await fiche('sb-test');
  const prod2 = await fiche('sb-prod');
  check('la production est mise à jour', prod2.name === 'SB Auto PROD modifié');
  check('…et la recette n’a pas bougé', test2.name === 'SB Auto TEST modifié');
  check('la clé logique commune n’a rien mélangé',
    test2.name !== prod2.name);
  check('chaque instance a SA projection',
    (await PanelProjectPresentation.countDocuments({})) === 2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA LISTE ET LA FICHE LISENT LA MÊME CHOSE');
{
  await resetSyncCore();
  await registryStore.clear();
  await PanelProjectPresentation.deleteMany({});
  await instance({ id: 'sb-test', environment: 'TEST', projectName: 'sbauto06', manifestName: 'sbauto06' });
  await pousserPresentation('sb-test', 'sbauto07');

  const parLot = await registryStore.list();
  const ligne = parLot.find((r) => r.projectId === 'sb-test');
  check('le chargement en lot attache aussi la projection',
    ligne.activePresentation?.companyName === 'sbauto07');
  check('…et la liste affiche donc le même nom que la fiche',
    registre.describeProject(ligne).name === (await fiche('sb-test')).name);

  /**
   * LE CHAMP EST CALCULÉ, JAMAIS PERSISTÉ. Le laisser filtrer dans
   * `panelprojects` créerait une seconde copie du nom — figée, celle-là,
   * puisque plus rien ne la recalculerait. C'est exactement le défaut qu'on
   * vient de corriger.
   */
  const brut = await registryStore.getById('sb-test');
  await registryStore.save(brut);
  const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
  const document = await PanelProject.findOne({ projectId: 'sb-test' }).lean();
  check('la présentation n’est PAS écrite dans la fiche',
    document.activePresentation === undefined);
  check('…ni le réseau résolu', document.activeNetwork === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE DONNÉE PUREMENT LOCALE NE DÉCLENCHE AUCUNE PROPAGATION');
{
  await resetSyncCore();
  await registryStore.clear();
  await PanelProjectPresentation.deleteMany({});
  await instance({ id: 'sb-test', environment: 'TEST', projectName: 'sbauto06', manifestName: 'sbauto06' });
  await pousserPresentation('sb-test', 'sbauto07');

  const avant = await PanelProjectPresentation.findOne({ projectId: 'sb-test' }).lean();

  // Une écriture PANEL sur la fiche — un champ qui n'appartient pas au projet.
  const record = await registryStore.getById('sb-test');
  record.projectName = 'nom saisi au Panel';
  await registryStore.save(record);

  const apres = await PanelProjectPresentation.findOne({ projectId: 'sb-test' }).lean();
  check('la projection du projet n’a pas été touchée',
    apres.companyName === avant.companyName && String(apres.updatedAt) === String(avant.updatedAt));
  check('…et le nom affiché reste celui du PROJET, pas celui saisi',
    (await fiche('sb-test')).name === 'sbauto07');
}

await stopMemoryMongo();
finish();
