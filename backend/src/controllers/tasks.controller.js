/**
 * LES TÂCHES — surface HTTP.
 *
 * Deux gestes distincts pour l'échéance, et ce n'est pas une redondance :
 * `PATCH` CORRIGE une date mal saisie, `POST /postpone` la DÉCALE et laisse une
 * trace. Confondre les deux ferait apparaître un report là où il n'y a qu'une
 * faute de frappe corrigée, ou l'inverse — et une tâche reportée quatre fois
 * raconte quelque chose que la nouvelle date, seule, ne raconte pas.
 */
import { created, ok } from '../utils/apiResponse.js';
import {
  completeTask,
  createTask,
  deleteTask,
  describeTask,
  listTasks,
  postponeTask,
  reopenTask,
  summarizeTasks,
  updateTask,
} from '../services/tasks/tasks.service.js';

/** L'auteur d'une décision. Jamais anonyme. */
const actorOf = (req) => ({
  email: req.panelUser?.email ?? null,
  role: req.panelUser?.role ?? null,
});

export async function list(req, res) {
  const {
    status = null, projectId = null, prospectId = null,
    transactionId = null, clientCompanyId = null,
  } = req.query ?? {};
  const [tasks, summary] = await Promise.all([
    listTasks({ status, projectId, prospectId, transactionId, clientCompanyId }),
    summarizeTasks(),
  ]);
  return ok(res, { tasks, summary });
}

export async function detail(req, res) {
  return ok(res, { task: await describeTask(req.params.taskId) });
}

export async function create(req, res) {
  return created(res, { task: await createTask(req.body ?? {}, actorOf(req)) });
}

export async function update(req, res) {
  return ok(res, { task: await updateTask(req.params.taskId, req.body ?? {}, actorOf(req)) });
}

export async function complete(req, res) {
  return ok(res, { task: await completeTask(req.params.taskId, actorOf(req)) });
}

export async function reopen(req, res) {
  return ok(res, { task: await reopenTask(req.params.taskId, actorOf(req)) });
}

export async function postpone(req, res) {
  return ok(res, { task: await postponeTask(req.params.taskId, req.body ?? {}, actorOf(req)) });
}

export async function remove(req, res) {
  return ok(res, await deleteTask(req.params.taskId));
}
