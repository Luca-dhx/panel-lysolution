// SUIVI D'UN DÉPLOIEMENT — Phase 4.
//
// L'écran que l'opérateur regarde pendant que ça se passe, puis relit après.
// Trois choses, dans cet ordre : où on en est, ce qui a été fait, le rapport.
//
// ── UN FLUX REPRENABLE, NI SONDAGE NI FLUX « À LA SB AUTO » ─────────────────
// SB Auto 06 diffuse ses étapes en NDJSON depuis la requête qui EXÉCUTE le
// déploiement. Transposé tel quel ici, ce serait faux : le Panel peut se
// déployer LUI-MÊME, et ce flux mourrait au moment précis où PM2 redémarre son
// backend — juste avant le contrôle de santé, l'étape qu'on attend le plus.
//
// L'exécution vit donc dans un processus DÉTACHÉ qui écrit, au fil de l'eau, un
// JOURNAL NUMÉROTÉ (`events[]`, `seq` monotone). Cet écran consomme ce journal
// en flux continu et, à la coupure, se reconnecte avec le dernier `seq` traité.
// La reprise est exacte : aucune perte, aucun doublon, aucun réordonnancement.
//
// On obtient donc l'expérience de SB Auto — progression immédiate, aucun délai,
// aucun sondage — AVEC la tolérance au redémarrage qu'exige l'auto-déploiement.
// Le sondage toutes les 2 s a disparu.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { deployment as api, errorMessage } from '@/lib/api';
import type { DeploymentRun, DeployStreamEvent, RunStep } from '@/types.deployment';
import { RunBadge, operationLabel } from '@/pages/DeploymentPage';
import { RunDiagnostics } from '@/components/deployment/RunDiagnostics';

/**
 * Délai avant de retenter le flux après une coupure.
 *
 * Ce n'est PAS un sondage : le flux est continu, cette valeur ne sert qu'après
 * une rupture — typiquement le redémarrage du backend quand le Panel se déploie
 * lui-même. On reprend alors au dernier `seq` traité, sans perte ni doublon.
 */
const RECONNECT_MS = 800;

/**
 * RECULS successifs entre deux tentatives, en millisecondes.
 *
 * Un délai fixe martèle le serveur pendant tout son redémarrage, et n'apprend
 * rien de son silence. On s'écarte progressivement, puis on plafonne : la
 * reconnexion reste rapide quand la coupure est brève — le cas normal — sans
 * transformer une panne durable en tempête de requêtes.
 */
const RECULS = [RECONNECT_MS, 1200, 2000, 3000, 5000, 8000];

/**
 * Au-delà de ce nombre de tentatives infructueuses, on cesse de dire « ça va
 * revenir ». Ce n'est plus vrai, et une interface qui rassure à tort empêche
 * précisément d'aller voir ce qui se passe.
 */
const TENTATIVES_AVANT_AVEU = RECULS.length;

const STEP_MARKS: Record<string, string> = {
  pending: '·', running: '⟳', ok: '✓', warning: '!', error: '✗', skipped: '–',
};
const stepMark = (status: string) => STEP_MARKS[status] ?? '·';

export function DeploymentRunPage() {
  const { runId = '' } = useParams();
  const [run, setRun] = useState<DeploymentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Une coupure momentanée n'est PAS une erreur quand le Panel se déploie
  // lui-même : c'est le symptôme attendu. On la distingue d'un vrai échec.
  const [unreachable, setUnreachable] = useState(false);
  // Combien de tentatives de reconnexion ont échoué d'affilée. Zéro dès qu'une
  // seule réussit : c'est la SUITE d'échecs qui est significative, pas leur total.
  const [echecsSuccessifs, setEchecsSuccessifs] = useState(0);
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const currentRef = useRef<HTMLLIElement | null>(null);
  // Curseur de reprise : dernier `seq` réellement appliqué à l'état.
  const lastSeqRef = useRef<number>(0);

  const load = useCallback(async () => {
    try {
      const data = await api.run(runId);
      setRun(data);
      setUnreachable(false);
      setError(null);
      return data;
    } catch (err) {
      const message = errorMessage(err, '');
      if (/introuvable|inconnue/i.test(message)) setError(message);
      else setUnreachable(true);
      return null;
    }
  }, [runId]);

  /**
   * SUIVI TEMPS RÉEL — un flux, jamais un sondage.
   *
   * On charge l'état complet UNE fois (la checklist canonique est déjà posée à
   * la création du run : toutes les lignes existent, aucune n'apparaîtra), puis
   * on n'applique plus que des deltas. Une étape qui change ne provoque la mise
   * à jour que de SA ligne : pas de remplacement de tableau, donc pas de
   * réordonnancement, pas de ligne recréée, pas de repaint global.
   *
   * À la coupure — le backend redémarre sous nos pieds en auto-déploiement — on
   * se reconnecte avec le dernier `seq` traité. Le journal côté serveur étant
   * persistant et numéroté, la reprise est exacte.
   */
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let retry: number | undefined;
    let echecs = 0;

    const applyEvent = (evt: DeployStreamEvent) => {
      if (evt.kind === 'step') {
        lastSeqRef.current = evt.seq;
        setRun((prev) => {
          if (!prev) return prev;
          const i = prev.steps.findIndex((s) => s.id === evt.payload.id);
          if (i === -1) return prev; // ligne inconnue : on n'en crée jamais
          const before = prev.steps[i];
          const after = { ...before, ...evt.payload };
          // Rien n'a bougé → on rend la MÊME référence : React ne repeint pas.
          if (before.status === after.status && before.message === after.message) return prev;
          const steps = prev.steps.slice();
          steps[i] = after;
          return { ...prev, steps };
        });
      } else if (evt.kind === 'log') {
        lastSeqRef.current = evt.seq;
        setRun((prev) => (prev ? { ...prev, log: [...prev.log, evt.payload] } : prev));
      } else if (evt.kind === 'ping') {
        lastSeqRef.current = Math.max(lastSeqRef.current, evt.seq);
      }
    };

    const pump = async () => {
      while (!stopped) {
        try {
          for await (const evt of api.streamRun(runId, lastSeqRef.current, controller.signal)) {
            if (stopped) return;
            if (evt.kind === 'reload') {
              // Curseur trop ancien (journal borné) : on reprend une photo
              // complète, puis on repart du curseur QUE LE SERVEUR DONNE.
              // Y mettre une valeur arbitrairement grande figerait le suivi :
              // le serveur ne rend que les évènements STRICTEMENT postérieurs.
              await load();
              lastSeqRef.current = evt.lastSeq;
              break;
            }
            if (evt.kind === 'end') {
              // Le run est conclu : on relit une dernière fois pour récupérer
              // le rapport et le résumé, qui ne transitent pas par le flux.
              await load();
              return;
            }
            applyEvent(evt);
            setUnreachable(false);
            // Le compteur repart de zéro : c'est la SUITE d'échecs qui compte,
            // et un évènement reçu prouve que le backend est de nouveau là.
            echecs = 0;
            setEchecsSuccessifs(0);
          }
        } catch {
          if (stopped) return;
          // Coupure (backend en redémarrage) : ce n'est pas une erreur.
          setUnreachable(true);
          echecs += 1;
          setEchecsSuccessifs(echecs);
        }
        if (stopped) return;
        const recul = RECULS[Math.min(echecs, RECULS.length - 1)];
        await new Promise((r) => { retry = window.setTimeout(r, recul); });
      }
    };

    void (async () => {
      const first = await load();
      if (!first) { void pump(); return; }
      if (first.status !== 'running') return; // run terminé : rien à suivre
      void pump();
    })();

    return () => {
      stopped = true;
      controller.abort();
      if (retry) window.clearTimeout(retry);
    };
  }, [runId, load]);

  // L'étape en cours reste visible. La clé ne change QUE lorsque l'étape
  // courante change réellement — avec le flux, elle ne repasse plus par
  // `undefined` entre deux rafraîchissements, donc le scroll ne saute plus.
  const currentStepId = run?.steps.find((s) => s.status === 'running')?.id ?? null;
  useEffect(() => {
    if (!currentStepId) return;
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentStepId]);

  const copyReport = async () => {
    if (!run?.markdownReport) return;
    try {
      await navigator.clipboard.writeText(run.markdownReport);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Presse-papiers refusé (contexte non sécurisé) : le rapport reste
      // affiché et sélectionnable à la main.
      setError('Copie automatique refusée par le navigateur. Le rapport reste sélectionnable ci-dessous.');
    }
  };

  if (error && !run) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
        <p><Link to="/deployment">← Déploiement</Link></p>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <p className="muted">Chargement de l’exécution…</p>
        {unreachable ? (
          <p className="mode-notice mode-execution">
            {echecsSuccessifs >= TENTATIVES_AVANT_AVEU
              ? 'Le backend du Panel n’est pas revenu après plusieurs tentatives. '
                + 'L’opération, elle, se poursuit dans son processus séparé : ce run '
                + 'reste consultable dès que l’API répond de nouveau.'
              : 'Le backend du Panel ne répond pas. S’il s’agit d’un déploiement du '
                + 'Panel lui-même, c’est attendu : il redémarre. Cette page se '
                + 'reconnectera seule.'}
          </p>
        ) : null}
      </div>
    );
  }

  const running = run.status === 'running';
  const current = run.steps.find((s) => s.status === 'running') ?? null;

  return (
    <div className="page">
      <p className="breadcrumb">
        <Link to="/deployment">← Déploiement</Link>
        {' · '}
        <Link to={`/deployment/${run.targetId}`}>{run.targetName}</Link>
      </p>

      <header className="page-head">
        <h1>{operationLabel(run.operationType)}</h1>
        <div className="execution-head">
          <RunBadge status={run.status} />
          <span className={`badge badge-${run.environment === 'PROD' ? 'danger' : 'neutral'}`}>
            {run.environment}
          </span>
          {run.selfDeployment ? <span className="badge badge-warn">auto-déploiement</span> : null}
        </div>
      </header>

      {unreachable ? (
        <p className="mode-notice mode-execution">
          Le backend ne répond pas actuellement.{' '}
          {echecsSuccessifs >= TENTATIVES_AVANT_AVEU
            ? 'Il n’est pas revenu après plusieurs tentatives. Le déploiement se '
              + 'poursuit dans son processus détaché : cette page le retrouvera dès '
              + 'que l’API répondra.'
            : run.selfDeployment
              ? 'C’est attendu : ce déploiement redémarre le Panel. L’opération se poursuit dans son processus séparé.'
              : 'La page se reconnectera automatiquement.'}
        </p>
      ) : null}

      {run.selfDeployment && running ? (
        <p className="mode-notice mode-execution">
          <strong>Ce déploiement met à jour le Panel que vous utilisez.</strong>{' '}
          Son backend va redémarrer. Vous pouvez fermer cette page : l’opération
          continue, et son issue sera ici à votre retour.
        </p>
      ) : null}

      {/* — OÙ ON EN EST ————————————————————————————————— */}
      <Card title={running ? 'Déploiement en cours' : 'Résultat'}>
        <div className="deploy-progress">
          <div className="deploy-progress-bar" role="img"
            aria-label={`Avancement : ${run.progress.percent} %`}>
            <div
              className={`deploy-progress-fill deploy-fill-${run.status}`}
              style={{ width: `${Math.max(2, run.progress.percent)}%` }}
            />
          </div>
          <p className="deploy-progress-label">
            {running ? (
              <>
                <span className="deploy-spinner" aria-hidden>⟳</span>{' '}
                {current ? current.label : 'Préparation…'}
                <span className="muted"> — {run.progress.done}/{run.progress.total} étapes</span>
              </>
            ) : (
              <>{run.progress.done}/{run.progress.total} étapes · {run.progress.percent} %</>
            )}
          </p>
        </div>

        {!running ? (
          <>
            <p className={`mode-notice ${run.status === 'ok' ? 'mode-simulation' : 'mode-execution'}`}>
              {run.summary ?? 'Aucun résumé.'}
            </p>
            {run.status === 'ok' && run.deployedUrl ? (
              <p>
                <a href={run.deployedUrl} target="_blank" rel="noreferrer" className="btn">
                  Ouvrir {run.deployedUrl} ↗
                </a>
              </p>
            ) : null}
          </>
        ) : null}
      </Card>

      {/* — LA CHECKLIST ————————————————————————————————— */}
      <Card title={`Étapes (${run.steps.length})`}>
        <ol className="deploy-steps">
          {run.steps.map((step) => (
            <li
              key={step.id}
              ref={step.status === 'running' ? currentRef : null}
              className={`deploy-step deploy-${step.status}`}
            >
              <span className={`deploy-step-mark${step.status === 'running' ? ' deploy-spinner' : ''}`} aria-hidden>
                {stepMark(step.status)}
              </span>
              <span className="deploy-step-label">{step.label}</span>
              <span className="deploy-step-message">{step.message ?? ''}</span>
              <span className="deploy-step-duration muted">
                {step.durationMs !== null ? `${(step.durationMs / 1000).toFixed(1)} s` : ''}
              </span>
            </li>
          ))}
        </ol>
        <p className="muted read-only-note">
          Ces étapes sont celles du moteur de déploiement — les mêmes que pour
          un projet vitrine. Aucune n’est déclenchée à la main : le déploiement
          les enchaîne.
        </p>
      </Card>

      {/* — LE RAPPORT ————————————————————————————————— */}
      {run.markdownReport ? (
        <Card title="Rapport complet">
          <p className="muted">
            Identité, configuration déduite, checklist détaillée, journaux,
            validations finales et verdict. Les secrets y sont masqués : il
            peut être transmis tel quel.
          </p>
          <div className="action-buttons">
            <button type="button" className="btn" onClick={() => void copyReport()}>
              {copied ? 'Rapport copié ✓' : 'Copier le rapport complet'}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? 'Masquer le rapport' : 'Afficher le rapport'}
            </button>
          </div>
          {error ? <div className="alert alert-warning">{error}</div> : null}
          {showDetails ? (
            <pre className="deploy-report">{run.markdownReport}</pre>
          ) : null}
        </Card>
      ) : running ? null : (
        <Card title="Rapport complet">
          <p className="muted">
            Aucun rapport : cette opération n’en produit pas, ou s’est
            interrompue avant sa génération. Le journal ci-dessous reste
            disponible.
          </p>
        </Card>
      )}

      {/* — LE DÉTAIL, replié ——————————————————————————— */}
      <Disclosure title="Détails de l’exécution">
        <DetailList
          items={[
            ['Identifiant', <code key="id">{run.runId}</code>],
            ['Destination', run.targetName ?? '—'],
            ['URL', run.deployedUrl ?? run.url ?? '—'],
            ['Version', run.version ?? <span className="muted">—</span>],
            ['Release', run.releaseId ?? <span className="muted">—</span>],
            ['Démarrée', run.startedAt],
            ['Terminée', run.finishedAt ?? <span className="muted">en cours</span>],
            ['Durée', run.durationMs !== null ? `${Math.round(run.durationMs / 1000)} s` : <span className="muted">—</span>],
            ['Lancée par', run.user ?? '—'],
          ]}
        />
        {run.error ? (
          <>
            <div className="alert alert-error">{run.error.message}</div>
            <p className="muted">
              Code : <code>{run.error.code}</code>
              {run.error.step ? ` · étape « ${stepLabel(run.steps, run.error.step)} »` : ''}
            </p>
          </>
        ) : null}
      </Disclosure>

      <Disclosure title={`Journal technique (${run.log.length} lignes)`}>
        {run.log.length === 0 ? (
          <p className="muted">Aucune ligne de journal.</p>
        ) : (
          <div className="deploy-log">
            {run.log.map((entry, index) => (
              <div key={index} className={`log-${entry.level.toLowerCase()}`}>
                <time className="log-at">{entry.at.slice(11, 19)}</time>
                <span className="log-message">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
        <p className="muted read-only-note">
          Ce journal est écrit en base par le processus de déploiement, pas
          diffusé par une connexion ouverte : il survit au redémarrage du
          Panel et reste consultable des semaines plus tard.
        </p>
      </Disclosure>

      {/*
        DIAGNOSTIC TECHNIQUE — tout ce qui a été enregistré pendant l'opération.

        Le journal ci-dessus raconte l'opération en termes métier ; celui-ci
        donne les faits bruts — HTTP, SSH, PM2, sockets, finalisation — avec
        leur source et leur code. C'est lui qu'on ouvre quand le premier ne
        suffit pas à expliquer.
      */}
      <RunDiagnostics run={run} />
    </div>
  );
}

/** Libellé métier d'une étape à partir de son identifiant. */
function stepLabel(steps: RunStep[], id: string): string {
  return steps.find((s) => s.id === id)?.label ?? id;
}
