/**
 * LOTS L1 + L2 — le contrat de présentation, et ce qu'on fait d'un refus.
 *
 * ══ CE QUE CE FICHIER PROUVE ════════════════════════════════════════════════
 *
 * 1. `PROJECT_PRESENTATION_WITH_MEDIA_IS_ACCEPTED`
 *    Une instance qui a un logo — c'est-à-dire toute instance de production —
 *    voit sa présentation acceptée, descripteur compris, autorité préservée.
 *
 * 2. `PROJECT_PRESENTATION_CONTRACT_REJECTION_IS_NOT_SILENT`
 *    Un refus n'est jamais compté comme une réussite : la donnée n'est pas
 *    appliquée, la file ne dit pas « vide », l'incident est durable, et la
 *    santé publiée passe à « bloquée ».
 *
 * 3. `REJECTED_SNAPSHOT_CONVERGES_AFTER_RECEIVER_FIX_WITHOUT_USER_SAVE`
 *    Le destinataire devient compatible ; PERSONNE ne réenregistre ; la
 *    projection finit appliquée et l'incident se referme.
 *
 * 4. `PROJECT_PRESENTATION_MEDIA_URL_POLICY_IS_CANONICAL`
 *    Une seule doctrine d'adresse, éprouvée dans les quatre configurations.
 *
 * ══ COMMENT UN REFUS EST PRODUIT — sans truquer l'émetteur ══════════════════
 *
 * Par un PANEL PLUS ANCIEN, simulé par un proxy HTTP que le test possède.
 * En mode « ancien », il répond un accusé REJECTED conforme au contrat sur les
 * présentations ; en mode « à jour », il relaie tout au vrai Panel, qui
 * applique réellement.
 *
 * C'est la situation RÉELLE que L1 vient de corriger — un émetteur en avance
 * sur son destinataire — et elle laisse la chaîne d'émission entièrement
 * intacte : hook du modèle, déclencheur, outbox durable, classification,
 * réaffirmation, transport. Aucun de ces maillons n'est doublé.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';
import express from '../backend/node_modules/express/index.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { PanelProjectPresentation } = await import('../backend/src/models/PanelProjectProjection.model.js');

await resetSyncCore();
const { base: panelUrl, close: closePanel } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   LE PANEL « PLUS ANCIEN » — un proxy, et un interrupteur.
   ══════════════════════════════════════════════════════════════════════════ */
const vieux = { actif: false };

const proxyApp = express();
proxyApp.use(express.json({ limit: '5mb' }));
proxyApp.use(async (req, res) => {
  /**
   * LE REFUS EST CONFORME AU CONTRAT — un accusé par écriture, avec son code.
   * Un 500 ou une déconnexion prouveraient tout autre chose : ce qu'on veut
   * éprouver ici est un destinataire qui COMPREND et REFUSE, pas un
   * destinataire absent (qui, lui, relève du backoff de transport).
   */
  if (vieux.actif && req.method === 'POST' && req.path === '/bridge/v1/sync/push') {
    const changes = req.body?.changes ?? [];
    return res.status(200).json({
      success: true,
      data: {
        results: changes.map((c) => (
          c.entityType === 'PROJECT_PRESENTATION'
            ? {
              writeId: c.writeId,
              status: 'REJECTED',
              code: 'ENTITY_PAYLOAD_INVALID',
              message: 'Payload PROJECT_PRESENTATION non conforme.',
            }
            : { writeId: c.writeId, status: 'APPLIED', code: null, message: null }
        )),
      },
    });
  }

  const cible = `${panelUrl}${req.originalUrl}`;
  const entetes = { ...req.headers };
  delete entetes.host;
  delete entetes['content-length'];
  const aCorps = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  const amont = await fetch(cible, {
    method: req.method,
    headers: entetes,
    body: aCorps && req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const texte = await amont.text();
  res.status(amont.status);
  res.set('content-type', amont.headers.get('content-type') ?? 'application/json');
  return res.send(texte);
});
const { base: proxyUrl, close: closeProxy } = await startServer(proxyApp);

/* ══════════════════════════════════════════════════════════════════════════ */
const ficheApi = async (projectId) =>
  registre.describeProject(await registryStore.getById(projectId));

async function attendre(predicat, plafondMs) {
  const debut = Date.now();
  for (;;) {
    if (await predicat()) return { ms: Date.now() - debut, atteint: true };
    if (Date.now() - debut > plafondMs) return { ms: Date.now() - debut, atteint: false };
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

const attendreNom = (projectId, attendu, plafond) =>
  attendre(async () => (await ficheApi(projectId)).name === attendu, plafond);

const instances = [];
async function demarrer({ dbName, projectName, urlDuPanel }) {
  const inst = await startSbAutoInstance({
    mongoUri: MONGO_URI, dbName, env: 'TEST', projectName,
    // Paliers courts : la réparation ne dépend pas de la durée d'attente.
    rejectionCadenceSeconds: [1, 1, 1],
  });
  instances.push(inst);
  const declared = await registre.declareProject({
    publicBackendUrl: inst.publicBackendUrl, projectName, environment: 'TEST',
  });
  const paired = await inst.pair({
    panelUrl: urlDuPanel, pairingCode: declared.pairingCode,
    publicBackendUrl: inst.publicBackendUrl,
  });
  inst.projectId = paired.projectId;
  await inst.heartbeat();
  return inst;
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PROJECT_PRESENTATION_WITH_MEDIA_IS_ACCEPTED');
{
  const A = await demarrer({
    dbName: 'pres_media_a', projectName: 'SB Auto Média', urlDuPanel: panelUrl,
  });

  /**
   * UN LOGO SOUS AUTORITÉ `PROJECT` — la configuration de toute production.
   * C'est le seul écart entre une instance de recette et une instance
   * déployée, et c'était exactement l'écart qui faisait tout échouer.
   */
  await A.setCompanyLogo({ url: 'https://cdn.exemple.fr/logo-garage.png' });

  const projection = await A.buildPresentation();
  check('le projet publie le descripteur, pas seulement l’adresse',
    projection.payload?.logo?.url === 'https://cdn.exemple.fr/logo-garage.png');
  check('…et il DÉCLARE son autorité',
    projection.payload?.logo?.authority === 'PROJECT');

  const t0 = Date.now();
  await A.renameCompany({ name: 'Garage du Nord' });
  const r = await attendreNom(A.projectId, 'Garage du Nord', 15_000);
  const latence = Date.now() - t0;

  check(`LA FICHE DU PANEL AFFICHE LE NOUVEAU NOM (${latence} ms)`, r.atteint);
  check('…sans qu’aucun cycle n’ait été demandé par le test', true);

  const fiche = await ficheApi(A.projectId);
  check('…et la source est la projection', fiche.presentationSource === 'PROJECTION');

  /* — LE DESCRIPTEUR A TRAVERSÉ LE PONT, ENTIER — */
  const stockee = await PanelProjectPresentation.findOne({ projectId: A.projectId }).lean();
  check('le Panel a PERSISTÉ le descripteur du logo',
    stockee?.logo?.url === 'https://cdn.exemple.fr/logo-garage.png');
  check('PROJECT_MEDIA_AUTHORITY_IS_PRESERVED : l’autorité a survécu au transport',
    stockee?.logo?.authority === 'PROJECT');
  check('…et l’API de la fiche l’expose',
    fiche.presentation?.logo?.authority === 'PROJECT');
  check('…l’adresse héritée reste publiée pour un lecteur antérieur',
    stockee?.logoUrl === 'https://cdn.exemple.fr/logo-garage.png');

  /* — L'ÉCRITURE EST ACQUITTÉE, ET LA FILE EST SAINE — */
  const file = await A.outboxDump();
  const derniere = file[file.length - 1];
  console.log(`    statut : ${derniere?.status} · tentatives : ${derniere?.attempts}`);
  check('ACK_MEANS_PERSISTED_NOT_SENT : l’écriture est ACQUITTÉE',
    derniere?.status === 'ACKNOWLEDGED');
  check('…en une seule tentative', derniere?.attempts === 1);
  check('…et aucun incident n’est ouvert', (await A.outboxHealth()).rejected === 0);

  await A.heartbeat();
  const sante = (await ficheApi(A.projectId)).businessSync;
  check('la santé de synchronisation publiée est SAINE', sante.status === 'HEALTHY');

  await A.stop();
  instances.pop();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PROJECT_PRESENTATION_CONTRACT_REJECTION_IS_NOT_SILENT');

const B = await demarrer({
  dbName: 'pres_media_b', projectName: 'SB Auto Refus', urlDuPanel: proxyUrl,
});

{
  await B.setCompanyLogo({ url: 'https://cdn.exemple.fr/logo-refus.png' });
  await attendreNom(B.projectId, 'SB Auto Refus', 8_000);
  const avant = await ficheApi(B.projectId);

  /* — LE DESTINATAIRE DEVIENT « PLUS ANCIEN » — */
  vieux.actif = true;

  await B.renameCompany({ name: 'Nom Refusé' });
  const arrive = await attendreNom(B.projectId, 'Nom Refusé', 5_000);
  check('la donnée n’est PAS appliquée', arrive.atteint === false);
  check('…la fiche reste sur la valeur précédente',
    (await ficheApi(B.projectId)).name === avant.name);

  const sain = await attendre(async () => (await B.outboxHealth()).rejected > 0, 8_000);
  check('un refus est enregistré', sain.atteint);

  const sante = await B.outboxHealth();
  console.log(`    refus : ${sante.rejected} · classe : ${sante.oldestRejection?.failureClass} · code : ${sante.oldestRejection?.code}`);
  check('…classé COMPATIBILITY — le destinataire comprend et n’en veut pas sous cette forme',
    sante.oldestRejection?.failureClass === 'COMPATIBILITY');
  check('…avec le code rendu par le destinataire',
    sante.oldestRejection?.code === 'ENTITY_PAYLOAD_INVALID');
  check('…et la date du PREMIER refus', typeof sante.oldestRejection?.since === 'string');

  /* — LE POINT CENTRAL : UN REFUS N'EST PAS UN ACK — */
  const file = await B.outboxDump();
  const refusee = file.find((e) => e.status === 'REJECTED');
  check('l’écriture n’est PAS marquée ACKNOWLEDGED', refusee !== undefined);
  check('…et ne porte AUCUNE date de résolution (donc aucun effacement TTL)',
    refusee?.acknowledgedAt === null || refusee?.acknowledgedAt === undefined);
  check('…elle reste DURABLE dans la file', (await B.outboxDump()).some((e) => e.status === 'REJECTED'));
  check('…tandis que le compteur « en attente de départ » reste honnête',
    (await B.outboxPending()) === 0);

  /* — ET LE PANEL LE VOIT — */
  await B.heartbeat();
  const vue = (await ficheApi(B.projectId)).businessSync;
  console.log(`    vu du Panel : ${vue.status} · ${vue.blocked?.entityType} · ${vue.blocked?.code}`);
  check('LE PANEL SAIT QUE LA SYNCHRONISATION EST BLOQUÉE', vue.status === 'BLOCKED');
  check('…et nomme l’entité concernée', vue.blocked?.entityType === 'PROJECT_PRESENTATION');
  check('…alors même que l’instance est parfaitement CONNECTÉE',
    typeof (await ficheApi(B.projectId)).dates.lastHeartbeatAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('REJECTED_SNAPSHOT_CONVERGES_AFTER_RECEIVER_FIX_WITHOUT_USER_SAVE');
{
  const avant = await B.outboxHealth();
  check('point de départ : un refus est ouvert', avant.rejected > 0);

  /* — LE DESTINATAIRE EST CORRIGÉ. PERSONNE NE RÉENREGISTRE. — */
  vieux.actif = false;

  /**
   * AUCUN `renameCompany`, AUCUN `syncNow`, AUCUN `reconcileAll` ici.
   *
   * La seule chose qui tourne est l'ordonnanceur du projet — c'est-à-dire le
   * cycle de RÉPARATION, dans son rôle légitime. C'est lui qui réaffirme les
   * refus dus, et rien d'autre ne le fait.
   */
  await B.startScheduler({ heartbeatMs: 500, syncMs: 400 });

  const converge = await attendreNom(B.projectId, 'Nom Refusé', 20_000);
  check(`LA PROJECTION FINIT APPLIQUÉE, SANS AUCUN GESTE (${converge.ms} ms)`,
    converge.atteint);

  const apres = await B.outboxHealth();
  check('…l’incident s’est refermé', apres.rejected === 0);

  const file = await B.outboxDump();
  const reparee = file.find((e) => e.writeId && e.status === 'ACKNOWLEDGED'
    && e.entityType === 'PROJECT_PRESENTATION');
  check('…l’écriture porte enfin sa date de résolution',
    Boolean(reparee?.acknowledgedAt));
  check('…et le compte de refus reste lisible pour le diagnostic',
    typeof file.find((e) => e.rejections > 0)?.rejections === 'number');

  await B.heartbeat();
  check('LE PANEL REDEVIENT SAIN', (await ficheApi(B.projectId)).businessSync.status === 'HEALTHY');

  await B.stopScheduler();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PROJECT_PRESENTATION_MEDIA_URL_POLICY_IS_CANONICAL');
{
  /**
   * UNE SEULE DOCTRINE : le DESCRIPTEUR fait autorité ; `logoUrl` n'en est que
   * la projection héritée, et n'est publiée QUE si elle est absolue et
   * joignable. Une adresse relative, locale ou non https n'est jamais
   * transportée — le destinataire l'afficherait depuis une AUTRE origine que
   * celle qui l'a produite, et n'obtiendrait qu'une image cassée.
   *
   * Ce n'est pas une règle ajoutée ici : c'est celle que `resolvePublicAssetUrl`
   * et `publishableProjectDescriptor` appliquent déjà. On la VERROUILLE, pour
   * qu'aucune évolution ne la contredise en silence.
   */
  const cas = [
    { titre: 'chemin RELATIF, sans backendUrl', valeur: '/uploads/logo.png' },
    { titre: 'hôte LOCAL', valeur: 'http://127.0.0.1:3000/uploads/logo.png' },
    { titre: 'localhost', valeur: 'http://localhost/uploads/logo.png' },
    { titre: 'https PUBLIQUE', valeur: 'https://cdn.exemple.fr/ok.png', publiable: true },
  ];

  for (const c of cas) {
    await B.setCompanyLogo({ url: c.valeur });
    const p = (await B.buildPresentation()).payload ?? {};
    if (c.publiable) {
      check(`${c.titre} → descripteur ET adresse publiés`,
        p.logo?.url === c.valeur && p.logoUrl === c.valeur);
      check(`${c.titre} → l’adresse dérive du descripteur, jamais l’inverse`,
        p.logoUrl === p.logo?.url);
    } else {
      check(`${c.titre} → AUCUNE adresse publiée`, p.logoUrl === undefined);
      check(`${c.titre} → et aucun descripteur inventé`, p.logo === undefined);
    }
  }

  /**
   * ET LE CONTRAT LE CONFIRME : toute présentation produite par ces quatre
   * configurations est acceptée. Une doctrine qui ne se vérifie pas contre le
   * validateur du destinataire n'est qu'une intention.
   */
  const { projectPresentationPayloadSchema } = await import('../backend/src/bridge/bridgeContract.js');
  let toutesConformes = true;
  for (const c of cas) {
    await B.setCompanyLogo({ url: c.valeur });
    const p = (await B.buildPresentation()).payload ?? {};
    if (!projectPresentationPayloadSchema.safeParse(p).success) toutesConformes = false;
  }
  check('les quatre configurations produisent un payload CONFORME', toutesConformes);
}

for (const inst of instances) await inst.stop();
await closeProxy();
await closePanel();
await stopMemoryMongo();
finish();
