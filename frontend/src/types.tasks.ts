/**
 * LES TÂCHES — ce que l'écran reçoit du serveur.
 *
 * ══ CE QUI N'EST PAS DANS CE FICHIER, ET POURQUOI ═══════════════════════════
 *
 * « En retard » n'y est pas. C'est une comparaison entre une échéance et
 * l'instant présent : la figer dans une réponse HTTP donnerait une valeur
 * périmée dès l'envoi — une tâche due dans deux minutes serait annoncée
 * « à l'heure » deux minutes de trop. L'écran compare, et il recommence à
 * chaque seconde qui passe (`lib/taskTime.ts`).
 *
 * Les NOMS des éléments rattachés n'y sont pas non plus. Une tâche porte des
 * identifiants, jamais des libellés recopiés : un projet renommé doit se lire
 * sous son nouveau nom, y compris depuis une tâche écrite il y a six mois.
 */

export type TaskStatus = 'OPEN' | 'DONE';

export interface Subtask {
  id: string;
  name: string;
  description: string;
  done: boolean;
}

/**
 * LES QUATRE FAMILLES DE RATTACHEMENT.
 *
 * Chacune est une liste, et chacune peut être vide : une tâche qui ne se
 * rattache à rien reste une tâche.
 */
export interface TaskLinks {
  projectIds: string[];
  prospectIds: string[];
  transactionIds: string[];
  clientCompanyIds: string[];
}

export interface TaskPostponement {
  at: string;
  from: string | null;
  to: string | null;
  actorEmail: string | null;
}

export interface Task {
  _id: string;
  name: string;
  description: string;
  subtasks: Subtask[];
  links: TaskLinks;
  /** `null` = sans échéance. Un état de plein droit, pas un oubli. */
  dueAt: string | null;
  status: TaskStatus;
  completedAt: string | null;
  completedBy: string | null;
  postponements: TaskPostponement[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInput {
  name?: string;
  description?: string;
  subtasks?: Subtask[];
  links?: Partial<TaskLinks>;
  dueAt?: string | null;
  status?: TaskStatus;
}

export interface TaskSummary {
  open: number;
  /** Ouvertes dont l'échéance est passée, à l'instant du calcul serveur. */
  overdue: number;
  dueSoon: number;
  undated: number;
  horizonDays: number;
}

export interface TaskListResult {
  tasks: Task[];
  summary: TaskSummary;
}

/** Les quatre familles, dans l'ordre où les écrans les présentent. */
export const TASK_LINK_KINDS = [
  'projectIds', 'prospectIds', 'clientCompanyIds', 'transactionIds',
] as const;

export type TaskLinkKind = (typeof TASK_LINK_KINDS)[number];

export const TASK_LINK_LABELS: Record<TaskLinkKind, { singulier: string; pluriel: string }> = {
  projectIds: { singulier: 'Projet', pluriel: 'Projets' },
  prospectIds: { singulier: 'Prospect', pluriel: 'Prospects' },
  clientCompanyIds: { singulier: 'Entreprise cliente', pluriel: 'Entreprises clientes' },
  transactionIds: { singulier: 'Mouvement', pluriel: 'Mouvements' },
};

export const EMPTY_LINKS: TaskLinks = {
  projectIds: [], prospectIds: [], transactionIds: [], clientCompanyIds: [],
};
