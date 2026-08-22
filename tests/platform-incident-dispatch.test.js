/* L'INCIDENT TECHNIQUE D'UN PROJET — du rapport jusqu'à l'adaptateur d'envoi.
 *
 * ══ CE QUE CE FICHIER PROUVE, ET POURQUOI IL FALLAIT LE PROUVER ═════════════
 *
 * L'audit d'autorité des modèles a trouvé un chemin mort : le projet envoyait
 * lui-même `PLATFORM_INCIDENT_DEV_ALERT`, un modèle de portée PANEL. Un projet
 * ne peut pas demander une portée PANEL — le rendu opposait
 * `EMAIL_TEMPLATE_NOT_DECLARED_BY_PROJECT`, et l'échec se rangeait dans une
 * livraison que personne ne relisait. AUCUN incident du parc n'a jamais été
 * notifié, et aucun test ne le voyait : celui du projet observait un dispatcher
 * local avec un envoi simulé, et passait au vert.
 *
 * La leçon porte au-delà de ce bug : un test qui s'arrête AVANT la frontière
 * d'autorité ne prouve rien de ce qui se passe après elle. Ce fichier va donc
 * jusqu'à l'adaptateur — le dernier composant avant le fournisseur — et vérifie
 * ce qu'il a réellement préparé.
 *
 * ══ POURQUOI AUCUN VRAI E-MAIL NE PART ══════════════════════════════════════
 *
 * Le transport est remplacé. Expédier un faux incident polluerait des boîtes
 * réelles pour démontrer une propriété qui se lit entièrement dans ce que
 * l'adaptateur remet au transport : le bon modèle, la bonne portée, les bonnes
 * variables, le bon destinataire.
 *
 * Base en mémoire, aucun réseau. Runner autonome. */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { PanelProjectMember } = await import('../backend/src/models/PanelProjectProjection.model.js');
const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const scopes = await import('../backend/src/services/email/panelEmailTemplateScope.js');
const registry = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');
const definitions = await import('../backend/src/services/email/panelEmailTemplateDefinitions.js');
const alerting = await import('../backend/src/services/supervision/platformIncidentAlerting.service.js');
const projectRegistry = await import('../backend/src/services/registry/projectRegistry.service.js');
const globalSender = await import('../backend/src/services/email/panelGlobalSender.service.js');
const { brevoSendTemplate } = await import('../backend/src/services/capabilities/brevoSendAdapter.js');

/**
 * Le projet est déclaré par le VRAI chemin du registre : `PanelProject` exige
 * un `projectKey`, un bloc `pairing` et un bloc `runtime` que seul lui sait
 * composer. Le fabriquer à la main produirait un document que le produit ne
 * crée jamais — et un test bâti dessus prouverait autre chose que la réalité.
 */
const { record: projet } = await projectRegistry.declareProject({
  publicBackendUrl: 'https://incident-recette.test',
  projectName: 'Projet de recette (incident)',
  environment: 'TEST',
});
const PROJET = projet.projectId;
const INCIDENT = {
  kind: 'CAPABILITY_FAILURE',
  component: 'billing.checkout.create',
  environment: 'TEST',
  occurrences: 3,
  firstSeenAt: '2026-08-22T09:00:00.000Z',
  error: { code: 'BRIDGE_UNAVAILABLE', message: 'Le Panel n’a pas répondu après 3 tentatives.' },
};

// ═══════════════════════════════════════════════════════════════════════════
section('1 · L’OWNERSHIP DU MODÈLE — c’est lui qui rendait l’ancien chemin mort');
{
  const def = definitions.templateDefinition(alerting.INCIDENT_TEMPLATE);
  check('le modèle d’alerte existe au registre', Boolean(def));
  check('il est de portée PANEL, et de PANEL seulement',
    def.scopes.length === 1 && def.scopes[0] === 'PANEL');
  check('il n’est jamais provisionné pour un projet', def.provisionForProjects === false);

  /**
   * LE REFUS QUI TUAIT L'ANCIEN CHEMIN, REPRODUIT ICI.
   *
   * Une portée PROJECT est refusée pour ce code. C'est exactement ce que le
   * projet obtenait quand il l'invoquait — et il l'obtenait en silence.
   */
  let refus = null;
  try {
    definitions.assertScopeAllowedForCode(alerting.INCIDENT_TEMPLATE, scopes.projectScope(PROJET));
  } catch (e) { refus = e; }
  check('demander ce modèle en portée PROJECT est REFUSÉ', Boolean(refus));
  check('…et le refus nomme la portée comme cause',
    /PANEL/.test(refus?.message ?? ''));

  /** …tandis qu'en portée PANEL, il est parfaitement légitime. */
  let panelOk = true;
  try { definitions.assertScopeAllowedForCode(alerting.INCIDENT_TEMPLATE, scopes.panelScope()); }
  catch { panelOk = false; }
  check('le même modèle EST servi en portée PANEL', panelOk);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · Le décor : un projet, ses développeurs, le modèle amorcé');
{
  await PanelProjectMember.create({
    projectId: PROJET,
    entityId: 'membre-dev-1',
    sourceUserId: 'u1',
    email: 'dev@recette.test',
    name: 'Dév de recette',
    role: 'DEV',
    sourceModifiedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  });
  await PanelProjectMember.create({
    projectId: PROJET,
    entityId: 'membre-admin-1',
    sourceUserId: 'u2',
    email: 'admin@client.test',
    name: 'Admin du client',
    role: 'ADMIN',
    sourceModifiedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  });

  await templates.seedPanelTemplates();

  /**
   * L'EXPÉDITEUR GLOBAL — sans lui l'adaptateur refuse, et il a raison.
   *
   * Depuis que le `From` du parc est unique et détenu par le Panel, aucun envoi
   * n'est possible tant qu'il n'est pas renseigné. Le poser ici fait partie du
   * décor minimal : sans lui, ce test prouverait seulement qu'un Panel mal
   * configuré n'envoie rien — ce qu'on sait déjà.
   */
  await globalSender.updateGlobalSender(
    { senderEmail: 'support@ly-solution.test', senderName: 'L.Y Solution' },
    { userId: 'u-recette', userEmail: 'recette@panel.test' },
  );
  const pose = await templates.resolveTemplate(alerting.INCIDENT_TEMPLATE, scopes.panelScope());
  check('le modèle d’alerte est configuré en portée PANEL', pose.configured === true);
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · LE DESTINATAIRE est choisi par le PANEL, jamais par le projet');
{
  const { recipients, source } = await alerting.resolveIncidentRecipients(PROJET);
  check('les développeurs du projet sont retenus',
    recipients.some((r) => r.email === 'dev@recette.test'));
  check('la source est nommée', source === 'PROJECT_DEV_MEMBERS');

  /**
   * §15 — L'ADMINISTRATEUR DU CLIENT NE REÇOIT RIEN DE TECHNIQUE.
   *
   * Le message nomme des composants internes (« CAPABILITY_FAILURE —
   * billing.checkout.create »). L'envoyer au garagiste serait la fuite que le
   * cloisonnement des populations existe pour empêcher.
   */
  check('§15 aucun administrateur client n’est destinataire',
    !recipients.some((r) => r.email === 'admin@client.test'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · LE RENDU RÉEL — jusqu’à ce que l’adaptateur remet au transport');
{
  /**
   * On appelle l'ADAPTATEUR, pas le service : c'est le dernier composant avant
   * le fournisseur, et c'est là que se décide ce qui part réellement. Le
   * transport est remplacé — aucun e-mail ne quitte cette machine.
   */
  const remisAuTransport = [];
  const fauxFetch = async (url, init) => {
    remisAuTransport.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messageId: '<recette@brevo>' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
  };

  const variables = Object.fromEntries(registry.sampleVariablesFor(alerting.INCIDENT_TEMPLATE));

  const sortie = await brevoSendTemplate({
    definition: { code: 'email.send_template', provider: 'BREVO', timeoutMs: 5000 },
    // `projectId: null` = INVOCATION PANEL_SELF. C'est ce qui ouvre la portée
    // PANEL, et c'est toute la correction : le Panel parle en son propre nom.
    context: { projectId: null, environment: 'TEST' },
    credentials: { apiKey: 'xkeysib-recette', baseUrl: 'https://api.brevo.test/v3' },
    input: {
      templateRef: alerting.INCIDENT_TEMPLATE,
      recipient: { email: 'dev@recette.test', name: 'Dév de recette' },
      variables,
      operationId: alerting.incidentOperationId({
        projectId: PROJET,
        component: INCIDENT.component,
        firstSeenAt: INCIDENT.firstSeenAt,
        occurrences: INCIDENT.occurrences,
      }),
    },
    fetchImpl: fauxFetch,
  }).catch((e) => e);

  if (sortie instanceof Error) console.error('    (adaptateur) ', sortie.code, sortie.message);
  check('l’adaptateur a ACCEPTÉ l’envoi', sortie?.status === 'ACCEPTED');
  check('il a résolu le modèle en portée PANEL', sortie?.templateScope === 'PANEL');
  check('…sans aucun projet attaché à cette portée', sortie?.templateScopeId === null);
  check('il rend le code du modèle', sortie?.templateCode === alerting.INCIDENT_TEMPLATE);
  check('il rend le SUJET réellement expédié (L12.1)',
    typeof sortie?.subject === 'string' && sortie.subject.length > 0);
  check('…et ce sujet ne contient plus aucun placeholder',
    !String(sortie?.subject ?? '{{').includes('{{'));

  const remis = remisAuTransport[0];
  check('le transport a bien été appelé UNE fois', remisAuTransport.length === 1);
  check('…avec le destinataire choisi par le Panel',
    remis?.body?.to?.[0]?.email === 'dev@recette.test');
  check('…avec un contenu HTML rendu',
    typeof remis?.body?.htmlContent === 'string' && remis.body.htmlContent.length > 100);
  check('…et sans aucun placeholder non résolu dans le corps',
    !String(remis?.body?.htmlContent ?? '{{').includes('{{'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · L’IDENTITÉ DE L’ACTE converge — un incident, une alerte');
{
  const a = alerting.incidentOperationId({
    projectId: PROJET, component: INCIDENT.component,
    firstSeenAt: INCIDENT.firstSeenAt, occurrences: INCIDENT.occurrences,
  });
  const b = alerting.incidentOperationId({
    projectId: PROJET, component: INCIDENT.component,
    firstSeenAt: INCIDENT.firstSeenAt, occurrences: INCIDENT.occurrences,
  });
  check('le même incident donne le même identifiant d’opération', a === b);

  const palierSuivant = alerting.incidentOperationId({
    projectId: PROJET, component: INCIDENT.component,
    firstSeenAt: INCIDENT.firstSeenAt, occurrences: INCIDENT.occurrences + 1,
  });
  check('un PALIER d’occurrences différent en donne un autre', palierSuivant !== a);
  check('l’identifiant tient dans la borne du contrat', a.length <= 64);
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · Le traitement complet NE LÈVE JAMAIS');
{
  /**
   * ══ POURQUOI CETTE PROPRIÉTÉ COMPTE PLUS QUE L'ALERTE ELLE-MÊME ═══════════
   *
   * L'incident arrive par la synchronisation d'entités. Si son traitement
   * levait, le projet rejouerait l'écriture indéfiniment : une panne d'e-mail
   * deviendrait une panne de pont. Un incident non notifié est regrettable ;
   * un pont bloqué par un incident l'est bien davantage.
   *
   * Ici l'envoi ÉCHOUERA (aucun identifiant Brevo n'est configuré dans cette
   * recette) : c'est exactement le cas qu'on veut voir absorbé.
   */
  const resultat = await alerting.handleProjectIncident({ projectId: PROJET, incident: INCIDENT })
    .then((r) => r).catch((e) => ({ __leve: e }));
  check('le traitement ne lève pas, même quand l’envoi échoue', !resultat?.__leve);
  check('…et il rend un compte rendu exploitable', typeof resultat === 'object');

  const inconnu = await alerting.handleProjectIncident({ projectId: 'projet-inexistant', incident: INCIDENT })
    .then((r) => r).catch((e) => ({ __leve: e }));
  check('un projet inconnu ne fait pas lever non plus', !inconnu?.__leve);
}

// ---------------------------------------------------------------------------
await PanelProjectMember.deleteMany({ projectId: PROJET });
await stopMemoryMongo();
finish();
