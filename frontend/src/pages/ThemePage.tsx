/**
 * THÈME DU PANEL — quatre couleurs, deux polices, un rayon.
 *
 * ── POURQUOI SI PEU DE RÉGLAGES ─────────────────────────────────────────────
 * C'est la convention du thème de la vitrine SB Auto, reprise telle quelle :
 * tout le reste — surfaces, bordures, texte atténué, survols — est DÉRIVÉ en
 * CSS. Douze couleurs à régler à la main produisent, une fois sur deux, un
 * thème incohérent ; quatre couleurs dérivées restent cohérentes par
 * construction.
 *
 * ── APERÇU IMMÉDIAT, ENREGISTREMENT EXPLICITE ───────────────────────────────
 * Chaque modification repeint l'application entière sur-le-champ — c'est le
 * seul moyen de juger un thème. Rien n'est enregistré tant qu'on ne le demande
 * pas, et « Annuler » remet exactement ce qui est en base.
 *
 * ── CONTRASTE ──────────────────────────────────────────────────────────────
 * Un texte qui ne ressort pas de son fond est illisible pour beaucoup de gens.
 * Le rapport est affiché en permanence, et l'enregistrement est refusé sous le
 * seuil — par le serveur, pas seulement par cet écran.
 */
import { Card } from '@/components/ui';
import {
  MIN_CONTRAST,
  PANEL_FONTS,
  contrastRatio,
  useThemeEditor,
} from '@/lib/useTheme';

const COULEURS: { cle: 'background' | 'foreground' | 'primary' | 'accent'; label: string; aide: string }[] = [
  { cle: 'background', label: 'Fond', aide: 'La couleur de base de toutes les pages.' },
  { cle: 'foreground', label: 'Texte', aide: 'Doit ressortir nettement du fond.' },
  { cle: 'primary', label: 'Couleur principale', aide: 'Boutons, liens, éléments actifs.' },
  { cle: 'accent', label: 'Accent', aide: 'Confirmations et états favorables.' },
];

const RAYONS = [
  { valeur: '0rem', label: 'Carré' },
  { valeur: '0.5rem', label: 'Léger' },
  { valeur: '0.75rem', label: 'Doux' },
  { valeur: '1rem', label: 'Rond' },
];

export function ThemePage() {
  const { theme, previsualiser, enregistrer, annuler, reinitialiser, erreur, enCours, modifie } =
    useThemeEditor();

  if (!theme) {
    return <div className="page"><p className="muted">Chargement du thème…</p></div>;
  }

  const contraste = contrastRatio(theme.colors.foreground, theme.colors.background);
  const lisible = contraste >= MIN_CONTRAST;

  const changerCouleur = (cle: string, valeur: string) =>
    previsualiser({ ...theme, colors: { ...theme.colors, [cle]: valeur } });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Thème du Panel</h1>
        <p className="page-description">
          Quatre couleurs suffisent : toutes les nuances en découlent. Les changements
          s’appliquent immédiatement à l’écran, et ne sont conservés qu’une fois enregistrés.
        </p>
      </header>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      <Card title="Couleurs">
        <div className="theme-swatches">
          {COULEURS.map((c) => (
            <label key={c.cle} className="theme-swatch">
              <input
                type="color"
                className="theme-dot"
                value={theme.colors[c.cle]}
                aria-label={c.label}
                onChange={(e) => changerCouleur(c.cle, e.target.value)}
              />
              <span>
                <strong>{c.label}</strong>
                <br />
                <span className="muted">{c.aide}</span>
              </span>
            </label>
          ))}
        </div>

        <p className={lisible ? 'muted' : 'alert alert-warning'}>
          Contraste du texte sur le fond : <strong>{contraste.toFixed(1)}:1</strong>
          {lisible
            ? ' — suffisant pour une lecture confortable.'
            : ` — insuffisant. Il en faut au moins ${MIN_CONTRAST}:1 ;`
              + ' l’enregistrement sera refusé tant que le texte ne ressortira pas assez.'}
        </p>
      </Card>

      <Card title="Formes et polices">
        <div className="field">
          <span className="field-label">Arrondi des cadres</span>
          <div className="chip-row">
            {RAYONS.map((r) => (
              <button
                key={r.valeur}
                type="button"
                className={theme.radius === r.valeur ? 'chip chip-active' : 'chip'}
                onClick={() => previsualiser({ ...theme, radius: r.valeur })}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="event-form">
          <label className="field">
            <span className="field-label">Police des titres</span>
            <select
              value={theme.typography.headingFont}
              onChange={(e) => previsualiser({
                ...theme,
                typography: { ...theme.typography, headingFont: e.target.value },
              })}
            >
              {PANEL_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Police du texte</span>
            <select
              value={theme.typography.bodyFont}
              onChange={(e) => previsualiser({
                ...theme,
                typography: { ...theme.typography, bodyFont: e.target.value },
              })}
            >
              {PANEL_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        </div>
      </Card>

      <Card title="Aperçu">
        <div className="theme-preview">
          <h2>Un titre de page</h2>
          <p>
            Un paragraphe de texte courant, tel qu’il apparaîtra sur les écrans du Panel.
            <span className="muted"> Et du texte atténué, pour les informations secondaires.</span>
          </p>
          <div className="contract-actions">
            <button type="button" className="btn btn-primary btn-small">Action principale</button>
            <button type="button" className="btn btn-secondary btn-small">Action secondaire</button>
          </div>
          <div className="project-row-meta">
            <span className="badge badge-ok">Tout va bien</span>
            <span className="badge badge-warn">À vérifier</span>
            <span className="badge badge-danger">Problème</span>
            <span className="badge badge-muted">Neutre</span>
          </div>
        </div>
      </Card>

      <div className="contract-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!modifie || enCours || !lisible}
          onClick={() => void enregistrer()}
        >
          {enCours ? 'Enregistrement…' : 'Enregistrer le thème'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!modifie || enCours}
          onClick={annuler}
        >
          Annuler les modifications
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={enCours}
          onClick={() => void reinitialiser()}
        >
          Revenir au thème d’origine
        </button>
      </div>
    </div>
  );
}
