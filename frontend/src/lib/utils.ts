/**
 * `cn` — LA FUSION DE CLASSES ATTENDUE PAR LES REGISTRES shadcn.
 *
 * ══ POURQUOI CE FICHIER N'EST PAS CELUI QUE LA CLI ÉCRIT ════════════════════
 *
 * `shadcn add` dépose ici une version canonique :
 *
 *     export function cn(...inputs) { return twMerge(clsx(inputs)); }
 *
 * Elle construit sa PROPRE instance de `tailwind-merge`. Or le Panel en a déjà
 * une, dans `@/utils/cx`, étendue avec l'échelle typographique d'Untitled UI
 * (`display-xs` … `display-2xl`). Deux instances dans un même bundle, ce sont
 * deux caches et deux configurations : `text-display-sm` et `text-sm` se
 * reconnaissent comme conflictuels d'un côté, pas de l'autre. L'écart
 * n'apparaît que sur la combinaison exacte qui met les deux en présence — donc
 * jamais en relecture, et toujours à l'écran.
 *
 * ── DEUX NOMS, UN SEUL MOTEUR ───────────────────────────────────────────────
 *
 *   `@/utils/cx`   → `cx`, attendu par les composants Untitled UI ;
 *   `@/lib/utils`  → `cn`, attendu par TOUT composant venant d'un registre
 *                    shadcn (Bklit, Kokonut UI). Le chemin est écrit en dur
 *                    dans leurs sources : le renommer obligerait à corriger
 *                    chaque fichier à chaque mise à jour de registre.
 *
 * ── SI LA CLI LE RÉÉCRIT ────────────────────────────────────────────────────
 * `shadcn add --overwrite` écrase ce fichier. Le rétablir est la seule chose à
 * refaire après une installation ; rien d'autre du pont n'est touché, puisque
 * les variables partent dans `registry-generated.css`.
 */
import type { ClassValue } from 'clsx';
import clsx from 'clsx';
import { cx } from '@/utils/cx';

export function cn(...inputs: ClassValue[]): string {
  return cx(clsx(inputs));
}

export default cn;
