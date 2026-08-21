/**
 * FINANCES — la vue d'ensemble de L.Y Solution.
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
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { FinanceWorkspace } from '@/components/finance/FinanceWorkspace';
import { LY_SOLUTION } from '@/components/finance/financeLabels';
import { errorMessage, finances } from '@/lib/api';
import { formatCents, formatNetCents, netTone } from '@/lib/money';
import { useProjects } from '@/lib/useProjects';
import { projectDisplayName } from '@/lib/projectPresentation';
import type { FinanceProjectLine } from '@/types.finance';

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

  return (
    <div className="page">
      <header className="page-header">
        <h1>Finances</h1>
        <p className="page-description">
          Tous les mouvements du parc et ceux de {LY_SOLUTION}, dans un seul registre.
          Le bénéfice est calculé depuis les mouvements — il n’est jamais saisi.
        </p>
      </header>

      {isInitialLoading ? (
        <Card><p className="muted">Chargement du parc…</p></Card>
      ) : (
        <>
          <FinanceWorkspace
            scope="all"
            projects={choix}
            onMutate={() => setRevision((n) => n + 1)}
          />
          <RepartitionParProjet
            revision={revision}
            projectNames={new Map(choix.map((c) => [c.projectId, c.projectName]))}
          />
        </>
      )}
    </div>
  );
}

/**
 * QUI RAPPORTE, QUI COÛTE — sur l'ensemble du registre.
 *
 * Volontairement SANS filtre de période : c'est un classement de fond, pas une
 * vue de travail. Le moteur au-dessus porte déjà toutes les périodes, et
 * dupliquer ses filtres ici aurait produit deux réglages indépendants sur un
 * même écran — donc, un jour, deux lectures contradictoires côte à côte.
 */
function RepartitionParProjet({
  revision,
  projectNames,
}: {
  /** Change à chaque écriture du moteur — c'est le seul déclencheur de relecture. */
  revision: number;
  projectNames: Map<string, string>;
}) {
  const [lignes, setLignes] = useState<FinanceProjectLine[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    finances.byProject({ period: 'ALL' })
      .then((res) => { if (vivant) { setLignes(res.items); setErreur(null); } })
      .catch((err) => {
        if (vivant) setErreur(errorMessage(err, 'La répartition n’a pas pu être chargée.'));
      });
    return () => { vivant = false; };
  }, [revision]);

  if (erreur) return <Card title="Répartition par projet"><div className="alert alert-error">{erreur}</div></Card>;
  if (lignes === null) return <Card title="Répartition par projet"><p className="muted">Chargement…</p></Card>;

  if (lignes.length === 0) {
    return (
      <Card title="Répartition par projet">
        <EmptyState
          title="Aucun mouvement enregistré."
          hint="La répartition apparaîtra dès la première transaction."
        />
      </Card>
    );
  }

  return (
    <Card title="Répartition par projet">
      <div className="table-scroll">
        <table className="data-table finance-table finance-table-stackable">
          <thead>
            <tr>
              <th scope="col">Rattachement</th>
              <th scope="col" className="finance-cell-amount">Revenus</th>
              <th scope="col" className="finance-cell-amount">Coûts</th>
              <th scope="col" className="finance-cell-amount">Net</th>
              <th scope="col" className="finance-cell-amount">Mouvements</th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((ligne) => (
              <tr key={ligne.projectId ?? '__company__'}>
                <td data-label="Rattachement">
                  {ligne.projectId ? (
                    // Depuis le classement, on va lire le détail là où il vit :
                    // sur la fiche du client, dans son onglet Finances.
                    <Link className="project-link" to={`/projects/${ligne.projectId}?tab=finances`}>
                      {projectNames.get(ligne.projectId) ?? ligne.projectNameSnapshot ?? ligne.projectId}
                    </Link>
                  ) : (
                    <span className="cell-primary">{LY_SOLUTION}</span>
                  )}
                </td>
                <td data-label="Revenus" className="finance-cell-amount finance-amount-inflow">
                  {formatCents(ligne.revenueCents)}
                </td>
                <td data-label="Coûts" className="finance-cell-amount finance-amount-outflow">
                  {formatCents(ligne.costCents)}
                </td>
                <td
                  data-label="Net"
                  className={`finance-cell-amount finance-net-${netTone(ligne.netCents)}`}
                >
                  {formatNetCents(ligne.netCents)}
                </td>
                <td data-label="Mouvements" className="finance-cell-amount">{ligne.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-hint muted">
        Depuis le début, toutes périodes confondues. Les mouvements supprimés n’y figurent pas.
      </p>
    </Card>
  );
}

export default FinancesPage;
