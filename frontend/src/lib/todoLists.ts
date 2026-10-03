/**
 * LES TO-DO LISTS — jours, avancement, couleurs.
 *
 * ══ UN JOUR EST UNE CLEF `AAAA-MM-JJ`, CALCULÉE EN HEURE LOCALE ════════════
 *
 * `toISOString()` rend l'heure UTC : à Paris, avant 2 h du matin en été, il
 * donnerait la date de la veille. Les clefs sont donc composées à la main
 * depuis `getFullYear/getMonth/getDate`, et relues sans passer par `Date.parse`
 * (qui lirait « 2026-10-14 » comme minuit UTC, soit le 13 au soir ailleurs).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { TodoItem, TodoList, TodoListColor } from '@/types.todoLists';

export function clefJour(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function jourDepuisClef(clef: string): Date {
  const [a, m, j] = clef.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(a, (m || 1) - 1, j || 1);
}

export function decalerJour(clef: string, jours: number): string {
  const d = jourDepuisClef(clef);
  d.setDate(d.getDate() + jours);
  return clefJour(d);
}

const LONG = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const COURT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/** La date en toutes lettres, sans relatif : « Jeudi 14 octobre 2026 ». */
export function dateCivile(clef: string, court = false): string {
  const texte = (court ? COURT : LONG).format(jourDepuisClef(clef));
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

/** « Aujourd'hui », « Demain », « Hier » — ou `null` pour tout autre jour. */
export function jourRelatif(clef: string, aujourdHui = clefJour(new Date())): string | null {
  if (clef === aujourdHui) return 'Aujourd’hui';
  if (clef === decalerJour(aujourdHui, 1)) return 'Demain';
  if (clef === decalerJour(aujourdHui, -1)) return 'Hier';
  return null;
}

/** « Aujourd'hui », « Demain », « Hier », sinon la date en toutes lettres. */
export function libelleJour(clef: string, aujourdHui = clefJour(new Date()), court = false): string {
  return jourRelatif(clef, aujourdHui) ?? dateCivile(clef, court);
}

export interface Avancement {
  faits: number;
  total: number;
  /** 0 à 100, entier. Une liste vide vaut 0 : rien n'est fait tant que rien n'est prévu. */
  pourcentage: number;
  complete: boolean;
}

export function avancement(items: Pick<TodoItem, 'done'>[]): Avancement {
  const total = items.length;
  const faits = items.filter((i) => i.done).length;
  const pourcentage = total === 0 ? 0 : Math.round((faits * 100) / total);
  return { faits, total, pourcentage, complete: total > 0 && faits === total };
}

/**
 * LES TEINTES D'UNE LISTE.
 *
 * Toutes passent par les échelles `utility-*` du thème : changer le thème du
 * Panel les repeint avec le reste. Les classes sont écrites EN ENTIER, jamais
 * composées (`bg-utility-${c}-500`) : Tailwind ne génère que ce qu'il lit.
 */
export const TEINTES: Record<TodoListColor, { pastille: string; barre: string; fond: string; texte: string; nom: string }> = {
  brand: { pastille: 'bg-utility-brand-500', barre: 'bg-utility-brand-500', fond: 'bg-utility-brand-50', texte: 'text-utility-brand-700', nom: 'Marque' },
  blue: { pastille: 'bg-utility-blue-500', barre: 'bg-utility-blue-500', fond: 'bg-utility-blue-50', texte: 'text-utility-blue-700', nom: 'Bleu' },
  green: { pastille: 'bg-utility-green-500', barre: 'bg-utility-green-500', fond: 'bg-utility-green-50', texte: 'text-utility-green-700', nom: 'Vert' },
  orange: { pastille: 'bg-utility-orange-500', barre: 'bg-utility-orange-500', fond: 'bg-utility-orange-50', texte: 'text-utility-orange-700', nom: 'Orange' },
  pink: { pastille: 'bg-utility-pink-500', barre: 'bg-utility-pink-500', fond: 'bg-utility-pink-50', texte: 'text-utility-pink-700', nom: 'Rose' },
  purple: { pastille: 'bg-utility-purple-500', barre: 'bg-utility-purple-500', fond: 'bg-utility-purple-50', texte: 'text-utility-purple-700', nom: 'Violet' },
  gray: { pastille: 'bg-utility-neutral-500', barre: 'bg-utility-neutral-500', fond: 'bg-utility-neutral-50', texte: 'text-utility-neutral-700', nom: 'Gris' },
};

const RAFRAICHIR_MS = 30_000;

/**
 * TOUTES LES LISTES, AVEC UNE COCHE INSTANTANÉE.
 *
 * ══ OPTIMISTE, ET RÉVERSIBLE ════════════════════════════════════════════════
 *
 * La case se coche et la barre avance AU CLIC, sans attendre le serveur : une
 * coche qui met 300 ms à apparaître se lit comme un clic raté, et on reclique.
 * Si le serveur refuse, l'état d'avant revient et l'erreur est remontée.
 *
 * Le rafraîchissement périodique est SUSPENDU tant qu'une coche est en vol :
 * sinon une réponse de liste partie avant la coche l'effacerait à l'écran.
 */
export function useTodoLists() {
  const [listes, setListes] = useState<TodoList[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const enVol = useRef(0);

  const recharger = useCallback(async () => {
    if (enVol.current > 0) return;
    try {
      const { todoLists } = await api.listTodoLists();
      if (enVol.current === 0) setListes(todoLists);
      setErreur(null);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Impossible de charger les to-do lists.');
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void recharger();
    const minuterie = window.setInterval(() => {
      if (document.visibilityState === 'visible') void recharger();
    }, RAFRAICHIR_MS);
    return () => window.clearInterval(minuterie);
  }, [recharger]);

  const remplacer = (liste: TodoList) => setListes(
    (courantes) => courantes.map((l) => (l._id === liste._id ? liste : l)),
  );

  const cocher = useCallback(async (listId: string, itemId: string, done: boolean) => {
    let avant: TodoList | undefined;
    setListes((courantes) => courantes.map((l) => {
      if (l._id !== listId) return l;
      avant = l;
      return { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done } : i)) };
    }));
    enVol.current += 1;
    try {
      const { todoList } = await api.toggleTodoItem(listId, itemId, done);
      /* Seul l'élément cliqué est repris de la réponse : un autre clic a pu
         partir entre-temps, et la réponse ne le connaît pas encore. */
      setListes((courantes) => courantes.map((l) => {
        if (l._id !== listId) return l;
        const serveur = todoList.items.find((i) => i.id === itemId);
        return serveur ? { ...l, items: l.items.map((i) => (i.id === itemId ? serveur : i)) } : l;
      }));
    } catch (e) {
      if (avant) {
        const restaure = avant.items.find((i) => i.id === itemId);
        setListes((courantes) => courantes.map((l) => (
          l._id === listId && restaure
            ? { ...l, items: l.items.map((i) => (i.id === itemId ? restaure : i)) }
            : l
        )));
      }
      throw e;
    } finally {
      enVol.current -= 1;
    }
  }, []);

  const supprimer = useCallback(async (listId: string) => {
    await api.deleteTodoList(listId);
    setListes((courantes) => courantes.filter((l) => l._id !== listId));
  }, []);

  return { listes, chargement, erreur, recharger, cocher, supprimer, remplacer };
}
