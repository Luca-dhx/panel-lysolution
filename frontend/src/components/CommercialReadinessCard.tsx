// OUVERTURE COMMERCIALE — l'écran du geste (lot L3.1).
//
// ── DEUX BADGES, JAMAIS FUSIONNÉS ───────────────────────────────────────────
//
//   Environnement technique : PRODUCTION
//   Ouverture commerciale   : PRÉ-OUVERTURE
//
// Les fondre en un seul (« PROD », « TEST ») rendrait invisible la distinction
// que tout le chantier a servi à établir. Une instance de production non
// ouverte n'est PAS une recette : ses données sont réelles, son environnement
// est réel, et seules les opérations qui engagent un tiers lui sont refusées.
//
// ── LE VOCABULAIRE COMPTE ───────────────────────────────────────────────────
//
// On n'écrit JAMAIS « Passer en PROD » : l'environnement ne se choisit pas
// (lot L2), et suggérer le contraire ressusciterait la doctrine révoquée. Le
// bouton dit ce qu'il fait vraiment — ouvrir le commerce.
import { useCallback, useState } from 'react';

import { Card } from '@/components/ui';
import { integratedApis, errorMessage } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { CommercialReadinessView } from '@/types.integratedApi';

const ENVIRONNEMENT_LABEL: Record<string, string> = {
  TEST: 'RECETTE',
  PROD: 'PRODUCTION',
};

/**
 * Même cadence que les fiches de projet (`useProjects`). Ce n'est PAS une
 * synchronisation métier — l'état vit dans la base du Panel, et cette lecture
 * ne franchit aucune frontière : c'est le même écran qui redemande à sa propre
 * API. Elle existe pour qu'un SECOND DEV, page ouverte pendant qu'un premier
 * ouvre l'instance, ne reste pas devant une valeur périmée.
 */
const REFRESH_MS = 7000;

/** Deux vues identiques ne doivent pas provoquer de rendu. */
function reconcile(previous: CommercialReadinessView, next: CommercialReadinessView) {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export function CommercialReadinessCard({ projectId, canEdit }: {
  projectId: string;
  /** Seul un DEV décide. Un ADMIN constate — et c'est déjà utile. */
  canEdit: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<'OPEN' | 'CLOSE' | null>(null);
  const [motif, setMotif] = useState('');

  const fetcher = useCallback(
    () => integratedApis.commercialReadiness(projectId),
    [projectId],
  );
  const { data: vue, error: erreurLecture, reload } = useLiveQuery(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Ouverture commerciale indisponible.',
    key: projectId,
    reconcile,
  });

  const appliquer = async (state: 'PREOPENING' | 'LIVE') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await integratedApis.setCommercialReadiness(projectId, state, motif || undefined);
      // On RELIT plutôt que d'afficher la réponse : la vue rendue par le PUT et
      // celle rendue par le GET doivent être la même chose, et c'est la lecture
      // vivante qui fait autorité à l'écran. Les faire diverger ferait afficher
      // un état que personne ne pourrait plus retrouver en rechargeant.
      await reload();
      setNotice(state === 'LIVE'
        ? 'Instance ouverte : les opérations commerciales réelles autorisées sont désormais possibles.'
        : 'Retour en pré-ouverture : les opérations financières et de signature sont de nouveau refusées.');
      setConfirmation(null);
      setMotif('');
    } catch (err) {
      setError(errorMessage(err, 'Changement refusé.'));
    } finally {
      setBusy(false);
    }
  };

  if (!vue) {
    return (
      <Card title="Ouverture commerciale">
        {erreurLecture
          ? <div className="alert alert-error">{erreurLecture}</div>
          : <p className="muted">Lecture…</p>}
      </Card>
    );
  }

  const ouverte = vue.state === 'LIVE';

  return (
    <Card title="Ouverture commerciale">
      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-success">{notice}</div> : null}

      <dl className="detail-list">
        <div>
          <dt>Environnement technique</dt>
          <dd><strong>{ENVIRONNEMENT_LABEL[vue.environment ?? ''] ?? '— non connu —'}</strong></dd>
        </div>
        <div>
          <dt>Ouverture commerciale</dt>
          <dd>
            <span className={`badge badge-${ouverte ? 'ok' : 'warn'}`}>
              {ouverte ? 'Ouverte' : 'Pré-ouverture'}
            </span>
            {vue.neverDecided ? (
              // « Personne n'a tranché » et « quelqu'un a choisi la
              // pré-ouverture » se lisent pareil, et ne se réparent pas pareil.
              <span className="muted"> — jamais décidée, le défaut fermé s’applique</span>
            ) : null}
          </dd>
        </div>
        {vue.decidedAt ? (
          <div>
            <dt>Dernière décision</dt>
            <dd>
              {new Date(vue.decidedAt).toLocaleString('fr-FR')}
              {vue.decisionReason ? <> — « {vue.decisionReason} »</> : null}
            </dd>
          </div>
        ) : null}
      </dl>

      {!ouverte ? (
        <>
          <p className="muted read-only-note">
            En pré-ouverture, {vue.blockedInPreopening.length} capacité(s) sont
            refusées — celles qui engagent quelqu’un d’autre que nous :{' '}
            {vue.blockedInPreopening.map((b) => b.capability).join(', ')}.
            Tout le reste (déploiement, configuration, e-mails, lectures)
            fonctionne normalement.
          </p>

          <ul className="credential-list">
            {vue.checks.map((c) => (
              <li key={c.code}>
                <span className="credential-name">{c.label}</span>
                <span className={c.passed ? 'badge badge-ok' : 'badge badge-warn'}>
                  {c.passed ? 'ok' : 'manquant'}
                </span>
                {c.detail ? <span className="muted">{c.detail}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {canEdit ? (
        <div className="action-buttons">
          {confirmation === null ? (
            ouverte ? (
              <button type="button" className="btn btn-small" disabled={busy}
                onClick={() => setConfirmation('CLOSE')}>
                Repasser en pré-ouverture
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy || !vue.readyToGoLive}
                title={vue.readyToGoLive ? undefined : 'Des prérequis manquent — voir la liste ci-dessus.'}
                onClick={() => setConfirmation('OPEN')}>
                Ouvrir commercialement
              </button>
            )
          ) : (
            <div className="parameter-form">
              {/*
                LA CONFIRMATION ÉNUMÈRE LES EFFETS PROUVÉS, ELLE NE LES RÉSUME PAS.

                « Les opérations commerciales réelles » ne dit rien à qui doit
                décider : ni lesquelles, ni ce qui reste intact. La liste des
                capacités vient du SERVEUR (`blockedInPreopening`), qui la dérive
                de la table des effets — l'écran ne peut donc pas se désynchroniser
                de la politique qu'il annonce, et l'ajout d'un verbe financier
                apparaît ici sans qu'on y touche.
              */}
              <div className={`mode-notice ${confirmation === 'OPEN' ? 'mode-reel' : 'mode-simulation'}`}>
                {confirmation === 'OPEN' ? (
                  <>
                    <p>
                      <strong>Cette action autorisera</strong> cette instance à exécuter,
                      en{' '}
                      <strong>{ENVIRONNEMENT_LABEL[vue.environment ?? ''] ?? 'son environnement'}</strong>,
                      les {vue.blockedInPreopening.length} capacité(s) aujourd’hui refusées :
                    </p>
                    <ul className="credential-list">
                      {vue.blockedInPreopening.map((b) => (
                        <li key={b.capability}>
                          <span className="credential-name">{b.capability}</span>
                          <span className="muted">{b.effect}</span>
                        </li>
                      ))}
                    </ul>
                    <p>
                      <strong>Elle ne modifiera pas</strong> l’environnement technique,
                      les identifiants fournisseurs, le contrat, l’état du site ni sa
                      suspension, les planificateurs, ni le déploiement. Elle ne déclenche
                      aucun paiement, aucun envoi et aucune signature : elle lève une
                      interdiction, elle n’agit pas.
                    </p>
                    <p>
                      <strong>Prérequis vérifiés</strong> :{' '}
                      {vue.checks.map((c) => c.label).join(' · ')}.
                    </p>
                    <p className="muted">
                      Réversible : « Repasser en pré-ouverture » referme sans condition.
                      Les opérations exécutées entre-temps, elles, ne sont pas annulées.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      <strong>Cette action refusera de nouveau</strong> les{' '}
                      {vue.blockedInPreopening.length} capacité(s) financières et de
                      signature, dès la prochaine demande.
                    </p>
                    <p>
                      <strong>Elle ne modifiera pas</strong> l’environnement technique, le
                      contrat, l’état du site, ni les abonnements en cours — refermer
                      n’est pas résilier.
                    </p>
                    <p className="muted">
                      <strong>Partiellement irréversible</strong> : les opérations déjà
                      exécutées (paiements encaissés, signatures demandées) restent
                      acquises et ne sont pas annulées.
                    </p>
                  </>
                )}
              </div>
              <label className="field">
                <span className="field-label">Motif (facultatif, conservé dans la chronologie)</span>
                <input type="text" value={motif} maxLength={200}
                  placeholder={confirmation === 'OPEN' ? 'ex. recette validée par le client' : 'ex. incident de facturation'}
                  onChange={(e) => setMotif(e.target.value)} />
              </label>
              <div className="action-buttons">
                <button type="button" className="btn btn-small" disabled={busy}
                  onClick={() => { setConfirmation(null); setMotif(''); }}>
                  Annuler
                </button>
                <button type="button" className="btn" disabled={busy}
                  onClick={() => appliquer(confirmation === 'OPEN' ? 'LIVE' : 'PREOPENING')}>
                  {confirmation === 'OPEN' ? 'Confirmer l’ouverture' : 'Confirmer le retour'}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="muted read-only-note">
          Seul un compte DEV peut ouvrir ou refermer une instance.
        </p>
      )}
    </Card>
  );
}

export default CommercialReadinessCard;
