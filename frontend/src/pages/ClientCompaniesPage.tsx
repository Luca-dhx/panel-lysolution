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
 * ══ POURQUOI UNE LISTE D'ITEMS, ET NON PLUS UN TABLEAU ══════════════════════
 *
 * Le tableau avait six colonnes pour un parc qui en compte une poignée de
 * lignes. Trois défauts, et ils se voyaient tous les trois :
 *
 *   · SIX COLONNES, AUCUNE HIÉRARCHIE. La raison sociale — la seule chose
 *     qu'on cherche — avait exactement le même poids visuel qu'un compte de
 *     projets. L'œil devait lire la ligne entière pour trouver le nom.
 *
 *   · DES CELLULES COLLÉES. Un `<td>` n'a pas d'espacement propre : SIREN,
 *     e-mail et badges se touchaient, et rien ne disait lesquels allaient
 *     ensemble.
 *
 *   · AUCUNE ACTION EXPLICITE. Le seul chemin vers la fiche était le nom, en
 *     lien — une cible minuscule, et rien à l'écran ne disait qu'il y AVAIT
 *     une fiche derrière.
 *
 * Un tableau sert à COMPARER colonne par colonne des dizaines de lignes. Ce
 * n'est pas ce qu'on fait ici : on cherche un client, on regarde s'il peut
 * facturer, on ouvre sa fiche. D'où un item par entreprise — une identité
 * dominante, ses métadonnées en second, ses verdicts en badges, et un bouton.
 *
 * ══ CE QUE CHAQUE ITEM PORTE, ET POURQUOI ═══════════════════════════════════
 *
 *   IDENTITÉ     la raison sociale — ce qui figure sur la facture. L'enseigne
 *                l'accompagne quand elle diffère, en second.
 *   SIREN        l'identifiant durable de la personne morale, et une mention
 *                obligatoire de la facture électronique au 1er septembre 2026.
 *   E-MAIL       à qui la facture part.
 *   PROJETS      combien de sites cette entreprise possède. C'est ce qui
 *                distingue un client d'un projet.
 *   VERDICTS     pas décoratifs : « bloqués » signifie que ce client NE PEUT
 *                NI PAYER NI SIGNER, et chacun des deux a sa propre réponse.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Checkbox } from '@/components/ui';
import { ClientCompaniesTable } from '@/components/company/ClientCompaniesTable';
import { PageHeader, SkeletonRows } from '@/components/ui-kit';
import { Icon } from '@/components/Icon';
import { SearchField } from '@/components/SearchField';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/ToastProvider';
import { useIsDev } from '@/auth/RequireDev';
import { clientCompanies, errorMessage } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { DuplicateSiren } from '@/types.clientCompany';
import {
  ClientCompanyForm,
  corpsPour,
  formulaireVide,
  type ClientCompanyFormValue,
} from '@/components/company/ClientCompanyForm';

/*
 * ── `VerdictBadge` ET `EntrepriseItem` ONT DÉMÉNAGÉ ────────────────────────
 *
 * Ils rendaient la liste sous forme d'items. Cette page rend désormais un
 * TABLEAU : les deux vivent, adaptés, dans
 * `components/company/ClientCompaniesTable.tsx`, qui explique en tête pourquoi
 * les trois défauts ayant motivé les items ne s'appliquent plus.
 */

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
      {/*
        ── L'EN-TÊTE COMMUN, ET LES OUTILS DANS L'EN-TÊTE DU TABLEAU ─────────

        La barre d'outils vivait entre le titre et la liste, sur deux lignes :
        actions et case à cocher d'abord, recherche ensuite. Elle occupait
        toute la largeur pour trois contrôles, et à 900 px — au moment où la
        barre latérale apparaît — elle repoussait la première ligne de la liste
        sous la ligne de flottaison.

        Les outils qui gouvernent CE QUE LA LISTE MONTRE sont désormais DANS
        l'en-tête du tableau, à côté de son titre. L'action de création, elle,
        reste dans l'en-tête de PAGE : elle ne filtre rien, elle crée.
      */}
      <PageHeader
        title="Clients"
        description="Les entreprises clientes de L.Y Solution. Leur identité légale fait autorité sur les factures et les contrats de leurs projets."
        actions={isDev ? (
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => setCreation(formulaireVide())}
          >
            <Icon name="plus-lg" size={13} />
            Nouvelle entreprise
          </button>
        ) : null}
      />

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

      {isInitialLoading ? (
        <div className="uui overflow-hidden rounded-xl ring-1 ring-secondary">
          <SkeletonRows rows={5} columns={4} />
        </div>
      ) : (
        <ClientCompaniesTable
          rows={lignes}
          title={avecArchivees ? 'Toutes les entreprises' : 'Entreprises actives'}
          description="Le nom mène à la fiche. « Bloqué » signifie que ce client ne peut ni payer ni signer."
          emptyTitle={recherche ? 'Aucune entreprise ne correspond' : 'Aucune entreprise cliente'}
          emptyHint={
            recherche
              ? 'Essayez une autre raison sociale, ou un SIREN.'
              : 'Créez la fiche d’un client pour pouvoir lui facturer un projet.'
          }
          contentTrailing={(
            <div className="flex w-full flex-wrap items-center gap-4 lg:w-auto lg:justify-end">
              <Checkbox
                checked={avecArchivees}
                onChange={setAvecArchivees}
                label="Afficher les archivées"
              />
              <div className="min-w-0 flex-1 lg:w-64 lg:flex-none">
                <SearchField
                  value={recherche}
                  onChange={setRecherche}
                  label="Rechercher une entreprise"
                  placeholder="Raison sociale ou SIREN…"
                />
              </div>
            </div>
          )}
        />
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
