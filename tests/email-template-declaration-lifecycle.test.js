/* LA DÉCLARATION VIVANTE — le projet dit ce qu'il utilise, le Panel s'y conforme.
 *
 * ══ CE QUE CE LOT RENVERSE ══════════════════════════════════════════════════
 *
 * Le lot précédent posait, sur CHAQUE projet, TOUS les codes marqués
 * `provisionForProjects`. Il réparait un vrai défaut — plus aucun projet n'avait
 * d'instance — mais en décidant à la place des projets. Un projet qui envoie
 * deux e-mails s'en voyait attribuer dix, et l'écran d'administration montrait
 * huit modèles que personne n'enverrait jamais.
 *
 * Désormais :
 *
 *     le projet DÉCLARE  →  le pont TRANSPORTE  →  le Panel SE CONFORME
 *
 * Cette suite éprouve les six moments qui font ou défont cette doctrine :
 *
 *   1. un projet déclare      → ses modèles apparaissent, et EUX SEULS ;
 *   2. un projet dupliqué     → servi par le seul fait d'être appairé ;
 *   3. un sous-ensemble       → deux projets, deux besoins, deux catalogues ;
 *   4. un retrait             → disparaît de l'actif, l'historique SURVIT ;
 *   5. une réintroduction     → la personnalisation revient INTACTE ;
 *   6. un code inconnu        → rapporté, sans faire échouer les autres.
 *
 * Panel en mémoire, aucun réseau. Runner autonome.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const editor = await import('../backend/src/services/email/panelEmailTemplateEditor.service.js');
const definitions = await import('../backend/src/services/email/panelEmailTemplateDefinitions.js');
const registry = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');
const scopes = await import('../backend/src/services/email/panelEmailTemplateScope.js');
const projectors = await import('../backend/src/services/sync/projectors.js');
const projectRegistry = await import('../backend/src/services/registry/projectRegistry.service.js');
const { default: PanelEmailTemplate } = await import('../backend/src/models/PanelEmailTemplate.model.js');
const { default: PanelEmailTemplateVersion } = await import('../backend/src/models/PanelEmailTemplateVersion.model.js');
const { PanelProjectEmailTemplateUsage } = await import('../backend/src/models/PanelProjectProjection.model.js');

const ACTEUR = { userId: 'u-test', userEmail: 'recette@panel.test' };

/** Les codes de portée PROJECT réellement disponibles pour ces scénarios. */
const PROJET_CODES = registry.EMAIL_TEMPLATE_IDS
  .filter((c) => definitions.templateDefinition(c).scopes.includes('PROJECT'));
const [A, B, C, D] = PROJET_CODES;

const PANEL_ONLY = registry.EMAIL_TEMPLATE_IDS
  .filter((c) => !definitions.templateDefinition(c).scopes.includes('PROJECT'));

async function creerProjet(projectKey, projectName) {
  const declared = await projectRegistry.declareProject({
    publicBackendUrl: `https://${projectKey}.test`,
    projectName,
    environment: 'TEST',
  });
  return declared.record.projectId;
}

let horloge = Date.now();

/**
 * LE PROJET DÉCLARE — par le VRAI chemin : le projecteur du pont.
 *
 * On n'appelle pas la réconciliation à la main : c'est précisément ce que la
 * doctrine interdit. Ce que le test pousse est ce que le pont remet, avec la
 * même forme d'écriture — `writeId`, `modifiedAt`, payload.
 */
async function declarer(projectId, templateCodes, { revision = null } = {}) {
  horloge += 1000;
  const codes = [...templateCodes].sort();
  await projectors.PROJECTORS.PROJECT_EMAIL_TEMPLATE_USAGE({
    projectId,
    change: {
      entityType: 'PROJECT_EMAIL_TEMPLATE_USAGE',
      entityId: `usage-${projectId}`,
      modifiedAt: new Date(horloge).toISOString(),
      payload: {
        templateCodes: codes,
        revision: revision ?? codes.join('|'),
        declaredAt: new Date(horloge).toISOString(),
        softwareVersion: 'test',
      },
    },
    stamp: { sourceEnvironment: 'TEST', sourceGeneration: 'g1', sourceSoftwareVersion: 'test', receivedAt: new Date(horloge).toISOString() },
  });
  return PanelProjectEmailTemplateUsage.findOne({ projectId }).lean();
}

const instancesDe = (projectId) => PanelEmailTemplate
  .find(scopes.scopeFilter(scopes.projectScope(projectId)))
  .select('templateCode version enabled subject').lean();

const actifsDe = async (projectId) => {
  const items = await editor.listEditableTemplates(scopes.projectScope(projectId));
  return items.filter((t) => t.declared === true).map((t) => t.templateId).sort();
};

// ═══════════════════════════════════════════════════════════════════════════
section('1 · Un projet déclare — et n’obtient QUE ce qu’il déclare');
const SB = await creerProjet('sb-auto-like', 'SB Auto (simulé)');
{
  check('avant toute déclaration, aucune instance', (await instancesDe(SB)).length === 0);

  const refusAvant = await templates
    .renderForSend({ templateCode: A, scope: scopes.projectScope(SB), variables: {} })
    .then(() => null).catch((e) => e);
  check('avant déclaration, l’envoi est refusé', Boolean(refusAvant));

  const decl = await declarer(SB, [A, B, C]);
  check('la déclaration est persistée', decl?.templateCodes?.length === 3);

  const posees = (await instancesDe(SB)).map((t) => t.templateCode).sort();
  check('§16 les 3 modèles déclarés sont provisionnés — et eux seuls',
    posees.join(',') === [A, B, C].sort().join(','));
  check('§26 aucun modèle non déclaré n’a été posé', posees.length === 3);

  check('la réconciliation est rapportée sur la déclaration',
    decl.lastReconciliation?.provisioned?.length === 3
    && decl.lastReconciliation.unknown.length === 0);

  const resolu = await templates.resolveTemplate(A, scopes.projectScope(SB));
  check('le modèle déclaré résout une instance PROJECT', resolu.configured === true);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · §12 — redéclarer la MÊME chose ne produit rien');
{
  const avant = await PanelEmailTemplateVersion
    .countDocuments(scopes.scopeFilter(scopes.projectScope(SB)));

  const decl = await declarer(SB, [A, B, C]); // même liste ⇒ même révision
  const apres = await PanelEmailTemplateVersion
    .countDocuments(scopes.scopeFilter(scopes.projectScope(SB)));

  check('§12 aucune version supplémentaire', apres === avant);
  check('§12 la déclaration reste à 3 codes', decl.templateCodes.length === 3);
  check('§12 les instances sont intactes', (await instancesDe(SB)).length === 3);
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · §26 — un projet au besoin PLUS PETIT n’hérite de rien');
const LITE = await creerProjet('project-lite', 'ProjectLite');
{
  await declarer(LITE, [A, B]);
  const posees = (await instancesDe(LITE)).map((t) => t.templateCode).sort();
  check('ProjectLite n’a QUE ses 2 modèles', posees.join(',') === [A, B].sort().join(','));
  check('ProjectLite n’a pas hérité des 3 de SB Auto', !posees.includes(C));
  check('SB Auto garde les siens', (await instancesDe(SB)).length === 3);
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · §63 — MRClean83 : dupliqué, appairé, servi sans un geste');
{
  /**
   * Le scénario complet du lot : un projet issu d'une duplication, qui n'a
   * jamais été touché par personne, et dont le SEUL acte est de déclarer ce que
   * son code utilise — exactement la même liste que son modèle d'origine.
   */
  const MRCLEAN = await creerProjet('mrclean83', 'MRClean83');
  check('à la création, MRClean83 n’a aucune instance', (await instancesDe(MRCLEAN)).length === 0);

  const usageSbAuto = [A, B, C];
  const decl = await declarer(MRCLEAN, usageSbAuto);

  const posees = (await instancesDe(MRCLEAN)).map((t) => t.templateCode).sort();
  check('§63 MRClean83 obtient les mêmes modèles que son modèle d’origine',
    posees.join(',') === [...usageSbAuto].sort().join(','));
  check('§63 provisionnements manuels = 0 (aucun appel direct dans ce scénario)',
    decl.lastReconciliation.provisioned.length === usageSbAuto.length);

  /** §49 — le premier e-mail, dans le même cycle de vie. */
  const premier = await templates
    .renderForSend({ templateCode: A, scope: scopes.projectScope(MRCLEAN), variables: registry.sampleVariablesFor(A) })
    .then((r) => r).catch((e) => e);
  check('§49 le PREMIER e-mail après appairage se rend', Boolean(premier?.subject));

  await PanelEmailTemplate.deleteMany(scopes.scopeFilter(scopes.projectScope(MRCLEAN)));
  await PanelEmailTemplateVersion.deleteMany(scopes.scopeFilter(scopes.projectScope(MRCLEAN)));
  await PanelProjectEmailTemplateUsage.deleteOne({ projectId: MRCLEAN });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · §64 — RETRAIT LIVE : C disparaît de l’actif, son contenu SURVIT');
{
  /** On personnalise C avant de le retirer : c'est ce qui rend le test utile. */
  const pose = await templates.resolveTemplate(C, scopes.projectScope(SB));
  await templates.saveTemplate(C, scopes.projectScope(SB), {
    subject: `PERSONNALISÉ — ${pose.subject}`,
    html: pose.html.replace('</body>', '<p>Texte du client, à ne jamais perdre.</p></body>'),
  }, ACTEUR);
  const avantRetrait = await templates.resolveTemplate(C, scopes.projectScope(SB));
  check('C est personnalisé (v2)', avantRetrait.version === 2);

  const actifsAvant = await actifsDe(SB);
  check('§64 avant retrait, 3 modèles actifs', actifsAvant.length === 3 && actifsAvant.includes(C));

  const decl = await declarer(SB, [A, B]);

  const actifsApres = await actifsDe(SB);
  check('§64 après retrait, 2 modèles actifs', actifsApres.length === 2);
  check('§2 C ne figure plus dans la vue active', !actifsApres.includes(C));
  /**
   * ── LE RETRAIT EST DÉSORMAIS UN ACTE, PLUS UN CONSTAT (L12.1) ─────────────
   *
   * Ce champ s'appelait `removed`, et il ne retirait rien : la réconciliation
   * se contentait de RECENSER les instances hors déclaration. Elles restaient
   * actives, éditables dans le Panel, et présentées comme si elles partaient
   * encore — le parc de TEST en portait deux, silencieusement, depuis des
   * semaines.
   *
   * Il s'appelle `archived` parce qu'il archive. Le nom décrit maintenant ce
   * qui a lieu, et les trois contrôles qui suivent le vérifient : l'instance
   * sort de l'actif, sa raison est écrite, son contenu survit.
   */
  check('§13 le retrait est un ARCHIVAGE, et il est rapporté',
    decl.lastReconciliation.archived.includes(C));

  /** ── LA PROPRIÉTÉ CENTRALE : RIEN N'A ÉTÉ DÉTRUIT ────────────────────── */
  const instanceC = await PanelEmailTemplate
    .findOne({ templateCode: C, ...scopes.scopeFilter(scopes.projectScope(SB)) }).lean();
  check('§3 l’instance de C existe TOUJOURS en base', Boolean(instanceC));
  check('§3 elle porte une DATE d’archivage', typeof instanceC.archivedAt === 'string' && instanceC.archivedAt.length > 0);
  check('§3 elle porte la RAISON de son archivage',
    /ne déclare plus/i.test(instanceC.archivedReason ?? ''));
  check('§3 sa personnalisation est intacte', instanceC.version === 2
    && instanceC.html.includes('Texte du client, à ne jamais perdre.'));
  const versionsC = await PanelEmailTemplateVersion
    .countDocuments({ templateCode: C, ...scopes.scopeFilter(scopes.projectScope(SB)) });
  check('§3 son historique est intact', versionsC === 2);

  /** §30 — et l'envoi de C est désormais REFUSÉ, avec un code qui l'explique. */
  const refus = await templates
    .renderForSend({ templateCode: C, scope: scopes.projectScope(SB), variables: {} })
    .then(() => null).catch((e) => e);
  check('§30 envoyer un modèle non déclaré est refusé',
    refus?.code === templates.EMAIL_TEMPLATE_NOT_DECLARED);

  /**
   * ══ ET LA CAPACITÉ DOIT DIRE LA MÊME CHOSE QUE LE SERVICE ═════════════════
   *
   * Ce contrôle s'arrêtait au service. C'était insuffisant, et le produit l'a
   * prouvé : faute d'être nommé dans la traduction des refus, le code retombait
   * en `CAPABILITY_INPUT_INVALID` — « entrée non conforme au contrat ». Un
   * appelant lisait donc qu'il avait mal appelé, alors que son appel était
   * juste et que la cause était ailleurs : ce projet ne déclare plus ce modèle.
   *
   * Le service peut avoir raison et la capacité mentir : ce sont deux
   * traductions, et seule la seconde sort du Panel.
   */
  const { translatePreparation } = await import('../backend/src/services/capabilities/brevoSendAdapter.js');
  const vuDuProjet = translatePreparation(refus, { code: 'email.send_template' });
  check('§30 la CAPACITÉ refuse pour indisponibilité, jamais pour entrée invalide',
    vuDuProjet.code === 'CAPABILITY_NOT_AVAILABLE');
  check('§30 …et elle nomme la déclaration comme cause',
    vuDuProjet.details?.reason === templates.EMAIL_TEMPLATE_NOT_DECLARED);
  check('§30 …en disant où cela se corrige : dans le projet',
    /déclarée par le projet/i.test(vuDuProjet.message));

  /** …mais l'édition reste possible : on doit pouvoir relire et corriger. */
  const relecture = await editor.getEditableTemplate(C, scopes.projectScope(SB));
  check('§21 le contenu retiré reste consultable dans l’éditeur',
    relecture.subject.startsWith('PERSONNALISÉ — '));
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · §19/§47 — RÉINTRODUCTION : C revient avec sa personnalisation');
{
  await declarer(SB, [A, B, C]);

  const actifs = await actifsDe(SB);
  check('§19 C est de nouveau actif', actifs.includes(C) && actifs.length === 3);

  const revenu = await templates.resolveTemplate(C, scopes.projectScope(SB));
  check('§47 MÊME version (v2), aucune réinitialisation', revenu.version === 2);
  check('§47 MÊME contenu personnalisé',
    revenu.html.includes('Texte du client, à ne jamais perdre.'));

  const doublons = await PanelEmailTemplate
    .countDocuments({ templateCode: C, ...scopes.scopeFilter(scopes.projectScope(SB)) });
  check('§19 aucune seconde instance créée', doublons === 1);

  const renvoi = await templates
    .renderForSend({ templateCode: C, scope: scopes.projectScope(SB), variables: registry.sampleVariablesFor(C) })
    .then((r) => r).catch((e) => e);
  check('§30 l’envoi de C est de nouveau autorisé', Boolean(renvoi?.subject));
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · §13/§22 — un code INCONNU ne fait pas échouer les autres');
{
  const decl = await declarer(SB, [A, B, C, 'UN_CODE_QUI_NEXISTE_PAS']);

  check('§13 les codes valides sont acceptés', decl.lastReconciliation.unknown.length === 1);
  check('§13 l’inconnu est nommé', decl.lastReconciliation.unknown[0] === 'UN_CODE_QUI_NEXISTE_PAS');
  check('§13 les 3 valides restent en place', (await instancesDe(SB)).length === 3);
  check('§22 l’anomalie est observable depuis la déclaration',
    (await PanelProjectEmailTemplateUsage.findOne({ projectId: SB }).lean())
      .lastReconciliation.unknown.length === 1);

  await declarer(SB, [A, B, C]); // on remet l'état propre
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · §8 — un modèle de la PLATEFORME n’est jamais provisionné');
{
  if (!PANEL_ONLY.length) {
    check('⚠ aucun code PANEL-only — cas non exerçable', false);
  } else {
    const decl = await declarer(SB, [A, B, C, PANEL_ONLY[0]]);
    check('§8 le code PANEL est REFUSÉ, et nommé',
      decl.lastReconciliation.forbidden.includes(PANEL_ONLY[0]));
    check('§8 aucune instance PROJECT n’a été créée pour lui',
      (await PanelEmailTemplate.countDocuments({ templateCode: PANEL_ONLY[0], scopeType: 'PROJECT' })) === 0);
    check('§8 les autres codes ne sont pas affectés', (await instancesDe(SB)).length === 3);
    await declarer(SB, [A, B, C]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('9 · §48 — un redémarrage du Panel ne change rien');
{
  const avant = {
    sb: (await instancesDe(SB)).length,
    lite: (await instancesDe(LITE)).length,
    actifsSb: await actifsDe(SB),
  };

  const rapport = await templates.reconcileProjectTemplates({ actor: ACTEUR });
  check('§33 le filet de démarrage ne lit QUE les déclarations', rapport.projects === 2);
  check('§48 il ne pose rien quand rien ne manque', rapport.created === 0);
  check('§48 les instances sont inchangées',
    (await instancesDe(SB)).length === avant.sb && (await instancesDe(LITE)).length === avant.lite);
  check('§48 les actifs sont inchangés',
    (await actifsDe(SB)).join(',') === avant.actifsSb.join(','));

  /** Et il RÉPARE une instance disparue, sans que le projet ait à redéclarer. */
  await PanelEmailTemplate.deleteOne({ templateCode: B, ...scopes.scopeFilter(scopes.projectScope(SB)) });
  const reparation = await templates.reconcileProjectTemplates({ actor: ACTEUR });
  check('§33 une instance disparue est reposée par le filet', reparation.created === 1);
  check('§33 …et la personnalisation de C n’a pas bougé',
    (await templates.resolveTemplate(C, scopes.projectScope(SB))).version === 2);
}

// ═══════════════════════════════════════════════════════════════════════════
section('10 · §58 — un projet SANS déclaration n’a aucun modèle actif');
{
  const MUET = await creerProjet('projet-muet', 'Projet muet');
  check('aucune instance', (await instancesDe(MUET)).length === 0);

  const items = await editor.listEditableTemplates(scopes.projectScope(MUET));
  check('§58 aucune déclaration ⇒ `declared` vaut null (pas false)',
    items.every((t) => t.declared === null));

  const portees = await editor.listAdministrableScopes();
  const entree = portees.find((p) => p.scopeId === MUET);
  check('§22 le sélecteur distingue « jamais déclaré » de « zéro modèle »',
    entree.declaration === null);

  const entreeSb = portees.find((p) => p.scopeId === SB);
  check('§20 le sélecteur porte le nombre de modèles utilisés',
    entreeSb.declaration?.count === 3);
}

// ═══════════════════════════════════════════════════════════════════════════
section('11 · §25 — aucun couplage entre duplication et modèles d’e-mail');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const ici = path.dirname(url.fileURLToPath(import.meta.url));
  const moteur = path.resolve(ici, '../backend/src/duplication-engine');

  const fichiers = [];
  const parcourir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (e.name.endsWith('.js')) fichiers.push(p);
    }
  };
  parcourir(moteur);

  const coupables = fichiers.filter((f) => {
    const code = fs.readFileSync(f, 'utf8');
    return /provisionProjectTemplates|reconcileDeclaredProjectEmailTemplates|PanelEmailTemplate\b/.test(code);
  });
  check(`§25 le moteur de duplication n’appelle aucune primitive de modèle (${fichiers.length} fichier(s) lus)`,
    coupables.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('12 · §61 — le PROTOCOLE existe, et documente ce qui compte');
{
  /**
   * ══ POURQUOI UNE GARDE DOCUMENTAIRE, ET POURQUOI CELLE-CI ════════════════
   *
   * Une doctrine que le code applique mais qu'aucun document n'énonce se perd
   * au premier lot suivant : le prochain lecteur voit une réconciliation au
   * démarrage et en conclut que le Panel décide — exactement l'inverse.
   *
   * On ne vérifie donc PAS une tournure de phrase (fragile, et cela
   * transformerait la doc en champ de mines). On vérifie que les QUESTIONS
   * auxquelles un exploitant doit pouvoir répondre sont traitées : chacune est
   * cherchée par plusieurs formulations, et une seule suffit.
   */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const ici = path.dirname(url.fileURLToPath(import.meta.url));
  const protocole = path.resolve(ici, '../docs/PROTOCOL.md');

  const present = fs.existsSync(protocole);
  check('§34 le PROTOCOL du Panel existe', present);

  const doc = present ? fs.readFileSync(protocole, 'utf8') : '';
  const sujets = [
    ['§35 les autorités sont nommées', [/autorit/i]],
    ['§36 la procédure d’appairage est écrite', [/appairer un projet/i, /pairing/i]],
    ['§37 le protocole du NOUVEAU modèle est écrit', [/nouveau mod[eè]le/i]],
    ['§37 la règle de redéploiement du Panel est explicite', [/red[ée]ploiement du panel/i, /REDÉPLOIEMENT PANEL REQUIS/i]],
    ['§38 « aucun redéploiement » pour un modèle existant', [/aucun red[ée]ploiement/i]],
    ['§39 le retrait d’un modèle est documenté', [/retirer un mod[eè]le/i]],
    ['§40 la duplication est documentée comme muette', [/dupliquer un projet/i]],
    ['§35 le démarrage est documenté', [/## d[ée]marrage/i]],
    ['§35 les migrations sont documentées', [/## migrations/i]],
    ['§35 le cleanup des recettes est documenté', [/cleanup/i]],
    ['§35 les gardes PROD sont documentées', [/gardes prod/i]],
  ];
  for (const [nom, motifs] of sujets) {
    check(nom, motifs.some((m) => m.test(doc)));
  }

  /** La phrase qui porte tout le lot doit être trouvable, sous une forme ou une autre. */
  check('§62 la doctrine « le projet déclare, le Panel ne devine pas » est écrite',
    /le projet le d[ée]clare/i.test(doc) && /devine/i.test(doc));
}

// ═══════════════════════════════════════════════════════════════════════════
section('10 · `enabled` et `declared` sont ORTHOGONAUX — et on ne les confond pas');
{
  /**
   * ══ LE PIÈGE QUE CETTE SECTION FERME ═══════════════════════════════════════
   *
   * Deux drapeaux vivent sur un modèle de projet, et ils ne répondent pas à la
   * même question :
   *
   *     enabled    l'INTERRUPTEUR D'ENVOI — « cet e-mail part-il ? »
   *     declared   L'APPARTENANCE À L'USAGE — « le projet le demande-t-il ? »
   *
   * Compter la vue active sur `enabled` donne un nombre juste par accident,
   * tant que personne n'a coupé un envoi ni retiré un code. Le jour où les deux
   * divergent, on lit un état pour un autre — et l'on conclut à une dérive de
   * déclaration là où il n'y a qu'un contenu conservé.
   *
   * C'est exactement l'erreur qui a produit un « 10 modèles actifs » là où le
   * système en déclarait 9 : le dixième était une instance HISTORIQUE,
   * délibérément conservée, et son `enabled` valait `true` parce que personne
   * n'avait eu de raison de l'éteindre.
   *
   * La vue active se lit sur `declared`, et sur rien d'autre.
   */
  const PROJ = await creerProjet('orthogonalite', 'Projet Orthogonalité');
  await declarer(PROJ, [A, B]);

  // Un modèle DÉCLARÉ mais dont l'envoi est COUPÉ reste ACTIF à la vue.
  await PanelEmailTemplate.updateOne(
    { templateCode: A, projectId: PROJ },
    { $set: { enabled: false } },
  );
  const actifs = await actifsDe(PROJ);
  check('un modèle déclaré dont l’ENVOI est coupé reste dans la vue ACTIVE',
    actifs.includes(A) && actifs.length === 2);

  // Un modèle RETIRÉ de la déclaration sort de l'actif, `enabled` inchangé.
  await declarer(PROJ, [B]);
  const apres = await actifsDe(PROJ);
  const instances = await instancesDe(PROJ);
  const instanceA = instances.find((t) => t.templateCode === A);

  check('un modèle retiré de la déclaration SORT de la vue active',
    !apres.includes(A) && apres.length === 1);
  check('…alors que son instance est TOUJOURS là', Boolean(instanceA));
  check('…et que son interrupteur d’envoi n’a pas été touché',
    instanceA.enabled === false);

  /**
   * LE COMPTE QUI COMPTE. `instances >= actifs`, et l'écart est exactement
   * l'historique. Un test qui compterait les instances annoncerait une dérive
   * à chaque contenu conservé.
   */
  check('instances stockées ≥ modèles actifs, l’écart étant l’historique',
    instances.length === 2 && apres.length === 1);

  const vue = await editor.listEditableTemplates(scopes.projectScope(PROJ));
  const historiques = vue.filter((t) => t.declared === false && t.configured === true);
  check('l’écart est présenté comme « précédemment utilisé », jamais caché',
    historiques.length === 1 && historiques[0].templateId === A);
}

// ---------------------------------------------------------------------------
await stopMemoryMongo();
finish();
