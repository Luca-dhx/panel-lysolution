/**
 * FINANCES — le tableau de bord de pilotage de L.Y Solution.
 *
 * ══ CE QU'ELLE N'EST PAS ════════════════════════════════════════════════════
 *
 * Un SECOND registre. Elle monte exactement le moteur de l'onglet « Finances »
 * d'un projet, avec une portée ouverte. Les revenus d'un client s'y lisent au
 * centime près comme sur sa fiche, parce que c'est la même somme, faite au même
 * endroit, sur les mêmes lignes.
 *
 * ══ CE QU'ELLE AJOUTE ═══════════════════════════════════════════════════════
 *
 * Une seule chose que la fiche d'un projet ne peut pas montrer : la
 * RÉPARTITION. Quel client rapporte, lequel coûte, et où se situe l'entreprise
 * elle-même dans ce classement — car les mouvements propres à L.Y Solution
 * (`projectId: null`) y figurent comme n'importe quel autre rattachement. Ce ne
 * sont pas une exception du modèle, ils en sont un cas.
 *
 * ══ CE QUE LA REFONTE A CHANGÉ ══════════════════════════════════════════════
 *
 * L'écran empilait un titre, quatre cartes, un graphique, une barre de filtres,
 * une liste et un tableau — tous du même poids visuel, tous à la même largeur.
 * Il fallait le PARCOURIR pour en tirer quoi que ce soit.
 *
 * Il est désormais organisé par question :
 *
 *   1. COMBIEN, et par rapport à quand   → les indicateurs, avec leur tendance
 *   2. COMMENT ça évolue                 → le graphique composé
 *   3. GRÂCE À QUI                       → la répartition, graphique + chiffres
 *   4. QUOI exactement                   → le registre, inchangé
 *
 * Les trois premières couches sont neuves ; la quatrième est le moteur
 * existant, qui n'a perdu aucune de ses fonctions.
 */
import { useMemo, useState } from 'react';
import { PageHeader, SkeletonRows } from '@/components/ui-kit';
import { FinanceWorkspace } from '@/components/finance/FinanceWorkspace';
import { FinanceBreakdownPanel } from '@/components/finance/FinanceDashboard';
import { LY_SOLUTION } from '@/components/finance/financeLabels';
import { useProjects } from '@/lib/useProjects';
import { projectDisplayName } from '@/lib/projectPresentation';

export function FinancesPage() {
  const { projects, isInitialLoading } = useProjects();
  /**
   * LE CLASSEMENT SUIT LES ÉCRITURES DU MOTEUR.
   *
   * Le moteur recharge ce qu'il affiche, mais la répartition vit à côté de lui.
   * Sans ce compteur, ajouter une transaction laissait un classement périmé
   * juste sous un total qui venait de bouger — l'écran se contredisait
   * lui-même, et c'est le genre d'incohérence qui fait douter des deux
   * chiffres.
   */
  const [revision, setRevision] = useState(0);

  const choix = useMemo(
    () => projects
      .map((projet) => ({
        projectId: projet.projectId,
        projectName: projectDisplayName(projet),
      }))
      .sort((a, b) => a.projectName.localeCompare(b.projectName, 'fr')),
    [projects],
  );

  /**
   * Les noms VIVANTS, indexés une fois.
   *
   * L'instantané porté par une ligne financière est un repli d'audit : il dit
   * comment le projet s'appelait au moment de la saisie. Ce qu'on veut lire,
   * c'est son nom d'aujourd'hui.
   */
  const nomsVivants = useMemo(
    () => new Map(choix.map((c) => [c.projectId, c.projectName])),
    [choix],
  );

  return (
    <div className="page">
      <PageHeader
        title="Finances"
        description={(
          <>
            Tous les mouvements du parc et ceux de {LY_SOLUTION}, dans un seul registre.
            Le bénéfice est calculé depuis les mouvements — il n’est jamais saisi.
          </>
        )}
      />

      {isInitialLoading ? (
        /*
          Le squelette a la FORME de ce qui arrive : quatre indicateurs puis un
          bloc. Un « Chargement du parc… » centré ne réservait aucune place, et
          tout sautait à l'arrivée des chiffres.
        */
        <div className="uui flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-secondary" />
            ))}
          </div>
          <div className="overflow-hidden rounded-xl ring-1 ring-secondary">
            <SkeletonRows rows={4} columns={4} />
          </div>
        </div>
      ) : (
        <>
          {/*
            LE MOTEUR — indicateurs, évolution, filtres, registre, formulaires.
            Il porte sa propre période : c'est LUI qui décide de la fenêtre, et
            les chiffres du haut décrivent exactement ce que la liste du bas
            contient.
          */}
          <FinanceWorkspace
            scope="all"
            projects={choix}
            onMutate={() => setRevision((n) => n + 1)}
          />

          {/*
            LA RÉPARTITION — volontairement hors du moteur, et sans période.

            C'est un classement de FOND. Lui donner ses propres filtres aurait
            mis deux réglages indépendants sur un même écran, donc, un jour,
            deux lectures contradictoires côte à côte.
          */}
          <FinanceBreakdownPanel revision={revision} projectNames={nomsVivants} />
        </>
      )}
    </div>
  );
}

export default FinancesPage;
