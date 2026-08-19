// LES TROIS BRIQUES DE `email.send_template` — L8.3.
//
// ══ CE QUE CE LOT DEVAIT CONSTRUIRE ══════════════════════════════════════════
//
// Le rapport L8.2 nommait trois manques structurels, et refusait de basculer
// l'envoi tant qu'ils tenaient :
//
//   1. l'autorité de CONTENU du Panel (modèles, versions, rendu) ;
//   2. les IDENTITÉS EXPÉDITRICES par projet ;
//   3. l'IDEMPOTENCE des envois, que Brevo n'offre pas.
//
// Cette recette les éprouve isolément, avant tout branchement du chemin
// d'envoi. C'est délibéré : une brique fausse branchée sur un envoi réel se
// découvre chez un destinataire.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo, simulateRestart,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const registre = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');
const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const senders = await import('../backend/src/services/email/panelSenderIdentity.service.js');
const globalSender = await import('../backend/src/services/email/panelGlobalSender.service.js');
const operations = await import('../backend/src/services/capabilities/operationRegistry.js');

const { default: PanelEmailTemplate } = await import('../backend/src/models/PanelEmailTemplate.model.js');
const { default: PanelEmailTemplateVersion } = await import('../backend/src/models/PanelEmailTemplateVersion.model.js');
const { default: PanelProjectSenderIdentity } = await import('../backend/src/models/PanelProjectSenderIdentity.model.js');
const { default: PanelCapabilityOperation, OPERATION_STATUS } = await import('../backend/src/models/PanelCapabilityOperation.model.js');

await PanelEmailTemplate.syncIndexes();
await PanelEmailTemplateVersion.syncIndexes();
await PanelProjectSenderIdentity.syncIndexes();
await PanelCapabilityOperation.syncIndexes();

const scopes = await import('../backend/src/services/email/panelEmailTemplateScope.js');
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const PROJET_A = 'projet-a';
const PROJET_B = 'projet-b';

const PANEL = scopes.panelScope();
const SCOPE_A = scopes.projectScope(PROJET_A);
const SCOPE_B = scopes.projectScope(PROJET_B);

/**
 * DEUX FICHES DE PROJET RÉELLES — parce que la portée est désormais VALIDÉE.
 *
 * `assertScopeUsable()` refuse une portée dont le projet n'existe pas au
 * registre : c'est ce qui empêche de créer la ligne fantôme que l'audit avait
 * trouvée. Une recette qui inventerait un identifiant de projet éprouverait
 * donc un chemin que la production n'a pas.
 */
async function declareProjet(projectId, projectName) {
  const at = new Date().toISOString();
  await PanelProject.updateOne(
    { projectId },
    {
      $set: { projectName, updatedAt: at },
      $setOnInsert: {
        projectKey: projectId,
        createdAt: at,
        pairing: { status: 'PAIRED' },
        runtime: {},
      },
    },
    { upsert: true },
  );
}
await declareProjet(PROJET_A, 'Projet A');
await declareProjet(PROJET_B, 'Projet B');

/* ══════════════════════════════════════════════════════════════════════════
   1. TEMPLATE_CODE_IS_CANONICAL — des codes métier, jamais un id Brevo.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Les codes de modèle sont canoniques et code-first');
{
  /**
   * ══ POURQUOI UN COMPTE EN DUR, ET POURQUOI IL DOIT FAIRE MAL ═══════════════
   *
   * Ce nombre n'est pas une commodité : c'est un point de passage obligé. Tout
   * modèle ajouté au registre canonique casse ce contrôle, et c'est le but —
   * il force à venir déclarer nominativement le nouveau modèle plutôt qu'à le
   * laisser entrer sans que personne ne l'ait regardé.
   *
   * Il a d'ailleurs déjà rempli son office : L10.5 a ajouté les deux modèles de
   * prestation sans passer par ici, et ce contrôle est resté rouge jusqu'à
   * L10.6B-2. La leçon n'est pas de dériver le nombre du registre — cela
   * supprimerait le garde-fou — mais de venir ici quand on ajoute un modèle.
   *
   * Un nombre SEUL serait toutefois insuffisant : remplacer un modèle par un
   * autre le laisserait passer. La liste nominative ci-dessous est donc
   * EXHAUSTIVE, et vérifiée dans les deux sens.
   */
  const ATTENDUS = [
    // Fondation (L8.4C)
    'PASSWORD_RESET_REQUEST',
    'CONTACT_ADMIN_NOTIFICATION',
    'CONTRACT_CANCELLATION_ADMIN_CONFIRMATION',
    'CONTRACT_CANCELLATION_DEV_NOTIFICATION',
    'EMAIL_SENDER_VERIFICATION_TEST',
    // L10.5 — prestations ponctuelles
    'PAYMENT_REQUEST_CREATED',
    'PAYMENT_REQUEST_REMINDER',
    // L10.6B-2 — impayé ayant réellement fermé un site. Deux publics, deux
    // messages : le client agit, l'équipe instruit.
    'SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT',
    'SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM',
    // L10.6 FINAL — la suspension MANUELLE, décidée par l'équipe. Distinct des
    // deux ci-dessus : le client n'a aucune prise dessus, et lui parler de
    // facturation laisserait croire à un impayé qui n'existe pas. Déclenché par
    // le PROJET (`email.send_template`), rendu et expédié ici.
    'SITE_SUSPENDED_MANUAL_ADMIN',
    // R10.4 — le test d'expédition de l'expéditeur global. Un VRAI modèle du
    // registre, et non un corps fabriqué par le service de test : un envoi de
    // diagnostic qui contournerait la résolution, le rendu, la validation des
    // variables et le versionnement réussirait là où un envoi réel échoue.
    'PANEL_EMAIL_SENDER_TEST',
    // LOT 2C — l'activation du PREMIER accès d'administration d'un projet
    // dupliqué. Il manquait à cette liste : le contrôle était rouge avant le
    // présent lot, et le rougissement était juste — c'est bien un modèle du
    // parc, déclaré côté `TEMPLATE_OWNERSHIP` mais jamais inscrit ici.
    'DEV_ACCOUNT_ACTIVATION',
    // Recette métier — le cycle de vie d'un paiement, vu par le client d'un
    // projet. Quatre instants, quatre messages, et aucun ne recouvre ceux du
    // Panel : ces derniers ne parlent qu'une fois le site déjà fermé.
    'CONTRACT_PAYMENT_RECEIVED_ADMIN',
    'CONTRACT_PAYMENT_OVERDUE_ADMIN',
    'CONTRACT_PAYMENT_OVERDUE_CRITICAL_ADMIN',
    'CONTRACT_PAYMENT_RECOVERED_ADMIN',
    // Recette métier — l'alerte technique aux développeurs responsables d'un
    // projet, natifs ET fédérés. Portée PANEL : elle nomme des composants
    // internes et ne porte jamais l'apparence du client.
    'PLATFORM_INCIDENT_DEV_ALERT',
  ];

  const codes = templates.listTemplateCodes();
  check(`les ${ATTENDUS.length} modèles du parc sont là`, codes.length === ATTENDUS.length);
  check('ce sont les codes RÉELS du dépôt, repris tels quels',
    ATTENDUS.every((c) => codes.includes(c)));
  /**
   * L'AUTRE SENS — aucun modèle ne s'invite sans être déclaré ici. Sans ce
   * contrôle, un ajout non revu passerait dès que le compte est corrigé.
   */
  const intrus = codes.filter((c) => !ATTENDUS.includes(c));
  check(`aucun modèle non déclaré (${intrus.join(', ') || 'aucun'})`, intrus.length === 0);

  /**
   * RAW_BREVO_TEMPLATE_ID_REJECTED — un identifiant numérique de modèle Brevo
   * n'est pas un code. L'accepter ferait sortir le contenu de nos versions et
   * le rendrait éditable depuis l'interface du fournisseur.
   */
  let refuse = null;
  try { templates.assertKnownTemplate('42'); } catch (err) { refuse = err; }
  check('un identifiant de modèle Brevo est REFUSÉ',
    refuse?.code === 'PANEL_EMAIL_TEMPLATE_UNKNOWN' && refuse?.statusCode === 404);

  let inconnu = null;
  try { templates.assertKnownTemplate('MON_TEMPLATE_MAISON'); } catch (err) { inconnu = err; }
  check('un code inventé est refusé lui aussi', inconnu !== null);

  check('le registre est gelé', Object.isFrozen(registre.EMAIL_TEMPLATE_REGISTRY));
  check('aucun code ne ressemble à un identifiant fournisseur',
    codes.every((c) => !/^\d+$/.test(c)));
}

/* ══════════════════════════════════════════════════════════════════════════
   2. AMORÇAGE — idempotent, et jamais destructif.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · L’amorçage pose les instances PANEL, une seule fois');
{
  /**
   * ══ CE QUE L11.1 A CHANGÉ ICI ═════════════════════════════════════════════
   *
   * L'amorçage posait les 11 codes en `projectId: null`. Il n'en pose plus que
   * ceux dont la DÉFINITION déclare la portée PANEL. Poser une instance PANEL
   * de `CONTACT_ADMIN_NOTIFICATION` créerait un document que le runtime ne
   * consulterait jamais — la notification de contact part en portée PROJECT —
   * mais qu'un exploitant éditerait en croyant changer quelque chose. C'est la
   * « surface fantôme » de l'audit, et elle ne doit pas renaître d'un seed.
   *
   * Le compte n'est donc plus `listTemplateCodes().length` : il est dérivé de
   * la classification, elle-même verrouillée par sa propre recette.
   */
  const N = templates.listTemplateCodesForScope(PANEL).length;
  check('la portée PANEL ne réclame pas les 11 codes', N < templates.listTemplateCodes().length);

  const premier = await templates.seedPlatformTemplates();
  check(`${N} modèles PANEL amorcés au premier passage`, premier.created === N && premier.existing === 0);

  const second = await templates.seedPlatformTemplates();
  check('rejoué : aucun nouveau modèle', second.created === 0 && second.existing === N);

  check(`${N} documents PANEL en base, pas un de plus`,
    (await PanelEmailTemplate.countDocuments({ scopeType: 'PANEL' })) === N);
  check('chaque amorçage a laissé une version 1',
    (await PanelEmailTemplateVersion.countDocuments({ origin: 'BOOTSTRAP' })) === N);

  /**
   * AUCUNE INSTANCE PROJET N'EST NÉE TOUTE SEULE. Le lot exige que le contenu
   * d'un projet soit un ACTE — pose de migration ou écriture d'un DEV — jamais
   * un effet de bord du démarrage.
   */
  check('l’amorçage ne crée AUCUNE instance projet',
    (await PanelEmailTemplate.countDocuments({ scopeType: 'PROJECT' })) === 0);

  /**
   * NOMINATIF — les modèles de L10.5 sont réellement AMORÇÉS, pas seulement
   * déclarés. Un modèle présent au registre mais absent en base ne serait
   * jamais envoyable, et le compte seul ne l'aurait pas dit.
   */
  const enBase = (await PanelEmailTemplate.find({ projectId: null }).select('templateCode').lean())
    .map((t) => t.templateCode);
  for (const code of [
    'PAYMENT_REQUEST_CREATED', 'PAYMENT_REQUEST_REMINDER',
    'SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT', 'SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM',
  ]) {
    check(`${code} est amorcé en base`, enBase.includes(code));
  }

  // NON DESTRUCTIF : un contenu réécrit survit à un rejeu du seed.
  await templates.saveTemplate('PASSWORD_RESET_REQUEST', PANEL, {
    subject: 'Sujet réécrit à la main {{company.name}}',
    expectedVersion: 1,
  }, ACTEUR);
  await templates.seedPlatformTemplates();
  const apres = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', PANEL);
  check('un contenu écrit par un humain n’est JAMAIS réécrit par le seed',
    apres.subject === 'Sujet réécrit à la main {{company.name}}');
}

/* ══════════════════════════════════════════════════════════════════════════
   3. PORTÉE — plateforme, projet, et surtout PAS environnement.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Le contenu est PAR PORTÉE, et il n’y a AUCUN repli PROJECT → PANEL');
{
  /**
   * ══ LE TEST QUI RETOURNE LA DOCTRINE ══════════════════════════════════════
   *
   * Cette section vérifiait exactement l'inverse jusqu'à L11.1 : « sans contenu
   * propre, le projet hérite de la plateforme ». C'était le comportement, il
   * était documenté, et il était le défaut central du système — parce qu'aucune
   * surface ne permettait jamais de rompre cet héritage. Tous les clients du
   * parc recevaient donc le même HTML, sous le nom de L.Y Solution.
   *
   * Le repli est supprimé. Un projet sans instance n'envoie PAS.
   */
  let sansInstance = null;
  try {
    await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_A);
  } catch (err) { sansInstance = err; }
  check('un projet SANS instance ne reçoit AUCUN contenu — il ÉCHOUE',
    sansInstance?.code === templates.EMAIL_TEMPLATE_NOT_CONFIGURED);
  check('…et le refus nomme la portée, pas Brevo',
    sansInstance?.details?.scopeId === PROJET_A && sansInstance?.statusCode === 409);

  await templates.saveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_A, {
    subject: 'Contact chez A — {{contact.name}}',
  }, ACTEUR);

  const propre = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_A);
  check('le projet A lit désormais SON contenu',
    propre.source === 'PROJECT' && propre.subject === 'Contact chez A — {{contact.name}}');

  /**
   * L'ISOLATION EST UN FAIT DE BASE, PAS UNE POLITESSE. Écrire chez A ne crée
   * rien chez B, et B reste en échec tant que personne n'a décidé de son texte.
   */
  let bTouche = null;
  try {
    await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_B);
  } catch (err) { bTouche = err; }
  check('le projet B n’a rien reçu de l’écriture faite chez A',
    bTouche?.code === templates.EMAIL_TEMPLATE_NOT_CONFIGURED);

  await templates.saveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_B, {
    subject: 'Contact chez B — {{contact.name}}',
  }, ACTEUR);
  const bPropre = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_B);
  check('MÊME CODE, DEUX PROJETS, DEUX CONTENUS DISTINCTS',
    bPropre.subject === 'Contact chez B — {{contact.name}}' && bPropre.subject !== propre.subject);

  const documents = await PanelEmailTemplate.find({ templateCode: 'CONTACT_ADMIN_NOTIFICATION' }).lean();
  check('…et DEUX DOCUMENTS Mongo, jamais un seul partagé',
    documents.length === 2 && new Set(documents.map((d) => String(d._id))).size === 2);

  /**
   * UN CODE PANEL N'A PAS D'INSTANCE PROJET — et le refus est explicite.
   *
   * Sans cette garde, un DEV pourrait créer `PROJECT/A/PAYMENT_REQUEST_CREATED` :
   * un document que le runtime ne lirait jamais (la facturation part du Panel)
   * mais qu'un exploitant éditerait en croyant agir.
   */
  let interdit = null;
  try {
    await templates.saveTemplate('PAYMENT_REQUEST_CREATED', SCOPE_A, { subject: 'Chez A' }, ACTEUR);
  } catch (err) { interdit = err; }
  check('un code PANEL est REFUSÉ en portée projet',
    interdit?.code === 'PANEL_EMAIL_TEMPLATE_SCOPE_FORBIDDEN_FOR_CODE');

  let interditInverse = null;
  try {
    await templates.saveTemplate('CONTACT_ADMIN_NOTIFICATION', PANEL, { subject: 'Chez le Panel' }, ACTEUR);
  } catch (err) { interditInverse = err; }
  check('…et un code PROJECT est refusé en portée PANEL',
    interditInverse?.code === 'PANEL_EMAIL_TEMPLATE_SCOPE_FORBIDDEN_FOR_CODE');

  /**
   * LA PORTÉE NE SE DEVINE PAS DEPUIS UN IDENTIFIANT NU. L'ancienne forme
   * `{ projectId }` est refusée BRUYAMMENT : la tolérer ferait retomber un
   * appelant non migré sur le défaut PANEL, donc écrire chez L.Y Solution en
   * croyant écrire chez un client — silencieusement.
   */
  let ancienneForme = null;
  try {
    await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', { projectId: PROJET_A });
  } catch (err) { ancienneForme = err; }
  check('la forme de portée obsolète `{ projectId }` est refusée',
    ancienneForme?.code === 'PANEL_EMAIL_TEMPLATE_SCOPE_INVALID');

  /**
   * PAS DE PORTÉE PAR ENVIRONNEMENT — et c'est la décision la plus discutable
   * du lot, donc celle qu'un test doit figer. Un texte qui diffère entre TEST
   * et PROD signifie qu'on ne relit jamais ce qu'on expédie.
   */
  const champs = Object.keys(PanelEmailTemplate.schema.paths);
  check('le modèle ne porte AUCUN champ d’environnement', !champs.includes('environment'));
  check('…mais il porte bien une portée DÉCLARÉE', champs.includes('scopeType'));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. RENDU — même moteur pour l’aperçu et pour l’envoi.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Le rendu est celui du projet, sans une règle assouplie');
{
  // L'instance projet doit exister — c'est le fail-closed de la section 3.
  await templates.provisionProjectTemplates(PROJET_A, { actor: ACTEUR });

  const rendu = await templates.renderForSend({
    templateCode: 'PASSWORD_RESET_REQUEST',
    scope: SCOPE_A,
    variables: {
      'company.name': 'Garage A',
      'user.name': 'Jean <script>',
      'auth.resetUrl': 'https://garage-a.fr/reset?t=abc',
      'auth.expiresMinutes': 30,
    },
  });
  check('le sujet est rendu', rendu.subject.includes('Garage A'));
  check('LE HTML EST ÉCHAPPÉ PAR DÉFAUT — aucune balise injectée',
    !rendu.html.includes('<script>') && rendu.html.includes('&lt;script&gt;'));
  /**
   * LE RENDU DIT QUEL DOCUMENT IL A RENDU (Phases 13-14). Sans cela, ni le
   * journal du Panel ni la livraison du projet ne peuvent répondre après coup
   * à « quel template exact est parti ».
   */
  check('le rendu porte la portée et la version RÉELLEMENT servies',
    rendu.scopeType === 'PROJECT' && rendu.scopeId === PROJET_A
    && rendu.source === 'PROJECT' && rendu.version >= 1);

  // Une variable manquante fait ÉCHOUER — jamais un e-mail à trou.
  let manque = null;
  try {
    await templates.renderForSend({
      templateCode: 'PASSWORD_RESET_REQUEST', scope: SCOPE_A,
      variables: { 'company.name': 'Garage A' },
    });
  } catch (err) { manque = err; }
  check('une variable requise absente fait échouer le rendu', manque !== null);

  // Un modèle désactivé REFUSE, il n'est pas silencieusement sauté.
  await templates.saveTemplate('EMAIL_SENDER_VERIFICATION_TEST', SCOPE_A, { enabled: false }, ACTEUR);
  let coupe = null;
  try {
    await templates.renderForSend({
      templateCode: 'EMAIL_SENDER_VERIFICATION_TEST', scope: SCOPE_A, variables: {},
    });
  } catch (err) { coupe = err; }
  check('un modèle désactivé REFUSE l’envoi, explicitement',
    coupe?.code === 'PANEL_EMAIL_TEMPLATE_DISABLED');
  await templates.saveTemplate('EMAIL_SENDER_VERIFICATION_TEST', SCOPE_A, { enabled: true }, ACTEUR);

  // L'aperçu emprunte le MÊME chemin : sinon il montrerait un rendu que
  // l'envoi refuserait, et l'on croirait le modèle bon.
  const apercu = await templates.previewTemplate('CONTRACT_CANCELLATION_DEV_NOTIFICATION', PANEL);
  check('l’aperçu se rend avec les données d’exemple', apercu.subject.length > 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. ÉDITION — validation, versions, et jeton d’édition.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Éditer sans perdre : versions, restauration, conflits');
{
  const CODE = 'CONTRACT_CANCELLATION_DEV_NOTIFICATION';
  const avant = await templates.resolveTemplate(CODE, PANEL);

  // Le contenu dangereux est refusé — la validation du projet a suivi le contenu.
  let dangereux = null;
  try {
    await templates.saveTemplate(CODE, PANEL, {
      html: '<html><body><script>alert(1)</script></body></html>',
      expectedVersion: avant.version,
    }, ACTEUR);
  } catch (err) { dangereux = err; }
  check('un <script> dans le HTML est REFUSÉ', dangereux?.code === 'PANEL_EMAIL_TEMPLATE_INVALID');

  // Une variable inconnue est refusée : le registre décide, pas l'éditeur.
  let inventee = null;
  try {
    await templates.saveTemplate(CODE, PANEL, {
      subject: 'Bonjour {{variable.inventee}}',
      expectedVersion: avant.version,
    }, ACTEUR);
  } catch (err) { inventee = err; }
  check('une variable inventée est refusée', inventee !== null);

  const v2 = await templates.saveTemplate(CODE, PANEL, {
    subject: 'Résiliation v2 — {{contract.reference}}',
    expectedVersion: avant.version,
  }, ACTEUR);
  check('la version s’incrémente', v2.version === avant.version + 1);

  // JETON D'ÉDITION : deux DEV ne s'écrasent pas en silence.
  let conflit = null;
  try {
    await templates.saveTemplate(CODE, PANEL, {
      subject: 'Écriture bâtie sur une lecture périmée',
      expectedVersion: avant.version,
    }, ACTEUR);
  } catch (err) { conflit = err; }
  check('une écriture bâtie sur une version périmée est REFUSÉE',
    conflit?.code === 'PANEL_EMAIL_TEMPLATE_VERSION_CONFLICT');

  // RESTAURATION : elle crée une version DE PLUS, elle ne remonte pas le temps.
  const restaure = await templates.restoreVersion(CODE, PANEL, avant.version, ACTEUR);
  check('la restauration rend l’ancien contenu', restaure.subject === avant.subject);
  check('…en créant une version SUPPLÉMENTAIRE', restaure.version === v2.version + 1);
  const historique = await templates.listVersions(CODE, PANEL);
  check('l’historique porte la trace de la restauration',
    historique[0].origin === 'RESTORE' && historique[0].restoredFromVersion === avant.version);
  check('l’historique n’a jamais été réécrit', historique.length >= 3);

  /**
   * L'HISTORIQUE EST ÉTANCHE À LA PORTÉE (Phase 12).
   *
   * `PROJECT/A/CONTACT_ADMIN_NOTIFICATION` porte lui aussi une v1 et une v2.
   * Restaurer chez A ne doit toucher aucun document PANEL, et réciproquement.
   * Sans la portée dans la clé de recherche, la restauration serait une loterie
   * entre documents homonymes.
   */
  const versionsA = await templates.listVersions('CONTACT_ADMIN_NOTIFICATION', SCOPE_A);
  const versionsB = await templates.listVersions('CONTACT_ADMIN_NOTIFICATION', SCOPE_B);
  check('chaque portée a son PROPRE historique',
    versionsA.length >= 1 && versionsB.length >= 1
    && versionsA.every((v) => v.projectId === PROJET_A)
    && versionsB.every((v) => v.projectId === PROJET_B));

  const avantB = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_B);
  await templates.restoreVersion('CONTACT_ADMIN_NOTIFICATION', SCOPE_A, 1, ACTEUR);
  const apresB = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_B);
  check('restaurer chez A ne touche RIEN chez B',
    apresB.version === avantB.version && apresB.subject === avantB.subject);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. PROJECT_A_CANNOT_USE_B_SENDER — l’invariant du lot.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Un projet ne peut jamais détourner la correspondance d’un autre');
{
  /**
   * ══ CE QUE R10.4 A CHANGÉ DANS CETTE SECTION ═══════════════════════════════
   *
   * L'invariant du lot L8 était « A ne peut pas expédier AU NOM DE B ». Il a
   * cessé d'avoir un sujet le jour où le `From` est devenu unique et global :
   * A et B expédient désormais sous la MÊME adresse, celle de la plateforme,
   * et il n'y a plus d'identité d'expéditeur à usurper.
   *
   * L'invariant n'a pas disparu pour autant — il s'est déplacé sur le champ qui
   * reste par projet, le `Reply-To`. Un projet capable de désigner l'adresse de
   * réponse d'un autre détournerait sa correspondance : les réponses de ses
   * clients arriveraient chez lui. C'est le même risque, sur le seul champ qui
   * peut encore le porter.
   */
  await senders.saveSenderIdentity(PROJET_A, 'TEST', { replyToEmail: 'sav@garage-a.fr' }, ACTEUR);
  await senders.saveSenderIdentity(PROJET_B, 'TEST', { replyToEmail: 'sav@garage-b.fr' }, ACTEUR);

  await globalSender.updateGlobalSender(
    { senderEmail: 'support@ly-solution.fr', senderName: 'L.Y Solution' }, ACTEUR,
  );

  const a = await senders.resolveForProject({ authenticatedProjectId: PROJET_A, environment: 'TEST' });
  const b = await senders.resolveForProject({ authenticatedProjectId: PROJET_B, environment: 'TEST' });

  check('SINGLE_GLOBAL_FROM — A expédie sous l’adresse de la plateforme',
    a.fromEmail === 'support@ly-solution.fr' && a.fromName === 'L.Y Solution');
  check('…et B sous exactement la même', b.fromEmail === a.fromEmail && b.fromName === a.fromName);
  check('A garde SON adresse de réponse', a.replyTo?.email === 'sav@garage-a.fr');
  check('…et B la sienne', b.replyTo?.email === 'sav@garage-b.fr');

  /**
   * LA GARDE : A demande explicitement la configuration de B. Le contrat L8
   * refuse sur ÉGALITÉ MANQUÉE plutôt que d'ignorer en silence — un projet qui
   * envoie un identifiant étranger a un bug ou une intention, et les deux
   * méritent une trace.
   */
  let usurpation = null;
  try {
    await senders.resolveForProject({
      authenticatedProjectId: PROJET_A, requestedProjectId: PROJET_B, environment: 'TEST',
    });
  } catch (err) { usurpation = err; }
  check('A DEMANDANT la configuration de B est REFUSÉ',
    usurpation?.code === 'SENDER_IDENTITY_SCOPE_VIOLATION' && usurpation?.statusCode === 403);

  /**
   * Sans `Reply-To` dans le monde servi : AUCUN repli, et aucun refus non plus.
   *
   * C'est la différence de nature avec l'ancien `From`. Un expéditeur manquant
   * bloquait l'envoi — il fallait bien écrire quelque chose dans l'en-tête. Une
   * adresse de réponse manquante est un cas NORMAL : les réponses arrivent au
   * support de la plateforme, ce qui est un défaut acceptable.
   */
  const prod = await senders.resolveForProject({ authenticatedProjectId: PROJET_A, environment: 'PROD' });
  check('aucun Reply-To en PROD → pas de repli sur celui de TEST', prod.replyTo === null);
  check('…et l’envoi reste possible, sous l’expéditeur global',
    prod.fromEmail === 'support@ly-solution.fr');
}

section('6 bis · Une configuration d’expéditeur ne porte JAMAIS de secret');
{
  let secret = null;
  try {
    await senders.saveSenderIdentity(PROJET_A, 'TEST', {
      replyToEmail: 'sav@garage-a.fr',
      apiKey: ['xkeysib', 'NEDOITJAMAISENTRER'].join('-'),
    }, ACTEUR);
  } catch (err) { secret = err; }
  check('un `apiKey` glissé dans la configuration est REFUSÉ', secret !== null);
  check('le message nomme le champ fautif', /apiKey/.test(secret?.message ?? ''));

  const brut = await PanelProjectSenderIdentity.collection.find({}).toArray();
  check('aucun champ de secret en base', !JSON.stringify(brut).includes('xkeysib'));

  /**
   * NO_PROJECT_FROM — la garde qui rend `PROJECT_EMAIL_FROM_CONFIGURATION = 0`
   * vérifiable plutôt que déclaratif.
   *
   * On refuse le champ au lieu de l'ignorer : l'ignorer laisserait un appelant
   * croire qu'il a configuré l'expéditeur de son projet, et l'écart entre ce
   * qu'il a saisi et ce qui part ne se verrait qu'à la réception.
   */
  for (const champ of ['fromEmail', 'fromName', 'senderEmail', 'senderName']) {
    let refus = null;
    try {
      await senders.saveSenderIdentity(PROJET_A, 'TEST', { [champ]: 'x@y.fr' }, ACTEUR);
    } catch (err) { refus = err; }
    check(`« ${champ} » ne se configure PAS par projet`,
      refus?.code === 'PANEL_PROJECT_FROM_NOT_CONFIGURABLE');
  }

  const stocke = await PanelProjectSenderIdentity.collection.find({}).toArray();
  check('aucun document de projet ne porte d’expéditeur',
    stocke.every((d) => d.fromEmail === undefined && d.fromName === undefined));
}

/* ══════════════════════════════════════════════════════════════════════════
   7. ONE_OPERATION_ID_ONE_EMAIL — l’idempotence que Brevo n’offre pas.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Une opération, un effet');
{
  const base = {
    projectId: PROJET_A, capability: 'email.send_template',
    environment: 'TEST', provider: 'BREVO', templateCode: 'PASSWORD_RESET_REQUEST',
    recipientEmail: 'Client@Exemple.FR',
  };

  const premier = await operations.claimOperation({ ...base, operationId: 'op-000000001' });
  check('la première réclamation donne le droit d’exécuter', premier.claim === operations.CLAIM.EXECUTE);
  check('l’adresse n’est stockée QU’en empreinte',
    premier.operation.recipientHash.length === 16
    && !JSON.stringify(premier.operation).toLowerCase().includes('client@exemple.fr'));

  await operations.settleSucceeded(premier.operation, { providerMessageId: 'msg-abc', durationMs: 120 });

  const rejeu = await operations.claimOperation({ ...base, operationId: 'op-000000001' });
  check('LE REJEU N’ENVOIE RIEN', rejeu.claim === operations.CLAIM.ALREADY_SUCCEEDED);
  check('…et rend le résultat CONSERVÉ', rejeu.operation.providerMessageId === 'msg-abc');
  check('une seule opération en base',
    (await PanelCapabilityOperation.countDocuments({ operationId: 'op-000000001' })) === 1);

  // CONCURRENT_DUPLICATE_ONE_EMAIL — l'index tranche, pas une lecture.
  const resultats = await Promise.all(Array.from({ length: 8 }, () =>
    operations.claimOperation({ ...base, operationId: 'op-000000002' })));
  const executants = resultats.filter((r) => r.claim === operations.CLAIM.EXECUTE);
  check('sur 8 appels SIMULTANÉS, UN SEUL exécute', executants.length === 1);
  check('les sept autres constatent qu’un envoi est en cours',
    resultats.filter((r) => r.claim === operations.CLAIM.IN_FLIGHT).length === 7);
  check('une seule ligne en base', (await PanelCapabilityOperation.countDocuments({ operationId: 'op-000000002' })) === 1);

  // Deux projets peuvent porter le même operationId sans se gêner.
  const memeCle = await operations.claimOperation({ ...base, projectId: PROJET_B, operationId: 'op-000000001' });
  check('le même identifiant chez un AUTRE projet exécute normalement',
    memeCle.claim === operations.CLAIM.EXECUTE);
}

section('7 bis · TIMEOUT_UNKNOWN_NO_AUTO_RETRY');
{
  const base = {
    projectId: PROJET_A, capability: 'email.send_template',
    environment: 'TEST', provider: 'BREVO',
  };

  const doute = await operations.claimOperation({ ...base, operationId: 'op-timeout-001' });
  await operations.settleFailure(doute.operation, {
    resolved: false, errorCode: 'CAPABILITY_TIMEOUT', errorMessage: 'pas de réponse',
  });

  const stocke = await PanelCapabilityOperation.findOne({ operationId: 'op-timeout-001' }).lean();
  check('un délai dépassé est rangé en UNKNOWN, jamais en FAILED',
    stocke.status === OPERATION_STATUS.UNKNOWN);

  const apres = await operations.claimOperation({ ...base, operationId: 'op-timeout-001' });
  check('UNE ISSUE INDÉCIDABLE NE SE REJOUE JAMAIS SEULE',
    apres.claim === operations.CLAIM.UNRESOLVED);
  check('…et l’opération reste en UNKNOWN', apres.operation.status === OPERATION_STATUS.UNKNOWN);

  // Un échec CERTAIN, lui, se rejoue : rien n'est parti.
  const echec = await operations.claimOperation({ ...base, operationId: 'op-failed-001' });
  await operations.settleFailure(echec.operation, {
    resolved: true, errorCode: 'CAPABILITY_PROVIDER_UNAVAILABLE', httpStatus: 503,
  });
  const rejouable = await operations.claimOperation({ ...base, operationId: 'op-failed-001' });
  check('un échec CERTAIN est rejouable', rejouable.claim === operations.CLAIM.EXECUTE);
  check('…sur la MÊME ligne, avec une tentative de plus', rejouable.operation.attempts === 2);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. PROVIDER_MESSAGE_ID_PRESERVED — la poignée du suivi de livraison.
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · L’identifiant fournisseur relie l’événement au bon projet');
{
  const trouve = await operations.findByProviderMessageId({
    provider: 'BREVO', environment: 'TEST', providerMessageId: 'msg-abc',
  });
  check('l’opération se retrouve depuis l’identifiant de message', trouve !== null);
  check('…et elle désigne LE BON projet', trouve.projectId === PROJET_A);
  check('…et le bon modèle', trouve.templateCode === 'PASSWORD_RESET_REQUEST');

  const absent = await operations.findByProviderMessageId({
    provider: 'BREVO', environment: 'TEST', providerMessageId: 'msg-inconnu',
  });
  check('un identifiant inconnu ne désigne personne', absent === null);

  const vue = operations.describeOperation(trouve);
  check('la vue rendue ne porte NI contenu NI adresse',
    !('recipientHash' in vue) && !('html' in vue) && !('subject' in vue));
  check('elle porte l’essentiel du diagnostic',
    vue.status === 'SUCCEEDED' && vue.providerMessageId === 'msg-abc');
}

/* ══════════════════════════════════════════════════════════════════════════
   9. PERSISTANCE — ce que le Panel garde, et ce qu’il laisse au projet.
   ══════════════════════════════════════════════════════════════════════════ */
section('9 · Le Panel est un transport, pas un CRM');
{
  const brut = await PanelCapabilityOperation.collection.find({}).toArray();
  const texte = JSON.stringify(brut);
  check('aucun contenu d’e-mail conservé',
    !texte.includes('htmlContent') && !texte.includes('<html'));
  check('aucune adresse de destinataire en clair',
    !texte.toLowerCase().includes('client@exemple.fr'));
  check('aucun sujet rendu', !texte.includes('Réinitialisation de votre'));

  const champs = Object.keys(PanelCapabilityOperation.schema.paths);
  for (const interdit of ['subject', 'html', 'body', 'recipientEmail', 'variables']) {
    check(`le modèle ne porte pas « ${interdit} »`, !champs.includes(interdit));
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   10. REDÉMARRAGE — l’état est en base, pas en mémoire.
   ══════════════════════════════════════════════════════════════════════════ */
section('10 · Tout survit à un redémarrage');
{
  await simulateRestart();

  const modele = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_A);
  check('le contenu du projet a survécu', modele.source === 'PROJECT');

  const identite = await senders.describeForProject(PROJET_A, 'TEST');
  check('l’adresse de réponse du projet a survécu', identite.configured === true);
  check('…et l’expéditeur GLOBAL aussi',
    (await globalSender.describeGlobalSender()).senderEmail === 'support@ly-solution.fr');

  const rejeu = await operations.claimOperation({
    projectId: PROJET_A, capability: 'email.send_template', operationId: 'op-000000001',
    environment: 'TEST', provider: 'BREVO',
  });
  check('L’IDEMPOTENCE SURVIT — un rejeu après redémarrage n’envoie toujours rien',
    rejeu.claim === operations.CLAIM.ALREADY_SUCCEEDED);
}

await stopMemoryMongo();
finish();
