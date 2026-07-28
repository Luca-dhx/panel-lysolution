// Composants de supervision — même design system que le reste du Panel
// (badges, cartes, listes de définitions). Aucun composant ici ne déclenche
// d'action : la Phase 3A est en lecture seule.
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { HealthLevel, Liveness, Severity } from '@/types.supervision';

type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'neutral';

const LIVENESS_TONE: Record<Liveness, { label: string; tone: Tone }> = {
  ONLINE: { label: 'En ligne', tone: 'ok' },
  STALE: { label: 'Signal périmé', tone: 'warn' },
  OFFLINE: { label: 'Hors ligne', tone: 'danger' },
  NEVER_SEEN: { label: 'Jamais vu', tone: 'muted' },
  NOT_PAIRED: { label: 'Non appairé', tone: 'neutral' },
};

const HEALTH_TONE: Record<HealthLevel, { label: string; tone: Tone }> = {
  OK: { label: 'OK', tone: 'ok' },
  WARNING: { label: 'Attention', tone: 'warn' },
  ERROR: { label: 'Erreur', tone: 'danger' },
  UNKNOWN: { label: 'Inconnu', tone: 'muted' },
};

const SEVERITY_TONE: Record<Severity, Tone> = { ERROR: 'danger', WARNING: 'warn', INFO: 'neutral' };

export function LivenessBadge({ value }: { value: Liveness }) {
  const def = LIVENESS_TONE[value];
  return <span className={`badge badge-${def.tone}`}>{def.label}</span>;
}

export function HealthBadge({ value }: { value: HealthLevel }) {
  const def = HEALTH_TONE[value];
  return <span className={`badge badge-${def.tone}`}>{def.label}</span>;
}

export function SeverityBadge({ value }: { value: Severity }) {
  return <span className={`badge badge-${SEVERITY_TONE[value]}`}>{value}</span>;
}

/**
 * Indicateur clé du tableau de bord. `tone` colore uniquement quand la valeur
 * mérite l'attention : un parc sain reste visuellement calme.
 */
export function Metric({ value, label, tone, hint }: {
  value: ReactNode; label: string; tone?: Tone; hint?: string;
}) {
  return (
    <div className={tone ? `metric metric-${tone}` : 'metric'}>
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
      {hint ? <span className="metric-hint">{hint}</span> : null}
    </div>
  );
}

/**
 * Bloc dépliable — le ressort de la divulgation progressive : le détail
 * existe, mais ne s'impose pas. Repliés par défaut, ces blocs gardent une
 * fiche projet lisible même quand elle contient tout.
 */
export function Disclosure({ title, hint, children, defaultOpen = false, onOpen }: {
  title: string; hint?: string; children: ReactNode; defaultOpen?: boolean; onOpen?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Le contenu n'est chargé qu'à la première ouverture : c'est ce qui rend
    // la fiche tenable sur un grand parc.
    if (next) onOpen?.();
  };
  return (
    <section className="disclosure">
      <button type="button" className="disclosure-header" onClick={toggle} aria-expanded={open}>
        <span className="disclosure-chevron">{open ? '▾' : '▸'}</span>
        <span className="disclosure-title">{title}</span>
        {hint ? <span className="disclosure-hint">{hint}</span> : null}
      </button>
      {open ? <div className="disclosure-body">{children}</div> : null}
    </section>
  );
}

/** Liste de définitions — le format de lecture par défaut du Panel. */
export function DetailList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="detail-list">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Valeur absente : jamais un blanc muet, toujours un « inconnu » explicite. */
export function Unknown({ reason }: { reason?: string }) {
  return <span className="muted" title={reason}>inconnu</span>;
}

export function orUnknown(value: string | number | null | undefined, reason?: string) {
  return value === null || value === undefined || value === '' ? <Unknown reason={reason} /> : value;
}

/** Durée lisible à partir de secondes. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} j ${hours % 24} h`;
}

/** Répartition compacte { valeur: nombre } — utilisée pour les versions. */
export function Distribution({ data, emptyLabel = 'Aucune donnée publiée.' }: {
  data: Record<string, number>; emptyLabel?: string;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <p className="muted">{emptyLabel}</p>;
  return (
    <ul className="distribution">
      {entries.map(([value, count]) => (
        <li key={value}>
          <code>{value}</code>
          <span className="distribution-count">{count}</span>
        </li>
      ))}
    </ul>
  );
}
