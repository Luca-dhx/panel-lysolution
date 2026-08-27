/**
 * LE TABLEAU DE PROSPECTION.
 *
 * ══ D'OÙ IL VIENT ═══════════════════════════════════════════════════════════
 *
 * Du composant `Table` d'Untitled UI (variante « divider line »), remanié pour
 * nos données. Ce qui a été gardé : la structure React Aria — donc le tri au
 * clavier, l'annonce des colonnes triables aux lecteurs d'écran, le focus
 * visible sur chaque cellule. Ce qui a été jeté : les colonnes de démonstration
 * (barre de licence, pile d'avatars) et le menu d'actions figé.
 *
 * ══ RESPONSIVE : AUCUNE COLONNE INDISPENSABLE NE DISPARAÎT ══════════════════
 *
 * Un tableau à sept colonnes sur un écran de 390 px n'a que deux issues : une
 * barre de défilement horizontale qu'on ne trouve pas, ou des colonnes écrasées
 * illisibles. Les colonnes sortent donc PAR PALIERS, de la moins utile à la
 * plus utile, et trois restent toujours là :
 *
 *   toujours   le prospect (nom + adresse e-mail), le statut, les actions
 *   ≥ 768 px   le téléphone
 *   ≥ 1024 px  ce qui est attaché (liens, images) et la dernière activité
 *   ≥ 1280 px  le prochain rendez-vous
 *
 * Rien de ce qui sort n'est PERDU : tout est sur la fiche, à un clic. Le
 * cadre conserve malgré tout son `overflow-x-auto` — c'est le tableau qui
 * défile, jamais la page.
 *
 * ══ LE TRI EST LOCAL, ET C'EST UN CHOIX ═════════════════════════════════════
 *
 * Un carnet de prospection se compte en dizaines. Un aller-retour réseau par
 * clic de colonne aurait rendu le tri poussif, et le rafraîchissement vivant
 * aurait remis la liste dans l'ordre du serveur entre deux clics.
 */
import { useMemo, useState } from 'react';
import type { SortDescriptor } from 'react-aria-components';
import { Link, useNavigate } from 'react-router-dom';
import {
  Image01, Link01, Mail01, Phone, Trash01, Edit01, ArrowRight,
} from '@untitledui/icons';
import { Table, TableCard } from '@/components/application/table/table';
import { Avatar } from '@/components/base/avatar/avatar';
import { Dropdown } from '@/components/base/dropdown/dropdown';
import { ProspectStatusSelect } from '@/components/prospection/ProspectStatusSelect';
import { prospectStatusRank } from '@/components/prospection/prospectStatus';
import type { Meeting } from '@/types.events';
import type { Prospect } from '@/types.prospection';

/** Les initiales servent d'illustration quand aucune image n'a été jointe. */
function initiales(nom: string): string {
  return nom
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((mot) => mot[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

const dateCourte = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });

const dateHeure = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export interface ProspectsTableProps {
  prospects: Prospect[];
  /** Les réunions à venir, tous prospects confondus — indexées ici. */
  upcomingMeetings?: Meeting[];
  onEdit: (prospect: Prospect) => void;
  onDelete: (prospect: Prospect) => void;
  onStatusChanged: () => void;
  title: string;
  description?: string;
  contentTrailing?: React.ReactNode;
}

export function ProspectsTable({
  prospects,
  upcomingMeetings = [],
  onEdit,
  onDelete,
  onStatusChanged,
  title,
  description,
  contentTrailing,
}: ProspectsTableProps) {
  const navigate = useNavigate();
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: 'updatedAt',
    direction: 'descending',
  });

  /**
   * LE PROCHAIN RENDEZ-VOUS, PAR PROSPECT.
   *
   * L'index est construit une fois plutôt qu'à chaque ligne : sans lui, chaque
   * rendu parcourait l'agenda entier autant de fois qu'il y a de prospects.
   * Les réunions arrivent déjà triées par date croissante — la PREMIÈRE
   * rencontrée pour un prospect est donc la prochaine.
   */
  const prochaineReunion = useMemo(() => {
    const index = new Map<string, Meeting>();
    for (const reunion of upcomingMeetings) {
      if (!index.has(reunion.projectId)) index.set(reunion.projectId, reunion);
    }
    return index;
  }, [upcomingMeetings]);

  const triees = useMemo(() => {
    const colonne = String(sortDescriptor.column ?? 'updatedAt');
    const sens = sortDescriptor.direction === 'descending' ? -1 : 1;

    // Une COPIE : `sort` modifie le tableau en place, et celui-ci vient de la
    // lecture vivante. Le trier sur place ferait muter l'état d'un hook.
    return [...prospects].sort((a, b) => {
      if (colonne === 'status') {
        const ecart = prospectStatusRank(a.status) - prospectStatusRank(b.status);
        return ecart !== 0 ? ecart * sens : a.name.localeCompare(b.name, 'fr');
      }
      if (colonne === 'updatedAt' || colonne === 'createdAt') {
        const va = new Date(a[colonne]).getTime();
        const vb = new Date(b[colonne]).getTime();
        return (va - vb) * sens;
      }
      if (colonne === 'phone' || colonne === 'name') {
        return a[colonne].localeCompare(b[colonne], 'fr') * sens;
      }
      return 0;
    });
  }, [prospects, sortDescriptor]);

  return (
    <div className="uui">
      <TableCard.Root>
        <TableCard.Header
          title={title}
          badge={String(prospects.length)}
          description={description}
          contentTrailing={contentTrailing}
        />

        <Table
          aria-label="Prospects"
          selectionMode="none"
          sortDescriptor={sortDescriptor}
          onSortChange={setSortDescriptor}
        >
          {/*
            `px-3 md:px-6` sur chaque colonne : le rembourrage d'origine (24 px
            de chaque côté, trois fois) mangeait 144 px des 390 px d'un
            téléphone. La pastille de statut sortait de l'écran — donc le
            contrôle le plus utilisé de la page devenait inatteignable sans
            défilement horizontal.
          */}
          <Table.Header>
            <Table.Head
              id="name" label="Prospect" isRowHeader allowsSorting
              className="min-w-0 px-3 md:min-w-56 md:px-6"
            />
            <Table.Head id="status" label="Statut" allowsSorting className="px-3 md:px-6" />
            <Table.Head
              id="phone" label="Téléphone" allowsSorting
              className="hidden px-3 md:table-cell md:px-6"
            />
            <Table.Head id="attachments" label="Joint" className="hidden px-3 lg:table-cell lg:px-6" />
            <Table.Head
              id="next" label="Prochain rendez-vous"
              className="hidden px-3 xl:table-cell xl:px-6"
            />
            <Table.Head
              id="updatedAt" label="Activité" allowsSorting
              className="hidden px-3 lg:table-cell lg:px-6"
            />
            <Table.Head id="actions" className="px-2 md:px-4" />
          </Table.Header>

          <Table.Body
            items={triees}
            /*
             * ── `dependencies` N'EST PAS UNE OPTIMISATION, C'EST UNE CORRECTION ──
             *
             * React Aria mémoïse le rendu d'une ligne sur l'IDENTITÉ de son item :
             * tant que `triees` ne change pas, la fonction de rendu n'est pas
             * rejouée, même si le reste du composant a changé.
             *
             * Le défaut observé : l'agenda arrive par une SECONDE requête, après
             * les prospects. Les lignes étaient déjà peintes avec un index de
             * rendez-vous vide, et la colonne « prochain rendez-vous » affichait
             * « Rien de prévu » pour un prospect qui en avait un — visible sur sa
             * fiche, invisible dans le tableau. Aucun message, aucune erreur.
             */
            dependencies={[prochaineReunion]}
            renderEmptyState={() => (
              <div className="px-6 py-10 text-center text-sm text-tertiary">
                Aucun prospect ne correspond à ce filtre.
              </div>
            )}
          >
            {(prospect: Prospect) => {
              const reunion = prochaineReunion.get(prospect._id);
              const illustration = prospect.images[0]?.url ?? null;

              return (
                <Table.Row id={prospect._id}>
                  <Table.Cell className="px-3 md:px-6">
                    <div className="flex items-center gap-3">
                      {/*
                        L'illustration DISPARAÎT sous 640 px. Elle décore, elle
                        n'informe pas : la garder aurait coûté 52 px de largeur
                        au nom, qui lui est la seule chose qu'on cherche.
                      */}
                      <Avatar
                        src={illustration}
                        alt={prospect.name}
                        initials={initiales(prospect.name)}
                        size="md"
                        className="hidden sm:flex"
                      />
                      <div className="min-w-0">
                        {/*
                          Le NOM est le lien vers la fiche. Un bouton « ouvrir »
                          en bout de ligne existe aussi, mais le nom est ce
                          qu'on vise en premier — et un nom non cliquable dans
                          un tableau de fiches se fait cliquer quand même.
                        */}
                        <Link
                          to={`/prospection/${prospect._id}`}
                          className="block truncate text-sm font-medium text-primary hover:underline"
                        >
                          {prospect.name}
                        </Link>
                        {prospect.email ? (
                          <a
                            href={`mailto:${prospect.email}`}
                            className="flex items-center gap-1 truncate text-sm text-tertiary hover:underline"
                          >
                            <Mail01 className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate">{prospect.email}</span>
                          </a>
                        ) : (
                          <span className="text-sm text-quaternary">Pas d’adresse e-mail</span>
                        )}
                      </div>
                    </div>
                  </Table.Cell>

                  <Table.Cell className="px-3 md:px-6">
                    <ProspectStatusSelect
                      prospectId={prospect._id}
                      status={prospect.status}
                      onChanged={onStatusChanged}
                    />
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 md:table-cell md:px-6">
                    {prospect.phone ? (
                      <a
                        href={`tel:${prospect.phone.replace(/\s+/g, '')}`}
                        className="flex items-center gap-1.5 whitespace-nowrap text-sm text-tertiary hover:underline"
                      >
                        <Phone className="size-3.5 shrink-0" aria-hidden="true" />
                        {prospect.phone}
                      </a>
                    ) : (
                      <span className="text-sm text-quaternary">—</span>
                    )}
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 lg:table-cell lg:px-6">
                    <div className="flex items-center gap-3 text-sm text-tertiary">
                      <span
                        className="flex items-center gap-1"
                        title={`${prospect.links.length} lien(s)`}
                      >
                        <Link01 className="size-4 shrink-0" aria-hidden="true" />
                        {prospect.links.length}
                      </span>
                      <span
                        className="flex items-center gap-1"
                        title={`${prospect.images.length} image(s)`}
                      >
                        <Image01 className="size-4 shrink-0" aria-hidden="true" />
                        {prospect.images.length}
                      </span>
                    </div>
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 xl:table-cell xl:px-6">
                    {reunion ? (
                      <div className="whitespace-nowrap">
                        <p className="text-sm font-medium text-primary">
                          {dateHeure(reunion.scheduledAt)}
                        </p>
                        <p className="truncate text-sm text-tertiary">{reunion.title}</p>
                      </div>
                    ) : (
                      <span className="text-sm text-quaternary">Rien de prévu</span>
                    )}
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 whitespace-nowrap lg:table-cell lg:px-6">
                    {dateCourte(prospect.updatedAt)}
                  </Table.Cell>

                  <Table.Cell className="px-2 md:px-4">
                    <div className="flex items-center justify-end">
                      <Dropdown.Root>
                        <Dropdown.DotsButton />
                        <Dropdown.Popover className="w-min">
                          <Dropdown.Menu>
                            {/*
                              `onAction` + `navigate`, et non `href` : un lien
                              natif dans ce menu aurait rechargé l'application
                              entière au lieu de changer de route — session
                              relue, agenda rechargé, deux secondes d'écran
                              blanc pour aller d'une fiche à l'autre.
                            */}
                            <Dropdown.Item
                              icon={ArrowRight}
                              onAction={() => navigate(`/prospection/${prospect._id}`)}
                              textValue="Ouvrir la fiche"
                            >
                              <span className="pr-4">Ouvrir la fiche</span>
                            </Dropdown.Item>
                            <Dropdown.Item
                              icon={Edit01}
                              onAction={() => onEdit(prospect)}
                              textValue="Modifier"
                            >
                              <span className="pr-4">Modifier</span>
                            </Dropdown.Item>
                            <Dropdown.Item
                              icon={Trash01}
                              onAction={() => onDelete(prospect)}
                              textValue="Supprimer"
                            >
                              <span className="pr-4">Supprimer</span>
                            </Dropdown.Item>
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
