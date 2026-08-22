/**
 * LE FAIT FOURNISSEUR D'UN MOUVEMENT — dans le DÉTAIL, et nulle part ailleurs.
 *
 * ══ POURQUOI CES IDENTIFIANTS NE SONT PAS DANS LA LISTE ═════════════════════
 *
 * `in_1QxK…`, `pi_3Q7x…`, `sub_1Nz…` ne veulent rien dire pour la personne qui
 * lit un livret de revenus. Une colonne d'identifiants Stripe transformerait un
 * écran comptable en console de débogage, pour servir un besoin qui se présente
 * une fois par trimestre : rapprocher une ligne du tableau de bord Stripe.
 *
 * Ils sont donc ici — chargés à la demande, sur l'écran qui les cherche.
 *
 * ══ CE N'EST PAS UNE LECTURE DE STRIPE ══════════════════════════════════════
 *
 * Le fait a été normalisé à la réception du webhook et vit en base. Ce panneau
 * lit le Panel, jamais le fournisseur : il s'affiche identiquement si Stripe
 * est indisponible. C'est toute la différence entre projeter un fait et
 * consulter une API.
 *
 * ══ LA FACTURE EST UN LIEN, PAS UN FICHIER ══════════════════════════════════
 *
 * `hostedUrl` et `pdfUrl` sont des adresses Stripe. Le Panel ne les recopie
 * pas, ne les republie pas et n'en fabrique aucune copie locale : le
 * justificatif PRIVÉ du lot L10.2 reste disponible à côté, pour la pièce que
 * l'opérateur choisit d'archiver lui-même.
 */
import { CopyField } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import type { ProviderFact } from '@/types.finance';

const JOUR_LONG = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });

/** Les libellés d'objet canonique — en français, jamais le mot de l'API. */
const OBJET_LABELS: Record<string, string> = {
  INVOICE: 'Facture',
  CHECKOUT_SESSION: 'Session de paiement',
};

/** Ce que dit l'état de projection, en une phrase utile. */
const ETAT_LABELS: Record<string, string> = {
  PROJECTED: 'Porté au registre',
  PENDING: 'En attente d’appartenance',
  UNOWNED: 'Aucune ressource liée',
  REVOKED: 'Lien neutralisé',
  DEFERRED: 'Reconnu, hors périmètre',
  SKIPPED: 'Écarté',
};

function Ligne({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="finance-detail-row">
      <span className="finance-detail-label">{label}</span>
      <span className="finance-detail-value">{children}</span>
    </div>
  );
}

export function ProviderFactPanel({ fact }: { fact: ProviderFact }) {
  const doc = fact.invoiceDocument;

  return (
    <div className="finance-provider-fact">
      <p className="subsection-title">Origine automatique</p>

      <div className="finance-detail-list">
        <Ligne label="Fournisseur">
          {fact.provider}
          {/*
            LE MONDE EST TOUJOURS VISIBLE, et il porte une pastille : lire un
            montant sans savoir s'il vient de la recette ou de la production est
            exactement l'erreur qu'un badge évite.
          */}
          {' '}
          <span className={fact.environment === 'PROD' ? 'badge badge-ok' : 'badge badge-warn'}>
            {fact.environment}
          </span>
        </Ligne>

        <Ligne label="Objet de référence">
          {OBJET_LABELS[fact.objectType] ?? fact.objectType}
          <CopyField value={fact.objectId} />
        </Ligne>

        {fact.occurredAt ? (
          <Ligne label="Date fournisseur">{formatDateTime(fact.occurredAt)}</Ligne>
        ) : null}

        {fact.periodStart && fact.periodEnd ? (
          <Ligne label="Période couverte">
            {`${JOUR_LONG.format(new Date(fact.periodStart))} → ${JOUR_LONG.format(new Date(fact.periodEnd))}`}
          </Ligne>
        ) : null}

        <Ligne label="État de projection">
          {ETAT_LABELS[fact.projectionStatus] ?? fact.projectionStatus}
          {fact.projectedAt ? (
            <span className="muted"> · {formatDateTime(fact.projectedAt)}</span>
          ) : null}
        </Ligne>

        {/*
          UNE REVENDICATION DIVERGENTE EST UN SIGNAL DE SÉCURITÉ.
          Les metadata Stripe désignaient un autre projet que le lien. Le lien a
          gagné — mais quelqu'un doit pouvoir le voir.
        */}
        {fact.claimMismatch ? (
          <Ligne label="Avertissement">
            <span className="badge badge-warn">Revendication divergente</span>
            <span className="muted">
              {' '}Les métadonnées du fournisseur désignaient un autre projet.
              Le lien d’appartenance a fait autorité.
            </span>
          </Ligne>
        ) : null}
      </div>

      {/* ── LA FACTURE DU FOURNISSEUR ────────────────────────────────────── */}
      {doc ? (
        <>
          <p className="subsection-title">Facture Stripe</p>
          <div className="finance-detail-list">
            {doc.number ? <Ligne label="Numéro">{doc.number}</Ligne> : null}
            <Ligne label="Document">
              <span className="finance-invoice-links">
                {doc.hostedUrl ? (
                  <a
                    className="btn btn-small"
                    href={doc.hostedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Ouvrir chez Stripe
                  </a>
                ) : null}
                {doc.pdfUrl ? (
                  <a
                    className="btn btn-small"
                    href={doc.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Télécharger le PDF
                  </a>
                ) : null}
              </span>
            </Ligne>
          </div>
          <p className="field-hint muted">
            Ces liens mènent chez Stripe et peuvent expirer. Pour conserver une copie
            durable, attachez un justificatif ci-dessus : il sera stocké dans l’espace
            privé du Panel.
          </p>
        </>
      ) : null}

      {/* ── IDENTITÉS SECONDAIRES — pour le rapprochement, rien d'autre ──── */}
      <details className="finance-technical">
        <summary>Identifiants techniques</summary>
        <div className="finance-detail-list">
          {fact.corroboration.invoiceNumber ? (
            <Ligne label="Numéro de facture">{fact.corroboration.invoiceNumber}</Ligne>
          ) : null}
          {fact.corroboration.subscriptionId ? (
            <Ligne label="Abonnement"><CopyField value={fact.corroboration.subscriptionId} /></Ligne>
          ) : null}
          {fact.corroboration.paymentIntentId ? (
            <Ligne label="Intention de paiement"><CopyField value={fact.corroboration.paymentIntentId} /></Ligne>
          ) : null}
          {fact.corroboration.chargeId ? (
            <Ligne label="Débit"><CopyField value={fact.corroboration.chargeId} /></Ligne>
          ) : null}
          {fact.corroboration.checkoutSessionId ? (
            <Ligne label="Session"><CopyField value={fact.corroboration.checkoutSessionId} /></Ligne>
          ) : null}
          {fact.corroboration.customerId ? (
            <Ligne label="Client"><CopyField value={fact.corroboration.customerId} /></Ligne>
          ) : null}
          {/*
            ── L'ÉCRITURE DE SOLDE (L13) ────────────────────────────────────

            C'est LA référence de ce lot : celle par laquelle un exploitant
            retrouve, dans le tableau de bord Stripe, la ligne exacte qui a
            fixé la commission. Elle est ici et pas plus haut parce qu'elle
            n'est pas une lecture courante — c'est une PREUVE, celle que le
            frais a été observé et non calculé.
          */}
          {fact.settlement?.balanceTransactionId ? (
            <Ligne label="Écriture de solde">
              <CopyField value={fact.settlement.balanceTransactionId} />
              {fact.settlement.reportingCategory ? (
                <span className="muted"> · {fact.settlement.reportingCategory}</span>
              ) : null}
            </Ligne>
          ) : null}
          {/*
            POURQUOI IL N'Y A PAS ENCORE DE FRAIS — dit ici, jamais deviné.

            Un encaissement dont la commission n'est pas encore connue affiche
            « en cours de récupération » plus haut. Cette ligne-ci donne le
            motif technique, et le nombre de tentatives : c'est ce qu'un
            exploitant vient chercher quand l'attente dure.
          */}
          {fact.settlement && fact.settlement.status !== 'SETTLED' ? (
            <Ligne label="Frais fournisseur">
              {fact.settlement.status}
              {fact.settlement.reason ? (
                <span className="muted"> · {fact.settlement.reason}</span>
              ) : null}
              {fact.settlement.attempts ? (
                <span className="muted"> · {fact.settlement.attempts} tentative(s)</span>
              ) : null}
              {fact.settlement.lastError ? (
                <div className="cell-secondary">{fact.settlement.lastError}</div>
              ) : null}
            </Ligne>
          ) : null}
          {fact.lastEventType ? (
            <Ligne label="Dernier événement">
              {fact.lastEventType}
              <span className="muted"> · {fact.seenEventCount} annonce(s) reçue(s)</span>
            </Ligne>
          ) : null}
        </div>
      </details>
    </div>
  );
}

export default ProviderFactPanel;
