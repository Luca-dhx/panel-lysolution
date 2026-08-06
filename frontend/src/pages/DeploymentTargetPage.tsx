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
import type {
  DeploymentTarget, DestinationInspection, ReleaseList, TargetDetail,
} from '@/types.deployment';
import { LifecycleBadge, RunBadge, StateBadge, operationLabel } from '@/pages/DeploymentPage';

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
  const [removing, setRemoving] = useState<'deprovision' | 'delete' | null>(null);

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
          <LifecycleBadge status={t.lifecycleStatus} />
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

      {/* — ÉTAT DU CYCLE DE VIE ————————————————————————
          Ce que la destination occupe encore sur le serveur. C'est cet état,
          et non le résultat du dernier déploiement, qui décide de ce qui est
          permis : une destination en place ne se supprime pas. */}
      {t.lifecycleStatus === 'EMPTY' ? (
        <p className="mode-notice">
          <strong>Cette destination est vidée.</strong> Son service est arrêté, son
          port {t.port} est libéré, ses fichiers sont supprimés, et{' '}
          <code>{t.host}</code> répond <code>410 Gone</code> plutôt que de retomber
          sur un autre site du serveur. Sa fiche — historique compris — peut
          maintenant être supprimée, ou la destination redéployée.
          {t.emptiedAt ? ` Vidée le ${t.emptiedAt.slice(0, 16).replace('T', ' ')}.` : ''}
        </p>
      ) : null}

      {t.lifecycleStatus === 'DEPROVISIONING' ? (
        <div className="alert alert-warning">
          <strong>Retrait en cours.</strong> Aucun déploiement n’est possible tant
          qu’il n’est pas terminé. Si le processus a été interrompu, relancez le
          retrait : chaque étape est sans effet quand elle a déjà été faite.
        </div>
      ) : null}

      {t.lifecycleStatus === 'DEPROVISION_FAILED' ? (
        <div className="alert alert-error">
          <strong>Le retrait s’est interrompu</strong>
          {t.lastError?.step ? ` à l’étape « ${t.lastError.step} »` : ''}
          {t.lastError?.message ? ` : ${t.lastError.message}` : '.'}
          {' '}La destination est toujours connue du Panel, et rien n’a été supprimé
          de sa fiche. Corrigez la cause, puis relancez le retrait.
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
            disabled={busy || locked || !t.canDeploy || (t.environment === 'PROD' && !confirmProd)}
            onClick={() => start('Déploiement', () => api.deploy(targetId, password, confirmProd))}
          >
            {t.lifecycleStatus === 'EMPTY' ? 'Redéployer' : 'Déployer'}
          </button>
        </div>
        {locked ? (
          <p className="muted">Un déploiement est déjà en cours sur cette destination.</p>
        ) : null}
        {!t.canDeploy && !locked ? (
          <p className="muted">
            Déploiement indisponible : la destination est {t.lifecycleLabel}.
          </p>
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

      {/* — RETRAIT ET SUPPRESSION ——————————————————————————
          Deux actions, dans cet ordre, et jamais l'une sans l'autre.

          Supprimer la fiche d'une destination encore en ligne laissait sur le
          serveur son service PM2 — qui détenait toujours son port —, sa
          configuration Nginx et ses fichiers. Plus aucune fiche ne disait
          qu'il restait quelque chose à nettoyer, et l'allocation de port
          recyclait un numéro déjà pris. On vide d'abord, on supprime ensuite. */}
      <Card title="Retirer cette destination">
        <p className="muted">
          Le retrait est l’opération inverse du déploiement : il arrête et
          supprime le service, libère le port, retire le routage, installe une
          quarantaine <code>410 Gone</code> sur le domaine, supprime les
          fichiers, puis vérifie qu’il ne reste rien. La fiche, elle, subsiste :
          elle passe à l’état <em>vidée</em>.
        </p>

        <div className="action-buttons">
          <button
            type="button" className="btn btn-danger"
            disabled={busy || locked || !t.canDeprovision}
            onClick={() => { setError(null); setNotice(null); setRemoving('deprovision'); }}
          >
            {t.lifecycleStatus === 'DEPROVISION_FAILED' || t.lifecycleStatus === 'DEPROVISIONING'
              ? 'Reprendre le retrait'
              : 'Retirer le déploiement'}
          </button>

          {/* Visible en permanence — mais actif UNIQUEMENT sur une destination
              vidée. Le cacher laisserait croire que la suppression n'existe
              pas ; l'activer trop tôt referait exactement le défaut corrigé. */}
          <button
            type="button" className="btn btn-danger"
            disabled={busy || locked || !t.canDelete}
            title={t.canDelete
              ? 'Supprime la fiche ; historique et audit conservés.'
              : 'Disponible seulement une fois la destination vidée.'}
            onClick={() => { setError(null); setNotice(null); setRemoving('delete'); }}
          >
            Supprimer la destination
          </button>
        </div>

        {!t.canDelete ? (
          <p className="muted read-only-note">
            « Supprimer la destination » ne devient possible qu’à l’état
            <strong> vidée</strong>. Tant que des fichiers, un service ou un
            routage subsistent sur le serveur, supprimer la fiche ferait perdre
            la seule trace de ce qu’il reste à nettoyer — et le port resterait
            détenu par un process que plus rien ne désigne.
          </p>
        ) : null}
      </Card>

      {removing ? (
        <RemovalDialog
          mode={removing}
          target={t}
          onCancel={() => setRemoving(null)}
          onDone={(message, runId) => {
            setRemoving(null);
            if (runId) { navigate(`/deployment/runs/${runId}`); return; }
            setNotice(message);
            void load();
          }}
        />
      ) : null}

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

/* -------------------------------------------------------------------------- */
/*  FENÊTRE DE CONFIRMATION DU RETRAIT                                        */
/* -------------------------------------------------------------------------- */

/**
 * ── POURQUOI UNE FENÊTRE DÉDIÉE, ET NON UN `confirm()` ──────────────────────
 *
 * Un `confirm()` du navigateur pose une question sans montrer de réponse : il
 * ne peut afficher ni le port, ni le service, ni la taille, ni le nombre de
 * médias qui vont disparaître. On ne fait pas confirmer une destruction sans
 * montrer ce qui sera détruit — sinon l'opérateur ne confirme pas un retrait,
 * il valide une phrase.
 *
 * Le déroulé est donc en deux temps :
 *   1. mot de passe SSH → INVENTAIRE réel lu sur le serveur ;
 *   2. saisie EXACTE du nom d'hôte → exécution.
 *
 * La saisie du nom d'hôte n'est pas une friction décorative : c'est le seul
 * contrôle qui distingue « je veux retirer CETTE destination » de « j'ai
 * cliqué sur la mauvaise ligne ». Une case à cocher ne fait pas cette
 * distinction.
 */
function RemovalDialog({ mode, target, onCancel, onDone }: {
  mode: 'deprovision' | 'delete';
  target: DeploymentTarget;
  onCancel: () => void;
  onDone: (message: string, runId?: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [hostname, setHostname] = useState('');
  const [dropData, setDropData] = useState(false);
  const [inspection, setInspection] = useState<DestinationInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inv = inspection?.inventory ?? null;
  const hostOk = hostname.trim().toLowerCase() === target.host.toLowerCase();
  // La suppression d'une destination vidée SANS quarantaine ne touche pas au
  // serveur : elle n'a donc pas besoin d'un mot de passe.
  const sshNeeded = mode === 'deprovision' || target.quarantineEnabled;

  const inspecter = async () => {
    setBusy(true);
    setError(null);
    try {
      setInspection(await api.inspectTarget(target.targetId, password));
    } catch (err) {
      setError(errorMessage(err, 'Inventaire impossible : le serveur n’a pas répondu.'));
    } finally {
      setBusy(false);
    }
  };

  const executer = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'deprovision') {
        const started = await api.deprovision(target.targetId, password, hostname.trim(), dropData);
        setPassword('');
        onDone('Retrait lancé.', started.runId);
        return;
      }
      const result = await api.destroyTarget(
        target.targetId, hostname.trim(), sshNeeded ? password : undefined,
      );
      setPassword('');
      const runId = (result as { runId?: string }).runId;
      onDone(`Destination « ${target.name} » supprimée. Son historique reste consultable.`, runId);
    } catch (err) {
      setError(errorMessage(err, 'Opération refusée.'));
    } finally {
      setBusy(false);
    }
  };

  const titre = mode === 'deprovision'
    ? 'Retirer le déploiement'
    : 'Supprimer définitivement la destination';

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={titre}>
      <div className="modal modal-danger">
        <header className="modal-head">
          <h2>{titre}</h2>
          <p className="muted"><code>{target.url}</code></p>
        </header>

        {error ? <div className="alert alert-error">{error}</div> : null}

        {/* — CE QUI SERA TOUCHÉ ———————————————————————— */}
        <DetailList
          items={[
            ['Nom d’hôte', <code key="h">{target.host}</code>],
            ['Environnement', target.environment],
            ['Serveur', `${target.sshUser}@${target.sshHost}`],
            ['Port applicatif', String(target.port)],
            ['Service PM2', <code key="p">{inv?.pm2Name ?? `panel-${target.host}`}</code>],
            ['Dossier', <code key="r">{inv?.siteRoot ?? `${target.remoteRoot}/${target.host}`}</code>],
            ['Taille', inv ? (inv.size ?? '—') : <span className="muted">à lire sur le serveur</span>],
            ['Fichiers', inv ? String(inv.files) : <span className="muted">à lire sur le serveur</span>],
            ['Médias (shared/uploads)', inv ? String(inv.uploads) : <span className="muted">à lire</span>],
            ['Stockage (shared/storage)', inv ? String(inv.storage) : <span className="muted">à lire</span>],
          ]}
        />

        {mode === 'deprovision' ? (
          <p className="mode-notice mode-execution">
            <strong>Cette opération est irréversible.</strong> Le service sera
            arrêté et supprimé, le port {target.port} libéré, le routage retiré,
            les fichiers effacés. Le domaine <code>{target.host}</code> répondra
            ensuite <code>410 Gone</code>. L’historique de la destination, lui,
            est conservé.
          </p>
        ) : (
          <p className="mode-notice mode-execution">
            <strong>Cette opération est irréversible.</strong> La fiche sortira
            des destinations actives{target.quarantineEnabled
              ? ` et la quarantaine 410 sera levée : ${target.host} ne sera plus servi du tout par ce serveur`
              : ''}. Son historique et son audit restent consultables.
          </p>
        )}

        {inv && inv.outboundSymlinks.length > 0 ? (
          <div className="alert alert-error">
            <strong>Retrait bloqué :</strong> {inv.outboundSymlinks.length} lien(s)
            symbolique(s) pointent hors de la destination
            (<code>{inv.outboundSymlinks.join(', ')}</code>). Les suivre effacerait
            des fichiers d’un autre projet. Corrigez-les d’abord.
          </div>
        ) : null}

        {inv && inv.persistentFiles > 0 ? (
          <label className="key-option">
            <input type="checkbox" checked={dropData} onChange={(e) => setDropData(e.target.checked)} />
            Je confirme la perte de <strong>{inv.persistentFiles} fichier(s)</strong> de
            données persistantes (médias et documents). Sans cette confirmation,
            le retrait est refusé.
          </label>
        ) : null}

        {/* — MOT DE PASSE ————————————————————————————— */}
        {sshNeeded ? (
          <label className="field">
            <span className="field-label">Mot de passe SSH du serveur</span>
            <input
              type="password" value={password} autoComplete="off"
              placeholder="demandé à chaque opération"
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="field-hint muted">
              Jamais enregistré. Il sert ici à lire l’inventaire, puis à exécuter
              l’opération.
            </span>
          </label>
        ) : null}

        {sshNeeded && !inspection ? (
          <div className="action-buttons">
            <button type="button" className="btn" disabled={busy || !password} onClick={() => void inspecter()}>
              Lire l’état réel du serveur
            </button>
            <button type="button" className="btn btn-small" onClick={onCancel}>Annuler</button>
          </div>
        ) : (
          <>
            {/* — CONFIRMATION PAR LE NOM D'HÔTE ——————————— */}
            <label className="field">
              <span className="field-label">
                Saisissez <code>{target.host}</code> pour confirmer
              </span>
              <input
                type="text" value={hostname} autoComplete="off" spellCheck={false}
                placeholder={target.host}
                onChange={(e) => setHostname(e.target.value)}
              />
            </label>

            <div className="action-buttons">
              <button
                type="button" className="btn btn-danger"
                disabled={
                  busy
                  || !hostOk
                  || (sshNeeded && !password)
                  || (mode === 'deprovision' && (inv?.outboundSymlinks.length ?? 0) > 0)
                  || (mode === 'deprovision' && (inv?.persistentFiles ?? 0) > 0 && !dropData)
                }
                onClick={() => void executer()}
              >
                {mode === 'deprovision' ? 'Retirer le déploiement' : 'Supprimer la destination'}
              </button>
              <button type="button" className="btn btn-small" onClick={onCancel}>Annuler</button>
            </div>
          </>
        )}

        <p className="muted read-only-note">
          L’avancement s’affiche étape par étape : arrêt du service, libération
          du port, retrait du routage, quarantaine, suppression, vérification.
        </p>
      </div>
    </div>
  );
}
