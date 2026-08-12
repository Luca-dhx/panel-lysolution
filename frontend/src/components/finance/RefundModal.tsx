/**
 * REMBOURSER — la fenêtre qui rend de l'argent (L10.4).
 *
 * ══ CE QU'ELLE MONTRE AVANT QU'ON PUISSE CLIQUER ════════════════════════════
 *
 * Le montant encaissé, ce qui a déjà été rendu, ce qui reste. Les trois, et
 * toujours — même quand rien n'a encore été remboursé. Une fenêtre qui
 * n'afficherait que « Montant : 500 € » laisserait croire que 500 € sont
 * disponibles alors que 400 ont pu partir la semaine passée.
 *
 * Aucun de ces chiffres n'est calculé ici : ils viennent du verdict
 * d'éligibilité, celui-là même dont le serveur se sert pour refuser. Deux
 * calculs finiraient par diverger, et c'est l'écran qui promettrait alors ce
 * que le serveur nie.
 *
 * ══ CE QU'ELLE N'OFFRE PAS ══════════════════════════════════════════════════
 *
 * Aucun choix d'environnement. Le monde est DÉRIVÉ du paiement d'origine et
 * affiché en lecture seule : offrir un sélecteur TEST/PROD permettrait de
 * rembourser en production un encaissement de recette, ou l'inverse.
 *
 * Aucune saisie d'identifiant Stripe. La fenêtre ne connaît que l'identité
 * interne du mouvement ; tout le reste est résolu côté serveur.
 *
 * ══ CE QU'ELLE FAIT D'UNE ISSUE INCONNUE ════════════════════════════════════
 *
 * Elle ne dit PAS « échec », et elle ne propose surtout pas de recommencer.
 * Elle dit que la vérification est en cours. C'est la seule réponse honnête
 * quand l'argent est peut-être déjà parti, et c'est ce qui empêche un second
 * remboursement bien réel.
 */
import { useEffect, useState } from 'react';

import { errorMessage, finances } from '@/lib/api';
import { formatCents } from '@/lib/money';
import type {
  RefundEligibility, RefundOutcome, StripeRefundReason,
} from '@/types.finance';

import { FinanceModal } from './FinanceModal';

/** Les trois motifs de Stripe, et leur nom en français. Il n'y en a pas d'autres. */
const MOTIFS: { value: StripeRefundReason; label: string }[] = [
  { value: 'requested_by_customer', label: 'À la demande du client' },
  { value: 'duplicate', label: 'Paiement en double' },
  { value: 'fraudulent', label: 'Paiement frauduleux' },
];

type Mode = 'TOTAL' | 'PARTIEL';

export function RefundModal({
  transactionId,
  onClose,
  onDone,
}: {
  transactionId: string;
  onClose: () => void;
  /** Appelé après une issue non-échec, pour relire le livret. */
  onDone: (outcome: RefundOutcome) => void;
}) {
  const [verdict, setVerdict] = useState<RefundEligibility | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('TOTAL');
  const [montant, setMontant] = useState('');
  const [motif, setMotif] = useState<StripeRefundReason | ''>('');
  const [note, setNote] = useState('');
  const [confirme, setConfirme] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [issue, setIssue] = useState<RefundOutcome | null>(null);

  useEffect(() => {
    let vivant = true;
    finances.refundEligibility(transactionId)
      .then((v) => { if (vivant) setVerdict(v); })
      .catch((e) => { if (vivant) setErreur(errorMessage(e, 'Lecture du paiement impossible.')); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [transactionId]);

  const etat = verdict?.refund ?? null;

  /**
   * Le montant part en CENTIMES, converti d'une saisie en euros. On ne
   * multiplie pas par 100 en virgule flottante — `12,34 × 100` vaut
   * 1233.9999999999998 — mais on lit les deux côtés de la virgule séparément.
   */
  const centimesSaisis = (): number | null => {
    const brut = montant.trim().replace(',', '.');
    if (!brut) return null;
    if (!/^\d+(\.\d{0,2})?$/.test(brut)) return null;
    const [entiers, decimales = ''] = brut.split('.');
    return Number(entiers) * 100 + Number(decimales.padEnd(2, '0'));
  };

  const centimes = mode === 'TOTAL' ? null : centimesSaisis();
  const montantInvalide = mode === 'PARTIEL'
    && (centimes === null || centimes <= 0 || (etat ? centimes > etat.remainingCents : false));

  async function envoyer() {
    if (!verdict?.eligible || envoi) return;
    setEnvoi(true);
    setErreur(null);
    try {
      const resultat = await finances.refund(transactionId, {
        amountCents: centimes,
        reason: motif || null,
        note: note.trim() || null,
      });
      setIssue(resultat);
      onDone(resultat);
    } catch (e) {
      setErreur(errorMessage(e, 'Le remboursement n’a pas pu être transmis.'));
    } finally {
      setEnvoi(false);
    }
  }

  /* ── L'issue, une fois l'acte tenté ───────────────────────────────────── */
  if (issue) {
    const inconnu = issue.status === 'UNKNOWN';
    return (
      <FinanceModal
        title={inconnu ? 'Vérification du remboursement en cours' : 'Remboursement effectué'}
        onClose={onClose}
        danger={inconnu}
      >
        <div className="modal-body">
          {inconnu ? (
            <>
              <p>
                L’issue de ce remboursement n’est pas encore connue. Il a peut-être
                abouti chez Stripe sans que la réponse nous parvienne.
              </p>
              {/**
               * AUCUN BOUTON « RÉESSAYER ». C'est le point entier de cet écran.
               * La reprise est automatique et porte la MÊME identité d'acte :
               * elle reconnaîtra le remboursement s'il existe. Proposer un
               * nouvel essai ici créerait un second remboursement réel.
               */}
              <p className="muted">
                La vérification se poursuit automatiquement. Aucun second remboursement
                ne sera créé, et aucune action n’est nécessaire de votre part.
              </p>
            </>
          ) : (
            <>
              <p>
                {issue.converged
                  ? 'Ce remboursement était déjà enregistré chez Stripe : rien n’a été émis une seconde fois.'
                  : 'Le remboursement a été transmis à Stripe.'}
              </p>
              <dl className="finance-detail-grid">
                <dt>Montant rendu</dt>
                <dd>{formatCents(issue.amountCents ?? 0)}</dd>
                {issue.providerStatus === 'pending' ? (
                  <>
                    <dt>État</dt>
                    <dd>
                      En cours chez Stripe — certains moyens de paiement mettent
                      plusieurs jours à restituer les fonds.
                    </dd>
                  </>
                ) : null}
              </dl>
              <details className="finance-technical">
                <summary>Références techniques</summary>
                <dl className="finance-detail-grid">
                  <dt>Identifiant du remboursement</dt>
                  <dd><code>{issue.refundId}</code></dd>
                </dl>
              </details>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Fermer</button>
        </div>
      </FinanceModal>
    );
  }

  /* ── La demande ───────────────────────────────────────────────────────── */
  return (
    <FinanceModal
      title="Rembourser ce paiement"
      hint="Le remboursement produit un mouvement distinct. L’encaissement d’origine reste inchangé."
      onClose={onClose}
      danger
    >
      <div className="modal-body">
        {chargement ? <p className="muted">Lecture du paiement…</p> : null}

        {etat ? (
          <dl className="finance-detail-grid">
            <dt>Montant encaissé</dt>
            <dd>{formatCents(etat.collectedCents)}</dd>
            <dt>Déjà remboursé</dt>
            <dd>{formatCents(etat.refundedCents)}</dd>
            <dt>Remboursable restant</dt>
            <dd><strong>{formatCents(etat.remainingCents)}</strong></dd>
            <dt>Environnement</dt>
            {/**
             * LECTURE SEULE, et pas un champ désactivé par prudence : il n'y a
             * rien à choisir. Le monde est celui du paiement d'origine.
             */}
            <dd>{etat.environment} <span className="muted">— déterminé par le paiement d’origine</span></dd>
          </dl>
        ) : null}

        {verdict && !verdict.eligible ? (
          <p className="alert alert-warning">{verdict.reason}</p>
        ) : null}

        {verdict?.eligible ? (
          <>
            <fieldset className="finance-fieldset">
              <legend>Montant à rembourser</legend>
              <label className="radio-row">
                <input
                  type="radio"
                  name="refund-mode"
                  checked={mode === 'TOTAL'}
                  onChange={() => setMode('TOTAL')}
                />
                <span>
                  Totalité du restant
                  {etat ? ` (${formatCents(etat.remainingCents)})` : ''}
                </span>
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="refund-mode"
                  checked={mode === 'PARTIEL'}
                  onChange={() => setMode('PARTIEL')}
                />
                <span>Montant partiel</span>
              </label>
              {mode === 'PARTIEL' ? (
                <label className="field">
                  <span>Montant (€)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={montant}
                    onChange={(e) => setMontant(e.target.value)}
                    placeholder="0,00"
                    aria-invalid={montantInvalide}
                  />
                  {montantInvalide ? (
                    <small className="danger">
                      Saisissez un montant positif, au plus {formatCents(etat?.remainingCents ?? 0)}.
                    </small>
                  ) : null}
                </label>
              ) : null}
            </fieldset>

            <label className="field">
              <span>Motif transmis à Stripe</span>
              <select value={motif} onChange={(e) => setMotif(e.target.value as StripeRefundReason | '')}>
                <option value="">— Aucun —</option>
                {MOTIFS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Note interne</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Pourquoi ce remboursement ? Conservé dans le Panel, non transmis à Stripe."
              />
            </label>

            {/**
             * LA CONFIRMATION EXPLICITE — une case, pas un mot à retaper.
             *
             * « Tout supprimer » exige de retaper un mot parce qu'il retire des
             * centaines de lignes d'un coup. Ici l'acte est unitaire, chiffré et
             * relu juste au-dessus : une case cochée sciemment est la bonne
             * hauteur de friction, et un mot à recopier serait un rituel qu'on
             * exécute sans lire.
             */}
            <label className="radio-row">
              <input
                type="checkbox"
                checked={confirme}
                onChange={(e) => setConfirme(e.target.checked)}
              />
              <span>
                Je confirme le remboursement de{' '}
                <strong>
                  {mode === 'TOTAL'
                    ? formatCents(etat?.remainingCents ?? 0)
                    : formatCents(centimes ?? 0)}
                </strong>
                {' '}au client. Cette opération est irréversible.
              </span>
            </label>
          </>
        ) : null}

        {erreur ? <p className="alert alert-danger">{erreur}</p> : null}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={envoi}>Annuler</button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={envoyer}
          disabled={!verdict?.eligible || !confirme || montantInvalide || envoi}
        >
          {envoi ? 'Remboursement en cours…' : 'Rembourser'}
        </button>
      </div>
    </FinanceModal>
  );
}

export default RefundModal;
