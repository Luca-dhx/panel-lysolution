// PLAN DE CONTRÔLE INTEGRATEDAPI — l'écran (L1).
//
// ── CE QUE CET ÉCRAN NE FAIT PLUS ───────────────────────────────────────────
//
// L'ancienne page laissait taper un fournisseur en texte libre (« STRIPE »,
// « Stripe », ce qu'on voulait) et inventer des noms de clés. Celle-ci REND LE
// REGISTRE : les fournisseurs et leurs champs viennent du backend, l'écran ne
// devine rien. Ajouter un rôle dans `providerRegistry.js` le fait apparaître
// ici sans toucher à ce fichier.
//
// ── CE QU'IL N'AFFICHE JAMAIS ───────────────────────────────────────────────
//
// Aucune valeur confidentielle — l'API n'en renvoie pas. Un secret renseigné
// se montre par son masque (« ••••••••4xK2 ») et son empreinte. Une clé
// PUBLIABLE, elle, s'affiche en clair : elle est faite pour partir dans un
// navigateur, la masquer n'apporterait rien.
//
// ── CONFIGURER LES DEUX MONDES, N'EN EXÉCUTER QU'UN ─────────────────────────
//
// L'écran laisse préparer le jeu TEST ET le jeu PROD : sans cela, on ne
// pourrait jamais provisionner l'autre instance. Mais il dit, en haut et sans
// ambiguïté, lequel des deux cette instance utilisera réellement. C'est un
// constat, pas un réglage : il n'y a aucun sélecteur pour en changer.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { integratedApis, webhookControlPlane, errorMessage } from '@/lib/api';
import type {
  CredentialRoleDefinition,
  CredentialSetView,
  IntegratedApiEnvironment,
  ProviderView,
  WebhookStateView,
} from '@/types.integratedApi';

const STATUS_LABELS: Record<CredentialSetView['status'], { label: string; tone: string }> = {
  EMPTY: { label: 'Non configuré', tone: 'muted' },
  CONFIGURED: { label: 'Configuré, non vérifié', tone: 'warn' },
  VALID: { label: 'Valide', tone: 'ok' },
  INVALID: { label: 'Identifiants refusés', tone: 'danger' },
  ERROR: { label: 'Fournisseur injoignable', tone: 'danger' },
};

/**
 * ÉTATS D'UN WEBHOOK (L5).
 *
 * `PENDING` est délibérément neutre : un Panel fraîchement installé, dont
 * personne n'a encore saisi la clé, n'est PAS en panne. Peindre cet état en
 * rouge apprendrait à ignorer le rouge.
 */
const WEBHOOK_STATUS_LABELS: Record<WebhookStateView['status'], { label: string; tone: string }> = {
  UNSUPPORTED: { label: 'Aucun webhook', tone: 'muted' },
  PENDING: { label: 'En attente d’un prérequis', tone: 'muted' },
  RECONCILING: { label: 'Réconciliation interrompue', tone: 'warn' },
  READY: { label: 'Conforme', tone: 'ok' },
  DRIFTED: { label: 'Divergent', tone: 'warn' },
  WARNING: { label: 'À surveiller', tone: 'warn' },
  ERROR: { label: 'Erreur', tone: 'danger' },
};

const DRIFT_LABELS: Record<string, string> = {
  URL: 'l’adresse enregistrée n’est pas la callback canonique',
  EVENTS: 'des événements souscrits manquent',
  DISABLED: 'l’endpoint est désactivé chez le fournisseur',
  DESCRIPTION: 'la description ne porte plus notre marque d’appartenance',
  MISSING: 'aucun endpoint ne nous appartient chez le fournisseur',
};

const SCOPE_LABELS: Record<string, string> = {
  PANEL_GLOBAL: 'Global au Panel',
  ENVIRONMENT: 'Par environnement',
  PROJECT: 'Par projet',
  PROJECT_ENVIRONMENT: 'Par projet et environnement',
};

function formatDate(value: string | null): string {
  if (!value) return 'jamais';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('fr-FR');
}

export function IntegratedApiControlPlanePage() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [webhooks, setWebhooks] = useState<Record<string, WebhookStateView>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders((await integratedApis.list()).items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Plan de contrôle indisponible.'));
    } finally {
      setLoaded(true);
    }
    /**
     * L'état des webhooks est chargé SÉPARÉMENT et sans faire échouer la page.
     *
     * Il décrit une frontière avec des tiers ; son indisponibilité ne doit pas
     * empêcher de lire — ni de corriger — les identifiants, qui sont
     * justement ce dont il dépend.
     */
    try {
      const { items } = await webhookControlPlane.list();
      setWebhooks(Object.fromEntries(items.map((item) => [item.provider, item])));
    } catch {
      setWebhooks({});
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

  const runtime = providers[0]?.runtimeEnvironment ?? null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Intégrations API</h1>
        <p className="muted">
          Le Panel détient les accès aux services tiers de la plateforme. Les
          identifiants sont chiffrés au repos et ne sortent jamais de cette
          instance.
        </p>
      </header>

      {runtime ? (
        <p className={`mode-notice ${runtime === 'PROD' ? 'mode-reel' : 'mode-simulation'}`}>
          Cette instance de Panel sert <strong>{runtime}</strong>. Toute action
          métier future utilisera le jeu d’identifiants {runtime} — sans que
          personne ait à le choisir. Les deux jeux se configurent ici ; un seul
          s’exécute.
        </p>
      ) : null}

      <p className="muted read-only-note">
        <strong>Lot L1 — fondation.</strong> Les projets continuent d’utiliser
        leurs propres intégrations : aucun appel métier ne passe encore par le
        Panel. Cet écran configure et diagnostique, il n’exécute rien.{' '}
        L’<Link to="/integrated-apis/legacy">ancien coffre</Link>, qui diffuse
        encore des identifiants aux projets, reste en service jusqu’au lot L4.
      </p>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-success">{notice}</div> : null}

      {loaded && providers.length === 0 ? (
        <EmptyState
          title="Aucun fournisseur au registre"
          hint="Le registre est code-first : un fournisseur s’ajoute dans providerRegistry.js, jamais depuis cette page."
        />
      ) : (
        providers.map((provider) => (
          <ProviderCard
            key={provider.definition.provider}
            provider={provider}
            webhook={webhooks[provider.definition.provider] ?? null}
            busy={busy}
            run={run}
          />
        ))
      )}
    </div>
  );
}

function ProviderCard({ provider, webhook, busy, run }: {
  provider: ProviderView;
  webhook: WebhookStateView | null;
  busy: boolean;
  run: (fn: () => Promise<string>) => Promise<void>;
}) {
  const { definition, credentialSets, runtimeEnvironment, effectiveEnvironment, validatable } = provider;

  return (
    <Card title={definition.label}>
      <DetailList
        items={[
          ['Fournisseur', <code>{definition.provider}</code>],
          ['Portée', SCOPE_LABELS[definition.scope] ?? definition.scope],
          ['Catégorie', definition.category],
          [
            'Utilisé ici en',
            effectiveEnvironment
              ? <strong>{effectiveEnvironment}</strong>
              : <span className="muted">sans environnement (compte unique)</span>,
          ],
          [
            'Capacités déclarées',
            <span className="muted">{definition.capabilities.join(', ') || '—'} (non invocables en L1)</span>,
          ],
        ]}
      />

      <WebhookPanel
        provider={definition.provider}
        supported={definition.supportsWebhookReconciliation}
        webhook={webhook}
        busy={busy}
        run={run}
      />

      {credentialSets.map((set) => (
        <CredentialSetPanel
          key={`${definition.provider}-${set.environment ?? 'GLOBAL'}`}
          definition={definition}
          set={set}
          runtimeEnvironment={runtimeEnvironment}
          validatable={validatable}
          busy={busy}
          run={run}
        />
      ))}
    </Card>
  );
}

/**
 * ÉTAT DU WEBHOOK (L5) — ce que le Panel veut, ce que le fournisseur expose.
 *
 * ── CE QUE CE BLOC N'AFFICHE JAMAIS ─────────────────────────────────────────
 * Aucun secret, aucune empreinte de secret, aucune charge utile d'événement.
 * Le backend ne les rend pas : cette absence est structurelle, l'écran n'a
 * rien à filtrer.
 *
 * La callback, elle, s'affiche EN CLAIR — c'est une adresse publique que le
 * fournisseur connaît déjà, et pouvoir la comparer à ce que son tableau de
 * bord montre est exactement ce qui rend cet écran utile.
 */
function WebhookPanel({ provider, supported, webhook, busy, run }: {
  provider: string;
  supported: boolean;
  webhook: WebhookStateView | null;
  busy: boolean;
  run: (fn: () => Promise<string>) => Promise<void>;
}) {
  if (!supported) {
    return (
      <p className="muted read-only-note">
        <strong>Webhooks — aucun.</strong>{' '}
        {webhook?.reason
          ?? 'Ce fournisseur n’expose pas de webhook. Aucun endpoint n’est créé, et aucune liaison vide n’est écrite.'}
      </p>
    );
  }

  if (!webhook) {
    return <p className="muted read-only-note">État des webhooks indisponible.</p>;
  }

  const status = WEBHOOK_STATUS_LABELS[webhook.status] ?? { label: webhook.status, tone: 'muted' };

  return (
    <Disclosure title={`Webhook — ${status.label}`} defaultOpen={webhook.status !== 'READY'}>
      <p className={`badge badge-${status.tone}`}>{status.label}</p>

      {webhook.interrupted ? (
        <div className="alert alert-error">
          Une réconciliation s’est interrompue sans conclure. L’endpoint distant
          existe peut-être déjà : la prochaine réconciliation le reconnaîtra par
          sa marque d’appartenance plutôt que d’en créer un second.
        </div>
      ) : null}

      {webhook.drift.length ? (
        <div className="alert alert-error">
          Divergence entre ce que le Panel veut et ce que le fournisseur expose :{' '}
          {webhook.drift.map((kind) => DRIFT_LABELS[kind] ?? kind).join(' ; ')}.
        </div>
      ) : null}

      <DetailList
        items={[
          ['Adresse de rappel', webhook.callbackUrl
            ? <code>{webhook.callbackUrl}</code>
            : <span className="muted">aucune adresse publique résolue pour ce Panel</span>],
          ['Endpoint distant', webhook.remoteWebhookId
            ? <code>{webhook.remoteWebhookId}</code>
            : <span className="muted">aucun</span>],
          ['Vérification des appels', webhook.signatureProves
            ? <span>signature cryptographique ({webhook.signatureScheme})</span>
            // La nuance est conservée jusqu'à l'écran : un jeton partagé
            // authentifie le porteur, il ne prouve pas le contenu reçu.
            : <span>jeton partagé — l’appelant est authentifié, le contenu n’est pas prouvé</span>],
          ['Secret de vérification', webhook.secretConfigured
            ? <span>en place dans le coffre</span>
            : <span className="muted">absent — les appels entrants seront refusés</span>],
          ['Événements souscrits', <span className="muted">{webhook.desiredEvents.length}</span>],
          ['Dernière vérification', formatDate(webhook.lastCheckedAt)],
          ['Dernière réconciliation', formatDate(webhook.lastReconciledAt)],
          ['Dernier événement reçu', webhook.lastEventAt
            ? <span>{formatDate(webhook.lastEventAt)} — <code>{webhook.lastEventType || '—'}</code></span>
            : <span className="muted">jamais</span>],
          ['Reçus / rejeux absorbés',
            <span className="muted">{webhook.eventsReceived ?? 0} / {webhook.duplicatesIgnored ?? 0}</span>],
          ...(webhook.lastError
            ? [['Dernier diagnostic',
              <span><code>{webhook.lastError.code}</code> — {webhook.lastError.message}</span>] as [string, ReactNode]]
            : []),
        ]}
      />

      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => run(async () => {
          const rapport = await webhookControlPlane.reconcile(provider) as { status?: string };
          return `Webhook ${provider} : ${rapport.status ?? 'réconcilié'}.`;
        })}
      >
        Réconcilier
      </button>
      <p className="muted read-only-note">
        Réconcilier ÉCRIT chez le fournisseur : création, mise à jour, ou
        retrait d’un endpoint <strong>que ce Panel a lui-même créé</strong>. Un
        endpoint qui ne nous appartient pas n’est jamais touché — le compte peut
        être partagé avec d’autres systèmes.
      </p>
    </Disclosure>
  );
}

function CredentialSetPanel({ definition, set, runtimeEnvironment, validatable, busy, run }: {
  definition: ProviderView['definition'];
  set: CredentialSetView;
  runtimeEnvironment: IntegratedApiEnvironment;
  validatable: boolean;
  busy: boolean;
  run: (fn: () => Promise<string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  const status = STATUS_LABELS[set.status];
  const titre = set.environment
    ? `${set.environment} — ${status.label}`
    : `Jeu unique — ${status.label}`;

  // Le jeu de l'autre monde se configure, mais ne servira jamais ICI. Le dire
  // évite le doute — et évite qu'on croie avoir « activé » la production en
  // remplissant un formulaire.
  const servedHere = set.environment === null || set.environment === runtimeEnvironment;

  const remplis = Object.entries(values).filter(([, v]) => v.trim() !== '');

  return (
    <Disclosure
      title={titre}
      defaultOpen={servedHere}
      hint={servedHere ? undefined : 'Provisionnement pour l’autre instance — jamais utilisé ici.'}
    >
      <p className={`badge badge-${status.tone}`}>{status.label}</p>

      {!servedHere ? (
        <p className="muted read-only-note">
          Ce jeu appartient à l’instance <strong>{set.environment}</strong>. Le
          configurer ici est utile — c’est le même coffre applicatif —, mais
          <strong> aucune action de cette instance ne l’utilisera</strong>.
        </p>
      ) : null}

      {set.validationStale ? (
        <div className="alert alert-error">
          Les identifiants ont changé depuis la dernière vérification : la preuve
          ne porte plus sur la clé en place. Relancez le test.
        </div>
      ) : null}

      <DetailList
        items={[
          ['Dernière vérification', formatDate(set.lastValidatedAt)],
          ['Issue', set.lastValidationMessage || <span className="muted">aucune</span>],
          ...(set.lastValidationCode ? [['Code', <code>{set.lastValidationCode}</code>] as [string, React.ReactNode]] : []),
          ...(set.lastValidationDurationMs !== null
            ? [['Temps de réponse', `${set.lastValidationDurationMs} ms`] as [string, React.ReactNode]]
            : []),
        ]}
      />

      <ul className="credential-list">
        {definition.credentialRoles.map((role) => (
          <CredentialRoleRow
            key={role.code}
            role={role}
            state={set.credentials[role.code]}
            value={values[role.code] ?? ''}
            onChange={(v) => setValues({ ...values, [role.code]: v })}
            busy={busy}
            onRemove={() => run(async () => {
              await integratedApis.saveCredentials(definition.provider, set.environment, {}, [role.code]);
              return `« ${role.label} » retiré du jeu ${set.environment ?? 'unique'}.`;
            })}
          />
        ))}
      </ul>

      <div className="action-buttons">
        <button
          type="button" className="btn" disabled={busy || remplis.length === 0}
          onClick={() => run(async () => {
            await integratedApis.saveCredentials(
              definition.provider,
              set.environment,
              Object.fromEntries(remplis),
            );
            setValues({});
            return `${remplis.length} identifiant(s) enregistré(s) pour ${definition.label}`
              + `${set.environment ? ` (${set.environment})` : ''}.`;
          })}
        >
          Enregistrer
        </button>

        <button
          type="button" className="btn btn-small"
          disabled={busy || !validatable || !set.configured}
          title={set.configured ? undefined : 'Renseignez d’abord les identifiants requis.'}
          onClick={() => run(async () => {
            const r = await integratedApis.validate(definition.provider, set.environment);
            return `${definition.label} : ${r.validation.message}`;
          })}
        >
          Tester la connexion
        </button>
      </div>

      <p className="muted read-only-note">
        Un champ laissé vide <strong>conserve</strong> la valeur existante — sans
        quoi un formulaire qui masque les secrets les effacerait à chaque
        enregistrement. Pour retirer une clé, utilisez « Retirer ».
        Le test est un appel en <strong>lecture seule</strong> : aucun paiement,
        aucun e-mail, aucune signature.
      </p>
    </Disclosure>
  );
}

function CredentialRoleRow({ role, state, value, onChange, busy, onRemove }: {
  role: CredentialRoleDefinition;
  state: CredentialSetView['credentials'][string] | undefined;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onRemove: () => void;
}) {
  const configured = state?.configured ?? false;
  const placeholder = configured
    ? 'laisser vide pour conserver'
    : role.defaultValue ?? (role.required ? 'requis' : 'facultatif');

  return (
    <li>
      <span className="credential-name">
        {role.label}
        {role.required ? <span className="badge badge-muted"> requis</span> : null}
        {role.autoManaged ? <span className="badge badge-muted"> auto</span> : null}
      </span>

      {/* Un secret ne montre que son masque ; une valeur publique se lit. */}
      {configured ? (
        <code className="credential-fingerprint">
          {state?.secret ? state.maskedValue : state?.value}
        </code>
      ) : (
        <span className="muted">non renseigné</span>
      )}

      <input
        type={role.secret ? 'password' : 'text'}
        placeholder={placeholder}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      />

      {configured ? (
        <button type="button" className="btn btn-small" disabled={busy} onClick={onRemove}>
          Retirer
        </button>
      ) : null}

      {role.hint ? <span className="field-hint muted">{role.hint}</span> : null}
    </li>
  );
}

export default IntegratedApiControlPlanePage;
