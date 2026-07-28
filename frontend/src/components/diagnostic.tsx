// Composants de diagnostic — mêmes jetons de design que le reste du Panel.
// Aucun composant ici ne déclenche d'action : la Phase 3B analyse, elle
// n'administre pas.
import type { ReactNode } from 'react';
import type {
  CriterionState, Priority, ReadinessLevel, RiskLevel, Severity, Verdict,
} from '@/types.diagnostic';

type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'neutral';

const SEVERITY_DEF: Record<Severity, { label: string; tone: Tone }> = {
  CRITICAL: { label: 'Critique', tone: 'danger' },
  HIGH: { label: 'Élevé', tone: 'danger' },
  MEDIUM: { label: 'Moyen', tone: 'warn' },
  LOW: { label: 'Faible', tone: 'neutral' },
  INFO: { label: 'Information', tone: 'muted' },
};

const PRIORITY_DEF: Record<Priority, { label: string; tone: Tone }> = {
  CRITICAL: { label: 'Critique', tone: 'danger' },
  URGENT: { label: 'Urgent', tone: 'danger' },
  FIX: { label: 'À corriger', tone: 'warn' },
  WATCH: { label: 'À surveiller', tone: 'neutral' },
};

const RISK_DEF: Record<RiskLevel, { label: string; tone: Tone }> = {
  CRITICAL: { label: 'Critique', tone: 'danger' },
  HIGH: { label: 'Élevé', tone: 'danger' },
  MEDIUM: { label: 'Moyen', tone: 'warn' },
  LOW: { label: 'Faible', tone: 'neutral' },
  INFO: { label: 'Information', tone: 'muted' },
};

const VERDICT_DEF: Record<Verdict, { label: string; tone: Tone }> = {
  COMPATIBLE: { label: 'Compatible', tone: 'ok' },
  COMPATIBLE_WITH_WARNING: { label: 'Compatible, avec réserve', tone: 'warn' },
  MIGRATION_AVAILABLE: { label: 'Mise à jour disponible', tone: 'warn' },
  VERSION_AHEAD: { label: 'Projet en avance', tone: 'warn' },
  VERSION_TOO_OLD: { label: 'Version trop ancienne', tone: 'danger' },
  INCOMPATIBLE: { label: 'Incompatible', tone: 'danger' },
  UNKNOWN: { label: 'Inconnu', tone: 'muted' },
};

const STATE_DEF: Record<CriterionState, { label: string; tone: Tone }> = {
  PASS: { label: 'OK', tone: 'ok' },
  WARN: { label: 'Réserve', tone: 'warn' },
  FAIL: { label: 'Échec', tone: 'danger' },
  UNKNOWN: { label: 'Inconnu', tone: 'muted' },
  SKIP: { label: 'Non applicable', tone: 'muted' },
};

const READINESS_DEF: Record<ReadinessLevel, { label: string; tone: Tone }> = {
  READY: { label: 'Prêt', tone: 'ok' },
  NEARLY_READY: { label: 'Presque prêt', tone: 'warn' },
  PARTIAL: { label: 'Partiel', tone: 'warn' },
  NOT_READY: { label: 'Non prêt', tone: 'danger' },
  BLOCKED: { label: 'Bloqué', tone: 'danger' },
};

const badge = (def: { label: string; tone: Tone }) => (
  <span className={`badge badge-${def.tone}`}>{def.label}</span>
);

export const SeverityBadge = ({ value }: { value: Severity }) => badge(SEVERITY_DEF[value]);
export const PriorityBadge = ({ value }: { value: Priority }) => badge(PRIORITY_DEF[value]);
export const RiskBadge = ({ value }: { value: RiskLevel }) => badge(RISK_DEF[value]);
export const VerdictBadge = ({ value }: { value: Verdict }) => badge(VERDICT_DEF[value]);
export const StateBadge = ({ value }: { value: CriterionState }) => badge(STATE_DEF[value]);
export const ReadinessBadge = ({ value }: { value: ReadinessLevel }) => badge(READINESS_DEF[value]);

/**
 * Jauge de préparation. La couleur suit le niveau, jamais le score brut :
 * un projet bloqué reste rouge même si son score calculé est correct.
 */
export function ReadinessGauge({ score, level, hint }: {
  score: number; level: ReadinessLevel; hint?: string;
}) {
  const tone = READINESS_DEF[level].tone;
  return (
    <div className="readiness-gauge">
      <div className="readiness-head">
        <span className={`readiness-score readiness-${tone}`}>{score}<span className="readiness-unit"> %</span></span>
        <ReadinessBadge value={level} />
      </div>
      <div className="readiness-bar" role="img" aria-label={`Préparation : ${score} %`}>
        <div className={`readiness-fill readiness-fill-${tone}`} style={{ width: `${Math.max(2, score)}%` }} />
      </div>
      {hint ? <p className="readiness-hint">{hint}</p> : null}
    </div>
  );
}

/** Effort estimé — grossier et assumé, il sert à ordonner. */
export function EffortTag({ value }: { value: string }) {
  const labels: Record<string, string> = {
    TRIVIAL: 'effort minime', SMALL: 'effort limité',
    MEDIUM: 'effort moyen', LARGE: 'chantier',
  };
  return <span className="effort-tag">{labels[value] ?? value}</span>;
}

/**
 * Bloc « pourquoi ? » — la justification d'un diagnostic. C'est l'élément
 * qui matérialise la promesse de la phase : aucun verdict sans explication.
 */
export function Why({ children }: { children: ReactNode }) {
  return (
    <p className="why">
      <span className="why-label">Pourquoi</span>
      <span className="why-text">{children}</span>
    </p>
  );
}
