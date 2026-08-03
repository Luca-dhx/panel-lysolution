/**
 * SÉLECTEURS DE DATE ET D'HEURE — cohérents avec le reste du Panel.
 *
 * ── POURQUOI PAS LE CHAMP NATIF ─────────────────────────────────────────────
 * `<input type="datetime-local">` change complètement d'apparence et de langue
 * selon le navigateur et le système : en anglais chez l'un, avec un calendrier
 * bleu système chez l'autre, illisible sur un mobile ancien. Un produit qui
 * soigne le reste de son interface ne peut pas laisser son champ le plus
 * utilisé ressembler à autre chose sur chaque poste.
 *
 * ── CE QU'ON N'A PAS FAIT ───────────────────────────────────────────────────
 * Aucune bibliothèque de dates n'a été ajoutée. Un calendrier mensuel se
 * calcule en une vingtaine de lignes ; importer trois cents kilo-octets pour
 * cela reviendrait à payer un abonnement pour une addition.
 *
 * ── FUSEAU HORAIRE ──────────────────────────────────────────────────────────
 * Tout se saisit et s'affiche dans le fuseau du NAVIGATEUR, et part en ISO
 * (UTC). Ce que l'utilisateur lit est donc toujours son heure locale ; ce que
 * la base stocke est toujours un instant absolu.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

const JOURS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const MOIS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

const deuxChiffres = (n: number) => String(n).padStart(2, '0');

/** `Date` → `AAAA-MM-JJ` en heure LOCALE (jamais `toISOString`, qui décale). */
export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${deuxChiffres(d.getMonth() + 1)}-${deuxChiffres(d.getDate())}`;
}

/** Lundi = 0. Le calendrier français ne commence pas le dimanche. */
function premierJourSemaine(annee: number, mois: number): number {
  return (new Date(annee, mois, 1).getDay() + 6) % 7;
}

function grille(annee: number, mois: number): (number | null)[] {
  const jours = new Date(annee, mois + 1, 0).getDate();
  const decalage = premierJourSemaine(annee, mois);
  return [
    ...Array.from({ length: decalage }, () => null),
    ...Array.from({ length: jours }, (_, i) => i + 1),
  ];
}

/* ── DATE ─────────────────────────────────────────────────────────────────── */

export function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;            // AAAA-MM-JJ
  onChange: (v: string) => void;
}) {
  const [ouvert, setOuvert] = useState(false);
  const boite = useRef<HTMLDivElement>(null);

  const selection = useMemo(() => (value ? new Date(`${value}T12:00:00`) : null), [value]);
  const [curseur, setCurseur] = useState(() => selection ?? new Date());

  useEffect(() => { if (selection) setCurseur(selection); }, [value]);

  // Un calendrier ouvert doit se fermer quand on clique ailleurs ou qu'on
  // appuie sur Échap — sinon il reste posé sur le formulaire.
  useEffect(() => {
    if (!ouvert) return undefined;
    const dehors = (e: MouseEvent) => {
      if (boite.current && !boite.current.contains(e.target as Node)) setOuvert(false);
    };
    const clavier = (e: KeyboardEvent) => { if (e.key === 'Escape') setOuvert(false); };
    document.addEventListener('mousedown', dehors);
    document.addEventListener('keydown', clavier);
    return () => {
      document.removeEventListener('mousedown', dehors);
      document.removeEventListener('keydown', clavier);
    };
  }, [ouvert]);

  const annee = curseur.getFullYear();
  const mois = curseur.getMonth();
  const aujourdhui = toDateKey(new Date());

  const choisir = (jour: number) => {
    onChange(toDateKey(new Date(annee, mois, jour)));
    setOuvert(false);
  };

  const lisible = selection
    ? selection.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : 'Choisir une date';

  return (
    <div className="field picker" ref={boite}>
      <span className="field-label">{label}</span>
      <button
        type="button"
        className="picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        onClick={() => setOuvert((o) => !o)}
      >
        {lisible}
      </button>

      {ouvert ? (
        <div className="picker-popover" role="dialog" aria-label="Calendrier">
          <div className="picker-head">
            <button
              type="button"
              className="picker-nav"
              aria-label="Mois précédent"
              onClick={() => setCurseur(new Date(annee, mois - 1, 1))}
            >
              ‹
            </button>
            <span className="picker-title">{MOIS[mois]} {annee}</span>
            <button
              type="button"
              className="picker-nav"
              aria-label="Mois suivant"
              onClick={() => setCurseur(new Date(annee, mois + 1, 1))}
            >
              ›
            </button>
          </div>

          <div className="picker-grid picker-weekdays">
            {JOURS.map((j, i) => <span key={`${j}${i}`}>{j}</span>)}
          </div>

          <div className="picker-grid">
            {grille(annee, mois).map((jour, i) => {
              if (jour === null) return <span key={`v${i}`} />;
              const cle = toDateKey(new Date(annee, mois, jour));
              const classes = ['picker-day'];
              if (cle === value) classes.push('picker-day-selected');
              if (cle === aujourdhui) classes.push('picker-day-today');
              return (
                <button
                  key={cle}
                  type="button"
                  className={classes.join(' ')}
                  aria-current={cle === aujourdhui ? 'date' : undefined}
                  onClick={() => choisir(jour)}
                >
                  {jour}
                </button>
              );
            })}
          </div>

          <div className="picker-foot">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => { onChange(aujourdhui); setOuvert(false); }}
            >
              Aujourd’hui
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── HEURE ────────────────────────────────────────────────────────────────── */

/**
 * Heure par pas de cinq minutes.
 *
 * Un rendez-vous ne se prend pas à la minute près, et une liste de 1440 choix
 * serait inutilisable. Le champ reste saisissable au clavier pour les cas
 * particuliers.
 */
export function TimeField({
  label,
  value,
  onChange,
  step = 5,
}: {
  label: string;
  value: string;            // HH:MM
  onChange: (v: string) => void;
  step?: number;
}) {
  const options = useMemo(() => {
    const liste: string[] = [];
    for (let m = 0; m < 24 * 60; m += step) {
      liste.push(`${deuxChiffres(Math.floor(m / 60))}:${deuxChiffres(m % 60)}`);
    }
    return liste;
  }, [step]);

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        list="panel-heures"
        value={value}
        placeholder="14:30"
        onChange={(e) => onChange(e.target.value)}
        className="picker-time"
      />
      <datalist id="panel-heures">
        {options.map((h) => <option key={h} value={h} />)}
      </datalist>
    </label>
  );
}

/* ── DURÉE ────────────────────────────────────────────────────────────────── */

const DUREES = [15, 30, 45, 60, 90, 120, 180];

export function DurationField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const lisible = (m: number) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="chip-row">
        {DUREES.map((d) => (
          <button
            key={d}
            type="button"
            className={d === value ? 'chip chip-active' : 'chip'}
            onClick={() => onChange(d)}
          >
            {lisible(d)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── ASSEMBLAGE ───────────────────────────────────────────────────────────── */

/** Découpe un instant ISO en date et heure LOCALES, pour les deux champs. */
export function splitIso(iso: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return { date: toDateKey(d), time: `${deuxChiffres(d.getHours())}:${deuxChiffres(d.getMinutes())}` };
}

/** Recompose un instant ISO à partir d'une date et d'une heure locales. */
export function joinIso(date: string, time: string): string | null {
  if (!date || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  const [h, m] = time.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  const [a, mo, j] = date.split('-').map(Number);
  const d = new Date(a, mo - 1, j, h, m, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
