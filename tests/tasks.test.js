/**
 * LES TÂCHES — création, rattachement, échéance, report.
 *
 * ══ CE QUE CETTE RECETTE VERROUILLE, ET POURQUOI ════════════════════════════
 *
 * 1. UNE ÉCHÉANCE EST FACULTATIVE. « Un jour, refaire les photos » est une
 *    vraie tâche. Lui imposer une date obligerait à en inventer une, et une
 *    date inventée pollue tout ce qui trie par urgence.
 *
 * 2. UNE DATE ILLISIBLE EST REFUSÉE. L'accepter en silence reviendrait à
 *    effacer une échéance que l'utilisateur croyait avoir posée.
 *
 * 3. REPORTER LAISSE UNE TRACE, CORRIGER N'EN LAISSE PAS. Une tâche reportée
 *    quatre fois raconte quelque chose que la nouvelle date, seule, ne raconte
 *    pas — et une faute de frappe corrigée ne raconte rien.
 *
 * 4. LES RATTACHEMENTS NE SONT PAS VÉRIFIÉS, ET C'EST DÉLIBÉRÉ. Ce sont des
 *    NOTES, pas des clefs étrangères : une cible peut disparaître après coup,
 *    et c'est exactement le cas que l'écran doit savoir afficher.
 *
 * 5. LES TÂCHES SANS ÉCHÉANCE PASSENT EN DERNIER. Mongo range `null` avant
 *    toute date : trier naïvement les mettrait devant ce qui est en retard.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const { PanelTask } = await import('../backend/src/models/PanelTask.model.js');

await seedFromEnv();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const creer = (body) => call('POST', '/api/tasks', { headers: AUTH, body });

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Créer une tâche — le nom, et rien d’autre d’obligatoire');
{
  const sansNom = await creer({ description: 'orpheline' });
  check('un nom est requis', sansNom.status === 400
    && sansNom.json.code === 'PANEL_TASK_NAME_REQUIRED');

  /**
   * L'ÉCHÉANCE EST UN ÉTAT, PAS UN OUBLI. Voir l'en-tête : « un jour, refaire
   * les photos » est une vraie tâche.
   */
  const nue = await creer({ name: 'Refaire les photos' });
  check('une tâche sans échéance est acceptée', nue.status === 201);
  check('…et son échéance est explicitement nulle', nue.json.data.task.dueAt === null);
  check('…elle naît ouverte', nue.json.data.task.status === 'OPEN');
  check('…et sans rattachement', nue.json.data.task.links.projectIds.length === 0);

  const datee = await creer({ name: 'Relancer Dupont', dueAt: '2026-09-15T16:00:00.000Z' });
  check('une échéance est conservée telle quelle',
    new Date(datee.json.data.task.dueAt).toISOString() === '2026-09-15T16:00:00.000Z');

  /**
   * UNE DATE ILLISIBLE EST UNE ERREUR, PAS UN CHAMP VIDE. L'accepter en
   * silence effacerait une échéance que l'utilisateur croyait avoir posée.
   */
  const cassee = await creer({ name: 'X', dueAt: 'vendredi prochain' });
  check('une date illisible est REFUSÉE, pas ignorée',
    cassee.status === 400 && cassee.json.code === 'PANEL_TASK_DUE_INVALID');

  /** `''` vient d'un champ de formulaire vidé : c'est « sans échéance ». */
  const videe = await creer({ name: 'Y', dueAt: '' });
  check('une chaîne vide veut dire « sans échéance »', videe.json.data.task.dueAt === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Les sous-tâches — l’ordre du tableau EST l’ordre affiché');
{
  const r = await creer({
    name: 'Préparer la reprise',
    subtasks: [
      { name: 'Récupérer les accès' },
      { name: 'Sauvegarder l’existant', description: 'Base et fichiers' },
      { name: '' },
    ],
  });
  const tache = r.json.data.task;

  check('une sous-tâche sans nom est écartée', tache.subtasks.length === 2);
  check('…les autres gardent leur ordre',
    tache.subtasks[0].name === 'Récupérer les accès'
    && tache.subtasks[1].name === 'Sauvegarder l’existant');
  check('chaque sous-tâche reçoit un identifiant',
    tache.subtasks.every((s) => typeof s.id === 'string' && s.id.length > 0));
  check('…et naît non faite', tache.subtasks.every((s) => s.done === false));

  /**
   * RÉORDONNER, C'EST RENVOYER LA LISTE. Aucun champ de rang à maintenir, donc
   * aucun moyen que deux éléments se retrouvent au même rang.
   */
  const inverse = [...tache.subtasks].reverse();
  const apres = await call('PATCH', `/api/tasks/${tache._id}`, {
    headers: AUTH, body: { subtasks: inverse },
  });
  check('l’ordre renvoyé est l’ordre gardé',
    apres.json.data.task.subtasks[0].name === 'Sauvegarder l’existant');
  check('…et les identifiants ne changent pas',
    apres.json.data.task.subtasks[0].id === tache.subtasks[1].id);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Les rattachements — quatre familles, et aucune vérification');
{
  const r = await creer({
    name: 'Vérifier la commission de juillet',
    links: {
      projectIds: ['p-1', 'p-2', 'p-1'],
      transactionIds: ['t-9'],
      prospectIds: [],
      clientCompanyIds: ['c-3'],
    },
  });
  const liens = r.json.data.task.links;

  check('les quatre familles coexistent',
    liens.projectIds.length === 2 && liens.transactionIds.length === 1
    && liens.clientCompanyIds.length === 1 && liens.prospectIds.length === 0);
  /* Rattacher deux fois le même projet ferait compter deux fois dans la fiche. */
  check('un doublon est écarté', liens.projectIds.filter((x) => x === 'p-1').length === 1);

  /**
   * ON NE VÉRIFIE PAS QUE LA CIBLE EXISTE, et ce n'est pas un oubli : une
   * vérification coûterait quatre requêtes par écriture et ne protégerait de
   * rien dans la durée — une cible peut disparaître APRÈS coup. L'écran résout
   * contre les registres vivants et nomme l'absence.
   */
  check('un identifiant inconnu est accepté — c’est une NOTE, pas une clef étrangère',
    liens.projectIds.includes('p-1'));

  const parProjet = await call('GET', '/api/tasks?projectId=p-2', { headers: AUTH });
  check('la liste filtre par rattachement', parProjet.json.data.tasks.length === 1);
  check('…et le filtre est appliqué par le SERVEUR',
    parProjet.json.data.tasks[0].name === 'Vérifier la commission de juillet');

  const inconnu = await call('GET', '/api/tasks?projectId=jamais-vu', { headers: AUTH });
  check('un rattachement sans tâche rend une liste vide', inconnu.json.data.tasks.length === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Reporter laisse une trace, corriger n’en laisse pas');
{
  const r = await creer({ name: 'Rappeler le notaire', dueAt: '2026-09-01T08:00:00.000Z' });
  const id = r.json.data.task._id;

  const corrige = await call('PATCH', `/api/tasks/${id}`, {
    headers: AUTH, body: { dueAt: '2026-09-02T08:00:00.000Z' },
  });
  check('corriger la date la change', corrige.json.data.task.dueAt.startsWith('2026-09-02'));
  /**
   * UNE FAUTE DE FRAPPE CORRIGÉE NE RACONTE RIEN. La consigner ferait
   * apparaître un report là où il n'y en a pas eu.
   */
  check('…et NE laisse aucune trace de report',
    corrige.json.data.task.postponements.length === 0);

  const reporte = await call('POST', `/api/tasks/${id}/postpone`, {
    headers: AUTH, body: { dueAt: '2026-09-20T08:00:00.000Z' },
  });
  const trace = reporte.json.data.task.postponements;
  check('reporter change la date', reporte.json.data.task.dueAt.startsWith('2026-09-20'));
  check('…ET consigne le report', trace.length === 1);
  check('…avec d’où l’on vient', new Date(trace[0].from).toISOString().startsWith('2026-09-02'));
  check('…où l’on va', new Date(trace[0].to).toISOString().startsWith('2026-09-20'));
  check('…et qui a décidé', trace[0].actorEmail === 'dev@panel.test');

  /* Reporter SANS date reviendrait à retirer l'échéance — une autre décision,
     qui passe par la modification. */
  const sansDate = await call('POST', `/api/tasks/${id}/postpone`, { headers: AUTH, body: {} });
  check('reporter sans nouvelle échéance est refusé',
    sansDate.status === 400 && sansDate.json.code === 'PANEL_TASK_POSTPONE_WITHOUT_DATE');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Faire, rouvrir — et ce que l’un efface de l’autre');
{
  const r = await creer({ name: 'Envoyer le devis', dueAt: '2026-08-01T08:00:00.000Z' });
  const id = r.json.data.task._id;

  const faite = await call('POST', `/api/tasks/${id}/complete`, { headers: AUTH });
  check('une tâche se ferme', faite.json.data.task.status === 'DONE');
  check('…l’instant est consigné', typeof faite.json.data.task.completedAt === 'string');
  check('…et l’auteur aussi', faite.json.data.task.completedBy === 'dev@panel.test');

  /* Refermer une tâche déjà fermée ne doit pas déplacer la date de clôture :
     c'est la première fois qui compte. */
  const encore = await call('POST', `/api/tasks/${id}/complete`, { headers: AUTH });
  check('refermer ne redate pas la clôture',
    encore.json.data.task.completedAt === faite.json.data.task.completedAt);

  const rouverte = await call('POST', `/api/tasks/${id}/reopen`, { headers: AUTH });
  check('rouvrir la remet ouverte', rouverte.json.data.task.status === 'OPEN');
  /**
   * ROUVRIR EFFACE LA CLÔTURE. La garder laisserait une tâche ouverte portant
   * une date de fin — et le tableau de bord aurait à choisir laquelle croire.
   */
  check('…et efface la date de clôture', rouverte.json.data.task.completedAt === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. L’ordre de la liste est celui de l’URGENCE');
{
  await PanelTask.deleteMany({});
  await creer({ name: 'Sans date' });
  await creer({ name: 'Tard', dueAt: '2026-12-01T08:00:00.000Z' });
  await creer({ name: 'Tôt', dueAt: '2026-01-01T08:00:00.000Z' });

  const liste = await call('GET', '/api/tasks', { headers: AUTH });
  const noms = liste.json.data.tasks.map((t) => t.name);

  check('le plus urgent d’abord', noms[0] === 'Tôt' && noms[1] === 'Tard');
  /**
   * MONGO RANGE `null` AVANT TOUTE DATE. Trier naïvement mettrait les tâches
   * sans échéance en tête, DEVANT ce qui est en retard — exactement l'inverse
   * de ce qu'on veut lire.
   */
  check('…et ce qui n’a pas d’échéance passe EN DERNIER', noms[2] === 'Sans date');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Le résumé compte, il ne liste pas');
{
  await PanelTask.deleteMany({});
  const passe = new Date(Date.now() - 86_400_000).toISOString();
  const proche = new Date(Date.now() + 86_400_000).toISOString();
  const loin = new Date(Date.now() + 60 * 86_400_000).toISOString();

  await creer({ name: 'En retard', dueAt: passe });
  await creer({ name: 'Demain', dueAt: proche });
  await creer({ name: 'Dans deux mois', dueAt: loin });
  await creer({ name: 'Sans date' });
  const close = await creer({ name: 'Déjà faite', dueAt: passe });
  await call('POST', `/api/tasks/${close.json.data.task._id}/complete`, { headers: AUTH });

  const { summary } = (await call('GET', '/api/tasks', { headers: AUTH })).json.data;

  check('les ouvertes sont comptées', summary.open === 4);
  check('le retard est compté', summary.overdue === 1);
  /**
   * UNE TÂCHE FAITE N'EST JAMAIS EN RETARD, même si son échéance est passée :
   * elle a été faite, en retard peut-être, mais le retard n'appelle plus rien.
   * La compter apprendrait à ignorer le compteur.
   */
  check('…et une tâche FAITE n’y figure pas', summary.overdue === 1);
  check('l’horizon proche est compté à part', summary.dueSoon === 1);
  check('les sans-échéance sont comptées à part', summary.undated === 1);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. La garde d’authentification');
{
  const nu = await call('GET', '/api/tasks');
  check('sans jeton, la liste est refusée', nu.status === 401);
  const ecriture = await call('POST', '/api/tasks', { body: { name: 'intrus' } });
  check('…et l’écriture aussi', ecriture.status === 401);
}

await close();
await stopMemoryMongo();
finish();
