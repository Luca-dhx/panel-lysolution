/**
 * LES TO-DO LISTS — création, édition, et la case qu'on coche.
 *
 * ══ COCHER N'EST PAS ENREGISTRER LA LISTE ═══════════════════════════════════
 *
 * Cocher passe par sa propre opération, ATOMIQUE sur un seul élément
 * (`$set` filtré par `arrayFilters`). Renvoyer le tableau entier à chaque case,
 * comme le fait l'édition, ferait perdre une coche dès que deux personnes — ou
 * deux clics rapides dont les réponses se croisent — touchent la même liste :
 * la seconde écriture rétablirait l'état d'avant la première.
 *
 * L'édition, elle, remplace le tableau : c'est un geste délibéré, fait sur un
 * écran dédié, et l'ordre du tableau EST l'ordre affiché.
 */
import crypto from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import { PanelTodoList, TODO_LIST_COLORS } from '../../models/PanelTodoList.model.js';

const identifiant = () => crypto.randomUUID();
const texte = (valeur, defaut = '') => (
  typeof valeur === 'string' ? valeur.trim() : defaut
);

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * UN JOUR CIVIL, OU UNE ERREUR.
 *
 * `2026-02-30` a la bonne forme et n'existe pas : on le refait passer par le
 * calendrier pour le vérifier, en UTC pour que le fuseau du serveur n'y touche
 * pas.
 */
function normaliserJour(valeur, { requis = true } = {}) {
  const brut = texte(valeur);
  if (!brut && !requis) return null;
  if (!JOUR.test(brut)) {
    throw ApiError.badRequest('PANEL_TODO_DATE_INVALID', 'La date doit être un jour au format AAAA-MM-JJ.');
  }
  const d = new Date(`${brut}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== brut) {
    throw ApiError.badRequest('PANEL_TODO_DATE_INVALID', 'Cette date n’existe pas.');
  }
  return brut;
}

function normaliserCouleur(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return 'brand';
  if (!TODO_LIST_COLORS.includes(valeur)) {
    throw ApiError.badRequest('PANEL_TODO_COLOR_UNKNOWN', 'Couleur inconnue.');
  }
  return valeur;
}

/**
 * LES ÉLÉMENTS — en conservant l'histoire de ceux qui existaient.
 *
 * Un élément déjà coché garde sa date de coche quand on renomme la liste : sans
 * cela, chaque édition remettrait « coché à l'instant » sur tout ce qui l'était
 * depuis le matin. Les lignes sans libellé sont ÉCARTÉES : une ligne ajoutée
 * puis laissée vide est un geste abandonné, pas une erreur.
 */
function normaliserElements(liste, anciens = [], actor = {}) {
  if (!Array.isArray(liste)) return [];
  const parId = new Map(anciens.map((e) => [e.id, e]));
  const vus = new Set();
  return liste
    .map((brut) => {
      const label = texte(brut?.label).slice(0, 300);
      if (!label) return null;
      let id = texte(brut?.id);
      if (!id || vus.has(id)) id = identifiant();
      vus.add(id);
      const done = brut?.done === true;
      const ancien = parId.get(id);
      return {
        id,
        label,
        done,
        doneAt: done ? (ancien?.done ? ancien.doneAt : new Date()) : null,
        doneBy: done ? (ancien?.done ? ancien.doneBy : (actor.email ?? null)) : null,
      };
    })
    .filter(Boolean)
    .slice(0, 200);
}

async function chargerOuLever(listId) {
  const liste = await PanelTodoList.findById(listId).catch(() => null);
  if (!liste) throw ApiError.notFound('PANEL_TODO_NOT_FOUND', 'To-do list introuvable.');
  return liste;
}

/** Bornes facultatives, incluses — la vue calendrier demande un mois à la fois. */
export async function listTodoLists({ from = null, to = null } = {}) {
  const filtre = {};
  const debut = normaliserJour(from, { requis: false });
  const fin = normaliserJour(to, { requis: false });
  if (debut || fin) {
    filtre.date = {};
    if (debut) filtre.date.$gte = debut;
    if (fin) filtre.date.$lte = fin;
  }
  return PanelTodoList.find(filtre).sort({ date: 1, createdAt: 1 }).lean();
}

export async function describeTodoList(listId) {
  return chargerOuLever(listId);
}

export async function createTodoList(data = {}, actor = {}) {
  const title = texte(data.title).slice(0, 200);
  if (!title) throw ApiError.badRequest('PANEL_TODO_TITLE_REQUIRED', 'Un titre est requis.');
  return PanelTodoList.create({
    title,
    description: data.description === undefined ? '' : String(data.description).slice(0, 4000),
    date: normaliserJour(data.date),
    color: normaliserCouleur(data.color),
    items: normaliserElements(data.items, [], actor),
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

export async function updateTodoList(listId, data = {}, actor = {}) {
  const liste = await chargerOuLever(listId);
  if (data.title !== undefined) {
    const title = texte(data.title).slice(0, 200);
    if (!title) throw ApiError.badRequest('PANEL_TODO_TITLE_REQUIRED', 'Un titre est requis.');
    liste.title = title;
  }
  if (data.description !== undefined) liste.description = String(data.description).slice(0, 4000);
  if (data.date !== undefined) liste.date = normaliserJour(data.date);
  if (data.color !== undefined) liste.color = normaliserCouleur(data.color);
  if (data.items !== undefined) {
    liste.items = normaliserElements(data.items, liste.items.map((e) => e.toObject?.() ?? e), actor);
  }
  liste.updatedBy = actor.email ?? null;
  await liste.save();
  return liste;
}

/**
 * COCHER UNE CASE — une écriture, un élément. Voir l'en-tête.
 */
export async function toggleTodoItem(listId, itemId, { done } = {}, actor = {}) {
  if (typeof done !== 'boolean') {
    throw ApiError.badRequest('PANEL_TODO_DONE_REQUIRED', '`done` doit valoir true ou false.');
  }
  const liste = await PanelTodoList.findOneAndUpdate(
    { _id: listId, 'items.id': itemId },
    {
      $set: {
        'items.$[el].done': done,
        'items.$[el].doneAt': done ? new Date() : null,
        'items.$[el].doneBy': done ? (actor.email ?? null) : null,
        updatedBy: actor.email ?? null,
      },
    },
    { new: true, arrayFilters: [{ 'el.id': itemId }] },
  ).catch(() => null);
  if (!liste) throw ApiError.notFound('PANEL_TODO_ITEM_NOT_FOUND', 'Élément introuvable.');
  return liste;
}

export async function deleteTodoList(listId) {
  const supprime = await PanelTodoList.findByIdAndDelete(listId).catch(() => null);
  if (!supprime) throw ApiError.notFound('PANEL_TODO_NOT_FOUND', 'To-do list introuvable.');
  return { deleted: true, listId: String(listId) };
}
