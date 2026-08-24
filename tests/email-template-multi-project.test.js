// LE PLAN DE CONTRÔLE MULTI-PROJETS DES MODÈLES E-MAIL — L11.1.
//
// ══ CE QUE CE LOT DEVAIT RETOURNER ══════════════════════════════════════════
//
// L'audit d'ownership a établi que le Panel avait réussi la centralisation du
// TRANSPORT — jeton prouvé, coffre jamais diffusé, portée d'expéditeur gardée —
// et centralisé le CONTENU par le même mouvement, sans que ce soit décidé :
//
//   · la portée par projet était MODÉLISÉE (`unique(templateCode, projectId)`)
//     mais aucun code, nulle part, n'écrivait une ligne dont le projet ne soit
//     pas `null` ;
//   · le repli `own ?? platform`, conçu comme un héritage, était donc devenu la
//     VALEUR UNIQUE du parc ;
//   · conséquence directe : le « mot de passe oublié » du Panel et celui d'un
//     client rendaient LE MÊME DOCUMENT, et éditer ce modèle réécrivait
//     l'e-mail de tous les clients à la fois.
//
// Cette recette éprouve le retournement, et rien d'autre. Elle n'est pas une
// suite d'unités : c'est la démonstration que trois portées portent trois
// contenus, que l'absence d'un contenu est un REFUS et jamais un emprunt, et
// qu'aucune surface — corps de requête, pont d'un autre projet, restauration —
// ne permet d'en franchir la frontière.
//
// ══ POURQUOI UN VRAI BREVO HTTP, ET PAS UN ADAPTATEUR MOQUÉ ═════════════════
//
// Parce que la question du lot est « QUEL DOCUMENT EST PARTI ». On ne peut y
// répondre qu'en lisant le corps réellement posté au fournisseur. Un adaptateur
// moqué prouverait qu'on a appelé une fonction ; il ne prouverait pas que le
// HTML du client B est parti chez B.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo, startServer,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CLE_PANEL = ['xkeysib', 'panel', 'l111'].join('-');

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX BREVO QUI PARLE VRAIMENT HTTP — on lira les corps postés.
   ══════════════════════════════════════════════════════════════════════════ */
const appelsBrevo = [];
let messageIdSuivant = 1;

const fauxBrevo = http.createServer((req, res) => {
  let corps = '';
  req.on('data', (c) => { corps += c; });
  req.on('end', () => {
    appelsBrevo.push({ url: req.url, apiKey: req.headers['api-key'] ?? null, body: corps });

    if (req.url.includes('/smtp/email')) {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messageId: `<msg-${messageIdSuivant++}@brevo>` }));
      return;
    }
    if (req.url.includes('/webhooks')) {
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' ? { id: 901 } : { webhooks: [] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ companyName: 'Plateforme', email: 'ops@plateforme.test' }));
  });
});
await new Promise((r) => fauxBrevo.listen(0, '127.0.0.1', r));
const BREVO_BASE = `http://127.0.0.1:${fauxBrevo.address().port}/v3`;

/** Le dernier corps posté à Brevo, décodé. `null` si aucun envoi. */
function dernierEnvoi() {
  const appel = [...appelsBrevo].reverse().find((a) => a.url.includes('/smtp/email'));
  return appel ? JSON.parse(appel.body) : null;
}
function nombreEnvois() {
  return appelsBrevo.filter((a) => a.url.includes('/smtp/email')).length;
}

/* ══════════════════════════════════════════════════════════════════════════
   MODULES
   ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const definitions = await import('../backend/src/services/email/panelEmailTemplateDefinitions.js');
const scopes = await import('../backend/src/services/email/panelEmailTemplateScope.js');
const panelRegistry = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');
const globalSender = await import('../backend/src/services/email/panelGlobalSender.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } = await import('../backend/src/bridge/bridgeContract.js');
const { default: PanelEmailTemplate } = await import('../backend/src/models/PanelEmailTemplate.model.js');
const { default: PanelEmailTemplateVersion } = await import('../backend/src/models/PanelEmailTemplateVersion.model.js');
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');
const { default: Operation } = await import('../backend/src/models/PanelCapabilityOperation.model.js');

await PanelEmailTemplate.syncIndexes();
await PanelEmailTemplateVersion.syncIndexes();

await seedIntegratedApiCredentialSets();
await templates.seedPanelTemplates();
await users.resetUsers();
await users.seedFromEnv();

const { call, close } = await startServer(createApp());
const H = { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION };

const login = await call('POST', '/api/auth/login', {
  body: { email: process.env.SEED_DEV_EMAIL, password: process.env.SEED_DEV_PASSWORD },
});
const DEV = { authorization: `Bearer ${login.json?.data?.token}` };

await globalSender.updateGlobalSender(
  { senderEmail: 'support@ly-solution.fr', senderName: 'L.Y Solution' }, ACTEUR,
);
await controlPlane.saveCredentialSet('BREVO', 'TEST', {
  values: { apiKey: CLE_PANEL, baseUrl: BREVO_BASE },
}, ACTEUR);
await controlPlane.validateCredentialSet('BREVO', 'TEST', { actor: ACTEUR });

/* ── DEUX PROJETS RÉELS, APPAIRÉS PAR LA VRAIE ROUTE ────────────────────────
 *
 * Ni fiche fabriquée, ni jeton inventé : la garde d'isolation qu'on éprouve
 * repose ENTIÈREMENT sur le jeton de pont, et un jeton fabriqué à la main
 * éprouverait un chemin que la production n'a pas.
 */
async function appairer(projectKey, projectName) {
  const declared = await registry.declareProject({
    publicBackendUrl: `https://${projectKey}.test`,
    projectName,
  });
  const paired = await call('POST', '/bridge/v1/pairings', {
    headers: H,
    body: {
      contractVersion: CONTRACT_VERSION,
      projectKey,
      projectName,
      environment: 'TEST',
      softwareVersion: '1.0.0',
      publicBackendUrl: `https://${projectKey}.test`,
      pairingCode: declared.pairingCode,
    },
  });
  return {
    projectId: declared.record.projectId,
    projectName,
    token: paired.json?.data?.bridgeToken ?? null,
    auth: { ...H, authorization: `Bearer ${paired.json?.data?.bridgeToken}` },
  };
}

const A = await appairer('sb-auto-06', 'SB Auto 06');
const B = await appairer('garage-b', 'Garage B');
const SCOPE_A = scopes.projectScope(A.projectId);
const SCOPE_B = scopes.projectScope(B.projectId);
const PANEL = scopes.panelScope();

/** Query de portée, telle que l'écran DEV la produit. */
const q = (scope) => (scope.scopeType === 'PANEL' ? '' : `?scope=PROJECT&projectId=${scope.scopeId}`);

/* ══════════════════════════════════════════════════════════════════════════
   1 · PARITÉ DES REGISTRES — le contrôle que l'audit réclamait « immédiatement ».
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Aucun modèle consommé par un projet ne peut être inconnu du Panel');
{
  /**
   * ══ CE QUE CETTE SECTION VÉRIFIAIT, ET POURQUOI ELLE NE LE PEUT PLUS ══════
   *
   * Elle comparait DEUX registres de variables — 11 codes côté Panel, 6 côté
   * projet — deux copies manuelles qu'aucune garde ne tenait ensemble. Le
   * registre du Panel s'annonçait lui-même comme un déplacement d'autorité dont
   * l'exemplaire d'origine « partira le jour où l'envoi projet sera retiré ».
   *
   * CE JOUR EST VENU. Le lot L12.1 a supprimé le registre du projet : le Panel
   * est la seule autorité d'édition, le projet n'a plus de base de modèles, et
   * son validateur a cessé d'énumérer les codes — précisément pour ne pas
   * recopier le registre du Panel, « la duplication même que le lot supprime ».
   *
   * Le contrôle cherchait donc un fichier retiré exprès, et rougissait sur une
   * absence qui est la RÉUSSITE d'un lot antérieur. Un test qui punit la
   * correction qu'il réclamait ne défend plus rien.
   *
   * ══ CE QUI RESTE VRAI, ET QUI EST LE VRAI SUJET ═══════════════════════════
   *
   * Le projet ne déclare plus quels modèles EXISTENT — il déclare ceux qu'il
   * CONSOMME (`projectEmailTemplateUsage.js`). Et un code consommé qu'aucun
   * Panel ne connaîtrait produirait un `PANEL_EMAIL_TEMPLATE_UNKNOWN` au
   * premier événement métier réel, c'est-à-dire chez un destinataire.
   *
   * C'est cette relation-là qui doit tenir, et c'est celle qu'on éprouve.
   *
   * ══ POURQUOI ON LIT LE FICHIER, ET PAS UN IMPORT ══════════════════════════
   *
   * Le projet vit dans un AUTRE dépôt : l'importer lierait la suite du Panel à
   * l'arborescence d'un client. On le lit s'il est là, et l'on DÉCLARE le
   * contrôle non exécuté s'il ne l'est pas — plutôt que de le déclarer vert,
   * ce qui reste le seul résultat inacceptable.
   */
  const ici = path.dirname(fileURLToPath(import.meta.url));
  const cheminUsage = path.resolve(
    ici, '../../SB Auto 06/backend/src/utils/projectEmailTemplateUsage.js',
  );

  if (!fs.existsSync(cheminUsage)) {
    check('⚠ déclaration d’usage projet absente — parité NON VÉRIFIÉE (et non « verte »)', false);
  } else {
    const projet = await import(`file://${cheminUsage.replace(/\\/g, '/')}`);
    const consommes = projet.CONSUMED_TEMPLATE_CODES ?? [];

    check(`le projet déclare ce qu’il consomme (${consommes.length} codes)`,
      Array.isArray(consommes) && consommes.length > 0);

    /**
     * ══ PAS DE NOMBRE EN DUR ═════════════════════════════════════════════
     *
     * Un « === 6 » rougirait à chaque modèle légitimement branché, et la
     * correction réflexe serait d'incrémenter le chiffre — ce qui ne vérifie
     * plus rien. Ce qui doit être vrai, c'est la RELATION : tout ce que le
     * projet consomme, le Panel le connaît. Elle ne se périme pas.
     */
    const inconnus = consommes.filter((code) => !panelRegistry.isKnownTemplateId(code));
    check(`aucun modèle consommé n’est inconnu du Panel (${inconnus.join(', ') || 'aucun'})`,
      inconnus.length === 0);

    /**
     * Et chaque code consommé a un CONTRAT DE VARIABLES chez le Panel. Un code
     * connu sans contrat s'enverrait avec un corps vide — la panne la plus
     * discrète de la chaîne.
     */
    const sansContrat = consommes.filter((code) => {
      const v = panelRegistry.variablesFor(code);
      return !Array.isArray(v) || v.length === 0;
    });
    check(`chaque modèle consommé porte un contrat de variables (${sansContrat.join(', ') || 'tous'})`,
      sansContrat.length === 0);

    /**
     * L'AUTRE SENS N'EST PLUS UNE ERREUR. Le Panel connaît plus de codes que ce
     * projet n'en consomme — il en sert plusieurs. Un code du Panel qu'aucun
     * projet n'appelle n'est pas un défaut : c'est un modèle disponible.
     */
    check('le Panel peut connaître plus de modèles que ce projet n’en consomme',
      panelRegistry.EMAIL_TEMPLATE_IDS.length >= consommes.length);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   2 · LA CLASSIFICATION — établie par les APPELANTS, jamais par les noms.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · Chaque code déclare qui possède sa communication');
{
  const problemes = definitions.validateOwnershipClassification();
  check(`la classification est complète et cohérente (${problemes.join(' | ') || 'aucun problème'})`,
    problemes.length === 0);

  /**
   * L'INVARIANT PORTE SUR LES CODES VIVANTS, et il n'est pas affaibli.
   *
   * Un code RETIRÉ — conservé pour la lisibilité des envois passés, plus appelé
   * par personne — n'a légitimement aucun appelant. C'est un état DÉCLARÉ, que
   * le validateur exige de justifier et qui interdit le provisionnement ; ce
   * n'est pas une échappatoire, et la ligne suivante le vérifie.
   */
  const classification = definitions.describeOwnership();
  check('chaque classification VIVANTE cite ses appelants RÉELS',
    classification.filter((row) => !row.retired).every((row) => row.callers.length > 0));
  check('un code retiré ne cite aucun appelant, et n’est plus provisionné',
    classification.filter((row) => row.retired)
      .every((row) => row.callers.length === 0 && row.provisionForProjects === false));

  const reset = definitions.templateDefinition('PASSWORD_RESET_REQUEST');
  check('PASSWORD_RESET_REQUEST vit dans DEUX portées — c’est le cœur du lot',
    reset.scopes.includes('PANEL') && reset.scopes.includes('PROJECT'));

  /**
   * LE CAS D'ÉCOLE DU §16 : l'événement vient d'un projet, les variables aussi,
   * et le modèle reste PANEL — parce que l'émetteur et le destinataire de la
   * communication sont L.Y Solution. L'ownership suit la COMMUNICATION, jamais
   * l'origine des variables.
   */
  const devNotif = definitions.templateDefinition('CONTRACT_CANCELLATION_DEV_NOTIFICATION');
  check('une notification technique alimentée par un projet reste PANEL',
    devNotif.scopes.length === 1 && devNotif.scopes[0] === 'PANEL');

  const facture = definitions.templateDefinition('PAYMENT_REQUEST_CREATED');
  check('la facturation de L.Y Solution n’a PAS d’instance projet',
    !facture.scopes.includes('PROJECT'));

  const contact = definitions.templateDefinition('CONTACT_ADMIN_NOTIFICATION');
  check('une notification de contact appartient au PROJET seul',
    contact.scopes.length === 1 && contact.scopes[0] === 'PROJECT');
}

/* ══════════════════════════════════════════════════════════════════════════
   3 · LA PORTÉE NE S'INJECTE PAS — la faille P1 de l'audit, refermée.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Le corps d’une requête ne choisit JAMAIS la portée');
{
  /**
   * ══ CE QUI ÉTAIT POSSIBLE ═════════════════════════════════════════════════
   *
   *   PUT /api/email-templates/PASSWORD_RESET_REQUEST
   *   { "projectId": "sb-auto", "html": "…" }
   *
   * créait une ligne de portée projet que l'éditeur ne montrait JAMAIS (il
   * lisait toujours la plateforme), que l'historique ne montrait jamais, que la
   * restauration ne pouvait jamais annuler — et que le runtime servait à ce
   * projet, en priorité, indéfiniment.
   */
  const injecte = await call('PUT', '/api/email-templates/PASSWORD_RESET_REQUEST', {
    headers: DEV,
    body: { projectId: A.projectId, subject: 'Injecté {{company.name}}' },
  });
  check('un projectId dans le CORPS fait échouer l’appel — il n’est pas ignoré',
    injecte.status === 400 && injecte.json?.code === 'PANEL_EMAIL_TEMPLATE_SCOPE_IN_BODY');
  check('…et le message NOMME le champ fautif',
    String(injecte.json?.message ?? '').includes('projectId'));

  for (const champ of ['scopeId', 'scopeType', 'projectKey', 'project_id']) {
    const essai = await call('PUT', '/api/email-templates/PASSWORD_RESET_REQUEST', {
      headers: DEV,
      body: { [champ]: A.projectId, subject: 'x' },
    });
    check(`« ${champ} » est refusé lui aussi`,
      essai.status === 400 && essai.json?.code === 'PANEL_EMAIL_TEMPLATE_SCOPE_IN_BODY');
  }

  check('AUCUN document fantôme n’a été créé',
    (await PanelEmailTemplate.countDocuments({ scopeType: 'PROJECT' })) === 0);

  /**
   * UNE PORTÉE VALIDE MAIS INEXISTANTE EST REFUSÉE. Sans cette garde, un DEV
   * créerait `PROJECT/typo` : un document servi à personne, invisible de tout
   * écran filtré par projet — la ligne fantôme, déplacée d'un cran.
   */
  const inconnu = await call('GET', '/api/email-templates?scope=PROJECT&projectId=nexiste-pas', {
    headers: DEV,
  });
  check('une portée qui désigne un projet inconnu est REFUSÉE',
    inconnu.status === 404 && inconnu.json?.code === 'PANEL_EMAIL_TEMPLATE_SCOPE_PROJECT_UNKNOWN');

  const portéeInvalide = await call('GET', '/api/email-templates?scope=TENANT', { headers: DEV });
  check('une portée inventée est refusée',
    portéeInvalide.status === 400 && portéeInvalide.json?.code === 'PANEL_EMAIL_TEMPLATE_SCOPE_INVALID');
}

/* ══════════════════════════════════════════════════════════════════════════
   4 · MÊME CODE, TROIS PORTÉES, TROIS CONTENUS — la recette du §25.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Un même code porte trois documents indépendants');
{
  const CODE = 'PASSWORD_RESET_REQUEST';

  // Le Panel écrit à SES exploitants.
  const panelActuel = await call('GET', `/api/email-templates/${CODE}`, { headers: DEV });
  await call('PUT', `/api/email-templates/${CODE}`, {
    headers: DEV,
    body: {
      subject: 'PANEL — réinitialisation {{company.name}}',
      expectedVersion: panelActuel.json.data.version,
    },
  });

  // Chaque projet écrit aux SIENS. La portée voyage en QUERY, jamais en corps.
  for (const [projet, texte] of [[A, 'SB AUTO'], [B, 'GARAGE B']]) {
    const scope = scopes.projectScope(projet.projectId);
    const avant = await call('GET', `/api/email-templates/${CODE}${q(scope)}`, { headers: DEV });
    check(`${texte} n’a AUCUNE instance au départ`, avant.json?.data?.configured === false);

    const ecrit = await call('PUT', `/api/email-templates/${CODE}${q(scope)}`, {
      headers: DEV,
      body: {
        subject: `${texte} — votre mot de passe {{company.name}}`,
        html: avant.json.data.html.replace('Réinitialisation du mot de passe', `Bienvenue chez ${texte}`),
        expectedVersion: avant.json.data.version,
      },
    });
    check(`${texte} a désormais SON instance`,
      ecrit.status === 200 && ecrit.json?.data?.configured === true
      && ecrit.json?.data?.scope?.scopeId === projet.projectId);
  }

  const documents = await PanelEmailTemplate.find({ templateCode: CODE }).lean();
  check('TROIS documents Mongo, jamais un seul partagé', documents.length === 3);
  check('…tous d’identité distincte',
    new Set(documents.map((d) => String(d._id))).size === 3);
  check('…et trois sujets distincts',
    new Set(documents.map((d) => d.subject)).size === 3);

  const resolus = await Promise.all([
    templates.resolveTemplate(CODE, PANEL),
    templates.resolveTemplate(CODE, SCOPE_A),
    templates.resolveTemplate(CODE, SCOPE_B),
  ]);
  check('le résolveur rend le bon document à chaque portée',
    resolus[0].subject.startsWith('PANEL —')
    && resolus[1].subject.startsWith('SB AUTO —')
    && resolus[2].subject.startsWith('GARAGE B —'));
  check('…et chaque résolution NOMME sa portée',
    resolus[0].source === 'PANEL' && resolus[1].source === 'PROJECT'
    && resolus[1].scopeId === A.projectId && resolus[2].scopeId === B.projectId);

  /**
   * ÉDITER LE MODÈLE DU PANEL NE TOUCHE PLUS PERSONNE. C'était l'inverse :
   * « un DEV qui édite ce modèle réécrit simultanément l'e-mail de tous les
   * clients du parc, présents et à venir ».
   */
  const versionPanel = (await call('GET', `/api/email-templates/${CODE}`, { headers: DEV })).json.data.version;
  await call('PUT', `/api/email-templates/${CODE}`, {
    headers: DEV,
    body: { subject: 'PANEL — texte réécrit {{company.name}}', expectedVersion: versionPanel },
  });
  const apresA = await templates.resolveTemplate(CODE, SCOPE_A);
  check('réécrire le modèle du PANEL ne change RIEN chez un client',
    apresA.subject.startsWith('SB AUTO —'));
}

/* ══════════════════════════════════════════════════════════════════════════
   5 · L'ENVOI RÉEL — c'est le corps posté à Brevo qui tranche.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Trois envois, trois contenus, un seul expéditeur');
{
  const variables = {
    'company.name': 'Client Démo',
    'user.name': 'Jean Dupont',
    'auth.resetUrl': 'https://exemple.test/reset?t=abc',
    'auth.expiresMinutes': '60',
  };

  /** Demande l'envoi comme un projet le fait : par le pont, sous SON jeton. */
  async function envoyerDepuisProjet(projet) {
    return call('POST', '/bridge/v1/capabilities/email.send_template/invoke', {
      headers: projet.auth,
      body: {
        templateRef: 'PASSWORD_RESET_REQUEST',
        recipient: { email: 'client@exemple.test' },
        variables,
        operationId: `op-${crypto.randomUUID()}`,
      },
    });
  }

  const envoiA = await envoyerDepuisProjet(A);
  check('l’envoi de A est accepté', envoiA.status === 200 && envoiA.json?.data?.result?.status === 'ACCEPTED');
  const corpsA = dernierEnvoi();
  check('LE CORPS POSTÉ À BREVO PORTE LE TEXTE DE A',
    corpsA.subject.startsWith('SB AUTO —') && String(corpsA.htmlContent).includes('SB AUTO'));

  const envoiB = await envoyerDepuisProjet(B);
  check('l’envoi de B est accepté', envoiB.status === 200);
  const corpsB = dernierEnvoi();
  check('LE CORPS POSTÉ À BREVO PORTE LE TEXTE DE B',
    corpsB.subject.startsWith('GARAGE B —') && String(corpsB.htmlContent).includes('GARAGE B'));

  check('DEUX CLIENTS, DEUX E-MAILS RÉELLEMENT DIFFÉRENTS',
    corpsA.subject !== corpsB.subject && corpsA.htmlContent !== corpsB.htmlContent);

  /**
   * ══ L'EXPÉDITEUR RESTE GLOBAL — §18, non négociable ═══════════════════════
   *
   * Le contenu est scopé ; l'identité d'expédition ne l'est pas. Le `From` est
   * aussi l'adresse de SUPPORT — celle qu'on surveille et qu'on authentifie
   * SPF/DKIM. Dispersée en N copies, elle ne serait plus administrable.
   */
  check('MÊME EXPÉDITEUR GLOBAL pour les deux clients',
    corpsA.sender.email === 'support@ly-solution.fr'
    && corpsB.sender.email === 'support@ly-solution.fr');
  check('…avec la clé Brevo DU PANEL, jamais celle d’un projet',
    appelsBrevo.at(-1).apiKey === CLE_PANEL);
  check('aucun templateId Brevo — le contenu reste dans NOS versions',
    !corpsA.templateId && !corpsB.templateId);

  /**
   * ══ L'OBSERVABILITÉ — §13 et §14 ═════════════════════════════════════════
   *
   * L'audit : « le journal n'enregistre ni version, ni portée, ni source du
   * modèle rendu — impossible de dire *a posteriori* quel document est parti ».
   */
  const opA = await Operation.findOne({ projectId: A.projectId }).sort({ startedAt: -1 }).lean();
  check('l’opération journalise la PORTÉE réellement servie',
    opA?.templateScope === 'PROJECT' && opA?.templateScopeId === A.projectId);
  check('…et la VERSION réellement rendue', Number.isInteger(opA?.templateVersion) && opA.templateVersion >= 1);
  check('…et le code, comme avant', opA?.templateCode === 'PASSWORD_RESET_REQUEST');

  check('la réponse rendue au projet porte la même vérité',
    envoiA.json.data.result.templateScope === 'PROJECT'
    && envoiA.json.data.result.templateScopeId === A.projectId
    && Number.isInteger(envoiA.json.data.result.templateVersion));
}

/* ══════════════════════════════════════════════════════════════════════════
   6 · FAIL-CLOSED — l'absence d'un contenu est un REFUS, jamais un emprunt.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Un projet sans instance N’ENVOIE PAS');
{
  const C = await appairer('projet-c', 'Projet C');
  const avant = nombreEnvois();

  const refus = await call('POST', '/bridge/v1/capabilities/email.send_template/invoke', {
    headers: C.auth,
    body: {
      templateRef: 'PASSWORD_RESET_REQUEST',
      recipient: { email: 'client@projet-c.test' },
      variables: {
        'company.name': 'Projet C',
        'user.name': 'Jean',
        'auth.resetUrl': 'https://projet-c.test/reset?t=x',
        'auth.expiresMinutes': '60',
      },
      operationId: `op-${crypto.randomUUID()}`,
    },
  });

  check('l’envoi est REFUSÉ', refus.status >= 400);
  check('…et le refus dit « pas configuré », pas « Brevo indisponible »',
    String(refus.json?.message ?? '').includes('configuré'));
  check('ZÉRO appel Brevo — rien n’est parti, même partiellement',
    nombreEnvois() === avant);

  /**
   * LA PREUVE QUE LE REPLI EST BIEN MORT : le modèle PANEL du même code existe,
   * il est valide, il est actif. L'ancien système l'aurait servi. Le nouveau
   * refuse, et c'est exactement pour cela qu'il refuse.
   */
  const panelExiste = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', PANEL);
  check('…alors que le modèle PANEL du même code existe et est actif',
    panelExiste.configured === true && panelExiste.enabled === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   7 · ISOLATION — un projet n'atteint que SA portée, et rien d'autre.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Aucun projet ne lit, n’écrit ni ne restaure chez un autre');
{
  /**
   * La garantie n'est pas déclarative : il n'existe AUCUN paramètre par lequel
   * un projet pourrait désigner une autre portée. Sa portée est construite à
   * partir du `projectId` que son jeton a prouvé. On éprouve donc ce que le
   * jeton DONNE, plutôt qu'un refus qu'on aurait codé.
   */
  const sienA = await call('GET', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST', { headers: A.auth });
  check('A lit SON modèle', sienA.status === 200 && sienA.json?.data?.subject.startsWith('SB AUTO —'));
  check('…et sa portée est bien la sienne', sienA.json?.data?.scope?.scopeId === A.projectId);

  const memeUrlDepuisB = await call('GET', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST', { headers: B.auth });
  check('LA MÊME URL, sous le jeton de B, rend le modèle DE B',
    memeUrlDepuisB.json?.data?.subject.startsWith('GARAGE B —')
    && memeUrlDepuisB.json?.data?.scope?.scopeId === B.projectId);

  /**
   * ══ UN PROJET N'ÉCRIT PLUS DU TOUT — c'est plus fort qu'un refus ══════════
   *
   * Ce bloc éprouvait deux refus d'ÉCRITURE : « écrire depuis A ne touche rien
   * chez B », puis « nommer une autre portée dans le corps est refusé ». Les
   * deux supposaient qu'un projet PUISSE écrire, et qu'on borne ce qu'il écrit.
   *
   * Le lot L12.1 a retiré cette possibilité : le Panel est la seule autorité
   * d'édition, le projet n'a plus de base de modèles, et le verbe a disparu du
   * pont. Le test réclamait donc un `400` bien élevé à une route qui répond
   * `404` — et il rougissait sur la version la PLUS sûre du produit.
   *
   * On éprouve ce qui est vrai : la porte n'existe pas. Une portée qu'on ne
   * peut pas forcer parce qu'aucune écriture n'est offerte est mieux gardée
   * qu'une portée validée à l'entrée.
   */
  const ecritureA = await call('PUT', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST', {
    headers: A.auth,
    body: { subject: 'SB AUTO — réécrit par le projet {{company.name}}' },
  });
  check('un projet ne dispose d’AUCUNE écriture sur les modèles',
    ecritureA.status === 404);

  const force = await call('PUT', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST', {
    headers: A.auth,
    body: { projectId: B.projectId, subject: 'Tentative' },
  });
  check('…y compris en nommant une autre portée dans le corps', force.status === 404);

  const bIntact = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', SCOPE_B);
  check('rien n’a bougé chez B', bIntact.subject.startsWith('GARAGE B —'));
  const panelIntact = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', PANEL);
  check('…ni chez le PANEL', panelIntact.subject.startsWith('PANEL —'));
  const aIntact = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', SCOPE_A);
  check('…ni même chez A, qui a pourtant émis la requête',
    aIntact.subject.startsWith('SB AUTO —') && !aIntact.subject.includes('réécrit par le projet'));

  /**
   * ══ UN CODE DU PANEL RESTE INUTILISABLE DEPUIS UN PROJET ═════════════════
   *
   * Le refus n'est plus un `400` : la lecture répond `200` en DÉCRIVANT
   * pourquoi le modèle n'est pas utilisable dans cette portée. C'est le bon
   * choix pour un catalogue — un écran qui liste des modèles a besoin d'une
   * raison affichable, pas d'une exception — et ce qui compte est inchangé :
   * le code n'est ni utilisable, ni listé.
   */
  const codePanel = await call('GET', '/bridge/v1/email-templates/PAYMENT_REQUEST_CREATED', { headers: A.auth });
  check('un code PANEL lu depuis un projet est déclaré INUTILISABLE',
    codePanel.json?.data?.usable === false);
  check('…et la raison nomme la portée, pas une panne',
    String(codePanel.json?.data?.unusableReason ?? '').includes('SCOPE'));
  check('…aucun contenu du Panel ne fuit au passage',
    !codePanel.json?.data?.subject && !codePanel.json?.data?.html);

  const catalogueA = await call('GET', '/bridge/v1/email-templates', { headers: A.auth });
  check('le catalogue d’un projet ne contient QUE des codes qui lui appartiennent',
    catalogueA.json.data.every((t) => t.scopes.includes('PROJECT'))
    && !catalogueA.json.data.some((t) => t.templateId === 'PAYMENT_REQUEST_CREATED'));
  check('…et chaque ligne porte SA portée',
    catalogueA.json.data.every((t) => t.scope.scopeId === A.projectId));

  /**
   * ══ HISTORIQUE ET RESTAURATION — HORS DE PORTÉE D'UN PROJET ══════════════
   *
   * Ces deux verbes accompagnaient l'écriture, et ils sont partis avec elle
   * (L12.1). Restaurer une version, c'est écrire ; un projet qui ne peut pas
   * écrire ne peut pas non plus revenir en arrière.
   *
   * Le contrôle qui suivait — « une restauration chez A ne touche ni B ni le
   * PANEL » — supposait la restauration possible. Ce qu'il protégeait reste
   * protégé, et plus simplement : la route n'existe pas.
   *
   * L'ISOLEMENT PHYSIQUE DES HISTORIQUES, lui, garde tout son sens et se
   * vérifie juste en dessous, en base — c'est là qu'il vit.
   */
  const versionsA = await call('GET', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST/versions', { headers: A.auth });
  check('un projet ne lit pas l’historique par le pont', versionsA.status === 404);

  const avantB = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', SCOPE_B);
  const restaure = await call('POST', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST/versions/1/restore', {
    headers: A.auth,
  });
  check('…et ne restaure aucune version', restaure.status === 404);
  const apresB = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', SCOPE_B);
  const apresPanel = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', PANEL);
  check('la tentative n’a touché NI B NI le PANEL',
    apresB.version === avantB.version && apresB.subject === avantB.subject
    && apresPanel.subject.startsWith('PANEL —'));

  /**
   * L'HISTORIQUE EST PHYSIQUEMENT SÉPARÉ. Sans la portée dans la clé, deux
   * documents homonymes porteraient des versions de même numéro, et une
   * restauration serait une loterie.
   */
  const vA = await PanelEmailTemplateVersion.countDocuments({
    templateCode: 'PASSWORD_RESET_REQUEST', scopeType: 'PROJECT', projectId: A.projectId,
  });
  const vB = await PanelEmailTemplateVersion.countDocuments({
    templateCode: 'PASSWORD_RESET_REQUEST', scopeType: 'PROJECT', projectId: B.projectId,
  });
  const vP = await PanelEmailTemplateVersion.countDocuments({
    templateCode: 'PASSWORD_RESET_REQUEST', scopeType: 'PANEL',
  });
  check('trois historiques distincts, aucun mélange', vA >= 1 && vB >= 1 && vP >= 1);

  // Le Panel DEV, lui, administre TOUT le parc — c'est son rôle de dépannage.
  const devChezB = await call(`GET`, `/api/email-templates/PASSWORD_RESET_REQUEST${q(SCOPE_B)}`, { headers: DEV });
  check('le Panel DEV administre la portée de N’IMPORTE quel projet',
    devChezB.status === 200 && devChezB.json.data.subject.startsWith('GARAGE B —'));
  const portees = await call('GET', '/api/email-templates/scopes', { headers: DEV });
  check('…et le serveur lui énumère les portées, sans qu’il les invente',
    portees.json.data.some((s) => s.scopeType === 'PANEL')
    && portees.json.data.some((s) => s.scopeId === A.projectId)
    && portees.json.data.some((s) => s.scopeId === B.projectId));
}

/* ══════════════════════════════════════════════════════════════════════════
   8 · APERÇU = RUNTIME — le bug « aperçu correct, e-mail différent » est mort.
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · L’aperçu rend le MÊME document que l’envoi');
{
  const apercu = await call('POST', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST/preview', {
    headers: A.auth,
    body: {},
  });
  check('l’aperçu du projet est rendu', apercu.status === 200 && typeof apercu.json.data.html === 'string');
  check('…dans SA portée', apercu.json.data.scope.scopeId === A.projectId);

  const rendu = await templates.renderForSend({
    templateCode: 'PASSWORD_RESET_REQUEST',
    scope: SCOPE_A,
    variables: Object.fromEntries(panelRegistry.sampleVariablesFor('PASSWORD_RESET_REQUEST')),
  });
  check('APERÇU ET ENVOI produisent le MÊME sujet et le MÊME HTML',
    apercu.json.data.subject === rendu.subject && apercu.json.data.html === rendu.html);
  check('…et la même version', apercu.json.data.version === rendu.version);
}

/* ══════════════════════════════════════════════════════════════════════════
   9 · RÉSILIATION — templates conservés, envois bloqués.
   ══════════════════════════════════════════════════════════════════════════ */
section('9 · Résilier un projet coupe ses envois sans détruire son contenu');
{
  /**
   * ══ CE QUE CE CONTRÔLE GARDE, ET CE QU'IL N'INVENTE PAS ═══════════════════
   *
   * Le lot demandait un état de cycle de vie lisible par la passerelle. La
   * passerelle a été SIMPLIFIÉE entre-temps : octrois et ouverture commerciale
   * en ont été retirés, délibérément. Le seul verrou d'exécution restant est
   * donc l'APPAIRAGE — et il suffit : un projet résilié voit son appairage
   * révoqué, et un jeton révoqué n'ouvre plus rien.
   *
   * Ce qui compte pour CE lot est ailleurs, et c'est ce qu'on prouve : la
   * révocation ne touche AUCUN document de contenu. Ni celui du projet, ni
   * ceux du Panel, ni ceux des autres clients.
   */
  const avantDocs = await PanelEmailTemplate.countDocuments({ projectId: B.projectId });
  const avantVersions = await PanelEmailTemplateVersion.countDocuments({ projectId: B.projectId });
  const avantEnvois = nombreEnvois();

  await PanelProject.updateOne(
    { projectId: B.projectId },
    { $set: { 'pairing.status': 'REVOKED', 'pairing.revokedAt': new Date().toISOString() } },
  );

  const bloque = await call('POST', '/bridge/v1/capabilities/email.send_template/invoke', {
    headers: B.auth,
    body: {
      templateRef: 'PASSWORD_RESET_REQUEST',
      recipient: { email: 'client@garage-b.test' },
      variables: {
        'company.name': 'Garage B', 'user.name': 'Jean',
        'auth.resetUrl': 'https://garage-b.test/r?t=1', 'auth.expiresMinutes': '60',
      },
      operationId: `op-${crypto.randomUUID()}`,
    },
  });
  check('un projet dont l’appairage est révoqué N’ENVOIE PLUS', bloque.status >= 400);
  check('…et aucun appel Brevo n’a eu lieu', nombreEnvois() === avantEnvois);

  check('SES MODÈLES SONT CONSERVÉS, à l’octet près',
    (await PanelEmailTemplate.countDocuments({ projectId: B.projectId })) === avantDocs);
  check('…son historique aussi',
    (await PanelEmailTemplateVersion.countDocuments({ projectId: B.projectId })) === avantVersions);

  const survivant = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', SCOPE_B);
  check('…et son contenu est intact', survivant.subject.startsWith('GARAGE B —'));

  // Les modèles du Panel et des AUTRES clients ne bougent pas d'un octet.
  const panelApres = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', PANEL);
  const aApres = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', SCOPE_A);
  check('résilier B ne touche NI PANEL/* NI PROJECT/A/*',
    panelApres.subject.startsWith('PANEL —') && aApres.scopeId === A.projectId);

  // RÉACTIVATION — le projet retrouve SES modèles, pas ceux du moment.
  await PanelProject.updateOne(
    { projectId: B.projectId },
    { $set: { 'pairing.status': 'PAIRED' } },
  );
  const reactive = await call('GET', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST', { headers: B.auth });
  check('réactivé, le projet retrouve SON contenu — pas celui du Panel',
    reactive.status === 200 && reactive.json.data.subject.startsWith('GARAGE B —'));
}

/* ══════════════════════════════════════════════════════════════════════════
   10 · DUPLICATION — deux projets issus de la même recette ne partagent rien.
   ══════════════════════════════════════════════════════════════════════════ */
section('10 · Un projet dupliqué obtient SES PROPRES documents');
{
  /**
   * L'audit : « A, B et tous les suivants lisent le MÊME document Mongo […] la
   * duplication est le scénario qui rendra le problème visible le plus vite :
   * deux garages issus de la même recette enverront le mot de passe oublié avec
   * le même texte, et le second client remarquera. »
   *
   * On éprouve la POSE d'instances pour un nouveau projet — le geste que la
   * duplication doit appeler — et l'on vérifie qu'aucun document n'est partagé.
   */
  const D = await appairer('garage-d', 'Garage D');
  const SCOPE_D = scopes.projectScope(D.projectId);

  const pose = await templates.provisionProjectTemplates(D.projectId, { actor: ACTEUR });
  check('la pose crée les instances du nouveau projet', pose.created.length > 0);
  check('…et refuse les codes qui ne lui appartiennent pas',
    !pose.created.includes('PAYMENT_REQUEST_CREATED'));

  const docsD = await PanelEmailTemplate.find({ projectId: D.projectId }).lean();
  const docsA = await PanelEmailTemplate.find({ projectId: A.projectId }).lean();
  const idsPartages = docsD.filter((d) => docsA.some((a) => String(a._id) === String(d._id)));
  check('AUCUN document n’est partagé entre deux projets', idsPartages.length === 0);
  check('…chacun repart d’une version 1 propre', docsD.every((d) => d.version === 1));

  // Une pose rejouée n'écrase RIEN — sinon une migration relancée détruirait
  // le travail fait entre-temps.
  await templates.saveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_D,
    { subject: 'Garage D — contact {{contact.name}}' }, ACTEUR);
  const rejoue = await templates.provisionProjectTemplates(D.projectId, { actor: ACTEUR });
  check('rejouer la pose ne crée rien', rejoue.created.length === 0);
  const apresRejeu = await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', SCOPE_D);
  check('…et n’écrase AUCUN contenu écrit entre-temps',
    apresRejeu.subject === 'Garage D — contact {{contact.name}}');

  /**
   * ══ L'IMPORT ÉTAIT UNE MIGRATION, ET UNE MIGRATION SE TERMINE ════════════
   *
   * `POST /bridge/v1/email-templates/import` servait à rapatrier, une fois, le
   * HTML rédigé dans un projet avant que le Panel ne devienne l'autorité
   * d'édition (§5.1). Le parc migré, la route a été retirée avec l'écriture
   * projet (L12.1) — et c'est cohérent : garder ouvert un verbe d'écriture
   * pour un besoin qui n'existe plus, c'est garder une porte pour personne.
   *
   * Le test l'appelait encore et lisait `.created` sur une réponse `404`. On
   * éprouve donc ce qui est vrai aujourd'hui : la porte est fermée, et un
   * projet fraîchement dupliqué obtient malgré tout SES propres documents —
   * ce qui est le sujet de cette section.
   */
  const E = await appairer('garage-e', 'Garage E');
  const importe = await call('POST', '/bridge/v1/email-templates/import', {
    headers: E.auth,
    body: { templates: [{ templateCode: 'CONTACT_ADMIN_NOTIFICATION', subject: 'Tentative' }] },
  });
  check('le chemin d’import du parc est refermé', importe.status === 404);

  /**
   * ET LE PROJET NEUF NE SE SERT PAS AILLEURS.
   *
   * Sans catalogue posé, il n'a AUCUN contenu — et la résolution le dit au lieu
   * de retomber sur celui du Panel. C'est l'invariant qui compte : le vide d'un
   * projet reste le vide d'un projet, il n'est jamais comblé par le voisin.
   */
  let refusE = null;
  try {
    await templates.resolveTemplate('CONTACT_ADMIN_NOTIFICATION', scopes.projectScope(E.projectId));
  } catch (e) { refusE = e; }
  check('un projet sans catalogue posé n’a AUCUN contenu', refusE !== null);
  check('…et le refus dit pourquoi, sans emprunter celui du Panel',
    String(refusE?.message ?? '').includes('jamais remplacé par celui du Panel'));

  const catalogueE = await call('GET', '/bridge/v1/email-templates', { headers: E.auth });
  check('…son catalogue ne porte que SA portée',
    catalogueE.json.data.every((t) => t.scope.scopeId === E.projectId));
  check('…sans aucun code réservé au Panel',
    !catalogueE.json.data.some((t) => t.templateId === 'PAYMENT_REQUEST_CREATED'));
}

/* ══════════════════════════════════════════════════════════════════════════
   11 · LE PANEL RESTE LE PLAN DE CONTRÔLE — aucun secret ne descend.
   ══════════════════════════════════════════════════════════════════════════ */
section('11 · Aucun projet ne voit une clé, un secret ni une portée voisine');
{
  const tout = JSON.stringify([
    (await call('GET', '/bridge/v1/email-templates', { headers: A.auth })).json,
    (await call('GET', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST', { headers: A.auth })).json,
    (await call('GET', '/bridge/v1/email-templates/PASSWORD_RESET_REQUEST/readiness', { headers: A.auth })).json,
  ]);

  check('aucune clé Brevo ne traverse le pont', !tout.includes('xkeysib'));
  check('aucune URL de fournisseur non plus', !tout.includes(BREVO_BASE));
  check('aucune portée d’un autre projet ne fuite', !tout.includes(B.projectId));

  /**
   * LE MODÈLE DE CONTENU NE PORTE AUCUN DESTINATAIRE, ET N'EN PORTERA JAMAIS.
   * L'écrire dans un template le rendrait modifiable depuis une interface web,
   * et figerait dans du contenu ce qui est une décision métier.
   */
  const champs = Object.keys(PanelEmailTemplate.schema.paths);
  for (const interdit of ['recipient', 'recipientEmail', 'to', 'fromEmail', 'senderEmail', 'apiKey']) {
    check(`le modèle de contenu ne porte pas « ${interdit} »`, !champs.includes(interdit));
  }
  check('…mais il porte une PORTÉE déclarée', champs.includes('scopeType'));
}

await close();
fauxBrevo.close();
await stopMemoryMongo();
finish();
