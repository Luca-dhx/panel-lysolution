// DÉPLOIEMENT — les destinations. Phase 4.
//
// C'est l'écran d'entrée du parcours :
//   Déploiement → Destinations → Ajouter → Tester → Simuler → Déployer
//
// Le Panel se déploie lui-même, par le même moteur que SB Auto 06. Cet écran
// n'exécute rien : il crée des destinations et lance des opérations qui
// s'exécutent dans un processus séparé.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { DetailList, Disclosure, Metric } from '@/components/supervision';
import { deployment as api, errorMessage } from '@/lib/api';
import type { DeploymentOverview, DeploymentTarget, PanelSelfInfo } from '@/types.deployment';

export function DeploymentPage() {
  const [data, setData] = useState<DeploymentOverview | null>(null);
  const [self, setSelf] = useState<PanelSelfInfo | null>(null);
  const [editing, setEditing] = useState<DeploymentTarget | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [overview, selfInfo] = await Promise.all([api.overview(), api.self()]);
      setData(overview);
      setSelf(selfInfo);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Déploiement indisponible.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error && !data) return <div className="page"><div className="alert alert-error">{error}</div></div>;
  if (!data || !self) return <div className="page"><p className="muted">Chargement…</p></div>;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Déploiement</h1>
        <p className="muted">
          Mettre ce Panel en ligne, par le moteur de déploiement standard —
          le même que celui des projets vitrines.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-success">{notice}</div> : null}

      <div className="metric-row">
        <Metric value={data.summary.total} label="destinations" />
        <Metric value={data.summary.deployed} label="déployées" tone="ok" />
        <Metric value={data.summary.failed} label="en échec" tone={data.summary.failed > 0 ? 'danger' : undefined} />
        <Metric value={data.summary.deploying} label="en cours" tone={data.summary.deploying > 0 ? 'warn' : undefined} />
      </div>

      {/* — Ce que le Panel sait de lui-même ————————————————— */}
      <Disclosure title="Ce Panel" hint={`${self.environment} · ${self.apps.length} composants`}>
        <DetailList
          items={[
            ['Environnement', self.environment],
            ['URL publique connue', self.publicUrl ?? <span className="muted">non configurée</span>],
            ['Source de cette URL', self.publicUrlSource],
            ['Identifiant de projet', <code key="id">{self.projectId}</code>],
            ['Composants déployés', self.apps.map((a) => `${a.id} (${a.role})`).join(' · ')],
            ['Bases wildcard gérées', self.wildcardBases.join(', ') || <span className="muted">aucune</span>],
            ['Racine distante par défaut', <code key="root">{self.defaultRemoteRoot}</code>],
          ]}
        />
        <p className="muted read-only-note">
          Le frontend est servi en statique à la racine du domaine ; le backend
          tourne sous PM2 derrière nginx. Le Panel n’a aucun sous-domaine
          Manager, contrairement à un projet vitrine.
        </p>
      </Disclosure>

      {/* — Destinations ————————————————————————————————— */}
      <Card title={`Destinations${data.targets.length ? ` (${data.targets.length})` : ''}`}>
        {data.targets.length === 0 ? (
          <EmptyState
            title="Aucune destination"
            hint="Ajoutez le serveur sur lequel ce Panel doit être mis en ligne."
          />
        ) : (
          <ul className="target-list">
            {data.targets.map((target) => (
              <li key={target.targetId}>
                <div className="target-head">
                  <Link to={`/deployment/${target.targetId}`} className="target-name">{target.name}</Link>
                  <span className={`badge badge-${target.environment === 'PROD' ? 'danger' : 'neutral'}`}>
                    {target.environment}
                  </span>
                  <StateBadge state={target.state} />
                  {target.selfHosted ? (
                    <span className="badge badge-warn" title="Cette destination héberge le Panel que vous utilisez">
                      auto-hébergé
                    </span>
                  ) : null}
                </div>
                <p className="target-url"><code>{target.url}</code></p>
                <p className="muted target-meta">
                  {target.sshUser}@{target.sshHost}:{target.sshPort} · port backend {target.backendPort}
                  {target.currentVersion ? ` · version ${target.currentVersion}` : ''}
                  {target.lastDeployedAt ? ` · déployée le ${target.lastDeployedAt.slice(0, 16).replace('T', ' ')}` : ''}
                </p>
                <div className="action-buttons">
                  <Link to={`/deployment/${target.targetId}`} className="btn btn-small">Ouvrir</Link>
                  <button type="button" className="btn btn-small" onClick={() => setEditing(target)}>Modifier</button>
                  <button
                    type="button" className="btn btn-small"
                    onClick={() => {
                      setError(null);
                      api.deleteTarget(target.targetId)
                        .then(() => { setNotice(`Destination « ${target.name} » supprimée.`); return load(); })
                        .catch((err) => setError(errorMessage(err, 'Suppression refusée.')));
                    }}
                  >
                    Supprimer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="action-buttons">
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            Ajouter une destination
          </button>
        </div>
      </Card>

      {editing ? (
        <TargetForm
          target={editing === 'new' ? null : editing}
          defaults={self}
          onCancel={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); setNotice(message); void load(); }}
          onError={setError}
        />
      ) : null}

      {/* — Exécutions récentes ————————————————————————— */}
      {data.recentRuns.length > 0 ? (
        <Card title="Exécutions récentes">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Destination</th><th>Opération</th><th>État</th>
                  <th>Version</th><th>Démarrée</th><th>Par</th><th />
                </tr>
              </thead>
              <tbody>
                {data.recentRuns.map((row) => (
                  <tr key={row.runId}>
                    <td>{row.targetName}</td>
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
        </Card>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Formulaire de destination.
 *
 * Il ne demande PAS l'hôte, le type ni le domaine : le moteur les déduit de
 * l'URL. Deux champs qui peuvent se contredire sont deux champs de trop.
 */
function TargetForm({ target, defaults, onCancel, onSaved, onError }: {
  target: DeploymentTarget | null;
  defaults: PanelSelfInfo;
  onCancel: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({
    name: target?.name ?? '',
    url: target?.url ?? '',
    environment: target?.environment ?? 'TEST',
    sshHost: target?.sshHost ?? '',
    sshUser: target?.sshUser ?? 'root',
    sshPort: String(target?.sshPort ?? 22),
    backendPort: String(target?.backendPort ?? 4100),
    remoteRoot: target?.remoteRoot ?? defaults.defaultRemoteRoot,
    dbName: target?.dbName ?? '',
    certbotEmail: target?.certbotEmail ?? '',
  });
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) => setForm({ ...form, [key]: value });

  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        sshPort: Number(form.sshPort),
        backendPort: Number(form.backendPort),
      } as unknown as Partial<DeploymentTarget>;
      if (target) {
        await api.updateTarget(target.targetId, body);
        onSaved(`Destination « ${form.name} » modifiée.`);
      } else {
        await api.createTarget(body);
        onSaved(`Destination « ${form.name} » créée. Testez la connexion avant de déployer.`);
      }
    } catch (err) {
      onError(errorMessage(err, 'Enregistrement refusé.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={target ? `Modifier « ${target.name} »` : 'Nouvelle destination'}>
      <div className="parameter-form">
        <label className="field">
          <span className="field-label">Nom</span>
          <input type="text" value={form.name} placeholder="Recette" onChange={(e) => set('name', e.target.value)} />
          <span className="field-hint muted">Pour vous repérer — n’a aucun effet technique.</span>
        </label>

        <label className="field">
          <span className="field-label">URL complète</span>
          <input type="text" value={form.url} placeholder="https://panel-test.exemple.com" onChange={(e) => set('url', e.target.value)} />
          <span className="field-hint muted">
            C’est la SEULE saisie de domaine. Le moteur en déduit l’hôte, le
            type et la base wildcard.
          </span>
        </label>

        <label className="field">
          <span className="field-label">Environnement</span>
          <select value={form.environment} onChange={(e) => set('environment', e.target.value)}>
            <option value="TEST">TEST</option>
            <option value="PROD">PROD</option>
          </select>
          <span className="field-hint muted">
            Décide de la base écrite dans le .env distant : DB_TEST ou DB_PROD.
          </span>
        </label>

        <label className="field">
          <span className="field-label">Serveur (IP ou nom)</span>
          <input type="text" value={form.sshHost} placeholder="203.0.113.10" onChange={(e) => set('sshHost', e.target.value)} />
        </label>

        <label className="field">
          <span className="field-label">Utilisateur SSH</span>
          <input type="text" value={form.sshUser} onChange={(e) => set('sshUser', e.target.value)} />
          <span className="field-hint muted">Doit pouvoir exécuter sudo sans mot de passe interactif.</span>
        </label>

        <label className="field">
          <span className="field-label">Port SSH</span>
          <input type="text" value={form.sshPort} onChange={(e) => set('sshPort', e.target.value)} />
        </label>

        <label className="field">
          <span className="field-label">Port local du backend</span>
          <input type="text" value={form.backendPort} onChange={(e) => set('backendPort', e.target.value)} />
          <span className="field-hint muted">
            Port d’écoute derrière nginx. Deux destinations sur un même serveur
            doivent en avoir deux différents.
          </span>
        </label>

        <label className="field">
          <span className="field-label">Racine des déploiements</span>
          <input type="text" value={form.remoteRoot} onChange={(e) => set('remoteRoot', e.target.value)} />
        </label>

        <label className="field">
          <span className="field-label">Base MongoDB (facultatif)</span>
          <input type="text" value={form.dbName} onChange={(e) => set('dbName', e.target.value)} />
          <span className="field-hint muted">Pour les sauvegardes et le diagnostic.</span>
        </label>

        <label className="field">
          <span className="field-label">E-mail Let’s Encrypt</span>
          <input type="text" value={form.certbotEmail} onChange={(e) => set('certbotEmail', e.target.value)} />
          <span className="field-hint muted">Contact d’expiration du certificat.</span>
        </label>
      </div>

      <p className="mode-notice mode-simulation">
        Le mot de passe SSH n’est <strong>pas</strong> demandé ici, et n’est
        jamais enregistré. Il vous sera demandé à chaque opération, et n’existe
        qu’en mémoire le temps de celle-ci.
      </p>

      <div className="action-buttons">
        <button type="button" className="btn" disabled={busy || !form.name || !form.url || !form.sshHost} onClick={() => void submit()}>
          {target ? 'Enregistrer' : 'Créer la destination'}
        </button>
        <button type="button" className="btn btn-small" onClick={onCancel}>Annuler</button>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

export function StateBadge({ state }: { state: string }) {
  const def: Record<string, { label: string; tone: string }> = {
    NEW: { label: 'Jamais déployée', tone: 'muted' },
    DEPLOYING: { label: 'Déploiement en cours', tone: 'warn' },
    DEPLOYED: { label: 'Déployée', tone: 'ok' },
    FAILED: { label: 'En échec', tone: 'danger' },
  };
  const d = def[state] ?? { label: state, tone: 'neutral' };
  return <span className={`badge badge-${d.tone}`}>{d.label}</span>;
}

export function RunBadge({ status }: { status: string }) {
  const def: Record<string, { label: string; tone: string }> = {
    running: { label: 'En cours', tone: 'warn' },
    ok: { label: 'Réussie', tone: 'ok' },
    warning: { label: 'Avec réserves', tone: 'warn' },
    error: { label: 'Échouée', tone: 'danger' },
    interrupted: { label: 'Interrompue', tone: 'danger' },
  };
  const d = def[status] ?? { label: status, tone: 'neutral' };
  return <span className={`badge badge-${d.tone}`}>{d.label}</span>;
}

export function operationLabel(type: string): string {
  return {
    CONNECTION_TEST: 'Test de connexion',
    PRECHECK: 'Vérification des prérequis',
    SIMULATION: 'Simulation',
    DEPLOYMENT: 'Déploiement',
    ROLLBACK: 'Retour arrière',
  }[type] ?? type;
}
