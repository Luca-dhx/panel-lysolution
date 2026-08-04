/**
 * CARTE CONTRAT — ce que l'équipe doit savoir, et ce qu'elle peut demander.
 *
 * ── DEUX PRINCIPES ──────────────────────────────────────────────────────────
 * 1. Le Panel n'édite pas le contrat. Il l'affiche, et il DEMANDE une
 *    résiliation au projet. La nouvelle vérité revient ensuite d'elle-même par
 *    la synchronisation — l'écran ne s'auto-félicite jamais d'un changement
 *    qu'il n'a pas constaté.
 * 2. Résilier engage. La confirmation nomme le projet, le contrat,
 *    l'environnement et l'effet attendu. Un clic ne suffit pas : il faut
 *    confirmer une seconde fois, sur une action qu'on a lue.
 */
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { DernierEtatConnu } from '@/components/FreshnessBanner';
import { actionsDistantesPossibles, getProjectDataFreshness } from '@/lib/projectFreshness';
import {
  contractState,
  formatAmount,
  formatInterval,
  toneBadgeClass,
} from '@/lib/projectPresentation';
import type {
  BusinessContract, ContractOperation, PreviousContract, PublicProject,
} from '@/types';

const CANCEL_NOW = 'contract.cancel_now';

/**
 * État du document, en français, sans jargon de signature électronique.
 *
 * « Momentanément indisponible » n'est pas « non généré » : le document
 * existe, c'est le lien avec le projet qui est rompu. Confondre les deux ferait
 * croire qu'un contrat n'a jamais été produit alors qu'il attend simplement
 * que le site revienne.
 */
function documentState(
  contract: BusinessContract,
  joignable: boolean,
): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  const doc = contract.document;
  // C'est le PROJET qui constate l'état, en croisant sa base et son stockage.
  // Le Panel ne le déduit plus : il l'affiche.
  if (!doc || doc.status === 'NONE') return { label: 'Non généré', tone: 'neutral' };
  if (doc.status === 'UNAVAILABLE') return { label: 'Momentanément indisponible', tone: 'warn' };
  if (!joignable) return { label: 'Momentanément indisponible', tone: 'warn' };
  if (doc.status === 'SIGNED') return { label: 'Signé', tone: 'ok' };
  if (doc.status === 'PENDING_SIGNATURE') return { label: 'En attente de signature', tone: 'warn' };
  return { label: 'Généré, non signé', tone: 'warn' };
}

export function ContractCard({
  project,
  contract,
}: {
  project: PublicProject;
  contract: BusinessContract | null;
}) {
  // UNE seule règle de fraîcheur, partagée avec toute la fiche.
  const fraicheur = getProjectDataFreshness(project);
  const [operations, setOperations] = useState<ContractOperation[]>([]);
  const [reachable, setReachable] = useState(true);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [demande, setDemande] = useState<ContractOperation | null>(null);
  const [motif, setMotif] = useState('');
  const [confirme, setConfirme] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [telechargement, setTelechargement] = useState(false);

  useEffect(() => {
    let annule = false;
    if (!contract) return undefined;
    api.getContractOperations(project.projectId)
      .then((data) => {
        if (annule) return;
        setOperations(data.operations);
        setReachable(data.reachable);
        setEnvironment(data.environment);
      })
      .catch(() => { if (!annule) setReachable(false); });
    return () => { annule = true; };
  }, [project.projectId, contract?.sourceContractId]);

  const historique = contract?.previousContracts ?? [];

  if (!contract) {
    return (
      <Card title="Contrat">
        <p className="muted">Aucun contrat synchronisé.</p>
      </Card>
    );
  }

  /**
   * AUCUN CONTRAT ACTUEL — et c'est une information, pas un trou.
   *
   * La carte affichait jusqu'ici l'abonnement, les frais, l'activation, la
   * signature et le document du dernier contrat TERMINÉ, sous une pastille
   * « Contrat terminé ». L'état contractuel du moment se mélangeait au détail
   * d'un contrat mort. Rien de tout cela n'a sa place ici : ces informations
   * existent toujours, dans l'historique, où elles sont justes.
   */
  if (contract.hasCurrent === false || !contract.status) {
    const dernier = historique[0] ?? null;
    return (
      <>
        <Card title="Contrat">
          <p className="contract-none">Aucun contrat actif</p>
          {dernier?.endedAt ? (
            <p className="muted">Le dernier contrat a pris fin le {formatDateTime(dernier.endedAt)}.</p>
          ) : dernier ? (
            <p className="muted">Le dernier contrat est {contractState(dernier.status).label.toLowerCase()}.</p>
          ) : (
            <p className="muted">Ce projet n’a jamais eu de contrat.</p>
          )}
        </Card>
        <ContractHistory contracts={historique} project={project} fraicheur={fraicheur} />
      </>
    );
  }

  const doc = contract.document;
  /**
   * JOIGNABLE veut dire : relié, ET qui répond, ET dont les données viennent
   * de l'instance qui répond. Un projet redéployé en TEST reste « appairé »
   * alors que ce qu'on affiche décrit encore PROD : proposer un
   * téléchargement ou une résiliation sur cette base agirait à l'aveugle.
   */
  const joignable = project.pairing.status === 'PAIRED' && actionsDistantesPossibles(fraicheur);
  const etatDoc = documentState(contract, joignable);
  const statut = contractState(contract.status);

  const telecharger = async () => {
    setErreur(null);
    setTelechargement(true);
    try {
      await api.downloadContractDocument(project.projectId, doc?.filename ?? 'contrat.pdf');
    } catch (err) {
      setErreur(errorMessage(err, 'Le document n’a pas pu être récupéré.'));
    } finally {
      setTelechargement(false);
    }
  };

  const envoyer = async () => {
    if (!demande) return;
    setErreur(null);
    setEnCours(true);
    try {
      await api.cancelContract(project.projectId, demande.id, motif.trim() || undefined);
      setMessage(
        'Demande transmise au projet. Le nouveau statut apparaîtra ici dès que le projet l’aura appliqué.',
      );
      setDemande(null);
      setMotif('');
      setConfirme(false);
    } catch (err) {
      setErreur(errorMessage(err, 'Le projet a refusé la demande.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <>
      <Card title="Contrat">
      <dl className="detail-list">
        <div>
          <dt>Statut</dt>
          <dd>
            <DernierEtatConnu fraicheur={fraicheur} attente="Statut actuel : en attente de synchronisation">
              <span className={toneBadgeClass(statut.tone)}>{statut.label}</span>
            </DernierEtatConnu>
          </dd>
        </div>
        {contract.reference ? (
          <div><dt>Référence</dt><dd>{contract.reference}</dd></div>
        ) : null}
        {contract.activatedAt ? (
          <div><dt>Activé le</dt><dd>{formatDateTime(contract.activatedAt)}</dd></div>
        ) : null}
        {formatAmount(contract.pricing.subscription) ? (
          <div>
            <dt>Abonnement</dt>
            <dd>
              {formatAmount(contract.pricing.subscription)}
              {formatInterval(contract.pricing.subscription?.interval)
                ? ` ${formatInterval(contract.pricing.subscription?.interval)}`
                : ''}
            </dd>
          </div>
        ) : null}
        {formatAmount(contract.pricing.launchFee) ? (
          <div><dt>Frais de mise en service</dt><dd>{formatAmount(contract.pricing.launchFee)}</dd></div>
        ) : null}
        <div>
          <dt>Document contractuel</dt>
          <dd>
            <span className={toneBadgeClass(etatDoc.tone)}>{etatDoc.label}</span>
            {doc?.available && doc.signedAt ? ` · signé le ${formatDateTime(doc.signedAt)}` : ''}
            {doc?.pages ? ` · ${doc.pages} pages` : ''}
          </dd>
        </div>
      </dl>

      {doc?.downloadAvailable && joignable ? (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={telechargement}
          onClick={() => void telecharger()}
        >
          {telechargement ? 'Récupération…' : 'Télécharger le contrat'}
        </button>
      ) : doc?.available ? (
        <p className="muted">
          Le document existe, mais le lien avec le projet est rompu : il sera de nouveau
          téléchargeable dès le retour du site.
        </p>
      ) : (
        <p className="muted">
          Le projet n’a publié aucun document. Il reste consultable dans son Manager.
        </p>
      )}

      {message ? <div className="alert alert-success">{message}</div> : null}
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      {/* ── RÉSILIATION ─────────────────────────────────────────────────── */}
      {!reachable ? (
        <p className="muted">
          Projet injoignable : les actions contractuelles sont indisponibles pour l’instant.
        </p>
      ) : operations.length === 0 ? null : (
        <div className="contract-actions">
          {operations.map((op) => (
            <button
              key={op.id}
              type="button"
              className={op.id === CANCEL_NOW ? 'btn btn-danger btn-small' : 'btn btn-secondary btn-small'}
              disabled={!op.available}
              onClick={() => { setDemande(op); setConfirme(false); setMessage(null); }}
            >
              {op.label}
            </button>
          ))}
        </div>
      )}

      {demande ? (
        <div className="alert alert-warning">
          <strong>{demande.label} — confirmation</strong>
          <dl className="detail-list">
            <div><dt>Projet</dt><dd>{project.projectName || project.projectKey}</dd></div>
            <div><dt>Contrat</dt><dd>{contract.reference || contract.sourceContractId}</dd></div>
            <div><dt>Environnement</dt><dd>{environment ?? 'inconnu'}</dd></div>
            <div>
              <dt>Effet</dt>
              <dd>
                {demande.id === CANCEL_NOW
                  ? 'Fin immédiate du contrat.'
                  : 'Le contrat reste actif jusqu’à son échéance, puis prend fin.'}
              </dd>
            </div>
            <div>
              <dt>Date effective</dt>
              <dd>
                {demande.id === CANCEL_NOW
                  ? 'immédiatement'
                  : 'à l’échéance de la période en cours'}
              </dd>
            </div>
          </dl>

          {demande.id === CANCEL_NOW ? (
            <p>
              Cette action mettra immédiatement fin au contrat de test.
              Elle n’affectera aucun contrat de production.
            </p>
          ) : (
            <p>
              Le service reste actif jusqu’à l’échéance. Le projet appliquera la transition
              lui-même ; le Panel ne fait que transmettre la demande.
            </p>
          )}

          <label className="field">
            <span className="field-label">Motif (conservé dans le journal)</span>
            <input
              type="text"
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder="Ex. : fin de collaboration"
            />
          </label>

          {/* Une case à cocher, puis un bouton : un clic isolé ne résilie rien. */}
          <label className="field-inline">
            <input
              type="checkbox"
              checked={confirme}
              onChange={(e) => setConfirme(e.target.checked)}
            />
            <span>Je confirme cette demande de résiliation.</span>
          </label>

          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-danger btn-small"
              disabled={!confirme || enCours}
              onClick={() => void envoyer()}
            >
              {enCours ? 'Transmission…' : 'Transmettre au projet'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => { setDemande(null); setConfirme(false); setMotif(''); }}
            >
              Annuler
            </button>
          </div>
        </div>
      ) : null}
      </Card>
      <ContractHistory contracts={historique} project={project} fraicheur={fraicheur} />
    </>
  );
}

/**
 * HISTORIQUE DES CONTRATS — compact, dépliable, complet.
 *
 * Un contrat terminé reste entièrement consultable : c'est un engagement qui a
 * existé, avec ses montants, ses dates et son document signé. Ce qui était faux
 * n'était pas de le montrer, c'était de le montrer À LA PLACE du contrat
 * actuel.
 */
function ContractHistory({
  contracts,
  project,
  fraicheur,
}: {
  contracts: PreviousContract[];
  project: PublicProject;
  fraicheur: ReturnType<typeof getProjectDataFreshness>;
}) {
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [telechargement, setTelechargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  if (contracts.length === 0) return null;

  // Le document d'un contrat passé se récupère CHEZ LE PROJET : sans lien
  // vivant, le bouton mentirait.
  const joignable = project.pairing.status === 'PAIRED' && actionsDistantesPossibles(fraicheur);

  const telecharger = async (nom: string) => {
    setErreur(null);
    setTelechargement(true);
    try {
      await api.downloadContractDocument(project.projectId, nom);
    } catch (err) {
      setErreur(errorMessage(err, 'Le document n’a pas pu être récupéré.'));
    } finally {
      setTelechargement(false);
    }
  };

  return (
    <Card title={`Historique des contrats (${contracts.length})`}>
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}
      <ul className="contract-history">
        {contracts.map((c) => {
          const etat = contractState(c.status);
          const deplie = ouvert === c.sourceContractId;
          const doc = c.document;
          return (
            <li key={c.sourceContractId} className="contract-history-item">
              <div className="contract-history-line">
                <span className="contract-history-ref">{c.reference || 'Sans référence'}</span>
                <span className={toneBadgeClass(etat.tone)}>{etat.label}</span>
                <span className="muted">
                  {c.activatedAt ? formatDateTime(c.activatedAt) : '—'}
                  {c.endedAt ? ` → ${formatDateTime(c.endedAt)}` : ''}
                </span>
                <span className="muted">{formatAmount(c.pricing?.subscription) || '—'}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  aria-expanded={deplie}
                  onClick={() => setOuvert(deplie ? null : c.sourceContractId)}
                >
                  {deplie ? 'Masquer' : 'Voir'}
                </button>
              </div>

              {deplie ? (
                <div className="contract-history-detail">
                  <dl className="detail-list">
                    {c.createdAt ? (
                      <div><dt>Créé le</dt><dd>{formatDateTime(c.createdAt)}</dd></div>
                    ) : null}
                    {c.activatedAt ? (
                      <div><dt>Activé le</dt><dd>{formatDateTime(c.activatedAt)}</dd></div>
                    ) : null}
                    {c.endedAt ? (
                      <div><dt>Terminé le</dt><dd>{formatDateTime(c.endedAt)}</dd></div>
                    ) : null}
                    {c.cancellationReason ? (
                      <div><dt>Motif</dt><dd>{c.cancellationReason}</dd></div>
                    ) : null}
                    {formatAmount(c.pricing?.subscription) ? (
                      <div>
                        <dt>Abonnement</dt>
                        <dd>
                          {formatAmount(c.pricing.subscription)}
                          {formatInterval(c.pricing.subscription?.interval)
                            ? ` ${formatInterval(c.pricing.subscription?.interval)}`
                            : ''}
                        </dd>
                      </div>
                    ) : null}
                    {formatAmount(c.pricing?.launchFee) ? (
                      <div><dt>Mise en service</dt><dd>{formatAmount(c.pricing.launchFee)}</dd></div>
                    ) : null}
                    {doc?.signedAt ? (
                      <div><dt>Signé le</dt><dd>{formatDateTime(doc.signedAt)}</dd></div>
                    ) : null}
                  </dl>

                  {doc?.downloadAvailable && joignable ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={telechargement}
                      onClick={() => void telecharger(doc.filename ?? 'contrat.pdf')}
                    >
                      {telechargement ? 'Téléchargement…' : 'Télécharger le contrat'}
                    </button>
                  ) : doc?.available ? (
                    <p className="muted">Document momentanément indisponible.</p>
                  ) : (
                    <p className="muted">Aucun document n’a été publié pour ce contrat.</p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
