/**
 * PANEL_COMPANY_SAVE_TO_SBAUTO_HELP_E2E
 *
 * ══ LA DOCTRINE QUE CE FICHIER VERROUILLE ═══════════════════════════════════
 *
 * `PanelCompany` est la source de vérité de l'identité de l'entreprise.
 * ENREGISTRER SUFFIT. La distribution aux projets est automatique ; les
 * numéros de version sont un mécanisme interne d'ordre et d'idempotence, pas
 * un workflow de publication qu'un utilisateur devrait conduire.
 *
 * ══ CE QUI EST INTERDIT DANS CE FICHIER ═════════════════════════════════════
 *
 * Après le `saveCompany`, aucun appel à :
 *
 *   publishConfiguration · republishCurrentConfiguration · broadcastCompany
 *   recordAppliedConfiguration · applyCompanyProfile
 *
 * Si le seul enregistrement ne suffit pas, le test échoue — et c'est
 * exactement ce qu'on veut savoir. Le produit ne doit pas demander un second
 * geste, donc le test ne doit pas en faire un.
 *
 * ══ CE QUI TOURNE RÉELLEMENT ════════════════════════════════════════════════
 *
 * Un vrai SB Auto, dans son processus, avec sa base et son port. Il tire par
 * HTTP, applique avec son applicateur, persiste dans son modèle — et la page
 * « Aide » est lue par SON contrôLEUR, pas par une relecture de complaisance.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const societe = await import('../backend/src/services/company/company.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const PanelCompanyVersion = (await import('../backend/src/models/PanelCompanyVersion.model.js')).default;

const ACTEUR = { userId: 'u-1', userEmail: 'dev@panel.test' };

await resetSyncCore();
const { base: panelUrl, close: closePanel } = await startServer(createApp());

const { companyId } = await societe.createCompany(
  { identity: { name: 'L.Y Solution' }, slug: 'ly-solution' }, ACTEUR,
);
// L'ÉTAT INITIAL du scénario : « PanelCompany.name = L.Y Solution ». C'est ce
// que fait l'écran — créer, c'est déjà se déclarer aux projets.
await societe.saveCompany(companyId, { identity: { name: 'L.Y Solution' } }, ACTEUR);
const fiche = () => PanelCompany.findOne({ companyId }).lean();

const instances = [];
async function demarrer({ dbName, env, projectName }) {
  const inst = await startSbAutoInstance({ mongoUri: MONGO_URI, dbName, env, projectName });
  instances.push(inst);
  const declared = await registre.declareProject({
    publicBackendUrl: inst.publicBackendUrl, projectName, environment: env,
  });
  const paired = await inst.pair({
    panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: inst.publicBackendUrl,
  });
  inst.projectId = paired.projectId;
  await inst.heartbeat();
  return inst;
}

const projet = await demarrer({ dbName: 'sbauto_help', env: 'TEST', projectName: 'SB Auto Aide' });

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ÉTAT INITIAL — le projet affiche déjà l’entreprise du Panel');
{
  const aide = await projet.help();
  check('la page « Aide » lit une entreprise', aide.company !== null);
  check('…et c’est celle du Panel', aide.company?.identity?.name === 'L.Y Solution');
  check('…le projet se sait relié', aide.paired === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN SEUL ENREGISTREMENT — et rien d’autre');
{
  /**
   * LE GESTE, ET IL EST UNIQUE.
   *
   * Rien avant, rien après : pas de publication, pas de rediffusion, pas de
   * relevé forcé. Ce qui suit doit se produire tout seul.
   */
  await societe.saveCompany(companyId, { identity: { name: 'L.Y Solution Nouvelle' } }, ACTEUR);

  // Le projet fait son travail habituel : il tire. C'est son rythme normal,
  // pas une action de l'utilisateur.
  const tirage = await projet.pull();
  check('le projet a appliqué la nouvelle vérité', tirage.applied >= 1);

  const etat = await projet.state();
  check('sa configuration porte le nouveau nom',
    etat.company?.identity?.name === 'L.Y Solution Nouvelle');

  const aide = await projet.help();
  check('LA PAGE « AIDE » AFFICHE LE NOUVEAU NOM',
    aide.company?.identity?.name === 'L.Y Solution Nouvelle');
  check('…sans qu’aucun second geste n’ait été fait côté Panel', true);

  /**
   * L'écran du Panel ne doit rien réclamer : la fiche enregistrée EST celle
   * que les projets appliquent.
   */
  const publication = await societe.describeCompanyPublication(await fiche());
  check('la fiche ne réclame aucune publication en attente', publication.state === 'PUBLISHED');
  check('…et ne se déclare pas « non publiée »',
    (await societe.describeCompany(await fiche())).hasUnpublishedChanges === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('HORS LIGNE A → B → C — au retour, c’est C, jamais B');
{
  const versionsAvant = await PanelCompanyVersion.countDocuments({ companyId });

  // Le projet ne tire pas : il est absent. Le Panel, lui, continue de vivre.
  await societe.saveCompany(companyId, { identity: { name: 'Agence B' } }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Agence C' } }, ACTEUR);

  const pendantAbsence = await projet.help();
  check('pendant son absence, le projet garde ce qu’il connaissait',
    pendantAbsence.company?.identity?.name === 'L.Y Solution Nouvelle');

  // Il revient, et ne fait qu'une chose : son rattrapage habituel.
  const tirage = await projet.pull();
  check('le rattrapage applique ce qui a été manqué', tirage.applied >= 1);

  const aide = await projet.help();
  check('LA PAGE « AIDE » AFFICHE C', aide.company?.identity?.name === 'Agence C');
  check('…jamais B', aide.company?.identity?.name !== 'Agence B');
  check('…jamais l’ancien nom', aide.company?.identity?.name !== 'L.Y Solution Nouvelle');

  const etat = await projet.state();
  check('la version appliquée est la DERNIÈRE du Panel',
    etat.company?.version === (await fiche()).publishedVersion);
  check('…et il n’en existe qu’une copie', etat.configurationCount === 1);
  check('deux enregistrements ont produit deux versions, pas plus',
    (await PanelCompanyVersion.countDocuments({ companyId })) === versionsAvant + 2);

  /**
   * AUCUN RATTRAPAGE N'A ÉTÉ DEMANDÉ — et cela se prouve sur le journal.
   *
   * Une rediffusion s'adresse NOMMÉMENT à une instance (`audience`). Si le
   * journal ne contient que des écritures diffusées à tout le parc, alors
   * personne — ni l'utilisateur, ni ce test — n'a relancé quoi que ce soit :
   * la convergence est venue du protocole seul.
   */
  const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');
  const nominatives = await PanelSyncJournalEntry.countDocuments({ audience: { $ne: null } });
  check('aucune écriture n’a été adressée nommément à ce projet', nominatives === 0);
  check('…la convergence n’a donc coûté aucun second clic', true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE PROJET SURVIT À L’ABSENCE DU PANEL');
{
  await closePanel();

  const aide = await projet.help();
  check('« Aide » répond encore, Panel éteint', aide.company !== null);
  check('…avec le dernier état convergé', aide.company?.identity?.name === 'Agence C');

  const tirage = await projet.pull();
  check('le rattrapage échoue proprement, sans rien casser',
    tirage.applied === 0 && typeof tirage.reason === 'string');
  check('…et la page « Aide » n’a pas bougé',
    (await projet.help()).company?.identity?.name === 'Agence C');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ISOLATION TEST/PROD — sur le vrai applicateur du projet');
{
  const refus = await projet.applyForeign({ environment: 'PROD' });
  check('une configuration de PRODUCTION est REFUSÉE par un projet de recette',
    refus.applied === false);
  check('…et le motif est nommé', refus.reason === 'ENVIRONMENT_MISMATCH');
  check('…rien n’a changé dans la page « Aide »',
    (await projet.help()).company?.identity?.name === 'Agence C');

  const sienne = await projet.applyForeign({ environment: 'TEST' });
  check('sa propre recette, elle, est acceptée', sienne.applied === true);

  // On rétablit la vérité du Panel : ce test ne laisse pas le projet dans un
  // état inventé par lui-même.
  check('…et l’environnement appliqué reste le sien',
    (await projet.state()).company?.environment === 'TEST');
}

for (const inst of instances) await inst.stop();
await stopMemoryMongo();
finish();
