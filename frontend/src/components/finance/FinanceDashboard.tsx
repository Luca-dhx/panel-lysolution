/**
 * LE TABLEAU DE BORD FINANCIER — indicateurs et graphiques, sur les vrais chiffres.
 *
 * ══ CE QU'IL AJOUTE AU REGISTRE, ET CE QU'IL NE REFAIT PAS ══════════════════
 *
 * Le registre (`FinanceWorkspace`) sait déjà tout faire : filtrer, lister,
 * saisir, corriger, rembourser. Il reste l'autorité, et ce tableau de bord ne
 * duplique aucune de ses écritures.
 *
 * Ce qu'il apporte est une LECTURE : est-ce que ça monte, par rapport à quand,
 * et grâce à qui. Trois questions auxquelles une liste de mouvements ne répond
 * pas, quelle que soit sa qualité.
 *
 * ══ D'OÙ VIENT CHAQUE CHIFFRE ═══════════════════════════════════════════════
 *
 *   Encaissé, sorties, net    `/api/finances/summary` → `totals`
 *   Remboursements            `/api/finances/summary` → `byCategory.refundCents`
 *   Commission fournisseur    `/api/finances/summary` → `costs.providerFeeCents`
 *   Courbe d'évolution        `/api/finances/summary` → `series[]`
 *   Répartition               `/api/finances/by-project`
 *   Tendance                  le MÊME `/summary`, sur la fenêtre précédente
 *
 * Aucun total n'est reconstitué à partir de la liste : elle est bornée par
 * `limit`, et une somme de lignes paginées serait plausible et fausse.
 *
 * ══ LA TENDANCE COÛTE UNE REQUÊTE, ET ELLE EST FACULTATIVE ══════════════════
 *
 * La fenêtre précédente est calculée à partir des bornes que le serveur vient
 * de rendre (voir `financeAnalytics.previousWindow`), puis redemandée au
 * serveur en période `CUSTOM`. C'est LUI qui agrège, ici comme ailleurs.
 *
 * Si la période n'a pas de bornes — « depuis toujours » —, il n'y a pas d'avant
 * et aucune tendance ne s'affiche. Si la requête échoue, les indicateurs
 * restent justes et perdent seulement leur flèche : une comparaison manquante
 * ne doit pas effacer un chiffre exact.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Metric, MetricRow, Panel, EmptyPanel, ErrorState, SkeletonRows } from '@/components/ui-kit';
import { LY_SOLUTION } from '@/components/finance/financeLabels';
import { errorMessage, finances } from '@/lib/api';
import { formatCents, formatNetCents, netTone } from '@/lib/money';
import {
  COMPANY_KEY,
  computeTrend,
  previousWindow,
  refundRate,
  toBreakdownRows,
} from '@/lib/financeAnalytics';
import type { BreakdownRow, Trend } from '@/lib/financeAnalytics';
import type { FinanceCriteria, FinanceProjectLine, FinanceSummary } from '@/types.finance';

/**
 * LES GRAPHIQUES SONT CHARGÉS À LA DEMANDE.
 *
 * Ils tirent visx, d3 et motion — environ 200 ko avant compression. Les quinze
 * écrans du Panel qui n'affichent aucun graphique n'ont pas à les télécharger.
 * `lazy` + `Suspense` avec un squelette de la BONNE HAUTEUR : l'arrivée du
 * fragment ne déplace rien.
 */
import { ChartBoundary } from './charts/ChartBoundary';

const FinanceEvolutionChart = lazy(() => import('./charts/FinanceEvolutionChart'));
const FinanceBreakdownChart = lazy(() => import('./charts/FinanceBreakdownChart'));

const POURCENT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });

/* ══════════════════════════════════════════════════════════════════════════
   LA COMPARAISON AVEC LA PÉRIODE PRÉCÉDENTE
   ══════════════════════════════════════════════════════════════════════════ */

interface Comparaison {
  revenue: Trend;
  cost: Trend;
  net: Trend;
  refund: Trend;
}

function useComparaison(
  summary: FinanceSummary | null,
  portee: Pick<FinanceCriteria, 'scope' | 'projectId'>,
): Comparaison | null {
  const [comparaison, setComparaison] = useState<Comparaison | null>(null);

  // La clef de dépendance est le CONTENU de la fenêtre, pas l'objet résumé :
  // un rafraîchissement qui rend les mêmes bornes ne doit pas relancer la
  // requête de comparaison.
  const fenetre = summary ? previousWindow(summary.period) : null;
  const clef = fenetre
    ? `${portee.scope}|${portee.projectId ?? ''}|${fenetre.start}|${fenetre.end}`
    : null;

  const courant = summary?.byCategory ?? null;
  const netCourant = summary?.totals.netCents ?? null;

  useEffect(() => {
    if (!(fenetre && clef && courant && netCourant !== null)) {
      setComparaison(null);
      return undefined;
    }
    let vivant = true;
    finances
      .summary({
        scope: portee.scope,
        projectId: portee.projectId,
        period: 'CUSTOM',
        start: fenetre.start,
        end: fenetre.end,
      })
      .then((precedent) => {
        if (!vivant) return;
        /*
          ── ON COMPARE LES MÊMES GRANDEURS, CATÉGORIE PAR CATÉGORIE ────────

          Comparer `totals.inflowCents` à `byCategory.revenueCents` aurait
          produit une tendance juste en apparence et fausse en fait : les
          entrées comprennent les ajustements, les sorties comprennent les
          remboursements. Chaque indicateur compare SA propre grandeur.
        */
        setComparaison({
          revenue: computeTrend(courant.revenueCents, precedent.byCategory.revenueCents),
          cost: computeTrend(courant.costCents, precedent.byCategory.costCents),
          net: computeTrend(netCourant, precedent.totals.netCents),
          refund: computeTrend(courant.refundCents, precedent.byCategory.refundCents),
        });
      })
      .catch(() => {
        // Une comparaison indisponible n'est pas une panne de l'écran : les
        // chiffres affichés restent exacts, ils perdent seulement leur flèche.
        if (vivant) setComparaison(null);
      });
    return () => { vivant = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clef, courant?.revenueCents, courant?.costCents, courant?.refundCents, netCourant]);

  return comparaison;
}

/* ══════════════════════════════════════════════════════════════════════════
   LES INDICATEURS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * LES QUATRE MÊMES GRANDEURS QU'AVANT — avec une période et une tendance.
 *
 * ══ CE QUI N'A PAS CHANGÉ, ET NE DEVAIT PAS ════════════════════════════════
 *
 *   Revenus          `byCategory.revenueCents`  — le total de la CATÉGORIE
 *                    revenu, donc le brut. Ce n'est PAS `totals.inflowCents`,
 *                    qui comprend aussi les ajustements.
 *   Coûts            `byCategory.costCents`     — et non `totals.outflowCents`,
 *                    qui comprend les remboursements. La ventilation « dont
 *                    commissions » vient du serveur et n'est jamais recomposée.
 *   Bénéfice net     `totals.netCents`          — entrées moins sorties.
 *   Remboursements   `byCategory.refundCents`   — comptés hors coûts.
 *
 * Une refonte d'interface n'a pas le droit de déplacer un montant sous un autre
 * libellé. Une première version de cet écran affichait « Encaissé » à partir de
 * `totals.inflowCents` : le chiffre était juste, mais ce n'était plus le même,
 * et la ventilation des commissions avait disparu au passage.
 *
 * Ce que la refonte ajoute est la PÉRIODE et la TENDANCE. Les grandeurs, elles,
 * sont exactement celles d'avant.
 */
export function FinanceMetrics({
  summary,
  isLoading,
  portee,
  periodeLabel,
}: {
  summary: FinanceSummary | null;
  isLoading: boolean;
  portee: Pick<FinanceCriteria, 'scope' | 'projectId'>;
  periodeLabel: string;
}) {
  const comparaison = useComparaison(summary, portee);
  const statut = isLoading || !summary ? 'loading' : 'ready';

  const taux = summary
    ? refundRate(summary.byCategory.refundCents, summary.byCategory.revenueCents)
    : null;

  return (
    <MetricRow>
      <Metric
        label="Revenus de la période"
        status={statut}
        value={summary ? formatCents(summary.byCategory.revenueCents) : '—'}
        caption={periodeLabel}
        tone="inflow"
        trend={comparaison?.revenue}
        goodDirection="up"
      />

      <Metric
        label="Coûts de la période"
        status={statut}
        value={summary ? formatCents(summary.byCategory.costCents) : '—'}
        caption={periodeLabel}
        /*
          ── DONT LES COMMISSIONS DE PAIEMENT ──────────────────────────────

          « dont », et le mot compte : ces centimes sont DÉJÀ dans le total
          au-dessus. Un indicateur séparé les aurait fait lire comme un coût
          supplémentaire, et quelqu'un les aurait additionnés.

          La ventilation vient du SERVEUR, où l'égalité
          `total = commissions + autres` est calculée une fois. Cet écran ne la
          recompose pas, et ne peut donc pas s'en écarter. Elle n'apparaît que
          s'il y en a : une ligne « dont 0,00 € » annoncerait un poste de charge
          inexistant.
        */
        hint={summary?.costs && summary.costs.providerFeeCents > 0
          ? `dont ${formatCents(summary.costs.providerFeeCents)} de commissions de paiement`
          : undefined}
        tone="outflow"
        trend={comparaison?.cost}
        /* Une hausse des coûts n'est PAS une bonne nouvelle : le sens favorable
           est déclaré, il ne se déduit pas de la direction. */
        goodDirection="down"
      />

      <Metric
        label="Bénéfice net"
        status={statut}
        value={summary ? formatNetCents(summary.totals.netCents) : '—'}
        caption="Entrées moins sorties"
        hint="Calculé depuis les mouvements — jamais un champ saisi."
        tone={summary ? (netTone(summary.totals.netCents) === 'danger' ? 'danger' : 'ok') : 'default'}
        trend={comparaison?.net}
        /* La valeur porte déjà sa couleur : la recolorer ferait deux signaux
           pour une seule information. */
        goodDirection="none"
      />

      {/*
        LES REMBOURSEMENTS N'APPARAISSENT QUE S'IL Y EN A — c'était déjà la
        règle. Un indicateur à zéro annoncerait un mécanisme qui n'a pas servi.
        À défaut, on montre le nombre de mouvements, qui a toujours un sens.
      */}
      {summary && summary.byCategory.refundCents > 0 ? (
        <Metric
          label="Remboursements"
          status={statut}
          value={formatCents(summary.byCategory.refundCents)}
          caption={taux !== null ? `${POURCENT.format(taux)} des revenus` : periodeLabel}
          hint="Comptés hors coûts d’exploitation."
          tone="outflow"
          trend={comparaison?.refund}
          goodDirection="down"
        />
      ) : (
        <Metric
          label="Mouvements"
          status={statut}
          value={summary ? summary.count.toLocaleString('fr-FR') : '—'}
          caption={periodeLabel}
          hint="Toutes catégories confondues."
        />
      )}
    </MetricRow>
  );
}


/* ══════════════════════════════════════════════════════════════════════════
   L'ÉVOLUTION
   ══════════════════════════════════════════════════════════════════════════ */

export function FinanceEvolutionPanel({
  summary,
  isLoading,
  periodeLabel,
}: {
  summary: FinanceSummary | null;
  isLoading: boolean;
  periodeLabel: string;
}) {
  return (
    <Panel
      title="Évolution"
      description={`Encaissements, sorties et bénéfice net — ${periodeLabel.toLowerCase()}.`}
    >
      {isLoading || !summary ? (
        // Un rectangle de la hauteur EXACTE du graphique : quand il arrive, rien
        // ne se déplace sous le curseur.
        <div
          className="uui h-[220px] w-full animate-pulse rounded-lg bg-secondary sm:h-[260px] lg:h-[320px]"
          aria-busy="true"
          aria-label="Chargement du graphique"
        />
      ) : (
        /*
          LA FRONTIÈRE D'ERREUR ENVELOPPE L'ATTENTE, pas l'inverse : c'est le
          CHARGEMENT du fragment qui peut échouer, et `Suspense` laisserait
          l'exception remonter jusqu'à démonter l'écran financier entier.
        */
        <ChartBoundary series={summary.series} period={summary.period}>
          <Suspense
            fallback={
              <div
                className="uui h-[220px] w-full animate-pulse rounded-lg bg-secondary sm:h-[260px] lg:h-[320px]"
                aria-busy="true"
              />
            }
          >
            <FinanceEvolutionChart summary={summary} />
          </Suspense>
        </ChartBoundary>
      )}
    </Panel>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   LA RÉPARTITION
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * QUI RAPPORTE, QUI COÛTE — le graphique ET les chiffres.
 *
 * ── VOLONTAIREMENT SANS FILTRE DE PÉRIODE ───────────────────────────────────
 * C'est un classement de FOND, pas une vue de travail. Le registre au-dessus
 * porte déjà toutes les périodes, et dupliquer ses filtres ici aurait produit
 * deux réglages indépendants sur un même écran — donc, un jour, deux lectures
 * contradictoires côte à côte. Le sous-titre le dit explicitement.
 */
export function FinanceBreakdownPanel({
  revision,
  projectNames,
}: {
  /** Change à chaque écriture du registre — le seul déclencheur de relecture. */
  revision: number;
  projectNames: Map<string, string>;
}) {
  const [lignes, setLignes] = useState<FinanceProjectLine[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [rechargement, setRechargement] = useState(0);

  useEffect(() => {
    let vivant = true;
    finances.byProject({ period: 'ALL' })
      .then((res) => { if (vivant) { setLignes(res.items); setErreur(null); } })
      .catch((err) => {
        if (vivant) setErreur(errorMessage(err, 'La répartition n’a pas pu être chargée.'));
      });
    return () => { vivant = false; };
  }, [revision, rechargement]);

  const rows = useMemo<BreakdownRow[]>(
    () => (lignes
      ? toBreakdownRows(lignes, {
        top: 8,
        nameOf: (id) => projectNames.get(id) ?? null,
        companyLabel: LY_SOLUTION,
      })
      : []),
    [lignes, projectNames],
  );

  return (
    <Panel
      title="Répartition par rattachement"
      description="Depuis le début, toutes périodes confondues. Les mouvements supprimés n’y figurent pas."
      badge={
        lignes ? (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary">
            {lignes.length}
          </span>
        ) : null
      }
    >
      {erreur ? (
        <ErrorState message={erreur} onRetry={() => setRechargement((n) => n + 1)} />
      ) : lignes === null ? (
        <SkeletonRows rows={5} columns={4} />
      ) : rows.length === 0 ? (
        <EmptyPanel
          title="Aucun mouvement enregistré"
          hint="La répartition apparaîtra dès la première transaction."
        />
      ) : (
        /*
         * ── LE GRAPHIQUE AU-DESSUS, PLEINE LARGEUR, ET LE TABLEAU DESSOUS ───
         *
         * Ils étaient côte à côte. Dans une colonne de 380 px, les 132 px de
         * marge réservés aux noms ne suffisaient plus : « Boulangerie Martin »
         * devenait « Boulange… », et une barre dont on ne peut pas lire
         * l'étiquette ne compare plus rien.
         *
         * Empilés, le graphique dispose de toute la largeur de la carte. Le
         * tableau juste dessous porte les montants exacts, dans le MÊME ORDRE :
         * passer de l'un à l'autre ne demande aucune recherche.
         */
        <div className="uui flex flex-col gap-6">
          <Suspense
            fallback={<div className="h-40 w-full animate-pulse rounded-lg bg-secondary" />}
          >
            <FinanceBreakdownChart rows={rows} />
          </Suspense>

          {/*
            LA LECTURE NUMÉRIQUE, à côté du graphique et dans le MÊME ORDRE.
            Une barre donne l'ordre de grandeur ; elle ne donne pas le centime.
            Passer de l'une à l'autre ne doit demander aucune recherche.
          */}
          {/*
            ── LE TABLEAU REPREND LE GABARIT EMPILABLE DES FINANCES ──────────

            Une première version rendait un tableau ordinaire dans un conteneur
            à défilement horizontal. Sur un téléphone, cinq colonnes de montants
            ne rentrent pas, et le lecteur devait balayer latéralement pour
            lire un net — en perdant en chemin le nom du rattachement.

            `finance-table-stackable` est le gabarit déjà éprouvé du registre :
            sous 46 rem de CONTENEUR — pas d'écran —, chaque ligne devient une
            fiche et chaque cellule porte le NOM de sa colonne (`data-label`).
            Rien à réinventer, et le comportement est identique à celui de la
            liste des mouvements juste au-dessus.
          */}
          <div className="table-scroll">
            <table className="data-table finance-table finance-table-stackable">
              <thead>
                <tr>
                  <th scope="col">Rattachement</th>
                  <th scope="col" className="finance-cell-amount">Revenus</th>
                  <th scope="col" className="finance-cell-amount">Coûts</th>
                  <th scope="col" className="finance-cell-amount">Net</th>
                  <th scope="col" className="finance-cell-amount">Mouvements</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ligne) => (
                  <tr key={ligne.key}>
                    <td data-label="Rattachement">
                      {ligne.key !== COMPANY_KEY && !ligne.isAggregate ? (
                        // Depuis le classement, on va lire le détail là où il
                        // vit : sur la fiche du client, onglet Finances.
                        <Link
                          className="project-link"
                          to={`/projects/${ligne.key}?tab=finances`}
                          title={ligne.name}
                        >
                          {ligne.name}
                        </Link>
                      ) : (
                        <span className="cell-primary">{ligne.name}</span>
                      )}
                      {ligne.share !== null ? (
                        <span className="cell-secondary">
                          {POURCENT.format(ligne.share)} des revenus
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Revenus" className="finance-cell-amount finance-amount-inflow">
                      {formatCents(ligne.revenueCents)}
                    </td>
                    <td data-label="Coûts" className="finance-cell-amount finance-amount-outflow">
                      {formatCents(ligne.costCents)}
                    </td>
                    <td
                      data-label="Net"
                      className={`finance-cell-amount finance-net-${netTone(ligne.netCents)}`}
                    >
                      {formatNetCents(ligne.netCents)}
                    </td>
                    <td data-label="Mouvements" className="finance-cell-amount">
                      {ligne.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
