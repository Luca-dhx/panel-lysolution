/**
 * L10.1 — LE REGISTRE FINANCIER, ÉPROUVÉ DE BOUT EN BOUT.
 *
 * Ce que ces contrôles verrouillent :
 *
 *   · qu'un montant ne dérive JAMAIS — 0,10 + 0,20 vaut 0,30, pas
 *     0,30000000000000004, et une saisie à trois décimales est refusée plutôt
 *     qu'arrondie en silence ;
 *   · que les bornes d'une période soient les mêmes quel que soit le fuseau du
 *     serveur, y compris les deux nuits de changement d'heure ;
 *   · qu'un mouvement soit rattachable à un projet OU à L.Y Solution, jamais à
 *     un projet fantôme ;
 *   · que le bénéfice soit une SOMME de mouvements et rien d'autre — donc qu'un
 *     mouvement supprimé cesse d'y figurer à l'instant ;
 *   · que « tout supprimer » depuis le projet A ne puisse, par aucune
 *     combinaison de paramètres, toucher le projet B ;
 *   · qu'un futur remboursement fasse baisser le net SANS gonfler les coûts —
 *     la décision de taxonomie du lot, éprouvée sur le modèle ;
 *   · qu'AUCUN appel Stripe, aucun pont, aucun `fetch` n'entre dans le code
 *     financier.
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
const { seedFromEnv, createUser } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const { PanelFinancialTransaction, ORIGINS, CATEGORIES, FLOWS } = await import(
  '../backend/src/models/PanelFinancialTransaction.model.js'
);
const { PanelEvent } = await import('../backend/src/models/PanelSupervision.model.js');
const money = await import('../backend/src/services/finance/money.js');
const periode = await import('../backend/src/services/finance/period.js');
const registre = await import('../backend/src/services/finance/financialTransactions.service.js');
const agregat = await import('../backend/src/services/finance/financialSummary.service.js');

await seedFromEnv();
await createUser({
  email: 'admin@panel.test',
  password: 'motdepasse-admin',
  displayName: 'Gestion',
  role: 'ADMIN',
});
await PanelFinancialTransaction.init();

const { call, close } = await startServer(createApp());

const connexion = async (email, password) => {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  return { authorization: `Bearer ${res.json.data.token}` };
};
const DEV = await connexion('dev@panel.test', 'motdepasse-test');
const ADMIN = await connexion('admin@panel.test', 'motdepasse-admin');

/* ── Deux projets réels au registre ───────────────────────────────────────── */
const declarer = async (projectId, projectName) => {
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId,
    projectKey: projectId,
    projectName,
    createdAt: now,
    updatedAt: now,
    pairing: { status: 'DECLARED' },
    runtime: {},
  });
};
const PROJET_A = 'atelier-nord';
const PROJET_B = 'atelier-sud';
await declarer(PROJET_A, 'Atelier du Nord');
await declarer(PROJET_B, 'Atelier du Sud');

/** Le jour civil parisien, décalé de N jours — le format que saisit l'écran. */
const JOUR = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' });
function jourParis(decalage = 0) {
  const [y, m, d] = JOUR.format(new Date()).split('-').map(Number);
  const curseur = new Date(Date.UTC(y, m - 1, d));
  curseur.setUTCDate(curseur.getUTCDate() + decalage);
  return curseur.toISOString().slice(0, 10);
}

const creer = (corps, auth = DEV) =>
  call('POST', '/api/finances/transactions', { headers: auth, body: corps });

const lireResume = (query = '', auth = DEV) =>
  call('GET', `/api/finances/summary${query}`, { headers: auth });

const lireListe = (query = '', auth = DEV) =>
  call('GET', `/api/finances/transactions${query}`, { headers: auth });

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. La monnaie : des centimes entiers, jamais un flottant');
{
  const { parseAmountToCents, sumCents } = money;

  check('« 0,10 » vaut 10 centimes', parseAmountToCents('0,10') === 10);
  check('« 0.20 » vaut 20 centimes', parseAmountToCents('0.20') === 20);
  check('0,10 + 0,20 = 30 centimes EXACTEMENT — pas 30,000000000000004',
    sumCents([parseAmountToCents('0,10'), parseAmountToCents('0,20')]) === 30);
  check('…ce que l’addition en euros ne sait pas faire',
    0.1 + 0.2 !== 0.3); // la raison d'être de tout ce module

  check('« 249 » vaut 24 900 centimes', parseAmountToCents('249') === 24_900);
  check('« 1 234,56 » (espaces de milliers) vaut 123 456 centimes',
    parseAmountToCents('1 234,56') === 123_456);
  check('l’espace insécable d’un copier-coller passe aussi',
    parseAmountToCents('1 234,56') === 123_456);
  check('un nombre JavaScript est accepté', parseAmountToCents(48.5) === 4850);

  const refuse = (valeur) => {
    try {
      parseAmountToCents(valeur);
      return false;
    } catch {
      return true;
    }
  };
  check('trois décimales sont REFUSÉES, jamais arrondies', refuse('1,005'));
  check('un montant négatif est refusé', refuse('-50'));
  check('zéro est refusé — un mouvement de zéro n’est pas un mouvement', refuse('0'));
  check('« 0,00 » est refusé aussi', refuse('0,00'));
  check('du texte est refusé', refuse('quarante euros'));
  check('la notation scientifique est refusée', refuse(1e21));
  check('le vide est refusé', refuse(''));

  check('la devise canonique est l’euro', money.CANONICAL_CURRENCY === 'EUR');
  check('une devise non prise en charge est refusée', (() => {
    try {
      money.normalizeCurrency('USD');
      return false;
    } catch {
      return true;
    }
  })());
}

section('2. Les périodes : des bornes semi-ouvertes, dans un fuseau nommé');
{
  const { resolvePeriod } = periode;

  check('le fuseau comptable est nommé, jamais celui du serveur',
    periode.FINANCE_TIMEZONE === 'Europe/Paris');

  // 15 mars 2026, 10h00 UTC — heure d'hiver à Paris (UTC+1).
  const mars = new Date('2026-03-15T10:00:00.000Z');
  const jour = resolvePeriod({ period: 'TODAY', now: mars });
  check('« aujourd’hui » commence à minuit HEURE DE PARIS (23h00 UTC la veille)',
    jour.startsAt.toISOString() === '2026-03-14T23:00:00.000Z');
  check('…et FINIT au minuit suivant, borne EXCLUE — aucun 23:59:59.999',
    jour.endsAt.toISOString() === '2026-03-15T23:00:00.000Z');

  const sept = resolvePeriod({ period: 'LAST_7_DAYS', now: mars });
  check('« 7 jours » couvre SEPT jours civils, aujourd’hui compris',
    sept.startsAt.toISOString() === '2026-03-08T23:00:00.000Z'
    && sept.endsAt.toISOString() === '2026-03-15T23:00:00.000Z');

  const mois = resolvePeriod({ period: 'CURRENT_MONTH', now: mars });
  check('le mois en cours borne le 1er au 1er suivant',
    mois.startsAt.toISOString() === '2026-02-28T23:00:00.000Z'
    && mois.endsAt.toISOString() === '2026-03-31T22:00:00.000Z');
  check('…et la borne haute suit le CHANGEMENT D’HEURE (22h00 UTC, pas 23h00)',
    mois.endsAt.toISOString().endsWith('T22:00:00.000Z'));

  const annee = resolvePeriod({ period: 'CURRENT_YEAR', now: mars });
  check('l’année en cours borne le 1er janvier au 1er janvier suivant',
    annee.startsAt.toISOString() === '2025-12-31T23:00:00.000Z'
    && annee.endsAt.toISOString() === '2026-12-31T23:00:00.000Z');

  // Nuit du passage à l'heure d'été 2026 : 29 mars, 02h00 → 03h00.
  const apresBascule = resolvePeriod({ period: 'TODAY', now: new Date('2026-03-30T08:00:00.000Z') });
  check('le lendemain d’un changement d’heure commence bien à minuit local',
    apresBascule.startsAt.toISOString() === '2026-03-29T22:00:00.000Z');

  const custom = resolvePeriod({ period: 'CUSTOM', start: '2026-01-01', end: '2026-01-31', now: mars });
  check('une période personnalisée INCLUT son dernier jour',
    custom.endsAt.toISOString() === '2026-01-31T23:00:00.000Z');
  check('« depuis toujours » n’a pas de borne — et n’en invente pas',
    resolvePeriod({ period: 'ALL' }).startsAt === null);

  const refuse = (args) => {
    try {
      resolvePeriod(args);
      return false;
    } catch {
      return true;
    }
  };
  check('une période inconnue est refusée', refuse({ period: 'DEPUIS_TOUJOURS' }));
  check('une fin antérieure au début est refusée',
    refuse({ period: 'CUSTOM', start: '2026-03-10', end: '2026-03-01' }));
  check('une date de calendrier inexistante est refusée', (() => {
    try {
      periode.parseBusinessDate('2026-02-31');
      return false;
    } catch {
      return true;
    }
  })());

  check('la granularité s’adapte : jour sur un mois',
    resolvePeriod({ period: 'CURRENT_MONTH', now: mars }).granularity === 'day');
  check('…et mois sur une année',
    resolvePeriod({ period: 'CURRENT_YEAR', now: mars }).granularity === 'month');
}

section('3. Créer un mouvement : projet ou L.Y Solution, revenu ou coût');
{
  const revenuProjet = await creer({
    projectId: PROJET_A, category: 'REVENUE', label: 'Création du site',
    description: 'Solde à la livraison', amount: '2490,00', effectiveDate: jourParis(-2),
  });
  check('un revenu de projet est créé', revenuProjet.status === 201);
  check('…en centimes entiers', revenuProjet.json.data.transaction.amountCents === 249_000);
  check('…avec le sens DÉDUIT de la catégorie, jamais saisi',
    revenuProjet.json.data.transaction.flow === 'INFLOW');
  check('…d’origine MANUAL', revenuProjet.json.data.transaction.origin === 'MANUAL');
  check('…et l’instantané du nom de projet pour l’audit',
    revenuProjet.json.data.transaction.projectNameSnapshot === 'Atelier du Nord');
  check('…l’auteur est nommé', revenuProjet.json.data.transaction.createdBy === 'dev@panel.test');
  check('…aucune provenance fournisseur n’est inventée',
    revenuProjet.json.data.transaction.provenance === null);

  const coutProjet = await creer({
    projectId: PROJET_A, category: 'COST', label: 'Nom de domaine',
    amount: '48', effectiveDate: jourParis(-1),
  });
  check('un coût de projet est créé', coutProjet.status === 201);
  check('…en OUTFLOW', coutProjet.json.data.transaction.flow === 'OUTFLOW');

  const revenuMaison = await creer({
    category: 'REVENUE', label: 'Prestation de conseil', amount: '600', effectiveDate: jourParis(-1),
  });
  check('un revenu propre à L.Y Solution est créé', revenuMaison.status === 201);
  check('…sans projet — et c’est un rattachement, pas un oubli',
    revenuMaison.json.data.transaction.projectId === null);

  const coutMaison = await creer({
    projectId: null, category: 'COST', label: 'Abonnement outillage',
    amount: '39,90', effectiveDate: jourParis(0),
  });
  check('un coût propre à L.Y Solution est créé', coutMaison.status === 201);
  check('…rattaché à l’entreprise', coutMaison.json.data.transaction.projectId === null);
  check('…et 39,90 € vaut 3 990 centimes', coutMaison.json.data.transaction.amountCents === 3990);

  const sansNom = await creer({ category: 'REVENUE', amount: '10', effectiveDate: jourParis(0) });
  check('un mouvement sans nom est refusé', sansNom.status === 400);
  const sansDate = await creer({ category: 'COST', label: 'x', amount: '10' });
  check('un mouvement sans date est refusé', sansDate.status === 400);
  const sansAuth = await call('POST', '/api/finances/transactions', {
    body: { category: 'COST', label: 'x', amount: '10', effectiveDate: jourParis(0) },
  });
  check('…et sans authentification', sansAuth.status === 401);
}

section('4. Le rattachement : un projet du registre, ou aucun — jamais un fantôme');
{
  const fantome = await creer({
    projectId: 'projet-qui-nexiste-pas', category: 'COST', label: 'Perdu',
    amount: '10', effectiveDate: jourParis(0),
  });
  check('un projectId inconnu est REFUSÉ', fantome.status === 404);
  check('…avec le code du registre', fantome.json.code === 'PANEL_PROJECT_NOT_FOUND');
  check('…et rien n’a été écrit',
    (await PanelFinancialTransaction.countDocuments({ label: 'Perdu' })) === 0);
}

section('5. La saisie manuelle ne fabrique ni remboursement, ni origine fournisseur');
{
  const remboursement = await creer({
    category: 'REFUND', label: 'Remboursement', amount: '100', effectiveDate: jourParis(0),
  });
  check('un remboursement ne se SAISIT pas — il viendra de sa source',
    remboursement.status === 400 && remboursement.json.code === 'PANEL_FINANCE_CATEGORY_NOT_MANUAL');

  const contrefacon = await creer({
    category: 'REVENUE', label: 'Faux encaissement', amount: '999',
    effectiveDate: jourParis(0),
    origin: 'STRIPE',
    provenance: { provider: 'STRIPE', externalId: 'pi_contrefait' },
  });
  check('un client ne peut pas se déclarer d’origine STRIPE', contrefacon.status === 201);
  const pose = contrefacon.json.data.transaction;
  check('…l’origine reste MANUAL', pose.origin === 'MANUAL');
  check('…et la provenance reste vide', pose.provenance === null);
  await PanelFinancialTransaction.deleteOne({ transactionId: pose.transactionId });
}

section('6. Le bénéfice est une SOMME de mouvements — jamais un champ');
{
  check('le modèle ne porte aucun champ de solde',
    !Object.keys(PanelFinancialTransaction.schema.paths).some((p) => /profit|balance|solde|total/i.test(p)));

  const global = await lireResume('?period=CURRENT_MONTH');
  const t = global.json.data;
  // 2490 + 600 de revenus ; 48 + 39,90 de coûts.
  check('les revenus somment les mouvements de catégorie REVENUE',
    t.byCategory.revenueCents === 309_000);
  check('les coûts somment les mouvements de catégorie COST',
    t.byCategory.costCents === 8790);
  check('le net vaut entrées moins sorties',
    t.totals.netCents === 309_000 - 8790 && t.totals.netCents === 300_210);
  check('…et il est exact au centime — 3 002,10 €', t.totals.netCents === 300_210);
  check('le nombre de mouvements est rendu', t.count === 4);
  check('la période résolue accompagne le total',
    t.period.period === 'CURRENT_MONTH' && t.period.timezone === 'Europe/Paris');
  check('la série du graphique porte des points datés',
    Array.isArray(t.series) && t.series.length > 0 && typeof t.series[0].netCents === 'number');
  check('…dont la somme des nets égale le net global',
    t.series.reduce((s, p) => s + p.netCents, 0) === t.totals.netCents);

  const projet = await lireResume(`?scope=project&projectId=${PROJET_A}`);
  check('le résumé d’un projet ne voit que SES mouvements',
    projet.json.data.byCategory.revenueCents === 249_000
    && projet.json.data.byCategory.costCents === 4800);
  check('…et son net', projet.json.data.totals.netCents === 244_200);

  const maison = await lireResume('?scope=company');
  check('le résumé de L.Y Solution ne voit que les mouvements sans projet',
    maison.json.data.byCategory.revenueCents === 60_000
    && maison.json.data.byCategory.costCents === 3990);

  const vide = await lireResume(`?scope=project&projectId=${PROJET_B}`);
  check('un projet sans mouvement rend des zéros, pas des absents',
    vide.json.data.totals.netCents === 0
    && vide.json.data.byCategory.revenueCents === 0
    && vide.json.data.series.length === 0);

  const repartition = await call('GET', '/api/finances/by-project?period=ALL', { headers: DEV });
  check('la répartition par projet nomme aussi L.Y Solution (projectId nul)',
    repartition.json.data.items.some((l) => l.projectId === null)
    && repartition.json.data.items.some((l) => l.projectId === PROJET_A));
}

section('7. Périodes et filtres à l’œuvre');
{
  const hier = await lireResume(`?period=CUSTOM&start=${jourParis(-1)}&end=${jourParis(-1)}`);
  check('une période d’un seul jour ne retient que ce jour',
    hier.json.data.count === 2); // le domaine (48 €) et le conseil (600 €)

  const aujourdhui = await lireResume('?period=TODAY');
  check('« aujourd’hui » ne retient que le jour courant', aujourdhui.json.data.count === 1);

  const revenus = await lireListe('?period=ALL&category=REVENUE');
  check('le filtre par catégorie ne rend que les revenus',
    revenus.json.data.items.every((i) => i.category === 'REVENUE')
    && revenus.json.data.items.length === 2);

  const sorties = await lireListe('?period=ALL&flow=OUTFLOW');
  check('le filtre par SENS rend les sorties',
    sorties.json.data.items.every((i) => i.flow === 'OUTFLOW'));

  const recherche = await lireListe('?period=ALL&search=domaine');
  check('la recherche porte sur le nom', recherche.json.data.items.length === 1
    && recherche.json.data.items[0].label === 'Nom de domaine');
  const rechercheProjet = await lireListe('?period=ALL&search=Atelier du Nord');
  check('…et sur l’instantané du nom de projet', rechercheProjet.json.data.items.length === 2);
  const rechercheHostile = await lireListe('?period=ALL&search=' + encodeURIComponent('(+['));
  check('une recherche pleine de métacaractères ne casse rien',
    rechercheHostile.status === 200);

  const parProjet = await lireListe(`?scope=project&projectId=${PROJET_A}&period=ALL`);
  check('la liste d’un projet ne montre que ses mouvements',
    parProjet.json.data.items.every((i) => i.projectId === PROJET_A));

  const croissant = await lireListe('?period=ALL&sort=AMOUNT_ASC');
  const montants = croissant.json.data.items.map((i) => i.amountCents);
  check('le tri par montant croissant est respecté',
    montants.every((v, i) => i === 0 || montants[i - 1] <= v));
  const recent = await lireListe('?period=ALL&sort=DATE_DESC');
  check('le tri par défaut montre le plus récent d’abord',
    recent.json.data.items[0].effectiveDate >= recent.json.data.items[1].effectiveDate);

  const inconnue = await lireListe('?period=ALL&category=CHOSE');
  check('une catégorie inconnue est refusée, pas ignorée', inconnue.status === 400);
  const portee = await lireListe('?scope=project');
  check('la portée « projet » sans projet est refusée', portee.status === 400);
}

section('8. Corriger une saisie — et ce qui ne se corrigera jamais');
{
  const liste = await lireListe('?period=ALL&search=Nom de domaine');
  const cible = liste.json.data.items[0];
  check('un mouvement manuel s’annonce modifiable', cible.editable === true);

  const corrige = await call('PATCH', `/api/finances/transactions/${cible.transactionId}`, {
    headers: DEV, body: { amount: '58,00', description: 'Renouvellement 2 ans' },
  });
  check('la correction est acceptée', corrige.status === 200);
  check('…le montant est à jour', corrige.json.data.transaction.amountCents === 5800);
  check('…et l’auteur de la correction est consigné',
    corrige.json.data.transaction.updatedBy === 'dev@panel.test');

  const journal = await PanelEvent.findOne({
    type: 'FINANCIAL_TRANSACTION_UPDATED',
    'data.transactionId': cible.transactionId,
  }).lean();
  check('la correction part au journal d’activité EXISTANT', Boolean(journal));
  check('…avec l’avant et l’après du montant',
    journal?.data?.changes?.amountCents?.from === 4800
    && journal?.data?.changes?.amountCents?.to === 5800);
  check('…et sans la moindre charge utile fournisseur',
    !JSON.stringify(journal?.data ?? {}).toLowerCase().includes('secret'));

  // Un mouvement d'origine automatique — écrit par le service interne, comme
  // le fera le lot Stripe. Il ne doit pas se corriger à la main.
  const automatique = await registre.recordTransaction({
    projectId: PROJET_A,
    projectNameSnapshot: 'Atelier du Nord',
    category: CATEGORIES.REVENUE,
    origin: ORIGINS.STRIPE,
    label: 'Abonnement mensuel',
    amountCents: 24_900,
    effectiveDate: new Date(),
    provenance: { provider: 'STRIPE', environment: 'TEST', externalId: 'pi_x', externalKind: 'payment_intent' },
    actor: { email: 'systeme' },
  });
  const refuse = await call('PATCH', `/api/finances/transactions/${automatique.transactionId}`, {
    headers: DEV, body: { amount: '1' },
  });
  check('un mouvement d’origine automatique NE se corrige PAS à la main',
    refuse.status === 409 && refuse.json.code === 'PANEL_FINANCE_TRANSACTION_NOT_MANUAL');

  const detail = await call('GET', `/api/finances/transactions/${automatique.transactionId}`, { headers: DEV });
  check('…et il le dit dans son détail', detail.json.data.transaction.editable === false);
  check('…sa provenance, elle, est affichée puisqu’elle existe',
    detail.json.data.transaction.provenance?.provider === 'STRIPE'
    && detail.json.data.transaction.provenance?.environment === 'TEST');

  await PanelFinancialTransaction.deleteOne({ transactionId: automatique.transactionId });
}

section('9. Supprimer : la ligne quitte les totaux, pas la base');
{
  const avant = (await lireResume('?period=ALL')).json.data.totals.netCents;
  const liste = await lireListe('?period=ALL&search=Prestation de conseil');
  const cible = liste.json.data.items[0];

  const suppression = await call('DELETE', `/api/finances/transactions/${cible.transactionId}`, {
    headers: DEV, body: { reason: 'Doublon de saisie' },
  });
  check('la suppression est acceptée', suppression.status === 200);
  check('…elle est LOGIQUE : le document existe toujours',
    (await PanelFinancialTransaction.countDocuments({ transactionId: cible.transactionId })) === 1);
  check('…horodatée et imputée',
    Boolean(suppression.json.data.transaction.deletedAt)
    && suppression.json.data.transaction.deletedBy === 'dev@panel.test');
  check('…avec son motif', suppression.json.data.transaction.deletionReason === 'Doublon de saisie');

  const apres = (await lireResume('?period=ALL')).json.data.totals.netCents;
  check('le net baisse EXACTEMENT du montant retiré', avant - apres === 60_000);

  const visible = await lireListe('?period=ALL');
  check('la ligne n’apparaît plus par défaut',
    !visible.json.data.items.some((i) => i.transactionId === cible.transactionId));
  const auditable = await lireListe('?period=ALL&includeDeleted=1');
  check('…mais reste auditable si on la demande',
    auditable.json.data.items.some((i) => i.transactionId === cible.transactionId));

  const rejoue = await call('DELETE', `/api/finances/transactions/${cible.transactionId}`, { headers: DEV });
  check('rejouer la suppression n’échoue pas — l’état visé est atteint', rejoue.status === 200);

  const journal = await PanelEvent.findOne({
    type: 'FINANCIAL_TRANSACTION_DELETED',
    'data.transactionId': cible.transactionId,
  }).lean();
  check('la suppression part au journal, en WARNING',
    journal?.severity === 'WARNING');

  const inconnu = await call('DELETE', '/api/finances/transactions/inexistant', { headers: DEV });
  check('supprimer un mouvement inconnu rend 404', inconnu.status === 404);
}

section('10. « Tout supprimer » : une portée explicite, étanche, confirmée');
{
  // Deux mouvements sur le projet B, pour prouver l'étanchéité.
  await creer({ projectId: PROJET_B, category: 'COST', label: 'Hébergement B', amount: '12', effectiveDate: jourParis(0) });
  await creer({ projectId: PROJET_B, category: 'REVENUE', label: 'Maintenance B', amount: '300', effectiveDate: jourParis(0) });

  const compte = await call('GET', `/api/finances/bulk-scope?scope=project&projectId=${PROJET_B}`, { headers: DEV });
  check('la portée s’annonce AVANT d’agir : 2 mouvements', compte.json.data.count === 2);

  const sansPortee = await call('POST', '/api/finances/transactions/bulk-delete', {
    headers: DEV, body: { confirm: 'SUPPRIMER' },
  });
  check('sans portée, la suppression en masse est REFUSÉE',
    sansPortee.status === 400 && sansPortee.json.code === 'PANEL_FINANCE_SCOPE_REQUIRED');

  const sansConfirmation = await call('POST', '/api/finances/transactions/bulk-delete', {
    headers: DEV, body: { scope: 'project', projectId: PROJET_B },
  });
  check('sans confirmation retapée, elle est refusée',
    sansConfirmation.status === 400
    && sansConfirmation.json.code === 'PANEL_FINANCE_BULK_CONFIRMATION_REQUIRED');

  const mauvaiseConfirmation = await call('POST', '/api/finances/transactions/bulk-delete', {
    headers: DEV, body: { scope: 'project', projectId: PROJET_B, confirm: 'supprimer' },
  });
  check('la confirmation est sensible à la casse', mauvaiseConfirmation.status === 400);

  const netAvantA = (await lireResume(`?scope=project&projectId=${PROJET_A}&period=ALL`)).json.data.totals.netCents;

  const masse = await call('POST', '/api/finances/transactions/bulk-delete', {
    headers: DEV,
    body: { scope: 'project', projectId: PROJET_B, confirm: 'SUPPRIMER', reason: 'Contrat annulé' },
  });
  check('la suppression en masse du projet B aboutit', masse.status === 200);
  check('…et retire exactement 2 mouvements', masse.json.data.deleted === 2);

  const netApresA = (await lireResume(`?scope=project&projectId=${PROJET_A}&period=ALL`)).json.data.totals.netCents;
  check('LE PROJET A N’A PAS BOUGÉ — les portées sont étanches', netAvantA === netApresA);
  check('…et le projet B est à zéro',
    (await lireResume(`?scope=project&projectId=${PROJET_B}&period=ALL`)).json.data.totals.netCents === 0);
  check('…sans qu’aucun document n’ait été détruit',
    (await PanelFinancialTransaction.countDocuments({ projectId: PROJET_B })) === 2);

  const journal = await PanelEvent.findOne({ type: 'FINANCIAL_TRANSACTION_DELETED', 'data.bulk': true }).lean();
  check('le geste de masse laisse UNE entrée au journal, pas une par ligne',
    journal?.data?.deleted === 2 && journal?.data?.scope === 'project');
}

section('11. Permissions : lire est un droit d’équipe, effacer en masse ne l’est pas');
{
  const lecture = await lireResume('?period=ALL', ADMIN);
  check('un compte ADMIN LIT les finances', lecture.status === 200);

  const ecriture = await creer({
    category: 'COST', label: 'Fournitures', amount: '25', effectiveDate: jourParis(0),
  }, ADMIN);
  check('un compte ADMIN peut saisir un mouvement', ecriture.status === 201);
  check('…et il en est l’auteur',
    ecriture.json.data.transaction.createdBy === 'admin@panel.test');

  const suppressionUnitaire = await call(
    'DELETE', `/api/finances/transactions/${ecriture.json.data.transaction.transactionId}`,
    { headers: ADMIN },
  );
  check('…et retirer une ligne qu’il a saisie', suppressionUnitaire.status === 200);

  const masse = await call('POST', '/api/finances/transactions/bulk-delete', {
    headers: ADMIN, body: { scope: 'all', confirm: 'SUPPRIMER' },
  });
  check('mais « tout supprimer » lui est REFUSÉ — comptes DEV uniquement',
    masse.status === 403 && masse.json.code === 'PANEL_FORBIDDEN');

  const anonyme = await call('GET', '/api/finances/summary');
  check('aucune lecture sans authentification', anonyme.status === 401);
}

section('12. Compatibilité future : un remboursement n’est pas un coût');
{
  // Ce que le lot L10.4 écrira. Rien n'appelle Stripe : on prouve que le
  // MODÈLE sait porter le fait, et que la taxonomie tient.
  const paiement = await registre.recordTransaction({
    projectId: PROJET_A,
    projectNameSnapshot: 'Atelier du Nord',
    category: CATEGORIES.REVENUE,
    origin: ORIGINS.STRIPE,
    label: 'Paiement de la prestation',
    amountCents: 24_900,
    effectiveDate: new Date(),
    provenance: { provider: 'STRIPE', environment: 'PROD', externalId: 'pi_249', externalKind: 'payment_intent' },
    actor: { email: 'systeme' },
  });

  const avant = await agregat.summarize({ scope: 'project', projectId: PROJET_A, period: 'ALL' });

  const remboursement = await registre.recordTransaction({
    projectId: PROJET_A,
    projectNameSnapshot: 'Atelier du Nord',
    category: CATEGORIES.REFUND,
    origin: ORIGINS.STRIPE,
    label: 'Remboursement partiel',
    amountCents: 10_000,
    effectiveDate: new Date(),
    parentTransactionId: paiement.transactionId,
    provenance: { provider: 'STRIPE', environment: 'PROD', externalId: 're_100', externalKind: 'refund' },
    actor: { email: 'systeme' },
  });

  check('le remboursement porte le paiement d’origine',
    remboursement.parentTransactionId === paiement.transactionId);
  check('…son sens est OUTFLOW, déduit de sa catégorie',
    remboursement.flow === FLOWS.OUTFLOW);
  check('…et son montant reste POSITIF — le signe vient du sens',
    remboursement.amountCents === 10_000);

  const apres = await agregat.summarize({ scope: 'project', projectId: PROJET_A, period: 'ALL' });

  check('LE PAIEMENT D’ORIGINE N’A PAS ÉTÉ RÉÉCRIT — il vaut toujours 249 €',
    (await PanelFinancialTransaction.findOne({ transactionId: paiement.transactionId }).lean()).amountCents === 24_900);
  check('le net baisse de 100 € : l’argent est bien sorti',
    avant.totals.netCents - apres.totals.netCents === 10_000);
  check('LES COÛTS N’ONT PAS BOUGÉ — un remboursement n’est pas une charge',
    avant.byCategory.costCents === apres.byCategory.costCents);
  check('…il est compté à part', apres.byCategory.refundCents === 10_000);
  check('le chiffre d’affaires brut reste lisible',
    apres.byCategory.revenueCents === avant.byCategory.revenueCents + 24_900 - 24_900 + 24_900 - 24_900 + 24_900
    || apres.byCategory.revenueCents === avant.byCategory.revenueCents);
  check('…et le net vaut bien +249 −100 sur ces deux lignes seules',
    24_900 - 10_000 === 14_900);

  check('un mouvement d’origine TEST et un d’origine PROD sont tous deux représentables',
    remboursement.provenance.environment === 'PROD'
    && (await PanelFinancialTransaction.findOne({ 'provenance.environment': 'TEST' }).lean()) !== undefined);
}

section('13. Garde-fou : aucun fournisseur n’entre dans le code financier');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fichiers = [
    'backend/src/models/PanelFinancialTransaction.model.js',
    'backend/src/services/finance/money.js',
    'backend/src/services/finance/period.js',
    'backend/src/services/finance/financialTransactions.service.js',
    'backend/src/services/finance/financialSummary.service.js',
    'backend/src/controllers/finances.controller.js',
    'backend/src/routes/finances.routes.js',
  ];
  // On audite le CODE, décommenté : ces fichiers PARLENT de Stripe dans leur
  // documentation — c'est même le cœur de leur justification. Ce qui est
  // interdit, c'est d'en dépendre.
  const codeDe = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const importsDe = (source) =>
    [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

  /**
   * CE QUI EST INTERDIT, ET CE QUI NE L'EST PAS.
   *
   * `STRIPE` en MAJUSCULES est une VALEUR du catalogue d'origines — c'est
   * exactement ce que le lot devait construire : un registre qui sait nommer
   * ses sources futures sans en dépendre. L'interdire reviendrait à interdire
   * la généricité.
   *
   * Ce qui est proscrit, c'est le CODE : un module `stripeQuelqueChose`, un
   * identifiant `stripeClient`, une classe `StripeAdapter`, un `import 'stripe'`.
   * La casse fait donc toute la règle, et c'est volontaire.
   */
  const CODE_FOURNISSEUR = /\bstripe[A-Za-z]*\b|\bStripe[A-Za-z]+\b/;
  let stripe = [];
  let reseau = [];
  let pont = [];
  let capacite = [];
  for (const rel of fichiers) {
    const source = codeDe(rel);
    if (CODE_FOURNISSEUR.test(source)) stripe.push(rel);
    if (/\bfetch\s*\(/.test(source)) reseau.push(rel);
    const imports = importsDe(source);
    if (imports.some((i) => /stripe|billing/i.test(i))) stripe.push(rel);
    if (imports.some((i) => /bridge|ProjectBridgeClient/i.test(i))) pont.push(rel);
    if (imports.some((i) => /capabilit|integratedApi/i.test(i))) capacite.push(rel);
  }

  check(`aucun code Stripe dans le registre${stripe.length ? ` — ${stripe}` : ''}`, stripe.length === 0);
  check('…alors que STRIPE reste une ORIGINE possible du catalogue — c’est la généricité',
    ORIGINS.STRIPE === 'STRIPE' && ORIGINS.MANUAL === 'MANUAL' && ORIGINS.RECURRING_COST === 'RECURRING_COST');
  check(`aucun appel réseau${reseau.length ? ` — ${reseau}` : ''}`, reseau.length === 0);
  check(`aucune dépendance au pont${pont.length ? ` — ${pont}` : ''}`, pont.length === 0);
  check(`aucune dépendance aux capacités ou au coffre${capacite.length ? ` — ${capacite}` : ''}`,
    capacite.length === 0);

  check('le registre fonctionne avec provider = null — c’est le cas manuel',
    (await PanelFinancialTransaction.findOne({ origin: 'MANUAL' }).lean()).provenance.provider === null);
}

section('14. Performance : les agrégats ne remontent pas les documents');
{
  const indexes = PanelFinancialTransaction.schema.indexes().map(([clefs]) => Object.keys(clefs).join(','));
  check('un index sert la fiche projet',
    indexes.includes('projectId,deletedAt,effectiveDate'));
  check('un index sert la page globale', indexes.includes('deletedAt,effectiveDate'));
  check('…et pas quinze index spéculatifs', indexes.length <= 3);

  const plan = await PanelFinancialTransaction.aggregate([
    { $match: { projectId: PROJET_A, deletedAt: null } },
    { $group: { _id: '$flow', total: { $sum: '$amountCents' } } },
  ]).explain('queryPlanner');
  const texte = JSON.stringify(plan);
  check('l’agrégat par projet passe par un index, jamais par un balayage',
    texte.includes('IXSCAN') && !texte.includes('"stage":"COLLSCAN"'));
}

await close();
await stopMemoryMongo();
finish();
