// LA TÂCHE — ce qu'il reste à faire, et à quoi ça se rattache.
//
// ══ POURQUOI UNE COLLECTION À PART, ET PAS UN CHAMP SUR CHAQUE FICHE ════════
//
// Une tâche traverse le Panel : « relancer Dupont avant vendredi » touche un
// prospect ; « vérifier la commission Stripe de juillet » touche une
// transaction ; « préparer la reprise du site » touche un projet ET l'entreprise
// cliente qui le paie. La ranger dans l'une des quatre fiches aurait obligé à
// choisir un propriétaire arbitraire, puis à interroger quatre collections pour
// répondre à « qu'est-ce que j'ai à faire cette semaine ? ».
//
// Les rattachements sont donc des LISTES, et elles peuvent être vides : une
// tâche qui ne se rattache à rien reste une tâche.
//
// ══ L'ÉCHÉANCE EST FACULTATIVE, ET CE N'EST PAS UN OUBLI ═══════════════════
//
// « Un jour, refaire les photos » est une vraie tâche. Lui imposer une date
// obligerait à en inventer une, et une date inventée pollue tout ce qui trie
// par urgence — le tableau de bord annoncerait un retard qui n'existe pas.
//
// `dueAt: null` est donc un état de plein droit. La chronologie des fiches les
// range à part, sous les tâches datées.
//
// ══ « REPORTER » LAISSE UNE TRACE ══════════════════════════════════════════
//
// Décaler une échéance est une décision, et une tâche reportée quatre fois dit
// quelque chose que la nouvelle date, seule, ne dit pas. Chaque report est donc
// consigné : d'où, vers où, par qui.
import mongoose from 'mongoose';

export const TASK_STATUS = Object.freeze({
  OPEN: 'OPEN',
  DONE: 'DONE',
});
export const TASK_STATUS_VALUES = Object.freeze(Object.values(TASK_STATUS));

/**
 * LA SOUS-TÂCHE.
 *
 * Son ORDRE est celui du tableau, et rien d'autre : pas de champ `position` à
 * maintenir. Réordonner, c'est renvoyer le tableau dans le nouvel ordre — une
 * seule écriture, atomique, et aucun risque de deux éléments au même rang.
 */
const subtaskSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    done: { type: Boolean, default: false },
  },
  { _id: false },
);

const postponementSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    from: { type: Date, default: null },
    to: { type: Date, default: null },
    actorEmail: { type: String, default: null },
  },
  { _id: false },
);

/**
 * LES RATTACHEMENTS.
 *
 * Quatre listes d'identifiants, et RIEN DE PLUS — pas de nom recopié. Un projet
 * renommé doit se lire sous son nouveau nom partout, y compris depuis une tâche
 * écrite il y a six mois. L'écran résout les identifiants contre les registres
 * vivants au moment de l'affichage.
 *
 * La contrepartie est assumée : une cible supprimée laisse un identifiant
 * orphelin. L'écran le dit alors avec des mots plutôt que d'afficher un
 * identifiant technique — la même règle que la répartition financière.
 */
const linksSchema = new mongoose.Schema(
  {
    projectIds: { type: [String], default: [] },
    prospectIds: { type: [String], default: [] },
    transactionIds: { type: [String], default: [] },
    clientCompanyIds: { type: [String], default: [] },
  },
  { _id: false },
);

const taskSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    subtasks: { type: [subtaskSchema], default: [] },
    links: { type: linksSchema, default: () => ({}) },
    /** `null` = sans échéance. Voir l'en-tête : c'est un état, pas un oubli. */
    dueAt: { type: Date, default: null, index: true },
    status: {
      type: String,
      enum: TASK_STATUS_VALUES,
      default: TASK_STATUS.OPEN,
      index: true,
    },
    completedAt: { type: Date, default: null },
    completedBy: { type: String, default: null },
    postponements: { type: [postponementSchema], default: [] },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

/*
  L'INDEX QUI SERT LA QUESTION LA PLUS POSÉE : « qu'est-ce qui est ouvert, et
  dans quel ordre d'urgence ? ». Le tableau de bord et la page des tâches la
  posent à chaque affichage.
*/
taskSchema.index({ status: 1, dueAt: 1 });
taskSchema.index({ 'links.projectIds': 1 });
taskSchema.index({ 'links.prospectIds': 1 });
taskSchema.index({ 'links.clientCompanyIds': 1 });
taskSchema.index({ 'links.transactionIds': 1 });

export const PanelTask = mongoose.model('PanelTask', taskSchema);
export default PanelTask;
