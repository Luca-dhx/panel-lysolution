/**
 * LE CONTENEUR RADIX — la seule porte d'entrée des primitives Radix Themes.
 *
 * ══ POURQUOI IL N'Y A PAS DE `<Theme>` GLOBAL ═══════════════════════════════
 *
 * La documentation de Radix montre un `<Theme>` posé à la racine de
 * l'application. Sur un Panel neuf, c'est le bon geste. Ici, ce serait un
 * accident : la racine porte déjà 190 ko de CSS écrit à la main, un thème à
 * quatre couleurs posé à l'exécution, la couche Untitled UI et le pont shadcn.
 * Un cinquième système revendiquant `background`, `color`, la police et le
 * rayon sur `<body>` aurait repeint l'application entière — y compris les
 * quinze écrans que cette mission ne touche pas.
 *
 * Le conteneur est donc LOCAL : on l'ouvre autour de ce qui a besoin d'une
 * primitive Radix, et nulle part ailleurs. Radix le permet explicitement — un
 * `Theme` imbriqué est un cas prévu, et il ne se déclare pas racine.
 *
 * ══ L'APPARENCE EST DÉDUITE, PAS CHOISIE ═══════════════════════════════════
 *
 * `appearance` ne pilote ici ni les couleurs ni les surfaces : elles viennent
 * toutes de `radix-scope.css`, qui les dérive du thème du Panel. Elle pilote
 * `color-scheme`, c'est-à-dire ce que le NAVIGATEUR dessine lui-même — barres
 * de défilement, sélecteurs natifs, champs de saisie.
 *
 * On ne peut donc pas la figer : l'exploitant règle librement ses quatre
 * couleurs, et « sombre » n'est pas un mode du Panel mais une conséquence du
 * fond qu'il a choisi. On mesure donc la LUMINANCE du fond réellement calculé,
 * et on en déduit l'apparence. Une valeur figée aurait donné, sur un thème
 * clair, des ascenseurs noirs au milieu d'une page blanche.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Theme } from '@radix-ui/themes';
import '@/styles/radix-scope.css';

/**
 * LUMINANCE RELATIVE — la formule de WCAG, celle que le backend applique déjà
 * pour refuser un thème illisible (`panelTheme.service.js`). Deux formules
 * différentes dans un même produit finiraient par se contredire sur un cas
 * limite, et c'est toujours sur un cas limite qu'on regarde.
 */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Lit une couleur RÉSOLUE sur la racine du document.
 *
 * On passe par `getComputedStyle` plutôt que par l'état React du thème : la
 * marque est posée sur `documentElement` avant même que React ne monte
 * (`applyCachedBranding`), et une couleur peut aussi venir d'un `color-mix`.
 * Le navigateur est le seul à savoir ce qui est réellement peint.
 */
function couleurResolue(variable: string): [number, number, number] | null {
  if (typeof window === 'undefined') return null;
  const brute = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!brute) return null;

  // `rgb(…)` / `rgba(…)` — ce que rend le navigateur dans la quasi-totalité des cas.
  const rgb = brute.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];

  // Repli hexadécimal : le thème est stocké sous cette forme, et un navigateur
  // peut rendre la variable telle qu'elle a été posée.
  const hex = brute.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  return null;
}

/**
 * L'apparence à donner à Radix, déduite du fond réellement calculé.
 *
 * Recalculée à chaque changement de thème : le Panel repeint sa racine sans
 * recharger la page (« aperçu » de l'écran Thème), et une apparence figée au
 * premier rendu aurait laissé des ascenseurs sombres sur un thème clair
 * jusqu'au prochain rechargement.
 */
export function useRadixAppearance(): 'light' | 'dark' {
  const [apparence, setApparence] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    const mesurer = () => {
      const rgb = couleurResolue('--p-background');
      // Sans mesure possible, on garde le défaut du Panel plutôt que de
      // basculer en clair : le thème livré est sombre.
      if (!rgb) return;
      setApparence(luminance(rgb) > 0.45 ? 'light' : 'dark');
    };
    mesurer();

    // Le thème est posé en écrivant des propriétés sur `documentElement` :
    // observer son attribut `style` est la façon la plus directe de l'apprendre.
    const observateur = new MutationObserver(mesurer);
    observateur.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    return () => observateur.disconnect();
  }, []);

  return apparence;
}

export function RadixScope({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const appearance = useRadixAppearance();

  return (
    <Theme
      appearance={appearance}
      /*
       * `hasBackground={false}` : le conteneur ne peint pas de fond. Il est
       * posé DANS une carte du Panel qui a déjà sa surface — un second fond y
       * aurait dessiné un rectangle plus clair.
       *
       * `radius` et `scaling` suivent le Panel : son échelle typographique est
       * plus dense que celle de Radix par défaut.
       */
      hasBackground={false}
      radius="medium"
      scaling="95%"
      className={className}
    >
      {children}
    </Theme>
  );
}

export default RadixScope;
