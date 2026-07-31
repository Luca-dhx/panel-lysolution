// FICHE D'UNE DESTINATION — Phase 4.
//
// Le parcours complet, dans l'ordre où il doit être suivi :
//   Tester la connexion → Vérifier les prérequis → Simuler → Déployer
//
// Chaque bouton demande le mot de passe SSH. Ce n'est pas une négligence
// d'ergonomie : le Panel n'en conserve aucun, nulle part. Le saisir à chaque
// fois est le prix de ne jamais l'avoir en base.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { deployment as api, errorMessage } from '@/lib/api';
import type { ReleaseList, TargetDetail } from '@/types.deployment';
import { RunBadge, StateBadge, operationLabel } from '@/pages/DeploymentPage';

export function DeploymentTargetPage() {
  const { targetId = '' } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState<TargetDetail | null>(null);
  const [password, setPassword] = useState('');
  const [confirmProd, setConfirmProd] = useState(false);
  const [releases, setReleases] = useState<ReleaseList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.target(targetId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Destination introuvable.'));
    }
  }, [targetId]);

  useEffect(() => { void load(); }, [load]);

  if (error && !data) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
        <p><Link to="/deployment">← Déploiement</Link></p>
      </div>
    );
  }
  if (!data) return <div className="page"><p className="muted">Chargement…</p></div>;

  const t = data.target;
  const locked = Boolean(data.activeRun);

  /** Lance une opération et emmène l'opérateur sur son suivi. */
  const start = async (label: string, fn: () => Promise<{ runId: string; notice: string | null }>) => {
    if (!password) {
      setError('Mot de passe SSH requis : le Panel n’en conserve aucun, il est demandé à chaque opération.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const started = await fn();
      // Le mot de passe quitte le navigateur dès qu'il a servi.
      setPassword('');
      if (started.notice) setNotice(started.notice);
      navigate(`/deployment/runs/${started.runId}`);
    } catch (err) {
      setError(errorMessage(err, `${label} : opération refusée.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <p className="breadcrumb"><Link to="/deployment">← Déploiement</Link></p>

      <header className="page-head">
        <h1>{t.name}</h1>
        <div className="execution-head">
          <span className={`badge badge-${t.environment === 'PROD' ? 'danger' : 'neutral'}`}>{t.environment}</span>
          <StateBadge state={t.state} />
          {t.selfHosted ? <span className="badge badge-warn">auto-hébergé</span> : null}
        </div>
        <p className="target-url"><code>{t.url}</code></p>
      </header>

      {t.selfHosted ? (
        <p className="mode-notice mode-execution">
          <strong>Cette destination héberge le Panel que vous utilisez.</strong> Un
          déploiement y redémarrera ce backend : l’interface deviendra
          brièvement injoignable. L’opération se poursuit dans un processus
          séparé — elle ne sera ni interrompue ni perdue.
        </p>
      ) : null}

      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-success">{notice}</div> : null}

      {data.activeRun ? (
        <div className="alert alert-warning">
          Une opération est en cours ({operationLabel(data.activeRun.operationType)}).{' '}
          <Link to={`/deployment/runs/${data.activeRun.runId}`}>Suivre son avancement →</Link>
        </div>
      ) : null}

      {/* — Configuration ————————————————————————————————— */}
      <Card title="Configuration">
        <DetailList
          items={[
            ['Hôte déduit', <code key="h">{t.host}</code>],
            ['Type', t.type === 'subdomain' ? 'sous-domaine' : 'domaine'],
            ['Base wildcard', t.wildcardBase
              ? <><code>*.{t.wildcardBase}</code> — certificat existant réutilisé</>
              : <span className="muted">aucune — un certificat dédié sera émis</span>],
            ['Serveur', `${t.sshUser}@${t.sshHost}:${t.sshPort}`],
            ['Port local du backend', t.backendPort],
            ['Racine distante', <code key="r">{t.remoteRoot}</code>],
            ['Base MongoDB', t.dbName ?? <span className="muted">non renseignée</span>],
            ['Let’s Encrypt', t.certbotEmail ?? <span className="muted">non renseigné</span>],
            ['Version en ligne', t.currentVersion ?? <span className="muted">aucune</span>],
            ['Dernier déploiement', t.lastDeployedAt ?? <span className="muted">jamais</span>],
          ]}
        />
        <Disclosure title={`Variables exigées sur le serveur (${t.requiredRemoteEnv.length})`}>
          <ul className="env-list">
            {t.requiredRemoteEnv.map((name) => <li key={name}><code>{name}</code></li>)}
          </ul>
          <p className="muted read-only-note">
            Le moteur relit le <code>.env</code> qu’il vient d’écrire et refuse
            de démarrer le service s’il en manque une. Elles sont construites à
            partir du <code>.env</code> local de ce Panel.
          </p>
        </Disclosure>
      </Card>

      {/* — Le parcours ————————————————————————————————— */}
      <Card title="Opérations">
        <p className="muted">
          Dans l’ordre : tester la connexion, vérifier les prérequis, simuler,
          puis déployer. Chaque étape est indépendante et peut être relancée.
        </p>

        <label className="field">
          <span className="field-label">Mot de passe SSH</span>
          <input
            type="password"
            value={password}
            autoComplete="off"
            placeholder="demandé à chaque opération"
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="field-hint muted">
            Jamais enregistré, ni en base, ni dans ce navigateur. Il n’existe
            qu’en mémoire, le temps de l’opération.
          </span>
        </label>

        <div className="action-buttons">
          <button type="button" className="btn" disabled={busy || locked}
            onClick={() => start('Test de connexion', () => api.testConnection(targetId, password))}>
            1 · Tester la connexion
          </button>
          <button type="button" className="btn" disabled={busy || locked}
            onClick={() => start('Prérequis', () => api.preflight(targetId, password))}>
            2 · Vérifier les prérequis
          </button>
          <button type="button" className="btn" disabled={busy || locked}
            onClick={() => start('Simulation', () => api.simulate(targetId, password))}>
            3 · Simuler
          </button>
        </div>

        <hr className="separator" />

        {t.environment === 'PROD' ? (
          <label className="key-option confirm-prod">
            <input type="checkbox" checked={confirmProd} onChange={(e) => setConfirmProd(e.target.checked)} />
            Je confirme déployer en <strong>PRODUCTION</strong> sur {t.host}
          </label>
        ) : null}

        <div className="action-buttons">
          <button
            type="button" className="btn btn-danger"
            disabled={busy || locked || (t.environment === 'PROD' && !confirmProd)}
            onClick={() => start('Déploiement', () => api.deploy(targetId, password, confirmProd))}
          >
            4 · Déployer réellement
          </button>
        </div>
        {locked ? (
          <p className="muted">Les opérations sont suspendues tant qu’une exécution est en cours.</p>
        ) : null}
      </Card>

      {/* — Releases et retour arrière ————————————————————— */}
      <Card title="Releases">
        <div className="action-buttons">
          <button
            type="button" className="btn btn-small" disabled={busy || !password}
            onClick={() => {
              setBusy(true);
              setError(null);
              api.releases(targetId, password)
                .then(setReleases)
                .catch((err) => setError(errorMessage(err, 'Lecture des releases impossible.')))
                .finally(() => setBusy(false));
            }}
          >
            Lire les releases sur le serveur
          </button>
          {!password ? <span className="muted">Saisissez le mot de passe SSH ci-dessus.</span> : null}
        </div>

        {releases ? (
          releases.releases.length === 0 ? (
            <p className="muted">Aucune release sur ce serveur : rien n’y a encore été déployé.</p>
          ) : (
            <ul className="release-list">
              {releases.releases.map((release) => (
                <li key={release}>
                  <code className="release-id">{release}</code>
                  {release === releases.current ? (
                    <span className="badge badge-ok">active</span>
                  ) : (
                    <button
                      type="button" className="btn btn-small" disabled={busy || locked}
                      onClick={() => start('Retour arrière', () => api.rollback(targetId, password, release))}
                    >
                      Revenir à cette release
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}

        <p className="muted read-only-note">
          Le retour arrière vérifie l’intégrité de la release cible AVANT de
          basculer, puis contrôle la santé du service. En cas d’échec, il
          restaure automatiquement la release précédente.
        </p>
      </Card>

      {/* — Historique ——————————————————————————————————— */}
      <Disclosure title={`Exécutions (${data.runs.length})`} defaultOpen={data.runs.length > 0}>
        {data.runs.length === 0 ? (
          <p className="muted">Aucune exécution sur cette destination.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Opération</th><th>État</th><th>Version</th><th>Démarrée</th><th>Par</th><th /></tr>
              </thead>
              <tbody>
                {data.runs.map((row) => (
                  <tr key={row.runId}>
                    <td>{operationLabel(row.operationType)}</td>
                    <td><RunBadge status={row.status} /></td>
                    <td>{row.version ?? <span className="muted">—</span>}</td>
                    <td className="muted">{row.startedAt.slice(0, 16).replace('T', ' ')}</td>
                    <td className="muted">{row.user ?? '—'}</td>
                    <td><Link to={`/deployment/runs/${row.runId}`}>Détail →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Disclosure>
    </div>
  );
}
