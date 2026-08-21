/**
 * FICHE D'UNE ENTREPRISE CLIENTE — l'autorité de son identité juridique.
 *
 * ══ SIX SECTIONS, ET PAS UNE DE PLUS ════════════════════════════════════════
 *
 *   IDENTITÉ     raison sociale, forme, SIREN/SIRET, TVA
 *   COORDONNÉES  adresses, téléphone, contact administratif
 *   FACTURATION  à qui la facture part, et à quelle adresse
 *   SIGNATAIRE   qui engage l'entreprise
 *   PROJETS      quels sites lui appartiennent
 *   DOCUMENTS    Kbis, attestation, mandat, RIB…
 *
 * Un écran par section aurait été plus « propre » et aurait obligé à naviguer
 * six fois pour répondre à la seule question qu'on se pose vraiment devant une
 * fiche client : « est-ce que je peux lui facturer quelque chose ? ».
 *
 * ══ CE QUE LA BANNIÈRE DIT EN PREMIER ═══════════════════════════════════════
 *
 * Précisément cette question. Une fiche incomplète ne bloque pas seulement un
 * champ : elle BLOQUE LES PAIEMENTS et LES SIGNATURES de tous les projets
 * rattachés. C'est la conséquence, pas le champ manquant, qui doit se lire en
 * premier.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Card, EmptyState } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/ToastProvider';
import { useIsDev } from '@/auth/RequireDev';
import { clientCompanies, errorMessage } from '@/lib/api';
import { useProjects } from '@/lib/useProjects';
import { formatDateTime } from '@/lib/format';
import type { ClientAddress, ClientCompanyDetail } from '@/types.clientCompany';
import {
  ClientCompanyForm,
  corpsPour,
  formulaireDepuis,
  type ClientCompanyFormValue,
} from '@/components/company/ClientCompanyForm';

/** Une adresse sur une ligne. Les morceaux absents sont ÉCARTÉS, pas remplacés. */
function adresseLisible(adresse: ClientAddress | null): string | null {
  if (!adresse) return null;
  const rue = [adresse.line1, adresse.line2].map((v) => String(v ?? '').trim()).filter(Boolean);
  const ville = [adresse.postalCode, adresse.city].map((v) => String(v ?? '').trim()).filter(Boolean);
  const pays = String(adresse.country ?? '').trim();
  const morceaux = [...rue, ville.join(' '), pays && pays !== 'FR' ? pays : ''].filter(Boolean);
  return morceaux.length > 0 ? morceaux.join(', ') : null;
}

/** Une ligne « libellé / valeur ». `null` n'affiche rien plutôt qu'un tiret nu. */
function Ligne({ label, value }: { label: string; value: string | null | undefined }) {
  const texte = String(value ?? '').trim();
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{texte || <span className="muted">—</span>}</span>
    </div>
  );
}

export function ClientCompanyDetailPage() {
  const { clientCompanyId = '' } = useParams();
  const isDev = useIsDev();
  const toast = useToast();
  const { projects } = useProjects();

  const [fiche, setFiche] = useState<ClientCompanyDetail | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [edition, setEdition] = useState<ClientCompanyFormValue | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  const [rattachement, setRattachement] = useState<string>('');
  const [depot, setDepot] = useState<{ file: File | null; label: string; type: string; date: string } | null>(null);

  const charger = async () => {
    try {
      const { clientCompany } = await clientCompanies.getClientCompany(clientCompanyId);
      setFiche(clientCompany);
      setErreur(null);
    } catch (err) {
      setErreur(errorMessage(err, 'Cette entreprise cliente n’a pas pu être chargée.'));
    } finally {
      setChargement(false);
    }
  };

  useEffect(() => {
    void charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientCompanyId]);

  if (chargement) return <p className="muted">Chargement de la fiche…</p>;
  if (erreur || !fiche) {
    return (
      <div className="page">
        <EmptyState title="Entreprise introuvable" hint={erreur ?? undefined} />
      </div>
    );
  }

  const enregistrer = async () => {
    if (!edition) return;
    setEnregistrement(true);
    try {
      const resultat = await clientCompanies.updateClientCompany(clientCompanyId, corpsPour(edition));
      setFiche(resultat.clientCompany);
      setEdition(null);
      toast.success(
        resultat.duplicateSiren
          ? `Fiche enregistrée. Attention : ce SIREN est aussi porté par « ${resultat.duplicateSiren.legalName} ».`
          : 'Fiche enregistrée et publiée aux projets rattachés.',
      );
    } catch (err) {
      toast.error(errorMessage(err, 'La fiche n’a pas pu être enregistrée.'));
    } finally {
      setEnregistrement(false);
    }
  };

  const rattacher = async () => {
    if (!rattachement) return;
    try {
      const resultat = await clientCompanies.linkProjectToClientCompany(clientCompanyId, rattachement);
      setRattachement('');
      await charger();
      /**
       * L'AVERTISSEMENT SUR LE CONTRAT EN COURS.
       *
       * Le client Stripe est lié au CONTRAT, pas au projet. Un contrat déjà
       * ouvert garde donc son identité de facturation : le nouveau
       * rattachement ne vaut que pour les opérations à venir. Le dire ici évite
       * de le découvrir sur la facture suivante.
       */
      if (resultat.pendingContract) {
        toast.success(
          `Projet rattaché. Le contrat ${resultat.pendingContract.reference ?? 'en cours'} conserve `
          + 'son identité de facturation : la nouvelle s’appliquera au prochain contrat.',
        );
      } else {
        toast.success('Projet rattaché.');
      }
    } catch (err) {
      toast.error(errorMessage(err, 'Le projet n’a pas pu être rattaché.'));
    }
  };

  const detacher = async (projectId: string) => {
    try {
      await clientCompanies.unlinkProjectFromClientCompany(projectId);
      await charger();
      toast.success('Projet détaché — ses paiements et signatures sont suspendus.');
    } catch (err) {
      toast.error(errorMessage(err, 'Le projet n’a pas pu être détaché.'));
    }
  };

  const basculerArchive = async () => {
    try {
      if (fiche.status === 'ARCHIVED') {
        const { clientCompany } = await clientCompanies.restoreClientCompany(clientCompanyId);
        setFiche(clientCompany);
        toast.success('Entreprise réactivée.');
      } else {
        const { clientCompany } = await clientCompanies.archiveClientCompany(clientCompanyId);
        setFiche(clientCompany);
        toast.success('Entreprise archivée — paiements et signatures suspendus.');
      }
    } catch (err) {
      toast.error(errorMessage(err, 'L’état de la fiche n’a pas pu être changé.'));
    }
  };

  const deposer = async () => {
    if (!depot?.file || !depot.label.trim()) return;
    try {
      const maj = await clientCompanies.uploadClientDocument(clientCompanyId, depot.file, {
        label: depot.label.trim(),
        type: depot.type.trim() || null,
        documentDate: depot.date || null,
      });
      setFiche(maj);
      setDepot(null);
      toast.success('Document déposé.');
    } catch (err) {
      toast.error(errorMessage(err, 'Le document n’a pas pu être déposé.'));
    }
  };

  const telecharger = async (documentId: string, label: string) => {
    try {
      await clientCompanies.downloadClientDocument(clientCompanyId, documentId, label);
    } catch (err) {
      toast.error(errorMessage(err, 'Le document n’a pas pu être récupéré.'));
    }
  };

  const retirer = async (documentId: string) => {
    try {
      const { clientCompany } = await clientCompanies.removeClientDocument(clientCompanyId, documentId);
      setFiche(clientCompany);
      toast.success('Document retiré.');
    } catch (err) {
      toast.error(errorMessage(err, 'Le document n’a pas pu être retiré.'));
    }
  };

  /** Les projets encore RATTACHABLES : ceux qui n'appartiennent à personne ici. */
  const dejaRattaches = new Set(fiche.projects.map((p) => p.projectId));
  const rattachables = projects.filter((p) => !dejaRattaches.has(p.projectId));

  const siege = adresseLisible(fiche.registeredOffice);
  const facturation = adresseLisible(fiche.billingAddressEffective);
  const signataire = fiche.contractualSigner;
  const nomSignataire = [signataire?.firstName, signataire?.lastName]
    .map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');

  return (
    <div className="page">
      <header className="page-header">
        <p className="page-eyebrow"><Link to="/clients">← Clients</Link></p>
        <h1>{fiche.legalName}</h1>
        <p className="page-description">
          {fiche.tradingName && fiche.tradingName !== fiche.legalName ? `${fiche.tradingName} — ` : ''}
          {fiche.projects.length} projet(s) rattaché(s)
        </p>
      </header>

      {/*
        ── CE QUE CETTE FICHE PERMET, OU EMPÊCHE ────────────────────────────
        La conséquence en premier, le champ manquant ensuite. « SIREN absent »
        n'a de sens que si l'on sait ce qu'il empêche.
      */}
      {fiche.status === 'ARCHIVED' ? (
        <div className="alert alert-warn">
          Cette entreprise est <strong>archivée</strong>. Ses projets ne peuvent ni payer ni signer.
          Sa fiche et son histoire restent intégralement consultables.
        </div>
      ) : !fiche.readiness.ready ? (
        <div className="alert alert-warn">
          {!fiche.readiness.billing.ready ? (
            <p>
              <strong>Aucun paiement possible</strong> pour les projets de ce client :{' '}
              {fiche.readiness.billing.missing.join(', ')}.
            </p>
          ) : null}
          {!fiche.readiness.signing.ready ? (
            <p>
              <strong>Aucune signature possible</strong> : {fiche.readiness.signing.missing.join(', ')}.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="alert alert-ok">
          Fiche complète : les projets de ce client peuvent payer et signer.
        </div>
      )}

      {isDev ? (
        <div className="contract-actions">
          <button type="button" className="btn btn-primary" onClick={() => setEdition(formulaireDepuis(fiche))}>
            Modifier la fiche
          </button>
          <button type="button" className="btn btn-secondary" onClick={basculerArchive}>
            {fiche.status === 'ARCHIVED' ? 'Réactiver' : 'Archiver'}
          </button>
        </div>
      ) : null}

      <Card title="Identité">
        <Ligne label="Raison sociale" value={fiche.legalName} />
        <Ligne label="Nom commercial" value={fiche.tradingName} />
        <Ligne label="Forme juridique" value={fiche.legalForm} />
        <Ligne label="SIREN" value={fiche.siren} />
        <Ligne label="SIRET" value={fiche.siret} />
        <Ligne label="N° de TVA" value={fiche.vatNumber} />
        <Ligne label="Ville d’immatriculation" value={fiche.registrationCity} />
      </Card>

      <Card title="Coordonnées et facturation">
        <Ligne label="Siège social" value={siege} />
        {/* L'adresse de facturation n'apparaît que si elle DIFFÈRE du siège. */}
        {facturation && facturation !== siege ? (
          <Ligne label="Adresse de facturation" value={facturation} />
        ) : null}
        <Ligne label="E-mail de facturation" value={fiche.billingEmail} />
        <Ligne label="Téléphone" value={fiche.phone} />
        <Ligne label="Site web" value={fiche.website} />
        <Ligne label="Contact administratif" value={fiche.administrativeContact?.name} />
        <Ligne label="E-mail du contact" value={fiche.administrativeContact?.email} />
      </Card>

      <Card title="Signataire contractuel">
        {nomSignataire ? (
          <>
            <Ligne label="Nom" value={nomSignataire} />
            <Ligne label="Fonction" value={signataire?.jobTitle} />
            <Ligne label="E-mail" value={signataire?.email} />
          </>
        ) : (
          <p className="muted">
            Aucun signataire désigné. Aucune demande de signature ne pourra être ouverte pour les
            projets de ce client.
          </p>
        )}
      </Card>

      <Card title="Projets rattachés">
        {fiche.projects.length === 0 ? (
          <p className="muted">Aucun projet n’est rattaché à cette entreprise.</p>
        ) : (
          <ul className="list-plain">
            {fiche.projects.map((p) => (
              <li key={p.projectId} className="detail-row">
                <span className="detail-value">
                  <Link to={`/projects/${p.projectId}`}>{p.projectName}</Link>
                  {p.environment ? <span className="muted"> — {p.environment}</span> : null}
                </span>
                {isDev ? (
                  <button type="button" className="btn btn-link" onClick={() => detacher(p.projectId)}>
                    Détacher
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {isDev ? (
          <div className="form-actions">
            <select
              className="input"
              value={rattachement}
              onChange={(e) => setRattachement(e.target.value)}
              aria-label="Projet à rattacher"
            >
              <option value="">Rattacher un projet…</option>
              {rattachables.map((p) => (
                <option key={p.projectId} value={p.projectId}>{p.projectName}</option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary" disabled={!rattachement} onClick={rattacher}>
              Rattacher
            </button>
          </div>
        ) : null}
      </Card>

      <Card title="Documents">
        {/*
          ── AUCUNE URL N'EXISTE POUR CES FICHIERS ──────────────────────────
          Ils vivent dans le stockage PRIVÉ du Panel, qu'aucun serveur statique
          ne dessert. Le téléchargement passe par une route authentifiée portée
          par CETTE fiche : un identifiant récupéré ailleurs ne mène nulle part.
        */}
        {fiche.documents.length === 0 ? (
          <p className="muted">Aucun document déposé.</p>
        ) : (
          <ul className="list-plain">
            {fiche.documents.map((d) => (
              <li key={d.documentId} className="detail-row">
                <span className="detail-value">
                  {d.label}
                  {d.type ? <span className="muted"> — {d.type}</span> : null}
                  <span className="muted"> · déposé le {formatDateTime(d.uploadedAt)}</span>
                </span>
                <span>
                  <button type="button" className="btn btn-link" onClick={() => telecharger(d.documentId, d.label)}>
                    Télécharger
                  </button>
                  {isDev ? (
                    <button type="button" className="btn btn-link" onClick={() => retirer(d.documentId)}>
                      Retirer
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {isDev ? (
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDepot({ file: null, label: '', type: '', date: '' })}
            >
              Déposer un document
            </button>
          </div>
        ) : null}
      </Card>

      {fiche.notes ? (
        <Card title="Note interne">
          <p>{fiche.notes}</p>
          <p className="muted">Jamais publiée au projet, jamais imprimée sur une facture.</p>
        </Card>
      ) : null}

      {edition ? (
        <Modal
          title={`Modifier « ${fiche.legalName} »`}
          hint="L’enregistrement publie immédiatement la nouvelle identité aux projets rattachés. Les factures et contrats DÉJÀ émis ne sont jamais réécrits."
          onClose={() => setEdition(null)}
        >
          <ClientCompanyForm value={edition} onChange={setEdition} />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setEdition(null)}>Annuler</button>
            <button type="button" className="btn btn-primary" disabled={enregistrement} onClick={enregistrer}>
              {enregistrement ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </Modal>
      ) : null}

      {depot ? (
        <Modal
          title="Déposer un document"
          hint="Kbis, attestation de vigilance, mandat, RIB… Le fichier n’est jamais servi par une adresse publique."
          onClose={() => setDepot(null)}
        >
          <div className="form">
            <label className="field">
              <span className="field-label">Fichier</span>
              <input
                className="input"
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => setDepot({ ...depot, file: e.target.files?.[0] ?? null })}
              />
            </label>
            <label className="field">
              <span className="field-label">Nom du document *</span>
              <input
                className="input"
                value={depot.label}
                onChange={(e) => setDepot({ ...depot, label: e.target.value })}
                placeholder="Kbis 2026"
              />
            </label>
            <label className="field">
              <span className="field-label">Catégorie</span>
              <input
                className="input"
                value={depot.type}
                onChange={(e) => setDepot({ ...depot, type: e.target.value })}
                placeholder="KBIS"
              />
              <span className="field-hint">Libre : KBIS, RIB, MANDAT… ou rien.</span>
            </label>
            <label className="field">
              <span className="field-label">Date du document</span>
              <input
                className="input"
                type="date"
                value={depot.date}
                onChange={(e) => setDepot({ ...depot, date: e.target.value })}
              />
              <span className="field-hint">La date du document lui-même, pas celle du dépôt.</span>
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setDepot(null)}>Annuler</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!depot.file || depot.label.trim().length === 0}
              onClick={deposer}
            >
              Déposer
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export default ClientCompanyDetailPage;
