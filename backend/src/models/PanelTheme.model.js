import mongoose from 'mongoose';

/**
 * THÈME DU PANEL — même convention que le thème de la vitrine SB Auto.
 *
 * ── PALETTE RÉDUITE, ET C'EST VOULU ─────────────────────────────────────────
 * Quatre couleurs seulement. Toutes les autres nuances — surfaces, bordures,
 * texte atténué, états de survol, succès, avertissement, danger — sont
 * DÉRIVÉES en CSS par `color-mix`. C'est la convention du thème vitrine, et
 * elle est reprise telle quelle plutôt que remplacée par une liste de quinze
 * champs.
 *
 * La raison est pratique : douze couleurs à régler à la main produisent, une
 * fois sur deux, un thème incohérent — un texte atténué qui ne s'accorde plus
 * au fond, une bordure invisible sur une surface. Quatre couleurs, dérivées,
 * restent cohérentes par construction.
 *
 * Un seul enregistrement : c'est un réglage, pas un historique.
 */
export const PANEL_FONTS = Object.freeze([
  'Inter', 'Poppins', 'Roboto', 'Open Sans', 'Lato', 'Source Sans 3', 'Work Sans',
]);

/** Valeurs par défaut — l'apparence actuelle du Panel, à l'octet près. */
export const DEFAULT_PANEL_THEME = Object.freeze({
  colors: {
    background: '#0b0f17',
    foreground: '#e8edf7',
    primary: '#3b82f6',
    accent: '#22c55e',
  },
  radius: '0.75rem',
  typography: { headingFont: 'Inter', bodyFont: 'Inter' },
});

const themeSchema = new mongoose.Schema(
  {
    colors: {
      background: { type: String, default: DEFAULT_PANEL_THEME.colors.background },
      foreground: { type: String, default: DEFAULT_PANEL_THEME.colors.foreground },
      primary: { type: String, default: DEFAULT_PANEL_THEME.colors.primary },
      accent: { type: String, default: DEFAULT_PANEL_THEME.colors.accent },
    },
    radius: { type: String, default: DEFAULT_PANEL_THEME.radius },
    typography: {
      headingFont: { type: String, enum: PANEL_FONTS, default: 'Inter' },
      bodyFont: { type: String, enum: PANEL_FONTS, default: 'Inter' },
    },
  },
  { timestamps: true, versionKey: false },
);

export const PanelTheme = mongoose.model('PanelTheme', themeSchema);

export default PanelTheme;
