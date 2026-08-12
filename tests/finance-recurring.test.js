/**
 * L10.2 — COÛTS RÉCURRENTS : la règle, ses cycles, ses révisions, son arrêt.
 *
 * Ce que ces contrôles verrouillent :
 *
 *   · qu'un mois ne vaut PAS trente jours, ni une année trois cent soixante-cinq —
 *     le 31 janvier revient au 31 mars après un février court, et le 29 février
 *     revient en 2028 ;
 *   · qu'une occurrence ne puisse JAMAIS être créée deux fois, même par deux
 *     matérialiseurs simultanés — la garantie est en base, pas dans le code ;
 *   · qu'un Panel arrêté quatre mois produise QUATRE occurrences à leurs quatre
 *     dates, jamais une seule compressée ;
 *   · que les trois modes de modification aient chacun leur effet exact, et que
 *     le passé matérialisé ne bouge que lorsqu'on le demande ;
 *   · qu'un « arrêt actuel » retire le cycle courant des totaux SANS détruire
 *     ni la ligne, ni son justificatif ;
 *   · qu'une règle future n'entre dans AUCUN agrégat avant matérialisation ;
 *   · qu'aucun fournisseur n'entre dans le code des récurrences.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const { PanelFinancialTransaction } = await import('../backend/src/models/PanelFinancialTransaction.model.js');
const { PanelRecurringCost } = await import('../backend/src/models/PanelRecurringCost.model.js');
const recurrence = await import('../backend/src/services/finance/recurrence.js');
const recurring = await import('../backend/src/services/finance/recurringCosts.service.js');
const agregat = await import('../backend/src/services/finance/financialSummary.service.js');

await seedFromEnv();
await PanelFinancialTransaction.init(); // l'index unique DOIT exister avant les tests
await PanelRecurringCost.init();

const { call, close } = await startServer(createApp());
const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const declarer = async (projectId, projectName) => {
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId, projectKey: projectId, projectName,
    createdAt: now, updatedAt: now, pairing: { status: 'DECLARED' }, runtime: {},
  });
};
const PROJET_A = 'atelier-nord';
const PROJET_B = 'atelier-sud';
await declarer(PROJET_A, 'Atelier du Nord');
await declarer(PROJET_B, 'Atelier du Sud');

/** Une horloge FIGÉE — aucun test de récurrence ne dépend de l'heure réelle. */
const T = (iso) => new Date(iso);

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. Le calendrier : un mois n’est pas trente jours');
{
  const { anchorOf, cycleDayAt, cycleKeyOf, normalizeRecurrence } = recurrence;

  const janvier31 = anchorOf(T('2026-01-31T00:00:00+01:00'));
  const mensuel = { unit: 'MONTH', interval: 1 };
  const suite = [0, 1, 2, 3, 4, 5].map((n) => cycleKeyOf(cycleDayAt(janvier31, mensuel, n)));
  check('31 janvier → 28 février (dernier jour valide)', suite[1] === '2026-02-28');
  check('…PUIS 31 MARS — le jour d’ancrage est RESTAURÉ, il n’est pas perdu',
    suite[2] === '2026-03-31');
  check('…30 avril, 31 mai : aucune dérive cumulative',
    suite[3] === '2026-04-30' && suite[4] === '2026-05-31');

  const bissextile = anchorOf(T('2024-02-29T00:00:00+01:00'));
  const annuel = { unit: 'YEAR', interval: 1 };
  const annees = [0, 1, 2, 3, 4].map((n) => cycleKeyOf(cycleDayAt(bissextile, annuel, n)));
  check('29 février 2024 → 28 février les années communes',
    annees[1] === '2025-02-28' && annees[2] === '2026-02-28' && annees[3] === '2027-02-28');
  check('…et de nouveau 29 FÉVRIER en 2028', annees[4] === '2028-02-29');

  const bimestriel = cycleKeyOf(cycleDayAt(anchorOf(T('2026-01-15T00:00:00+01:00')), { unit: 'MONTH', interval: 2 }, 3));
  check('tous les 2 mois : 15 janvier → 15 juillet au 3ᵉ pas', bimestriel === '2026-07-15');

  const hebdo = cycleKeyOf(cycleDayAt(anchorOf(T('2026-03-01T00:00:00+01:00')), { unit: 'DAY', interval: 7 }, 4));
  check('tous les 7 jours : 1er mars → 29 mars au 4ᵉ pas', hebdo === '2026-03-29');

  // La nuit du 28 au 29 mars 2026 est celle du passage à l'heure d'été.
  const dst = recurrence.dueCycles({
    startAt: T('2026-03-27T00:00:00+01:00'),
    recurrence: { unit: 'DAY', interval: 1 },
    now: T('2026-03-31T12:00:00Z'),
  });
  check('DST : les jours restent consécutifs, aucun n’est sauté ni doublé',
    dst.cycles.map((c) => c.key).join(',') === '2026-03-27,2026-03-28,2026-03-29,2026-03-30,2026-03-31');

  check('une unité inconnue est refusée', (() => {
    try { normalizeRecurrence({ unit: 'WEEK', interval: 1 }); return false; } catch { return true; }
  })());
  check('un intervalle nul est refusé', (() => {
    try { normalizeRecurrence({ unit: 'DAY', interval: 0 }); return false; } catch { return true; }
  })());
}

section('2. Créer une règle — et sa première occurrence le jour même');
{
  const res = await call('POST', '/api/finances/recurring-costs', {
    headers: AUTH,
    body: {
      scope: 'PROJECT', projectId: PROJET_A,
      label: 'Brevo', description: 'Envoi d’e-mails',
      amount: '49', recurrence: { unit: 'MONTH', interval: 1 },
      startAt: '2026-08-01',
    },
  });
  check('la règle est créée', res.status === 201);
  const regle = res.json.data.recurringCost;
  check('…avec une première révision, effective au premier cycle',
    regle.revisions.length === 1 && regle.revisions[0].effectiveFromCycleKey === '2026-08-01');
  check('…active', regle.status === 'ACTIVE');
  check('…et son montant courant en centimes', regle.amountCents === 4900);

  const occurrences = await PanelFinancialTransaction.find({ sourceId: regle.recurringCostId }).lean();
  check('les occurrences dues sont matérialisées immédiatement', occurrences.length > 0);
  check('…en OUTFLOW / COST', occurrences.every((o) => o.flow === 'OUTFLOW' && o.category === 'COST'));
  check('…d’origine RECURRING_COST', occurrences.every((o) => o.origin === 'RECURRING_COST'));
  check('…portant leur règle et leur cycle',
    occurrences.every((o) => o.sourceId === regle.recurringCostId && /^\d{4}-\d{2}-\d{2}$/.test(o.cycleKey)));
  check('…et rattachées au projet', occurrences.every((o) => o.projectId === PROJET_A));

  const sansProjet = await call('POST', '/api/finances/recurring-costs', {
    headers: AUTH,
    body: { scope: 'PROJECT', label: 'x', amount: '1', recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01' },
  });
  check('une portée PROJECT sans projet est refusée', sansProjet.status === 400);
  const projetFantome = await call('POST', '/api/finances/recurring-costs', {
    headers: AUTH,
    body: { scope: 'PROJECT', projectId: 'nexiste-pas', label: 'x', amount: '1', recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01' },
  });
  check('un projet inconnu est refusé', projetFantome.status === 404);
  const sansAuth = await call('POST', '/api/finances/recurring-costs', { body: {} });
  check('…et rien sans authentification', sansAuth.status === 401);
}

section('3. Rattrapage : quatre mois d’arrêt = quatre occurrences, pas une');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Domiciliation', amount: '30',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, { email: 'dev@panel.test' }, { now: T('2026-08-01T09:00:00Z') });

  const apresCreation = await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId });
  check('au démarrage, une seule occurrence', apresCreation === 1);

  // Le Panel s'éteint. On revient le 5 décembre.
  const rattrapage = await recurring.materializeDueOccurrences(def.recurringCostId, { now: T('2026-12-05T10:00:00Z') });
  check('le retour crée les QUATRE cycles manqués', rattrapage.created === 4);

  const toutes = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).sort({ cycleKey: 1 }).lean();
  check('cinq occurrences au total', toutes.length === 5);
  check('…à leurs VRAIES dates, jamais compressées',
    toutes.map((o) => o.cycleKey).join(',') === '2026-08-01,2026-09-01,2026-10-01,2026-11-01,2026-12-01');
  check('…chacune au montant de la règle, pas leur somme',
    toutes.every((o) => o.amountCents === 3000));
  check('…et rattachées à L.Y Solution', toutes.every((o) => o.projectId === null));

  const rejoue = await recurring.materializeDueOccurrences(def.recurringCostId, { now: T('2026-12-05T10:00:00Z') });
  check('REJOUER la matérialisation ne crée RIEN', rejoue.created === 0);
  check('…et n’en supprime aucune',
    (await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId })) === 5);
}

section('4. Idempotence sous CONCURRENCE réelle');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Concurrence', amount: '10',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-01-01',
  }, {}, { now: T('2026-01-01T00:00:00Z') });

  // HUIT matérialiseurs simultanés sur les mêmes cycles — le cas du double
  // worker, du retry et des deux onglets, tous en même temps.
  const now = T('2026-06-15T10:00:00Z');
  const resultats = await Promise.all(
    Array.from({ length: 8 }, () => recurring.materializeDueOccurrences(def.recurringCostId, { now })),
  );

  const total = await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId });
  check('six cycles dus, six occurrences — pas une de plus', total === 6);
  const crees = resultats.reduce((s, r) => s + r.created, 0);
  check('…et cinq créations au total sur les huit passages (une par cycle neuf)', crees === 5);

  const clefs = await PanelFinancialTransaction.distinct('cycleKey', { sourceId: def.recurringCostId });
  check('aucune clé de cycle en double', clefs.length === total);

  // La preuve que la garantie est EN BASE et non dans le code.
  const index = PanelFinancialTransaction.schema.indexes()
    .find(([clefs2]) => clefs2.sourceId === 1 && clefs2.cycleKey === 1);
  check('un index UNIQUE porte (sourceId, cycleKey)', Boolean(index) && index[1].unique === true);
  check('…partiel, pour ne pas faire collisionner les saisies manuelles',
    Boolean(index[1].partialFilterExpression?.sourceId));

  const doublon = await PanelFinancialTransaction.create({
    transactionId: 'force-doublon', projectId: null, flow: 'OUTFLOW', category: 'COST',
    origin: 'RECURRING_COST', label: 'x', amountCents: 1, currency: 'EUR',
    effectiveDate: new Date(), sourceId: def.recurringCostId, cycleKey: '2026-01-01',
  }).then(() => false).catch((err) => err.code === 11000);
  check('la BASE refuse un doublon écrit à la main', doublon === true);
}

section('5. Modification — « prochaine récurrence »');
{
  const def = await recurring.createRecurringCost({
    scope: 'PROJECT', projectId: PROJET_A, label: 'Hébergement', amount: '49',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, {}, { now: T('2026-09-15T10:00:00Z') });

  const avant = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).sort({ cycleKey: 1 }).lean();
  check('août et septembre existent', avant.map((o) => o.cycleKey).join(',') === '2026-08-01,2026-09-01');

  const r = await recurring.reviseRecurringCost(def.recurringCostId, {
    mode: 'NEXT', amount: '59',
  }, { email: 'dev@panel.test' }, { now: T('2026-09-15T10:00:00Z') });
  check('la révision prend effet au 1er OCTOBRE', r.revision.effectiveFromCycleKey === '2026-10-01');
  check('…et AUCUNE occurrence matérialisée n’est touchée', r.revisedOccurrences === 0);

  const apres = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).sort({ cycleKey: 1 }).lean();
  check('août reste à 49 €', apres[0].amountCents === 4900);
  check('septembre reste à 49 €', apres[1].amountCents === 4900);

  await recurring.materializeDueOccurrences(def.recurringCostId, { now: T('2026-11-15T10:00:00Z') });
  const suite = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).sort({ cycleKey: 1 }).lean();
  check('octobre naît à 59 €', suite.find((o) => o.cycleKey === '2026-10-01').amountCents === 5900);
  check('novembre aussi', suite.find((o) => o.cycleKey === '2026-11-01').amountCents === 5900);
  check('…et août n’a toujours pas bougé', suite[0].amountCents === 4900);
}

section('6. Modification — « récurrence précédente » (le cycle COURANT)');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Outillage', amount: '49',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, {}, { now: T('2026-09-15T10:00:00Z') });

  const r = await recurring.reviseRecurringCost(def.recurringCostId, {
    mode: 'CURRENT', amount: '59',
  }, { email: 'dev@panel.test' }, { now: T('2026-09-15T10:00:00Z') });

  check('la révision prend effet au 1er SEPTEMBRE — le cycle courant',
    r.revision.effectiveFromCycleKey === '2026-09-01');
  check('…et UNE occurrence est révisée', r.revisedOccurrences === 1);

  const apres = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).sort({ cycleKey: 1 }).lean();
  check('août reste à 49 € — le passé ancien ne bouge pas', apres[0].amountCents === 4900);
  check('septembre passe à 59 €', apres[1].amountCents === 5900);
  check('…par MISE À JOUR : l’identifiant est conservé',
    apres[1].transactionId && apres[1].transactionId.length > 10);
  check('…et la révision appliquée est tracée sur la ligne', apres[1].sourceRevision === 2);
  check('…avec l’auteur de la révision', apres[1].updatedBy === 'dev@panel.test');
}

section('7. Modification — « depuis le début »');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Assurance', amount: '49',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, {}, { now: T('2026-11-15T10:00:00Z') });

  const avant = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).lean();
  check('quatre occurrences existent', avant.length === 4);
  const ids = avant.map((o) => o.transactionId).sort();

  const r = await recurring.reviseRecurringCost(def.recurringCostId, {
    mode: 'FROM_START', amount: '59', reason: 'Tarif renégocié rétroactivement',
  }, { email: 'dev@panel.test' }, { now: T('2026-11-15T10:00:00Z') });

  check('la révision part du PREMIER cycle', r.revision.effectiveFromCycleKey === '2026-08-01');
  check('…et les quatre occurrences sont révisées', r.revisedOccurrences === 4);

  const apres = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).lean();
  check('toutes valent 59 €', apres.every((o) => o.amountCents === 5900));
  check('AUCUN identifiant n’a changé',
    JSON.stringify(apres.map((o) => o.transactionId).sort()) === JSON.stringify(ids));
  check('aucun doublon n’est apparu', apres.length === 4);
  check('le motif est conservé sur la révision', r.revision.reason === 'Tarif renégocié rétroactivement');

  const relu = await recurring.getRecurringCost(def.recurringCostId);
  check('l’historique des révisions est APPEND-ONLY et complet',
    relu.revisions.length === 2
    && relu.revisions[0].amountCents === 4900
    && relu.revisions[1].amountCents === 5900);
  check('…chacune datée et imputée',
    relu.revisions.every((v) => v.createdAt && 'createdBy' in v));
  check('…et le mode d’application est conservé', relu.revisions[1].mode === 'FROM_START');
}

section('8. Arrêt — « prochaine » : le cycle courant reste');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Stop prochaine', amount: '20',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, {}, { now: T('2026-09-15T10:00:00Z') });

  const r = await recurring.stopRecurringCost(def.recurringCostId, { mode: 'NEXT' }, { email: 'dev@panel.test' }, { now: T('2026-09-15T10:00:00Z') });
  check('la borne est le cycle courant', r.untilCycleKey === '2026-09-01');
  check('…et rien n’est annulé', r.cancelled === 0);

  const vivantes = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId, deletedAt: null }).lean();
  check('août et septembre restent dans les totaux', vivantes.length === 2);

  // Le temps passe : aucune occurrence ne doit plus naître, même après reprise.
  await recurring.materializeDueOccurrences(def.recurringCostId, { now: T('2027-06-01T10:00:00Z') });
  check('AUCUN cycle postérieur n’est produit, même six mois plus tard',
    (await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId })) === 2);

  const relu = await recurring.getRecurringCost(def.recurringCostId);
  check('la règle est STOPPED', relu.status === 'STOPPED');
  check('…sans prochaine échéance annoncée', relu.nextOccurrenceAt === null);
  check('…et l’arrêt est daté, imputé, qualifié',
    relu.stoppedAt && relu.stoppedBy === 'dev@panel.test' && relu.stopMode === 'NEXT');
}

section('9. Arrêt — « actuelle » : le cycle courant quitte les totaux');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Stop actuelle', amount: '20',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, {}, { now: T('2026-09-15T10:00:00Z') });

  const netAvant = (await agregat.summarize({ scope: 'company', period: 'ALL' })).totals.netCents;

  const r = await recurring.stopRecurringCost(def.recurringCostId, { mode: 'CURRENT', reason: 'Résilié' }, { email: 'dev@panel.test' }, { now: T('2026-09-15T10:00:00Z') });
  check('le cycle courant est annulé', r.cancelCycleKey === '2026-09-01' && r.cancelled === 1);

  const septembre = await PanelFinancialTransaction.findOne({ sourceId: def.recurringCostId, cycleKey: '2026-09-01' }).lean();
  check('la ligne EXISTE toujours en base — rien n’est détruit', Boolean(septembre));
  check('…mais elle est supprimée logiquement', Boolean(septembre.deletedAt));
  check('…imputée et motivée',
    septembre.deletedBy === 'dev@panel.test' && /Résilié/.test(septembre.deletionReason));

  const aout = await PanelFinancialTransaction.findOne({ sourceId: def.recurringCostId, cycleKey: '2026-08-01' }).lean();
  check('AOÛT RESTE — un arrêt ne réécrit pas l’histoire', aout.deletedAt === null);

  const netApres = (await agregat.summarize({ scope: 'company', period: 'ALL' })).totals.netCents;
  check('le net remonte exactement du montant annulé', netApres - netAvant === 2000);

  await recurring.materializeDueOccurrences(def.recurringCostId, { now: T('2027-06-01T10:00:00Z') });
  const ressuscite = await PanelFinancialTransaction.findOne({ sourceId: def.recurringCostId, cycleKey: '2026-09-01' }).lean();
  check('LE CYCLE ANNULÉ NE RESSUSCITE PAS à la relecture', Boolean(ressuscite.deletedAt));
  check('…et aucun cycle postérieur n’est né',
    (await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId })) === 2);
}

section('10. Une règle arrêtée est immuable — et c’est une décision énoncée');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Immuable', amount: '10',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, {}, { now: T('2026-09-15T10:00:00Z') });
  await recurring.stopRecurringCost(def.recurringCostId, { mode: 'NEXT' }, {}, { now: T('2026-09-15T10:00:00Z') });

  const refus = await call('PATCH', `/api/finances/recurring-costs/${def.recurringCostId}`, {
    headers: AUTH, body: { mode: 'NEXT', amount: '99' },
  });
  check('modifier une récurrence arrêtée est REFUSÉ',
    refus.status === 409 && refus.json.code === 'PANEL_RECURRING_STOPPED');
  check('…avec l’issue indiquée', /nouvelle/.test(refus.json.message));

  const doubleArret = await call('POST', `/api/finances/recurring-costs/${def.recurringCostId}/stop`, {
    headers: AUTH, body: { mode: 'NEXT' },
  });
  check('l’arrêter deux fois est refusé', doubleArret.status === 409);
}

section('11. Le futur ne compte pas — seules les occurrences matérialisées');
{
  const def = await recurring.createRecurringCost({
    scope: 'PROJECT', projectId: PROJET_B, label: 'Futur', amount: '500',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2099-01-01',
  }, {}, { now: T('2026-09-15T10:00:00Z') });

  const occurrences = await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId });
  check('une règle démarrant en 2099 ne matérialise RIEN', occurrences === 0);

  const resume = await agregat.summarize({ scope: 'project', projectId: PROJET_B, period: 'ALL' });
  check('…et ne pèse pas un centime sur les coûts', resume.byCategory.costCents === 0);
  check('…ni sur le net', resume.totals.netCents === 0);
  check('…ni sur le graphique', resume.series.length === 0);

  const relu = await recurring.getRecurringCost(def.recurringCostId);
  check('la prochaine échéance est néanmoins ANNONCÉE', relu.nextOccurrenceAt !== null);
  check('…au 1er janvier 2099', relu.nextOccurrenceCycleKey === '2099-01-01');
}

section('12. Les règles sont une liste À PART du ledger');
{
  const liste = await call('GET', `/api/finances/recurring-costs?scope=project&projectId=${PROJET_A}`, { headers: AUTH });
  check('la liste des règles répond', liste.status === 200);
  check('…et ne contient que celles du projet',
    liste.json.data.items.every((r) => r.projectId === PROJET_A));
  check('…avec montant, fréquence, prochaine échéance et statut',
    liste.json.data.items.every((r) => typeof r.amountCents === 'number'
      && r.recurrence?.unit && 'nextOccurrenceAt' in r && r.status));

  const societe = await call('GET', '/api/finances/recurring-costs?scope=company', { headers: AUTH });
  check('la portée société ne rend que les règles sans projet',
    societe.json.data.items.every((r) => r.projectId === null));

  const ledger = await call('GET', `/api/finances/transactions?scope=project&projectId=${PROJET_A}&period=ALL`, { headers: AUTH });
  check('le LEDGER, lui, ne contient que des mouvements matérialisés',
    ledger.json.data.items.every((t) => t.cycleKey === null || /^\d{4}-\d{2}-\d{2}$/.test(t.cycleKey)));
  check('…et l’on distingue une occurrence d’une saisie manuelle',
    ledger.json.data.items.some((t) => t.origin === 'RECURRING_COST'));

  const occurrence = ledger.json.data.items.find((t) => t.origin === 'RECURRING_COST');
  check('une occurrence n’est PAS modifiable ligne à ligne', occurrence.editable === false);
  check('…et le dit : la règle est le bon endroit',
    /RECURRING_COST/.test(occurrence.notEditableReason ?? ''));
}

section('13. « Tout supprimer » n’arrête aucune récurrence — et le dit');
{
  const portee = await call('GET', `/api/finances/bulk-scope?scope=project&projectId=${PROJET_A}`, { headers: AUTH });
  check('le décompte annonce aussi les règles ACTIVES restantes',
    typeof portee.json.data.activeRecurringCosts === 'number'
    && portee.json.data.activeRecurringCosts > 0);

  const actives = portee.json.data.activeRecurringCosts;
  const res = await call('POST', '/api/finances/transactions/bulk-delete', {
    headers: AUTH, body: { scope: 'project', projectId: PROJET_A, confirm: 'SUPPRIMER' },
  });
  check('la suppression en masse aboutit', res.status === 200);
  check('…et rend le nombre de règles qui SURVIVENT', res.json.data.activeRecurringCosts === actives);

  const reglesApres = await PanelRecurringCost.countDocuments({ projectId: PROJET_A, status: 'ACTIVE' });
  check('les règles ne sont ni supprimées ni arrêtées', reglesApres === actives);

  const vivantes = await PanelFinancialTransaction.countDocuments({ projectId: PROJET_A, deletedAt: null });
  check('le livret du projet est vide', vivantes === 0);

  // Le point subtil : les occurrences passées ne doivent pas ressusciter.
  const relecture = await call('GET', `/api/finances/transactions?scope=project&projectId=${PROJET_A}&period=ALL`, { headers: AUTH });
  check('une relecture ne ressuscite AUCUNE occurrence passée',
    relecture.json.data.items.length === 0);
}

section('14. Convergence sans ordonnanceur : la LECTURE matérialise');
{
  /**
   * L'ancre est dans le passé RÉEL, et la création est faite avec une horloge
   * figée AU JOUR DE L'ANCRE : une seule occurrence naît. Tout ce qui s'est
   * écoulé depuis reste dû — c'est exactement la situation d'un Panel qui
   * redémarre après une coupure, et c'est la LECTURE qui doit la rattraper.
   */
  const ancre = new Date(Date.now() - 10 * 86_400_000);
  const jour = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(ancre);

  const def = await recurring.createRecurringCost({
    scope: 'PROJECT', projectId: PROJET_B, label: 'Convergence', amount: '15',
    recurrence: { unit: 'DAY', interval: 1 }, startAt: jour,
  }, {}, { now: ancre });

  const apresCreation = await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId });
  check('au jour de l’ancre, une seule occurrence', apresCreation === 1);

  // On n'appelle AUCUN matérialiseur : seulement l'API de lecture.
  const lecture = await call('GET', `/api/finances/summary?scope=project&projectId=${PROJET_B}&period=ALL`, { headers: AUTH });
  check('la lecture répond', lecture.status === 200);

  const apresLecture = await PanelFinancialTransaction.countDocuments({ sourceId: def.recurringCostId });
  check('…et elle a matérialisé les cycles dus, sans ordonnanceur',
    apresLecture > apresCreation);

  const ordonnanceur = await import('../backend/src/services/finance/recurringCostScheduler.js');
  check('un ordonnanceur existe par ailleurs',
    typeof ordonnanceur.startRecurringCostScheduler === 'function');
  const cycle = await ordonnanceur.runRecurringCostCycle();
  check('…il est idempotent : rien de neuf après la lecture', cycle.created === 0);
}

section('15. Garde-fou : aucun fournisseur dans le code des récurrences');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fichiers = [
    'backend/src/models/PanelRecurringCost.model.js',
    'backend/src/services/finance/recurrence.js',
    'backend/src/services/finance/recurringCosts.service.js',
    'backend/src/services/finance/recurringCostScheduler.js',
    'backend/src/services/finance/receipts.service.js',
  ];
  const codeDe = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const CODE_FOURNISSEUR = /\bstripe[A-Za-z]*\b|\bStripe[A-Za-z]+\b/;
  const offenses = [];
  for (const rel of fichiers) {
    const source = codeDe(rel);
    if (CODE_FOURNISSEUR.test(source)) offenses.push(`${rel} (stripe)`);
    if (/\bfetch\s*\(/.test(source)) offenses.push(`${rel} (réseau)`);
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (imports.some((i) => /stripe|billing|capabilit|integratedApi|bridge\//i.test(i))) {
      offenses.push(`${rel} (import)`);
    }
  }
  check(`aucun fournisseur, aucun réseau, aucun pont${offenses.length ? ` — ${offenses}` : ''}`,
    offenses.length === 0);
}

await close();
await stopMemoryMongo();
finish();
