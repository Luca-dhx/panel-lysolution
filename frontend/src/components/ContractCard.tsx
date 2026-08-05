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
import { getProjectDataFreshness } from '@/lib/projectFreshness';
import {
  contractState,
  formatAmount,
  formatInterval,
  toneBadgeClass,
} from '@/lib/projectPresentation';
import { getContractDocumentPresentation } from '@/lib/contractDocument';
import type { ContractDocumentPresentation } from '@/lib/contractDocument';
import type {
  BusinessContract, ContractOperation, PreviousContract, PublicProject,
} from '@/types';

const CANCEL_NOW = 'contract.cancel_now';

/**
 * POURQUOI les actions contractuelles sont indisponibles — la vraie raison.
 *
 * Un bouton grisé sans explication laisse chercher. Et « projet injoignable »
 * sur un projet connecté dont la projection vient d'un autre environnement
 * serait faux : la cause est la donnée, pas le réseau.
 */
function raisonActionsIndisponibles(
  fraicheur: ReturnType<typeof getProjectDataFreshness>,
  project: PublicProject,
): string {
  if (project.pairing.status !== 'PAIRED') {
    return 'Ce projet n’est pas relié : aucune action contractuelle n’est possible.';
  }
  if (fraicheur.isEnvironmentMismatch) {
    return 'Les données affichées viennent de l’environnement précédent : les actions contractuelles sont suspendues tant que la synchronisation n’a pas rattrapé le nouvel environnement.';
  }
  if (fraicheur.isGenerationMismatch) {
    return 'Les données affichées viennent d’une génération précédente du projet : les actions contractuelles sont suspendues.';
  }
  return 'Projet injoignable : les actions contractuelles sont indisponibles pour l’instant.';
}

/**
 * LE DOCUMENT CONTRACTUEL, présenté comme ce qu'il est : un fichier.
 *
 * Il était réduit à une ligne de la liste de définitions, avec une pastille qui
 * mélangeait sa disponibilité et l'état de sa signature. Ce sont deux choses
 * distinctes : un document peut être disponible sans signature requise, ou
 * signé mais introuvable sur le stockage. Chacune a donc sa place.
 *
 * Le vocabulaire change aussi : le document est IMPORTÉ dans le projet, jamais
 * fabriqué par lui. « Généré » / « Non généré » décrivait une production
 * imaginaire et faisait attendre une étape qui n'existe pas.
 */
function DocumentFile({
  presentation,
  signedAt,
  enCours,
  onDownload,
}: {
  presentation: ContractDocumentPresentation;
  signedAt: string | null;
  enCours: boolean;
  onDownload: () => void;
}) {
  const { availability, availabilityLabel, signatureLabel, filename, pages } = presentation;
  return (
    <section className="doc-file" aria-label="Document contractuel">
      <div className="doc-file-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" strokeLinejoin="round" />
          <path d="M14 2v5h5" strokeLinejoin="round" />
        </svg>
        <span className="doc-file-ext">PDF</span>
      </div>

      <div className="doc-file-body">
        <p className="doc-file-name" title={filename ?? undefined}>
          {filename || 'Document contractuel'}
        </p>
        <p className="doc-file-meta">
          PDF
          {pages ? ` · ${pages} page${pages > 1 ? 's' : ''}` : ''}
          {signedAt ? ` · signé le ${formatDateTime(signedAt)}` : ''}
        </p>
        <div className="doc-file-tags">
          <span className={availability === 'AVAILABLE' ? 'badge badge-ok' : 'badge badge-muted'}>
            {availabilityLabel}
          </span>
          {/* La signature est un AUTRE axe : elle a sa propre étiquette. */}
          {signatureLabel ? <span className="badge badge-neutral">{signatureLabel}</span> : null}
        </div>
        {presentation.message ? <p className="doc-file-note">{presentation.message}</p> : null}
      </div>

      {/* Aucun faux bouton : il n'apparaît que si le fichier est réellement
          servable — projet relié, qui répond, données du bon monde. */}
      {presentation.showDownload ? (
        <button
          type="button"
          className="btn btn-secondary btn-small doc-file-action"
          disabled={enCours}
          onClick={onDownload}
        >
          {enCours ? 'Récupération…' : 'Télécharger'}
        </button>
      ) : null}
    </section>
  );
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
  /**
   * L'ÉTAT DU DOCUMENT est calculé À PART, et il ne parle que du document.
   *
   * Cette carte concluait auparavant d'un axe sur l'autre : téléchargement
   * impossible ⇒ « le lien avec le projet est rompu ». Sur un projet en ligne
   * dont le fichier manque, l'écran affirmait donc « connecté » et « lien
   * rompu » en même temps. La connexion, la fraîcheur, le contrat et le
   * document sont désormais quatre axes lus séparément.
   */
  const doc0 = getContractDocumentPresentation({
    document: contract.document,
    contract,
    freshness: fraicheur,
    paired: project.pairing.status === 'PAIRED',
  });
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
      </dl>

      <DocumentFile
        presentation={doc0}
        signedAt={doc?.signedAt ?? null}
        enCours={telechargement}
        onDownload={() => void telecharger()}
      />

      {message ? <div className="alert alert-success">{message}</div> : null}
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      {/* ── RÉSILIATION ─────────────────────────────────────────────────── */}
      {/*
        Deux conditions, et elles ne se remplacent pas : le projet doit répondre
        (`reachable`, constaté à l'appel), ET ce qu'on affiche doit décrire ce
        projet-ci maintenant (`showRemoteActions` : bon environnement, bonne
        génération, connexion vivante). Agir sur la foi d'une projection d'un
        autre monde reviendrait à résilier à l'aveugle.
      */}
      {!doc0.showRemoteActions ? (
        <p className="muted">{raisonActionsIndisponibles(fraicheur, project)}</p>
      ) : !reachable ? (
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
          // Même calcul que la carte du contrat courant : un contrat historique
          // n'autorise pas plus l'écran à confondre document et connexion.
          const docEtat = getContractDocumentPresentation({
            document: doc,
            contract: c,
            freshness: fraicheur,
            paired: project.pairing.status === 'PAIRED',
          });
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

                  </dl>

                  {/* Même fiche de fichier que pour le contrat courant. */}
                  <DocumentFile
                    presentation={docEtat}
                    signedAt={doc?.signedAt ?? null}
                    enCours={telechargement}
                    onDownload={() => void telecharger(doc?.filename ?? 'contrat.pdf')}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
