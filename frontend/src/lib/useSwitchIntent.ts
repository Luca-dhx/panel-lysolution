import { useEffect, useRef, useState } from 'react';

/**
 * LA MACHINE À ÉTATS DE L'INTERRUPTEUR — isolée du rendu, et sans JSX.
 *
 * ══ POURQUOI DANS SON PROPRE MODULE ═════════════════════════════════════════
 *
 * C'est ici que se joue tout ce qui peut mal tourner : l'intention en vol, la
 * projection contradictoire qui doit gagner, le retour en arrière, le double
 * clic. Ces règles doivent être ÉPROUVÉES — et les éprouver à travers un
 * moteur de rendu reviendrait à tester le rendu plutôt que la règle.
 *
 * Le fichier ne contient donc AUCUN JSX : il se charge tel quel dans un runner
 * node, sans build ni moteur de rendu.
 */
export interface SwitchIntentInput {
  /** L'état CONFIRMÉ par la projection. Jamais écrit ici. */
  checked: boolean;
  /** Rendue quand l'utilisateur demande un changement. Résout ou lève. */
  onToggle: (next: boolean) => Promise<void>;
  disabled?: boolean;
}

export type SwitchPhase = 'STABLE' | 'PENDING' | 'ERROR';

/**
 * LA MACHINE À ÉTATS, ISOLÉE DU RENDU.
 *
 * ── POURQUOI ELLE VIT À PART ────────────────────────────────────────────────
 * C'est ici que se joue tout ce qui peut mal tourner : l'intention en vol, la
 * projection contradictoire qui doit gagner, le retour en arrière, le double
 * clic. Ces règles doivent être ÉPROUVÉES, et les éprouver à travers un moteur
 * de rendu reviendrait à tester le rendu plutôt que la règle.
 *
 * Le composant plus bas ne fait qu'habiller ce que ce hook décide.
 */
export function useSwitchIntent({
  checked, onToggle, disabled = false,
}: SwitchIntentInput) {
  const [phase, setPhase] = useState<SwitchPhase>('STABLE');
  /** Ce que l'utilisateur a demandé — affichage seul, jamais une vérité. */
  const [intention, setIntention] = useState<boolean | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const vivant = useRef(true);

  useEffect(() => () => { vivant.current = false; }, []);

  /**
   * LA PROJECTION A PARLÉ — l'intention n'a plus lieu d'être.
   *
   * Qu'elle confirme ou qu'elle contredise, elle fait autorité : dans les deux
   * cas on repasse en état stable et l'on affiche `checked`. Garder une
   * intention qui survit à une projection contradictoire ferait clignoter
   * l'interrupteur entre deux vérités.
   */
  useEffect(() => {
    setIntention(null);
    setPhase((p) => (p === 'PENDING' ? 'STABLE' : p));
  }, [checked]);

  /**
   * CE QUI EST AFFICHÉ : l'intention si elle est en vol, l'état confirmé sinon.
   * Un seul booléen pour le rendu — c'est ce qui évite le OFF→ON→OFF→ON qu'un
   * rerender intermédiaire produirait en mélangeant deux sources.
   */
  const affiche = intention ?? checked;
  const enCours = phase === 'PENDING';

  const basculer = async () => {
    // DOUBLE CLIC : une mutation en vol interdit d'en lancer une seconde. Deux
    // commandes concurrentes se répondraient dans un ordre indéterminé, et la
    // dernière projection reçue ne serait pas forcément la dernière demandée.
    if (enCours || disabled) return;
    const voulu = !checked;
    setIntention(voulu);
    setPhase('PENDING');
    setErreur(null);
    try {
      await onToggle(voulu);
      // On ne repasse PAS en STABLE ici : la commande a été acceptée, mais
      // seule la projection dira ce que le projet a réellement appliqué.
      // C'est l'effet sur `checked` qui clôt l'attente.
    } catch (err) {
      if (!vivant.current) return;
      // ROLLBACK : on relâche l'intention, l'affichage revient au dernier état
      // confirmé — sans saut, la transition CSS s'en charge.
      setIntention(null);
      setPhase('ERROR');
      setErreur(err instanceof Error ? err.message : 'La demande a échoué.');
    }
  };

  return { affiche, enCours, phase, erreur, basculer };
}
