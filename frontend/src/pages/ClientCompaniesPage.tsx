/**
 * CLIENTS — les ENTREPRISES CLIENTES de L.Y Solution.
 *
 * ══ CE QUE CETTE PAGE N'EST PAS ═════════════════════════════════════════════
 *
 * Ce n'est pas « Projets clients ». Un projet est une INSTANCE technique — un
 * site, une base, un appairage. Une entreprise cliente est une PERSONNE MORALE,
 * et elle possède souvent plusieurs projets :
 *
 *     SARL DUPONT AUTOMOBILES
 *       ├── Demo SB Auto      (recette)
 *       └── sbauto06.fr       (production)
 *
 * Les deux pages existaient déjà en substance, sauf que la seconde n'existait
 * pas : le Panel connaissait des sites, pas des sociétés. C'est pourquoi ses
 * factures portaient « Facturer à : CTR-2026-0002 » — une référence de contrat
 * en guise de raison sociale, faute de mieux.
 *
 * ══ CE QU'ON VOIT, ET POURQUOI CES COLONNES-LÀ ══════════════════════════════
 *
 *   ENTREPRISE   la raison sociale — ce qui figure sur la facture. L'enseigne
 *                l'accompagne quand elle diffère, en second.
 *   SIREN        l'identifiant durable de la personne morale, et une mention
 *                obligatoire de la facture électronique au 1er septembre 2026.
 *   PROJETS      combien de sites cette entreprise possède. C'est ce qui
 *                distingue un client d'un projet.
 *   ÉTAT         pas un état décoratif : « incomplète » signifie que ce client
 *                NE PEUT NI PAYER NI SIGNER.
 *   CONTACT      à qui la facture part.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState } from '@/components/ui';
import { SearchField } from '@/components/SearchField';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/ToastProvider';
import { useIsDev } from '@/auth/RequireDev';
import { clientCompanies, errorMessage } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { ClientCompanyRow, DuplicateSiren } from '@/types.clientCompany';
import {
  ClientCompanyForm,
  corpsPour,
  formulaireVide,
  type ClientCompanyFormValue,
} from '@/components/company/ClientCompanyForm';

/**
 * LE VERDICT, EN UN MOT ET UNE COULEUR.
 *
 * Il vient du BACKEND (`readiness`) : la complétude est une règle de
 * facturation, et la recopier ici produirait une seconde implémentation qui
 * divergerait au premier changement de mention obligatoire.
 */
function EtatBadge({ row }: { row: ClientCompanyRow }) {
  if (row.status === 'ARCHIVED') return <span className="badge badge-muted">Archivée</span>;
  if (row.readiness.ready) return <span className="badge badge-ok">Prête</span>;
  if (!row.readiness.billing.ready) return <span className="badge badge-danger">Facturation incomplète</span>;
  return <span className="badge badge-warn">Signataire manquant</span>;
}

export function ClientCompaniesPage() {
  const isDev = useIsDev();
  const toast = useToast();
  const [recherche, setRecherche] = useState('');
  const [avecArchivees, setAvecArchivees] = useState(false);
  const [creation, setCreation] = useState<ClientCompanyFormValue | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  /**
   * LE DOUBLON DE SIREN RESTE À L'ÉCRAN, il ne passe pas en notification.
   *
   * Une notification disparaît en quatre secondes ; ceci est une information
   * sur laquelle l'opérateur doit AGIR — vérifier l'autre fiche, décider de
   * fusionner ou de corriger. Elle reste donc affichée jusqu'à ce qu'il la
   * ferme.
   */
  const [doublon, setDoublon] = useState<DuplicateSiren | null>(null);

  /**
   * LA RECHERCHE EST FAITE PAR LE SERVEUR, pas par le navigateur.
   *
   * Un filtrage local exigerait de charger toutes les fiches — ce qui va bien
   * jusqu'à la centième, et cesse d'aller après. Le serveur cherche déjà sur le
   * nom ET le SIREN, avec l'échappement qui va avec.
   *
   * `key` porte les critères : quand ils changent, c'est une AUTRE liste, et
   * le premier chargement est légitime plutôt qu'un rafraîchissement muet.
   */
  const { data, isInitialLoading, error, reload } = useLiveQuery(
    () => clientCompanies.listClientCompanies({
      search: recherche.trim(),
      status: avecArchivees ? undefined : 'ACTIVE',
    }),
    {
      /**
       * Une entreprise cliente ne change pas toute seule : aucune écriture
       * automatique ne la touche. Le sondage est donc LENT — il rattrape la
       * modification faite par un collègue, pas un flux d'événements.
       */
      intervalMs: 60_000,
      fallbackError: 'Les entreprises clientes n’ont pas pu être chargées.',
      key: `${recherche.trim()}|${avecArchivees}`,
    },
  );

  const lignes = data?.clientCompanies ?? [];

  const creer = async () => {
    if (!creation) return;
    setEnregistrement(true);
    try {
      const resultat = await clientCompanies.createClientCompany(corpsPour(creation));
      /**
       * LE DOUBLON DE SIREN EST SIGNALÉ, JAMAIS BLOQUANT.
       *
       * Une reprise de fiche, une fusion en cours, une correction en deux temps
       * produisent légitimement deux fiches d'un même SIREN. Refuser obligerait
       * à supprimer une fiche RÉFÉRENCÉE par des factures pour pouvoir en
       * corriger une autre — un remède pire que le mal.
       */
      setDoublon(resultat.duplicateSiren);
      toast.success('Entreprise cliente créée.');
      setCreation(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err, 'La fiche n’a pas pu être créée.'));
    } finally {
      setEnregistrement(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Clients</h1>
        <p className="page-description">
          Les entreprises clientes de L.Y Solution. Leur identité légale fait autorité sur les
          factures et les contrats de leurs projets.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {doublon ? (
        <div className="alert alert-warn">
          Le SIREN saisi est déjà porté par «{' '}
          <Link to={`/clients/${doublon.clientCompanyId}`}>{doublon.legalName}</Link> ». La fiche a
          bien été créée — vérifiez qu’il ne s’agit pas d’un doublon.{' '}
          <button type="button" className="btn btn-link" onClick={() => setDoublon(null)}>
            J’ai vérifié
          </button>
        </div>
      ) : null}

      <div className="toolbar">
        <SearchField
          value={recherche}
          onChange={setRecherche}
          label="Rechercher une entreprise"
          placeholder="Raison sociale ou SIREN…"
        />
        <label className="toolbar-check">
          <input
            type="checkbox"
            checked={avecArchivees}
            onChange={(e) => setAvecArchivees(e.target.checked)}
          />
          Afficher les archivées
        </label>
        {/*
          LA CRÉATION EST RÉSERVÉE AUX COMPTES DEV.
          Ce qui est saisi ici finit sur une facture et sur un contrat signé :
          la garde n'est pas hiérarchique, elle est proportionnée à ce qu'une
          erreur de saisie produit chez un tiers. Le backend applique la même
          règle, et c'est LUI la barrière — ce bouton ne fait que la refléter.
        */}
        {isDev ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreation(formulaireVide())}>
            Nouvelle entreprise
          </button>
        ) : null}
      </div>

      {isInitialLoading ? (
        <p className="muted">Chargement des entreprises clientes…</p>
      ) : lignes.length === 0 ? (
        <EmptyState
          title={recherche ? 'Aucune entreprise ne correspond' : 'Aucune entreprise cliente'}
          hint={
            recherche
              ? 'Essayez une autre raison sociale, ou un SIREN.'
              : 'Créez la fiche d’un client pour pouvoir lui facturer un projet.'
          }
        />
      ) : (
        <Card className="table-card">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Entreprise</th>
                  <th>SIREN</th>
                  <th>Projets</th>
                  <th>État</th>
                  <th>Contact</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((row) => (
                  <tr key={row.clientCompanyId}>
                    <td>
                      <Link to={`/clients/${row.clientCompanyId}`}>{row.legalName}</Link>
                      {/*
                        L'ENSEIGNE N'EST AFFICHÉE QUE SI ELLE DIFFÈRE.
                        La répéter à l'identique donnerait l'impression de deux
                        noms distincts à maintenir séparément.
                      */}
                      {row.tradingName && row.tradingName !== row.legalName ? (
                        <div className="muted">{row.tradingName}</div>
                      ) : null}
                    </td>
                    <td>{row.siren ?? <span className="muted">—</span>}</td>
                    <td>{row.projectCount}</td>
                    <td><EtatBadge row={row} /></td>
                    <td>{row.billingEmail ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creation ? (
        <Modal
          title="Nouvelle entreprise cliente"
          hint="Seule la raison sociale est obligatoire. Les autres champs peuvent être complétés plus tard — mais la facturation restera bloquée tant que l’identité légale est incomplète."
          onClose={() => setCreation(null)}
        >
          <ClientCompanyForm value={creation} onChange={setCreation} />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setCreation(null)}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={enregistrement || creation.legalName.trim().length < 2}
              onClick={creer}
            >
              {enregistrement ? 'Création…' : 'Créer'}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export default ClientCompaniesPage;
