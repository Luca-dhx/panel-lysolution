/**
 * PAIEMENTS EN ATTENTE — de l'argent RÉCLAMÉ, pas encore gagné (L10.5).
 *
 * ══ POURQUOI UN BLOC À PART, SOUS « REVENUS » ══════════════════════════════
 *
 * Une créance n'est pas un mouvement : elle n'entre dans aucun total, et le
 * bénéfice du mois ne doit pas dépendre de ce qu'on espère encaisser. La mêler
 * à la liste des revenus aurait fait exactement cela.
 *
 * Elle vit pourtant sous « Revenus », parce que c'est là qu'on vient poser la
 * question « qu'est-ce que ce client me doit ? ». Séparée, mais voisine.
 *
 * ══ CE QUE L'ÉCRAN NE CALCULE PAS ══════════════════════════════════════════
 *
 * La TVA. Le taux vient du CONTRAT, projeté depuis le projet, et le serveur
 * fige le triplet HT / TVA / TTC à la création. L'écran affiche un aperçu
 * pendant la saisie — clairement annoncé comme tel — et le serveur reste seul à
 * décider. Deux calculs finiraient par diverger, et c'est l'écran qui
 * promettrait alors ce que la facture ne dirait pas.
 */
import { useCallback, useEffect, useState } from 'react';

import { Card, EmptyState } from '@/components/ui';
import { errorMessage, finances } from '@/lib/api';
import { formatCents } from '@/lib/money';
import type { PaymentRequest, PaymentRequestStatus } from '@/types.finance';

import { FinanceModal } from './FinanceModal';

const DATE_SEULE = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Paris',
});

/**
 * LES SIX ÉTATS, ET CE QU'ILS DISENT AU LECTEUR.
 *
 * `PAYMENT_PENDING` se lit « paiement en cours » et non « en attente » : le
 * client est devant sa carte, ce n'est pas la même chose qu'une facture qu'il
 * n'a pas ouverte.
 */
const ETIQUETTE: Record<PaymentRequestStatus, { label: string; tone: string }> = {
  DRAFT: { label: 'Brouillon', tone: 'badge' },
  OPEN: { label: 'À payer', tone: 'badge badge-warn' },
  PAYMENT_PENDING: { label: 'Paiement en cours', tone: 'badge badge-warn' },
  PAID: { label: 'Payée', tone: 'badge badge-ok' },
  CANCELED: { label: 'Annulée', tone: 'badge' },
  EXPIRED: { label: 'Échue', tone: 'badge' },
};

export function PaymentRequestPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName?: string | null;
}) {
  const [items, setItems] = useState<PaymentRequest[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [formulaire, setFormulaire] = useState(false);
  const [detail, setDetail] = useState<PaymentRequest | null>(null);

  const recharger = useCallback(async () => {
    try {
      const { items: recus } = await finances.paymentRequests(projectId);
      setItems(recus);
      setErreur(null);
    } catch (e) {
      setErreur(errorMessage(e, 'Les prestations n’ont pas pu être lues.'));
      setItems([]);
    }
  }, [projectId]);

  useEffect(() => { void recharger(); }, [recharger]);

  const du = (items ?? [])
    .filter((p) => p.payable)
    .reduce((somme, p) => somme + p.grossAmountCents, 0);

  return (
    <Card>
      <div className="card-head">
        <div>
          <h2>Paiements en attente</h2>
          <p className="muted">
            {du > 0
              ? `${formatCents(du)} TTC réclamés et non encore encaissés.`
              : 'Aucune somme réclamée en attente.'}
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setFormulaire(true)}>
          Nouvelle prestation
        </button>
      </div>

      {erreur ? <p className="alert alert-danger">{erreur}</p> : null}

      {items === null ? (
        <p className="muted">Chargement…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="Aucune prestation facturée"
          hint="Facturez un travail ponctuel à ce client — développement, intervention, régularisation."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Prestation</th>
                <th scope="col">Montant</th>
                <th scope="col">État</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.paymentRequestId}>
                  <td>{DATE_SEULE.format(new Date(p.sentAt ?? p.createdAt))}</td>
                  <td>
                    <span className="cell-primary">{p.label}</span>
                    {p.description ? <span className="cell-secondary">{p.description}</span> : null}
                    {/*
                      LES RELANCES SE LISENT SUR LA LIGNE : c'est la question
                      qu'on se pose en parcourant — « ce client a-t-il été
                      relancé, et quand le sera-t-il ? ».
                    */}
                    {p.reminders.enabled && p.payable ? (
                      <span className="cell-secondary">
                        {p.reminders.count > 0
                          ? `${p.reminders.count} relance(s) · prochaine le `
                          : 'Relances actives · première le '}
                        {p.reminders.nextAt
                          ? DATE_SEULE.format(new Date(p.reminders.nextAt))
                          : '—'}
                      </span>
                    ) : null}
                  </td>
                  <td className="finance-cell-amount">
                    {formatCents(p.grossAmountCents)}
                    <span className="cell-secondary">
                      {formatCents(p.netAmountCents)} HT · TVA {p.taxRate} %
                    </span>
                  </td>
                  <td>
                    <span className={ETIQUETTE[p.status].tone}>{ETIQUETTE[p.status].label}</span>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="btn btn-small" onClick={() => setDetail(p)}>
                      Détails
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formulaire ? (
        <PaymentRequestForm
          projectId={projectId}
          projectName={projectName ?? null}
          onClose={() => setFormulaire(false)}
          onDone={() => { setFormulaire(false); void recharger(); }}
        />
      ) : null}

      {detail ? (
        <PaymentRequestDetail
          request={detail}
          onClose={() => setDetail(null)}
          onChanged={() => { setDetail(null); void recharger(); }}
        />
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  CRÉATION                                                                  */
/* -------------------------------------------------------------------------- */

function PaymentRequestForm({
  projectId, projectName, onClose, onDone,
}: {
  projectId: string;
  projectName: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [montant, setMontant] = useState('');
  const [relances, setRelances] = useState(false);
  const [intervalle, setIntervalle] = useState('7');
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  /**
   * L'APERÇU DE LA TVA — annoncé comme tel, et jamais autoritaire.
   *
   * Le taux réel vient du contrat et n'est connu que du serveur. On ne le
   * devine donc PAS ici : tant qu'on ne l'a pas, on montre le HT seul plutôt
   * qu'un TTC inventé. Afficher « 600 € » sur un taux supposé serait la pire
   * des aides — le client recevrait autre chose.
   */
  const centimes = (() => {
    const brut = montant.trim().replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(brut)) return null;
    const [entiers, dec = ''] = brut.split('.');
    return Number(entiers) * 100 + Number(dec.padEnd(2, '0'));
  })();

  async function envoyer() {
    if (envoi || !label.trim() || !centimes) return;
    setEnvoi(true);
    setErreur(null);
    try {
      await finances.createPaymentRequest({
        projectId,
        label: label.trim(),
        description: description.trim(),
        netAmount: montant.trim(),
        reminders: relances
          ? { enabled: true, intervalDays: Number(intervalle) || 7 }
          : { enabled: false },
      });
      onDone();
    } catch (e) {
      setErreur(errorMessage(e, 'La prestation n’a pas pu être créée.'));
      setEnvoi(false);
    }
  }

  return (
    <FinanceModal
      title="Nouvelle prestation"
      hint={projectName ? `Facturée à ${projectName}.` : undefined}
      onClose={onClose}
    >
      <div className="modal-body">
        <label className="field">
          <span>Nom *</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={160}
            placeholder="Ajout formulaire personnalisé"
          />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Développement et intégration du formulaire demandé."
          />
        </label>

        <label className="field">
          <span>Montant HT (€) *</span>
          <input
            type="text"
            inputMode="decimal"
            value={montant}
            onChange={(e) => setMontant(e.target.value)}
            placeholder="500,00"
            aria-invalid={montant.trim().length > 0 && centimes === null}
          />
          {/*
            LE TAUX N'EST PAS SUPPOSÉ. Il vient du contrat du projet, et le
            serveur le fige à la création. On l'annonce plutôt que d'inventer
            un TTC qui pourrait démentir la facture.
          */}
          <small className="muted">
            La TVA est appliquée au taux du contrat de ce projet, figé au moment
            de l’envoi. Le total TTC apparaîtra sur la prestation créée.
          </small>
        </label>

        <label className="radio-row">
          <input type="checkbox" checked={relances} onChange={(e) => setRelances(e.target.checked)} />
          <span>Relances automatiques tant que la prestation n’est pas réglée</span>
        </label>

        {relances ? (
          <label className="field">
            <span>Intervalle (jours)</span>
            <input
              type="number"
              min={1}
              max={90}
              value={intervalle}
              onChange={(e) => setIntervalle(e.target.value)}
            />
          </label>
        ) : null}

        {erreur ? <p className="alert alert-danger">{erreur}</p> : null}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={envoi}>Annuler</button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={envoyer}
          disabled={envoi || !label.trim() || !centimes}
        >
          {envoi ? 'Envoi…' : 'Envoyer'}
        </button>
      </div>
    </FinanceModal>
  );
}

/* -------------------------------------------------------------------------- */
/*  DÉTAIL                                                                    */
/* -------------------------------------------------------------------------- */

function PaymentRequestDetail({
  request, onClose, onChanged,
}: {
  request: PaymentRequest;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [annulation, setAnnulation] = useState(false);
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  async function annuler() {
    setAnnulation(true);
    setErreur(null);
    try {
      await finances.cancelPaymentRequest(request.paymentRequestId, motif.trim() || undefined);
      onChanged();
    } catch (e) {
      setErreur(errorMessage(e, 'L’annulation a échoué.'));
      setAnnulation(false);
    }
  }

  return (
    <FinanceModal title={request.label} onClose={onClose}>
      <div className="modal-body">
        <dl className="finance-detail-grid">
          <dt>Montant HT</dt>
          <dd>{formatCents(request.netAmountCents)}</dd>
          <dt>TVA {request.taxRate} %</dt>
          <dd>{formatCents(request.taxAmountCents)}</dd>
          <dt>Total à payer</dt>
          <dd><strong>{formatCents(request.grossAmountCents)} TTC</strong></dd>
          <dt>État</dt>
          <dd>{ETIQUETTE[request.status].label}</dd>
          {request.environment ? (<><dt>Environnement</dt><dd>{request.environment}</dd></>) : null}
          {request.description ? (<><dt>Description</dt><dd>{request.description}</dd></>) : null}
        </dl>

        {/*
          LE REVENU PRODUIT — le seul pont vers le livret, et il est descendant.
          Il n'apparaît qu'une fois l'argent réellement encaissé.
        */}
        {request.transactionId ? (
          <p className="field-hint muted">
            Cette prestation a produit un revenu au livret. Le remboursement, s’il
            devient nécessaire, se fait depuis ce mouvement.
          </p>
        ) : null}

        {request.stripe.hostedInvoiceUrl ? (
          <p>
            <a href={request.stripe.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">
              Voir la facture Stripe
            </a>
          </p>
        ) : null}

        <details className="finance-technical">
          <summary>Références techniques et historique</summary>
          <dl className="finance-detail-grid">
            <dt>Identifiant interne</dt>
            <dd><code>{request.paymentRequestId}</code></dd>
            {request.stripe.checkoutSessionId ? (
              <><dt>Session de paiement</dt><dd><code>{request.stripe.checkoutSessionId}</code></dd></>
            ) : null}
            {request.stripe.invoiceId ? (
              <><dt>Facture Stripe</dt><dd><code>{request.stripe.invoiceId}</code></dd></>
            ) : null}
          </dl>
          <ul className="finance-refund-history">
            {request.history.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                {h.to}
                {h.reason ? ` · ${h.reason}` : ''}
                <span className="muted"> · {DATE_SEULE.format(new Date(h.at))}</span>
              </li>
            ))}
          </ul>
        </details>

        {request.payable ? (
          <label className="field">
            <span>Motif d’annulation</span>
            <input
              type="text"
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              maxLength={500}
              placeholder="Devis refusé"
            />
          </label>
        ) : null}

        {erreur ? <p className="alert alert-danger">{erreur}</p> : null}
      </div>

      <div className="modal-actions">
        {request.payable ? (
          <button type="button" className="btn btn-danger" onClick={annuler} disabled={annulation}>
            {annulation ? 'Annulation…' : 'Annuler la prestation'}
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={onClose}>Fermer</button>
      </div>
    </FinanceModal>
  );
}

export default PaymentRequestPanel;
