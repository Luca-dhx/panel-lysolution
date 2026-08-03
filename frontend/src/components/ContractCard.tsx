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
import {
  contractState,
  formatAmount,
  formatInterval,
  toneBadgeClass,
} from '@/lib/projectPresentation';
import type { BusinessContract, ContractOperation, PublicProject } from '@/types';

const CANCEL_NOW = 'contract.cancel_now';

/** État du document, en français, sans jargon de signature électronique. */
function documentState(contract: BusinessContract): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  const doc = contract.document;
  if (!doc?.available) return { label: 'Non généré', tone: 'neutral' };
  if (doc.kind === 'SIGNED') return { label: 'Signé', tone: 'ok' };
  if (doc.signatureStatus === 'ONGOING') return { label: 'En attente de signature', tone: 'warn' };
  if (doc.signatureStatus === 'DECLINED') return { label: 'Signature refusée', tone: 'warn' };
  if (doc.signatureStatus === 'EXPIRED') return { label: 'Signature expirée', tone: 'warn' };
  return { label: 'Généré, non signé', tone: 'warn' };
}

export function ContractCard({
  project,
  contract,
}: {
  project: PublicProject;
  contract: BusinessContract | null;
}) {
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

  if (!contract) {
    return (
      <Card title="Contrat">
        <p className="muted">Aucun contrat actif synchronisé.</p>
      </Card>
    );
  }

  const doc = contract.document;
  const etatDoc = documentState(contract);
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
    <Card title="Contrat">
      <dl className="detail-list">
        <div>
          <dt>Statut</dt>
          <dd><span className={toneBadgeClass(statut.tone)}>{statut.label}</span></dd>
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
            {doc?.available && doc.pageCount ? ` · ${doc.pageCount} pages` : ''}
          </dd>
        </div>
      </dl>

      {doc?.available ? (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={telechargement}
          onClick={() => void telecharger()}
        >
          {telechargement ? 'Récupération…' : 'Télécharger le contrat'}
        </button>
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
  );
}
