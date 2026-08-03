/**
 * THÈME DU PANEL — lecture, écriture, contraste.
 *
 * Le contraste n'est pas une coquetterie : un texte gris clair sur fond blanc
 * est illisible pour beaucoup de gens, et le seul moment où l'on peut
 * l'empêcher est la sauvegarde. On refuse donc un thème dont le texte ne
 * ressort pas de son fond, en disant de combien il s'en faut.
 */
import ApiError from '../../utils/ApiError.js';
import {
  DEFAULT_PANEL_THEME,
  PANEL_FONTS,
  PanelTheme,
} from '../../models/PanelTheme.model.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Luminance relative (WCAG). */
function luminance(hex) {
  const canal = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

/** Rapport de contraste entre deux couleurs, de 1 (identiques) à 21. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [clair, sombre] = la > lb ? [la, lb] : [lb, la];
  return (clair + 0.05) / (sombre + 0.05);
}

/** Seuil AA pour du texte courant. En dessous, on refuse d'enregistrer. */
export const MIN_CONTRAST = 4.5;

export async function getPanelTheme() {
  const existant = await PanelTheme.findOne().lean();
  if (existant) return existant;
  return { ...DEFAULT_PANEL_THEME, _id: null };
}

export async function savePanelTheme(patch = {}) {
  const courant = await getPanelTheme();
  const colors = { ...courant.colors, ...(patch.colors ?? {}) };

  for (const [nom, valeur] of Object.entries(colors)) {
    if (!HEX.test(String(valeur))) {
      throw ApiError.badRequest(
        'PANEL_THEME_COLOR_INVALID',
        `La couleur « ${nom} » doit être un code hexadécimal à six chiffres.`,
      );
    }
  }

  const contrasteTexte = contrastRatio(colors.foreground, colors.background);
  if (contrasteTexte < MIN_CONTRAST) {
    throw ApiError.badRequest(
      'PANEL_THEME_CONTRAST_TOO_LOW',
      `Le texte ne ressort pas assez du fond (${contrasteTexte.toFixed(1)}:1, `
      + `minimum ${MIN_CONTRAST}:1).`,
    );
  }

  const typography = { ...courant.typography, ...(patch.typography ?? {}) };
  for (const cle of ['headingFont', 'bodyFont']) {
    if (!PANEL_FONTS.includes(typography[cle])) {
      throw ApiError.badRequest('PANEL_THEME_FONT_UNKNOWN', 'Police inconnue du catalogue.');
    }
  }

  const radius = patch.radius ?? courant.radius;
  if (!/^\d*\.?\d+(rem|px)$/.test(String(radius))) {
    throw ApiError.badRequest('PANEL_THEME_RADIUS_INVALID', 'Rayon invalide (ex. « 0.75rem »).');
  }

  await PanelTheme.updateOne({}, { $set: { colors, typography, radius } }, { upsert: true });
  return getPanelTheme();
}

/** Retour aux valeurs d'origine — une sortie de secours, toujours disponible. */
export async function resetPanelTheme() {
  await PanelTheme.deleteMany({});
  return getPanelTheme();
}

export default { getPanelTheme, savePanelTheme, resetPanelTheme, contrastRatio, MIN_CONTRAST };
