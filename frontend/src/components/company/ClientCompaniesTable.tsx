/**
 * LES ENTREPRISES CLIENTES, EN TABLEAU.
 *
 * ══ POURQUOI ON REVIENT À UN TABLEAU ═══════════════════════════════════════
 *
 * La liste a été une grille de cartes, puis une liste d'items. Le passage aux
 * items répondait à trois défauts RÉELS du tableau d'origine, et il faut les
 * nommer pour expliquer pourquoi ils ne s'appliquent plus :
 *
 *   1. « SIX COLONNES, AUCUNE HIÉRARCHIE » — la raison sociale avait le même
 *      poids qu'un compte de projets.
 *      → Ici, elle est l'EN-TÊTE DE LIGNE, en gras, avec l'enseigne dessous en
 *        seconde ligne atténuée. La hiérarchie est dans la cellule, pas dans
 *        le choix du conteneur.
 *
 *   2. « DES CELLULES COLLÉES » — un `<td>` nu n'a pas d'espacement propre.
 *      → Les cellules du tableau de la librairie portent leur rembourrage
 *        (24 px), et chaque groupe d'informations a sa colonne.
 *
 *   3. « AUCUNE ACTION EXPLICITE » — le seul chemin vers la fiche était le nom.
 *      → Le nom reste cliquable, ET un menu en fin de ligne nomme les actions.
 *
 * Ce que le tableau apporte en plus, et que les items ne pouvaient pas donner :
 * le TRI, et surtout la comparaison verticale. « Qui est bloqué en paiement »
 * se lit en balayant une colonne ; avec des items, il fallait lire chaque bloc.
 *
 * ══ CE QUE CHAQUE COLONNE PORTE ════════════════════════════════════════════
 *
 *   ENTREPRISE   la raison sociale — ce qui figure sur la facture — et
 *                l'enseigne quand elle diffère.
 *   ÉTAT         les deux verdicts. « Bloqué » n'est pas décoratif : ce client
 *                NE PEUT NI PAYER NI SIGNER, et chacun a sa propre réponse.
 *   SIREN        l'identifiant durable, et une mention obligatoire de la
 *                facture électronique française à compter du 1er sept. 2026.
 *   FACTURATION  à qui la facture part.
 *   PROJETS      combien de sites. C'est ce qui distingue un client d'un projet.
 */
import { useMemo, useState } from 'react';
import type { SortDescriptor } from 'react-aria-components';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Mail01 } from '@untitledui/icons';
import { Table, TableCard } from '@/components/application/table/table';
import { Avatar } from '@/components/base/avatar/avatar';
import { BadgeWithDot } from '@/components/base/badges/badges';
import { Dropdown } from '@/components/base/dropdown/dropdown';
import { EmptyPanel } from '@/components/ui-kit';
import type { ClientCompanyRow } from '@/types.clientCompany';

/** Les initiales de la raison sociale — l'illustration à défaut de logo. */
function initiales(nom: string): string {
  return nom
    .split(/[\s-]+/)
    .filter((mot) => /[a-zA-ZÀ-ÿ0-9]/.test(mot))
    .slice(0, 2)
    .map((mot) => mot[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

/**
 * UN VERDICT — et le détail des manques dans l'infobulle.
 *
 * La liste sert à BALAYER un parc : y déplier sept libellés par ligne la
 * rendrait illisible. La fiche, elle, les écrit en clair.
 */
function Verdict({
  archived,
  pret,
  manquants,
  titre,
}: {
  archived: boolean;
  pret: boolean;
  manquants: string[];
  titre: string;
}) {
  if (archived) {
    return <BadgeWithDot size="sm" color="gray">{titre} suspendus</BadgeWithDot>;
  }
  if (pret) {
    return <BadgeWithDot size="sm" color="success">{titre}</BadgeWithDot>;
  }
  return (
    <span title={`${titre} : il manque ${manquants.join(', ')}.`}>
      <BadgeWithDot size="sm" color="error">{titre} bloqués</BadgeWithDot>
    </span>
  );
}

export interface ClientCompaniesTableProps {
  rows: ClientCompanyRow[];
  title: string;
  description?: string;
  contentTrailing?: React.ReactNode;
  emptyTitle: string;
  emptyHint?: string;
  emptyAction?: React.ReactNode;
}

export function ClientCompaniesTable({
  rows,
  title,
  description,
  contentTrailing,
  emptyTitle,
  emptyHint,
  emptyAction,
}: ClientCompaniesTableProps) {
  const navigate = useNavigate();
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: 'legalName',
    direction: 'ascending',
  });

  const triees = useMemo(() => {
    const colonne = String(sortDescriptor.column ?? 'legalName');
    const sens = sortDescriptor.direction === 'descending' ? -1 : 1;

    // Une COPIE : `sort` modifie en place, et la liste vient d'une lecture
    // vivante. La trier sur place ferait muter l'état d'un hook.
    return [...rows].sort((a, b) => {
      if (colonne === 'projects') {
        const ecart = a.projectCount - b.projectCount;
        return ecart !== 0 ? ecart * sens : a.legalName.localeCompare(b.legalName, 'fr');
      }
      if (colonne === 'siren') {
        return (a.siren ?? '').localeCompare(b.siren ?? '', 'fr') * sens;
      }
      return a.legalName.localeCompare(b.legalName, 'fr') * sens;
    });
  }, [rows, sortDescriptor]);

  const entete = (
    <TableCard.Header
      title={title}
      badge={rows.length > 0 ? String(rows.length) : undefined}
      description={description}
      contentTrailing={contentTrailing}
      /* L'en-tête ne passe en ligne qu'à 1024 px : la barre latérale reprend
         250 px dès 900 px, il n'y a pas la place avant. */
      className="md:flex-col lg:flex-row lg:items-center"
    />
  );

  if (rows.length === 0) {
    return (
      <div className="uui">
        <TableCard.Root>
          {entete}
          <EmptyPanel title={emptyTitle} hint={emptyHint} action={emptyAction} />
        </TableCard.Root>
      </div>
    );
  }

  return (
    <div className="uui">
      <TableCard.Root>
        {entete}

        <Table
          aria-label="Entreprises clientes"
          selectionMode="none"
          sortDescriptor={sortDescriptor}
          onSortChange={setSortDescriptor}
        >
          <Table.Header>
            <Table.Head
              id="legalName" label="Entreprise" isRowHeader allowsSorting
              className="min-w-0 px-3 md:px-6 lg:min-w-64"
            />
            <Table.Head id="state" label="État" className="px-3 md:px-6" />
            <Table.Head
              id="siren" label="SIREN" allowsSorting
              className="hidden px-3 lg:table-cell lg:px-6"
            />
            <Table.Head
              id="billing" label="Facturation"
              className="hidden px-3 xl:table-cell xl:px-6"
            />
            <Table.Head
              id="projects" label="Projets" allowsSorting
              className="hidden px-3 sm:table-cell sm:px-6"
            />
            <Table.Head id="actions" className="px-2 md:px-4" />
          </Table.Header>

          <Table.Body items={triees}>
            {(row: ClientCompanyRow) => {
              const archivee = row.status === 'ARCHIVED';
              const enseigne = row.tradingName && row.tradingName !== row.legalName
                ? row.tradingName
                : null;

              return (
                <Table.Row id={row.clientCompanyId}>
                  <Table.Cell className="px-3 md:px-6">
                    <div className="flex items-center gap-3">
                      <Avatar
                        alt={row.legalName}
                        initials={initiales(row.legalName)}
                        size="md"
                        className="hidden sm:flex"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/clients/${row.clientCompanyId}`}
                            className="block truncate text-sm font-medium text-primary hover:underline"
                            title={row.legalName}
                          >
                            {row.legalName}
                          </Link>
                          {archivee ? (
                            <BadgeWithDot size="sm" color="gray">Archivée</BadgeWithDot>
                          ) : null}
                        </div>
                        {/*
                          L'ENSEIGNE N'EST AFFICHÉE QUE SI ELLE DIFFÈRE.
                          La répéter à l'identique donnerait l'impression de
                          deux noms distincts à maintenir séparément.
                        */}
                        {enseigne ? (
                          <span className="block truncate text-sm text-tertiary" title={enseigne}>
                            {enseigne}
                          </span>
                        ) : (
                          <span className="block text-sm text-quaternary">
                            {row.projectCount} projet{row.projectCount > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </Table.Cell>

                  <Table.Cell className="px-3 md:px-6">
                    <div className="flex flex-col items-start gap-1">
                      <Verdict
                        archived={archivee}
                        pret={row.readiness.billing.ready}
                        manquants={row.readiness.billing.missing}
                        titre="Paiements"
                      />
                      <Verdict
                        archived={archivee}
                        pret={row.readiness.signing.ready}
                        manquants={row.readiness.signing.missing}
                        titre="Signatures"
                      />
                    </div>
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 whitespace-nowrap tabular-nums lg:table-cell lg:px-6">
                    {row.siren ?? <span className="text-quaternary">Non renseigné</span>}
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 xl:table-cell xl:px-6">
                    {row.billingEmail ? (
                      <a
                        href={`mailto:${row.billingEmail}`}
                        className="flex max-w-56 items-center gap-1.5 text-sm text-tertiary hover:underline"
                        title={row.billingEmail}
                      >
                        <Mail01 className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{row.billingEmail}</span>
                      </a>
                    ) : (
                      <span className="text-sm text-quaternary">Aucune adresse</span>
                    )}
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 tabular-nums sm:table-cell sm:px-6">
                    {row.projectCount}
                  </Table.Cell>

                  <Table.Cell className="px-2 md:px-4">
                    <div className="flex items-center justify-end">
                      <Dropdown.Root>
                        <Dropdown.DotsButton />
                        <Dropdown.Popover className="w-min">
                          <Dropdown.Menu>
                            <Dropdown.Item
                              icon={ArrowRight}
                              onAction={() => navigate(`/clients/${row.clientCompanyId}`)}
                              textValue="Ouvrir la fiche"
                            >
                              <span className="pr-4">Ouvrir la fiche</span>
                            </Dropdown.Item>
                            {row.billingEmail ? (
                              <Dropdown.Item
                                icon={Mail01}
                                onAction={() => { window.location.href = `mailto:${row.billingEmail}`; }}
                                textValue="Écrire au client"
                              >
                                <span className="pr-4">Écrire au client</span>
                              </Dropdown.Item>
                            ) : null}
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown.Root>
                    </div>
                  </Table.Cell>
                </Table.Row>
              );
            }}
          </Table.Body>
        </Table>
      </TableCard.Root>
    </div>
  );
}

export default ClientCompaniesTable;
