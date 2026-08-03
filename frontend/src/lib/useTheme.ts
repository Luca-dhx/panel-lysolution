import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * THÈME DU PANEL — appliqué en écrivant quatre variables CSS.
 *
 * ── POURQUOI PAS DE RECHARGEMENT ────────────────────────────────────────────
 * Tout dérive de ces quatre couleurs par `color-mix`. Poser les variables sur
 * `<html>` suffit donc à repeindre l'application entière, instantanément et
 * sans perdre l'écran où l'on se trouve. Un aperçu qui exigerait de recharger
 * ne serait pas un aperçu.
 */
export interface PanelTheme {
  colors: { background: string; foreground: string; primary: string; accent: string };
  radius: string;
  typography: { headingFont: string; bodyFont: string };
}

export const PANEL_FONTS = [
  'Inter', 'Poppins', 'Roboto', 'Open Sans', 'Lato', 'Source Sans 3', 'Work Sans',
];

/** Écrit le thème sur la racine du document. Sans effet de bord ailleurs. */
export function applyTheme(theme: PanelTheme | null): void {
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty('--p-background', theme.colors.background);
  root.style.setProperty('--p-foreground', theme.colors.foreground);
  root.style.setProperty('--p-primary', theme.colors.primary);
  root.style.setProperty('--p-accent', theme.colors.accent);
  root.style.setProperty('--p-radius', theme.radius);
  root.style.setProperty('--p-font-heading', `'${theme.typography.headingFont}', system-ui, sans-serif`);
  root.style.setProperty('--p-font-body', `'${theme.typography.bodyFont}', system-ui, sans-serif`);
}

/**
 * Contraste WCAG entre deux couleurs — la MÊME formule que le serveur.
 *
 * Dupliquée volontairement : l'écran doit prévenir AVANT d'envoyer, et le
 * serveur doit refuser même si l'écran se trompe. La garde qui compte est
 * celle du serveur ; celle-ci ne fait qu'éviter un aller-retour.
 */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const canal = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const bl = parseInt(hex.slice(5, 7), 16);
    return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(bl);
  };
  const la = lum(a);
  const lb = lum(b);
  const [clair, sombre] = la > lb ? [la, lb] : [lb, la];
  return (clair + 0.05) / (sombre + 0.05);
}

export const MIN_CONTRAST = 4.5;

/** Charge le thème enregistré et l'applique. Utilisé une fois, au démarrage. */
export function useThemeLoader(): void {
  useEffect(() => {
    let annule = false;
    api.getTheme()
      .then((data) => { if (!annule) applyTheme(data.theme); })
      // Un thème indisponible n'empêche pas de travailler : les défauts CSS
      // sont déjà en place, l'application reste lisible.
      .catch(() => {});
    return () => { annule = true; };
  }, []);
}

/** Édition du thème — aperçu immédiat, enregistrement explicite. */
export function useThemeEditor() {
  const [theme, setTheme] = useState<PanelTheme | null>(null);
  const [enregistre, setEnregistre] = useState<PanelTheme | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    api.getTheme().then((d) => { setTheme(d.theme); setEnregistre(d.theme); }).catch(() => {});
  }, []);

  /** Aperçu : on repeint tout de suite, on n'enregistre pas encore. */
  const previsualiser = useCallback((next: PanelTheme) => {
    setTheme(next);
    applyTheme(next);
  }, []);

  const enregistrer = useCallback(async () => {
    if (!theme) return;
    setErreur(null);
    setEnCours(true);
    try {
      const { theme: sauve } = await api.saveTheme(theme);
      setEnregistre(sauve);
      setTheme(sauve);
      applyTheme(sauve);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : 'Enregistrement impossible.');
    } finally {
      setEnCours(false);
    }
  }, [theme]);

  /** Annuler l'aperçu : on remet ce qui est réellement enregistré. */
  const annuler = useCallback(() => {
    setTheme(enregistre);
    applyTheme(enregistre);
    setErreur(null);
  }, [enregistre]);

  const reinitialiser = useCallback(async () => {
    setEnCours(true);
    try {
      const { theme: defaut } = await api.resetTheme();
      setTheme(defaut);
      setEnregistre(defaut);
      applyTheme(defaut);
    } finally {
      setEnCours(false);
    }
  }, []);

  const modifie = JSON.stringify(theme) !== JSON.stringify(enregistre);

  return { theme, previsualiser, enregistrer, annuler, reinitialiser, erreur, enCours, modifie };
}
