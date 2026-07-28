// ONGLET DIAGNOSTIC d'un projet — Phase 3B.
//
// Structure en divulgation progressive, comme le reste du Panel :
//   · le RÉSUMÉ répond immédiatement aux questions (pourquoi cet état ?
//     est-il compatible ? est-il prêt ?) ;
//   · risques, compatibilité, readiness et recommandations sont des blocs
//     dépliables, ouverts seulement si l'on creuse.
//
// 100 % LECTURE SEULE : aucun bouton n'exécute quoi que ce soit. Les
// recommandations décrivent une action ; elles ne la déclenchent pas.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import {
  EffortTag, PriorityBadge, ReadinessGauge, RiskBadge, SeverityBadge,
  StateBadge, VerdictBadge, Why,
} from '@/components/diagnostic';
import { diagnostic as api, errorMessage } from '@/lib/api';
import type { ProjectDiagnostic } from '@/types.diagnostic';

export function ProjectDiagnosticPage() {
  const { projectId = '' } = useParams();
  const [data, setData] = useState<ProjectDiagnostic | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.project(projectId)
      .then((d) => { if (active) setData(d); })
      .catch((err) => { if (active) setError(errorMessage(err, 'Diagnostic indisponible.')); });
    return () => { active = false; };
  }, [projectId]);

  if (error) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
        <p><Link to="/supervision">← Retour au parc</Link></p>
      </div>
    );
  }
  if (!data) return <div className="page"><p className="muted">Analyse en cours…</p></div>;

  const { summary, diagnostics, compatibility, readiness, risks, recommendations } = data;

  return (
    <div className="page">
      <p className="breadcrumb">
        <Link to="/supervision">← Parc</Link>
        {' · '}
        <Link to={`/supervision/${projectId}`}>Fiche projet</Link>
      </p>

      <header className="page-header">
        <h1>Diagnostic — {data.projectName}</h1>
        <p className="page-description">
          Analyse calculée à partir de ce que le projet a publié. Aucune action n’est exécutée.
        </p>
        <div className="header-badges">
          <PriorityBadge value={data.priority} />
          <VerdictBadge value={compatibility.verdict} />
          {summary.highestRisk ? <RiskBadge value={summary.highestRisk} /> : null}
        </div>
      </header>

      {/* — Le résumé : les réponses, tout de suite ——————————————— */}
      <div className="card-grid">
        <Card title="Préparation">
          <ReadinessGauge
            score={readiness.score}
            level={readiness.level}
            hint={summary.readinessExplanation}
          />
        </Card>

        <Card title="Ce qu’il faut retenir">
          <DetailList
            items={[
              ['État', summary.explanation],
              ['Compatibilité', summary.compatibilityExplanation],
              ['Diagnostics', `${summary.diagnosticCount} dont ${summary.blockingCount} bloquant(s)`],
              ['Risque le plus élevé', summary.highestRisk
                ? <RiskBadge key="r" value={summary.highestRisk} />
                : <span className="muted">aucun</span>],
              ['Priorité', <PriorityBadge key="p" value={data.priority} />],
            ]}
          />
        </Card>
      </div>

      {/* — Recommandations : ce qu'il faudrait faire ——————————— */}
      <Card title={`Recommandations${recommendations.length ? ` (${recommendations.length})` : ''}`}>
        {recommendations.length === 0 ? (
          <p className="muted">Aucune action recommandée : le projet ne présente aucun écart.</p>
        ) : (
          <ul className="recommendation-list">
            {recommendations.map((rec) => (
              <li key={rec.id}>
                <div className="recommendation-head">
                  <PriorityBadge value={rec.priority} />
                  <span className="recommendation-action">{rec.action}</span>
                  <EffortTag value={rec.effort} />
                </div>
                <DetailList
                  items={[
                    ['Bénéfice attendu', rec.benefit],
                    ['Risque', rec.risk],
                    ['Prérequis', rec.prerequisites.length
                      ? rec.prerequisites.join(' · ')
                      : <span className="muted">aucun</span>],
                  ]}
                />
                {rec.reasons.map((reason, index) => (
                  <Why key={index}>{reason.justification}</Why>
                ))}
              </li>
            ))}
          </ul>
        )}
        <p className="muted read-only-note">
          Ces recommandations décrivent une action ; le Panel ne l’exécute pas.
        </p>
      </Card>

      {/* — Risques ————————————————————————————————————————— */}
      <Disclosure
        title={`Risques (${risks.total})`}
        hint={risks.highest ? `plus élevé : ${risks.highest}` : 'aucun'}
        defaultOpen={risks.byLevel.critical > 0 || risks.byLevel.high > 0}
      >
        {risks.items.length === 0 ? (
          <p className="muted">Aucun risque identifié.</p>
        ) : (
          <ul className="risk-list">
            {risks.items.map((risk) => (
              <li key={risk.id}>
                <div className="risk-head">
                  <RiskBadge value={risk.level} />
                  <span className="risk-title">{risk.title}</span>
                  <span className="muted risk-score">score {risk.score}</span>
                </div>
                <p className="risk-exposure">{risk.exposure}</p>
                <DetailList
                  items={[
                    ['Probabilité', `${Math.round(risk.probability * 100)} % — ${risk.probabilityReason}`],
                    ['Impact', `${risk.impact} — ${risk.impactReason}`],
                  ]}
                />
                <Why>{risk.justification}</Why>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>

      {/* — Compatibilité ————————————————————————————————— */}
      <Disclosure
        title="Compatibilité avec l’écosystème"
        hint={compatibility.blocking ? 'bloquante' : compatibility.verdict}
        defaultOpen={compatibility.blocking}
      >
        <p className="disclosure-lead">{compatibility.reason}</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Axe</th><th>Verdict</th><th>Projet</th><th>Référence</th><th>Explication</th></tr>
            </thead>
            <tbody>
              {compatibility.axes.map((axis) => (
                <tr key={axis.axis}>
                  <td>{axis.label}</td>
                  <td><VerdictBadge value={axis.verdict} /></td>
                  <td>{axis.actual ?? <span className="muted">—</span>}</td>
                  <td>{axis.reference ?? <span className="muted">—</span>}</td>
                  <td className="axis-reason">{axis.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>

      {/* — Readiness : le détail du calcul —————————————————— */}
      <Disclosure title="Détail du score de préparation" hint={`${readiness.score} %`}>
        <p className="disclosure-lead">
          <code>{readiness.formula.description}</code> — poids obtenu{' '}
          {readiness.formula.earnedWeight} sur {readiness.formula.totalWeight}.
          {readiness.formula.ceilingApplied
            ? ` Score plafonné à ${readiness.formula.ceilingApplied} % (critère bloquant en échec).`
            : null}
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Critère</th><th>Poids</th><th>État</th><th>Apport</th><th>Raison</th></tr>
            </thead>
            <tbody>
              {readiness.criteria.map((criterion) => (
                <tr key={criterion.id} className={criterion.state === 'FAIL' ? 'row-attention' : undefined}>
                  <td>
                    {criterion.label}
                    {criterion.blocking ? <span className="muted"> (bloquant)</span> : null}
                  </td>
                  <td>{criterion.weight}</td>
                  <td><StateBadge value={criterion.state} /></td>
                  <td>{criterion.contribution === null
                    ? <span className="muted">—</span>
                    : criterion.contribution}</td>
                  <td className="axis-reason">{criterion.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>

      {/* — Diagnostics bruts ————————————————————————————— */}
      <Disclosure title={`Diagnostics détaillés (${diagnostics.length})`}>
        {diagnostics.length === 0 ? (
          <p className="muted">Aucun diagnostic : aucun écart détectable.</p>
        ) : (
          <ul className="diagnostic-list">
            {diagnostics.map((d) => (
              <li key={d.id}>
                <div className="diagnostic-head">
                  <SeverityBadge value={d.severity} />
                  <span className="diagnostic-title">{d.title}</span>
                  <code className="diagnostic-id">{d.ruleId}</code>
                </div>
                <p>{d.description}</p>
                <Why>{d.justification}</Why>
                <DetailList
                  items={[
                    ['Composant', d.component],
                    ['Catégorie', d.category],
                    ['Impact', d.impact],
                    ['Origine', d.origin === 'PROJECT_DECLARATION' ? 'déclaré par le projet'
                      : d.origin === 'PANEL_OBSERVATION' ? 'constaté par le Panel'
                        : 'analysé par le Panel'],
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Disclosure>

      <p className="muted read-only-note">
        Analyse calculée le {new Date(data.evaluatedAt).toLocaleString()} — recalculée à chaque
        consultation, jamais mise en cache.
      </p>
    </div>
  );
}
