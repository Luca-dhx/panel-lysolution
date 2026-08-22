import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '@/components/Icon';
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

/**
 * ── CASE À COCHER — LA SEULE DU PANEL ────────────────────────────────────
 *
 * ══ CE QU’ELLE REMPLACE, ET POURQUOI ═════════════════════════════════════
 *
 * Un `<input type="checkbox">` nu. Sa case est dessinée par le système
 * d’exploitation : elle ignore le thème éditable du Panel — ses couleurs,
 * son rayon, sa taille — exactement comme le faisait le `<select>` natif
 * remplacé par `ThemedSelect`. Sur un thème sombre, la case restait un carré
 * clair, et rien en CSS ne peut y remédier de façon portable.
 *
 * ══ CE QU’ELLE N’EST PAS ═════════════════════════════════════════════════
 *
 * Ce n’est PAS un second `Switch`. Les deux se ressemblent à l’écran et ne
 * disent pas la même chose :
 *
 *   Switch    un RÉGLAGE distant — il part sur le réseau, il attend une
 *             confirmation, il peut échouer. D’où son état « en cours ».
 *   Checkbox  un CHOIX LOCAL, immédiat et sans conséquence — un filtre
 *             d’affichage, une option de formulaire pas encore enregistrée.
 *
 * Utiliser un interrupteur pour un filtre promettrait un aller-retour qui
 * n’existe pas ; utiliser une case pour un réglage distant ferait croire
 * l’affaire faite avant qu’elle le soit.
 *
 * ══ L’ACCESSIBILITÉ N’EST PAS UNE OPTION ═════════════════════════════════
 *
 * L’`<input>` natif est CONSERVÉ, simplement rendu invisible : c’est lui qui
 * porte l’état, le focus, la touche Espace, la participation au formulaire
 * et l’annonce par les lecteurs d’écran. Seule sa PEINTURE est reprise. Un
 * `<div role="checkbox">` aurait exigé de réécrire tout cela à la main — et
 * d’oublier au moins une chose.
 *
 * Le `<label>` enveloppe l’ensemble : le libellé est donc cliquable sans
 * qu’aucun `htmlFor` ne doive être tenu à jour.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Toujours fourni : une case sans libellé n’est pas annonçable. */
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? 'checkbox checkbox-disabled' : 'checkbox'}>
      <input
        type="checkbox"
        className="checkbox-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {/*
        LA MARQUE EST DÉCORATIVE — `aria-hidden`. L’état est déjà porté par
        l’`<input>` : l’annoncer une seconde fois ferait entendre la case
        deux fois.
      */}
      <span className="checkbox-box" aria-hidden="true">
        <Icon name="check2" size={12} className="checkbox-mark" />
      </span>
      <span className="checkbox-text">
        <span className="checkbox-label">{label}</span>
        {hint ? <span className="checkbox-hint">{hint}</span> : null}
      </span>
    </label>
  );
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
