/* LE CYCLE DE VIE DES INSTANCES DE MODÈLE — la garde qui manquait.
 *
 * ══ CE QUE CETTE SUITE EXISTE POUR EMPÊCHER ═════════════════════════════════
 *
 * L11.1 a livré une résolution fail-closed excellente et deux mécanismes de
 * pose — `backfillScopeTypes()` et `provisionProjectTemplates()` — puis n'a
 * branché NI l'un NI l'autre. Le résultat, mesuré en production TEST : onze
 * documents de contenu sans portée donc invisibles du résolveur, et zéro
 * instance PROJECT sur huit projets. Aucun projet du parc ne pouvait envoyer
 * un e-mail, et aucun test ne rougissait.
 *
 * Aucune des suites existantes ne pouvait le voir : chacune POSE elle-même ses
 * instances avant d'éprouver la résolution. Elles vérifiaient que la mécanique
 * fonctionne quand on l'actionne ; personne ne vérifiait qu'on l'actionne.
 *
 * C'est donc la question que cette suite pose, et la seule :
 *
 *     « un projet qui n'a rien demandé finit-il par avoir ses modèles ? »
 *
 * ══ LES QUATRE MOMENTS DE VIE COUVERTS ══════════════════════════════════════
 *
 *   1. base héritée      — documents sans portée : retrouvés après backfill ;
 *   2. projet existant   — instances manquantes : posées par réconciliation ;
 *   3. projet NOUVEAU    — créé après coup : servi par le même passage ;
 *   4. modèle NOUVEAU    — ajouté au registre demain : atteint tout le parc.
 *
 * Le 4 est le plus important : c'est celui qui dit que le défaut ne reviendra
 * pas au prochain modèle ajouté.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const definitions = await import('../backend/src/services/email/panelEmailTemplateDefinitions.js');
const registry = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');
const scopes = await import('../backend/src/services/email/panelEmailTemplateScope.js');
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');
const projectRegistry = await import('../backend/src/services/registry/projectRegistry.service.js');
const { default: PanelEmailTemplate } = await import('../backend/src/models/PanelEmailTemplate.model.js');
const { default: PanelEmailTemplateVersion } = await import('../backend/src/models/PanelEmailTemplateVersion.model.js');

const ACTEUR = { userId: 'u-test', userEmail: 'recette@panel.test' };
const CODES = definitions.codesToProvisionForProjects();

/**
 * UN PROJET CRÉÉ PAR LE CHEMIN OFFICIEL — `declareProject`, comme le Panel.
 *
 * Fabriquer la fiche à la main aurait éprouvé une forme que la production ne
 * produit pas : c'est précisément ce genre de raccourci qui laisse passer un
 * défaut de cycle de vie.
 */
async function creerProjet(projectKey, projectName) {
  const declared = await projectRegistry.declareProject({
    publicBackendUrl: `https://${projectKey}.test`,
    projectName,
    environment: 'TEST',
  });
  return declared.record.projectId;
}

const instancesDe = (projectId) => PanelEmailTemplate
  .find(scopes.scopeFilter(scopes.projectScope(projectId))).select('templateCode version enabled subject').lean();

// ═══════════════════════════════════════════════════════════════════════════
section('0 · Le registre déclare bien des modèles à poser sur les projets');
{
  check('au moins un code est marqué provisionForProjects', CODES.length > 0);
  check('tous ces codes acceptent la portée PROJECT',
    CODES.every((code) => definitions.templateDefinition(code).scopes.includes('PROJECT')));

  /**
   * L'INVERSE, ET IL EST AUSSI IMPORTANT : un code que le registre veut poser
   * mais que la portée PROJECT refuse produirait une réconciliation qui refuse
   * une ligne à chaque démarrage, indéfiniment.
   */
  const incoherents = registry.EMAIL_TEMPLATE_IDS.filter((code) => {
    const d = definitions.templateDefinition(code);
    return d.provisionForProjects && !d.scopes.includes('PROJECT');
  });
  check(`aucun code « à poser » interdit en portée PROJECT (${incoherents.join(', ') || 'aucun'})`,
    incoherents.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('1 · Une base héritée : les documents sans portée redeviennent visibles');
{
  /**
   * On reproduit EXACTEMENT la forme trouvée en production : un document écrit
   * avant L11.1, donc `projectId: null` et AUCUN `scopeType`. On passe par le
   * pilote : Mongoose appliquerait son défaut de schéma et effacerait le cas
   * qu'on veut éprouver.
   */
  const at = new Date().toISOString();
  await PanelEmailTemplate.collection.insertOne({
    templateCode: 'PASSWORD_RESET_REQUEST',
    projectId: null,
    name: 'Hérité', description: '', subject: 'Sujet hérité {{company.name}}',
    html: '<html><body><p>Contenu écrit à la main {{company.name}}</p></body></html>',
    enabled: true, version: 4, updatedBy: 'humain', createdAt: at, updatedAt: at,
  });

  const avant = await PanelEmailTemplate
    .countDocuments(scopes.scopeFilter(scopes.panelScope()));
  check('AVANT backfill : le document hérité est INVISIBLE du filtre de portée', avant === 0);

  const resoluAvant = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', scopes.panelScope());
  check('AVANT backfill : la résolution retombe sur le défaut du registre',
    resoluAvant.source === templates.TEMPLATE_SOURCES.REGISTRY_DEFAULT && resoluAvant.configured === false);

  const rapport = await templates.backfillScopeTypes();
  check('le backfill pose la portée PANEL sur le document hérité', rapport.templates.panel === 1);

  const resoluApres = await templates.resolveTemplate('PASSWORD_RESET_REQUEST', scopes.panelScope());
  check('APRÈS backfill : le contenu ÉCRIT PAR L’HUMAIN est enfin servi',
    resoluApres.source === templates.TEMPLATE_SOURCES.PANEL
    && resoluApres.subject === 'Sujet hérité {{company.name}}'
    && resoluApres.version === 4);

  const rejeu = await templates.backfillScopeTypes();
  check('le backfill est idempotent (un second passage ne touche rien)',
    rejeu.templates.panel === 0 && rejeu.templates.project === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · L’amorçage PANEL ne peut plus heurter l’index unique');
{
  /**
   * LE SYMPTÔME EXACT DE LA PRODUCTION : sans portée, `seedPanelTemplates()`
   * ne retrouvait pas le document hérité, tentait de le créer, et heurtait
   * `uniq_template_project`. L'échec partait dans un `catch` au démarrage.
   * Le backfill ayant tourné juste avant, la pose redevient un no-op.
   */
  let echec = null;
  const rapport = await templates.seedPanelTemplates().catch((err) => { echec = err; return null; });
  check('l’amorçage PANEL ne lève plus de doublon', echec === null && rapport !== null);
  check('le document hérité est reconnu comme déjà posé, pas recréé',
    (await PanelEmailTemplate.countDocuments({ templateCode: 'PASSWORD_RESET_REQUEST' })) === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · La POSE elle-même : ce que provisionProjectTemplates garantit');
const PROJET_A = await creerProjet('projet-a-existant', 'Projet A');
const PROJET_B = await creerProjet('projet-b-existant', 'Projet B');
{
  /**
   * ══ CE QUE CETTE SECTION GARDE, ET CE QU'ELLE NE GARDE PLUS ═════════════
   *
   * Elle gardait « tous les projets reçoivent tous les modèles ». Ce n'est plus
   * la doctrine : c'est le PROJET qui déclare ce qu'il utilise, et
   * `email-template-declaration-lifecycle.test.js` garde cette règle-là.
   *
   * Reste ici la PRIMITIVE de pose, qui n'a pas changé et sur laquelle tout le
   * reste repose : poser ce qui manque, ne jamais réécrire, ne jamais dupliquer.
   */
  check('AVANT pose : le projet n’a AUCUNE instance', (await instancesDe(PROJET_A)).length === 0);

  const envoiImpossible = await templates
    .resolveTemplate(CODES[0], scopes.projectScope(PROJET_A))
    .then(() => null)
    .catch((err) => err);
  check('AVANT pose : tout envoi de ce projet est REFUSÉ',
    envoiImpossible?.code === templates.EMAIL_TEMPLATE_NOT_CONFIGURED);

  const pose = await templates.provisionProjectTemplates(PROJET_A, { codes: CODES, actor: ACTEUR });
  check('la pose crée exactement les codes demandés', pose.created.length === CODES.length);
  check('…et n’en refuse aucun', pose.refused.length === 0);

  const posees = await instancesDe(PROJET_A);
  check(`le projet possède les ${CODES.length} modèle(s) posé(s)`, posees.length === CODES.length);
  check('chaque instance naît en version 1', posees.every((t) => t.version === 1));

  const versions = await PanelEmailTemplateVersion
    .countDocuments(scopes.scopeFilter(scopes.projectScope(PROJET_A)));
  check('chaque instance posée ouvre son historique de versions', versions === CODES.length);

  const resolu = await templates.resolveTemplate(CODES[0], scopes.projectScope(PROJET_A));
  check('APRÈS pose : la résolution du projet aboutit',
    resolu.configured === true && resolu.source === templates.TEMPLATE_SOURCES.PROJECT);

  /** Le second projet reste VIERGE : la pose ne déborde pas sur les voisins. */
  check('§26 un projet qui n’a rien demandé n’a rien reçu',
    (await instancesDe(PROJET_B)).length === 0);

  await templates.provisionProjectTemplates(PROJET_B, { codes: CODES, actor: ACTEUR });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · Aucune personnalisation n’est jamais écrasée');
{
  const code = CODES[0];
  const scope = scopes.projectScope(PROJET_A);

  /**
   * On PART du contenu posé et on le réécrit, plutôt que d'inventer un HTML :
   * le validateur exige que chaque variable obligatoire du contrat figure
   * dans le rendu, et un client qui personnalise part lui aussi de l'existant.
   */
  const pose = await templates.resolveTemplate(code, scope);
  const htmlPersonnalise = pose.html.replace(
    '</body>',
    '<p>Mention ajoutée par le client — ne doit jamais disparaître.</p></body>',
  );
  await templates.saveTemplate(code, scope, {
    subject: `PERSONNALISÉ — ${pose.subject}`,
    html: htmlPersonnalise,
  }, ACTEUR);

  const avant = await templates.resolveTemplate(code, scope);
  check('le contenu personnalisé est bien enregistré (version 2)',
    avant.version === 2 && avant.subject.startsWith('PERSONNALISÉ — ')
    && avant.html.includes('Mention ajoutée par le client'));

  await templates.reconcileProjectTemplates({ actor: ACTEUR });
  await templates.reconcileProjectTemplates({ actor: ACTEUR });

  const apres = await templates.resolveTemplate(code, scope);
  check('§20 après DEUX réconciliations : contenu INCHANGÉ',
    apres.subject === avant.subject && apres.html === avant.html);
  check('§20 après DEUX réconciliations : version INCHANGÉE', apres.version === avant.version);

  const doublons = await PanelEmailTemplate.countDocuments({ templateCode: code, ...scopes.scopeFilter(scope) });
  check('aucun doublon (projet, code)', doublons === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · Un modèle DÉSACTIVÉ à la main n’est jamais réactivé');
{
  const code = CODES[1] ?? CODES[0];
  const scope = scopes.projectScope(PROJET_B);
  await PanelEmailTemplate.updateOne(
    { templateCode: code, ...scopes.scopeFilter(scope) },
    { $set: { enabled: false } },
  );

  await templates.reconcileProjectTemplates({ actor: ACTEUR });

  const doc = await PanelEmailTemplate.findOne({ templateCode: code, ...scopes.scopeFilter(scope) }).lean();
  check('la réconciliation ne rallume pas un modèle éteint par un humain', doc.enabled === false);

  const refus = await templates.renderForSend({ templateCode: code, scope, variables: {} })
    .then(() => null).catch((err) => err);
  check('un modèle désactivé REFUSE l’envoi (jamais un silence)',
    refus !== null && String(refus.code ?? '').includes('DISABLED'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · Un projet NOUVEAU ne reçoit RIEN tant qu’il n’a rien demandé');
{
  const PROJET_C = await creerProjet('projet-c-nouveau', 'Projet C');
  check('à sa création, le projet n’a aucune instance', (await instancesDe(PROJET_C)).length === 0);

  /**
   * ══ LE CHANGEMENT DE DOCTRINE, ÉNONCÉ PAR UN TEST ═══════════════════════
   *
   * Le passage de démarrage ne parcourt plus le parc : il ne lit que les
   * DÉCLARATIONS. Un projet qui n'a jamais parlé n'est donc pas servi — et
   * c'est le comportement voulu : la plateforme ne décide plus de ce qu'un
   * projet utilise.
   */
  const rapport = await templates.reconcileProjectTemplates({ actor: ACTEUR });
  check('le filet de démarrage ne sert pas un projet sans déclaration',
    (await instancesDe(PROJET_C)).length === 0);
  check('…et ne lit aucune déclaration puisqu’il n’y en a aucune', rapport.projects === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · Une instance disparue est RESTAURÉE, jamais réinitialisée');
{
  /**
   * Le cas réel : suppression manuelle, restauration de base partielle. Son
   * HISTORIQUE, lui, survit — il n'est jamais effacé. Reposer au défaut du
   * registre effacerait un texte encore présent à côté.
   */
  // Un code À PART : la section 4 a déjà personnalisé CODES[0], et deux
  // sections qui se marchent dessus donneraient un test qui ment sur sa cause.
  const code = CODES[2] ?? CODES[1];
  const scope = scopes.projectScope(PROJET_A);

  const avant = await templates.resolveTemplate(code, scope);
  await templates.saveTemplate(code, scope, {
    subject: `ÉCRIT PAR UN HUMAIN — ${avant.subject}`,
    html: avant.html.replace('</body>', '<p>Phrase à ne pas perdre.</p></body>'),
  }, ACTEUR);
  const personnalise = await templates.resolveTemplate(code, scope);
  check('le contenu est personnalisé (v2)', personnalise.version === 2);

  await PanelEmailTemplate.deleteOne({ templateCode: code, ...scopes.scopeFilter(scope) });
  check('l’instance a bien disparu',
    (await PanelEmailTemplate.countDocuments({ templateCode: code, ...scopes.scopeFilter(scope) })) === 0);

  const repose = await templates.provisionProjectTemplates(PROJET_A, { codes: [code], actor: ACTEUR });
  check('la pose la recrée', repose.created.length === 1);

  const restaure = await templates.resolveTemplate(code, scope);
  check('§3 elle revient avec SON contenu, pas le défaut du registre',
    restaure.html.includes('Phrase à ne pas perdre.'));
  check('§3 …et à SA version, sans repartir de 1', restaure.version === 2);

  const versions = await PanelEmailTemplateVersion
    .countDocuments({ templateCode: code, ...scopes.scopeFilter(scope) });
  check('§3 aucune version en double n’a été écrite', versions === 2);
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · La portée PANEL n’est JAMAIS posée sur un projet');
{
  const panelSeul = registry.EMAIL_TEMPLATE_IDS
    .filter((code) => !definitions.templateDefinition(code).scopes.includes('PROJECT'));
  check(`des codes sont exclusivement PANEL (${panelSeul.length})`, panelSeul.length > 0);

  const fuites = await PanelEmailTemplate
    .countDocuments({ templateCode: { $in: panelSeul }, scopeType: 'PROJECT' });
  check('aucune instance PROJECT pour un code PANEL-only', fuites === 0);

  /** Et la tentative explicite est REFUSÉE, pas silencieusement ignorée. */
  const rapport = await templates.provisionProjectTemplates(PROJET_A, {
    codes: [panelSeul[0]], actor: ACTEUR,
  });
  check('poser un code PANEL sur un projet est REFUSÉ et nommé',
    rapport.created.length === 0
    && rapport.refused.length === 1
    && rapport.refused[0].code === scopes.SCOPE_ERROR_CODES.FORBIDDEN_FOR_CODE);
}

// ═══════════════════════════════════════════════════════════════════════════
section('9 · Après réconciliation, la base ne porte aucune ambiguïté');
{
  const sansPortee = await PanelEmailTemplate.countDocuments({ scopeType: { $exists: false } });
  check('§40 aucun modèle sans portée', sansPortee === 0);

  const versionsSansPortee = await PanelEmailTemplateVersion.countDocuments({ scopeType: { $exists: false } });
  check('§40 aucune version sans portée', versionsSansPortee === 0);

  const tous = await PanelEmailTemplate.find({}).select('templateCode scopeType projectId').lean();
  check('§40 aucun code inconnu du registre',
    tous.every((d) => registry.isKnownTemplateId(d.templateCode)));
  check('§40 portée cohérente partout (PANEL ⇔ projectId null)',
    tous.every((d) => (d.scopeType === 'PANEL') === (d.projectId === null)));

  const cles = tous.map((d) => `${d.scopeType}|${d.projectId}|${d.templateCode}`);
  check('§40 aucun doublon (portée, code)', new Set(cles).size === cles.length);

  const orphelines = await PanelEmailTemplateVersion.aggregate([
    { $group: { _id: { c: '$templateCode', p: '$projectId' } } },
  ]);
  const connues = new Set(tous.map((d) => `${d.templateCode}|${d.projectId}`));
  check('§40 aucune version orpheline',
    orphelines.every((o) => connues.has(`${o._id.c}|${o._id.p}`)));
}

// ---------------------------------------------------------------------------
await stopMemoryMongo();
finish();
