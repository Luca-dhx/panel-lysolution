// Composants de PILOTAGE — Phase 3C. Mêmes jetons de design que le reste.
//
// Deux principes tiennent toute cette couche :
//
//  1. AUCUN refus muet. Un bouton désactivé sans explication serait un
//     « Action refusée. » déguisé. Ici, un refus s'accompagne toujours de ses
//     causes, énoncées telles que le moteur les a formulées.
//
//  2. AUCUNE décision côté navigateur. Ce composant n'évalue aucune
//     politique, ne devine aucun état : il affiche ce que le moteur renvoie.
//     Deux interfaces différentes montreraient exactement la même chose.
import type { ReactNode } from 'react';
import type {
  Denial, ExecutionMode, ExecutionState, LogEntry, PlanStep, PolicyCheck, Risk,
} from '@/types.execution';

type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'neutral';

const STATE_DEF: Record<ExecutionState, { label: string; tone: Tone }> = {
  CREATED: { label: 'Créée', tone: 'neutral' },
  WAITING_CONFIRMATION: { label: 'Attend confirmation', tone: 'warn' },
  QUEUED: { label: 'En file', tone: 'neutral' },
  RUNNING: { label: 'En cours', tone: 'warn' },
  SUCCEEDED: { label: 'Réussie', tone: 'ok' },
  FAILED: { label: 'Échouée', tone: 'danger' },
  CANCELLED: { label: 'Annulée', tone: 'muted' },
  ROLLED_BACK: { label: 'Compensée', tone: 'warn' },
  TIMEOUT: { label: 'Délai dépassé', tone: 'danger' },
};

const RISK_DEF: Record<Risk, { label: string; tone: Tone }> = {
  NONE: { label: 'Sans risque', tone: 'ok' },
  LOW: { label: 'Risque faible', tone: 'neutral' },
  MEDIUM: { label: 'Risque moyen', tone: 'warn' },
  HIGH: { label: 'Risque élevé', tone: 'danger' },
  CRITICAL: { label: 'Risque critique', tone: 'danger' },
};

const MODE_DEF: Record<ExecutionMode, { label: string; tone: Tone }> = {
  SIMULATION: { label: 'Simulation', tone: 'neutral' },
  EXECUTION: { label: 'Exécution réelle', tone: 'warn' },
};

const badge = (def: { label: string; tone: Tone }) => (
  <span className={`badge badge-${def.tone}`}>{def.label}</span>
);

export const StateBadge = ({ value }: { value: ExecutionState }) => badge(STATE_DEF[value]);
export const RiskBadge = ({ value }: { value: Risk }) => badge(RISK_DEF[value]);
export const ModeBadge = ({ value }: { value: ExecutionMode }) => badge(MODE_DEF[value]);

/** Durée lisible — une exécution non terminée n'affiche pas de durée fausse. */
export function duration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/**
 * BLOC DE REFUS — la pièce maîtresse de la phase côté interface.
 *
 * Il n'affiche jamais « Action refusée. » seul : chaque cause est reprise
 * avec le mot du moteur, qui contient déjà le « parce que… ».
 */
export function DenialList({ denials, title = 'Cette action est refusée' }: {
  denials: Denial[]; title?: string;
}) {
  if (denials.length === 0) return null;
  return (
    <div className="denial-block">
      <p className="denial-title">
        {title}
        {denials.length > 1 ? ` — ${denials.length} causes` : null}
      </p>
      <ul className="denial-list">
        {denials.map((denial, index) => (
          <li key={`${denial.code}-${index}`}>
            <span className="denial-message">{denial.message}</span>
            <code className="denial-code">{denial.code}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Détail de TOUS les contrôles — y compris ceux qui passent. */
export function CheckList({ checks }: { checks: PolicyCheck[] }) {
  return (
    <ul className="check-list">
      {checks.map((check) => (
        <li key={check.id} className={check.ok ? 'check-ok' : 'check-ko'}>
          <span className="check-mark" aria-hidden>{check.ok ? '✓' : '✗'}</span>
          <span className="check-label">{check.label}</span>
          <span className="check-message">{check.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Le plan d'une simulation : ce qui SERAIT fait, étape par étape. */
export function PlanList({ steps }: { steps: PlanStep[] }) {
  return (
    <ol className="plan-list">
      {steps.map((step, index) => (
        <li key={`${step.step}-${index}`}>
          <code className="plan-step">{step.step}</code>
          <span className="plan-description">{step.description}</span>
        </li>
      ))}
    </ol>
  );
}

/** Journal d'exécution — la pièce d'audit, affichée telle quelle. */
export function LogView({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return <p className="muted">Aucune entrée de journal.</p>;
  return (
    <ol className="log-view">
      {entries.map((entry, index) => (
        <li key={index} className={`log-${entry.level.toLowerCase()}`}>
          <time className="log-at" dateTime={entry.at}>{entry.at.slice(11, 19)}</time>
          <span className="log-phase">{entry.phase}</span>
          <span className="log-message">{entry.message}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Avertissement de mode. La simulation est le défaut ; passer en réel doit
 * rester un acte visible, jamais un glissement.
 */
export function ModeNotice({ mode, children }: { mode: ExecutionMode; children?: ReactNode }) {
  if (mode === 'SIMULATION') {
    return (
      <p className="mode-notice mode-simulation">
        Mode simulation : rien ne sera modifié sur la cible. {children}
      </p>
    );
  }
  return (
    <p className="mode-notice mode-execution">
      Exécution réelle : cette action agira sur la cible. {children}
    </p>
  );
}
