/**
 * LES FORMATEURS DES GRAPHIQUES — EN FRANÇAIS.
 *
 * ══ CE FICHIER VIENT DU REGISTRE, ET IL EST MODIFIÉ EXPRÈS ══════════════════
 *
 * Le registre `@bklit` livre ces quatre formateurs en `en-US`. Le Panel est une
 * application française : ses libellés, ses montants et ses dates le sont
 * partout ailleurs. Laisser l'axe des dates en anglais produisait, sur l'écran
 * financier, un mélange constaté en production :
 *
 *     axe horizontal   Feb 1 · Feb 15 · Feb 28
 *     tableau dessous  01 févr. · 15 févr. · 28 févr.
 *
 * Les deux décrivent les MÊMES seaux. Un lecteur qui compare les deux se demande
 * légitimement s'il regarde la même chose.
 *
 * `intFmt` comptait autant : `1,234` en anglais, `1 234` en français — et le
 * séparateur anglais des milliers est le séparateur français des décimales.
 * Sur des montants, la confusion n'est pas cosmétique.
 *
 * ── À RESTAURER APRÈS UN `shadcn add --overwrite` ───────────────────────────
 * La CLI réécrit ce fichier avec sa version d'origine, comme elle le fait pour
 * `lib/utils.ts`. Les deux sont signalés dans
 * `docs/ui/PANEL_UI_SYSTEM_BKLIT_KOKONUT_RADIX_UNTITLED.md`.
 */

const LOCALE = "fr-FR";

/** L'axe des dates : « 1 févr. ». */
export const shortDateFmt = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
});

/** L'en-tête d'une infobulle : « sam. 22 août ». */
export const weekdayDateFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

export const hmsTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// `Intl.NumberFormat.prototype.format` is a bound getter — safe to extract.
export const intFmt = new Intl.NumberFormat(LOCALE).format;
