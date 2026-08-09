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
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { integratedApis, errorMessage } from '@/lib/api';
import type {
  CredentialRoleDefinition,
  CredentialSetView,
  IntegratedApiEnvironment,
  ProviderView,
} from '@/types.integratedApi';

const STATUS_LABELS: Record<CredentialSetView['status'], { label: string; tone: string }> = {
  EMPTY: { label: 'Non configuré', tone: 'muted' },
  CONFIGURED: { label: 'Configuré, non vérifié', tone: 'warn' },
  VALID: { label: 'Valide', tone: 'ok' },
  INVALID: { label: 'Identifiants refusés', tone: 'danger' },
  ERROR: { label: 'Fournisseur injoignable', tone: 'danger' },
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
            busy={busy}
            run={run}
          />
        ))
      )}
    </div>
  );
}

function ProviderCard({ provider, busy, run }: {
  provider: ProviderView;
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
            'Webhooks',
            definition.supportsWebhookReconciliation
              ? <span className="muted">réconciliables (prévu en L5)</span>
              : <span className="muted">aucun</span>,
          ],
          [
            'Capacités déclarées',
            <span className="muted">{definition.capabilities.join(', ') || '—'} (non invocables en L1)</span>,
          ],
        ]}
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
