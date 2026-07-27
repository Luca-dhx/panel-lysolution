import { useState } from 'react';
import type { ReactNode } from 'react';
import type { HealthStatus, Liveness, PairingStatus } from '@/types';

type BadgeTone = 'ok' | 'warn' | 'danger' | 'muted' | 'neutral';

interface BadgeDef {
  label: string;
  tone: BadgeTone;
}

const PAIRING_BADGES: Record<PairingStatus, BadgeDef> = {
  DECLARED: { label: 'Déclaré', tone: 'neutral' },
  PAIRED: { label: 'Appairé', tone: 'ok' },
  REVOKED: { label: 'Révoqué', tone: 'danger' },
};

const LIVENESS_BADGES: Record<Liveness, BadgeDef> = {
  NOT_PAIRED: { label: 'Non appairé', tone: 'neutral' },
  NEVER_SEEN: { label: 'Jamais vu', tone: 'muted' },
  ONLINE: { label: 'En ligne', tone: 'ok' },
  STALE: { label: 'Signal périmé', tone: 'warn' },
  OFFLINE: { label: 'Hors ligne', tone: 'danger' },
};

const HEALTH_BADGES: Record<HealthStatus, BadgeDef> = {
  OK: { label: 'OK', tone: 'ok' },
  DEGRADED: { label: 'Dégradé', tone: 'warn' },
};

type StatusBadgeProps =
  | { kind: 'pairing'; value: PairingStatus }
  | { kind: 'liveness'; value: Liveness }
  | { kind: 'health'; value: HealthStatus };

export function StatusBadge(props: StatusBadgeProps) {
  let def: BadgeDef;
  switch (props.kind) {
    case 'pairing':
      def = PAIRING_BADGES[props.value];
      break;
    case 'liveness':
      def = LIVENESS_BADGES[props.value];
      break;
    case 'health':
      def = HEALTH_BADGES[props.value];
      break;
  }
  return <span className={`badge badge-${def.tone}`}>{def.label}</span>;
}

interface CardProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Card({ title, children, className }: CardProps) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {title ? <h2 className="card-title">{title}</h2> : null}
      {children}
    </section>
  );
}

interface EmptyStateProps {
  title: string;
  hint?: string;
}

export function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {hint ? <p className="empty-state-hint">{hint}</p> : null}
    </div>
  );
}

interface CopyFieldProps {
  value: string;
  label?: string;
}

export function CopyField({ value, label }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers indisponible : l'utilisateur peut copier manuellement.
    }
  };

  return (
    <div className="copy-field">
      {label ? <span className="copy-field-label">{label}</span> : null}
      <code className="copy-field-value">{value}</code>
      <button type="button" className="btn btn-small" onClick={() => void copy()}>
        {copied ? 'Copié !' : 'Copier'}
      </button>
    </div>
  );
}
