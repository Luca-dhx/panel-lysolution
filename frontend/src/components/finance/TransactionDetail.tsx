/**
 * LE DÉTAIL D'UN MOUVEMENT.
 *
 * ══ CE QU'ON N'Y VERRA PAS ══════════════════════════════════════════════════
 *
 * Aucune ligne « Identifiant Stripe : — », aucun « Facture : — », aucun
 * « Transaction parente : — ». Un champ vide affiché par anticipation se lit
 * comme une donnée MANQUANTE : l'utilisateur cherche pourquoi elle n'est pas
 * remplie, alors qu'elle n'a simplement aucune raison d'exister sur une saisie
 * manuelle.
 *
 * Chaque bloc conditionnel ci-dessous est donc l'emplacement DÉJÀ PRÊT d'une
 * donnée future : le jour où un mouvement portera une provenance ou une
 * transaction parente, il s'affichera sans qu'on touche à cet écran — et il ne
 * s'affichera que là.
 */
import { formatDateTime } from '@/lib/format';
import { formatCents, formatFlowCents } from '@/lib/money';
import { FinanceModal } from '@/components/finance/FinanceModal';
import { ReceiptCell } from '@/components/finance/ReceiptCell';
import {
  CATEGORY_LABELS, FLOW_LABELS, ORIGIN_LABELS, STATUS_LABELS, ownershipLabel,
} from '@/components/finance/financeLabels';
import type { FinancialTransaction } from '@/types.finance';

const DATE_SEULE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });

function Ligne({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="finance-detail-row">
      <span className="finance-detail-label">{label}</span>
      <span className="finance-detail-value">{children}</span>
    </div>
  );
}

export function TransactionDetail({
  transaction,
  projectNames,
  onClose,
  onEdit,
  onDelete,
  onReceiptChanged,
}: {
  transaction: FinancialTransaction;
  projectNames: Map<string, string>;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReceiptChanged: () => Promise<void> | void;
}) {
  const supprime = transaction.deletedAt !== null;

  return (
    <FinanceModal title={transaction.label} onClose={onClose}>
      {supprime ? (
        <div className="alert alert-warning">
          Ce mouvement est supprimé : il ne participe plus aux totaux.
          {transaction.deletionReason ? ` Motif : ${transaction.deletionReason}.` : ''}
        </div>
      ) : null}

      <p className={`finance-detail-amount finance-amount-${transaction.flow.toLowerCase()}`}>
        {formatFlowCents(transaction.amountCents, transaction.flow)}
      </p>

      <div className="finance-detail-list">
        <Ligne label="Catégorie">
          {CATEGORY_LABELS[transaction.category]}
          {' · '}
          <span className="muted">{FLOW_LABELS[transaction.flow]} de trésorerie</span>
        </Ligne>
        <Ligne label="Rattachement">
          {ownershipLabel(transaction.projectId, transaction.projectNameSnapshot, projectNames)}
        </Ligne>
        <Ligne label="Date d’effet">
          {DATE_SEULE.format(new Date(transaction.effectiveDate))}
        </Ligne>
        {transaction.description ? (
          <Ligne label="Description">{transaction.description}</Ligne>
        ) : null}
        <Ligne label="Origine">{ORIGIN_LABELS[transaction.origin]}</Ligne>
        <Ligne label="Statut">{STATUS_LABELS[transaction.status]}</Ligne>
        <Ligne label="Montant brut">{formatCents(transaction.amountCents)}</Ligne>

        {/*
          PROVENANCE — affichée SEULEMENT si elle existe. Voir l'en-tête : un
          bloc Stripe vide sur une saisie manuelle serait un mensonge poli.
        */}
        {transaction.provenance ? (
          <>
            {transaction.provenance.provider ? (
              <Ligne label="Fournisseur">{transaction.provenance.provider}</Ligne>
            ) : null}
            {transaction.provenance.environment ? (
              <Ligne label="Environnement">{transaction.provenance.environment}</Ligne>
            ) : null}
            {transaction.provenance.externalId ? (
              <Ligne label="Référence externe">
                <code className="inline-code">{transaction.provenance.externalId}</code>
                {transaction.provenance.externalKind ? (
                  <span className="muted"> · {transaction.provenance.externalKind}</span>
                ) : null}
              </Ligne>
            ) : null}
          </>
        ) : null}

        {transaction.parentTransactionId ? (
          <Ligne label="Mouvement d’origine">
            <code className="inline-code">{transaction.parentTransactionId}</code>
          </Ligne>
        ) : null}

        {/*
          L'OCCURRENCE DIT SA RÈGLE ET SON CYCLE — les deux moitiés de son
          identité métier, et la raison pour laquelle elle ne se modifie pas ici.
        */}
        {transaction.cycleKey ? (
          <Ligne label="Cycle">
            {transaction.cycleKey}
            {transaction.sourceRevision ? (
              <span className="muted"> · version {transaction.sourceRevision} de la règle</span>
            ) : null}
          </Ligne>
        ) : null}

        {/*
          LE JUSTIFICATIF — présent même sur un mouvement supprimé, en lecture.
          Un cycle annulé garde sa facture : c'est elle qui explique pourquoi il
          a existé, et c'est exactement ce qu'on cherchera plus tard.
        */}
        <Ligne label="Justificatif">
          <ReceiptCell transaction={transaction} onChanged={onReceiptChanged} />
        </Ligne>

        <Ligne label="Identifiant interne">
          <code className="inline-code">{transaction.transactionId}</code>
        </Ligne>
        <Ligne label="Saisi par">
          {transaction.createdBy ?? '—'}
          <span className="muted"> · {formatDateTime(transaction.createdAt)}</span>
        </Ligne>
        {transaction.updatedAt !== transaction.createdAt ? (
          <Ligne label="Dernière modification">
            {transaction.updatedBy ?? '—'}
            <span className="muted"> · {formatDateTime(transaction.updatedAt)}</span>
          </Ligne>
        ) : null}
        {supprime ? (
          <Ligne label="Supprimé par">
            {transaction.deletedBy ?? '—'}
            <span className="muted"> · {formatDateTime(transaction.deletedAt)}</span>
          </Ligne>
        ) : null}
      </div>

      {!transaction.editable && !supprime ? (
        <p className="field-hint muted">{transaction.notEditableReason}</p>
      ) : null}

      <div className="action-buttons">
        {transaction.editable ? (
          <button type="button" className="btn btn-primary" onClick={onEdit}>Modifier</button>
        ) : null}
        {!supprime ? (
          <button type="button" className="btn btn-danger" onClick={onDelete}>Supprimer</button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={onClose}>Fermer</button>
      </div>
    </FinanceModal>
  );
}

export default TransactionDetail;
