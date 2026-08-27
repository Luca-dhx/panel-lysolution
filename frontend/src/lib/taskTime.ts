/**
 * LE TEMPS QUI RESTE, ET CE QU'IL FAUT EN MONTRER.
 *
 * ══ POURQUOI CE CALCUL EST ICI, ET PAS SUR LE SERVEUR ═══════════════════════
 *
 * « En retard » est une comparaison entre une échéance et l'instant présent.
 * La figer dans une réponse HTTP donnerait une valeur périmée dès l'envoi :
 * une tâche due dans deux minutes serait annoncée « à l'heure » deux minutes
 * de trop, puis « à l'heure » encore, jusqu'au prochain rafraîchissement.
 *
 * Le serveur compte les retards (un nombre, pour le badge) ; l'écran, lui,
 * recalcule l'urgence de chaque tâche à chaque battement d'horloge. Les deux
 * répondent à deux questions différentes.
 *
 * ══ POURQUOI CES FONCTIONS SONT PURES ══════════════════════════════════════
 *
 * `maintenant` est un paramètre, jamais `Date.now()` lu à l'intérieur. Sans
 * cela, aucune de ces règles ne serait éprouvable : on ne peut pas écrire une
 * recette sur « dans deux heures » si l'heure change à chaque exécution.
 */

/**
 * LES CINQ DEGRÉS D'URGENCE.
 *
 * Ils ne sont pas décoratifs : chacun répond à « qu'est-ce que je fais de cette
 * ligne, maintenant ? ».
 *
 *   `none`      pas d'échéance. Rien à décider aujourd'hui.
 *   `far`       plus de trois jours. On la voit, on ne s'en occupe pas.
 *   `soon`      moins de trois jours. Elle entre dans la semaine.
 *   `imminent`  moins de six heures. C'est aujourd'hui, et bientôt.
 *   `overdue`   l'échéance est passée. Elle demande une décision : faite, ou
 *               reportée.
 */
export type TaskUrgency = 'none' | 'far' | 'soon' | 'imminent' | 'overdue';

const HEURE_MS = 3_600_000;
const JOUR_MS = 86_400_000;

/** Le seuil « bientôt » : trois jours. Une semaine noierait le signal. */
export const SEUIL_SOON_MS = 3 * JOUR_MS;
/** Le seuil « imminent » : six heures — ce qui reste d'une journée de travail. */
export const SEUIL_IMMINENT_MS = 6 * HEURE_MS;

/**
 * L'URGENCE D'UNE TÂCHE.
 *
 * Une tâche FAITE n'est jamais urgente, même si son échéance est passée : elle
 * a été faite, en retard peut-être, mais le retard n'appelle plus rien. La
 * peindre en rouge apprendrait à ignorer le rouge.
 */
export function taskUrgency(
  dueAt: string | null,
  maintenant: number,
  status: 'OPEN' | 'DONE' = 'OPEN',
): TaskUrgency {
  if (status === 'DONE' || !dueAt) return 'none';
  const reste = new Date(dueAt).getTime() - maintenant;
  if (Number.isNaN(reste)) return 'none';
  if (reste < 0) return 'overdue';
  if (reste <= SEUIL_IMMINENT_MS) return 'imminent';
  if (reste <= SEUIL_SOON_MS) return 'soon';
  return 'far';
}

/**
 * LE COMPTE À REBOURS, EN TOUTES LETTRES.
 *
 * ══ L'UNITÉ SUIT LA DISTANCE ═══════════════════════════════════════════════
 *
 * « dans 172 800 minutes » n'aide personne. Au-delà de deux jours on compte en
 * jours, au-delà d'une heure en heures, et en dessous en minutes — c'est à ce
 * moment-là seulement que la minute devient une information.
 *
 * ══ LE RETARD SE DIT AU PASSÉ ══════════════════════════════════════════════
 *
 * « en retard de 3 h » et « dans 3 h » ne doivent pas pouvoir se confondre au
 * premier coup d'œil : ce sont deux décisions opposées.
 */
export function formatCountdown(dueAt: string | null, maintenant: number): string {
  if (!dueAt) return 'Sans échéance';
  const cible = new Date(dueAt).getTime();
  if (Number.isNaN(cible)) return 'Sans échéance';

  const delta = cible - maintenant;
  const enRetard = delta < 0;
  const reste = Math.abs(delta);

  let quantite: string;
  if (reste >= 2 * JOUR_MS) {
    quantite = `${Math.floor(reste / JOUR_MS)} j`;
  } else if (reste >= HEURE_MS) {
    const heures = Math.floor(reste / HEURE_MS);
    const minutes = Math.floor((reste % HEURE_MS) / 60_000);
    quantite = minutes ? `${heures} h ${String(minutes).padStart(2, '0')}` : `${heures} h`;
  } else {
    /* Une minute, jamais zéro : « dans 0 min » se lit comme une panne. */
    quantite = `${Math.max(1, Math.floor(reste / 60_000))} min`;
  }

  return enRetard ? `En retard de ${quantite}` : `Dans ${quantite}`;
}

/**
 * L'ÉCHÉANCE, ÉCRITE EN TOUTES LETTRES.
 *
 * Le fuseau est celui du navigateur, et c'est le bon : une échéance est un
 * rendez-vous avec soi-même, pas une écriture comptable. Elle doit se lire dans
 * l'heure de celui qui la regarde.
 */
const DATE_HEURE = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

export function formatDueAt(dueAt: string | null): string {
  if (!dueAt) return 'Sans échéance';
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return 'Sans échéance';
  return DATE_HEURE.format(date);
}

/**
 * L'AVANCEMENT DES SOUS-TÂCHES.
 *
 * `null` quand il n'y en a aucune — et non « 0 / 0 », qui se lit comme un
 * travail commencé et abandonné. Une tâche sans sous-tâche n'a pas
 * d'avancement, elle a un état.
 */
export function subtaskProgress(
  subtasks: { done: boolean }[],
): { done: number; total: number; ratio: number } | null {
  if (!subtasks.length) return null;
  const done = subtasks.filter((s) => s.done).length;
  return { done, total: subtasks.length, ratio: done / subtasks.length };
}

/**
 * LA CHRONOLOGIE D'UNE FICHE.
 *
 * ══ CE QU'ELLE RÉSOUT ══════════════════════════════════════════════════════
 *
 * Une fiche de projet ou de prospect porte des tâches datées ET des tâches sans
 * échéance. Les mélanger dans une seule liste triée par date obligerait à
 * inventer une date pour les secondes — et une date inventée remonte au milieu
 * des vraies, où elle ment.
 *
 * Elles sont donc SÉPARÉES, et l'ordre des trois groupes est celui de
 * l'attention : ce qui est en retard d'abord, ce qui vient ensuite, ce qui est
 * fait à la fin. Les tâches sans échéance forment leur propre groupe, entre
 * l'à-venir et le fait : elles ne pressent pas, mais elles ne sont pas closes.
 */
export interface TaskTimeline {
  overdue: { _id: string; dueAt: string | null; status: 'OPEN' | 'DONE' }[];
  upcoming: { _id: string; dueAt: string | null; status: 'OPEN' | 'DONE' }[];
  undated: { _id: string; dueAt: string | null; status: 'OPEN' | 'DONE' }[];
  done: { _id: string; dueAt: string | null; status: 'OPEN' | 'DONE' }[];
}

export function buildTimeline<T extends { _id: string; dueAt: string | null; status: 'OPEN' | 'DONE' }>(
  tasks: T[],
  maintenant: number,
): { overdue: T[]; upcoming: T[]; undated: T[]; done: T[] } {
  const overdue: T[] = [];
  const upcoming: T[] = [];
  const undated: T[] = [];
  const done: T[] = [];

  for (const tache of tasks) {
    if (tache.status === 'DONE') { done.push(tache); continue; }
    if (!tache.dueAt) { undated.push(tache); continue; }
    if (new Date(tache.dueAt).getTime() < maintenant) overdue.push(tache);
    else upcoming.push(tache);
  }

  const parDate = (sens: 1 | -1) => (a: T, b: T) => (
    sens * (new Date(a.dueAt ?? 0).getTime() - new Date(b.dueAt ?? 0).getTime())
  );
  /* Le retard le plus ANCIEN en tête : c'est celui qui a le plus attendu. */
  overdue.sort(parDate(1));
  /* L'à-venir le plus PROCHE en tête : c'est celui qui arrive. */
  upcoming.sort(parDate(1));
  /* Le fait le plus RÉCENT en tête : c'est celui dont on se souvient. */
  done.sort(parDate(-1));

  return { overdue, upcoming, undated, done };
}

export default {
  taskUrgency, formatCountdown, formatDueAt, subtaskProgress, buildTimeline,
};
