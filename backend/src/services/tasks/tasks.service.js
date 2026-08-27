/**
 * LES TÂCHES — création, rattachement, échéance, report.
 *
 * ══ CE QUE CE SERVICE NE FAIT PAS ═══════════════════════════════════════════
 *
 * Il ne VÉRIFIE PAS que les identifiants rattachés existent. C'est délibéré :
 *
 *   · une vérification coûterait quatre requêtes à chaque écriture, pour un
 *     rattachement qui est une NOTE, pas une clef étrangère ;
 *   · elle ne protégerait de rien dans la durée — une cible peut disparaître
 *     après coup, et c'est exactement le cas qu'il faut savoir afficher.
 *
 * L'écran résout les identifiants contre les registres vivants au moment de
 * l'affichage, et nomme l'absence quand il ne trouve rien. La même règle que la
 * répartition financière.
 *
 * ══ IL NE CALCULE PAS NON PLUS « EN RETARD » ═══════════════════════════════
 *
 * Le retard est une comparaison entre une échéance et l'instant présent. Le
 * figer côté serveur donnerait une valeur périmée dès la réponse envoyée : une
 * tâche due dans deux minutes serait annoncée « à l'heure » pendant deux
 * minutes de trop. L'écran compare, et il le refait à chaque seconde qui passe.
 */
import crypto from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import { PanelTask, TASK_STATUS, TASK_STATUS_VALUES } from '../../models/PanelTask.model.js';

const identifiant = () => crypto.randomUUID();
const texte = (valeur, defaut = '') => (
  typeof valeur === 'string' ? valeur.trim() : defaut
);

/**
 * UNE ÉCHÉANCE, OU RIEN.
 *
 * `null` et `''` veulent dire « sans échéance » — l'un vient du modèle, l'autre
 * d'un champ de formulaire vidé. Une date illisible, en revanche, est une
 * erreur : l'accepter en silence reviendrait à effacer une échéance que
 * l'utilisateur croyait avoir posée.
 */
function normaliserEcheance(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(
      'PANEL_TASK_DUE_INVALID',
      'L’échéance doit être une date valide.',
    );
  }
  return date;
}

function normaliserSousTache(brut) {
  const name = texte(brut?.name);
  if (!name) return null;
  return {
    id: texte(brut?.id) || identifiant(),
    name: name.slice(0, 200),
    description: texte(brut?.description).slice(0, 2000),
    done: brut?.done === true,
  };
}

/**
 * L'ORDRE DU TABLEAU EST L'ORDRE AFFICHÉ.
 *
 * Réordonner, c'est renvoyer la liste dans le nouvel ordre. Aucun champ de rang
 * à maintenir, donc aucun moyen que deux éléments se retrouvent au même rang.
 */
function normaliserSousTaches(liste) {
  if (!Array.isArray(liste)) return [];
  return liste.map(normaliserSousTache).filter(Boolean).slice(0, 100);
}

const CLEFS_LIENS = ['projectIds', 'prospectIds', 'transactionIds', 'clientCompanyIds'];

function normaliserLiens(brut) {
  const liens = {};
  for (const clef of CLEFS_LIENS) {
    const liste = Array.isArray(brut?.[clef]) ? brut[clef] : [];
    /* Dédoublonné : rattacher deux fois le même projet n'a pas de sens, et
       ferait compter deux fois dans la fiche. */
    liens[clef] = [...new Set(liste.map((v) => texte(v)).filter(Boolean))].slice(0, 50);
  }
  return liens;
}

function normaliserStatut(valeur) {
  if (!TASK_STATUS_VALUES.includes(valeur)) {
    throw ApiError.badRequest('PANEL_TASK_STATUS_UNKNOWN', 'Statut de tâche inconnu.');
  }
  return valeur;
}

export async function createTask(data = {}, actor = {}) {
  const name = texte(data.name);
  if (!name) {
    throw ApiError.badRequest('PANEL_TASK_NAME_REQUIRED', 'Un nom est requis.');
  }

  return PanelTask.create({
    name,
    description: data.description === undefined ? '' : String(data.description),
    subtasks: normaliserSousTaches(data.subtasks),
    links: normaliserLiens(data.links),
    dueAt: normaliserEcheance(data.dueAt),
    status: TASK_STATUS.OPEN,
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

async function chargerOuLever(taskId) {
  const tache = await PanelTask.findById(taskId).catch(() => null);
  if (!tache) throw ApiError.notFound('PANEL_TASK_NOT_FOUND', 'Tâche introuvable.');
  return tache;
}

export async function updateTask(taskId, data = {}, actor = {}) {
  const tache = await chargerOuLever(taskId);

  if (data.name !== undefined) {
    const name = texte(data.name);
    if (!name) throw ApiError.badRequest('PANEL_TASK_NAME_REQUIRED', 'Un nom est requis.');
    tache.name = name;
  }
  if (data.description !== undefined) tache.description = String(data.description);
  if (data.subtasks !== undefined) tache.subtasks = normaliserSousTaches(data.subtasks);
  if (data.links !== undefined) tache.links = normaliserLiens(data.links);
  if (data.status !== undefined) {
    const cible = normaliserStatut(data.status);
    tache.status = cible;
    tache.completedAt = cible === TASK_STATUS.DONE ? (tache.completedAt ?? new Date()) : null;
    tache.completedBy = cible === TASK_STATUS.DONE ? (tache.completedBy ?? actor.email ?? null) : null;
  }

  /**
   * CHANGER L'ÉCHÉANCE PAR `PATCH` N'EST PAS UN REPORT.
   *
   * Corriger une date qu'on avait mal saisie et décaler une tâche parce qu'on
   * n'a pas eu le temps sont deux gestes différents. Le second passe par
   * `postponeTask`, qui laisse une trace ; celui-ci n'en laisse pas, et c'est
   * ce qu'on attend d'une correction.
   */
  if (data.dueAt !== undefined) tache.dueAt = normaliserEcheance(data.dueAt);

  tache.updatedBy = actor.email ?? null;
  await tache.save();
  return tache;
}

export async function completeTask(taskId, actor = {}) {
  const tache = await chargerOuLever(taskId);
  if (tache.status === TASK_STATUS.DONE) return tache;
  tache.status = TASK_STATUS.DONE;
  tache.completedAt = new Date();
  tache.completedBy = actor.email ?? null;
  tache.updatedBy = actor.email ?? null;
  await tache.save();
  return tache;
}

export async function reopenTask(taskId, actor = {}) {
  const tache = await chargerOuLever(taskId);
  tache.status = TASK_STATUS.OPEN;
  tache.completedAt = null;
  tache.completedBy = null;
  tache.updatedBy = actor.email ?? null;
  await tache.save();
  return tache;
}

/**
 * REPORTER — et le dire.
 *
 * Une tâche reportée quatre fois raconte quelque chose que la nouvelle date,
 * seule, ne raconte pas. Chaque report consigne d'où l'on vient, où l'on va, et
 * qui a décidé.
 */
export async function postponeTask(taskId, { dueAt } = {}, actor = {}) {
  const tache = await chargerOuLever(taskId);
  const cible = normaliserEcheance(dueAt);
  if (cible === null) {
    throw ApiError.badRequest(
      'PANEL_TASK_POSTPONE_WITHOUT_DATE',
      'Reporter demande une nouvelle échéance.',
    );
  }

  tache.postponements.push({
    at: new Date(),
    from: tache.dueAt ?? null,
    to: cible,
    actorEmail: actor.email ?? null,
  });
  tache.dueAt = cible;
  tache.updatedBy = actor.email ?? null;
  await tache.save();
  return tache;
}

export async function deleteTask(taskId) {
  const tache = await chargerOuLever(taskId);
  const id = String(tache._id);
  await tache.deleteOne();
  return { deleted: true, taskId: id };
}

/**
 * LA LISTE, FILTRABLE PAR RATTACHEMENT.
 *
 * ── L'ORDRE N'EST PAS « PAR DATE » ─────────────────────────────────────────
 * Il est « par urgence ». Les tâches SANS échéance ne sont pas urgentes, et
 * Mongo range `null` avant toute date : trier naïvement les mettrait en tête,
 * devant ce qui est en retard. Elles passent donc à la fin, et l'écran les
 * présente à part.
 */
export async function listTasks({
  status = null,
  projectId = null,
  prospectId = null,
  transactionId = null,
  clientCompanyId = null,
  limit = 500,
} = {}) {
  const filtre = {};
  if (status) filtre.status = normaliserStatut(status);
  if (projectId) filtre['links.projectIds'] = projectId;
  if (prospectId) filtre['links.prospectIds'] = prospectId;
  if (transactionId) filtre['links.transactionIds'] = transactionId;
  if (clientCompanyId) filtre['links.clientCompanyIds'] = clientCompanyId;

  const taches = await PanelTask.find(filtre)
    .limit(Math.min(Number(limit) || 500, 1000))
    .lean();

  return taches.sort((a, b) => {
    if (!a.dueAt && !b.dueAt) return String(a.name).localeCompare(String(b.name), 'fr');
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
}

export async function describeTask(taskId) {
  return chargerOuLever(taskId);
}

/**
 * LE RÉSUMÉ DU TABLEAU DE BORD.
 *
 * `overdue` est compté ICI parce que la question posée est « combien », pas
 * « lesquelles » — et compter côté serveur évite de transporter la liste
 * entière pour n'en afficher qu'un nombre. La borne temporelle est celle de la
 * requête, et le compteur est donc juste au moment où il est calculé ; l'écran
 * le rafraîchit avec le reste.
 */
export async function summarizeTasks({ horizonDays = 7 } = {}) {
  const maintenant = new Date();
  const horizon = new Date(maintenant.getTime() + horizonDays * 86_400_000);

  const [open, overdue, dueSoon, undated] = await Promise.all([
    PanelTask.countDocuments({ status: TASK_STATUS.OPEN }),
    PanelTask.countDocuments({ status: TASK_STATUS.OPEN, dueAt: { $ne: null, $lt: maintenant } }),
    PanelTask.countDocuments({
      status: TASK_STATUS.OPEN,
      dueAt: { $gte: maintenant, $lte: horizon },
    }),
    PanelTask.countDocuments({ status: TASK_STATUS.OPEN, dueAt: null }),
  ]);

  return { open, overdue, dueSoon, undated, horizonDays };
}
