/**
 * AGRÉGATEUR — le bénéfice, calculé et jamais stocké.
 *
 * ══ POURQUOI TOUT SE PASSE DANS MONGODB ═════════════════════════════════════
 *
 * La tentation était de lire les mouvements et de les additionner en Node.
 * Elle marche parfaitement sur trois lignes, et elle est intenable ensuite :
 * afficher le bénéfice de l'année charge alors l'année entière en mémoire pour
 * en tirer trois nombres. Le coût d'un écran d'accueil deviendrait
 * proportionnel à l'ancienneté de l'entreprise — la définition même d'une
 * lenteur qu'on ne voit jamais venir.
 *
 * L'agrégat vit donc dans la base, sur les mêmes index que la liste. Un seul
 * aller-retour, un `$facet` : les totaux et les points du graphique sortent de
 * la même lecture, donc du même ensemble de lignes. Les calculer séparément
 * autoriserait un écart entre le total affiché et la somme des barres.
 *
 * ══ LE SIGNE VIENT DU SENS, PAS DU MONTANT ══════════════════════════════════
 *
 *     net = Σ(INFLOW) − Σ(OUTFLOW)
 *
 * et non « somme des montants signés ». Les montants stockés sont tous
 * positifs (voir le modèle) : il n'y a donc aucun double négatif possible, et
 * un coût ne peut pas augmenter le bénéfice par accident de saisie.
 *
 * ══ POURQUOI DEUX FAMILLES DE TOTAUX ════════════════════════════════════════
 *
 *   `totals`     la TRÉSORERIE — entrées, sorties, net. Insensible à la
 *                taxonomie : quelle que soit la catégorie inventée demain, le
 *                net reste juste.
 *
 *   `byCategory` la NATURE — revenus, coûts, remboursements, corrections.
 *                C'est elle qui alimente « Revenus » et « Coûts » à l'écran.
 *
 * La séparation n'est pas décorative : le jour où un remboursement de 100 €
 * entrera au registre, `totals.net` baissera de 100 € (c'est vrai : l'argent
 * est sorti) sans que `byCategory.COST` ne bouge d'un centime (c'est vrai
 * aussi : aucune charge n'a été supportée). Un seul axe ne sait pas dire ces
 * deux vérités à la fois.
 */
import {
  CATEGORY_VALUES,
  FLOWS,
  STATUSES,
  PanelFinancialTransaction,
} from '../../models/PanelFinancialTransaction.model.js';
import { PROVIDER_FEE_EXTERNAL_KIND } from './providerRevenue/providerSettlement.service.js';
import { FINANCE_TIMEZONE } from './period.js';
import { buildQueryFilter, publicPeriod } from './financialTransactions.service.js';

/** Correspondance granularité → unité `$dateTrunc`. */
const UNITS = Object.freeze({ day: 'day', month: 'month', year: 'year' });

/** Un total vide, avec toutes ses clés. Jamais `undefined` vers un écran. */
function emptyCategories() {
  const total = {};
  for (const category of CATEGORY_VALUES) total[category] = 0;
  return total;
}

/**
 * SOMMES ET SÉRIE d'une demande, en une seule lecture.
 *
 * La demande a EXACTEMENT la forme de celle de la liste : c'est le même
 * `buildQueryFilter` qui la traduit. Le total affiché en haut d'un écran est
 * donc, par construction, celui des lignes affichées en dessous.
 *
 * ── LES SUPPRIMÉS NE COMPTENT PAS, LES `PENDING` NON PLUS ───────────────────
 * `deletedAt: null` vient du filtre commun. Le statut, lui, est imposé ICI :
 * seuls les mouvements `RECORDED` entrent dans un total. C'est ce qui fera
 * qu'un paiement Stripe annoncé mais non encaissé n'apparaîtra jamais dans un
 * bénéfice, sans qu'aucun écran n'ait à s'en souvenir.
 */
export async function summarize(demande = {}) {
  const { filtre, resolved } = await buildQueryFilter(demande);
  const filtreAgrege = { ...filtre, status: STATUSES.RECORDED };
  const unite = UNITS[resolved.granularity] ?? UNITS.month;

  const [resultat] = await PanelFinancialTransaction.aggregate([
    { $match: filtreAgrege },
    {
      $facet: {
        /* Trésorerie : deux lignes au plus, INFLOW et OUTFLOW. */
        flows: [
          { $group: { _id: '$flow', amountCents: { $sum: '$amountCents' }, count: { $sum: 1 } } },
        ],
        /* Nature : une ligne par catégorie rencontrée. */
        categories: [
          { $group: { _id: '$category', amountCents: { $sum: '$amountCents' }, count: { $sum: 1 } } },
        ],
        /*
          Série du graphique — regroupée dans le FUSEAU COMPTABLE.
          `$dateTrunc` sait où tombent les changements d'heure : sans son
          `timezone`, une transaction du 1er du mois à 00h30 à Paris serait
          rangée dans le mois précédent, et la première barre du graphique
          serait systématiquement amputée.
        */
        series: [
          {
            $group: {
              _id: {
                bucket: { $dateTrunc: { date: '$effectiveDate', unit: unite, timezone: FINANCE_TIMEZONE } },
                flow: '$flow',
              },
              amountCents: { $sum: '$amountCents' },
            },
          },
          { $sort: { '_id.bucket': 1 } },
        ],
        /*
          L13 — LA PART DES COÛTS QUI EST UNE COMMISSION DE PAIEMENT.

          ══ C'EST UNE VENTILATION, PAS UN TOTAL DE PLUS ══════════════════════

          Ces centimes sont DÉJÀ dans `byCategory.costCents` : ce sont des
          mouvements `COST` ordinaires, écrits par la projection fournisseur.
          On les compte une seconde fois ICI pour pouvoir répondre à « combien
          la facturation nous coûte-t-elle ? » — jamais pour les ajouter.

          Les additionner aux coûts serait le seul double comptage que ce lot
          puisse introduire, et c'est pour l'écarter que la formule est écrite
          une fois, ici, plutôt que recomposée dans chaque écran.

          ══ POURQUOI LA CLÉ EST LE TYPE D'OBJET EXTERNE ══════════════════════

          `provenance.externalKind = BALANCE_TRANSACTION` désigne exactement les
          lignes nées d'une écriture de solde fournisseur — ni les saisies
          manuelles, ni les coûts récurrents, ni les revenus. Filtrer sur
          `origin: STRIPE` seul aurait aussi ramassé les REVENUS, dont l'origine
          est la même : le fournisseur est une origine, pas une nature.

          Le filtre reste GÉNÉRIQUE : il ne nomme aucun fournisseur. Un second
          PSP écrirait ses commissions sous la même forme et entrerait dans ce
          total sans qu'une ligne change.
        */
        providerFees: [
          {
            $match: {
              category: 'COST',
              'provenance.externalKind': PROVIDER_FEE_EXTERNAL_KIND,
            },
          },
          { $group: { _id: '$provenance.provider', amountCents: { $sum: '$amountCents' }, count: { $sum: 1 } } },
        ],
        count: [{ $count: 'value' }],
      },
    },
  ]);

  const flows = indexBy(resultat?.flows);
  const categories = indexBy(resultat?.categories);

  const inflow = flows[FLOWS.INFLOW]?.amountCents ?? 0;
  const outflow = flows[FLOWS.OUTFLOW]?.amountCents ?? 0;

  const byCategory = emptyCategories();
  for (const [category, ligne] of Object.entries(categories)) {
    byCategory[category] = ligne.amountCents;
  }

  /**
   * LA VENTILATION DES COÛTS — lue sur la même passe que tout le reste.
   *
   * `_id` porte le fournisseur (`STRIPE`). Il est conservé pour que l'écran
   * puisse dire lequel coûte quoi le jour où il y en aura deux — et il n'y a
   * rien à changer pour cela.
   */
  const parFournisseur = {};
  let fraisFournisseur = 0;
  for (const ligne of resultat?.providerFees ?? []) {
    const fournisseur = ligne._id ?? 'INCONNU';
    parFournisseur[fournisseur] = (parFournisseur[fournisseur] ?? 0) + ligne.amountCents;
    fraisFournisseur += ligne.amountCents;
  }

  return {
    period: publicPeriod(resolved),
    currency: 'EUR',
    totals: {
      inflowCents: inflow,
      outflowCents: outflow,
      // La seule définition du bénéfice net du Panel. Elle tient sur une ligne
      // et n'est écrite nulle part ailleurs.
      netCents: inflow - outflow,
    },
    byCategory: {
      revenueCents: byCategory.REVENUE,
      costCents: byCategory.COST,
      refundCents: byCategory.REFUND,
      adjustmentCents: byCategory.ADJUSTMENT,
    },
    /**
     * L13 — DE QUOI LES COÛTS SONT FAITS. Un SOUS-ENSEMBLE, jamais un ajout.
     *
     *     totalCents = providerFeeCents + otherCents
     *     totalCents = byCategory.costCents            (la même chose, dite deux fois)
     *
     * L'égalité est écrite ici, une fois, pour qu'aucun écran n'ait à la
     * recomposer — et donc pour qu'aucun écran ne puisse se tromper en
     * additionnant la commission aux charges dont elle fait déjà partie.
     */
    costs: {
      totalCents: byCategory.COST,
      providerFeeCents: fraisFournisseur,
      otherCents: byCategory.COST - fraisFournisseur,
      /** Le détail par fournisseur — vide tant qu'aucune commission n'existe. */
      byProvider: parFournisseur,
    },
    count: resultat?.count?.[0]?.value ?? 0,
    series: buildSeries(resultat?.series ?? []),
  };
}

function indexBy(lignes = []) {
  const index = {};
  for (const ligne of lignes) index[ligne._id] = ligne;
  return index;
}

/**
 * Recompose la série en points ordonnés `{ bucket, inflow, outflow, net }`.
 *
 * Mongo rend une ligne par (période, sens) ; l'écran veut un point par période.
 * Le pliage se fait ici plutôt que dans le composant : un graphique qui doit
 * d'abord réorganiser ses données finit toujours par en réorganiser une partie
 * différemment de la légende.
 *
 * ── LES PÉRIODES SANS MOUVEMENT N'APPARAISSENT PAS ──────────────────────────
 * On ne fabrique pas de points à zéro pour combler les trous. Le graphique de
 * L10.1 relie des faits ; inventer trente points nuls pour un mois vide
 * donnerait à lire « le bénéfice est resté à zéro », alors que la vérité est
 * « il ne s'est rien passé ». La différence compte quand on cherche un oubli
 * de saisie.
 */
function buildSeries(lignes) {
  const points = new Map();
  for (const ligne of lignes) {
    const clef = new Date(ligne._id.bucket).toISOString();
    const point = points.get(clef) ?? { bucket: clef, inflowCents: 0, outflowCents: 0, netCents: 0 };
    if (ligne._id.flow === FLOWS.INFLOW) point.inflowCents += ligne.amountCents;
    else point.outflowCents += ligne.amountCents;
    point.netCents = point.inflowCents - point.outflowCents;
    points.set(clef, point);
  }
  return [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * RÉPARTITION PAR PROJET — la page globale, et elle seule.
 *
 * Elle répond à « quel client rapporte, lequel coûte ? ». Elle est calculée en
 * base pour la même raison que le reste, et bornée : au-delà d'une poignée de
 * projets, un écran ne se lit plus, et la page globale porte déjà la liste
 * complète des mouvements.
 *
 * `projectId: null` y figure comme n'importe quel autre rattachement : les
 * mouvements propres à L.Y Solution ne sont pas une exception du modèle, ils
 * en sont un cas.
 */
export async function summarizeByProject(demande = {}, { limit = 50 } = {}) {
  const { filtre } = await buildQueryFilter(demande);
  const lignes = await PanelFinancialTransaction.aggregate([
    { $match: { ...filtre, status: STATUSES.RECORDED } },
    {
      $group: {
        _id: '$projectId',
        projectNameSnapshot: { $last: '$projectNameSnapshot' },
        inflowCents: {
          $sum: { $cond: [{ $eq: ['$flow', FLOWS.INFLOW] }, '$amountCents', 0] },
        },
        outflowCents: {
          $sum: { $cond: [{ $eq: ['$flow', FLOWS.OUTFLOW] }, '$amountCents', 0] },
        },
        revenueCents: {
          $sum: { $cond: [{ $eq: ['$category', 'REVENUE'] }, '$amountCents', 0] },
        },
        costCents: {
          $sum: { $cond: [{ $eq: ['$category', 'COST'] }, '$amountCents', 0] },
        },
        /**
         * L13 — la part de ces coûts qui est une commission de paiement.
         *
         * SOUS-ENSEMBLE de `costCents`, jamais un total de plus : la question
         * à laquelle il répond est « combien encaisser ce client nous
         * coûte-t-il ? », pas « quels sont ses coûts ». Les additionner
         * doublerait la commission — c'est le seul double comptage que ce lot
         * puisse introduire, et il est écarté ici comme dans `summarize`.
         */
        providerFeeCents: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$category', 'COST'] },
                  { $eq: ['$provenance.externalKind', PROVIDER_FEE_EXTERNAL_KIND] },
                ],
              },
              '$amountCents',
              0,
            ],
          },
        },
        count: { $sum: 1 },
      },
    },
    { $addFields: { netCents: { $subtract: ['$inflowCents', '$outflowCents'] } } },
    { $sort: { netCents: -1 } },
    { $limit: Math.min(Math.max(1, limit), 200) },
  ]);

  return lignes.map(({ _id, ...reste }) => ({ projectId: _id ?? null, ...reste }));
}

export default { summarize, summarizeByProject };
