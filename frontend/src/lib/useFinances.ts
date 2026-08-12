/**
 * LECTURE DU REGISTRE — le résumé et la liste, ensemble ou jamais.
 *
 * ══ POURQUOI LES DEUX APPELS SONT LIÉS ══════════════════════════════════════
 *
 * Le total en haut de l'écran et les lignes en dessous doivent décrire le MÊME
 * ensemble. Les charger séparément, avec deux états de chargement distincts,
 * produit une fenêtre — courte mais réelle — où l'on lit un total de mars
 * au-dessus des mouvements de février. Ce hook les demande donc en parallèle
 * et ne publie que lorsque les deux sont là.
 *
 * ══ POURQUOI AUCUN SONDAGE ══════════════════════════════════════════════════
 *
 * Les autres écrans du Panel sondent (`useLiveQuery`) parce qu'une source
 * EXTÉRIEURE les modifie : un projet pousse sa présentation, un heartbeat
 * arrive. Le registre financier n'a aucune source extérieure en L10.1 — il ne
 * change que lorsque la personne devant l'écran le change. Sonder ne
 * rafraîchirait donc jamais rien, tout en risquant de remplacer une liste sous
 * le doigt de quelqu'un qui s'apprête à cliquer « Voir les détails ».
 *
 * Le jour où Stripe écrira dans ce registre (L10.3), cette décision devra être
 * rouverte — et c'est le seul endroit à relire.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, finances } from '@/lib/api';
import type { FinanceCriteria, FinanceListResult, FinanceSummary } from '@/types.finance';

export interface FinanceWorkspaceData {
  summary: FinanceSummary | null;
  list: FinanceListResult | null;
  /** Premier chargement : il n'y a RIEN à montrer. */
  isInitialLoading: boolean;
  /** Relecture après une écriture : le contenu affiché reste en place. */
  isRefreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Une clef stable pour un jeu de critères.
 *
 * Les objets de critères sont reconstruits à chaque rendu ; les comparer par
 * référence relancerait une lecture en boucle. On compare donc leur contenu,
 * une fois, ici — plutôt que de demander à chaque écran de mémoriser le sien.
 */
function criteriaKey(criteria: FinanceCriteria): string {
  return JSON.stringify([
    criteria.scope ?? null,
    criteria.projectId ?? null,
    criteria.period ?? null,
    criteria.start ?? null,
    criteria.end ?? null,
    criteria.category ?? null,
    criteria.flow ?? null,
    criteria.search ?? null,
    criteria.sort ?? null,
    criteria.limit ?? null,
    criteria.includeDeleted ?? false,
  ]);
}

/**
 * DEUX JEUX DE CRITÈRES, ET C'EST DÉLIBÉRÉ.
 *
 * Le RÉSUMÉ décrit la période : revenus, coûts, net, tels qu'ils sont. La
 * LISTE peut être restreinte davantage — le sous-onglet « Coûts » ne montre que
 * les sorties. Leur imposer les mêmes critères afficherait « Revenus : 0 € »
 * au-dessus de la liste des coûts, ce qui serait faux : il y a bien eu des
 * revenus, on a seulement choisi de ne pas les lister.
 */
export function useFinanceWorkspace(
  summaryCriteria: FinanceCriteria,
  listCriteria: FinanceCriteria = summaryCriteria,
): FinanceWorkspaceData {
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [list, setList] = useState<FinanceListResult | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clef = `${criteriaKey(summaryCriteria)}|${criteriaKey(listCriteria)}`;
  // Les critères sont lus dans une référence : le rechargement dépend de leur
  // CONTENU (`clef`), jamais de l'identité de l'objet qui les porte.
  const criteresRef = useRef({ summary: summaryCriteria, list: listCriteria });
  criteresRef.current = { summary: summaryCriteria, list: listCriteria };
  const aDesDonneesRef = useRef(false);
  const vivantRef = useRef(true);

  const run = useCallback(async () => {
    if (aDesDonneesRef.current) setIsRefreshing(true);
    try {
      const courants = criteresRef.current;
      const [resume, lignes] = await Promise.all([
        finances.summary(courants.summary),
        finances.list(courants.list),
      ]);
      if (!vivantRef.current) return;
      setSummary(resume);
      setList(lignes);
      aDesDonneesRef.current = true;
      setError(null);
    } catch (err) {
      if (!vivantRef.current) return;
      /**
       * L'ERREUR EST TOUJOURS PUBLIÉE — c'est l'ÉCRAN qui décide de sa gravité.
       *
       * Une relecture ratée ne doit pas effacer un écran déjà lu ; mais elle ne
       * doit pas non plus disparaître. La distinction ne se fait pas ici : le
       * hook dit ce qui s'est passé, et l'écran choisit entre le message
       * bloquant (rien à montrer) et le bandeau d'avertissement (les chiffres
       * affichés datent de la lecture précédente). Avaler l'erreur ici
       * laisserait croire à des totaux frais.
       */
      setError(errorMessage(err, 'Les finances n’ont pas pu être chargées.'));
    } finally {
      if (vivantRef.current) {
        setIsInitialLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    vivantRef.current = true;
    // Changer de projet ou de période, c'est demander autre chose : on repart
    // sur un vrai premier chargement plutôt que d'afficher les chiffres du
    // périmètre précédent sous le nouveau titre.
    aDesDonneesRef.current = false;
    setIsInitialLoading(true);
    setError(null);
    void run();
    return () => { vivantRef.current = false; };
  }, [clef, run]);

  return { summary, list, isInitialLoading, isRefreshing, error, reload: run };
}

export default useFinanceWorkspace;
