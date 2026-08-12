/**
 * SAISIR OU CORRIGER UN MOUVEMENT.
 *
 * ══ DEUX AXES À L'ÉCRAN, ET LE SECOND EST DÉSACTIVÉ ═════════════════════════
 *
 * Le cahier des charges final prévoit une CATÉGORIE (coût · revenu) et un TYPE
 * (ponctuel · récurrent). Le lot L10.1 n'implémente que le ponctuel.
 *
 * Le choix « Récurrent » est donc présent mais DÉSACTIVÉ, avec sa mention. Ce
 * n'est pas de la décoration : le retirer laisserait croire que la récurrence
 * n'est pas prévue, et l'activer sans ordonnanceur produirait de FAUSSES
 * récurrences — une case cochée qui ne déclenche rien, découverte trois mois
 * plus tard en constatant qu'aucune occurrence n'a été créée. Un bouton
 * désactivé qui dit pourquoi est la seule des trois options honnête.
 *
 * ══ LA RÉCURRENCE NE SERA JAMAIS UN CHAMP DE CETTE LIGNE ════════════════════
 *
 * Un coût récurrent n'est pas un mouvement « marqué récurrent » : c'est une
 * DÉFINITION qui engendre des occurrences, chacune étant un mouvement daté de
 * son propre mois. C'est pour cela que le modèle porte `origin:
 * RECURRING_COST` et non un drapeau `isRecurring` — le lot L10.2 ajoutera la
 * définition, pas une case à cocher ici.
 *
 * ══ LE MONTANT PART EN CHAÎNE, JAMAIS EN NOMBRE ═════════════════════════════
 *
 * `<input type="number">` rendrait un `number` JavaScript, donc un flottant, et
 * « 1,005 » y deviendrait silencieusement 1.005 — que le backend refuserait
 * sans que l'utilisateur comprenne. On envoie la SAISIE telle quelle : c'est le
 * backend qui la lit chiffre par chiffre et explique le refus.
 */
import { useState } from 'react';
import { errorMessage } from '@/lib/api';
import { FinanceModal } from '@/components/finance/FinanceModal';
import { LY_SOLUTION, todayInputValue } from '@/components/finance/financeLabels';
import type { FinancialTransaction, ManualTransactionInput } from '@/types.finance';

export interface ProjectChoice {
  projectId: string;
  projectName: string;
}

export function TransactionForm({
  /** Le mouvement à corriger, ou `null` pour une saisie. */
  transaction = null,
  /**
   * LE PROJET IMPOSÉ — depuis la fiche d'un client, le rattachement est
   * verrouillé. On n'affiche alors aucun sélecteur : proposer de rattacher
   * ailleurs depuis la fiche d'un projet serait une invitation à se tromper.
   */
  lockedProjectId = null,
  lockedProjectName = null,
  projects,
  onSubmit,
  onClose,
}: {
  transaction?: FinancialTransaction | null;
  lockedProjectId?: string | null;
  lockedProjectName?: string | null;
  projects: ProjectChoice[];
  onSubmit: (input: ManualTransactionInput) => Promise<void>;
  onClose: () => void;
}) {
  const correction = transaction !== null;

  const [category, setCategory] = useState<'REVENUE' | 'COST'>(
    transaction?.category === 'COST' ? 'COST' : 'REVENUE',
  );
  const [projectId, setProjectId] = useState<string>(
    lockedProjectId ?? transaction?.projectId ?? '',
  );
  const [label, setLabel] = useState(transaction?.label ?? '');
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [amount, setAmount] = useState(
    transaction ? (transaction.amountCents / 100).toFixed(2).replace('.', ',') : '',
  );
  const [effectiveDate, setEffectiveDate] = useState(
    transaction?.effectiveDate?.slice(0, 10) ?? todayInputValue(),
  );
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const envoyer = async (e: React.FormEvent) => {
    e.preventDefault();
    setOccupe(true);
    setErreur(null);
    try {
      await onSubmit({
        // Chaîne vide = L.Y Solution. Le backend lit ce nul comme un
        // rattachement à l'entreprise, jamais comme un oubli.
        projectId: projectId || null,
        category,
        label,
        description,
        amount,
        effectiveDate,
      });
      onClose();
    } catch (err) {
      setErreur(errorMessage(err, 'Le mouvement n’a pas pu être enregistré.'));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <FinanceModal
      title={correction ? 'Corriger le mouvement' : 'Ajouter une transaction'}
      hint={correction
        ? 'Chaque correction est consignée avec son auteur, son avant et son après.'
        : undefined}
      onClose={onClose}
    >
      <form className="finance-form" onSubmit={(e) => void envoyer(e)}>
        {/* ── CATÉGORIE ─────────────────────────────────────────────────── */}
        <fieldset className="finance-fieldset">
          <legend className="field-label">Catégorie</legend>
          <div className="finance-choice-row" role="group">
            <button
              type="button"
              className={category === 'REVENUE' ? 'finance-choice finance-choice-on' : 'finance-choice'}
              aria-pressed={category === 'REVENUE'}
              onClick={() => setCategory('REVENUE')}
            >
              Revenu
            </button>
            <button
              type="button"
              className={category === 'COST' ? 'finance-choice finance-choice-on' : 'finance-choice'}
              aria-pressed={category === 'COST'}
              onClick={() => setCategory('COST')}
            >
              Coût
            </button>
          </div>
        </fieldset>

        {/* ── TYPE — la récurrence est annoncée, jamais simulée ──────────── */}
        <fieldset className="finance-fieldset">
          <legend className="field-label">Type</legend>
          <div className="finance-choice-row" role="group">
            <button type="button" className="finance-choice finance-choice-on" aria-pressed>
              Ponctuel
            </button>
            <button
              type="button"
              className="finance-choice"
              disabled
              title="Les coûts récurrents arriveront dans un lot dédié : ils engendreront une occurrence par échéance, avec son justificatif."
            >
              Récurrent
            </button>
          </div>
          <p className="field-hint muted">
            Le récurrent arrive dans un prochain lot : il produira une ligne par échéance,
            plutôt qu’une case cochée sur un mouvement unique.
          </p>
        </fieldset>

        {/* ── RATTACHEMENT ──────────────────────────────────────────────── */}
        <label className="field">
          <span className="field-label">Rattachement</span>
          {lockedProjectId ? (
            <>
              <input
                className="search-input"
                value={lockedProjectName ?? lockedProjectId}
                readOnly
                aria-describedby="finance-rattachement-verrouille"
              />
              <span className="field-hint muted" id="finance-rattachement-verrouille">
                Depuis la fiche d’un projet, le rattachement est verrouillé.
              </span>
            </>
          ) : (
            <>
              <select
                className="search-input"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">{LY_SOLUTION} — mouvement propre à l’entreprise</option>
                {projects.map((projet) => (
                  <option key={projet.projectId} value={projet.projectId}>
                    {projet.projectName}
                  </option>
                ))}
              </select>
              <span className="field-hint muted">
                Sans projet, le mouvement appartient à {LY_SOLUTION} — frais de structure,
                prestations hors projet.
              </span>
            </>
          )}
        </label>

        <label className="field">
          <span className="field-label">Nom</span>
          <input
            className="search-input"
            value={label}
            maxLength={160}
            required
            placeholder="Création du site, Nom de domaine, Abonnement outillage…"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            className="manifest-textarea finance-textarea"
            value={description}
            rows={3}
            placeholder="Ce que cette ligne recouvre — solde à la livraison, période couverte…"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="finance-form-row">
          <label className="field">
            <span className="field-label">Montant (€)</span>
            <input
              className="search-input"
              // `text` et non `number` : voir l'en-tête de ce fichier.
              type="text"
              inputMode="decimal"
              value={amount}
              required
              placeholder="249,00"
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="field-hint muted">
              Toujours positif : le sens vient de la catégorie, jamais d’un signe.
            </span>
          </label>

          <label className="field">
            <span className="field-label">Date</span>
            <input
              className="search-input"
              type="date"
              value={effectiveDate}
              required
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
            <span className="field-hint muted">
              La date du FAIT, pas celle de la saisie.
            </span>
          </label>
        </div>

        {erreur ? <div className="alert alert-error">{erreur}</div> : null}

        <div className="action-buttons">
          <button type="submit" className="btn btn-primary" disabled={occupe}>
            {occupe ? 'Enregistrement…' : correction ? 'Enregistrer la correction' : 'Ajouter'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={occupe}>
            Annuler
          </button>
        </div>
      </form>
    </FinanceModal>
  );
}

export default TransactionForm;
