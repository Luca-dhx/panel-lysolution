/**
 * IMPAYÉS D'ABONNEMENT — CE QUE L'ÉCRAN A LE DROIT DE DIRE (L10.6B-3).
 *
 * ══ CE COMPOSANT NE DÉCIDE RIEN ═════════════════════════════════════════════
 *
 * Pas une ligne de calcul métier. Ni l'échéance de grâce, ni l'accessibilité du
 * site, ni l'état de la cause de suspension : les trois arrivent DÉJÀ DÉCIDÉES
 * dans `display`, mises en mots par un mapper pur côté serveur.
 *
 * Ce n'est pas de la discipline gratuite. Une échéance reconstruite ici depuis
 * `firstFailedAt + contrat.paymentGraceDays` afficherait la politique COURANTE
 * du contrat sur un incident qui en a figé une autre — et annoncerait au client
 * une date de fermeture que le moteur n'appliquera jamais.
 *
 * ══ QUATRE DIMENSIONS, ET ON NE LES FUSIONNE JAMAIS EN UN BADGE ════════════
 *
 *   PAIEMENT        en échec / régularisé / abonnement terminé sans règlement
 *   GRÂCE           non configurée / en cours / expirée
 *   CAUSE           absente / demandée / appliquée / retirée
 *   ACCESSIBILITÉ   le site répond, ou non — et pourquoi
 *
 * L'état qui l'établit, et qu'aucun badge unique ne sait dire :
 *
 *     Paiement        : régularisé
 *     Défaut paiement : retiré
 *     Site            : suspendu
 *     Autre cause     : maintenance technique
 *
 * Un badge vert « tout va bien » y est un mensonge ; un badge rouge « impayé »
 * aussi. Les deux affirmations sont vraies EN MÊME TEMPS, et l'écran doit
 * pouvoir les dire toutes les deux.
 *
 * ══ DEMANDÉE N'EST PAS CONFIRMÉE ═══════════════════════════════════════════
 *
 * Entre `suspensionRequestedAt` et `suspensionConfirmedAt`, il y a un projet
 * qui peut être hors ligne. Tant que la seconde manque, l'écran écrit
 * « Suspension en cours d'application » — jamais « Site suspendu » comme un
 * fait. Et la preuve d'application n'est JAMAIS `suspensionSource` : sous
 * maintenance, la cause dominante reste `TECHNICAL` alors que la nôtre est bel
 * et bien appliquée.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Card, EmptyState } from '@/components/ui';
import { errorMessage, finances } from '@/lib/api';
import { formatCents } from '@/lib/money';
import type {
  CauseDimensionState, GraceDimensionState, PaymentDefaultEntry, PaymentDefaultsView,
  PaymentDimensionState, SiteDimensionState,
} from '@/types.finance';

const DATE_HEURE = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: 'Europe/Paris',
});

/**
 * `null` NE S'AFFICHE PAS COMME UNE DATE VIDE — il s'affiche comme une absence.
 *
 * Un tiret est honnête ; « 01/01/1970 » ne l'est pas, et c'est ce que produit
 * `new Date(null)`.
 */
const quand = (valeur: string | null | undefined) =>
  (valeur ? DATE_HEURE.format(new Date(valeur)) : '—');

/* -------------------------------------------------------------------------- */
/*  TONALITÉS — une par ÉTAT, dérivée du serveur, jamais d'une heuristique     */
/* -------------------------------------------------------------------------- */

const TON_PAIEMENT: Record<PaymentDimensionState, string> = {
  FAILED: 'badge badge-danger',
  SETTLED: 'badge badge-ok',
  ENDED: 'badge',
};

const TON_GRACE: Record<GraceDimensionState, string> = {
  UNCONFIGURED: 'badge',
  RUNNING: 'badge badge-warn',
  EXPIRED: 'badge badge-danger',
  NOT_APPLICABLE: 'badge',
};

const TON_CAUSE: Record<CauseDimensionState, string> = {
  NONE: 'badge',
  /** ORANGE, ET NON ROUGE : une demande n'est pas une fermeture constatée. */
  REQUESTED: 'badge badge-warn',
  APPLIED: 'badge badge-danger',
  REMOVED: 'badge badge-ok',
};

const TON_SITE: Record<SiteDimensionState, string> = {
  ACCESSIBLE: 'badge badge-ok',
  SUSPENDED: 'badge badge-danger',
  /** NEUTRE : « je ne sais pas » n'est ni une bonne ni une mauvaise nouvelle. */
  UNKNOWN: 'badge',
};

/* -------------------------------------------------------------------------- */
/*  LA CARTE D'UN INCIDENT                                                    */
/* -------------------------------------------------------------------------- */

function Ligne({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="finance-default-line">
      <span className="finance-default-label">{label}</span>
      <span className="finance-default-value">{children}</span>
    </div>
  );
}

function IncidentCard({ entry, onRetried }: {
  entry: PaymentDefaultEntry;
  onRetried: () => void;
}) {
  const { incident, display } = entry;
  const { payment, grace, cause, site, policy } = display;
  const [details, setDetails] = useState(false);
  const [tentative, setTentative] = useState<'REPOS' | 'EN_COURS'>('REPOS');
  const [message, setMessage] = useState<{ ton: 'ok' | 'attention'; texte: string } | null>(null);

  /**
   * ── DEMANDER UNE NOUVELLE TENTATIVE ───────────────────────────────────────
   *
   * ══ LA CONFIRMATION EST LÉGÈRE, ET ELLE EST NÉCESSAIRE ══════════════════
   *
   * C’est un prélèvement sur la carte d’un client. Pas de dialogue modal — le
   * geste est réversible dans ses conséquences (une tentative refusée ne coûte
   * rien) — mais pas de déclenchement au survol non plus.
   *
   * ══ LE DOUBLE CLIC EST ARRÊTÉ ICI *ET* AU SERVEUR ══════════════════════
   *
   * Ce drapeau est du confort : il évite une seconde requête. Il ne PROTÈGE
   * rien — un rechargement le remet à zéro. La vraie garantie est l’identité
   * d’acte, dérivée de la facture ET de son nombre de tentatives : deux clics
   * sur le même état produisent le même acte, donc une seule tentative.
   */
  async function demanderTentative() {
    if (tentative === 'EN_COURS') return;
    const montant = formatCents(payment.amountDueCents);
    if (!window.confirm(`Relancer maintenant une tentative de paiement de ${montant} ?`)) return;

    setTentative('EN_COURS');
    setMessage(null);
    try {
      const r = await finances.retryPaymentDefault(display.technical.paymentDefaultId);
      /**
       * On n’annonce PAS « payé ». Stripe a reçu la demande ; l’issue viendra
       * par le webhook, et l’écran la lira au prochain rafraîchissement.
       */
      setMessage({
        ton: 'ok',
        texte: r.invoice?.paid
          ? 'Nouvelle tentative demandée — la facture est réglée.'
          : 'Nouvelle tentative demandée. Le résultat arrivera de Stripe.',
      });
      onRetried();
    } catch (e) {
      /**
       * UN REFUS ATTENDU N’EST PAS UNE PANNE. On affiche le message métier tel
       * que le serveur l’a formulé — il nomme la situation. Le générique n’est
       * gardé que pour ce qui n’en a réellement aucun.
       */
      const err = e as { message?: string };
      setMessage({
        ton: 'attention',
        texte: err?.message || 'La nouvelle tentative n’a pas pu être demandée.',
      });
    } finally {
      setTentative('REPOS');
    }
  }

  return (
    <div className="finance-default-card">
      <div className="finance-default-head">
        <div>
          {/*
            LE TITRE NOMME LA DIMENSION LA PLUS ACTIONNABLE — il n'efface pas
            les trois autres, qui restent affichées juste en dessous.
          */}
          <h3>{display.headline}</h3>
          <p className="muted">
            {display.reasonLabel}
            {payment.invoiceNumber ? ` · facture ${payment.invoiceNumber}` : null}
          </p>
        </div>
        <span className="finance-default-amount">
          {formatCents(payment.amountDueCents)}
        </span>
      </div>

      {/* ── PAIEMENT ─────────────────────────────────────────────────────── */}
      <section className="finance-default-section">
        <h4>Paiement</h4>
        <Ligne label="État">
          <span className={TON_PAIEMENT[payment.state]}>{payment.label}</span>
        </Ligne>
        <Ligne label="Premier échec">{quand(payment.firstFailedAt)}</Ligne>
        {payment.lastFailedAt ? (
          <Ligne label="Dernier échec">{quand(payment.lastFailedAt)}</Ligne>
        ) : null}
        <Ligne label="Tentatives Stripe">
          {payment.attemptCount}
        </Ligne>
        {/*
          ══ « PRÉVUE PAR STRIPE », JAMAIS « NOUS RETENTERONS » ══════════════

          Le Panel n'ordonnance AUCUNE tentative de prélèvement. Laisser croire
          le contraire ferait attendre au client une action que personne ne
          déclenchera — et le libellé vient du serveur pour qu'aucun écran ne
          puisse le reformuler en promesse.

          Une date absente ne veut pas dire « aucune tentative prévue » : elle
          veut dire que Stripe ne l'a pas communiquée. `nextAttemptKnown` porte
          exactement cette nuance.
        */}
        <Ligne label={payment.nextAttemptLabel}>
          {payment.nextAttemptKnown ? quand(payment.nextPaymentAttemptAt) : 'Non communiquée'}
        </Ligne>
        {payment.resolvedAt ? (
          <Ligne label="Régularisé le">{quand(payment.resolvedAt)}</Ligne>
        ) : null}
        {payment.hostedInvoiceUrl || payment.invoicePdfUrl ? (
          <Ligne label="Facture Stripe">
            {payment.hostedInvoiceUrl ? (
              <a href={payment.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                Voir la facture
              </a>
            ) : null}
            {payment.hostedInvoiceUrl && payment.invoicePdfUrl ? ' · ' : null}
            {payment.invoicePdfUrl ? (
              <a href={payment.invoicePdfUrl} target="_blank" rel="noreferrer">PDF</a>
            ) : null}
          </Ligne>
        ) : null}
      </section>

      {/* ── GRÂCE ────────────────────────────────────────────────────────── */}
      <section className="finance-default-section">
        <h4>Délai de grâce</h4>
        <Ligne label="État">
          <span className={TON_GRACE[grace.state]}>{grace.label}</span>
        </Ligne>
        {/*
          ══ `null` ET `0` SONT DEUX DÉCISIONS OPPOSÉES ══════════════════════

          null → aucune politique n'existe. Le site ne fermera pas tout seul.
          0    → aucune clémence. L'échéance tombe dès l'échec.

          Le test est `=== null`, jamais un test de vérité : `grace.snapshot ?`
          afficherait « aucun délai configuré » à un client qui en a zéro, et
          promettrait une suspension automatique là où il n'y en aura jamais.
        */}
        <Ligne label="Délai figé à l’ouverture">
          {grace.graceDaysSnapshot === null
            ? 'Aucun'
            : `${grace.graceDaysSnapshot} jour${grace.graceDaysSnapshot > 1 ? 's' : ''}`}
        </Ligne>
        <Ligne label="Échéance">{quand(grace.graceDeadlineAt)}</Ligne>
        {grace.note ? <p className="field-hint muted">{grace.note}</p> : null}

        {/*
          ══ LE SNAPSHOT N'EST PAS LA POLITIQUE COURANTE ════════════════════

          Les DEUX sont affichées quand elles diffèrent, et l'écran dit
          laquelle s'applique. Recalculer l'incident avec la politique
          courante ferait glisser une échéance déjà annoncée au client.
        */}
        {policy?.drifted ? (
          <div className="finance-default-drift">
            <Ligne label="Incident actuel">
              {policy.snapshot === null ? 'Aucun délai' : `${policy.snapshot} jour(s)`}
            </Ligne>
            <Ligne label="Politique du contrat">
              {policy.current === null ? 'Aucun délai' : `${policy.current} jour(s)`}
            </Ligne>
            {policy.note ? <p className="field-hint muted">{policy.note}</p> : null}
          </div>
        ) : null}
      </section>

      {/* ── SUSPENSION ───────────────────────────────────────────────────── */}
      <section className="finance-default-section">
        <h4>Suspension</h4>
        <Ligne label="Cause « défaut de paiement »">
          <span className={TON_CAUSE[cause.state]}>{cause.label}</span>
        </Ligne>
        <Ligne label="Demandée le">{quand(cause.requestedAt)}</Ligne>
        {/*
          CONFIRMÉE — l'OBSERVATION, pas l'intention. Tant qu'elle manque,
          l'état ci-dessus lit « Suspension en cours d'application ».
        */}
        <Ligne label="Confirmée le">{quand(cause.confirmedAt)}</Ligne>
        {cause.removalConfirmedAt ? (
          <Ligne label="Cause retirée le">{quand(cause.removalConfirmedAt)}</Ligne>
        ) : null}
        {cause.note ? <p className="field-hint muted">{cause.note}</p> : null}
      </section>

      {/* ── ACCESSIBILITÉ ────────────────────────────────────────────────── */}
      <section className="finance-default-section">
        <h4>État réel du site</h4>
        <Ligne label="Accessibilité">
          <span className={TON_SITE[site.state]}>{site.label}</span>
        </Ligne>
        {/*
          LES AUTRES CAUSES, NOMMÉES. C'est ce qui permet de lire
          « paiement régularisé » et « site suspendu » ensemble sans que
          l'écran se contredise : la seconde a une autre raison, et elle est
          écrite.
        */}
        {site.otherCauses.length > 0 ? (
          <Ligne label="Autres causes en vigueur">
            {site.otherCauses.map((c) => c.label).join(' · ')}
          </Ligne>
        ) : null}
        {site.note ? <p className="field-hint muted">{site.note}</p> : null}
      </section>

      {/* ── DÉTAILS TECHNIQUES ───────────────────────────────────────────── */}
      {/*
        ── LA NOUVELLE TENTATIVE — un geste, pas un réglage ─────────────────

        Le bouton n’apparaît que si le serveur dit qu’il servira : incident
        ouvert ou grâce expirée, facture fournisseur présente, montant encore
        dû. L’écran ne recalcule aucune de ces conditions — il les lit.

        Il ne marque jamais « payé ». Il RÉCLAME ; c’est le webhook de Stripe
        qui CONSTATE, par le même chemin que les tentatives automatiques.
      */}
      {display.retry?.retryable ? (
        <div className="finance-default-retry">
          <button
            type="button"
            className="btn btn-small"
            disabled={tentative === 'EN_COURS'}
            onClick={() => void demanderTentative()}
          >
            {tentative === 'EN_COURS' ? 'Envoi…' : 'Nouvelle tentative'}
          </button>
          {/*
            Le retour est DISTINCT selon sa nature : un refus métier se lit,
            une indisponibilité de fournisseur se réessaie. Les fondre en un
            « erreur serveur » ferait chercher une panne là où il n’y a qu’un
            état.
          */}
          {message ? (
            <p className={message.ton === 'ok' ? 'finance-default-ok' : 'finance-default-warn'}>
              {message.texte}
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
        LES IDENTIFIANTS SONT DERRIÈRE « DÉTAILS », et le cahier des charges
        l'exige : un identifiant de fournisseur sert au support, pas à la
        lecture courante. Aucun secret n'y figure — ce sont des références
        d'objets, pas des clés.
      */}
      <div className="finance-default-details">
        <button
          type="button"
          className="btn btn-small"
          aria-expanded={details}
          onClick={() => setDetails((v) => !v)}
        >
          {details ? 'Masquer les détails' : 'Détails'}
        </button>
        {details ? (
          <dl className="finance-default-tech">
            <dt>Incident</dt><dd>{display.technical.paymentDefaultId}</dd>
            <dt>Contrat</dt><dd>{display.technical.contractId ?? '—'}</dd>
            <dt>Facture Stripe</dt><dd>{display.technical.invoiceId ?? '—'}</dd>
            <dt>Abonnement Stripe</dt><dd>{display.technical.subscriptionId ?? '—'}</dd>
            <dt>Intention de paiement</dt><dd>{display.technical.paymentIntentId ?? '—'}</dd>
            <dt>Code d’échec</dt><dd>{display.technical.lastFailureCode ?? '—'}</dd>
            <dt>Revenu produit</dt><dd>{display.technical.transactionId ?? '—'}</dd>
            <dt>Monde</dt><dd>{display.technical.environment ?? '—'}</dd>
            <dt>Ouvert le</dt><dd>{quand(incident.firstFailedAt)}</dd>
            <dt>Issue</dt><dd>{incident.resolution ?? '—'}</dd>
          </dl>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  LE BLOC                                                                   */
/* -------------------------------------------------------------------------- */

export function PaymentDefaultPanel({ projectId }: { projectId: string }) {
  const [vue, setVue] = useState<PaymentDefaultsView | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [historique, setHistorique] = useState(false);

  const recharger = useCallback(async () => {
    try {
      setVue(await finances.paymentDefaults(projectId));
      setErreur(null);
    } catch (e) {
      setErreur(errorMessage(e, 'Les impayés n’ont pas pu être lus.'));
      setVue(null);
    }
  }, [projectId]);

  useEffect(() => { void recharger(); }, [recharger]);

  /* ── CHARGEMENT ───────────────────────────────────────────────────────── */
  if (!vue && !erreur) {
    return (
      <Card>
        <div className="card-head"><h2>Impayés d’abonnement</h2></div>
        <p className="muted">Chargement…</p>
      </Card>
    );
  }

  /* ── ERREUR — et surtout PAS « aucun impayé » ──────────────────────────── */
  if (erreur) {
    return (
      <Card>
        <div className="card-head"><h2>Impayés d’abonnement</h2></div>
        {/*
          UNE LECTURE QUI ÉCHOUE N'EST PAS UNE ABSENCE D'IMPAYÉ. Afficher
          « aucun impayé » ici rassurerait à tort sur un client peut-être
          suspendu.
        */}
        <p className="alert alert-danger">{erreur}</p>
      </Card>
    );
  }

  const items = vue?.items ?? [];
  const actif = vue?.active ?? null;
  const passes = items.filter((i) => i.incident.paymentDefaultId !== actif?.incident.paymentDefaultId);

  return (
    <Card>
      <div className="card-head">
        <div>
          <h2>Impayés d’abonnement</h2>
          <p className="muted">
            {actif
              ? 'Un incident est en cours sur l’abonnement de ce client.'
              : 'Aucun impayé en cours sur l’abonnement de ce client.'}
          </p>
        </div>
      </div>

      {/*
        ══ L'INCIDENT N'ENTRE DANS AUCUN TOTAL ═══════════════════════════════

        Ce bloc est SÉPARÉ du livret, et c'est le point : une facture impayée
        n'est ni un revenu ni une transaction. Le bénéfice du mois ne doit pas
        bouger parce qu'une carte a été refusée.
      */}
      {items.length === 0 ? (
        <EmptyState
          title="Aucun défaut de paiement"
          hint="Les prélèvements d’abonnement de ce client ont tous abouti."
        />
      ) : (
        <>
          {actif ? <IncidentCard entry={actif} onRetried={() => { void recharger(); }} /> : null}

          {/*
            ══ L'HISTORIQUE RESTE CONSULTABLE ═══════════════════════════════

            Un incident résolu ne disparaît pas : il explique une suspension
            passée, et deux incidents du même contrat restent DEUX incidents.
            Ils ne sont jamais fusionnés par `contractId` — l'identité est
            celle du `PaymentDefault`.
          */}
          {passes.length > 0 ? (
            <div className="finance-default-history">
              <button
                type="button"
                className="btn btn-small"
                aria-expanded={historique}
                onClick={() => setHistorique((v) => !v)}
              >
                {historique
                  ? 'Masquer l’historique'
                  : `Historique (${passes.length} incident${passes.length > 1 ? 's' : ''})`}
              </button>
              {historique ? (
                <div className="finance-default-list">
                  {passes.map((entry) => (
                    <IncidentCard key={entry.incident.paymentDefaultId} entry={entry} onRetried={() => { void recharger(); }} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

export default PaymentDefaultPanel;
