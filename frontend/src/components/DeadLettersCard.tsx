// ÉCRITURES EN ÉCHEC — la supervision, puis le geste.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Rejeu d'une lettre morte ».
//
// ── CE QUE CET ÉCRAN CORRIGE ────────────────────────────────────────────────
//
// Le rejeu existait, testé, déployé — et n'était atteignable que par un appel
// HTTP à la main. Un mécanisme de réparation qu'aucun opérateur ne peut
// déclencher n'est pas une réparation : c'est une capacité théorique.
//
// ── DEUX AUTORITÉS, CÔTE À CÔTE, JAMAIS FUSIONNÉES ──────────────────────────
//
// La LETTRE MORTE appartient au projet : lui seul sait ce qu'il n'a pas su
// appliquer, et on la lit chez lui, vivante. Le REJEU appartient au Panel :
// c'est notre décision, avec sa causalité. L'écran les met face à face parce
// que l'opérateur pose une seule question — « qu'est-ce qui bloque, et qu'a-t-on
// déjà tenté ? » — mais chaque ligne dit de qui elle tient son information.
//
// ── CE QUI N'APPARAÎT JAMAIS ICI ────────────────────────────────────────────
//
// La charge utile. Le projet n'en conserve aucune dans ses lettres mortes, et
// cet écran ne pourrait donc pas l'afficher — mais la règle vaut d'abord par
// intention : une écriture garée nomme souvent un client, et un écran de
// diagnostic n'est pas un endroit où déverser des données personnelles.
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { Modale } from '@/components/Modale';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type {
  DeadLetterReplayView,
  ProjectDeadLetterView,
  ProjectDeadLettersRead,
} from '@/types';

/** Le refus que le serveur oppose à un second rejeu encore en vol. */
const DEJA_EN_VOL = 'PANEL_REPLAY_ALREADY_IN_FLIGHT';

/**
 * L'état d'un rejeu, traduit une seule fois.
 *
 * `STALLED` n'est pas une couleur d'alerte de plus : c'est le seul état qui
 * appelle une DÉCISION. Republié se regarde, acquitté se classe, enlisé se
 * tranche — et c'est un humain qui tranche, jamais une boucle.
 */
const ETAT_REJEU: Record<
  DeadLetterReplayView['status'],
  { libelle: string; classe: string; aide: string }
> = {
  REPUBLISHED: {
    libelle: 'En vol',
    classe: 'badge badge-warn',
    aide: 'Republié au journal ; le projet ne l’a pas encore consommé.',
  },
  ACKNOWLEDGED: {
    libelle: 'Acquitté',
    classe: 'badge badge-ok',
    aide: 'Le curseur du projet a dépassé cette écriture : elle est arrivée.',
  },
  STALLED: {
    libelle: 'Enlisé',
    classe: 'badge badge-danger',
    aide: 'Republié, jamais consommé, et cela dure. Rien n’est rejoué automatiquement.',
  },
};

/**
 * ÉCRITURES EN ÉCHEC — carte de supervision de l'onglet développeur.
 *
 * Elle vit dans la fiche projet, avec le reste de la supervision. Une page
 * isolée aurait obligé à savoir qu'un incident existe pour aller le chercher —
 * or c'est exactement ce qu'on ne sait pas d'avance.
 */
export function DeadLettersCard({ projectId }: { projectId: string }) {
  const [lecture, setLecture] = useState<ProjectDeadLettersRead | null>(null);
  const [chargement, setChargement] = useState(true);
  /** L'écriture dont on a ouvert le détail. Une seule à la fois. */
  const [ouverte, setOuverte] = useState<string | null>(null);
  /** L'écriture pour laquelle on demande confirmation. */
  const [aConfirmer, setAConfirmer] = useState<ProjectDeadLetterView | null>(null);
  /** L'écriture dont le rejeu est EN COURS d'envoi. Verrou du double clic. */
  const [enCours, setEnCours] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ton: 'ok' | 'info' | 'error'; texte: string } | null>(null);

  const lire = useCallback(async () => {
    setChargement(true);
    try {
      setLecture(await api.getProjectDeadLetters(projectId));
    } catch (err) {
      /**
       * Le SERVICE du Panel ne lève pas : une indisponibilité du projet est un
       * résultat qu'il rend. Arriver ici veut dire que le PANEL n'a pas
       * répondu — on le dit dans le même vocabulaire, sans inventer un
       * troisième état, et sans notification volante : le défaut appartient à
       * cette carte, il doit rester lisible tant qu'elle est à l'écran.
       */
      setLecture({
        available: false,
        deadLetters: [],
        active: 0,
        resolved: 0,
        readAt: null,
        reason: 'PANEL_UNREACHABLE',
        message: errorMessage(err, 'Écritures garées temporairement indisponibles.'),
        replays: [],
      });
    } finally {
      setChargement(false);
    }
  }, [projectId]);

  useEffect(() => { void lire(); }, [lire]);

  const rejeuxDe = (writeId: string | null) =>
    (lecture?.replays ?? [])
      .filter((r) => r.replayOfWriteId === writeId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

  /** Un rejeu est EN VOL tant qu'il n'est ni acquitté ni déclaré enlisé. */
  const enVol = (writeId: string | null) =>
    rejeuxDe(writeId).some((r) => r.status === 'REPUBLISHED');

  const rejouer = async (lettre: ProjectDeadLetterView) => {
    if (!lettre.writeId) return;
    setAConfirmer(null);
    setEnCours(lettre.writeId);
    setMessage(null);
    try {
      const rejeu = await api.replayProjectDeadLetter(projectId, lettre.writeId);
      setMessage({
        ton: 'ok',
        texte: `Rejeu n° ${rejeu.attempt} republié (séquence ${rejeu.newSeq}). `
          + 'Il passera « acquitté » dès que le projet l’aura consommé.',
      });
    } catch (err) {
      /**
       * ── UN REFUS N'EST PAS UNE PANNE ──────────────────────────────────────
       *
       * `ALREADY_IN_FLIGHT` veut dire que le geste a DÉJÀ abouti — deuxième
       * clic, deuxième onglet, ou index qui tranche entre deux requêtes
       * simultanées. Le peindre en rouge apprendrait à l'opérateur que le
       * système casse alors qu'il vient précisément de le protéger.
       */
      const dejaFait = err instanceof ApiError && err.code === DEJA_EN_VOL;
      setMessage({
        ton: dejaFait ? 'info' : 'error',
        texte: dejaFait
          ? 'Un rejeu de cette écriture est déjà en vol : rien n’a été republié une seconde fois.'
          : errorMessage(err, 'Le rejeu n’a pas pu être demandé.'),
      });
    } finally {
      setEnCours(null);
      /** On relit dans TOUS les cas : c'est le serveur qui dit l'état réel. */
      await lire();
    }
  };

  const actives = lecture?.active ?? 0;
  const enlises = (lecture?.replays ?? []).filter((r) => r.status === 'STALLED').length;

  return (
    <Card title="Écritures en échec">
      {chargement && !lecture ? <p className="muted">Lecture en cours…</p> : null}

      {lecture && !lecture.available ? (
        <div className="alert alert-error">
          <p><strong>{lecture.message}</strong></p>
          <p className="muted">
            Ces écritures sont lues en direct dans le projet : rien de périmé n’est
            affiché à la place.
          </p>
          <p>
            <button type="button" className="btn btn-small" onClick={() => void lire()}>
              Réessayer
            </button>
          </p>
        </div>
      ) : null}

      {lecture?.available ? (
        <>
          {/*
            ── LE RÉSUMÉ NE COMPTE QUE CE QUI BLOQUE ENCORE ────────────────────
            Une lettre morte RÉSOLUE est close : le fait a fini par être
            appliqué. La compter dans l'alerte entretiendrait un voyant rouge
            pour un incident terminé, et un voyant qu'on apprend à ignorer ne
            sert plus à rien.
          */}
          <p className="badge-list">
            <span className={actives > 0 ? 'badge badge-danger' : 'badge badge-ok'}>
              {actives > 0 ? `${actives} écriture(s) en échec` : 'Aucune écriture en échec'}
            </span>
            {lecture.resolved > 0 ? (
              <span className="badge badge-muted">{lecture.resolved} résolue(s)</span>
            ) : null}
            {enlises > 0 ? (
              <span className="badge badge-warn">{enlises} rejeu(x) enlisé(s)</span>
            ) : null}
          </p>

          {message ? (
            <div
              className={
                message.ton === 'error' ? 'alert alert-error'
                  : message.ton === 'ok' ? 'alert alert-success' : 'alert alert-info'
              }
            >
              {message.texte}
            </div>
          ) : null}

          {lecture.deadLetters.length === 0 ? (
            <p className="muted">
              Ce projet n’a garé aucune écriture : tout ce que le Panel lui a envoyé
              a été appliqué.
            </p>
          ) : (
            <ul className="team-list">
              {lecture.deadLetters.map((lettre) => {
                const rejeux = rejeuxDe(lettre.writeId);
                const vol = enVol(lettre.writeId);
                const occupe = enCours === lettre.writeId;
                const detailOuvert = ouverte === lettre.writeId;
                return (
                  <li key={lettre.writeId ?? Math.random()} className="team-row dead-letter-row">
                    <span className="team-row-main">
                      <span className="team-row-name">
                        {lettre.entityType ?? 'Écriture'}
                        {lettre.entityId ? <span className="muted"> · {lettre.entityId}</span> : null}
                      </span>
                      <span className="muted">{lettre.reason || 'Motif non transmis.'}</span>
                    </span>

                    {/*
                      GARÉE ET RÉSOLUE NE SE RÉPARENT PAS PAREIL — la première
                      attend une décision, la seconde n'attend plus rien.
                    */}
                    <span className={lettre.status === 'PARKED' ? 'badge badge-danger' : 'badge badge-muted'}>
                      {lettre.status === 'PARKED' ? 'Garée' : 'Résolue'}
                    </span>
                    <span className="badge badge-neutral">{lettre.attempts} tentative(s)</span>
                    {rejeux.length > 0 ? (
                      <span className={ETAT_REJEU[rejeux[0].status].classe}>
                        Rejeu {rejeux[0].attempt} · {ETAT_REJEU[rejeux[0].status].libelle}
                      </span>
                    ) : null}

                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      aria-expanded={detailOuvert}
                      onClick={() => setOuverte(detailOuvert ? null : lettre.writeId)}
                    >
                      {detailOuvert ? 'Masquer' : 'Détail'}
                    </button>

                    {/*
                      ── LE BOUTON DIT CE QU'IL FAIT, ET REFUSE AVANT DE PARTIR ──
                      Désactivé pendant l'envoi ET tant qu'un rejeu est en vol :
                      un double clic ne produit donc pas deux requêtes. Le
                      serveur tient la même règle par un index — les deux
                      existent parce qu'aucune des deux ne couvre l'autre.
                    */}
                    {lettre.status === 'PARKED' ? (
                      <button
                        type="button"
                        className="btn btn-small btn-primary"
                        disabled={occupe || vol || !lettre.writeId}
                        title={vol ? 'Un rejeu de cette écriture est déjà en vol.' : undefined}
                        onClick={() => setAConfirmer(lettre)}
                      >
                        {occupe ? 'Rejeu…' : rejeux.length > 0 ? 'Rejouer à nouveau' : 'Rejouer'}
                      </button>
                    ) : null}

                    {detailOuvert ? (
                      <div className="dead-letter-detail">
                        <dl className="detail-list">
                          <dt>Écriture</dt>
                          <dd><code className="inline-code">{lettre.writeId}</code></dd>
                          <dt>Garée le</dt>
                          <dd>{lettre.parkedAt ? formatDateTime(lettre.parkedAt) : '—'}</dd>
                          <dt>Motif</dt>
                          <dd>{lettre.reason || '—'}</dd>
                          {lettre.status === 'RESOLVED' ? (
                            <>
                              <dt>Résolue le</dt>
                              <dd>{lettre.resolvedAt ? formatDateTime(lettre.resolvedAt) : '—'}</dd>
                              <dt>Par l’écriture</dt>
                              <dd><code className="inline-code">{lettre.resolvedByWriteId ?? '—'}</code></dd>
                            </>
                          ) : null}
                        </dl>

                        {/*
                          ── L'HISTORIQUE EST COMPLET, ET DANS CET ORDRE ─────────
                          Un rejeu enlisé suivi d'un rejeu acquitté raconte une
                          histoire que la seule dernière ligne effacerait : on a
                          essayé, ça n'est pas passé, on a recommencé. Remplacer
                          la première trace par la seconde ferait disparaître
                          l'incident au moment même où il est réparé.
                        */}
                        {rejeux.length === 0 ? (
                          <p className="muted">Aucun rejeu demandé pour cette écriture.</p>
                        ) : (
                          <ul className="alert-list">
                            {rejeux.map((r) => (
                              <li key={r.replayId}>
                                <span className={ETAT_REJEU[r.status].classe}>
                                  {ETAT_REJEU[r.status].libelle}
                                </span>
                                {' '}Rejeu n° {r.attempt} · demandé le {formatDateTime(r.requestedAt)}
                                {r.requestedBy ? <span className="muted"> par {r.requestedBy}</span> : null}
                                {' '}· séquence {r.newSeq}
                                {r.acknowledgedAt ? (
                                  <span className="muted"> · acquitté le {formatDateTime(r.acknowledgedAt)}</span>
                                ) : null}
                                {r.stalledAt ? (
                                  <span className="muted"> · enlisement constaté le {formatDateTime(r.stalledAt)}</span>
                                ) : null}
                                <br />
                                <span className="muted">{ETAT_REJEU[r.status].aide}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="muted">
            {lecture.readAt ? `Lu dans le projet le ${formatDateTime(lecture.readAt)}. ` : null}
            Un rejeu republie le même fait par le pipeline normal ; il ne rembobine
            aucun curseur et ne contourne aucun applicateur.
          </p>
        </>
      ) : null}

      {aConfirmer ? (
        <Modale titre="Rejouer une écriture garée" onClose={() => setAConfirmer(null)}>
          <p className="modal-text">
            Le Panel va republier <strong>{aConfirmer.entityType ?? 'cette écriture'}</strong>
            {aConfirmer.entityId ? <> (<strong>{aConfirmer.entityId}</strong>)</> : null} vers ce
            projet, sous une nouvelle identité technique.
          </p>
          {/*
            CE QUE LE REJEU NE FAIT PAS — énuméré, parce qu'un opérateur qui
            hésite hésite sur les effets de bord.
          */}
          <ul className="modal-list">
            <li>Le fait métier republié est le MÊME : rien n’est réécrit.</li>
            <li>Le curseur du projet n’est pas rembobiné.</li>
            <li>Les applicateurs normaux s’appliquent, avec leur idempotence.</li>
            <li>
              La lettre morte ne sera close que si le projet l’applique vraiment —
              jamais parce qu’on a cliqué.
            </li>
          </ul>
          {aConfirmer.attempts > 1 ? (
            <div className="alert alert-warning">
              Cette écriture a déjà échoué {aConfirmer.attempts} fois. Si le rejeu échoue
              encore, c’est un défaut à corriger, pas un incident passager.
            </div>
          ) : null}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setAConfirmer(null)}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={enCours !== null}
              onClick={() => void rejouer(aConfirmer)}
            >
              Rejouer
            </button>
          </div>
        </Modale>
      ) : null}
    </Card>
  );
}

export default DeadLettersCard;
