// LA TO-DO LIST — une journée de travail, et ce qu'elle contient.
//
// ══ POURQUOI PAS UNE TÂCHE DE PLUS ═══════════════════════════════════════════
//
// Une TÂCHE (`PanelTask`) est un engagement : elle a une échéance à l'heure
// près, elle se rattache à un projet ou à un prospect, et elle se REPORTE en
// laissant une trace. Une to-do list est plus légère et plus quotidienne :
// « ce que je fais jeudi », une liste de cases à cocher, et un avancement.
// Les mêler aurait chargé chaque case de l'appareil d'une tâche, ou privé les
// tâches de ce qui les rend utiles.
//
// ══ LA DATE EST UN JOUR CIVIL, PAS UN INSTANT ═══════════════════════════════
//
// `date` est une chaîne `AAAA-MM-JJ`. Un `Date` Mongo est un instant UTC : la
// liste « du 14 » créée à 00 h 30 à Paris serait enregistrée le 13 à 22 h 30, et
// un serveur réglé sur UTC la rangerait la veille. Le Panel a déjà payé ce
// décalage ailleurs (créneaux décalés de deux heures). Un jour n'a pas de
// fuseau : on le stocke comme tel, et il se trie lexicographiquement.
//
// ══ L'AVANCEMENT N'EST PAS STOCKÉ ═══════════════════════════════════════════
//
// Il se déduit des éléments (cochés / total). Le recopier dans un champ, c'est
// s'exposer à un pourcentage qui ment après une écriture partielle.
import mongoose from 'mongoose';

export const TODO_LIST_COLORS = Object.freeze([
  'brand', 'blue', 'green', 'orange', 'pink', 'purple', 'gray',
]);

/**
 * L'ÉLÉMENT — une case à cocher.
 *
 * Son ORDRE est celui du tableau, comme les sous-tâches : réordonner, c'est
 * renvoyer la liste dans le nouvel ordre, en une écriture.
 */
const itemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    doneBy: { type: String, default: null },
  },
  { _id: false },
);

const todoListSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    /** `AAAA-MM-JJ`. Voir l'en-tête : un jour, pas un instant. */
    date: { type: String, required: true, index: true },
    color: { type: String, enum: TODO_LIST_COLORS, default: 'brand' },
    items: { type: [itemSchema], default: [] },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

todoListSchema.index({ date: 1, createdAt: 1 });

export const PanelTodoList = mongoose.model('PanelTodoList', todoListSchema);
export default PanelTodoList;
