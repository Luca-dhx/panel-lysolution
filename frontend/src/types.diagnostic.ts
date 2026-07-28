// Types de la surface de diagnostic (/api/diagnostic) — Phase 3B.
// Miroir des projections du backend. Lecture seule : aucun type ne décrit
// une action exécutable — `futureAction` est une étiquette, pas un appel.

export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Priority = 'WATCH' | 'FIX' | 'URGENT' | 'CRITICAL';
export type RiskLevel = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Verdict =
  | 'COMPATIBLE' | 'COMPATIBLE_WITH_WARNING' | 'MIGRATION_AVAILABLE'
  | 'VERSION_AHEAD' | 'VERSION_TOO_OLD' | 'INCOMPATIBLE' | 'UNKNOWN';
export type CriterionState = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN' | 'SKIP';
export type ReadinessLevel = 'READY' | 'NEARLY_READY' | 'PARTIAL' | 'NOT_READY' | 'BLOCKED';

export interface Recommendation {
  id: string;
  action: string;
  benefit: string;
  risk: string;
  prerequisites: string[];
  futureAction: string;
  effort: 'TRIVIAL' | 'SMALL' | 'MEDIUM' | 'LARGE';
  category: string;
  priority: Priority;
  leverage: number;
  reasons: Array<{ diagnosticId: string; severity: Severity; justification: string }>;
  projectCount?: number;
  projects?: Array<{ projectId: string; projectName: string }>;
}

export interface Diagnostic {
  id: string;
  ruleId: string;
  category: string;
  component: string;
  severity: Severity;
  title: string;
  description: string;
  justification: string;
  origin: string;
  impact: string;
  recommendation: Omit<Recommendation, 'id' | 'effort' | 'category' | 'priority' | 'leverage' | 'reasons'> | null;
  priority: Priority;
  evaluatedAt: string;
}

export interface CompatibilityAxis {
  axis: string;
  label: string;
  verdict: Verdict;
  reason: string;
  actual: string | null;
  reference: string | null;
}

export interface Compatibility {
  verdict: Verdict;
  blocking: boolean;
  axes: CompatibilityAxis[];
  reason: string;
}

export interface ReadinessCriterion {
  id: string;
  label: string;
  weight: number;
  blocking: boolean;
  state: CriterionState;
  reason: string;
  contribution: number | null;
}

export interface Readiness {
  score: number;
  rawScore: number;
  level: ReadinessLevel;
  blockedBy: Array<{ id: string; label: string; reason: string }>;
  criteria: ReadinessCriterion[];
  formula: {
    description: string;
    factors: Record<string, number>;
    earnedWeight: number;
    totalWeight: number;
    skipped: string[];
    ceilingApplied: number | null;
  };
  evaluatedAt: string;
}

export interface Risk {
  id: string;
  ruleId: string;
  title: string;
  category: string;
  component: string;
  level: RiskLevel;
  score: number;
  probability: number;
  probabilityReason: string;
  impact: number;
  impactReason: string;
  exposure: string;
  justification: string;
  projectId?: string | null;
  projectName?: string | null;
}

export interface RiskSummary {
  items: Risk[];
  total: number;
  highest: RiskLevel | null;
  aggregate: number;
  byLevel: { critical: number; high: number; medium: number; low: number; info: number };
}

export interface DiagnosticSummary {
  healthStatus: string;
  liveness: string;
  priority: Priority;
  readinessScore: number;
  readinessLevel: ReadinessLevel;
  compatibilityVerdict: Verdict;
  compatibilityBlocking: boolean;
  diagnosticCount: number;
  blockingCount: number;
  highestRisk: RiskLevel | null;
  explanation: string;
  compatibilityExplanation: string;
  readinessExplanation: string;
}

export interface ProjectDiagnostic {
  projectId: string;
  projectName: string;
  slug: string;
  environment: string | null;
  summary: DiagnosticSummary;
  diagnostics: Diagnostic[];
  compatibility: Compatibility;
  readiness: Readiness;
  risks: RiskSummary;
  recommendations: Recommendation[];
  priority: Priority;
  evaluatedAt: string;
}

export interface FleetDiagnostic {
  generatedAt: string;
  projects: number;
  readiness: {
    average: number | null;
    level: ReadinessLevel | null;
    projects: number;
    blocked: number;
    distribution: Record<string, number>;
  };
  compatibility: {
    verdict: Verdict;
    projects: number;
    blocking: number;
    spreads: Array<{ axis: string; values: string[] }>;
    fragmented: string[];
    majorSplits: string[];
    reason: string;
  };
  risks: RiskSummary & { top: Risk[] };
  recommendations: { total: number; top: Recommendation[] };
  priorities: { critical: number; urgent: number; fix: number; watch: number };
  queue: Array<{
    projectId: string;
    projectName: string;
    slug: string;
    environment: string | null;
    priority: Priority;
    readinessScore: number;
    readinessLevel: ReadinessLevel;
    compatibilityVerdict: Verdict;
    highestRisk: RiskLevel | null;
    diagnosticCount: number;
    aggregateRisk: number;
  }>;
}
