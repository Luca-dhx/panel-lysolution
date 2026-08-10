// API INTÉGRÉES — ANCIEN COFFRE (Phase 4, LOT 4 — vidé de sa fonction en L4).
//
// ── CE QUI RESTE VIVANT ICI, ET RIEN D'AUTRE ────────────────────────────────
//
// Une seule chose : les AUTORISATIONS. « Ce projet a le droit d'utiliser cette
// intégration » est une donnée saisie à la main, sans équivalent ailleurs, et
// que le lot L3 transformera en droit d'invoquer une capacité. La détruire
// coûterait une configuration ; la garder ne coûte rien.
//
// ── CE QUI EST MORT, ET POURQUOI L'ÉCRAN LE DIT ─────────────────────────────
//
// Les IDENTIFIANTS de ce coffre ne sont lus par AUCUN code depuis le lot L4 :
// leur unique consommateur était la diffusion vers les projets, supprimée avec
// la garde de la frontière. Le service les chiffre encore à l'écriture, mais
// plus rien ne les déchiffre.
//
// Le formulaire de saisie a donc été retiré. Laisser un champ qui accepte une
// vraie clé Stripe pour la ranger dans un cul-de-sac est pire qu'un champ
// absent : personne ne peut deviner que le geste n'a aucun effet.
//
// ── LE MONDE FOURNISSEUR NE SE CHOISIT PLUS (lot L2) ────────────────────────
//
// Cet écran affichait « Mode côté Panel ». Ce mode ne routait déjà plus rien
// depuis L4 ; depuis L2 la notion elle-même a disparu — l'environnement de
// l'instance impose celui des fournisseurs, et aucune interface ne le choisit.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { RuntimeEnvironmentNotice } from '@/components/RuntimeEnvironmentNotice';
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
        <h1>API intégrées — ancien coffre</h1>
        <p className="muted">
          Les accès aux services tiers de l’entreprise. Le Panel les détient ;
          les projets reçoivent uniquement ceux qui leur sont accordés.
        </p>
        <p>
          <Link to="/integrated-apis">← Plan de contrôle</Link>
          {' · '}
          <Link to="/company">Entreprise</Link>
        </p>
      </header>

      <p className="mode-notice mode-reel">
        <strong>Ancien coffre — il ne sert plus qu’aux autorisations.</strong>{' '}
        Depuis le lot L4, cet écran ne diffuse plus aucun identifiant : la garde
        du pont l’interdit. Le coffre vivant est le{' '}
        <Link to="/integrated-apis">plan de contrôle</Link>.
      </p>

      <RuntimeEnvironmentNotice />

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
  const [grantProject, setGrantProject] = useState('');

  const granted = new Set(item.grants.map((g) => g.projectId));
  const available = projects.filter((p) => !granted.has(p.projectId));

  return (
    <Card title={`${item.label} — ${item.provider}`}>
      <DetailList
        items={[
          ['Identifiant', <code>{item.key}</code>],
          ['Catégorie', item.category],
          ['Actif', item.enabled ? 'oui' : 'non'],
          ['TEST configuré', item.credentials.TEST.configured ? `${item.credentials.TEST.keys.length} clé(s)` : <span className="muted">non</span>],
          ['PROD configuré', item.credentials.PROD.configured ? `${item.credentials.PROD.keys.length} clé(s)` : <span className="muted">non</span>],
        ]}
      />

      {/* — Identifiants : INERTES depuis L4 ————————————————— */}
      <Disclosure title={`Identifiants historiques (${item.credentials.TEST.keys.length + item.credentials.PROD.keys.length})`}>
        <p className="mode-notice mode-reel">
          <strong>Ces identifiants ne sont lus par aucun code.</strong> Le lot L4
          a supprimé leur seul consommateur — la diffusion vers les projets. Ce
          service les chiffre encore à l’écriture, mais plus rien ne les
          déchiffre : une clé saisie ici partirait dans un cul-de-sac.
        </p>
        <p className="muted read-only-note">
          Le coffre vivant est le{' '}
          <Link to="/integrated-apis">plan de contrôle</Link>. Le formulaire de
          saisie a été retiré d’ici pour ne plus inviter un geste sans effet ;
          la route correspondante subsiste, inchangée, pour la compatibilité.
        </p>

        {item.credentials.TEST.keys.length + item.credentials.PROD.keys.length === 0 ? (
          <p className="muted">Aucune clé historique sur cette entrée.</p>
        ) : (
          <ul className="credential-list">
            {(['TEST', 'PROD'] as const).flatMap((jeu) =>
              item.credentials[jeu].keys.map((name) => (
                <li key={`${jeu}-${name}`}>
                  <span className="credential-name">{jeu} · {name}</span>
                  <code className="credential-fingerprint">
                    {item.credentials[jeu].fingerprints[name]}
                  </code>
                  <span className="muted">inerte</span>
                </li>
              )),
            )}
          </ul>
        )}
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
            {/*
              ─── SUPPRIMÉ : LA RESTRICTION PAR CLÉ ────────────────────────
              Elle permettait de n'accorder qu'une partie des identifiants —
              utile tant que le Panel les DIFFUSAIT. Depuis L4 il n'en diffuse
              aucun : restreindre un envoi qui n'a plus lieu n'a plus d'objet.

              L'autorisation, elle, survit : elle deviendra un droit d'invoquer
              une capacité (lot L3). Le champ `keys` reste au modèle, vide.
            */}
            <div className="action-buttons">
              <button
                type="button" className="btn" disabled={busy || !grantProject}
                onClick={() => run(async () => {
                  await api.grant(item.apiId, grantProject, []);
                  const name = available.find((p) => p.projectId === grantProject)?.projectName;
                  setGrantProject('');
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
