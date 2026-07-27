const DATE_TIME = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const RELATIVE = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_TIME.format(date);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < MINUTE) return RELATIVE.format(Math.round(diff / 1000), 'second');
  if (abs < HOUR) return RELATIVE.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return RELATIVE.format(Math.round(diff / HOUR), 'hour');
  return RELATIVE.format(Math.round(diff / DAY), 'day');
}

export function majorVersion(version: string | null | undefined): number | null {
  if (!version) return null;
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}
