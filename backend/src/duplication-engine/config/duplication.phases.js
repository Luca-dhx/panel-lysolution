/**
 * LE REGISTRE CANONIQUE DES PHASES DE DUPLICATION — source de vérité UNIQUE.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * Une phase de duplication était définie à TROIS endroits, et aucun des trois
 * ne savait qu'il n'était pas seul :
 *
 *   · le MOTEUR l'émettait, par des chaînes littérales dispersées dans le
 *     pipeline (`onPhase({ phase: 'copy', … })`) ;
 *   · `friendly.ts`, côté Manager, en tenait la liste — donc l'ORDRE,
 *     l'EXISTENCE et les LIBELLÉS — avec les trois sous-projets Node écrits à
 *     la main (`dependencies.backend`, `.manager`, `.vitrine`) alors que le
 *     moteur les DÉCOUVRE ;
 *   · `DuplicateAssistant` reconstruisait l'identifiant d'instance par un
 *     switch parallèle, et traduisait `failed` en `error` parce que les deux
 *     mots coexistaient sur le fil.
 *
 * Conséquence observée : la checklist affichait des lignes qui ne recevaient
 * plus jamais d'événement, et le contrôle de gouvernance comparait ces
 * identifiants à l'ordre canonique du moteur de DÉPLOIEMENT — une autre
 * architecture. Personne ne mentait ; il y avait simplement trois vérités.
 *
 * ══ CE QUE CE MODULE ÉTABLIT ════════════════════════════════════════════════
 *
 * Une phase est DÉFINIE ici, et seulement ici. Tout le reste en dérive :
 * l'ordre, les libellés, la checklist du Manager, la validation du flux, le
 * rapport final et les gardes d'architecture.
 *
 * La DÉFINITION (ce qu'est une phase) et l'EXÉCUTION (ce qui lui arrive) sont
 * séparées : un événement ne transporte JAMAIS de `label` ni d'`order`. Les
 * transporter recréerait deux vérités — et c'est toujours l'événement qui
 * gagnerait, puisqu'il arrive en dernier.
 *
 * ══ AJOUTER UNE PHASE ═══════════════════════════════════════════════════════
 *
 * Une seule modification : une entrée ici. Le moteur peut alors l'émettre, le
 * Manager l'affiche, le rapport la liste, et la garde de gouvernance l'exige.
 * Émettre une phase absente d'ici lève — au point d'émission, pas trois écrans
 * plus loin.
 */

/**
 * LES ÉTATS D'UNE PHASE. Fermés, et volontairement peu nombreux.
 *
 * `failed` a existé, en parallèle de `error`, sur le même fil : le Manager
 * traduisait l'un en l'autre. Deux mots pour un état, c'est déjà une seconde
 * vérité — il n'en reste qu'un.
 */
export const PHASE_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  OK: 'ok',
  ERROR: 'error',
  /**
   * PASSÉE, ET NON EXÉCUTÉE. Une phase qui n'avait rien à faire n'est PAS
   * réussie : afficher `ok` sur une installation qui n'a jamais eu lieu ferait
   * croire à une garantie qu'on n'a pas.
   */
  SKIPPED: 'skipped',
});

export const PHASE_STATUS_VALUES = Object.freeze(Object.values(PHASE_STATUS));

/** Familles d'affichage. Sert à grouper un écran, jamais à décider. */
export const PHASE_GROUPS = Object.freeze({
  DATABASE: 'database',
  IDENTITY: 'identity',
  FILES: 'files',
  NODE: 'node',
  RESULT: 'result',
});

/**
 * ══ LE REGISTRE ═════════════════════════════════════════════════════════════
 *
 * `order` est explicite et espacé de 10 : insérer une phase entre deux autres
 * ne doit pas obliger à renuméroter la liste — c'est exactement le genre de
 * modification en cascade qui finit par être faite à moitié.
 *
 * `dynamic` distingue les deux natures de phase :
 *
 *   · STATIQUE : elle a lieu une fois. `copy`, `first_admin`.
 *   · DYNAMIQUE : elle a lieu une fois PAR CIBLE découverte à l'exécution.
 *     `dependencies` s'exécute pour chaque sous-projet Node réellement trouvé.
 *     Le registre déclare la FAMILLE ; le nombre d'instances appartient au
 *     runtime. C'est ce que l'ancienne liste ignorait en écrivant « backend,
 *     manager, vitrine » en dur : elle affirmait une composition de projet que
 *     personne ne garantit.
 *
 * `required` dit qu'une duplication ne peut pas être déclarée réussie sans
 * cette phase. Une famille dynamique sans aucune cible est `skipped`, jamais
 * `ok` — l'absence de travail n'est pas un travail réussi.
 */
export const DUPLICATION_PHASES = Object.freeze([
  {
    id: 'mongo',
    order: 10,
    label: 'Vérification MongoDB',
    icon: 'Database',
    group: PHASE_GROUPS.DATABASE,
    dynamic: false,
    required: true,
    blocking: true,
  },
  {
    id: 'databases',
    order: 20,
    label: 'Préparation des bases',
    icon: 'DatabaseZap',
    group: PHASE_GROUPS.DATABASE,
    dynamic: false,
    required: true,
    blocking: true,
  },
  {
    /**
     * L'ACCÈS HUMAIN AU PROJET LIVRÉ.
     *
     * Placée au plus tôt : un mot de passe refusé ou une base injoignable doit
     * coûter quelques secondes, et non se découvrir après trois minutes
     * d'installation, sur un dossier qu'il faudra supprimer.
     */
    id: 'first_admin',
    order: 30,
    label: 'Premier administrateur créé',
    icon: 'UserPlus',
    group: PHASE_GROUPS.IDENTITY,
    dynamic: false,
    required: true,
    blocking: true,
  },
  {
    id: 'copy',
    order: 40,
    label: 'Copie des fichiers',
    icon: 'Copy',
    group: PHASE_GROUPS.FILES,
    dynamic: false,
    required: true,
    blocking: true,
  },
  {
    id: 'config',
    order: 50,
    label: 'Configuration du projet',
    icon: 'Settings2',
    group: PHASE_GROUPS.FILES,
    dynamic: false,
    required: true,
    blocking: true,
  },
  {
    /**
     * LA COPIE EST-ELLE PROPRE ? — la seule phase qui relit ce qui a été fait.
     *
     * ══ POURQUOI ELLE EXISTE, ET POURQUOI ICI ═════════════════════════════
     *
     * Les phases précédentes DÉCLARENT : on exclut des dossiers, on réécrit une
     * identité. Une exclusion qui rate et une réécriture qui n'ancre pas
     * échouent en silence — et la première duplication réelle a livré un clone
     * portant 7 006 documents contractuels du client source, sans qu'une seule
     * ligne de journal s'en émeuve.
     *
     * Elle vient APRÈS `config` parce qu'elle contrôle les deux à la fois : ce
     * qui n'aurait pas dû être copié, et ce qui aurait dû être renommé. Elle
     * vient AVANT `dependencies` parce qu'il est absurde de passer trois
     * minutes à installer un dossier qu'on va jeter.
     *
     * Bloquante, évidemment : c'est tout son objet.
     */
    id: 'cleanliness',
    order: 55,
    label: 'Contrôle de propreté du clone',
    icon: 'ShieldCheck',
    group: PHASE_GROUPS.FILES,
    dynamic: false,
    required: true,
    blocking: true,
  },
  {
    id: 'discover',
    order: 60,
    label: 'Détection des sous-projets',
    icon: 'FolderCog',
    group: PHASE_GROUPS.NODE,
    dynamic: true,
    required: true,
    blocking: true,
  },
  {
    id: 'dependencies',
    order: 70,
    label: 'Installation des dépendances',
    icon: 'FolderCog',
    group: PHASE_GROUPS.NODE,
    dynamic: true,
    required: true,
    blocking: true,
  },
  {
    id: 'validate',
    order: 80,
    label: 'Validation',
    icon: 'BadgeCheck',
    group: PHASE_GROUPS.NODE,
    dynamic: true,
    required: true,
    blocking: true,
  },
  {
    id: 'done',
    order: 90,
    label: 'Projet prêt',
    icon: 'PartyPopper',
    group: PHASE_GROUPS.RESULT,
    dynamic: false,
    required: true,
    blocking: false,
  },
]);

/** Les identifiants, dans l'ordre canonique. UNE seule liste d'ordre existe. */
export const DUPLICATION_PHASE_ORDER = Object.freeze(
  [...DUPLICATION_PHASES].sort((a, b) => a.order - b.order).map((p) => p.id)
);

const PAR_ID = new Map(DUPLICATION_PHASES.map((p) => [p.id, p]));

export function isKnownPhase(id) {
  return PAR_ID.has(id);
}

export function phaseDefinition(id) {
  return PAR_ID.get(id) || null;
}

/**
 * Refuse une phase hors registre. Appelée AU POINT D'ÉMISSION : un identifiant
 * inventé doit faire échouer la duplication qui l'invente, pas s'évanouir dans
 * une interface qui ne sait pas quoi en faire.
 */
export function assertKnownPhase(id) {
  const definition = phaseDefinition(id);
  if (!definition) {
    throw new Error(
      `Phase de duplication inconnue : « ${id} ». Déclarez-la dans `
        + 'duplication-engine/config/duplication.phases.js — nulle part ailleurs.'
    );
  }
  return definition;
}

export function assertKnownStatus(status) {
  if (!PHASE_STATUS_VALUES.includes(status)) {
    throw new Error(
      `Statut de phase inconnu : « ${status} ». Attendu : ${PHASE_STATUS_VALUES.join(' | ')}.`
    );
  }
  return status;
}

/**
 * LA CLÉ D'UNE INSTANCE — `dependencies:backend`.
 *
 * Le séparateur est `:` et non `.`, et ce n'est pas cosmétique : une cible est
 * un CHEMIN relatif (`backend`, mais aussi `apps/web` ou `.`), et un point y
 * est un caractère légitime. L'ancienne convention `dependencies.backend`
 * devenait ambiguë dès la première arborescence un peu profonde.
 */
export function phaseKey(id, target = null) {
  return target ? `${id}:${target}` : id;
}

/**
 * LA PROJECTION PUBLIQUE — ce que le Manager consomme.
 *
 * Aucune logique, aucun secret : la définition, telle quelle. C'est elle qui
 * remplace la liste écrite à la main côté Manager, et c'est pourquoi elle ne
 * doit rien contenir que le registre n'ait déclaré.
 */
export function describeDuplicationPhases() {
  return DUPLICATION_PHASES.map(({ id, order, label, icon, group, dynamic, required, blocking }) => ({
    id, order, label, icon, group, dynamic, required, blocking,
  }));
}

export default {
  DUPLICATION_PHASES,
  DUPLICATION_PHASE_ORDER,
  PHASE_STATUS,
  PHASE_STATUS_VALUES,
  PHASE_GROUPS,
  isKnownPhase,
  phaseDefinition,
  assertKnownPhase,
  assertKnownStatus,
  phaseKey,
  describeDuplicationPhases,
};
