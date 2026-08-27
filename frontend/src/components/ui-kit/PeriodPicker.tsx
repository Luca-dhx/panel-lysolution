/**
 * LE CHOIX DE PÉRIODE — un contrôle segmenté, pas une liste déroulante.
 *
 * ══ POURQUOI SEGMENTÉ ═══════════════════════════════════════════════════════
 *
 * Une période se change SOUVENT, et on compare : « 30 jours », puis « 90 »,
 * puis retour. Une liste déroulante demande deux gestes par changement — ouvrir,
 * choisir — et masque les autres choix pendant qu'on lit. Un contrôle segmenté
 * les montre tous, et un clic suffit.
 *
 * ── IL VIENT DE RADIX, ET C'EST LA RAISON ───────────────────────────────────
 * `SegmentedControl` est un groupe de boutons radio : flèches gauche/droite au
 * clavier, un seul arrêt de tabulation pour le groupe entier, état annoncé.
 * Une rangée de `<button>` faite à la main aurait donné cinq arrêts de
 * tabulation et rien à annoncer.
 *
 * ══ « PERSONNALISÉ » N'EST PAS UN SEGMENT ═══════════════════════════════════
 *
 * Il ouvre deux champs de date, donc il change la HAUTEUR du bandeau. Le
 * glisser parmi les autres aurait fait sauter la mise en page à chaque
 * sélection. Il est donc à part, et les champs n'apparaissent que lorsqu'il est
 * actif.
 *
 * ══ LA PÉRIODE EST UNE DEMANDE, PAS UN CALCUL ═══════════════════════════════
 *
 * Ce composant n'interprète aucune date : il rend une CLEF, et deux bornes
 * quand elles sont saisies. C'est le serveur qui résout la fenêtre, dans son
 * fuseau, et qui la renvoie. Calculer « les 30 derniers jours » ici aurait
 * produit une fenêtre différente de celle des chiffres affichés en dessous.
 */
import { SegmentedControl } from '@radix-ui/themes';
import { RadixScope } from '@/components/radix/RadixScope';
import { cx } from '@/utils/cx';
import type { FinancePeriodKey } from '@/types.finance';

export interface PeriodOption {
  value: FinancePeriodKey;
  /** Court : il doit tenir sur un segment à 390 px. */
  label: string;
  /** Long : l'infobulle et l'annonce vocale. */
  title: string;
}

export const PERIODES: PeriodOption[] = [
  { value: 'LAST_7_DAYS', label: '7 j', title: 'Les 7 derniers jours' },
  { value: 'LAST_30_DAYS', label: '30 j', title: 'Les 30 derniers jours' },
  { value: 'CURRENT_MONTH', label: 'Mois', title: 'Le mois en cours' },
  { value: 'CURRENT_YEAR', label: 'Année', title: 'L’année en cours' },
  { value: 'ALL', label: 'Tout', title: 'Depuis le début' },
];

export function PeriodPicker({
  value,
  onChange,
  start,
  end,
  onStartChange,
  onEndChange,
  options = PERIODES,
  className,
}: {
  value: FinancePeriodKey;
  onChange: (value: FinancePeriodKey) => void;
  start: string;
  end: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  options?: PeriodOption[];
  className?: string;
}) {
  const personnalise = value === 'CUSTOM';

  return (
    <div className={cx('uui flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <RadixScope>
          <SegmentedControl.Root
            size="1"
            value={personnalise ? '' : value}
            onValueChange={(v) => { if (v) onChange(v as FinancePeriodKey); }}
            aria-label="Période"
          >
            {options.map((option) => (
              <SegmentedControl.Item key={option.value} value={option.value} title={option.title}>
                {option.label}
              </SegmentedControl.Item>
            ))}
          </SegmentedControl.Root>
        </RadixScope>

        <button
          type="button"
          aria-pressed={personnalise}
          onClick={() => onChange(personnalise ? 'LAST_30_DAYS' : 'CUSTOM')}
          className={cx(
            'rounded-md px-2.5 py-1 text-xs font-medium ring-1 transition',
            'outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2',
            personnalise
              ? 'bg-brand-solid text-white ring-transparent'
              : 'text-secondary ring-secondary hover:bg-primary_hover',
          )}
        >
          Personnalisé
        </button>
      </div>

      {personnalise ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-tertiary">Du</span>
            <input
              type="date"
              value={start}
              max={end || undefined}
              onChange={(e) => onStartChange(e.target.value)}
              className="rounded-md bg-primary px-2.5 py-1.5 text-sm text-primary ring-1 ring-secondary outline-focus-ring focus-visible:outline-2"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-tertiary">Au (inclus)</span>
            <input
              type="date"
              value={end}
              min={start || undefined}
              onChange={(e) => onEndChange(e.target.value)}
              className="rounded-md bg-primary px-2.5 py-1.5 text-sm text-primary ring-1 ring-secondary outline-focus-ring focus-visible:outline-2"
            />
          </label>
          {/*
            Tant que les deux bornes ne sont pas saisies, la demande est
            incomplète : on le DIT, plutôt que d'envoyer une fenêtre à moitié
            définie que le serveur interpréterait à sa façon.
          */}
          {!start || !end ? (
            <p className="text-xs text-quaternary">
              Renseignez les deux dates pour appliquer la période.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default PeriodPicker;
