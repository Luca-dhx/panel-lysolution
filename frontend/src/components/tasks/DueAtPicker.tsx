/**
 * L'ÉCHÉANCE — un jour, une heure, ou rien du tout.
 *
 * ══ POURQUOI TROIS CHEMINS VERS LA MÊME VALEUR ══════════════════════════════
 *
 * Parce qu'on ne pose pas une échéance de la même façon selon ce qu'on sait :
 *
 *   les RACCOURCIS     « demain matin », « vendredi » — le cas le plus fréquent,
 *                      et celui où ouvrir un calendrier fait perdre du temps ;
 *   le CALENDRIER      quand la date est précise et lointaine ;
 *   l'HEURE            toujours à côté, parce qu'une échéance sans heure se
 *                      compare mal — « mardi » est-il dépassé mardi à 00 h 01 ?
 *
 * ══ L'HEURE PAR DÉFAUT EST 18 H, ET C'EST UN CHOIX ═════════════════════════
 *
 * Minuit ferait basculer la tâche « en retard » la veille au soir, en pleine
 * journée de travail. Midi la ferait basculer à l'heure du déjeuner. Dix-huit
 * heures est la fin de journée ouvrée : une tâche « pour mardi » devient en
 * retard mardi soir, ce qui est le sens qu'on lui donne en la posant.
 *
 * ══ « SANS ÉCHÉANCE » EST UN ÉTAT, PAS UN CHAMP VIDE ═══════════════════════
 *
 * Il a son propre bouton, à côté des raccourcis. Effacer un champ pour dire
 * « un jour, peut-être » est ambigu — on ne sait pas si c'est un choix ou un
 * oubli.
 */
import { useMemo } from 'react';
import { CalendarDate, getLocalTimeZone, today } from '@internationalized/date';
import type { DateValue } from 'react-aria-components';
import { Button } from '@/components/base/buttons/button';
import { Calendar } from '@/components/application/date-picker/calendar';
import { Input } from '@/components/base/input/input';
import { formatDueAt } from '@/lib/taskTime';

/** L'heure de fin de journée ouvrée. Voir l'en-tête. */
const HEURE_PAR_DEFAUT = 18;

function aLHeure(date: Date, heures: number, minutes: number): Date {
  const copie = new Date(date);
  copie.setHours(heures, minutes, 0, 0);
  return copie;
}

/**
 * LES RACCOURCIS.
 *
 * Ils sont calculés à l'appel, jamais figés dans une constante : « demain »
 * dépend du jour où l'on clique, et un module chargé lundi servirait encore
 * lundi le vendredi suivant.
 */
function raccourcis(maintenant: Date): { label: string; valeur: Date }[] {
  const jour = (delta: number) => {
    const d = new Date(maintenant);
    d.setDate(d.getDate() + delta);
    return d;
  };

  /* Le prochain lundi : 7 jours au maximum, jamais aujourd'hui même si l'on est
     lundi — « lundi prochain » ne veut pas dire « dans une heure ». */
  const lundi = new Date(maintenant);
  const versLundi = ((8 - lundi.getDay()) % 7) || 7;
  lundi.setDate(lundi.getDate() + versLundi);

  return [
    { label: 'Ce soir', valeur: aLHeure(maintenant, HEURE_PAR_DEFAUT, 0) },
    { label: 'Demain 9 h', valeur: aLHeure(jour(1), 9, 0) },
    { label: 'Dans 3 jours', valeur: aLHeure(jour(3), HEURE_PAR_DEFAUT, 0) },
    { label: 'Lundi prochain', valeur: aLHeure(lundi, 9, 0) },
  ];
}

export interface DueAtPickerProps {
  /** ISO, ou `null` pour « sans échéance ». */
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
}

export function DueAtPicker({ value, onChange, label = 'Échéance' }: DueAtPickerProps) {
  const courant = value ? new Date(value) : null;
  const valide = courant && !Number.isNaN(courant.getTime()) ? courant : null;

  const presets = useMemo(() => raccourcis(new Date()), []);

  /*
    LE CALENDRIER PARLE EN DATES CIVILES, PAS EN INSTANTS.
    `CalendarDate` n'a ni heure ni fuseau — c'est exactement ce qu'il faut pour
    une grille de jours. L'heure vit dans son propre champ, et les deux ne se
    recomposent qu'au moment d'écrire la valeur.
  */
  const jourSelectionne: DateValue | null = valide
    ? new CalendarDate(valide.getFullYear(), valide.getMonth() + 1, valide.getDate())
    : null;

  const heure = valide
    ? `${String(valide.getHours()).padStart(2, '0')}:${String(valide.getMinutes()).padStart(2, '0')}`
    : `${String(HEURE_PAR_DEFAUT).padStart(2, '0')}:00`;

  const changerJour = (jour: DateValue | null) => {
    if (!jour) { onChange(null); return; }
    const [h, m] = heure.split(':').map((n) => Number.parseInt(n, 10));
    const date = jour.toDate(getLocalTimeZone());
    onChange(aLHeure(date, Number.isFinite(h) ? h : HEURE_PAR_DEFAUT, Number.isFinite(m) ? m : 0).toISOString());
  };

  const changerHeure = (saisie: string) => {
    const [h, m] = saisie.split(':').map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(h)) return;
    /* Changer l'heure sans avoir choisi de jour vise AUJOURD'HUI : c'est le
       seul jour dont on peut être sûr qu'il est voulu. */
    const base = valide ?? new Date();
    onChange(aLHeure(base, h, Number.isFinite(m) ? m : 0).toISOString());
  };

  return (
    <div className="uui flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-secondary">{label}</span>
        <span className="text-xs text-tertiary">
          {valide ? formatDueAt(valide.toISOString()) : 'Sans échéance'}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Button
            key={p.label}
            size="sm"
            color="secondary"
            onClick={() => onChange(p.valeur.toISOString())}
          >
            {p.label}
          </Button>
        ))}
        <Button
          size="sm"
          color={value === null ? 'primary' : 'link-gray'}
          onClick={() => onChange(null)}
        >
          Sans échéance
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="rounded-lg border border-secondary p-3">
          <Calendar
            aria-label="Jour de l’échéance"
            value={jourSelectionne}
            onChange={changerJour}
            minValue={today(getLocalTimeZone()).subtract({ years: 1 })}
          >
            {null}
          </Calendar>
        </div>

        <div className="sm:w-40">
          <Input
            type="time"
            label="Heure"
            value={heure}
            onChange={changerHeure}
            isDisabled={!valide}
            hint={valide ? undefined : 'Choisissez d’abord un jour.'}
          />
        </div>
      </div>
    </div>
  );
}

export default DueAtPicker;
