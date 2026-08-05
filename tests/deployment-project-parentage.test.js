// PARENTÉ DES DESTINATIONS ET MIGRATION DES MÉDIAS — ce qui autorise une copie.
//
// ── LE DÉFAUT QUI A COÛTÉ HUIT MÉDIAS ───────────────────────────────────────
// Un projet change de domaine. Sa base le suit, ses fichiers persistants non :
// ils restent dans le `shared/uploads` de l'ancienne destination. La nouvelle
// vitrine référençait huit médias qui n'existaient pas chez elle et répondait
// 404 sur chacun.
//
// La tentation était de rapprocher les deux destinations automatiquement — même
// base, domaines proches, même serveur. Ces contrôles verrouillent le refus de
// cette facilité : deux projets distincts peuvent partager les trois, et une
// copie faite à tort déplacerait les médias d'un client chez un autre.
//
// Ce qui est vérifié ici : la parenté est déclarée, jamais déduite ; la copie ne
// détruit rien ; elle se rejoue sans effet ; et un désaccord de contenu arrête
// tout au lieu de trancher en silence.
//
// À ne pas confondre avec `project-identity.test.js`, qui porte sur la clé
// technique d'un projet dans le REGISTRE du Panel — un tout autre sujet.
import {
  check, section, finish, setTestEnv, startMemoryMongo, connectTestDatabase, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { randomUUID } = await import('node:crypto');
const { nowIso } = await import('../backend/src/bridge/bridgeContract.js');
const { default: PanelDeploymentTarget } = await import('../backend/src/models/PanelDeploymentTarget.model.js');
const { default: PanelProjectIdentity } = await import('../backend/src/models/PanelProjectIdentity.model.js');
const { default: PanelDeploymentLocation } = await import('../backend/src/models/PanelDeploymentLocation.model.js');
const identity = await import('../backend/src/services/deployment/projectIdentity.service.js');
const { migrateUploads, inventoryUploads, assertUploadsPath } =
  await import('../backend/src/deployment-engine/uploads.js');

let port = 5001;
/** Crée une destination minimale, sans parenté déclarée. */
async function creerCible(host, extra = {}) {
  const at = nowIso();
  return PanelDeploymentTarget.create({
    targetId: randomUUID(), name: host, url: `https://${host}`, host, type: 'domain',
    registrableDomain: host, environment: 'PROD', backendPort: port++, remoteRoot: '/var/www',
    state: 'DEPLOYED', createdAt: at, updatedAt: at, ...extra,
  });
}
const recharger = (t) => PanelDeploymentTarget.findOne({ targetId: t.targetId });

/* -------------------------------------------------------------------------- */
section('1. LA PARENTÉ EST DÉCLARÉE, JAMAIS DÉDUITE');
{
  // Tout ce qui pourrait servir d'heuristique est identique : même base, même
  // serveur, même préfixe de domaine, même environnement.
  const a = await creerCible('demo-x.exemple.com', { dbName: 'partagee', sshHost: '10.0.0.1' });
  const b = await creerCible('demo-x.autre.com', { dbName: 'partagee', sshHost: '10.0.0.1' });

  const idA = await identity.ensureOwnIdentity(a);
  const idB = await identity.ensureOwnIdentity(b);

  check('chaque destination reçoit une identité', Boolean(idA.identityId && idB.identityId));
  check('base partagée : AUCUNE fusion', idA.identityId !== idB.identityId);
  check('serveur partagé : AUCUNE fusion', idA.identityId !== idB.identityId);
  check('l’identité est opaque (ni nom, ni domaine)',
    /^[0-9a-f-]{36}$/.test(idA.identityId)
    && !idA.identityId.includes('demo') && !idA.identityId.includes('exemple'));
  check('la destination porte désormais son identité',
    (await recharger(a)).projectIdentityId === idA.identityId);

  const encore = await identity.ensureOwnIdentity(await recharger(a));
  check('rejouable : la même identité est retrouvée', encore.identityId === idA.identityId);
  check('…et aucune identité en double', (await PanelProjectIdentity.countDocuments()) === 2);
  check('le rattachement est journalisé', idA.links.length === 1 && idA.links[0].host === a.host);
}

/* -------------------------------------------------------------------------- */
section('2. RATTACHER À UN PROJET EXISTANT — et refuser de réécrire un parent');
{
  const parent = await creerCible('projet-parent.exemple.com');
  const suite = await creerCible('projet-suite.exemple.com');
  const etranger = await creerCible('projet-etranger.exemple.com');

  const idParent = await identity.ensureOwnIdentity(parent);
  await identity.ensureOwnIdentity(etranger);

  const r = await identity.attachTargetToIdentity(suite, idParent.identityId, {
    actor: 'ops@panel.test', reason: 'changement de domaine',
  });
  check('une destination neuve peut être déclarée enfant', r.alreadyLinked === false);
  check('…et porte l’identité du parent',
    (await recharger(suite)).projectIdentityId === idParent.identityId);
  check('…l’acte est journalisé avec son auteur',
    r.identity.links.some((l) => l.host === suite.host && l.actor === 'ops@panel.test' && l.origin === 'DECLARED'));

  const rejeu = await identity.attachTargetToIdentity(await recharger(suite), idParent.identityId);
  check('rejouable sans effet', rejeu.alreadyLinked === true);
  check('…sans doubler le journal',
    (await PanelProjectIdentity.findOne({ identityId: idParent.identityId }))
      .links.filter((l) => l.host === suite.host).length === 1);

  // Réécrire un parent ouvrirait un droit de copie entre deux projets qui n'en
  // ont jamais partagé.
  let refus = null;
  await identity.attachTargetToIdentity(await recharger(etranger), idParent.identityId)
    .catch((e) => { refus = e; });
  check('réécrire un parent déjà déclaré est REFUSÉ', refus !== null && refus.statusCode === 409);
  check('…et la destination garde son parent d’origine',
    (await recharger(etranger)).projectIdentityId !== idParent.identityId);
}

/* -------------------------------------------------------------------------- */
section('3. SOURCES DE MIGRATION — même identité, sain, et ailleurs');
{
  const ancien = await creerCible('ancien.exemple.com');
  const actuel = await creerCible('actuel.exemple.com');
  const autre = await creerCible('autre-projet.exemple.com');

  const id = await identity.ensureOwnIdentity(ancien);
  await identity.attachTargetToIdentity(actuel, id.identityId);
  const idAutre = await identity.ensureOwnIdentity(autre);

  const loc = await identity.recordLocation({
    projectIdentityId: id.identityId, targetId: ancien.targetId, host: ancien.host,
    siteRoot: '/var/www/ancien.exemple.com',
    sharedUploadsPath: '/var/www/ancien.exemple.com/shared/uploads',
    environment: 'PROD', deploymentRunId: 'run-1',
  });
  const echoue = await identity.recordLocation({
    projectIdentityId: id.identityId, targetId: ancien.targetId, host: ancien.host,
    siteRoot: '/var/www/ancien-rate.exemple.com',
    sharedUploadsPath: '/var/www/ancien-rate.exemple.com/shared/uploads',
    environment: 'PROD', deploymentRunId: 'run-rate',
  });
  await identity.markLocationFailed(echoue._id);
  const voisin = await identity.recordLocation({
    projectIdentityId: idAutre.identityId, targetId: autre.targetId, host: autre.host,
    siteRoot: '/var/www/autre-projet.exemple.com',
    sharedUploadsPath: '/var/www/autre-projet.exemple.com/shared/uploads',
    environment: 'PROD', deploymentRunId: 'run-2',
  });
  await identity.markLocationHealthy(voisin._id);

  check('un emplacement naît « en cours », pas « sain »', loc.status === 'DEPLOYING');
  const avant = await identity.resolveUploadsSources({
    projectIdentityId: id.identityId, targetId: actuel.targetId,
    sharedUploadsPath: '/var/www/actuel.exemple.com/shared/uploads',
  });
  check('un emplacement non vérifié n’est PAS une source', avant.sources.length === 0);

  await identity.markLocationHealthy(loc._id, { deploymentRunId: 'run-1' });
  const apres = await identity.resolveUploadsSources({
    projectIdentityId: id.identityId, targetId: actuel.targetId,
    sharedUploadsPath: '/var/www/actuel.exemple.com/shared/uploads',
  });
  check('une fois vérifié, il devient une source', apres.sources.length === 1);
  check('…et c’est bien l’ancien emplacement',
    apres.sources[0].sharedUploadsPath === '/var/www/ancien.exemple.com/shared/uploads');
  check('l’emplacement EN ÉCHEC reste exclu',
    !apres.sources.some((s) => s.sharedUploadsPath.includes('ancien-rate')));
  check('l’emplacement d’un AUTRE projet reste exclu',
    !apres.sources.some((s) => s.sharedUploadsPath.includes('autre-projet')));

  const orpheline = await identity.resolveUploadsSources({
    projectIdentityId: null, targetId: actuel.targetId, sharedUploadsPath: '/var/www/x/shared/uploads',
  });
  check('sans identité déclarée : AUCUNE source', orpheline.sources.length === 0);

  const rechargee = await recharger(ancien);
  check('la destination mémorise son emplacement courant',
    rechargee.currentSiteRoot === '/var/www/ancien.exemple.com');
  check('…et le run qui l’a vérifiée', rechargee.lastHealthyDeploymentRunId === 'run-1');

  await identity.recordLocation({
    projectIdentityId: id.identityId, targetId: ancien.targetId, host: ancien.host,
    siteRoot: '/var/www/ancien.exemple.com',
    sharedUploadsPath: '/var/www/ancien.exemple.com/shared/uploads',
    environment: 'PROD', deploymentRunId: 'run-1',
  });
  check('rejouer un run n’ajoute pas d’emplacement',
    (await PanelDeploymentLocation.countDocuments({ targetId: ancien.targetId, deploymentRunId: 'run-1' })) === 1);
}

/* -------------------------------------------------------------------------- */
section('4. CHEMINS — une remontée de répertoire n’est jamais « nettoyée »');
{
  const refuse = (p) => {
    try { assertUploadsPath(p, { remoteRoot: '/var/www' }); return false; } catch { return true; }
  };
  check('accepte un chemin canonique sous la racine',
    assertUploadsPath('/var/www/site.fr/shared/uploads') === '/var/www/site.fr/shared/uploads');
  check('refuse une remontée `..`', refuse('/var/www/../etc/shadow'));
  check('refuse une remontée enfouie', refuse('/var/www/site.fr/../../etc'));
  check('refuse un chemin relatif', refuse('site.fr/shared/uploads'));
  check('refuse la racine elle-même', refuse('/var/www'));
  check('refuse hors de la racine', refuse('/etc/letsencrypt'));
  check('refuse un métacaractère shell', refuse('/var/www/site;rm -rf /'));
}

/* -------------------------------------------------------------------------- */
section('5. MIGRATION — copier sans jamais écraser, et s’arrêter au désaccord');
{
  const { createHash } = await import('node:crypto');
  const sha = (s) => createHash('sha256').update(s).digest('hex');

  /** VPS simulé : chemin absolu → contenu. `exec` couvre find/sha256sum et cp -n. */
  const faireVps = (fichiers) => {
    const fs = new Map(Object.entries(fichiers));
    const copies = [];
    return {
      fs, copies,
      async exec(cmd) {
        const inv = cmd.match(/^if \[ -d '(.+?)' \]; then cd '(.+?)' && find/);
        if (inv) {
          const dir = inv[1];
          const lignes = [...fs.keys()]
            .filter((f) => f.startsWith(`${dir}/`))
            .map((f) => `${sha(fs.get(f))}  ./${f.slice(dir.length + 1)}`);
          return { code: 0, stdout: lignes.join('\n'), stderr: '' };
        }
        const cp = cmd.match(/cp -n --preserve=timestamps -- '(.+?)' '(.+?)'$/);
        if (cp) {
          const [, src, dst] = cp;
          copies.push({ src, dst });
          if (!fs.has(src)) return { code: 1, stdout: '', stderr: 'no such file' };
          if (!fs.has(dst)) fs.set(dst, fs.get(src)); // `-n` : jamais d'écrasement
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
  };

  const SRC = '/var/www/ancien.fr/shared/uploads';
  const DST = '/var/www/actuel.fr/shared/uploads';
  const ID = 'identite-commune';
  const source = [{ host: 'ancien.fr', sharedUploadsPath: SRC, projectIdentityId: ID }];

  {
    const vps = faireVps({
      [`${SRC}/favicon.webp`]: 'FAVICON',
      [`${SRC}/logo.webp`]: 'LOGO',
      [`${SRC}/galerie/voiture.webp`]: 'VOITURE',
    });
    const r = await migrateUploads(vps, { destination: DST, identityId: ID, sources: source });
    check('les trois médias sont migrés', r.migrated === 3);
    check('…vérifiés par empreinte après copie', r.verified === true);
    check('…y compris dans un sous-dossier', vps.fs.get(`${DST}/galerie/voiture.webp`) === 'VOITURE');
    check('…avec le contenu exact', vps.fs.get(`${DST}/favicon.webp`) === 'FAVICON');

    const r2 = await migrateUploads(vps, { destination: DST, identityId: ID, sources: source });
    check('rejeu : aucune nouvelle copie', r2.migrated === 0);
    check('…et les fichiers sont reconnus déjà présents', r2.alreadyPresent === 3);
    check('…idempotent, aucune commande de copie supplémentaire', vps.copies.length === 3);
  }

  {
    const vps = faireVps({
      [`${SRC}/logo.webp`]: 'ANCIEN_LOGO',
      [`${SRC}/nouveau.webp`]: 'NOUVEAU',
      [`${DST}/logo.webp`]: 'ANCIEN_LOGO',
    });
    const r = await migrateUploads(vps, { destination: DST, identityId: ID, sources: source });
    check('seul le média absent est copié', r.migrated === 1);
    check('…le fichier déjà présent est laissé intact', vps.fs.get(`${DST}/logo.webp`) === 'ANCIEN_LOGO');
    check('…et il n’a fait l’objet d’aucune copie', !vps.copies.some((c) => c.dst.endsWith('logo.webp')));
  }

  {
    const vps = faireVps({
      [`${SRC}/logo.webp`]: 'VERSION_A',
      [`${SRC}/sain.webp`]: 'SAIN',
      [`${DST}/logo.webp`]: 'VERSION_B',
    });
    let err = null;
    await migrateUploads(vps, { destination: DST, identityId: ID, sources: source })
      .catch((e) => { err = e; });
    check('un conflit de contenu ARRÊTE la migration', err?.code === 'UPLOADS_MIGRATION_CONFLICT');
    check('…en nommant le fichier', err?.details?.file === 'logo.webp');
    check('…avec les DEUX empreintes, pour trancher',
      Boolean(err?.details?.sourceHash && err?.details?.destinationHash)
      && err.details.sourceHash !== err.details.destinationHash);
    check('…et le fichier de destination reste intact', vps.fs.get(`${DST}/logo.webp`) === 'VERSION_B');
    check('…aucune copie n’a été tentée', vps.copies.length === 0);
  }

  {
    const vps = faireVps({ [`${SRC}/photo.webp`]: 'PHOTO' });
    let err = null;
    await migrateUploads(vps, {
      destination: DST, identityId: ID,
      sources: [{ host: 'autre.fr', sharedUploadsPath: SRC, projectIdentityId: 'une-autre-identite' }],
    }).catch((e) => { err = e; });
    check('source d’un autre projet : REFUS explicite', err?.code === 'UPLOADS_MIGRATION_IDENTITY_MISMATCH');
    check('…et rien n’a été copié', vps.copies.length === 0);
  }

  {
    const vps = faireVps({ [`${SRC}/photo.webp`]: 'PHOTO' });
    let err = null;
    await migrateUploads(vps, { destination: DST, identityId: null, sources: [] }).catch((e) => { err = e; });
    check('sans identité : migration REFUSÉE', err?.code === 'UPLOADS_MIGRATION_NO_IDENTITY');
  }

  {
    const vps = faireVps({});
    const r = await migrateUploads(vps, { destination: DST, identityId: ID, sources: [] });
    check('projet neuf sans emplacement antérieur : aucun échec', r.migrated === 0);
  }

  {
    const vps = faireVps({ [`${SRC}/volatil.webp`]: 'X' });
    const exec = vps.exec.bind(vps);
    vps.exec = async (cmd) => {
      if (cmd.includes('cp -n')) vps.fs.delete(`${SRC}/volatil.webp`);
      return exec(cmd);
    };
    let err = null;
    await migrateUploads(vps, { destination: DST, identityId: ID, sources: source })
      .catch((e) => { err = e; });
    check('fichier source disparu : échec explicite', err?.code === 'UPLOADS_MIGRATION_COPY_FAILED');
  }

  {
    const vps = { async exec() { return { code: 0, stdout: 'ceci-nest-pas-un-inventaire\n', stderr: '' }; } };
    let err = null;
    await inventoryUploads(vps, DST).catch((e) => { err = e; });
    check('inventaire illisible : refus de travailler dessus', err?.code === 'UPLOADS_INVENTORY_UNREADABLE');
  }
}

/* -------------------------------------------------------------------------- */
section('6. LE PIPELINE — migrer avant de vérifier, publier après');
{
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pipeline = await fs.readFile(path.join(racine, 'backend/src/deployment-engine/pipeline.js'), 'utf8');
  const at = (id) => pipeline.indexOf(`await step('${id}'`);

  check('l’étape de migration existe', at('uploads_migrate') > 0);
  check('elle vient APRÈS le transfert de l’artefact', at('uploads_migrate') > at('upload'));
  check('…et APRÈS la liaison des dossiers partagés', at('uploads_migrate') > at('dirs'));
  check('…et AVANT la vérification publique', at('uploads_migrate') < at('validate'));
  check('la vérification précède toujours la publication réseau', at('validate') < at('runtime_config'));

  const { PIPELINE_STEPS } = await import('../backend/src/deployment-engine/pipeline.js');
  check('la liste déclarée suit l’ordre d’exécution',
    PIPELINE_STEPS.indexOf('uploads_migrate') < PIPELINE_STEPS.indexOf('validate')
    && PIPELINE_STEPS.indexOf('validate') < PIPELINE_STEPS.indexOf('runtime_config'));

  const { CANONICAL_ORDER, toCanonical } = await import('../backend/src/deployment-engine/steps.js');
  check('l’étape a un identifiant canonique', toCanonical('uploads_migrate') === 'uploads.migrate');
  check('…placé avant la vérification publique',
    CANONICAL_ORDER.indexOf('uploads.migrate') < CANONICAL_ORDER.indexOf('public.healthcheck'));
  check('runtime.sync est APRÈS public.healthcheck (affichage et rapport)',
    CANONICAL_ORDER.indexOf('runtime.sync') > CANONICAL_ORDER.indexOf('public.healthcheck'));

  // Le moteur ne cherche jamais une source : il ne connaît que celle qu'on lui donne.
  const uploads = await fs.readFile(path.join(racine, 'backend/src/deployment-engine/uploads.js'), 'utf8');
  const sansCommentaires = uploads.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('le moteur ne scanne aucun répertoire de déploiement',
    !/\/var\/www\/\*/.test(sansCommentaires) && !sansCommentaires.includes('ls /var/www'));
  check('…et ne rapproche jamais deux destinations par leur domaine',
    !/registrableDomain|subdomain|dbName/.test(sansCommentaires));

  // Le Panel fournit bien cette source à chaque déploiement.
  const exec = await fs.readFile(
    path.join(racine, 'backend/src/services/deployment/deploymentExecutor.service.js'), 'utf8');
  check('l’exécuteur du Panel injecte la résolution de source', exec.includes('resolveUploadsSources,'));
  check('…et ne promeut l’emplacement qu’en cas de succès',
    /if \(result\.ok\) await identity\.markLocationHealthy/.test(exec));
}

await stopMemoryMongo();
finish();
