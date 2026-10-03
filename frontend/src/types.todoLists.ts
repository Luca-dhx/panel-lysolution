/**
 * LES TO-DO LISTS — ce que l'écran reçoit du serveur.
 *
 * `date` est un jour civil `AAAA-MM-JJ`, jamais un instant : une liste « du 14 »
 * reste celle du 14 quel que soit le fuseau du serveur ou du navigateur.
 *
 * L'avancement n'y est pas : il se recalcule à chaque rendu depuis `items`
 * (`lib/todoLists.ts`), ce qui le garde juste pendant qu'on coche.
 */

export type TodoListColor = 'brand' | 'blue' | 'green' | 'orange' | 'pink' | 'purple' | 'gray';

export const TODO_LIST_COLORS: TodoListColor[] = ['brand', 'blue', 'green', 'orange', 'pink', 'purple', 'gray'];

export interface TodoItem {
  id: string;
  label: string;
  done: boolean;
  doneAt?: string | null;
  doneBy?: string | null;
}

export interface TodoList {
  _id: string;
  title: string;
  description: string;
  date: string;
  color: TodoListColor;
  items: TodoItem[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TodoListInput {
  title?: string;
  description?: string;
  date?: string;
  color?: TodoListColor;
  items?: Pick<TodoItem, 'id' | 'label' | 'done'>[];
}
