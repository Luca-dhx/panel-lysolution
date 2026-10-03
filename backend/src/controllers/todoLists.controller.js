/**
 * LES TO-DO LISTS — surface HTTP.
 *
 * Deux gestes d'écriture, et ce n'est pas une redondance : `PATCH` remplace la
 * liste depuis l'écran d'édition, `PATCH /items/:itemId` coche UNE case sans
 * toucher aux autres. Voir le service.
 */
import { created, ok } from '../utils/apiResponse.js';
import {
  createTodoList,
  deleteTodoList,
  describeTodoList,
  listTodoLists,
  toggleTodoItem,
  updateTodoList,
} from '../services/todoLists/todoLists.service.js';

const actorOf = (req) => ({
  email: req.panelUser?.email ?? null,
  role: req.panelUser?.role ?? null,
});

export async function list(req, res) {
  const { from = null, to = null } = req.query ?? {};
  return ok(res, { todoLists: await listTodoLists({ from, to }) });
}

export async function detail(req, res) {
  return ok(res, { todoList: await describeTodoList(req.params.listId) });
}

export async function create(req, res) {
  return created(res, { todoList: await createTodoList(req.body ?? {}, actorOf(req)) });
}

export async function update(req, res) {
  return ok(res, { todoList: await updateTodoList(req.params.listId, req.body ?? {}, actorOf(req)) });
}

export async function toggleItem(req, res) {
  return ok(res, {
    todoList: await toggleTodoItem(req.params.listId, req.params.itemId, req.body ?? {}, actorOf(req)),
  });
}

export async function remove(req, res) {
  return ok(res, await deleteTodoList(req.params.listId));
}
