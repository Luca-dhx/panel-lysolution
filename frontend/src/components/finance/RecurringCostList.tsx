/**
 * LES COÛTS RÉCURRENTS — un listing de RÈGLES, à côté du livret, jamais dedans.
 *
 * ══ POURQUOI DEUX LISTES SUR LE MÊME ÉCRAN ══════════════════════════════════
 *
 * Le livret montre des MOUVEMENTS comptabilisés : ce qui est réellement sorti.
 * Ce tableau montre des RÈGLES : ce qui sortira. Les mélanger ferait apparaître
 * une dépense future au milieu de dépenses réelles, et le total du haut ne
 * voudrait plus rien dire — il compterait des choses qui n'ont pas eu lieu.
 *
 * La colonne « Prochaine » est donc explicitement une PRÉVISION. Elle
 * n'intervient dans aucun agrégat tant qu'elle n'a pas été matérialisée, et le
 * pied de tableau le dit.
 */
import { Card, EmptyState } from '@/components/ui';
import { formatCents } from '@/lib/money';
import { LY_SOLUTION, ownershipLabel } from '@/components/finance/financeLabels';
import type { RecurrenceUnit, RecurringCost } from '@/types.finance';

const JOUR_LONG = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });

const UNITE_SINGULIER: Record<RecurrenceUnit, string> = { DAY: 'jour', MONTH: 'mois', YEAR: 'an' };
const UNITE_PLURIEL: Record<RecurrenceUnit, string> = { DAY: 'jours', MONTH: 'mois', YEAR: 'ans' };

/** « tous les mois », « tous les 2 mois », « tous les 7 jours ». */
export function frequenceLabel({ unit, interval }: { unit: RecurrenceUnit; interval: number }): string {
  if (interval === 1) return `tous les ${UNITE_SINGULIER[unit]}${unit === 'MONTH' ? '' : 's'}`;
  return `tous les ${interval} ${UNITE_PLURIEL[unit]}`;
}

export function RecurringCostList({
  items,
  projectNames,
  showOwnership,
  onAdd,
  onEdit,
  onStop,
}: {
  items: RecurringCost[];
  projectNames: Map<string, string>;
  /** La colonne de rattachement n'a de sens que sur la page globale. */
  showOwnership: boolean;
  onAdd: () => void;
  onEdit: (recurringCost: RecurringCost) => void;
  onStop: (recurringCost: RecurringCost) => void;
}) {
  const actives = items.filter((r) => r.status === 'ACTIVE');

  return (
    <Card title={`Coûts récurrents (${actives.length} active${actives.length > 1 ? 's' : ''})`}>
      <p className="field-hint muted">
        Ces lignes sont des <strong>règles</strong>, pas des dépenses. Chacune produit un
        mouvement dans le livret à chaque échéance ; seuls ces mouvements comptent dans les
        totaux et le graphique.
      </p>

      {items.length === 0 ? (
        <EmptyState
          title="Aucun coût récurrent."
          hint="Un abonnement, un hébergement, une domiciliation : déclarez-le une fois, il se comptabilisera tout seul."
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table finance-table">
            <thead>
              <tr>
                <th scope="col">Nom</th>
                {showOwnership ? <th scope="col">Rattachement</th> : null}
                <th scope="col" className="finance-cell-amount">Montant</th>
                <th scope="col">Fréquence</th>
                <th scope="col">Prochaine</th>
                <th scope="col">État</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((regle) => {
                const arretee = regle.status === 'STOPPED';
                return (
                  <tr key={regle.recurringCostId} className={arretee ? 'finance-row-muted' : undefined}>
                    <td>
                      <span className="cell-primary">{regle.label}</span>
                      {regle.description ? (
                        <span className="cell-secondary">{regle.description}</span>
                      ) : null}
                      {regle.revisions.length > 1 ? (
                        <span className="cell-secondary">
                          {`${regle.revisions.length} versions — dernière depuis le cycle ${regle.revisions.at(-1)?.effectiveFromCycleKey}`}
                        </span>
                      ) : null}
                    </td>
                    {showOwnership ? (
                      <td>{ownershipLabel(regle.projectId, regle.projectNameSnapshot, projectNames)}</td>
                    ) : null}
                    <td className="finance-cell-amount finance-amount-outflow">
                      {formatCents(regle.amountCents)}
                    </td>
                    <td>{frequenceLabel(regle.recurrence)}</td>
                    <td>
                      {regle.nextOccurrenceAt ? (
                        <>
                          {JOUR_LONG.format(new Date(regle.nextOccurrenceAt))}
                          {/* PRÉVISION, et le mot est écrit : elle ne compte nulle part. */}
                          <span className="cell-secondary">prévision — non comptabilisée</span>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>
                      {arretee ? (
                        <span className="badge badge-muted">
                          {regle.stopMode === 'CURRENT' ? 'Arrêtée (cycle retiré)' : 'Arrêtée'}
                        </span>
                      ) : (
                        <span className="badge badge-ok">Active</span>
                      )}
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        {arretee ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            <button type="button" className="btn btn-small" onClick={() => onEdit(regle)}>
                              Modifier
                            </button>
                            <button type="button" className="btn btn-small" onClick={() => onStop(regle)}>
                              Stopper
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="action-buttons">
        <button type="button" className="btn btn-secondary" onClick={onAdd}>
          Ajouter un coût récurrent
        </button>
      </div>

      {items.some((r) => r.projectId === null) && showOwnership ? (
        <p className="field-hint muted">
          {`Les règles sans projet appartiennent à ${LY_SOLUTION}.`}
        </p>
      ) : null}
    </Card>
  );
}

export default RecurringCostList;
