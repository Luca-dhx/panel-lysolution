// LA PORTÉE D'UN TEMPLATE — qui possède la communication (L11.1).
//
// docs/email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md §« Portée ».
//
// ── CE QUE CE MODULE EXISTE POUR EMPÊCHER ───────────────────────────────────
//
// Avant L11.1, la portée d'un template était une NULLITÉ : `projectId === null`
// voulait dire « plateforme », et toute autre valeur « projet ». Deux défauts
// tenaient dans cette convention :
//
//   · elle n'était écrite NULLE PART — chaque appelant la redécouvrait, et
//     l'éditeur avait fini par coder `projectId: null` en dur à quatre endroits ;
//   · elle était FOURNIE PAR LE CORPS de la requête, donc choisie par
//     l'appelant, donc pas une portée mais une suggestion.
//
// Une portée est désormais un OBJET, construit par une fonction, jamais
// désérialisé depuis une charge utile. Les deux seuls constructeurs sont
// `panelScope()` et `projectScope(projectId)` : il n'existe aucun chemin qui
// produise une portée à partir d'une chaîne reçue du réseau sans passer par une
// validation explicite.
//
// ── DEUX SCOPES, ET PAS TROIS ───────────────────────────────────────────────
//
// `SHARED` a été envisagé (audit §OPEN QUESTIONS n°3) et écarté : les deux
// candidats — le test technique d'expéditeur et la notification DEV de
// résiliation — sont des communications de L.Y Solution vers L.Y Solution ou
// vers un opérateur. Ce sont des templates PANEL. Un troisième scope sans
// cas d'usage réel serait une branche de code que rien n'exerce, donc une
// branche qui pourrit.
//
// ── LE NOM DE LA COLONNE N'A PAS CHANGÉ ─────────────────────────────────────
//
// En base, l'identifiant de portée reste `projectId`. Le renommer en `scopeId`
// aurait imposé une migration de deux collections, de deux index uniques et de
// tous leurs lecteurs, pour gagner un mot. La correspondance est totale et
// déterministe — `scopeType: PANEL ⇔ projectId: null` — et elle est vérifiée à
// l'écriture comme à la lecture par `assertScopeCoherent()`.
import ApiError from '../../utils/ApiError.js';
import PanelProject from '../../models/PanelProject.model.js';

/** Les deux portées réellement servies par le runtime. */
export const SCOPE_TYPES = Object.freeze({
  /** Contenu de L.Y Solution. Un seul document par code, pour tout le parc. */
  PANEL: 'PANEL',
  /** Contenu propre à UN projet. Un document par (projet, code). */
  PROJECT: 'PROJECT',
});

export const SCOPE_TYPE_VALUES = Object.freeze(Object.values(SCOPE_TYPES));

/** Codes d'erreur STABLES de la portée. Les écrans s'appuient sur eux. */
export const SCOPE_ERROR_CODES = Object.freeze({
  /** La portée demandée n'est pas `PANEL` ou `PROJECT`. */
  INVALID: 'PANEL_EMAIL_TEMPLATE_SCOPE_INVALID',
  /** `PROJECT` sans projet, ou `PANEL` avec un projet. */
  INCOHERENT: 'PANEL_EMAIL_TEMPLATE_SCOPE_INCOHERENT',
  /** Le projet nommé n'existe pas au registre. */
  PROJECT_UNKNOWN: 'PANEL_EMAIL_TEMPLATE_SCOPE_PROJECT_UNKNOWN',
  /** Une portée a été trouvée dans le CORPS d'une requête. Refus sec. */
  IN_BODY: 'PANEL_EMAIL_TEMPLATE_SCOPE_IN_BODY',
  /** Ce code de template n'a pas le droit d'exister dans cette portée. */
  FORBIDDEN_FOR_CODE: 'PANEL_EMAIL_TEMPLATE_SCOPE_FORBIDDEN_FOR_CODE',
});

/**
 * LA PORTÉE PLATEFORME — `scopeId` toujours `null`.
 *
 * Gelée : une portée qui se laisserait muter après construction pourrait être
 * transformée en portée projet par un appelant distrait, entre la validation et
 * l'usage.
 */
export function panelScope() {
  return Object.freeze({ scopeType: SCOPE_TYPES.PANEL, scopeId: null });
}

/**
 * LA PORTÉE D'UN PROJET.
 *
 * Ne vérifie PAS que le projet existe — c'est le rôle de `assertScopeUsable()`,
 * qui est asynchrone. Séparer les deux permet de construire une portée dans du
 * code synchrone (un contexte d'invocation, par exemple) sans faire une requête,
 * puis de la valider une seule fois, au bon endroit.
 */
export function projectScope(projectId) {
  const id = String(projectId ?? '').trim();
  if (!id) {
    throw ApiError.badRequest(
      SCOPE_ERROR_CODES.INCOHERENT,
      'Une portée PROJECT exige un identifiant de projet.',
    );
  }
  return Object.freeze({ scopeType: SCOPE_TYPES.PROJECT, scopeId: id });
}

/**
 * NORMALISE une portée reçue en pièces détachées.
 *
 * Le défaut est `PANEL` — et il est sûr : une portée absente désigne le contenu
 * de L.Y Solution, jamais celui d'un client. Le défaut inverse aurait fait
 * qu'un paramètre oublié écrive chez quelqu'un.
 */
export function normalizeScope(input = {}) {
  /**
   * L'ANCIENNE FORME EST REFUSÉE BRUYAMMENT, PAS TRADUITE.
   *
   * Avant L11.1, la portée s'écrivait `{ projectId }`. Accepter cette forme
   * « par gentillesse » serait le pire des choix : `{ projectId: '<un client>' }`
   * n'a pas de `scopeType`, retomberait donc sur le défaut PANEL, et un
   * appelant non migré écrirait chez L.Y Solution en croyant écrire chez son
   * client — silencieusement. Un refus franc fait échouer le test, pas la
   * production.
   */
  if (Object.prototype.hasOwnProperty.call(input ?? {}, 'projectId')) {
    throw ApiError.badRequest(
      SCOPE_ERROR_CODES.INVALID,
      'Forme de portée obsolète : `{ projectId }`. Utilisez `panelScope()` ou `projectScope(id)` — '
      + 'une portée se construit, elle ne se devine pas depuis un identifiant nu.',
    );
  }

  const { scopeType, scopeId = null } = input ?? {};
  const type = String(scopeType ?? SCOPE_TYPES.PANEL).trim().toUpperCase();

  if (!SCOPE_TYPE_VALUES.includes(type)) {
    throw ApiError.badRequest(
      SCOPE_ERROR_CODES.INVALID,
      `Portée inconnue : « ${scopeType} ». Portées servies : ${SCOPE_TYPE_VALUES.join(', ')}.`,
    );
  }

  if (type === SCOPE_TYPES.PANEL) {
    // Une portée PANEL accompagnée d'un projet est une contradiction, pas une
    // précision. On refuse plutôt que d'ignorer : ignorer ferait croire à
    // l'appelant qu'il a écrit chez le projet.
    if (scopeId !== null && scopeId !== undefined && String(scopeId).trim() !== '') {
      throw ApiError.badRequest(
        SCOPE_ERROR_CODES.INCOHERENT,
        'La portée PANEL ne porte aucun projet : le contenu de L.Y Solution est unique pour le parc.',
      );
    }
    return panelScope();
  }

  return projectScope(scopeId);
}

/**
 * La portée EST-ELLE COHÉRENTE avec l'identifiant qu'elle porte ?
 *
 * Invariant unique du modèle de données, vérifié à chaque écriture et à chaque
 * relecture d'un document : `PANEL ⇔ projectId null`. Une base à moitié migrée,
 * une écriture manuelle ou un backfill interrompu se signalent ici plutôt que de
 * produire un document que le résolveur ne retrouvera jamais.
 */
export function assertScopeCoherent(scope) {
  /**
   * L'ANCIENNE FORME EST REFUSÉE ICI AUSSI — et c'est ici qu'il fallait la
   * mettre.
   *
   * `assertScopeCoherent` est le passage obligé de TOUTES les opérations
   * scopées ; `normalizeScope` ne l'est que pour celles qui viennent du réseau.
   * Un appelant interne non migré qui passerait `{ projectId }` à
   * `resolveTemplate` aurait donc échappé au garde-fou, avec un message générique
   * « portée incohérente » qui ne dit pas quoi corriger.
   */
  if (scope && Object.prototype.hasOwnProperty.call(scope, 'projectId')) {
    throw ApiError.badRequest(
      SCOPE_ERROR_CODES.INVALID,
      'Forme de portée obsolète : `{ projectId }`. Utilisez `panelScope()` ou `projectScope(id)` — '
      + 'une portée se construit, elle ne se devine pas depuis un identifiant nu.',
    );
  }

  const { scopeType, scopeId } = scope ?? {};
  const coherent = scopeType === SCOPE_TYPES.PANEL
    ? scopeId === null
    : scopeType === SCOPE_TYPES.PROJECT && typeof scopeId === 'string' && scopeId.length > 0;

  if (!coherent) {
    throw ApiError.badRequest(
      SCOPE_ERROR_CODES.INCOHERENT,
      `Portée incohérente : scopeType=${scopeType ?? '(absent)'}, scopeId=${scopeId ?? 'null'}.`,
    );
  }
  return scope;
}

/**
 * LA PORTÉE EST-ELLE UTILISABLE ? — la seule garde qui interroge le registre.
 *
 * ── POURQUOI VALIDER LE PROJET, ET PAS SEULEMENT LA FORME ─────────────────
 *
 * Sans elle, un DEV du Panel pourrait écrire un template pour `PROJECT/typo` :
 * le document existerait, ne serait servi à personne, et n'apparaîtrait dans
 * aucun écran filtré par projet. Ce serait exactement la « ligne fantôme » que
 * l'audit décrivait comme irréversible depuis l'IHM (incohérence n°5), sous une
 * autre forme.
 */
export async function assertScopeUsable(scope) {
  assertScopeCoherent(scope);
  if (scope.scopeType === SCOPE_TYPES.PANEL) return scope;

  const known = await PanelProject.exists({ projectId: scope.scopeId });
  if (!known) {
    throw ApiError.notFound(
      SCOPE_ERROR_CODES.PROJECT_UNKNOWN,
      `Aucun projet « ${scope.scopeId} » au registre : aucune portée ne peut lui être ouverte.`,
    );
  }
  return scope;
}

/**
 * Le FILTRE MONGO d'une portée — la seule traduction portée → colonnes.
 *
 * Elle est ici, et nulle part ailleurs. Le jour où `projectId` deviendra
 * `scopeId` en base, ce sont ces quatre lignes qui changeront, et rien d'autre.
 */
export function scopeFilter(scope) {
  assertScopeCoherent(scope);
  return { scopeType: scope.scopeType, projectId: scope.scopeId };
}

/**
 * Les colonnes de portée à ÉCRIRE. Identiques au filtre, et c'est voulu : un
 * document doit être retrouvé par la clé qui l'a écrit, sans conversion.
 */
export function scopeColumns(scope) {
  return scopeFilter(scope);
}

/** Reconstruit une portée depuis un document lu en base. */
export function scopeOfDocument(document) {
  const scopeType = document?.scopeType
    // Document antérieur au backfill : la convention historique est déterministe.
    ?? (document?.projectId ? SCOPE_TYPES.PROJECT : SCOPE_TYPES.PANEL);
  return normalizeScope({ scopeType, scopeId: document?.projectId ?? null });
}

/**
 * LA PORTÉE D'UN ENVOI, DÉDUITE DU CONTEXTE D'INVOCATION — jamais du corps.
 *
 * C'est la fonction qui ferme la Phase 7 du lot. Le projet demande un CODE ; la
 * portée est reconstituée ici, à partir du `projectId` que le jeton de pont a
 * prouvé (`buildInvocationContext` → `assertProjectScope`). Il n'y a aucun
 * paramètre par lequel un appelant pourrait proposer autre chose.
 *
 * `context.projectId === null` signifie « le Panel écrit pour lui-même »
 * (`PANEL_SELF`) : c'est la seule origine d'une portée PANEL à l'envoi.
 */
export function scopeOfInvocationContext(context) {
  return context?.projectId === null || context?.projectId === undefined
    ? panelScope()
    : projectScope(context.projectId);
}

/** Libellé court d'une portée — journaux, messages d'erreur, écrans. */
export function describeScope(scope) {
  assertScopeCoherent(scope);
  return scope.scopeType === SCOPE_TYPES.PANEL
    ? 'PANEL'
    : `PROJECT/${scope.scopeId}`;
}

/**
 * Deux portées désignent-elles le MÊME document ?
 *
 * Utilisée par les gardes d'isolation : un projet qui demande à restaurer une
 * version compare la portée de sa requête à la portée que son jeton autorise.
 */
export function sameScope(a, b) {
  return a?.scopeType === b?.scopeType && (a?.scopeId ?? null) === (b?.scopeId ?? null);
}

/**
 * LE CORPS N'EST PAS UNE AUTORITÉ — refus explicite, jamais un silence.
 *
 * ── POURQUOI REFUSER PLUTÔT QU'IGNORER (Phase 0.1) ────────────────────────
 *
 * L'audit a montré qu'un `PUT` pouvait porter `{"projectId":"x"}` et créer un
 * document invisible de l'IHM mais servi par le runtime. Le premier réflexe est
 * de retirer le champ du corps : c'est insuffisant. Un corps ignoré en silence
 * laisse l'appelant croire qu'il a agi — et le jour où quelqu'un rebranche le
 * champ « parce qu'il était déjà envoyé », la faille revient.
 *
 * On refuse donc l'appel entier. Un client correct n'envoie pas ces champs ; un
 * client qui les envoie a une intention, et cette intention doit être visible
 * dans un journal.
 */
export const SCOPE_FIELDS_FORBIDDEN_IN_BODY = Object.freeze([
  'projectId', 'project_id', 'projectKey', 'scopeId', 'scope_id', 'scopeType', 'scope_type', 'scope',
]);

export function assertNoScopeInBody(body = {}) {
  const found = SCOPE_FIELDS_FORBIDDEN_IN_BODY
    .filter((field) => Object.prototype.hasOwnProperty.call(body ?? {}, field));

  if (found.length) {
    throw ApiError.badRequest(
      SCOPE_ERROR_CODES.IN_BODY,
      'La portée d’un modèle ne se déclare pas dans le corps : elle est déterminée par la route '
      + `et l’authentification. Champs refusés : ${found.join(', ')}.`,
    );
  }
  return body;
}

export default {
  SCOPE_TYPES,
  SCOPE_TYPE_VALUES,
  SCOPE_ERROR_CODES,
  SCOPE_FIELDS_FORBIDDEN_IN_BODY,
  assertNoScopeInBody,
  assertScopeCoherent,
  assertScopeUsable,
  describeScope,
  normalizeScope,
  panelScope,
  projectScope,
  sameScope,
  scopeColumns,
  scopeFilter,
  scopeOfDocument,
  scopeOfInvocationContext,
};
