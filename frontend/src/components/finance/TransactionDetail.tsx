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
import { useEffect, useState } from 'react';
import { finances } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { ProviderFactPanel } from '@/components/finance/ProviderFactPanel';
import type { ProviderFact, RefundRequest } from '@/types.finance';
import { formatCents, formatFlowCents } from '@/lib/money';
import { FinanceModal } from '@/components/finance/FinanceModal';
import { ReceiptCell } from '@/components/finance/ReceiptCell';
import { SettlementBreakdown } from '@/components/finance/SettlementBreakdown';
import {
  CATEGORY_LABELS, FLOW_LABELS, ORIGIN_LABELS, STATUS_LABELS, ownershipLabel,
} from '@/components/finance/financeLabels';
import type { FinancialTransaction } from '@/types.finance';

const DATE_SEULE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });

/**
 * LES CINQ ÉTATS D'UNE DEMANDE DE REMBOURSEMENT (L10.4).
 *
 * `UNKNOWN` ne se lit PAS « Échec ». C'est la traduction la plus importante de
 * ce fichier : un échec dit que l'argent n'est pas parti, un inconnu dit qu'on
 * ne sait pas. Écrire « Échec » ferait recommencer, et l'argent partirait deux
 * fois.
 */
const ETIQUETTE_DEMANDE: Record<RefundRequest['status'], { label: string; tone: string }> = {
  REQUESTED: { label: 'Demandé', tone: 'badge' },
  PROCESSING: { label: 'En cours', tone: 'badge badge-warn' },
  SUCCEEDED: { label: 'Remboursé', tone: 'badge badge-ok' },
  /**
   * « le fournisseur » et non « Stripe » : cet écran décrit un MOUVEMENT, et le
   * registre est fournisseur-agnostique depuis L10.1. Le nom du fournisseur vit
   * dans le panneau du fait, à côté des identifiants qu'il produit.
   */
  FAILED: { label: 'Refusé par le fournisseur', tone: 'badge badge-danger' },
  UNKNOWN: { label: 'Vérification en cours', tone: 'badge badge-warn' },
};

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

  /**
   * LE FAIT FOURNISSEUR EST CHARGÉ À L'OUVERTURE DU DÉTAIL — et seulement là.
   *
   * La liste ne le demande jamais : ce sont des identités techniques, et les
   * charger pour cent lignes coûterait cent lectures pour un écran qui n'en
   * montre aucune. Ici, on en montre une, et quelqu'un la cherche.
   *
   * Aucune requête si le mouvement n'a pas de provenance : une saisie manuelle
   * ou une occurrence de coût récurrent n'a rien à dire, et un appel qui rend
   * toujours `null` est un appel de trop.
   */
  const [fait, setFait] = useState<ProviderFact | null>(null);
  /**
   * L'HISTORIQUE DES DEMANDES DE REMBOURSEMENT (L10.4).
   *
   * Ici, et nulle part ailleurs. La liste porte déjà l'ÉTAT — combien a été
   * rendu, s'il reste quelque chose — parce que c'est ce qu'on lit en
   * parcourant. Le détail répond à la question suivante : QUI a demandé, QUAND,
   * pour quelle raison, et ce qu'il est advenu des tentatives qui ont échoué.
   */
  const [demandes, setDemandes] = useState<RefundRequest[]>([]);
  useEffect(() => {
    if (!transaction.provenance) return undefined;
    let vivant = true;
    finances.detail(transaction.transactionId)
      .then((res) => {
        if (!vivant) return;
        setFait(res.providerFact);
        setDemandes(res.refundRequests ?? []);
      })
      // Un détail fournisseur indisponible ne doit pas casser l'écran : le
      // mouvement lui-même est déjà là, et c'est lui qui compte.
      .catch(() => null);
    return () => { vivant = false; };
  }, [transaction.transactionId, transaction.provenance]);

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
          PROVENANCE — affichée SEULEMENT si elle existe, et seulement TANT QUE
          le fait fournisseur complet n'est pas chargé.

          Les deux diraient la même chose en double. Ce repli sert le cas où le
          détail fournisseur n'a pas pu être lu : mieux vaut le peu qu'on a en
          main que rien du tout — un bloc vide sur une saisie manuelle serait en
          revanche un mensonge poli.
        */}
        {transaction.provenance && !fait ? (
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

      {/*
        ── CE QUE LA VENTE VALAIT (L13) ──────────────────────────────────────

        HT, TVA, TTC tels que le DOCUMENT du fournisseur les portait. Jamais
        recalculés depuis le taux du contrat : celui-ci est celui d'aujourd'hui,
        la facture est celle d'un jour donné, et un changement de taux ferait
        mentir rétroactivement toutes les lignes passées.

        Le bloc n'apparaît que si le fournisseur a réellement ventilé. Une
        facture sans TVA n'a pas de TVA à afficher — pas « 0,00 € », rien.
      */}
      {transaction.fiscal ? (
        <div className="finance-detail-block">
          <h3>Informations commerciales</h3>
          <div className="finance-detail-list">
            <Ligne label="Montant HT">{formatCents(transaction.fiscal.netExcludingTaxCents)}</Ligne>
            <Ligne label="TVA">{formatCents(transaction.fiscal.taxCents)}</Ligne>
            <Ligne label="Montant TTC">
              {formatCents(transaction.fiscal.grossIncludingTaxCents)}
              <span className="muted"> · le montant réellement débité</span>
            </Ligne>
          </div>
        </div>
      ) : null}

      {/*
        ── CE QUE L'ENCAISSEMENT A RAPPORTÉ (L13) ────────────────────────────

        La question à laquelle le registre ne savait pas répondre avant ce lot.
        Le montant affiché tout en haut ne bouge pas : c'est le brut, c'est ce
        que le client a payé, et c'est lui qui compte dans le chiffre
        d'affaires. Ce bloc dit ce que le fournisseur en a retenu.
      */}
      {transaction.settlement ? (
        <div className="finance-detail-block">
          {/*
            LE TITRE SUIT LE SENS DU MOUVEMENT.

            « Résultat de l'encaissement » sur un remboursement était faux : rien
            n'a été encaissé, de l'argent est sorti. La recette déployée l'a
            montré sur un remboursement réel, et un titre qui ment sur la nature
            d'un mouvement financier est plus grave qu'un chiffre absent.
          */}
          <h3>
            {transaction.settlement.direction === 'OUT'
              ? 'Résultat du remboursement'
              : 'Résultat de l’encaissement'}
          </h3>
          <SettlementBreakdown settlement={transaction.settlement} />
          {/*
            UN FRAIS CONNU ET NUL SE DIT — ici, et pas dans la liste.

            Le décompte ne s'affiche pas quand il n'y a rien à décomposer. Mais
            « le fournisseur n'a rien prélevé » est une information, et c'est
            même la réponse à la question qu'on vient poser sur un remboursement.
            La taire laisserait croire que le frais n'a pas été cherché.
          */}
          {transaction.settlement.status === 'SETTLED'
            && transaction.settlement.providerCostCents === 0 ? (
              <p className="field-hint muted">
                Aucun frais retenu par le fournisseur sur ce mouvement.
              </p>
            ) : null}
          <div className="finance-detail-list">
            <Ligne label="Fournisseur de paiement">
              {transaction.settlement.provider}
              {transaction.provenance?.environment ? (
                <span className="muted"> · {transaction.provenance.environment}</span>
              ) : null}
            </Ligne>
            {/*
              LA VENTILATION DU FOURNISSEUR — lue, jamais recomposée.

              Le total qui fait foi reste « Frais » ci-dessus : c'est lui que
              Stripe garantit égal à brut − net. Additionner ces lignes
              soi-même rouvrirait une question d'arrondi sur une donnée dont on
              n'est pas l'autorité.
            */}
            {transaction.settlement.feeDetails.length > 0 ? (
              <Ligne label="Détail des frais">
                <ul className="finance-fee-details">
                  {transaction.settlement.feeDetails.map((d, i) => (
                    <li key={`${d.type ?? 'fee'}-${i}`}>
                      {d.description ?? d.type ?? 'Frais'}
                      {' · '}
                      {formatCents(d.amountCents)}
                    </li>
                  ))}
                </ul>
              </Ligne>
            ) : null}
            {/*
              QUAND L'ARGENT DEVIENT DISPONIBLE — une information de trésorerie,
              pas de résultat. Le revenu est acquis le jour du paiement ; les
              fonds, eux, arrivent plus tard. Confondre les deux ferait attendre
              un virement pour constater une vente.
            */}
            {transaction.settlement.availableOn ? (
              <Ligne label="Fonds disponibles le">
                {DATE_SEULE.format(new Date(transaction.settlement.availableOn))}
                {transaction.settlement.providerStatus === 'pending' ? (
                  <span className="muted"> · encore en attente chez le fournisseur</span>
                ) : null}
              </Ligne>
            ) : null}
            {/*
              LE PONT VERS LA CHARGE. La commission n'est pas un champ de ce
              mouvement : c'est un MOUVEMENT à part, qui pèse sur le bénéfice
              et qu'on retrouve dans la liste. Son identité est donnée ici pour
              que le lien se voie.
            */}
            {transaction.settlement.providerCostTransactionId ? (
              <Ligne label="Mouvement de commission">
                <code className="inline-code">
                  {transaction.settlement.providerCostTransactionId}
                </code>
              </Ligne>
            ) : null}
          </div>
        </div>
      ) : null}

      {/*
        LE FAIT FOURNISSEUR — après les données métier, et jamais avant.
        L'utilisateur lit d'abord un montant, une date et un nom ; les
        identifiants Stripe viennent après, pour qui les cherche.
      */}
      {fait ? <ProviderFactPanel fact={fait} /> : null}

      {/*
        ── L'ÉTAT DE REMBOURSEMENT DE CET ENCAISSEMENT ────────────────────────

        Le montant affiché plus haut ne bouge PAS. C'est un principe, pas un
        oubli : l'encaissement de 500 € a bien eu lieu, et le corriger à 400
        effacerait un fait. Ce bloc dit ce qui en est reparti, et rien d'autre.
      */}
      {transaction.refund && transaction.refund.count > 0 ? (
        <div className="finance-detail-block">
          <h3>Remboursements</h3>
          <div className="finance-detail-grid">
            <Ligne label="Déjà remboursé">{formatCents(transaction.refund.refundedCents)}</Ligne>
            <Ligne label="Remboursable restant">{formatCents(transaction.refund.remainingCents)}</Ligne>
          </div>
        </div>
      ) : null}

      {transaction.refund?.pending ? (
        <div className="alert alert-warning">
          Un remboursement est en cours de vérification : son issue n’est pas encore
          connue. Aucun second remboursement ne sera créé.
        </div>
      ) : null}

      {demandes.length > 0 ? (
        <details className="finance-technical">
          <summary>Demandes de remboursement ({demandes.length})</summary>
          <ul className="finance-refund-history">
            {demandes.map((d) => (
              <li key={d.refundRequestId}>
                <span className={ETIQUETTE_DEMANDE[d.status].tone}>
                  {ETIQUETTE_DEMANDE[d.status].label}
                </span>
                {' · '}
                {d.amountCents === null ? 'Totalité du restant' : formatCents(d.amountCents)}
                {' · '}
                <span className="muted">{formatDateTime(d.requestedAt)}</span>
                {d.requestedBy.email ? <span className="muted"> · {d.requestedBy.email}</span> : null}
                {d.operatorReason ? <div className="cell-secondary">{d.operatorReason}</div> : null}
                {/* L'identité du REMBOURSEMENT (re_…), jamais celle du paiement. */}
                {d.refundId ? <div className="cell-secondary"><code>{d.refundId}</code></div> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

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
