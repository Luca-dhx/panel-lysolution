/**
 * CRÉER OU MODIFIER UNE RÈGLE DE COÛT RÉCURRENT.
 *
 * ══ AUCUN JUSTIFICATIF DANS CE FORMULAIRE — ET C'EST STRUCTUREL ═════════════
 *
 * Un justificatif documente un PAIEMENT. La facture d'août et celle de
 * septembre sont deux documents distincts ; une règle n'en a aucun. Un champ
 * « justificatif » ici aurait forcément fini par désigner l'un des deux mois,
 * en laissant croire qu'il valait pour tous. Les pièces se déposent depuis le
 * livret de coûts, ligne par ligne.
 *
 * ══ MODIFIER OUVRE UNE QUESTION, JAMAIS UN DÉFAUT ═══════════════════════════
 *
 * Le bouton « Enregistrer » n'apparaît qu'une fois quelque chose changé, et il
 * n'enregistre pas : il ouvre la question « à partir de quand ? ». Il n'y a pas
 * de réponse évidente — appliquer d'office au prochain cycle, ou au cycle
 * courant, réécrirait l'historique de quelqu'un sans le lui demander.
 */
import { useMemo, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { FinanceModal } from '@/components/finance/FinanceModal';
import { LY_SOLUTION, todayInputValue } from '@/components/finance/financeLabels';
import type { ProjectChoice } from '@/components/finance/TransactionForm';
import type {
  RecurrenceUnit, RecurringCost, RecurringCostInput, RecurringCostPatch, RecurringEditMode,
} from '@/types.finance';

const UNITES: { value: RecurrenceUnit; label: string; pluriel: string }[] = [
  { value: 'DAY', label: 'jour', pluriel: 'jours' },
  { value: 'MONTH', label: 'mois', pluriel: 'mois' },
  { value: 'YEAR', label: 'an', pluriel: 'ans' },
];

/**
 * LES TROIS MODES, ÉNONCÉS COMME L'UTILISATEUR LES VIT.
 *
 * Chaque description dit ce qui BOUGE et ce qui ne bouge pas. « Récurrence
 * précédente » est le libellé du cahier des charges ; ce qu'il désigne est le
 * cycle COURANT — celui de la dernière ligne apparue dans le livret — et il
 * fallait l'écrire, parce que le mot « précédente » invite à comprendre
 * l'inverse.
 */
const MODES: { value: RecurringEditMode; label: string; detail: string }[] = [
  {
    value: 'NEXT',
    label: 'Prochaine récurrence',
    detail: 'Les lignes déjà enregistrées ne bougent pas. Le nouveau montant s’applique à partir de la prochaine échéance.',
  },
  {
    value: 'CURRENT',
    label: 'Récurrence précédente',
    detail: 'La dernière ligne enregistrée est corrigée, ainsi que toutes les suivantes. Les cycles antérieurs restent inchangés.',
  },
  {
    value: 'FROM_START',
    label: 'Depuis le début',
    detail: 'Toutes les lignes de cette récurrence sont corrigées, depuis la première. Les justificatifs déjà attachés sont conservés.',
  },
];

export function RecurringCostForm({
  recurringCost = null,
  lockedProjectId = null,
  lockedProjectName = null,
  projects,
  onCreate,
  onRevise,
  onClose,
}: {
  /** La règle à modifier, ou `null` pour une création. */
  recurringCost?: RecurringCost | null;
  lockedProjectId?: string | null;
  lockedProjectName?: string | null;
  projects: ProjectChoice[];
  onCreate: (input: RecurringCostInput) => Promise<void>;
  onRevise: (patch: RecurringCostPatch) => Promise<void>;
  onClose: () => void;
}) {
  const modification = recurringCost !== null;

  const [projectId, setProjectId] = useState<string>(
    lockedProjectId ?? recurringCost?.projectId ?? '',
  );
  const [label, setLabel] = useState(recurringCost?.label ?? '');
  const [description, setDescription] = useState(recurringCost?.description ?? '');
  const [amount, setAmount] = useState(
    recurringCost ? (recurringCost.amountCents / 100).toFixed(2).replace('.', ',') : '',
  );
  const [interval, setInterval] = useState(String(recurringCost?.recurrence.interval ?? 1));
  const [unit, setUnit] = useState<RecurrenceUnit>(recurringCost?.recurrence.unit ?? 'MONTH');
  const [startAt, setStartAt] = useState(
    recurringCost?.startAt?.slice(0, 10) ?? todayInputValue(),
  );

  const [mode, setMode] = useState<RecurringEditMode | null>(null);
  const [reason, setReason] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  /**
   * « ENREGISTRER » N'APPARAÎT QUE SI QUELQUE CHOSE A CHANGÉ.
   *
   * C'est la demande du cahier des charges, et elle a une vertu : proposer
   * d'enregistrer un formulaire intact invite à ouvrir la modale des modes pour
   * rien, donc à choisir un mode au hasard.
   */
  const modifie = useMemo(() => {
    if (!recurringCost) return true;
    const montantInitial = (recurringCost.amountCents / 100).toFixed(2).replace('.', ',');
    return label !== recurringCost.label
      || description !== recurringCost.description
      || amount !== montantInitial;
  }, [recurringCost, label, description, amount]);

  const uniteChoisie = UNITES.find((u) => u.value === unit) ?? UNITES[1];
  const pluriel = Number(interval) > 1;

  const creer = async (e: React.FormEvent) => {
    e.preventDefault();
    setOccupe(true);
    setErreur(null);
    try {
      await onCreate({
        scope: projectId ? 'PROJECT' : 'COMPANY',
        projectId: projectId || null,
        label,
        description,
        amount,
        recurrence: { unit, interval: Number(interval) || 1 },
        startAt,
      });
      onClose();
    } catch (err) {
      setErreur(errorMessage(err, 'La récurrence n’a pas pu être créée.'));
    } finally {
      setOccupe(false);
    }
  };

  const appliquer = async () => {
    if (!mode) return;
    setOccupe(true);
    setErreur(null);
    try {
      await onRevise({ mode, label, description, amount, reason: reason || undefined });
      onClose();
    } catch (err) {
      setErreur(errorMessage(err, 'La modification n’a pas pu être appliquée.'));
      setMode(null);
    } finally {
      setOccupe(false);
    }
  };

  /* ── La question « à partir de quand ? » ────────────────────────────── */
  if (modification && mode !== null) {
    const choisi = MODES.find((m) => m.value === mode);
    return (
      <FinanceModal
        title="À partir de quand appliquer les modifications ?"
        hint="Les lignes déjà enregistrées ne changent que si vous le demandez ici."
        onClose={() => setMode(null)}
      >
        <div className="finance-mode-list" role="radiogroup" aria-label="Portée temporelle">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              className={mode === m.value ? 'finance-mode finance-mode-on' : 'finance-mode'}
              onClick={() => setMode(m.value)}
            >
              <span className="finance-mode-label">{m.label}</span>
              <span className="finance-mode-detail">{m.detail}</span>
            </button>
          ))}
        </div>

        <label className="field">
          <span className="field-label">Motif (facultatif)</span>
          <input
            className="search-input"
            value={reason}
            placeholder="Tarif renégocié, correction de saisie…"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        {erreur ? <div className="alert alert-error">{erreur}</div> : null}

        <div className="action-buttons">
          <button type="button" className="btn btn-primary" disabled={occupe} onClick={() => void appliquer()}>
            {occupe ? 'Application…' : `Appliquer — ${choisi?.label}`}
          </button>
          <button type="button" className="btn btn-secondary" disabled={occupe} onClick={() => setMode(null)}>
            Revenir au formulaire
          </button>
        </div>
      </FinanceModal>
    );
  }

  /* ── Le formulaire ──────────────────────────────────────────────────── */
  return (
    <FinanceModal
      title={modification ? 'Modifier la récurrence' : 'Nouveau coût récurrent'}
      hint={modification
        ? 'La fréquence et la date de démarrage ne se modifient pas : elles ancrent toute la suite des échéances.'
        : 'Une règle produira une ligne de coût à chaque échéance, à partir de sa date de démarrage.'}
      onClose={onClose}
    >
      <form
        className="finance-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (modification) setMode('NEXT');
          else void creer(e);
        }}
      >
        <label className="field">
          <span className="field-label">Rattachement</span>
          {lockedProjectId || modification ? (
            <>
              <input
                className="search-input"
                value={lockedProjectName ?? recurringCost?.projectNameSnapshot ?? LY_SOLUTION}
                readOnly
              />
              <span className="field-hint muted">
                {modification
                  ? 'Le rattachement d’une règle existante ne change pas.'
                  : 'Depuis la fiche d’un projet, le rattachement est verrouillé.'}
              </span>
            </>
          ) : (
            <select
              className="search-input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">{LY_SOLUTION} — coût propre à l’entreprise</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>{p.projectName}</option>
              ))}
            </select>
          )}
        </label>

        <label className="field">
          <span className="field-label">Nom</span>
          <input
            className="search-input"
            value={label}
            maxLength={160}
            required
            placeholder="Brevo, hébergement, domiciliation…"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            className="manifest-textarea finance-textarea"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="finance-form-row">
          <label className="field">
            <span className="field-label">Montant (€)</span>
            <input
              className="search-input"
              type="text"
              inputMode="decimal"
              value={amount}
              required
              placeholder="49,00"
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">Tous les</span>
            <div className="finance-recurrence-row">
              <input
                className="search-input finance-interval"
                type="number"
                min={1}
                max={366}
                value={interval}
                required
                disabled={modification}
                onChange={(e) => setInterval(e.target.value)}
              />
              <select
                className="search-input"
                value={unit}
                disabled={modification}
                onChange={(e) => setUnit(e.target.value as RecurrenceUnit)}
              >
                {UNITES.map((u) => (
                  <option key={u.value} value={u.value}>{pluriel ? u.pluriel : u.label}</option>
                ))}
              </select>
            </div>
            <span className="field-hint muted">
              {`Une ligne de coût tous les ${interval || 1} ${pluriel ? uniteChoisie.pluriel : uniteChoisie.label}.`}
            </span>
          </label>

          <label className="field">
            <span className="field-label">Démarrage</span>
            <input
              className="search-input"
              type="date"
              value={startAt}
              required
              disabled={modification}
              onChange={(e) => setStartAt(e.target.value)}
            />
            <span className="field-hint muted">
              La première échéance a lieu ce jour-là.
            </span>
          </label>
        </div>

        {unit === 'MONTH' && Number(startAt.slice(8, 10)) > 28 ? (
          <p className="field-hint muted">
            {`Le ${Number(startAt.slice(8, 10))} n’existe pas tous les mois : l’échéance tombera alors au `}
            dernier jour du mois, puis reviendra au {Number(startAt.slice(8, 10))} dès que possible.
          </p>
        ) : null}

        {erreur ? <div className="alert alert-error">{erreur}</div> : null}

        <div className="action-buttons">
          {/* Le bouton d'enregistrement n'existe que s'il y a quelque chose à enregistrer. */}
          {!modification || modifie ? (
            <button type="submit" className="btn btn-primary" disabled={occupe}>
              {modification ? 'Enregistrer…' : (occupe ? 'Création…' : 'Créer la récurrence')}
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={occupe}>
            Annuler
          </button>
        </div>
      </form>
    </FinanceModal>
  );
}

/**
 * ARRÊTER UNE RÉCURRENCE — deux choix, et leurs conséquences écrites.
 *
 * « Actuelle » retire du livret le coût du cycle en cours : c'est exactement ce
 * que demande le cahier des charges, et c'est le geste le plus surprenant des
 * deux. La modale le dit en toutes lettres, avec ce qui est conservé — la ligne
 * reste auditable, son justificatif aussi.
 */
export function StopRecurringDialog({
  recurringCost,
  onStop,
  onClose,
}: {
  recurringCost: RecurringCost;
  onStop: (mode: 'CURRENT' | 'NEXT', reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'CURRENT' | 'NEXT'>('NEXT');
  const [reason, setReason] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const CHOIX = [
    {
      value: 'NEXT' as const,
      label: 'Prochaine',
      detail: 'Le cycle en cours reste comptabilisé. Plus aucune ligne ne sera créée ensuite.',
    },
    {
      value: 'CURRENT' as const,
      label: 'Actuelle',
      detail: 'Le coût du cycle en cours est retiré des totaux, et plus aucune ligne ne sera créée. '
        + 'La ligne reste consultable pour l’audit, avec son justificatif s’il y en a un.',
    },
  ];

  return (
    <FinanceModal
      title="Quand arrêter cette récurrence ?"
      hint={`« ${recurringCost.label} » — les cycles antérieurs ne sont jamais touchés.`}
      danger
      onClose={onClose}
    >
      <div className="finance-mode-list" role="radiogroup" aria-label="Moment de l’arrêt">
        {CHOIX.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={mode === c.value}
            className={mode === c.value ? 'finance-mode finance-mode-on' : 'finance-mode'}
            onClick={() => setMode(c.value)}
          >
            <span className="finance-mode-label">{c.label}</span>
            <span className="finance-mode-detail">{c.detail}</span>
          </button>
        ))}
      </div>

      <label className="field">
        <span className="field-label">Motif (facultatif)</span>
        <input
          className="search-input"
          value={reason}
          placeholder="Contrat résilié, service remplacé…"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>

      <p className="field-hint muted">
        Une récurrence arrêtée ne se modifie plus et ne se réactive pas. Pour reprendre
        cet abonnement plus tard, créez-en une nouvelle : son historique restera distinct
        et lisible.
      </p>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      <div className="action-buttons">
        <button
          type="button"
          className="btn btn-danger"
          disabled={occupe}
          onClick={() => {
            setOccupe(true);
            setErreur(null);
            void onStop(mode, reason)
              .catch((err) => setErreur(errorMessage(err, 'L’arrêt n’a pas abouti.')))
              .finally(() => setOccupe(false));
          }}
        >
          {occupe ? 'Arrêt…' : `Arrêter — ${mode === 'CURRENT' ? 'actuelle' : 'prochaine'}`}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={occupe}>
          Annuler
        </button>
      </div>
    </FinanceModal>
  );
}

export default RecurringCostForm;
