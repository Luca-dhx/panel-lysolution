// FICHE D'UNE DESTINATION — Phase 4.
//
// ── UNE INTENTION, PAS UN PARCOURS TECHNIQUE ────────────────────────────────
// L'opérateur clique sur « Déployer ». C'est tout. Le moteur enchaîne ensuite
// connexion, prérequis, sécurité de la destination, build, transfert, nginx,
// TLS, services, contrôle de santé et vérification publique.
//
// Une version antérieure exposait ces phases comme quatre boutons numérotés.
// C'était une erreur : la connexion et les prérequis ne sont pas des
// DÉCISIONS que l'opérateur prend, ce sont des ÉTAPES du déploiement. Les lui
// faire déclencher revenait à lui faire piloter le moteur à la main, et à
// transformer l'écran en panneau d'administration SSH.
//
// Les trois opérations de diagnostic subsistent, repliées : elles gardent une
// utilité propre — examiner un serveur sans rien engager — mais ne sont plus
// des préalables.
//
// Le mot de passe SSH est demandé à chaque opération. Ce n'est pas une
// négligence d'ergonomie : le Panel n'en conserve aucun, nulle part.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { deployment as api, errorMessage } from '@/lib/api';
import type { ReleaseList, TargetDetail } from '@/types.deployment';
import { RunBadge, StateBadge, operationLabel } from '@/pages/DeploymentPage';

/** Nombre d'étapes du moteur — annoncé à l'opérateur avant qu'il ne lance. */
const STEP_COUNT = 20;

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

      {/* — Ce que VOUS avez saisi ————————————————————————— */}
      <Card title="Votre destination">
        <DetailList
          items={[
            ['Nom', t.name],
            ['Adresse', <code key="u">{t.url}</code>],
            ['Environnement', t.environment],
            ['Serveur', `${t.sshUser}@${t.sshHost}`],
            ['Base de données', t.dbName ?? <span className="muted">déduite de l’environnement</span>],
            ['Version en ligne', t.currentVersion ?? <span className="muted">aucune</span>],
            ['Dernier déploiement', t.lastDeployedAt ?? <span className="muted">jamais</span>],
          ]}
        />
      </Card>

      {/* — Ce que le BACKEND a déduit ————————————————————
          Affiché en clair : l'opérateur n'a pas à saisir ces valeurs, mais il
          a le droit de les voir. Sans cela, la déduction ressemblerait à de
          la magie, et le jour où quelque chose cloche il n'aurait aucune
          prise sur le problème. */}
      <Disclosure
        title="Configuration déterminée automatiquement"
        hint={`${t.derived.length} valeurs`}
      >
        <ul className="derived-list">
          {t.derived.map((item) => (
            <li key={item.label}>
              <span className="derived-label">{item.label}</span>
              <code className="derived-value">{item.value}</code>
              <span className="derived-from muted">{item.from}</span>
            </li>
          ))}
        </ul>
        <p className="muted read-only-note">
          Ces valeurs viennent du profil de déploiement du Panel et des
          conventions du moteur — le même moteur que celui des projets
          vitrines. Elles ne sont pas saisissables : les modifier casserait la
          correspondance entre nginx, PM2 et les chemins sur le serveur.
        </p>

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
      </Disclosure>

      {/* — L'ACTION ————————————————————————————————————
          UNE seule. L'opérateur exprime une intention ; le moteur enchaîne
          connexion, prérequis, sécurité de la destination, build, transfert,
          nginx, TLS, services, contrôle de santé et vérification publique.
          Aucun bouton technique : ce ne sont pas des décisions à prendre,
          ce sont des étapes de CETTE opération. */}
      <Card title="Déployer">
        <p className="muted">
          Le déploiement enchaîne automatiquement les {STEP_COUNT} étapes du
          moteur — connexion, prérequis, transfert, configuration web, HTTPS,
          services et vérifications finales. Vous suivez son avancement en
          direct, et obtenez un rapport complet à la fin.
        </p>

        <label className="field">
          <span className="field-label">Mot de passe SSH du serveur</span>
          <input
            type="password"
            value={password}
            autoComplete="off"
            placeholder="demandé à chaque déploiement"
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="field-hint muted">
            Jamais enregistré, ni en base, ni dans ce navigateur. Il n’existe
            qu’en mémoire, le temps de l’opération.
          </span>
        </label>

        {t.environment === 'PROD' ? (
          <label className="key-option confirm-prod">
            <input type="checkbox" checked={confirmProd} onChange={(e) => setConfirmProd(e.target.checked)} />
            Je confirme déployer en <strong>PRODUCTION</strong> sur {t.host}
          </label>
        ) : null}

        <div className="action-buttons">
          <button
            type="button" className="btn btn-primary btn-deploy"
            disabled={busy || locked || (t.environment === 'PROD' && !confirmProd)}
            onClick={() => start('Déploiement', () => api.deploy(targetId, password, confirmProd))}
          >
            Déployer
          </button>
        </div>
        {locked ? (
          <p className="muted">Un déploiement est déjà en cours sur cette destination.</p>
        ) : null}
      </Card>

      {/* — OUTILS DE DIAGNOSTIC, hors parcours ————————————
          Ces trois opérations ne sont PLUS des étapes à déclencher : le
          déploiement les exécute lui-même. Elles gardent une utilité propre —
          examiner un serveur sans rien engager — d'où leur conservation, mais
          repliées et nommées comme ce qu'elles sont. */}
      <Disclosure title="Outils de diagnostic" hint="facultatif — le déploiement fait déjà tout cela">
        <p className="muted">
          À utiliser pour examiner un serveur <em>avant</em> de préparer un
          déploiement. Aucune de ces opérations ne modifie quoi que ce soit,
          et aucune n’est nécessaire : le déploiement les enchaîne lui-même.
        </p>
        <div className="action-buttons">
          <button type="button" className="btn btn-small" disabled={busy || locked || !password}
            onClick={() => start('Test de connexion', () => api.testConnection(targetId, password))}>
            Tester la connexion
          </button>
          <button type="button" className="btn btn-small" disabled={busy || locked || !password}
            onClick={() => start('Prérequis', () => api.preflight(targetId, password))}>
            Vérifier les prérequis
          </button>
          <button type="button" className="btn btn-small" disabled={busy || locked || !password}
            onClick={() => start('Simulation', () => api.simulate(targetId, password))}>
            Simuler
          </button>
        </div>
      </Disclosure>

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
