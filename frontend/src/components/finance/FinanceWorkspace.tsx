/**
 * LE MOTEUR FINANCIER — UN SEUL, pour la fiche projet ET pour la page globale.
 *
 * ══ POURQUOI CE COMPOSANT EXISTE ════════════════════════════════════════════
 *
 * Le cahier des charges décrit deux écrans : un onglet « Finances » sur chaque
 * projet, et une page « Finances » qui agrège tout. Les écrire deux fois aurait
 * produit deux calculs de bénéfice, deux façons de borner une période et deux
 * listes de filtres — puis, inévitablement, deux totaux différents pour la même
 * réalité, sans que personne ne sache lequel croire.
 *
 * Il n'y a donc qu'un moteur. La fiche projet le monte avec une PORTÉE
 * verrouillée ; la page globale le monte avec un sélecteur de portée. Tout le
 * reste — sous-onglets, cartes, graphique, liste, formulaire, détail,
 * suppression — est rigoureusement identique, parce que c'est le même code.
 *
 * ══ LES TROIS SOUS-ONGLETS ══════════════════════════════════════════════════
 *
 *   Général   toutes les lignes, les agrégats, le graphique.
 *   Coûts     les lignes de catégorie COST.
 *   Revenus   les lignes de catégorie REVENUE.
 *
 * Les cartes du haut, elles, ne suivent PAS le sous-onglet : elles décrivent la
 * période. Voir `useFinanceWorkspace` — afficher « Revenus : 0 € » au-dessus
 * d'une liste de coûts serait faux.
 *
 * Aucun sous-onglet n'invente de remboursement Stripe, de facture ni de coût
 * récurrent : ces vues fonctionnent avec les mouvements de L10.1, et rien
 * d'autre.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, EmptyState } from '@/components/ui';
import { SearchField } from '@/components/SearchField';
import { ThemedFilter } from '@/components/ThemedSelect';
import { useIsDev } from '@/auth/RequireDev';
import { errorMessage, finances } from '@/lib/api';
import { useFinanceWorkspace } from '@/lib/useFinances';
import { formatCents, formatFlowCents, formatNetCents, netTone } from '@/lib/money';
import { NetChart } from '@/components/finance/NetChart';
import { TransactionDetail } from '@/components/finance/TransactionDetail';
import { TransactionForm } from '@/components/finance/TransactionForm';
import type { ProjectChoice } from '@/components/finance/TransactionForm';
import { FinanceModal } from '@/components/finance/FinanceModal';
import {
  LY_SOLUTION, PERIOD_LABELS, PERIOD_ORDER, SORT_LABELS, SORT_ORDER, ownershipLabel,
} from '@/components/finance/financeLabels';
import type {
  FinanceCriteria, FinancePeriodKey, FinanceScope, FinanceSort, FinancialTransaction,
  ManualTransactionInput,
} from '@/types.finance';

type SousOnglet = 'general' | 'costs' | 'revenues';

const SOUS_ONGLETS: { key: SousOnglet; label: string }[] = [
  { key: 'general', label: 'Général' },
  { key: 'costs', label: 'Coûts' },
  { key: 'revenues', label: 'Revenus' },
];

/** Le mot à retaper pour une suppression en masse — le backend l'exige aussi. */
const CONFIRMATION_MASSE = 'SUPPRIMER';

const DATE_SEULE = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Paris',
});

export function FinanceWorkspace({
  /**
   * `project` verrouille le périmètre sur un client ; `all` ouvre le sélecteur
   * de portée. Il n'y a pas de troisième montage possible : la vue
   * « L.Y Solution seule » est une valeur du sélecteur, pas un écran à part.
   */
  scope,
  projectId = null,
  projectName = null,
  projects = [],
  onMutate,
}: {
  scope: 'project' | 'all';
  projectId?: string | null;
  projectName?: string | null;
  /** Le parc, pour le sélecteur de rattachement. Vide sur une fiche projet. */
  projects?: ProjectChoice[];
  /**
   * SIGNALÉ APRÈS CHAQUE ÉCRITURE RÉUSSIE.
   *
   * Le moteur recharge ce qu'il affiche, mais il ne connaît pas ce qui l'entoure
   * — la répartition par projet de la page globale, par exemple, vit à côté de
   * lui. Sans ce signal, ajouter une transaction laissait un classement périmé
   * juste en dessous d'un total qui, lui, venait de bouger.
   */
  onMutate?: () => void;
}) {
  const isDev = useIsDev();
  const verrouille = scope === 'project';

  const [sousOnglet, setSousOnglet] = useState<SousOnglet>('general');
  const [period, setPeriod] = useState<FinancePeriodKey>('CURRENT_MONTH');
  const [debut, setDebut] = useState('');
  const [fin, setFin] = useState('');
  const [recherche, setRecherche] = useState('');
  const [tri, setTri] = useState<FinanceSort>('DATE_DESC');
  /** Sur la page globale : « tout », un projet, ou L.Y Solution. */
  const [rattachement, setRattachement] = useState<string>('__ALL__');

  const [formulaire, setFormulaire] = useState<{ open: boolean; cible: FinancialTransaction | null }>(
    { open: false, cible: null },
  );
  const [detail, setDetail] = useState<FinancialTransaction | null>(null);
  const [aSupprimer, setASupprimer] = useState<FinancialTransaction | null>(null);
  const [masse, setMasse] = useState(false);
  const [erreurAction, setErreurAction] = useState<string | null>(null);

  /** La portée EFFECTIVE, résolue une fois — jamais recalculée par appel. */
  const portee: { scope: FinanceScope; projectId: string | null } = useMemo(() => {
    if (verrouille) return { scope: 'project', projectId };
    if (rattachement === '__ALL__') return { scope: 'all', projectId: null };
    if (rattachement === '__COMPANY__') return { scope: 'company', projectId: null };
    return { scope: 'project', projectId: rattachement };
  }, [verrouille, projectId, rattachement]);

  // Une période personnalisée incomplète retomberait en erreur serveur : tant
  // que les deux bornes ne sont pas saisies, on reste sur le mois en cours.
  const periodeUtilisable: FinancePeriodKey =
    period === 'CUSTOM' && (!debut || !fin) ? 'CURRENT_MONTH' : period;

  const criteresResume: FinanceCriteria = useMemo(() => ({
    scope: portee.scope,
    projectId: portee.projectId,
    period: periodeUtilisable,
    start: periodeUtilisable === 'CUSTOM' ? debut : undefined,
    end: periodeUtilisable === 'CUSTOM' ? fin : undefined,
    search: recherche.trim() || null,
  }), [portee, periodeUtilisable, debut, fin, recherche]);

  const criteresListe: FinanceCriteria = useMemo(() => ({
    ...criteresResume,
    category: sousOnglet === 'costs' ? 'COST' : sousOnglet === 'revenues' ? 'REVENUE' : null,
    sort: tri,
  }), [criteresResume, sousOnglet, tri]);

  const { summary, list, isInitialLoading, isRefreshing, error, reload } =
    useFinanceWorkspace(criteresResume, criteresListe);

  /** Les noms VIVANTS du parc — l'instantané ne sert qu'aux fiches disparues. */
  const nomsVivants = useMemo(
    () => new Map(projects.map((p) => [p.projectId, p.projectName])),
    [projects],
  );

  const agir = async (action: () => Promise<unknown>, echec: string) => {
    setErreurAction(null);
    try {
      await action();
      await reload();
      onMutate?.();
    } catch (err) {
      setErreurAction(errorMessage(err, echec));
    }
  };

  /**
   * L'erreur N'EST PAS attrapée ici : elle remonte au formulaire, qui l'affiche
   * à côté du champ fautif et garde la saisie. L'avaler ici fermerait la modale
   * sur un échec, et l'utilisateur retaperait tout.
   */
  const enregistrer = async (input: ManualTransactionInput) => {
    if (formulaire.cible) {
      await finances.update(formulaire.cible.transactionId, input);
    } else {
      await finances.create(input);
    }
    await reload();
    onMutate?.();
  };

  /* ── États de premier niveau ─────────────────────────────────────────── */
  if (isInitialLoading) {
    return <Card><p className="muted">Chargement des finances…</p></Card>;
  }
  if (error && !summary) {
    return <div className="alert alert-error">{error}</div>;
  }
  if (!summary || !list) {
    return <div className="alert alert-error">Les finances n’ont pas pu être chargées.</div>;
  }

  const net = summary.totals.netCents;

  return (
    <div className="finance-workspace">
      {/*
        UNE RELECTURE RATÉE NE VIDE PAS L'ÉCRAN — mais elle ne se tait pas.
        Les chiffres affichés datent alors de la lecture précédente, et le dire
        est le minimum : un total périmé présenté comme frais est pire qu'une
        page d'erreur.
      */}
      {error ? (
        <div className="alert alert-warning">
          {error} Les montants ci-dessous datent de la dernière lecture réussie.
        </div>
      ) : null}

      {/* ── SOUS-ONGLETS ──────────────────────────────────────────────── */}
      <div className="tabs tabs-sub">
        {SOUS_ONGLETS.map((onglet) => (
          <button
            key={onglet.key}
            type="button"
            className={sousOnglet === onglet.key ? 'tab tab-active' : 'tab'}
            onClick={() => setSousOnglet(onglet.key)}
          >
            {onglet.label}
          </button>
        ))}
        {isRefreshing ? <span className="live-hint">Mise à jour…</span> : null}
      </div>

      {/* ── AGRÉGATS DE LA PÉRIODE ────────────────────────────────────── */}
      <div className="metric-row finance-metrics">
        <div className="metric">
          <p className="metric-value finance-amount-inflow">
            {formatCents(summary.byCategory.revenueCents)}
          </p>
          <p className="metric-label">Revenus de la période</p>
        </div>
        <div className="metric">
          <p className="metric-value finance-amount-outflow">
            {formatCents(summary.byCategory.costCents)}
          </p>
          <p className="metric-label">Coûts de la période</p>
        </div>
        <div className={`metric metric-${netTone(net)}`}>
          <p className={`metric-value finance-net-${netTone(net)}`}>{formatNetCents(net)}</p>
          <p className="metric-label">Bénéfice net</p>
          <p className="metric-hint">Entrées moins sorties — jamais un champ saisi.</p>
        </div>
        {/*
          Les remboursements n'apparaissent QUE s'il y en a. Une carte à zéro
          annoncerait une fonctionnalité que ce lot n'a pas livrée.
        */}
        {summary.byCategory.refundCents > 0 ? (
          <div className="metric">
            <p className="metric-value">{formatCents(summary.byCategory.refundCents)}</p>
            <p className="metric-label">Remboursements</p>
            <p className="metric-hint">Comptés hors coûts d’exploitation.</p>
          </div>
        ) : null}
      </div>

      {/* ── GRAPHIQUE — sur « Général » seulement ─────────────────────── */}
      {sousOnglet === 'general' ? (
        <Card title="Bénéfice net sur la période">
          <NetChart series={summary.series} period={summary.period} />
        </Card>
      ) : null}

      {/* ── FILTRES ET ACTIONS ────────────────────────────────────────── */}
      <Card>
        <div className="filter-row finance-filters">
          <ThemedFilter
            label="Période"
            value={period}
            options={PERIOD_ORDER.map((clef) => ({ value: clef, label: PERIOD_LABELS[clef] }))}
            onChange={(valeur) => setPeriod(valeur as FinancePeriodKey)}
          />

          {period === 'CUSTOM' ? (
            <>
              <label className="filter">
                <span className="filter-label">Du</span>
                <input
                  className="search-input"
                  type="date"
                  value={debut}
                  onChange={(e) => setDebut(e.target.value)}
                />
              </label>
              <label className="filter">
                <span className="filter-label">Au (inclus)</span>
                <input
                  className="search-input"
                  type="date"
                  value={fin}
                  onChange={(e) => setFin(e.target.value)}
                />
              </label>
            </>
          ) : null}

          {!verrouille ? (
            <ThemedFilter
              label="Rattachement"
              value={rattachement}
              options={[
                { value: '__ALL__', label: 'Tous les mouvements' },
                { value: '__COMPANY__', label: `${LY_SOLUTION} seule` },
                ...projects.map((p) => ({ value: p.projectId, label: p.projectName })),
              ]}
              onChange={setRattachement}
            />
          ) : null}

          <ThemedFilter
            label="Tri"
            value={tri}
            options={SORT_ORDER.map((clef) => ({ value: clef, label: SORT_LABELS[clef] }))}
            onChange={(valeur) => setTri(valeur as FinanceSort)}
          />

          <div className="filter finance-filter-search">
            <span className="filter-label">Recherche</span>
            <SearchField
              label="Rechercher un mouvement"
              value={recherche}
              placeholder="Nom, description, projet…"
              onChange={setRecherche}
            />
          </div>
        </div>

        {period === 'CUSTOM' && (!debut || !fin) ? (
          <p className="field-hint muted">
            Renseignez les deux bornes : en attendant, le mois en cours reste affiché.
          </p>
        ) : null}

        <div className="action-buttons">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setFormulaire({ open: true, cible: null })}
          >
            Ajouter une transaction
          </button>
          {isDev ? (
            <button type="button" className="btn btn-danger" onClick={() => setMasse(true)}>
              Tout supprimer
            </button>
          ) : null}
        </div>
      </Card>

      {erreurAction ? <div className="alert alert-error">{erreurAction}</div> : null}

      {/* ── LISTE ─────────────────────────────────────────────────────── */}
      <Card title={`Mouvements (${list.total})`}>
        {list.items.length === 0 ? (
          <EmptyState
            title="Aucun mouvement ne correspond."
            hint={
              recherche.trim()
                ? 'Élargissez la recherche, ou changez de période.'
                : 'Ajoutez une transaction pour commencer à suivre ce périmètre.'
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table finance-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Mouvement</th>
                  {!verrouille ? <th scope="col">Rattachement</th> : null}
                  <th scope="col" className="finance-cell-amount">Montant</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((ligne) => (
                  <tr key={ligne.transactionId}>
                    <td>{DATE_SEULE.format(new Date(ligne.effectiveDate))}</td>
                    <td>
                      <span className="cell-primary">{ligne.label}</span>
                      {ligne.description ? (
                        <span className="cell-secondary">{ligne.description}</span>
                      ) : null}
                    </td>
                    {!verrouille ? (
                      <td>{ownershipLabel(ligne.projectId, ligne.projectNameSnapshot, nomsVivants)}</td>
                    ) : null}
                    <td className={`finance-cell-amount finance-amount-${ligne.flow.toLowerCase()}`}>
                      {formatFlowCents(ligne.amountCents, ligne.flow)}
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setDetail(ligne)}
                      >
                        Voir les détails
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {list.truncated ? (
          <p className="field-hint muted">
            {list.items.length} mouvements affichés sur {list.total}. Affinez la période
            ou la recherche pour voir le reste — les totaux ci-dessus, eux, portent
            sur l’ensemble.
          </p>
        ) : null}
      </Card>

      {/* ── DIALOGUES ─────────────────────────────────────────────────── */}
      {formulaire.open ? (
        <TransactionForm
          transaction={formulaire.cible}
          lockedProjectId={verrouille ? projectId : null}
          lockedProjectName={verrouille ? projectName : null}
          projects={projects}
          onSubmit={enregistrer}
          onClose={() => setFormulaire({ open: false, cible: null })}
        />
      ) : null}

      {detail ? (
        <TransactionDetail
          transaction={detail}
          projectNames={nomsVivants}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setFormulaire({ open: true, cible: detail });
            setDetail(null);
          }}
          onDelete={() => {
            setASupprimer(detail);
            setDetail(null);
          }}
        />
      ) : null}

      {aSupprimer ? (
        <SuppressionUnitaire
          transaction={aSupprimer}
          onClose={() => setASupprimer(null)}
          onConfirm={async (motif) => {
            await agir(
              () => finances.remove(aSupprimer.transactionId, motif),
              'La suppression n’a pas abouti.',
            );
            setASupprimer(null);
          }}
        />
      ) : null}

      {masse ? (
        <SuppressionEnMasse
          scope={portee.scope}
          projectId={portee.projectId}
          libelle={
            portee.scope === 'project'
              ? (projectName ?? nomsVivants.get(portee.projectId ?? '') ?? portee.projectId ?? '')
              : portee.scope === 'company' ? LY_SOLUTION : 'tout le registre'
          }
          onClose={() => setMasse(false)}
          onDone={async () => {
            setMasse(false);
            await reload();
            onMutate?.();
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * SUPPRESSION D'UNE LIGNE — avec son motif, qui n'est pas obligatoire.
 *
 * L'imposer produirait des « erreur » et des « x » : un motif contraint n'est
 * pas un motif. On l'offre, et il est conservé sur le document supprimé.
 */
function SuppressionUnitaire({
  transaction,
  onClose,
  onConfirm,
}: {
  transaction: FinancialTransaction;
  onClose: () => void;
  onConfirm: (motif: string) => Promise<void>;
}) {
  const [motif, setMotif] = useState('');
  const [occupe, setOccupe] = useState(false);

  return (
    <FinanceModal
      title="Supprimer ce mouvement ?"
      hint="Il quitte immédiatement les totaux. Le document, lui, reste consultable pour l’audit."
      danger
      onClose={onClose}
    >
      <p>
        <strong>{transaction.label}</strong>
        {' · '}
        {formatFlowCents(transaction.amountCents, transaction.flow)}
      </p>
      <label className="field">
        <span className="field-label">Motif (facultatif)</span>
        <input
          className="search-input"
          value={motif}
          placeholder="Doublon de saisie, erreur de montant…"
          onChange={(e) => setMotif(e.target.value)}
        />
      </label>
      <div className="action-buttons">
        <button
          type="button"
          className="btn btn-danger"
          disabled={occupe}
          onClick={() => {
            setOccupe(true);
            void onConfirm(motif).finally(() => setOccupe(false));
          }}
        >
          {occupe ? 'Suppression…' : 'Supprimer'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={occupe}>
          Annuler
        </button>
      </div>
    </FinanceModal>
  );
}

/**
 * « TOUT SUPPRIMER » — la portée est ANNONCÉE, le nombre est COMPTÉ, le mot est
 * RETAPÉ.
 *
 * ══ POURQUOI ON COMPTE AVANT D'OUVRIR ═══════════════════════════════════════
 *
 * « Voulez-vous tout supprimer ? » n'est pas une question à laquelle on peut
 * répondre : on ne sait pas ce que « tout » recouvre. L'écran interroge donc le
 * backend, et écrit le nombre exact. Trois lignes ou trois cents ne se
 * confirment pas de la même façon.
 *
 * ══ TOUTES PÉRIODES CONFONDUES, ET C'EST ÉCRIT ══════════════════════════════
 *
 * La suppression en masse ignore la période et la recherche affichées. Effacer
 * « ce qu'on voit » ferait dépendre le résultat du filtre en cours — deux
 * personnes appuieraient sur le même bouton et n'effaceraient pas la même
 * chose. Le compteur porte donc sur la PORTÉE entière, et la phrase le dit.
 */
function SuppressionEnMasse({
  scope,
  projectId,
  libelle,
  onClose,
  onDone,
}: {
  scope: FinanceScope;
  projectId: string | null;
  libelle: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [compte, setCompte] = useState<number | null>(null);
  const [phrase, setPhrase] = useState('');
  const [motif, setMotif] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  // Le décompte est un EFFET, pas un calcul : il interroge le serveur. Le
  // placer dans un `useMemo` le déclencherait pendant le rendu — React
  // n'ordonne rien à ce moment-là, et un double rendu compterait deux fois.
  useEffect(() => {
    let vivant = true;
    finances.bulkScope(scope, projectId)
      .then((res) => { if (vivant) setCompte(res.count); })
      .catch((err) => {
        if (vivant) setErreur(errorMessage(err, 'Le décompte n’a pas pu être établi.'));
      });
    return () => { vivant = false; };
  }, [scope, projectId]);

  const supprimer = async () => {
    setOccupe(true);
    setErreur(null);
    try {
      await finances.bulkDelete({ scope, projectId, confirm: phrase, reason: motif || undefined });
      await onDone();
    } catch (err) {
      setErreur(errorMessage(err, 'La suppression en masse n’a pas abouti.'));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <FinanceModal
      title="Tout supprimer"
      hint={`Portée : ${libelle}. Toutes périodes confondues, quel que soit le filtre affiché.`}
      danger
      onClose={onClose}
    >
      {compte === null && !erreur ? <p className="muted">Décompte en cours…</p> : null}
      {compte !== null ? (
        <p>
          <strong>{compte}</strong>
          {compte > 1 ? ' mouvements seront retirés des totaux.' : ' mouvement sera retiré des totaux.'}
          {' '}
          Les documents restent en base et demeurent auditables ; aucun écran ne sait les
          restaurer.
        </p>
      ) : null}

      <label className="field">
        <span className="field-label">Motif (facultatif)</span>
        <input
          className="search-input"
          value={motif}
          placeholder="Contrat annulé, reprise de saisie…"
          onChange={(e) => setMotif(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">
          Saisissez <code className="inline-code">{CONFIRMATION_MASSE}</code> pour confirmer
        </span>
        <input
          className="search-input"
          value={phrase}
          autoComplete="off"
          onChange={(e) => setPhrase(e.target.value)}
        />
      </label>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      <div className="action-buttons">
        <button
          type="button"
          className="btn btn-danger"
          disabled={occupe || phrase !== CONFIRMATION_MASSE || compte === 0}
          onClick={() => void supprimer()}
        >
          {occupe ? 'Suppression…' : 'Tout supprimer'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={occupe}>
          Annuler
        </button>
      </div>
    </FinanceModal>
  );
}

export default FinanceWorkspace;
