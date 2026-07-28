// WORKFLOW D'EXÉCUTION d'un projet — Phase 3C, LOT 8.
//
// C'est le seul chemin par lequel une action part. Il suit exactement les
// étapes du moteur, et n'en saute aucune :
//
//   1. CHOISIR     l'action, dans le catalogue servi par le backend
//   2. RENSEIGNER  ses paramètres, décrits par son descripteur
//   3. PRÉPARER    → le moteur évalue et explique ce qui bloque
//   4. SIMULER     → le plan réel, sans effet (mode par défaut)
//   5. EXÉCUTER    → seulement si les politiques passent, et après confirmation
//
// Il n'existe AUCUN bouton qui lance une action sans passer par la
// préparation : l'écran ne peut pas court-circuiter le moteur, parce que le
// moteur est le seul à savoir si l'action est permise.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { Disclosure } from '@/components/supervision';
import {
  CheckList, DenialList, ModeBadge, ModeNotice, PlanList, RiskBadge, StateBadge, duration,
} from '@/components/execution';
import { executions as api, errorMessage } from '@/lib/api';
import type { ActionDescriptor, ActionPreparation, Execution } from '@/types.execution';

export function ProjectActionsPage() {
  const { projectId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const [catalogue, setCatalogue] = useState<ActionDescriptor[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [preparation, setPreparation] = useState<ActionPreparation | null>(null);
  const [outcome, setOutcome] = useState<Execution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Le catalogue vient du backend : aucune action n'est écrite en dur ici.
  useEffect(() => {
    api.actions()
      .then((data) => {
        const items = data.items.filter((a) => a.target === 'PROJECT');
        setCatalogue(items);
        // Arrivée depuis une recommandation 3B : l'action est pré-choisie.
        const wanted = search.get('futureAction');
        const match = wanted ? items.find((a) => a.futureActions.includes(wanted)) : null;
        setSelected((current) => current ?? match?.type ?? null);
      })
      .catch((err) => setError(errorMessage(err, 'Catalogue d’actions indisponible.')));
  }, [search]);

  const action = useMemo(
    () => catalogue.find((a) => a.type === selected) ?? null,
    [catalogue, selected],
  );

  // Changer d'action réinitialise tout : une préparation ne vaut que pour
  // l'action et les paramètres qui l'ont produite.
  const choose = (type: string) => {
    setSelected(type);
    setParameters({});
    setPreparation(null);
    setOutcome(null);
    setError(null);
  };

  const typedParameters = (): Record<string, unknown> => {
    if (!action) return {};
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(action.parameters)) {
      const raw = parameters[name];
      if (raw === undefined || raw === '') continue;
      out[name] = spec.type === 'array'
        ? raw.split(',').map((v) => v.trim()).filter(Boolean)
        : raw;
    }
    return out;
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err, 'Opération impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const prepare = () => run(async () => {
    setOutcome(null);
    setPreparation(await api.prepare({ type: action!.type, projectId, parameters: typedParameters() }));
  });

  const launch = (mode: 'SIMULATION' | 'EXECUTION') => run(async () => {
    const execution = await api.create({
      type: action!.type, projectId, parameters: typedParameters(), mode,
    });
    setOutcome(execution);
    // Une exécution qui attend une décision se poursuit sur sa propre fiche :
    // la confirmation est un acte à part entière, pas une case à cocher.
    if (execution.state === 'WAITING_CONFIRMATION') {
      navigate(`/actions/${execution.executionId}`);
    }
  });

  if (error && catalogue.length === 0) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
        <p><Link to="/supervision">← Retour au parc</Link></p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Piloter ce projet</h1>
        <p className="muted">
          Toute action passe par le moteur d’exécution : préparée, validée, confirmée, tracée.
        </p>
        <p>
          <Link to={`/supervision/${projectId}`}>← Fiche projet</Link>
          {' · '}
          <Link to={`/supervision/${projectId}/diagnostic`}>Diagnostic</Link>
          {' · '}
          <Link to={`/actions?projectId=${projectId}`}>Historique des exécutions</Link>
        </p>
      </header>

      {/* — 1. Choisir l'action ————————————————————————————— */}
      <Card title="Actions disponibles">
        {catalogue.length === 0 ? (
          <p className="muted">Chargement du catalogue…</p>
        ) : (
          <ul className="action-catalogue">
            {catalogue.map((item) => (
              <li key={item.type} className={item.type === selected ? 'action-selected' : undefined}>
                <button type="button" className="action-choice" onClick={() => choose(item.type)}>
                  <span className="action-label">{item.label}</span>
                  <RiskBadge value={item.policy.risk} />
                </button>
                <p className="action-description">{item.description}</p>
                <p className="action-policy muted">
                  {item.policy.allowedEnvironments.join(' ou ')}
                  {item.policy.requiresConfirmation
                    ? ` · ${item.policy.confirmationsRequired} confirmation(s)`
                    : ' · sans confirmation'}
                  {item.policy.requiredReadiness !== null
                    ? ` · préparation ≥ ${item.policy.requiredReadiness} %`
                    : null}
                  {item.policy.exclusive ? ' · exclusive' : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* — 2. Renseigner les paramètres ————————————————————— */}
      {action ? (
        <Card title={`Préparer « ${action.label} »`}>
          {Object.keys(action.parameters).length === 0 ? (
            <p className="muted">Cette action ne prend aucun paramètre.</p>
          ) : (
            <div className="parameter-form">
              {Object.entries(action.parameters).map(([name, spec]) => (
                <label key={name} className="field">
                  <span className="field-label">
                    {name}
                    {spec.required ? <span className="field-required"> (obligatoire)</span> : null}
                  </span>
                  {spec.type === 'enum' && spec.values ? (
                    <select
                      value={parameters[name] ?? ''}
                      onChange={(e) => setParameters({ ...parameters, [name]: e.target.value })}
                    >
                      <option value="">—</option>
                      {spec.values.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={parameters[name] ?? ''}
                      placeholder={spec.type === 'array' ? 'valeurs séparées par des virgules' : ''}
                      onChange={(e) => setParameters({ ...parameters, [name]: e.target.value })}
                    />
                  )}
                  <span className="field-hint muted">{spec.description}</span>
                </label>
              ))}
            </div>
          )}

          <div className="action-buttons">
            <button type="button" className="btn" disabled={busy} onClick={prepare}>
              Vérifier les conditions
            </button>
          </div>
          {error ? <div className="alert alert-error">{error}</div> : null}
        </Card>
      ) : null}

      {/* — 3. Le verdict du moteur ————————————————————————— */}
      {preparation ? (
        <Card title="Ce que dit le moteur">
          {preparation.allowed ? (
            <p className="alert alert-success">{preparation.reason}</p>
          ) : (
            <DenialList denials={preparation.denials} />
          )}

          <Disclosure title={`Détail des contrôles (${preparation.checks.length})`}>
            <CheckList checks={preparation.checks} />
          </Disclosure>

          {preparation.confirmation.required ? (
            <p className="muted">
              Cette action exige {preparation.confirmation.count} confirmation(s) explicite(s)
              avant toute exécution réelle.
            </p>
          ) : null}

          {/* La simulation reste offerte même quand l'exécution est refusée :
              comprendre ce qui serait fait aide à lever le blocage. */}
          <div className="action-buttons">
            <button
              type="button"
              className="btn"
              disabled={busy || !preparation.modes.simulation}
              onClick={() => launch('SIMULATION')}
            >
              Simuler
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !preparation.modes.execution}
              onClick={() => launch('EXECUTION')}
            >
              Exécuter réellement
            </button>
          </div>
          {!preparation.modes.execution ? (
            <p className="muted">
              L’exécution réelle est indisponible tant que les causes ci-dessus subsistent.
              La simulation, elle, reste possible.
            </p>
          ) : null}
        </Card>
      ) : null}

      {/* — 4. Le résultat ————————————————————————————————— */}
      {outcome ? (
        <Card title="Résultat">
          <div className="execution-head">
            <StateBadge value={outcome.state} />
            <ModeBadge value={outcome.mode} />
            <span className="muted">{duration(outcome.durationMs)}</span>
            <Link to={`/actions/${outcome.executionId}`}>Fiche complète et journal →</Link>
          </div>
          <ModeNotice mode={outcome.mode} />

          {outcome.error ? (
            <div className="alert alert-error">{outcome.error.message}</div>
          ) : (
            <p>{outcome.result?.summary}</p>
          )}

          {outcome.result?.consequences ? (
            <div className="denial-block">
              <p className="denial-title">Conséquences déclarées</p>
              <ul className="denial-list">
                {outcome.result.consequences.map((c) => (
                  <li key={c.secret}>
                    <span className="denial-message"><strong>{c.secret}</strong> — {c.consequence}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {outcome.result?.plan?.length ? (
            <Disclosure title={`Plan (${outcome.result.plan.length} étapes)`} defaultOpen>
              <PlanList steps={outcome.result.plan} />
            </Disclosure>
          ) : null}
        </Card>
      ) : null}

      {catalogue.length > 0 && !action ? (
        <EmptyState
          title="Choisissez une action"
          hint="Le Panel n’exécute rien avant d’avoir vérifié que l’action est permise."
        />
      ) : null}
    </div>
  );
}
