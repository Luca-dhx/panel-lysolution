// API INTÉGRÉES — Phase 4, LOT 4.
//
// Le Panel est le coffre des accès tiers de l'entreprise. Cet écran l'ouvre
// sans jamais montrer ce qu'il contient.
//
// ── CE QUE L'ÉCRAN NE PEUT PAS AFFICHER ─────────────────────────────────────
// Aucune valeur d'identifiant, jamais — l'API n'en renvoie pas. Ce qui est
// montré : le NOM des clés renseignées, et une EMPREINTE courte de chacune.
// L'empreinte suffit à répondre à la seule question utile sans lire le
// secret : « ai-je bien remplacé cette clé ? ».
//
// ── LE MODE SUIT LE PROJET ──────────────────────────────────────────────────
// Un projet en TEST reçoit les identifiants TEST, quoi qu'affiche cet écran.
// L'interface le rappelle à chaque autorisation, parce que c'est exactement
// la confusion qui met une clé de production dans un site de recette.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { ThemedFilter } from '@/components/ThemedSelect';
import { company as api, errorMessage } from '@/lib/api';
import { useProjects } from '@/lib/useProjects';
import type { IntegratedApi } from '@/types.company';

export function IntegratedApisPage() {
  const [apis, setApis] = useState<IntegratedApi[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { projects } = useProjects();

  const load = useCallback(async () => {
    try {
      setApis((await api.apis()).items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'API intégrées indisponibles.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Opération refusée.'));
    } finally {
      setBusy(false);
    }
  };

  const paired = projects.filter((p) => p.pairing?.status === 'PAIRED');

  return (
    <div className="page">
      <header className="page-head">
        <h1>API intégrées</h1>
        <p className="muted">
          Les accès aux services tiers de l’entreprise. Le Panel les détient ;
          les projets reçoivent uniquement ceux qui leur sont accordés.
        </p>
        <p><Link to="/company">← Entreprise</Link></p>
      </header>

      <p className="mode-notice mode-simulation">
        Les valeurs des identifiants ne sortent jamais de cette interface :
        l’API n’en renvoie pas. Seuls le nom des clés et une empreinte courte
        sont affichés.
      </p>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-success">{notice}</div> : null}

      <NewApiForm busy={busy} onCreate={(body) => run(async () => {
        await api.createApi(body);
        return `API « ${body.label} » créée. Renseignez ses identifiants, puis accordez-la à un projet.`;
      })} />

      {apis.length === 0 ? (
        <EmptyState
          title="Aucune API intégrée"
          hint="Créez-en une pour centraliser un accès tiers (paiement, e-mail, cartographie…)."
        />
      ) : (
        apis.map((item) => (
          <ApiCard
            key={item.apiId}
            api={item}
            projects={paired}
            busy={busy}
            run={run}
          />
        ))
      )}
    </div>
  );
}

function ApiCard({ api: item, projects, busy, run }: {
  api: IntegratedApi;
  projects: Array<{ projectId: string; projectName: string; runtime?: { environment?: string | null } }>;
  busy: boolean;
  run: (fn: () => Promise<string>) => Promise<void>;
}) {
  const [mode, setMode] = useState<'TEST' | 'PROD'>('TEST');
  const [values, setValues] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [grantProject, setGrantProject] = useState('');
  const [grantKeys, setGrantKeys] = useState<string[]>([]);

  const set = item.credentials[mode];
  const granted = new Set(item.grants.map((g) => g.projectId));
  const available = projects.filter((p) => !granted.has(p.projectId));

  return (
    <Card title={`${item.label} — ${item.provider}`}>
      <DetailList
        items={[
          ['Identifiant', <code>{item.key}</code>],
          ['Catégorie', item.category],
          ['Mode côté Panel', item.mode],
          ['Actif', item.enabled ? 'oui' : 'non'],
          ['TEST configuré', item.credentials.TEST.configured ? `${item.credentials.TEST.keys.length} clé(s)` : <span className="muted">non</span>],
          ['PROD configuré', item.credentials.PROD.configured ? `${item.credentials.PROD.keys.length} clé(s)` : <span className="muted">non</span>],
        ]}
      />

      {/* — Identifiants ————————————————————————————————— */}
      <Disclosure title="Identifiants">
        <div className="filter-row">
          <ThemedFilter
            label="Mode"
            value={mode}
            onChange={(v) => { setMode(v as 'TEST' | 'PROD'); setValues({}); }}
            options={[
              { value: 'TEST', label: 'TEST' },
              { value: 'PROD', label: 'PROD' },
            ]}
          />
        </div>

        {set.keys.length === 0 ? (
          <p className="muted">Aucune clé renseignée pour le mode {mode}.</p>
        ) : (
          <ul className="credential-list">
            {set.keys.map((name) => (
              <li key={name}>
                <span className="credential-name">{name}</span>
                <code className="credential-fingerprint">{set.fingerprints[name]}</code>
                <input
                  type="password"
                  placeholder="laisser vide pour conserver"
                  value={values[name] ?? ''}
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                />
                <button
                  type="button" className="btn btn-small" disabled={busy}
                  onClick={() => run(async () => {
                    await api.setCredentials(item.apiId, mode, {}, [name]);
                    return `Clé « ${name} » retirée du mode ${mode}.`;
                  })}
                >
                  Retirer
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="filter-row">
          <label className="field">
            <span className="field-label">Ajouter une clé</span>
            <input type="text" value={newKey} placeholder="ex. secretKey" onChange={(e) => setNewKey(e.target.value)} />
          </label>
          {newKey ? (
            <label className="field">
              <span className="field-label">Valeur</span>
              <input
                type="password"
                value={values[newKey] ?? ''}
                onChange={(e) => setValues({ ...values, [newKey]: e.target.value })}
              />
            </label>
          ) : null}
        </div>

        <div className="action-buttons">
          <button
            type="button" className="btn" disabled={busy || Object.keys(values).length === 0}
            onClick={() => run(async () => {
              const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
              await api.setCredentials(item.apiId, mode, filled);
              setValues({});
              setNewKey('');
              return `${Object.keys(filled).length} identifiant(s) enregistré(s) en ${mode}, et rediffusé(s) aux projets autorisés.`;
            })}
          >
            Enregistrer les identifiants
          </button>
        </div>
        <p className="muted read-only-note">
          Une valeur laissée vide CONSERVE la clé existante. Pour la supprimer,
          utilisez « Retirer » — sans quoi un formulaire qui masque les secrets
          les effacerait à chaque enregistrement.
        </p>
      </Disclosure>

      {/* — Autorisations ————————————————————————————————— */}
      <Disclosure title={`Projets autorisés (${item.grants.length})`} defaultOpen>
        {item.grants.length === 0 ? (
          <p className="muted">Aucun projet n’a accès à cette API.</p>
        ) : (
          <ul className="grant-list">
            {item.grants.map((grant) => (
              <li key={grant.projectId}>
                <span className="grant-project">{grant.projectName ?? grant.projectId}</span>
                <span className="muted">
                  {grant.keys.length === 0
                    ? 'toutes les clés du mode'
                    : `clés : ${grant.keys.join(', ')}`}
                </span>
                <button
                  type="button" className="btn btn-small" disabled={busy}
                  onClick={() => run(async () => {
                    await api.revoke(item.apiId, grant.projectId);
                    return `Accès révoqué pour « ${grant.projectName} » — le projet oubliera la clé à sa prochaine synchronisation.`;
                  })}
                >
                  Révoquer
                </button>
              </li>
            ))}
          </ul>
        )}

        {available.length > 0 ? (
          <>
            <div className="filter-row">
              <ThemedFilter
                label="Projet"
                value={grantProject}
                placeholder="Choisir un projet…"
                onChange={setGrantProject}
                options={available.map((p) => ({
                  value: p.projectId,
                  label: `${p.projectName} (${p.runtime?.environment ?? 'env. inconnu'})`,
                }))}
              />
            </div>
            {set.keys.length > 0 ? (
              <fieldset className="key-selection">
                <legend className="field-label">Clés accordées (aucune cochée = toutes)</legend>
                {set.keys.map((name) => (
                  <label key={name} className="key-option">
                    <input
                      type="checkbox"
                      checked={grantKeys.includes(name)}
                      onChange={(e) => setGrantKeys(
                        e.target.checked
                          ? [...grantKeys, name]
                          : grantKeys.filter((k) => k !== name),
                      )}
                    />
                    {name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="action-buttons">
              <button
                type="button" className="btn" disabled={busy || !grantProject}
                onClick={() => run(async () => {
                  await api.grant(item.apiId, grantProject, grantKeys);
                  const name = available.find((p) => p.projectId === grantProject)?.projectName;
                  setGrantProject('');
                  setGrantKeys([]);
                  return `Accès accordé à « ${name} ». Il recevra les identifiants du mode correspondant à SON environnement.`;
                })}
              >
                Accorder l’accès
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Tous les projets appairés ont déjà accès à cette API.</p>
        )}
      </Disclosure>

      <div className="action-buttons">
        <button
          type="button" className="btn btn-small" disabled={busy}
          onClick={() => run(async () => {
            const result = await api.deleteApi(item.apiId);
            return `API supprimée — ${result.revoked} autorisation(s) révoquée(s).`;
          })}
        >
          Supprimer l’API
        </button>
      </div>
    </Card>
  );
}

function NewApiForm({ busy, onCreate }: {
  busy: boolean;
  onCreate: (body: { key: string; label: string; provider: string; category: string }) => void;
}) {
  const [form, setForm] = useState({ key: '', label: '', provider: '', category: 'OTHER' });
  return (
    <Card title="Nouvelle API intégrée">
      <div className="parameter-form">
        <label className="field">
          <span className="field-label">Identifiant</span>
          <input type="text" value={form.key} placeholder="stripe" onChange={(e) => setForm({ ...form, key: e.target.value })} />
          <span className="field-hint muted">Minuscules et tirets. C’est lui qui voyage jusqu’aux projets.</span>
        </label>
        <label className="field">
          <span className="field-label">Libellé</span>
          <input type="text" value={form.label} placeholder="Stripe" onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Fournisseur</span>
          <input type="text" value={form.provider} placeholder="STRIPE" onChange={(e) => setForm({ ...form, provider: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Catégorie</span>
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {['PAYMENT', 'EMAIL', 'SIGNATURE', 'MAPS', 'AI', 'HOSTING', 'OTHER'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="action-buttons">
        <button
          type="button" className="btn"
          disabled={busy || !form.key || !form.label || !form.provider}
          onClick={() => onCreate(form)}
        >
          Créer
        </button>
      </div>
    </Card>
  );
}
