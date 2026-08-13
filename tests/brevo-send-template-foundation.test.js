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
const operations = await import('../backend/src/services/capabilities/operationRegistry.js');

const { default: PanelEmailTemplate } = await import('../backend/src/models/PanelEmailTemplate.model.js');
const { default: PanelEmailTemplateVersion } = await import('../backend/src/models/PanelEmailTemplateVersion.model.js');
const { default: PanelProjectSenderIdentity } = await import('../backend/src/models/PanelProjectSenderIdentity.model.js');
const { default: PanelCapabilityOperation, OPERATION_STATUS } = await import('../backend/src/models/PanelCapabilityOperation.model.js');

await PanelEmailTemplate.syncIndexes();
await PanelEmailTemplateVersion.syncIndexes();
await PanelProjectSenderIdentity.syncIndexes();
await PanelCapabilityOperation.syncIndexes();

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const PROJET_A = 'projet-a';
const PROJET_B = 'projet-b';

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
section('2 · L’amorçage pose les défauts de plateforme, une seule fois');
{
  // Le registre fait foi : l'amorçage doit poser TOUT ce qu'il déclare, ni
  // plus ni moins. Le nombre attendu vient de la liste nominative ci-dessus,
  // qui est elle-même verrouillée dans les deux sens.
  const N = templates.listTemplateCodes().length;

  const premier = await templates.seedPlatformTemplates();
  check(`${N} modèles amorcés au premier passage`, premier.created === N && premier.existing === 0);

  const second = await templates.seedPlatformTemplates();
  check('rejoué : aucun nouveau modèle', second.created === 0 && second.existing === N);

  check(`${N} documents en base, pas un de plus`,
    (await PanelEmailTemplate.countDocuments({ projectId: null })) === N);
  check('chaque amorçage a laissé une version 1',
    (await PanelEmailTemplateVersion.countDocuments({ origin: 'BOOTSTRAP' })) === N);

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
  await templates.saveTemplate('PASSWORD_RESET_REQUEST', {
    subject: 'Sujet réécrit à la main {{company.name}}',
    expectedVersion: 1,
  }, ACTEUR);
  await templates.seedPlatformTemplates();
  const apres = await templates.resolveTemplate('PASSWORD_RESET_REQUEST');
  check('un contenu écrit par un humain n’est JAMAIS réécrit par le seed',
    apres.subject === 'Sujet réécrit à la main {{company.name}}');
}

/* ══════════════════════════════════════════════════════════════════════════
   3. PORTÉE — plateforme, projet, et surtout PAS environnement.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Le contenu est par projet, avec un défaut de plateforme');
{
  const defaut = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', { projectId: PROJET_A });
  check('sans contenu propre, le projet hérite de la plateforme', defaut.source === 'PLATFORM');

  await templates.saveTemplate('CONTACT_ADMIN_NOTIFICATION', {
    projectId: PROJET_A,
    subject: 'Contact chez A — {{contact.name}}',
    expectedVersion: defaut.version,
  }, ACTEUR);

  const propre = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', { projectId: PROJET_A });
  check('le projet A lit désormais SON contenu', propre.source === 'PROJECT'
    && propre.subject === 'Contact chez A — {{contact.name}}');

  const b = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', { projectId: PROJET_B });
  check('le projet B n’est pas affecté', b.source === 'PLATFORM');
  const plateforme = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION');
  check('le défaut de plateforme est intact', plateforme.source === 'PLATFORM'
    && plateforme.subject !== propre.subject);

  /**
   * PAS DE PORTÉE PAR ENVIRONNEMENT — et c'est la décision la plus discutable
   * du lot, donc celle qu'un test doit figer. Un texte qui diffère entre TEST
   * et PROD signifie qu'on ne relit jamais ce qu'on expédie.
   */
  const champs = Object.keys(PanelEmailTemplate.schema.paths);
  check('le modèle ne porte AUCUN champ d’environnement', !champs.includes('environment'));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. RENDU — même moteur pour l’aperçu et pour l’envoi.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Le rendu est celui du projet, sans une règle assouplie');
{
  const rendu = await templates.renderForSend({
    templateCode: 'PASSWORD_RESET_REQUEST',
    projectId: PROJET_A,
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

  // Une variable manquante fait ÉCHOUER — jamais un e-mail à trou.
  let manque = null;
  try {
    await templates.renderForSend({
      templateCode: 'PASSWORD_RESET_REQUEST', projectId: PROJET_A,
      variables: { 'company.name': 'Garage A' },
    });
  } catch (err) { manque = err; }
  check('une variable requise absente fait échouer le rendu', manque !== null);

  // Un modèle désactivé REFUSE, il n'est pas silencieusement sauté.
  await templates.saveTemplate('EMAIL_SENDER_VERIFICATION_TEST', { enabled: false }, ACTEUR);
  let coupe = null;
  try {
    await templates.renderForSend({
      templateCode: 'EMAIL_SENDER_VERIFICATION_TEST', projectId: PROJET_A, variables: {},
    });
  } catch (err) { coupe = err; }
  check('un modèle désactivé REFUSE l’envoi, explicitement',
    coupe?.code === 'PANEL_EMAIL_TEMPLATE_DISABLED');
  await templates.saveTemplate('EMAIL_SENDER_VERIFICATION_TEST', { enabled: true }, ACTEUR);

  // L'aperçu emprunte le MÊME chemin : sinon il montrerait un rendu que
  // l'envoi refuserait, et l'on croirait le modèle bon.
  const apercu = await templates.previewTemplate('CONTRACT_CANCELLATION_DEV_NOTIFICATION');
  check('l’aperçu se rend avec les données d’exemple', apercu.subject.length > 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. ÉDITION — validation, versions, et jeton d’édition.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Éditer sans perdre : versions, restauration, conflits');
{
  const avant = await templates.resolveTemplate('CONTRACT_CANCELLATION_DEV_NOTIFICATION');

  // Le contenu dangereux est refusé — la validation du projet a suivi le contenu.
  let dangereux = null;
  try {
    await templates.saveTemplate('CONTRACT_CANCELLATION_DEV_NOTIFICATION', {
      html: '<html><body><script>alert(1)</script></body></html>',
      expectedVersion: avant.version,
    }, ACTEUR);
  } catch (err) { dangereux = err; }
  check('un <script> dans le HTML est REFUSÉ', dangereux?.code === 'PANEL_EMAIL_TEMPLATE_INVALID');

  // Une variable inconnue est refusée : le registre décide, pas l'éditeur.
  let inventee = null;
  try {
    await templates.saveTemplate('CONTRACT_CANCELLATION_DEV_NOTIFICATION', {
      subject: 'Bonjour {{variable.inventee}}',
      expectedVersion: avant.version,
    }, ACTEUR);
  } catch (err) { inventee = err; }
  check('une variable inventée est refusée', inventee !== null);

  const v2 = await templates.saveTemplate('CONTRACT_CANCELLATION_DEV_NOTIFICATION', {
    subject: 'Résiliation v2 — {{contract.reference}}',
    expectedVersion: avant.version,
  }, ACTEUR);
  check('la version s’incrémente', v2.version === avant.version + 1);

  // JETON D'ÉDITION : deux DEV ne s'écrasent pas en silence.
  let conflit = null;
  try {
    await templates.saveTemplate('CONTRACT_CANCELLATION_DEV_NOTIFICATION', {
      subject: 'Écriture bâtie sur une lecture périmée',
      expectedVersion: avant.version,
    }, ACTEUR);
  } catch (err) { conflit = err; }
  check('une écriture bâtie sur une version périmée est REFUSÉE',
    conflit?.code === 'PANEL_EMAIL_TEMPLATE_VERSION_CONFLICT');

  // RESTAURATION : elle crée une version DE PLUS, elle ne remonte pas le temps.
  const restaure = await templates.restoreVersion('CONTRACT_CANCELLATION_DEV_NOTIFICATION', avant.version, {}, ACTEUR);
  check('la restauration rend l’ancien contenu', restaure.subject === avant.subject);
  check('…en créant une version SUPPLÉMENTAIRE', restaure.version === v2.version + 1);
  const historique = await templates.listVersions('CONTRACT_CANCELLATION_DEV_NOTIFICATION');
  check('l’historique porte la trace de la restauration',
    historique[0].origin === 'RESTORE' && historique[0].restoredFromVersion === avant.version);
  check('l’historique n’a jamais été réécrit', historique.length >= 3);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. PROJECT_A_CANNOT_USE_B_SENDER — l’invariant du lot.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Un projet ne peut jamais expédier au nom d’un autre');
{
  await senders.saveSenderIdentity(PROJET_A, 'TEST', {
    fromEmail: 'contact@garage-a.fr', fromName: 'Garage A',
    replyToEmail: 'sav@garage-a.fr',
  }, ACTEUR);
  await senders.saveSenderIdentity(PROJET_B, 'TEST', {
    fromEmail: 'contact@garage-b.fr', fromName: 'Garage B',
  }, ACTEUR);

  const a = await senders.resolveForProject({ authenticatedProjectId: PROJET_A, environment: 'TEST' });
  check('A résout SON expéditeur', a.fromEmail === 'contact@garage-a.fr');
  check('…avec son adresse de réponse', a.replyTo?.email === 'sav@garage-a.fr');

  /**
   * LA GARDE : A demande explicitement l'identité de B. Le contrat L8 refuse
   * sur ÉGALITÉ MANQUÉE plutôt que d'ignorer en silence — un projet qui envoie
   * un identifiant étranger a un bug ou une intention, et les deux méritent une
   * trace.
   */
  let usurpation = null;
  try {
    await senders.resolveForProject({
      authenticatedProjectId: PROJET_A, requestedProjectId: PROJET_B, environment: 'TEST',
    });
  } catch (err) { usurpation = err; }
  check('A DEMANDANT l’identité de B est REFUSÉ',
    usurpation?.code === 'SENDER_IDENTITY_SCOPE_VIOLATION' && usurpation?.statusCode === 403);

  // Sans identité dans le monde servi, on refuse — jamais de repli.
  let absente = null;
  try {
    await senders.resolveForProject({ authenticatedProjectId: PROJET_A, environment: 'PROD' });
  } catch (err) { absente = err; }
  check('aucune identité en PROD → refus, jamais un repli sur celle de TEST',
    absente?.code === 'SENDER_IDENTITY_MISSING');

  // ENVIRONMENT_CANNOT_BE_SELECTED : l'environnement n'est pas devinable.
  let sansMonde = null;
  try {
    await senders.resolveForProject({ authenticatedProjectId: PROJET_A, environment: null });
  } catch (err) { sansMonde = err; }
  check('un environnement absent est refusé, jamais deviné', sansMonde !== null);
}

section('6 bis · Une identité expéditrice ne porte JAMAIS de secret');
{
  let secret = null;
  try {
    await senders.saveSenderIdentity(PROJET_A, 'TEST', {
      fromEmail: 'contact@garage-a.fr', fromName: 'Garage A',
      apiKey: ['xkeysib', 'NEDOITJAMAISENTRER'].join('-'),
    }, ACTEUR);
  } catch (err) { secret = err; }
  check('un `apiKey` glissé dans l’identité est REFUSÉ', secret !== null);
  check('le message nomme le champ fautif', /apiKey/.test(secret?.message ?? ''));

  const brut = await PanelProjectSenderIdentity.collection.find({}).toArray();
  check('aucun champ de secret en base', !JSON.stringify(brut).includes('xkeysib'));

  // Changer d'adresse invalide la reconnaissance : Brevo valide une ADRESSE.
  await senders.markVerifiedAtProvider(PROJET_A, 'TEST', true);
  check('l’adresse peut être marquée reconnue',
    (await senders.describeForProject(PROJET_A, 'TEST')).verifiedAtProvider === true);
  await senders.saveSenderIdentity(PROJET_A, 'TEST', {
    fromEmail: 'nouvelle@garage-a.fr', fromName: 'Garage A',
  }, ACTEUR);
  check('changer d’adresse RETIRE la preuve de reconnaissance',
    (await senders.describeForProject(PROJET_A, 'TEST')).verifiedAtProvider === false);
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

  const modele = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', { projectId: PROJET_A });
  check('le contenu du projet a survécu', modele.source === 'PROJECT');

  const identite = await senders.describeForProject(PROJET_A, 'TEST');
  check('l’identité expéditrice a survécu', identite.configured === true);

  const rejeu = await operations.claimOperation({
    projectId: PROJET_A, capability: 'email.send_template', operationId: 'op-000000001',
    environment: 'TEST', provider: 'BREVO',
  });
  check('L’IDEMPOTENCE SURVIT — un rejeu après redémarrage n’envoie toujours rien',
    rejeu.claim === operations.CLAIM.ALREADY_SUCCEEDED);
}

await stopMemoryMongo();
finish();
