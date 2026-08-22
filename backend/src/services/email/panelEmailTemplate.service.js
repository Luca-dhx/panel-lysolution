// L'AUTORITÉ DE CONTENU DU PANEL — lire, écrire, rendre, PAR PORTÉE (L11.1).
//
// docs/email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md.
//
// ── CE QUI A CHANGÉ, ET POURQUOI C'EST LE CŒUR DU LOT ───────────────────────
//
// L'ancienne règle était un HÉRITAGE :
//
//     const stored = own ?? platform;      // ← supprimé
//
// Elle décrivait une intention défendable — « chaque projet hérite du défaut
// tant qu'il n'a rien réécrit » — et elle a produit l'inverse : comme aucune
// surface ne permettait de le rompre, l'héritage est devenu la valeur unique du
// parc. Tous les clients recevaient le même HTML, et éditer un modèle dans le
// Panel réécrivait l'e-mail de tout le monde.
//
// La règle est désormais une RÉSOLUTION STRICTE, une par portée :
//
//     PANEL   : (PANEL,  null,    code)   sinon défaut du registre, source dite
//     PROJECT : (PROJECT, projet, code)   sinon ÉCHEC — EMAIL_TEMPLATE_NOT_CONFIGURED
//
// Il n'existe AUCUN chemin par lequel une portée PROJECT lise un document
// PANEL. C'est le seul repli que ce module refuse absolument : envoyer sous le
// nom d'un client un texte écrit pour un autre est pire que ne pas envoyer.
//
// ── POURQUOI LE DÉFAUT DU REGISTRE SURVIT, MAIS SEULEMENT EN PORTÉE PANEL ───
//
// Une base vide au premier démarrage n'est pas une erreur de configuration :
// c'est un amorçage qui n'a pas encore tourné, et le contenu qu'il poserait est
// EXACTEMENT celui du registre. Le servir ne ment donc à personne, et évite de
// perdre un e-mail du Panel pour une migration en retard.
//
// En portée PROJECT le même geste mentirait : le défaut du registre est le
// contenu de L.Y Solution. Le servir à un projet reproduirait le repli qu'on
// vient de supprimer, sous un autre nom.
//
// ── LA PORTÉE EST UN ARGUMENT, JAMAIS UN CHAMP DU PATCH ─────────────────────
//
// `saveTemplate(code, scope, patch, actor)`. L'audit avait trouvé que
// `saveTemplate(code, { projectId, ...patch })` permettait à un corps de requête
// de choisir sa portée. Ce n'est plus une question de validation : la signature
// rend l'injection STRUCTURELLEMENT impossible — il n'y a pas de champ de portée
// dans le patch à déstructurer.
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelEmailTemplate from '../../models/PanelEmailTemplate.model.js';
import PanelEmailTemplateVersion from '../../models/PanelEmailTemplateVersion.model.js';
import PanelProject from '../../models/PanelProject.model.js';
import { PanelProjectEmailTemplateUsage } from '../../models/PanelProjectProjection.model.js';
import {
  EMAIL_TEMPLATE_IDS,
  getTemplateDefinition,
  isKnownTemplateId,
  sampleVariablesFor,
  variablesFor,
} from './panelEmailTemplateRegistry.js';
import {
  assertScopeAllowedForCode,
  codesToProvisionForProjects,
  templateDefinition,
} from './panelEmailTemplateDefinitions.js';
import {
  SCOPE_TYPES,
  assertScopeCoherent,
  describeScope,
  panelScope,
  projectScope,
  scopeColumns,
  scopeFilter,
} from './panelEmailTemplateScope.js';
import { variableContractFingerprint } from './panelEmailTemplateContract.js';
import { validateTemplate } from './panelEmailTemplateValidator.js';
import { renderTemplate, EmailRenderError } from './panelEmailTemplateRenderer.js';
import { EMAIL_TEMPLATE_ERROR_CODES as E, MAX_TEMPLATE_VERSION_HISTORY } from '../../utils/panelEmailTemplateConstants.js';

/** D'où vient le contenu résolu. Un exploitant doit pouvoir le lire. */
export const TEMPLATE_SOURCES = Object.freeze({
  /** Le document PANEL, écrit en base. */
  PANEL: 'PANEL',
  /** Le document du projet, écrit en base. */
  PROJECT: 'PROJECT',
  /** Le défaut du registre — base vide, portée PANEL uniquement. */
  REGISTRY_DEFAULT: 'REGISTRY_DEFAULT',
});

/**
 * LE REFUS QUI REMPLACE LE REPLI.
 *
 * Code STABLE : les écrans, le pont et les projets s'appuient dessus. Il dit
 * exactement ce qui s'est passé — « ce projet n'a pas d'instance pour ce
 * code » — et non « erreur d'envoi », qui enverrait chercher du côté de Brevo.
 */
export const EMAIL_TEMPLATE_NOT_CONFIGURED = 'EMAIL_TEMPLATE_NOT_CONFIGURED';

/**
 * LE PROJET N'A PAS DÉCLARÉ CE MODÈLE — refus distinct, et la distinction compte.
 *
 * `NOT_CONFIGURED` dit « rien n'a été posé » : la réparation est un
 * provisionnement. Celui-ci dit « ce projet affirme ne plus utiliser ce
 * message » : la réparation est dans le CODE DU PROJET, qui appelle encore un
 * chemin qu'il a cessé de déclarer. Les confondre enverrait chercher la panne du
 * mauvais côté — exactement ce que la doctrine des codes stables évite partout
 * ailleurs dans ce module.
 */
export const EMAIL_TEMPLATE_NOT_DECLARED = 'EMAIL_TEMPLATE_NOT_DECLARED_BY_PROJECT';

/* -------------------------------------------------------------------------- */
/*  CATALOGUE                                                                 */
/* -------------------------------------------------------------------------- */

export function assertKnownTemplate(templateCode) {
  if (!isKnownTemplateId(templateCode)) {
    throw ApiError.notFound(
      'PANEL_EMAIL_TEMPLATE_UNKNOWN',
      `Modèle inconnu : « ${templateCode} ». Le registre est code-first — il ne s’enrichit pas depuis la base.`,
    );
  }
  return getTemplateDefinition(templateCode);
}

/** Les codes canoniques. Aucun n'est un identifiant de modèle Brevo. */
export function listTemplateCodes() {
  return [...EMAIL_TEMPLATE_IDS];
}

/** Les codes dont une instance a le droit d'exister dans cette portée. */
export function listTemplateCodesForScope(scope) {
  assertScopeCoherent(scope);
  return EMAIL_TEMPLATE_IDS
    .filter((code) => templateDefinition(code).scopes.includes(scope.scopeType));
}

/** Les définitions du registre, dans l'ordre STABLE — celui des écrans. */
function registryDefinitions() {
  return EMAIL_TEMPLATE_IDS.map((code) => getTemplateDefinition(code));
}

/** Le contenu d'amorçage d'un code, tel que le registre le déclare. */
function registryContent(definition) {
  return {
    name: definition.defaultName,
    description: definition.defaultDescription,
    subject: definition.defaultSubject,
    html: definition.defaultHtml,
    enabled: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  AMORÇAGE ET PROVISIONNEMENT                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pose les instances PANEL manquantes. IDEMPOTENT, et NON destructif : un
 * contenu déjà écrit n'est jamais réécrit — il a été rédigé par un humain, et
 * un déploiement ne doit pas l'effacer.
 *
 * ── POURQUOI TOUS LES CODES, Y COMPRIS LES CODES PROJECT ────────────────────
 *
 * Non : depuis L11.1, seuls les codes dont la définition déclare la portée
 * PANEL sont amorcés. Poser une instance PANEL de `CONTACT_ADMIN_NOTIFICATION`
 * créerait un document que le runtime ne consulterait jamais — la notification
 * de contact part en portée PROJECT — mais qu'un exploitant éditerait en
 * croyant changer quelque chose.
 */
export async function seedPanelTemplates() {
  const scope = panelScope();
  let created = 0;
  let existing = 0;

  for (const definition of registryDefinitions()) {
    if (!templateDefinition(definition.templateId).scopes.includes(SCOPE_TYPES.PANEL)) continue;

    const posed = await ensureInstance({
      templateCode: definition.templateId,
      scope,
      content: registryContent(definition),
      origin: 'BOOTSTRAP',
      actor: {},
    });
    if (posed.created) created += 1; else existing += 1;
  }

  if (created) logger.info(`[email] ${created} modèle(s) PANEL amorcé(s).`);
  return { created, existing };
}

/**
 * COMPATIBILITÉ — l'ancien nom, conservé pour `server.js` et les suites.
 *
 * Il ne dit plus tout à fait la vérité (« plateforme » est devenu « PANEL »),
 * mais le renommer partout dans le même lot aurait mêlé un changement cosmétique
 * à un changement de comportement. L'alias part au prochain passage.
 */
export const seedPlatformTemplates = seedPanelTemplates;

/**
 * POSE LES INSTANCES D'UN PROJET — la migration de la Phase 4/5 du lot.
 *
 * ── POURQUOI UNE POSE EXPLICITE, ET PAS UNE CRÉATION À LA VOLÉE ─────────────
 *
 * Créer l'instance au premier envoi ferait disparaître le refus qui donne tout
 * son sens au lot : un projet dont le contenu n'a jamais été décidé enverrait un
 * texte que personne n'a relu. La pose est donc un ACTE — d'ouverture de projet,
 * de duplication, ou de migration — journalisé, et daté.
 *
 * `content` permet de POSER UN CONTENU EXISTANT plutôt que le défaut du
 * registre : c'est par là que le HTML rédigé dans SB Auto entre dans le Panel
 * sans être perdu (Phase 5.1).
 *
 * IDEMPOTENT : une instance déjà posée n'est jamais réécrite. Rejouer une
 * migration ne détruit donc pas le travail fait entre-temps.
 */
export async function provisionProjectTemplates(projectId, {
  codes = null,
  contents = {},
  actor = {},
} = {}) {
  const scope = projectScope(projectId);
  const wanted = codes ?? codesToProvisionForProjects();

  const created = [];
  const existing = [];
  const restored = [];
  const refused = [];

  for (const templateCode of wanted) {
    try {
      assertScopeAllowedForCode(templateCode, scope);
    } catch (error) {
      refused.push({ templateCode, code: error?.code ?? 'REFUSED', message: error?.message ?? '' });
      continue;
    }

    const definition = getTemplateDefinition(templateCode);
    const provided = contents[templateCode] ?? null;
    const content = provided
      ? {
        name: provided.name ?? definition.defaultName,
        description: provided.description ?? definition.defaultDescription,
        subject: provided.subject ?? definition.defaultSubject,
        html: provided.html ?? definition.defaultHtml,
        enabled: provided.enabled === undefined ? true : Boolean(provided.enabled),
      }
      : registryContent(definition);

    // Un contenu importé peut être invalide au regard du contrat de CE code :
    // on refuse la ligne, on ne refuse pas la migration entière.
    const verdict = validateTemplate({ templateId: templateCode, subject: content.subject, html: content.html });
    if (!verdict.valid) {
      refused.push({
        templateCode,
        code: 'PANEL_EMAIL_TEMPLATE_INVALID',
        message: `Contenu refusé : ${verdict.errors.length} erreur(s) de validation.`,
        errors: verdict.errors,
      });
      continue;
    }

    const posed = await ensureInstance({
      templateCode,
      scope,
      content,
      origin: 'BOOTSTRAP',
      actor,
    });
    if (posed.created) created.push(templateCode);
    else if (posed.restoredFromArchive) restored.push(templateCode);
    else existing.push(templateCode);
  }

  if (created.length) {
    logger.info(
      `[email] ${created.length} modèle(s) posé(s) en portée ${describeScope(scope)} : ${created.join(', ')}.`,
    );
  }
  return { scope: describeScope(scope), created, existing, restored, refused };
}

/**
 * Pose UNE instance si elle manque. Rend `{ created }`.
 *
 * L'écriture est conditionnelle (`findOne` puis `create`) plutôt qu'un
 * `upsert` : un upsert écraserait le contenu existant, ce qui est exactement
 * ce que l'amorçage ne doit jamais faire.
 */
async function ensureInstance({ templateCode, scope, content, origin, actor }) {
  const filter = { templateCode, ...scopeFilter(scope) };
  const present = await PanelEmailTemplate.findOne(filter).lean();

  /**
   * UNE INSTANCE ARCHIVÉE QUI REDEVIENT DÉCLARÉE SE RÉVEILLE — elle ne se
   * refait pas (L12.1).
   *
   * La reposer depuis les défauts du registre effacerait le contenu qu'un
   * exploitant avait écrit, au seul motif que le projet avait cessé un temps
   * de déclarer ce code. L'archive existe précisément pour éviter cette perte.
   */
  if (present?.archivedAt) {
    await PanelEmailTemplate.updateOne(
      { _id: present._id },
      { $set: { archivedAt: null, archivedReason: '', updatedAt: nowIso() } },
    );
    logger.info(
      `[email] instance ${templateCode} (${describeScope(scope)}) DÉSARCHIVÉE : `
      + 'le projet la déclare de nouveau.',
    );
    return { created: false, restoredFromArchive: true };
  }

  if (present) return { created: false };

  const at = nowIso();

  /**
   * ── UNE INSTANCE ABSENTE N'EST PAS FORCÉMENT UNE INSTANCE NEUVE ───────────
   *
   * Elle peut avoir EXISTÉ : suppression manuelle, restauration de base
   * partielle, incident. Son HISTORIQUE, lui, est resté — il n'est jamais
   * effacé. Repartir de zéro dans ce cas produirait deux dégâts, l'un visible
   * et l'autre non :
   *
   *   · une collision d'index sur (code, portée, version 1), qui fait échouer
   *     la réconciliation entière — c'est ainsi que ce cas s'est révélé ;
   *   · une RÉGRESSION SILENCIEUSE : le contenu reviendrait au défaut du
   *     registre, effaçant le texte que quelqu'un avait écrit, alors qu'il est
   *     encore là, à côté, dans l'historique.
   *
   * On RESTAURE donc depuis la dernière version connue, et l'on n'ajoute aucune
   * entrée d'historique : cette version-là a déjà été écrite, elle n'est pas
   * réécrite. Une restauration n'est pas une modification.
   */
  const derniere = await PanelEmailTemplateVersion
    .findOne(filter).sort({ version: -1 }).lean();

  if (derniere) {
    await PanelEmailTemplate.create({
      templateCode,
      ...scopeColumns(scope),
      name: derniere.name,
      description: derniere.description ?? '',
      subject: derniere.subject,
      html: derniere.html,
      enabled: derniere.enabled !== false,
      version: derniere.version,
      updatedBy: derniere.changedBy ?? null,
      createdAt: derniere.createdAt ?? at,
      updatedAt: at,
    });
    logger.warn(
      `[email] instance ${templateCode} en portée ${describeScope(scope)} RESTAURÉE `
      + `depuis son historique (v${derniere.version}) — elle avait disparu.`,
    );
    return { created: true, restored: true };
  }

  await PanelEmailTemplate.create({
    templateCode,
    ...scopeColumns(scope),
    ...content,
    version: 1,
    updatedBy: actor.userId ?? null,
    createdAt: at,
    updatedAt: at,
  });
  await PanelEmailTemplateVersion.create({
    templateCode,
    ...scopeColumns(scope),
    version: 1,
    ...content,
    changedBy: actor.userId ?? null,
    changedByLabel: actor.userEmail ?? '',
    origin,
    createdAt: at,
  });
  return { created: true, restored: false };
}

/**
 * BACKFILL — pose `scopeType` sur les documents antérieurs à L11.1.
 *
 * Déterministe, et c'est ce qui autorise à le jouer sans supervision :
 * `projectId: null ⇒ PANEL`, sinon `PROJECT`. Aucune heuristique, aucun motif
 * de nom, aucune décision. Idempotent — les documents déjà porteurs d'une
 * portée ne sont pas touchés.
 */
export async function backfillScopeTypes() {
  const collections = [
    ['templates', PanelEmailTemplate],
    ['versions', PanelEmailTemplateVersion],
  ];
  const report = {};

  for (const [label, Model] of collections) {
    const toPanel = await Model.updateMany(
      { scopeType: { $exists: false }, projectId: null },
      { $set: { scopeType: SCOPE_TYPES.PANEL } },
    );
    const toProject = await Model.updateMany(
      { scopeType: { $exists: false }, projectId: { $ne: null } },
      { $set: { scopeType: SCOPE_TYPES.PROJECT } },
    );
    report[label] = {
      panel: toPanel.modifiedCount ?? 0,
      project: toProject.modifiedCount ?? 0,
    };
  }

  const total = Object.values(report).reduce((sum, r) => sum + r.panel + r.project, 0);
  if (total) logger.info(`[email] portée posée sur ${total} document(s) antérieur(s) à L11.1.`);
  return report;
}

/**
 * RÉCONCILIER UN PROJET AVEC CE QU'IL DÉCLARE UTILISER.
 *
 * ══ LE RENVERSEMENT QUE CE LOT OPÈRE ═══════════════════════════════════════
 *
 * La version précédente posait, sur CHAQUE projet, TOUS les codes marqués
 * `provisionForProjects`. Elle réparait le vrai défaut — plus aucun projet
 * n'avait d'instance — mais au prix d'une décision que la plateforme n'a pas à
 * prendre : elle décidait de ce qu'un projet utilise.
 *
 * Les conséquences se voyaient : un projet qui n'envoie que deux e-mails s'en
 * voyait attribuer dix, l'écran d'administration montrait huit modèles que
 * personne n'enverrait jamais, et rien ne pouvait dire lesquels comptaient.
 *
 * Désormais : le projet DÉCLARE, le Panel se CONFORME. L'autorité de l'usage
 * appartient à celui qui écrit le code qui envoie.
 *
 * ══ CE QU'ELLE NE FAIT PAS, ET C'EST ESSENTIEL ═════════════════════════════
 *
 * Elle ne SUPPRIME rien. Un code retiré de la déclaration cesse d'être ACTIF —
 * il disparaît des vues du projet — mais son instance et tout son historique
 * restent en base. Un client qui a écrit son texte, puis cesse temporairement
 * d'utiliser ce message, doit le retrouver INTACT s'il y revient. Supprimer
 * serait irréversible pour économiser quelques documents.
 *
 * L'état « actif » n'est donc pas un champ à tenir : c'est l'APPARTENANCE à la
 * déclaration courante. Une seule vérité, impossible à désynchroniser.
 *
 * ══ UN CODE INCONNU NE FAIT PAS ÉCHOUER LES NEUF AUTRES ════════════════════
 *
 * Un projet déployé AVANT le Panel qui connaît son nouveau code déclarera un
 * code inconnu. C'est un état transitoire NORMAL de l'ordre de déploiement, pas
 * une anomalie de données : les codes valides sont provisionnés, l'inconnu est
 * rapporté, et il se résoudra au déploiement du Panel — sans que personne
 * n'ait à rejouer quoi que ce soit.
 *
 * @param {string} projectId
 * @param {string[]} templateCodes  ce que le projet déclare utiliser
 * @returns {Promise<{accepted, provisioned, existing, restored, unknown, forbidden, archived}>}
 */
export async function reconcileDeclaredProjectEmailTemplates(projectId, templateCodes = [], {
  actor = {},
} = {}) {
  const scope = projectScope(projectId);
  const declares = [...new Set(
    (templateCodes ?? []).map((c) => String(c ?? '').trim()).filter(Boolean),
  )].sort();

  const accepted = [];
  const unknown = [];
  const forbidden = [];

  for (const code of declares) {
    if (!isKnownTemplateId(code)) { unknown.push(code); continue; }
    try {
      assertScopeAllowedForCode(code, scope);
      accepted.push(code);
    } catch {
      // Le projet déclare un code de la PLATEFORME : refus nommé, pas silence.
      forbidden.push(code);
    }
  }

  const pose = accepted.length
    ? await provisionProjectTemplates(projectId, { codes: accepted, actor })
    : { created: [], existing: [], restored: [], refused: [] };

  /**
   * ── LA CONVERGENCE, ET CE QU'ELLE A REMPLACÉ (L12.1) ────────────────────────
   *
   * Cette réconciliation se contentait auparavant de RECENSER les instances hors
   * déclaration dans un champ `removed` — sans jamais rien retirer. Le nom
   * décrivait donc un acte qui n'avait pas lieu : l'instance restait active,
   * éditable dans le Panel, et présentée comme si elle partait encore. Le parc
   * de TEST en portait deux, silencieusement, depuis des semaines.
   *
   * Elle ARCHIVE désormais. Ni suppression (l'historique d'un contenu réellement
   * expédié est la seule trace exploitable d'une enquête), ni désactivation
   * (`enabled: false` prêterait à un exploitant une décision qu'il n'a pas
   * prise). L'instance sort des listes actives, l'envoi la refuse, la raison est
   * écrite, et une nouvelle déclaration la réveille intacte.
   */
  const instances = await PanelEmailTemplate
    .find(scopeFilter(scope)).select('templateCode archivedAt').lean();

  const aArchiver = instances
    .filter((d) => !d.archivedAt && !accepted.includes(d.templateCode))
    .map((d) => d.templateCode)
    .sort();

  if (aArchiver.length) {
    await PanelEmailTemplate.updateMany(
      { ...scopeFilter(scope), templateCode: { $in: aArchiver }, archivedAt: null },
      {
        $set: {
          archivedAt: nowIso(),
          archivedReason: 'Le projet ne déclare plus consommer ce modèle.',
        },
      },
    );
    logger.info(
      `[email] ${describeScope(scope)} — ${aArchiver.length} instance(s) archivée(s) : ${aArchiver.join(', ')}.`,
    );
  }

  const rapport = {
    scope: describeScope(scope),
    accepted,
    provisioned: pose.created,
    existing: pose.existing,
    restored: pose.restored ?? [],
    unknown,
    forbidden,
    archived: aArchiver,
  };

  if (pose.created.length || unknown.length || forbidden.length || aArchiver.length
    || (pose.restored ?? []).length) {
    logger.info(
      `[email] ${describeScope(scope)} — ${pose.created.length} posé(s), `
      + `${pose.existing.length} déjà là, ${(pose.restored ?? []).length} désarchivé(s), `
      + `${unknown.length} inconnu(s), ${forbidden.length} interdit(s), `
      + `${aArchiver.length} archivé(s).`,
    );
  }
  return rapport;
}

/**
 * RÉCONCILIATION DE SÉCURITÉ AU DÉMARRAGE — proportionnelle à l'USAGE RÉEL.
 *
 * ══ CE QU'ELLE NE FAIT PLUS ════════════════════════════════════════════════
 *
 * Elle ne parcourt plus « tous les projets × tous les modèles globaux ». Elle
 * lit les DÉCLARATIONS persistées et s'assure que ce qui est demandé existe.
 * Un projet sans déclaration — relique de fixture, projet jamais démarré depuis
 * ce lot — n'est donc pas touché : il ne demande rien.
 *
 * ══ POURQUOI LA GARDER, PUISQUE LA DÉCLARATION RÉCONCILIE DÉJÀ ═════════════
 *
 * Parce qu'une réconciliation peut échouer à mi-chemin : la base devient
 * indisponible après trois instances posées sur neuf. La déclaration, elle, est
 * persistée et ne sera pas rejouée tant que le projet ne redémarre pas — sa
 * révision n'a pas changé. Ce passage est le filet qui rattrape ce cas, et il
 * ne coûte rien quand il n'y a rien à faire.
 */
export async function reconcileProjectTemplates({ actor = {} } = {}) {
  const declarations = await PanelProjectEmailTemplateUsage
    .find({}).select('projectId templateCodes').lean();

  const rapport = {
    projects: 0, created: 0, existing: 0, unknown: 0, forbidden: 0, archived: 0, byProject: [],
  };

  for (const declaration of declarations) {
    if (!declaration?.projectId) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await reconcileDeclaredProjectEmailTemplates(
      declaration.projectId, declaration.templateCodes ?? [], { actor },
    );
    rapport.projects += 1;
    rapport.created += r.provisioned.length;
    rapport.existing += r.existing.length;
    rapport.unknown += r.unknown.length;
    rapport.forbidden += r.forbidden.length;
    rapport.archived += r.archived.length;
    if (r.provisioned.length || r.unknown.length || r.forbidden.length || r.archived.length) {
      rapport.byProject.push({ projectId: declaration.projectId, ...r });
    }
  }

  if (rapport.created || rapport.archived) {
    logger.info(
      `[email] réconciliation au démarrage : ${rapport.created} instance(s) posée(s), `
      + `${rapport.archived} archivée(s) `
      + `sur ${rapport.byProject.length} projet(s) déclarant `
      + `(${rapport.projects} déclaration(s) lue(s)).`,
    );
  }
  return rapport;
}

/**
 * CE QUI MANQUE À CE QUI EST DÉCLARÉ — sans rien écrire.
 *
 * Lit les déclarations, jamais le drapeau global : la question « que manque-t-il
 * à ce projet ? » n'a de sens que par rapport à ce QU'IL demande.
 */
export async function findMissingProjectTemplates() {
  const declarations = await PanelProjectEmailTemplateUsage
    .find({}).select('projectId templateCodes').lean();
  const manques = [];

  for (const d of declarations) {
    if (!d?.projectId) continue;
    const scope = projectScope(d.projectId);
    const demandes = (d.templateCodes ?? []).filter((c) => isKnownTemplateId(c));
    // eslint-disable-next-line no-await-in-loop
    const presents = await PanelEmailTemplate
      .find({ templateCode: { $in: demandes }, ...scopeFilter(scope) })
      .select('templateCode').lean();
    const connus = new Set(presents.map((x) => x.templateCode));
    const absents = demandes.filter((c) => !connus.has(c));
    if (absents.length) manques.push({ projectId: d.projectId, missing: absents });
  }
  return { declarations: declarations.length, missing: manques };
}

/**
 * LES CODES ACTIVEMENT DÉCLARÉS PAR UN PROJET — la question que tout le reste
 * pose : les écrans, la résolution d'envoi, la recette.
 *
 * Rend `null` — et non `[]` — quand AUCUNE déclaration n'existe. « Ce projet
 * n'a jamais parlé » et « ce projet déclare zéro modèle » n'appellent pas la
 * même réponse, et les confondre ferait refuser les envois d'un projet
 * simplement plus ancien que ce lot.
 */
export async function declaredCodesForProject(projectId) {
  const d = await PanelProjectEmailTemplateUsage
    .findOne({ projectId }).select('templateCodes').lean();
  return d ? (d.templateCodes ?? []) : null;
}

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * LE CONTENU QUI PART RÉELLEMENT, pour CETTE portée. FAIL-CLOSED.
 *
 * Une seule fonction pour l'aperçu, l'envoi, l'écriture et le catalogue : deux
 * endroits qui choisiraient « quel contenu » finiraient par ne pas choisir le
 * même, et l'aperçu montrerait autre chose que ce qui part.
 *
 * @throws {ApiError} `EMAIL_TEMPLATE_NOT_CONFIGURED` — portée PROJECT sans instance.
 */
/**
 * L'INSTANCE ACTIVE d'une portée — jamais une archive (L12.1).
 *
 * Toute lecture qui décide d'un ENVOI ou d'un AFFICHAGE passe par ici. Une
 * instance archivée existe encore (son historique est la seule trace de ce qui
 * est réellement parti), mais elle n'est plus une réponse à « quel modèle sert
 * ce projet ? ». La confondre avec une instance vivante ferait repartir un
 * contenu que le projet a cessé de déclarer.
 */
function activeInstanceFilter(templateCode, scope) {
  return { templateCode, ...scopeFilter(scope), archivedAt: null };
}

export async function resolveTemplate(templateCode, scope) {
  const definition = assertKnownTemplate(templateCode);
  assertScopeAllowedForCode(templateCode, scope);

  const stored = await PanelEmailTemplate
    .findOne(activeInstanceFilter(templateCode, scope)).lean();

  if (stored) {
    return {
      templateCode,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      source: scope.scopeType === SCOPE_TYPES.PANEL ? TEMPLATE_SOURCES.PANEL : TEMPLATE_SOURCES.PROJECT,
      configured: true,
      name: stored.name,
      description: stored.description,
      subject: stored.subject,
      html: stored.html,
      enabled: stored.enabled,
      version: stored.version,
      updatedAt: stored.updatedAt,
    };
  }

  /**
   * PORTÉE PROJECT SANS INSTANCE — LE REFUS QUI FAIT TOUT LE LOT.
   *
   * Ni repli PANEL, ni défaut du registre : les deux enverraient sous le nom
   * d'un client un texte écrit pour quelqu'un d'autre. Un e-mail non envoyé se
   * répare ; un e-mail envoyé avec le mauvais branding ne se rattrape pas.
   */
  if (scope.scopeType === SCOPE_TYPES.PROJECT) {
    throw ApiError.conflict(
      EMAIL_TEMPLATE_NOT_CONFIGURED,
      `Aucun modèle « ${templateCode} » configuré en portée ${describeScope(scope)}. `
      + 'Aucun envoi n’est effectué : le contenu d’un projet n’est jamais remplacé par celui du Panel.',
      { templateCode, scopeType: scope.scopeType, scopeId: scope.scopeId },
    );
  }

  /**
   * PORTÉE PANEL, BASE VIDE — le seul repli conservé, et il ne ment pas.
   *
   * C'est le contenu que l'amorçage POSERAIT : le servir donne exactement le
   * même e-mail, et évite de perdre une notification du Panel parce qu'une
   * migration n'a pas encore tourné. La `source` le dit, et l'écran l'affiche.
   */
  return {
    templateCode,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    source: TEMPLATE_SOURCES.REGISTRY_DEFAULT,
    configured: false,
    ...registryContent(definition),
    version: 0,
    updatedAt: null,
  };
}

/**
 * LA RÉSOLUTION D'ENVOI, RENDUE OBSERVABLE — même chemin, sans exception (L12.1).
 *
 * ── LE PROBLÈME QU'ELLE RÈGLE ───────────────────────────────────────────────
 *
 * Un écran de consultation doit montrer CE QUI PARTIRAIT. Jusqu'ici il n'avait
 * le choix qu'entre deux mauvaises réponses : appeler `resolveTemplate` et se
 * prendre une exception (donc n'afficher RIEN, alors que le diagnostic est
 * précisément ce qu'on cherche), ou appeler `draftTemplate` et afficher le
 * défaut du registre — un contenu qui ne partirait JAMAIS pour une portée
 * PROJECT, puisque l'envoi refuse justement de le servir.
 *
 * La seconde était la pire : elle donnait à un aperçu l'apparence d'une vérité.
 * Un exploitant y lisait un modèle « configuré » qui, à l'envoi, produisait
 * EMAIL_TEMPLATE_NOT_CONFIGURED.
 *
 * ── CE QU'ELLE FAIT, ET CE QU'ELLE NE FAIT PAS ──────────────────────────────
 *
 * Elle appelle la MÊME primitive que l'envoi et se contente de transformer son
 * refus en constat : `usable: false` + la raison. Elle n'invente aucun contenu
 * de repli. Un modèle non configuré ne rend donc ni sujet ni HTML — parce qu'il
 * n'y en a pas, et qu'en fabriquer un serait exactement le mensonge qu'on
 * supprime.
 *
 * `draftTemplate`, lui, reste réservé à l'ÉDITEUR du Panel : là, proposer un
 * point de départ est le service rendu, et l'écran dit « pas encore configuré ».
 */
export const TEMPLATE_UNUSABLE = Object.freeze({
  NOT_CONFIGURED: EMAIL_TEMPLATE_NOT_CONFIGURED,
  NOT_DECLARED: EMAIL_TEMPLATE_NOT_DECLARED,
  DISABLED: 'PANEL_EMAIL_TEMPLATE_DISABLED',
  FORBIDDEN_SCOPE: 'PANEL_EMAIL_TEMPLATE_SCOPE_FORBIDDEN_FOR_CODE',
  UNKNOWN: 'PANEL_EMAIL_TEMPLATE_UNKNOWN',
});

export async function resolveForProjection(templateCode, scope, { declaredCodes = null } = {}) {
  const base = {
    templateCode,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    usable: false,
    configured: false,
    source: null,
    name: '',
    description: '',
    subject: '',
    html: '',
    enabled: false,
    version: 0,
    updatedAt: null,
    unusableReason: null,
    unusableMessage: '',
  };

  // La déclaration d'abord : c'est le refus que `renderForSend` oppose EN
  // PREMIER, et l'ordre doit être le même — sans quoi l'écran nommerait une
  // cause que l'envoi ne retiendrait pas.
  if (scope.scopeType === SCOPE_TYPES.PROJECT && Array.isArray(declaredCodes)
    && !declaredCodes.includes(templateCode)) {
    return {
      ...base,
      unusableReason: TEMPLATE_UNUSABLE.NOT_DECLARED,
      unusableMessage: `Ce projet ne déclare pas consommer « ${templateCode} » : aucun envoi n’est possible.`,
    };
  }

  let resolved;
  try {
    resolved = await resolveTemplate(templateCode, scope);
  } catch (error) {
    return {
      ...base,
      unusableReason: error?.code ?? TEMPLATE_UNUSABLE.NOT_CONFIGURED,
      unusableMessage: error?.message ?? 'Ce modèle ne peut pas être résolu pour cette portée.',
    };
  }

  return {
    ...base,
    ...resolved,
    usable: resolved.enabled !== false,
    ...(resolved.enabled === false
      ? {
        unusableReason: TEMPLATE_UNUSABLE.DISABLED,
        unusableMessage: `Le modèle « ${templateCode} » est désactivé : aucun envoi n’est effectué.`,
      }
      : {}),
  };
}

/**
 * LA PROJECTION AUTORITATIVE D'UNE PORTÉE — ce que le pont sert au projet.
 *
 * Un seul producteur pour les trois consommateurs : l'écran du Manager, son
 * aperçu, et le contrôle de compatibilité. Trois résolveurs auraient fini par
 * répondre trois choses différentes à la même question ; c'est précisément
 * l'écart que l'audit avait relevé.
 */
export async function describeProjectionForScope(scope) {
  assertScopeCoherent(scope);
  const declaredCodes = scope.scopeType === SCOPE_TYPES.PROJECT
    ? await declaredCodesForProject(scope.scopeId)
    : null;

  // Une portée PROJECT ne présente QUE ce qu'elle déclare. Lister les autres
  // codes du registre inviterait à croire qu'ils sont disponibles ici.
  const codes = scope.scopeType === SCOPE_TYPES.PROJECT
    ? (declaredCodes ?? []).filter((code) => isKnownTemplateId(code))
    : listTemplateCodesForScope(scope);

  const items = [];
  for (const templateCode of codes) {
    const contract = templateDefinition(templateCode);
    if (!contract) continue;
    const resolved = await resolveForProjection(templateCode, scope, { declaredCodes });
    items.push({
      templateCode,
      label: getTemplateDefinition(templateCode).defaultName,
      description: resolved.description || getTemplateDefinition(templateCode).defaultDescription,
      subject: resolved.subject,
      html: resolved.html,
      enabled: resolved.enabled,
      configured: resolved.configured,
      usable: resolved.usable,
      unusableReason: resolved.unusableReason,
      unusableMessage: resolved.unusableMessage,
      version: resolved.version,
      source: resolved.source,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      updatedAt: resolved.updatedAt,
      category: contract.category,
      ownedBy: contract.scopes.includes(SCOPE_TYPES.PROJECT) ? SCOPE_TYPES.PROJECT : SCOPE_TYPES.PANEL,
      retentionClass: getTemplateDefinition(templateCode).retentionClass ?? null,
      variableContractFingerprint: variableContractFingerprint(templateCode),
      variables: variablesFor(templateCode).map((v) => ({
        key: v.key, label: v.label, description: v.description,
        type: v.type, required: v.required,
      })),
    });
  }
  return items;
}

/**
 * LA MÊME RÉSOLUTION, POUR UN ÉCRAN D'ÉDITION — un refus devient un BROUILLON.
 *
 * ── POURQUOI DEUX FONCTIONS, ET PAS UN DRAPEAU ─────────────────────────────
 *
 * Un drapeau `{ allowMissing: true }` finirait par être passé depuis le chemin
 * d'envoi « pour que ça marche ». Deux fonctions au nom distinct rendent
 * l'intention lisible à l'appel : `resolveTemplate` sert un ENVOI et refuse,
 * `draftTemplate` sert un ÉDITEUR et propose un point de départ.
 *
 * `configured: false` est rendu tel quel : l'écran doit dire « ce projet n'a pas
 * encore ce modèle » plutôt que d'afficher un contenu qui semble en production.
 */
export async function draftTemplate(templateCode, scope) {
  const definition = assertKnownTemplate(templateCode);
  assertScopeAllowedForCode(templateCode, scope);

  /**
   * L'ÉDITEUR VOIT LES ARCHIVES — l'envoi, jamais (L12.1).
   *
   * Ce filtre a d'abord exclu les instances archivées ici aussi. C'était une
   * faute : un exploitant perdait l'accès au contenu qu'il avait écrit à la
   * seconde où le projet cessait de déclarer le code, et l'archive — dont toute
   * la raison d'être est de PRÉSERVER ce contenu — le rendait inaccessible.
   *
   * La distinction est donc portée par les deux fonctions, pas par le filtre :
   * `resolveTemplate` sert l'ENVOI et ignore les archives ; `draftTemplate`
   * sert l'ÉCRAN D'ADMINISTRATION et les montre, marquées comme telles.
   */
  const stored = await PanelEmailTemplate
    .findOne({ templateCode, ...scopeFilter(scope) }).lean();

  if (stored?.archivedAt) {
    return {
      templateCode,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      source: scope.scopeType === SCOPE_TYPES.PANEL ? TEMPLATE_SOURCES.PANEL : TEMPLATE_SOURCES.PROJECT,
      configured: true,
      archived: true,
      archivedAt: stored.archivedAt,
      archivedReason: stored.archivedReason ?? '',
      name: stored.name,
      description: stored.description,
      subject: stored.subject,
      html: stored.html,
      enabled: stored.enabled,
      version: stored.version,
      updatedAt: stored.updatedAt,
    };
  }

  if (stored) return resolveTemplate(templateCode, scope);

  return {
    templateCode,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    source: TEMPLATE_SOURCES.REGISTRY_DEFAULT,
    configured: false,
    ...registryContent(definition),
    version: 0,
    updatedAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  RENDU                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rend un template pour un envoi RÉEL.
 *
 * Un template désactivé fait ÉCHOUER l'appel : le refus est explicite, jamais
 * un envoi silencieusement sauté. Couper un e-mail est une décision — la
 * découvrir dans l'absence de message n'en est pas une.
 *
 * La sortie porte la PORTÉE et la VERSION réellement rendues : c'est ce que
 * l'observabilité du lot (Phase 13) journalise, et ce que le projet persiste
 * sur sa livraison (Phase 14) au lieu d'un numéro local qui n'est jamais parti.
 */
export async function renderForSend({ templateCode, scope, variables = {} }) {
  /**
   * ── LE PROJET DÉCLARE-T-IL ENCORE CE MODÈLE ? ──────────────────────────────
   *
   * Vérifié À L'ENVOI, et seulement à l'envoi : ni l'aperçu ni l'édition n'en
   * dépendent — un exploitant doit pouvoir relire et corriger le texte d'un
   * message que le projet n'envoie plus.
   *
   * ══ POURQUOI CE CONTRÔLE EXISTE ═════════════════════════════════════════
   *
   * Sans lui, un vieux chemin métier resté branché continuerait d'envoyer un
   * message que le projet affirme ne plus utiliser — avec le contenu figé au
   * jour où il a cessé d'être maintenu. L'écran d'administration ne le montre
   * plus, personne ne le relit, et il part quand même. C'est exactement le type
   * de divergence silencieuse que la portée explicite a supprimé ailleurs.
   *
   * ══ `null` N'EST PAS `[]` ═══════════════════════════════════════════════
   *
   * Un projet qui n'a JAMAIS déclaré — antérieur à ce lot, ou dont la première
   * synchronisation n'est pas encore arrivée — obtient `null`, et on n'oppose
   * rien. Le refus ne vaut que contre une déclaration EXISTANTE qui ne contient
   * pas ce code : là, le projet a parlé, et il a dit non.
   */
  if (scope.scopeType === SCOPE_TYPES.PROJECT) {
    const declares = await declaredCodesForProject(scope.scopeId);
    if (declares !== null && !declares.includes(templateCode)) {
      throw ApiError.conflict(
        EMAIL_TEMPLATE_NOT_DECLARED,
        `Le projet ${describeScope(scope)} ne déclare pas utiliser « ${templateCode} » : `
        + 'aucun envoi n’est effectué. Un chemin métier appelle un modèle que le projet '
        + 'a cessé de déclarer — la correction est dans le projet, pas dans le Panel.',
        { templateCode, scopeType: scope.scopeType, scopeId: scope.scopeId },
      );
    }
  }

  const template = await resolveTemplate(templateCode, scope);

  if (!template.enabled) {
    throw ApiError.conflict(
      'PANEL_EMAIL_TEMPLATE_DISABLED',
      `Le modèle « ${templateCode} » est désactivé en portée ${describeScope(scope)} : aucun envoi n’est effectué.`,
    );
  }

  try {
    const rendered = renderTemplate({
      templateId: templateCode,
      template: { subject: template.subject, html: template.html },
      variables,
    });
    return {
      ...rendered,
      templateCode,
      scopeType: template.scopeType,
      scopeId: template.scopeId,
      version: template.version,
      source: template.source,
    };
  } catch (error) {
    const details = error instanceof EmailRenderError ? error.details : [];
    throw ApiError.badRequest(
      error?.code ?? E.RENDER_FAILED,
      `Rendu impossible pour « ${templateCode} » en portée ${describeScope(scope)}.`,
      details,
    );
  }
}

/**
 * APERÇU — même moteur, même portée, même version, données d'exemple.
 *
 * Il passe par `renderTemplate` et non par une simulation : un aperçu qui
 * emprunterait un chemin plus permissif montrerait un rendu que l'envoi
 * refuserait, et l'on croirait le template bon. C'est l'invariant de la Phase 10
 * du lot — le bug « aperçu correct, e-mail différent » doit être structurellement
 * impossible, et il l'est parce qu'il n'y a qu'un résolveur et qu'un renderer.
 */
/**
 * L'APERÇU AUTORITATIF — celui d'un CONSOMMATEUR, pas celui d'un éditeur (L12.1).
 *
 * `previewTemplate` ci-dessous sert l'éditeur du Panel : il prévisualise un
 * brouillon, y compris avant qu'aucune instance n'existe. Celui-ci sert le
 * Manager, et répond à une autre question — « à quoi ressemble l'e-mail QUI
 * PARTIRAIT aujourd'hui ? ». Il part donc de la résolution d'envoi, et refuse
 * de rendre quoi que ce soit quand l'envoi refuserait lui aussi.
 */
export async function previewResolvedTemplate(templateCode, scope, { declaredCodes = null } = {}) {
  const definition = assertKnownTemplate(templateCode);
  const resolved = await resolveForProjection(templateCode, scope, { declaredCodes });

  if (!resolved.usable) {
    return {
      templateId: templateCode,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      subject: null,
      html: null,
      usable: false,
      configured: resolved.configured,
      version: resolved.version,
      source: resolved.source,
      unusableReason: resolved.unusableReason,
      unusableMessage: resolved.unusableMessage,
      renderError: null,
      sampleVariables: Object.fromEntries(sampleVariablesFor(templateCode)),
    };
  }

  try {
    const rendered = renderTemplate({
      templateId: templateCode,
      template: { subject: resolved.subject, html: resolved.html },
      variables: sampleVariablesFor(templateCode),
    });
    return {
      templateId: templateCode,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      subject: rendered.subject,
      html: rendered.html,
      usedVariables: rendered.usedVariables,
      usable: true,
      configured: resolved.configured,
      version: resolved.version,
      source: resolved.source,
      unusableReason: null,
      unusableMessage: '',
      renderError: null,
      sampleVariables: Object.fromEntries(sampleVariablesFor(templateCode)),
    };
  } catch (error) {
    return {
      templateId: templateCode,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      subject: null,
      html: null,
      usable: false,
      configured: resolved.configured,
      version: resolved.version,
      source: resolved.source,
      unusableReason: error?.code ?? 'RENDER_FAILED',
      unusableMessage: error?.message ?? 'Rendu impossible.',
      renderError: {
        code: error?.code ?? 'RENDER_FAILED',
        message: error?.message ?? 'Rendu impossible.',
        details: error instanceof EmailRenderError ? error.details : [],
      },
      sampleVariables: Object.fromEntries(sampleVariablesFor(templateCode)),
    };
  }
}

export async function previewTemplate(templateCode, scope, { variables = null } = {}) {
  const definition = assertKnownTemplate(templateCode);
  const template = await draftTemplate(templateCode, scope);
  const rendered = renderTemplate({
    templateId: templateCode,
    template: { subject: template.subject, html: template.html },
    variables: variables ?? definition.sampleVariables,
  });
  return {
    ...rendered,
    scopeType: template.scopeType,
    scopeId: template.scopeId,
    source: template.source,
    configured: template.configured,
    version: template.version,
  };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Enregistre un contenu DANS UNE PORTÉE.
 *
 * ── LA PORTÉE EST LE 2e ARGUMENT, ET C'EST LA CORRECTION DE LA PHASE 0.1 ────
 *
 * Elle n'est plus lue dans le patch. Un corps de requête ne peut donc plus la
 * choisir, quelle que soit la vigilance du contrôleur : il n'y a rien à
 * déstructurer. Les seuls champs retenus du patch sont nommés un par un,
 * ci-dessous — tout le reste est ignoré parce qu'il n'est jamais lu.
 *
 * ── LE JETON D'ÉDITION ──────────────────────────────────────────────────────
 *
 * `expectedVersion` refuse une écriture bâtie sur un contenu périmé. Deux DEV
 * qui éditent le même modèle en même temps ne doivent pas silencieusement
 * s'écraser : le second est refusé et relit.
 */
export async function saveTemplate(templateCode, scope, patch = {}, actor = {}) {
  assertKnownTemplate(templateCode);
  assertScopeAllowedForCode(templateCode, scope);

  const { subject, html, name, description, enabled, expectedVersion } = patch;

  const current = await draftTemplate(templateCode, scope);
  const next = {
    name: name ?? current.name,
    description: description ?? current.description,
    subject: subject ?? current.subject,
    html: html ?? current.html,
    enabled: enabled === undefined ? current.enabled : Boolean(enabled),
  };

  if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) {
    throw ApiError.conflict(
      'PANEL_EMAIL_TEMPLATE_VERSION_CONFLICT',
      `Ce modèle a été modifié depuis votre dernière lecture (version ${current.version}). Relisez avant d’enregistrer.`,
    );
  }

  // La validation porte sur le CONTENU FUSIONNÉ, pas sur les champs reçus :
  // écrire un sujet valide sur un HTML devenu invalide doit échouer.
  const verdict = validateTemplate({ templateId: templateCode, subject: next.subject, html: next.html });
  if (!verdict.valid) {
    throw ApiError.badRequest(
      'PANEL_EMAIL_TEMPLATE_INVALID',
      'Modèle refusé : le contenu ne respecte pas les règles de sécurité ou de variables.',
      verdict.errors,
    );
  }

  const at = nowIso();
  const version = current.version + 1;
  const actorId = actor.userId ?? null;
  const columns = scopeColumns(scope);

  await PanelEmailTemplate.updateOne(
    { templateCode, ...scopeFilter(scope) },
    {
      $set: { ...next, version, updatedAt: at, updatedBy: actorId },
      $setOnInsert: { createdAt: at, ...columns },
    },
    { upsert: true },
  );

  await PanelEmailTemplateVersion.create({
    templateCode, ...columns, version, ...next,
    changedBy: actorId,
    changedByLabel: actor.userEmail ?? '',
    origin: 'EDIT',
    createdAt: at,
  });

  await pruneHistory(templateCode, scope);

  // On NOMME ce qui a été touché, jamais son contenu : un sujet rendu porterait
  // le nom d'un destinataire.
  logger.info(`[email] modèle ${templateCode} (${describeScope(scope)}) enregistré en version ${version}.`);

  return resolveTemplate(templateCode, scope);
}

/**
 * RESTAURE une version — en en créant une NOUVELLE, DANS SA SEULE PORTÉE.
 *
 * On ne remonte pas le temps : l'historique est un fait daté. Une restauration
 * malheureuse doit pouvoir être annulée à son tour, ce qu'un écrasement
 * interdirait.
 *
 * La version source est cherchée AVEC la portée : restaurer la v3 de
 * `PROJECT/A/X` ne peut pas lire, ni écrire, la v3 de `PANEL/X` — même code,
 * même numéro, documents étrangers l'un à l'autre.
 */
export async function restoreVersion(templateCode, scope, version, actor = {}) {
  assertKnownTemplate(templateCode);
  assertScopeAllowedForCode(templateCode, scope);

  const source = await PanelEmailTemplateVersion
    .findOne({ templateCode, ...scopeFilter(scope), version: Number(version) }).lean();
  if (!source) {
    throw ApiError.notFound(
      'PANEL_EMAIL_TEMPLATE_VERSION_UNKNOWN',
      `Version ${version} introuvable pour « ${templateCode} » en portée ${describeScope(scope)}.`,
    );
  }

  const current = await draftTemplate(templateCode, scope);
  const at = nowIso();
  const nextVersion = current.version + 1;
  const columns = scopeColumns(scope);

  await PanelEmailTemplate.updateOne(
    { templateCode, ...scopeFilter(scope) },
    {
      $set: {
        name: source.name, description: source.description,
        subject: source.subject, html: source.html, enabled: source.enabled,
        version: nextVersion, updatedAt: at, updatedBy: actor.userId ?? null,
      },
      $setOnInsert: { createdAt: at, ...columns },
    },
    { upsert: true },
  );
  await PanelEmailTemplateVersion.create({
    templateCode, ...columns, version: nextVersion,
    name: source.name, description: source.description,
    subject: source.subject, html: source.html, enabled: source.enabled,
    changedBy: actor.userId ?? null, changedByLabel: actor.userEmail ?? '',
    origin: 'RESTORE', restoredFromVersion: source.version,
    createdAt: at,
  });
  await pruneHistory(templateCode, scope);

  return resolveTemplate(templateCode, scope);
}

/** L'historique ne grossit pas sans fin : au-delà du plafond, le plus ancien part. */
async function pruneHistory(templateCode, scope) {
  const filter = { templateCode, ...scopeFilter(scope) };
  const total = await PanelEmailTemplateVersion.countDocuments(filter);
  if (total <= MAX_TEMPLATE_VERSION_HISTORY) return;
  const surplus = await PanelEmailTemplateVersion
    .find(filter)
    .sort({ version: 1 })
    .limit(total - MAX_TEMPLATE_VERSION_HISTORY)
    .select('_id')
    .lean();
  await PanelEmailTemplateVersion.deleteMany({ _id: { $in: surplus.map((v) => v._id) } });
}

export async function listVersions(templateCode, scope, { limit = 20 } = {}) {
  assertKnownTemplate(templateCode);
  assertScopeAllowedForCode(templateCode, scope);
  return PanelEmailTemplateVersion
    .find({ templateCode, ...scopeFilter(scope) })
    .sort({ version: -1 })
    .limit(Math.min(Number(limit) || 20, MAX_TEMPLATE_VERSION_HISTORY))
    .lean();
}

/** UNE version, dans SA portée. `null` si elle n'y existe pas. */
export async function getVersion(templateCode, scope, version) {
  assertKnownTemplate(templateCode);
  assertScopeAllowedForCode(templateCode, scope);
  return PanelEmailTemplateVersion
    .findOne({ templateCode, ...scopeFilter(scope), version: Number(version) })
    .lean();
}

/* -------------------------------------------------------------------------- */
/*  VUE                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Le catalogue D'UNE PORTÉE, tel qu'un écran d'édition le consomme.
 *
 * Ne liste que les codes dont une instance a le droit d'exister ici : l'écran de
 * SB Auto ne doit pas proposer d'éditer `PAYMENT_REQUEST_CREATED`, qui part du
 * Panel et ne le concerne pas.
 */
export async function describeTemplates(scope) {
  assertScopeCoherent(scope);
  const items = [];

  /**
   * ── EN PORTÉE PROJET, LE CATALOGUE SUIT LA DÉCLARATION ────────────────────
   *
   * L'écran montrait tous les codes que la portée AUTORISE — c'est-à-dire ce
   * que le projet POURRAIT utiliser, pas ce qu'il utilise. Un exploitant y
   * voyait dix modèles pour un projet qui en envoie deux, dont huit marqués
   * « non configuré » : huit faux problèmes, et aucun moyen de distinguer un
   * modèle réellement manquant d'un modèle simplement non utilisé.
   *
   * On affiche donc ce que le projet DÉCLARE. `declared` porte l'information
   * jusqu'à l'écran, qui range à part ce qui ne l'est plus — sans le cacher :
   * un contenu écrit reste consultable, il n'est simplement plus présenté comme
   * actif.
   *
   * `null` (aucune déclaration reçue) laisse le catalogue complet : un projet
   * antérieur à ce lot, ou dont la première synchronisation n'est pas arrivée,
   * ne doit pas voir son écran se vider.
   */
  const declares = scope.scopeType === SCOPE_TYPES.PROJECT
    ? await declaredCodesForProject(scope.scopeId)
    : null;

  for (const templateCode of listTemplateCodesForScope(scope)) {
    const definition = getTemplateDefinition(templateCode);
    const resolved = await draftTemplate(templateCode, scope);
    const contract = templateDefinition(templateCode);

    items.push({
      templateCode,
      label: definition.defaultName,
      description: resolved.description,
      subject: resolved.subject,
      enabled: resolved.enabled,
      /** `false` = aucune instance dans cette portée. L'écran doit le DIRE. */
      configured: resolved.configured,
      /**
       * `true` = le projet ne déclare plus ce code ; l'instance et son
       * historique sont conservés, l'envoi la refuse. L'écran doit le
       * distinguer d'un modèle actif, sans pour autant la cacher : c'est ici
       * qu'on relit le contenu écrit avant le retrait.
       */
      archived: resolved.archived === true,
      version: resolved.version,
      source: resolved.source,
      scopeType: resolved.scopeType,
      scopeId: resolved.scopeId,
      updatedAt: resolved.updatedAt,
      category: contract.category,
      scopes: contract.scopes,
      /**
       * CE PROJET LE DÉCLARE-T-IL ? `null` = aucune déclaration reçue, donc
       * aucune opinion — l'écran n'a alors rien à ranger à part.
       */
      declared: declares === null ? null : declares.includes(templateCode),
      retentionClass: definition.retentionClass ?? null,
      /** Les variables AUTORISÉES — l'écran les rend, il ne les devine pas. */
      variables: variablesFor(templateCode).map((v) => ({
        key: v.key, label: v.label, description: v.description,
        type: v.type, required: v.required,
      })),
    });
  }

  return items;
}

/**
 * TOUTES LES PORTÉES OÙ UN CODE EST RÉELLEMENT CONFIGURÉ.
 *
 * Sert au diagnostic (« qui a réécrit ce modèle ? ») et à la recette du §25 :
 * prouver que trois portées portent trois contenus distincts suppose de pouvoir
 * les énumérer.
 */
export async function describeScopesForCode(templateCode) {
  assertKnownTemplate(templateCode);
  const documents = await PanelEmailTemplate
    .find({ templateCode })
    .select('scopeType projectId version updatedAt enabled')
    .lean();

  return documents.map((document) => ({
    scopeType: document.scopeType ?? (document.projectId ? SCOPE_TYPES.PROJECT : SCOPE_TYPES.PANEL),
    scopeId: document.projectId ?? null,
    version: document.version,
    enabled: document.enabled,
    updatedAt: document.updatedAt,
  }));
}

export default {
  EMAIL_TEMPLATE_NOT_CONFIGURED,
  EMAIL_TEMPLATE_NOT_DECLARED,
  TEMPLATE_SOURCES,
  assertKnownTemplate,
  backfillScopeTypes,
  describeScopesForCode,
  describeTemplates,
  findMissingProjectTemplates,
  draftTemplate,
  getVersion,
  listTemplateCodes,
  listTemplateCodesForScope,
  listVersions,
  previewTemplate,
  declaredCodesForProject,
  provisionProjectTemplates,
  reconcileDeclaredProjectEmailTemplates,
  reconcileProjectTemplates,
  renderForSend,
  resolveTemplate,
  restoreVersion,
  saveTemplate,
  seedPanelTemplates,
  seedPlatformTemplates,
};
