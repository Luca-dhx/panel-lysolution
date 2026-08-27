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
 * Un tableau à huit colonnes sur un écran de 390 px n'a que deux issues : une
 * barre de défilement horizontale qu'on ne trouve pas, ou des colonnes écrasées
 * illisibles. Les colonnes sortent donc PAR PALIERS, de la moins utile à la
 * plus utile, et trois restent toujours là :
 *
 *   toujours    le prospect (nom + adresse e-mail), le statut, les actions
 *   ≥ 640 px    la nature de l'affaire (conception / refonte)
 *   ≥ 1280 px   le prochain rendez-vous et la dernière activité
 *   ≥ 1536 px   le téléphone et ce qui est attaché (liens, images)
 *
 * ── LES PALIERS SONT CALÉS SUR LA LARGEUR DU CONTENU, PAS DE LA FENÊTRE ─────
 *
 * La barre latérale reprend 250 px dès 900 px de fenêtre. Il y a donc MOINS de
 * place à 900 px (≈ 570 px utiles) qu'à 768 px (≈ 736 px, la barre étant encore
 * un tiroir). Un palier posé à `md` — le réflexe — faisait donc déborder le
 * tableau juste après le seuil du tiroir, sur la seule largeur où personne ne
 * pense à regarder. La largeur minimale du nom suit la même règle : elle
 * n'entre qu'à 1024 px.
 *
 * Rien de ce qui sort n'est PERDU : tout est sur la fiche, à un clic. Le type,
 * lui, ne sort même pas — sous 640 px sa pastille se replie sous le nom, parce
 * qu'une refonte et une conception ne se devinent pas et qu'on balaie cette
 * liste pour les distinguer. Le cadre conserve malgré tout son
 * `overflow-x-auto` : c'est le tableau qui défile, jamais la page.
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
import {
  ProspectTypeBadge, ProspectTypeSelect,
} from '@/components/prospection/ProspectTypeSelect';
import { prospectStatusRank, prospectTypeRank } from '@/components/prospection/prospectStatus';
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
      if (colonne === 'type') {
        const ecart = prospectTypeRank(a.type) - prospectTypeRank(b.type);
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
        {/*
          L'en-tête de la librairie passe en ligne dès 768 px. À cette largeur,
          la recherche prend sa place et le titre se retrouve écrasé sur trois
          lignes dans une colonne de 100 px. Il ne se met donc en ligne qu'à
          1024 px — même raison que les colonnes : la barre latérale reprend
          250 px dès 900 px, et il n'y a pas la place avant.
        */}
        <TableCard.Header
          title={title}
          badge={String(prospects.length)}
          description={description}
          contentTrailing={contentTrailing}
          className="md:flex-col lg:flex-row lg:items-center"
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
              className="min-w-0 px-3 md:px-6 lg:min-w-56"
            />
            <Table.Head id="status" label="Statut" allowsSorting className="px-3 md:px-6" />
            {/*
              LE TYPE SORT AVANT LE TÉLÉPHONE, à 640 px et non 768 : savoir si
              une affaire est une refonte ou une conception change le devis et
              les questions du premier rendez-vous. Un numéro se retrouve sur la
              fiche ; la nature de l'affaire se lit en balayant la liste.

              Sous 640 px il n'y a plus de colonne : la pastille passe alors
              sous le nom, dans la première cellule.
            */}
            <Table.Head
              id="type" label="Type" allowsSorting
              className="hidden px-3 sm:table-cell sm:px-6"
            />
            <Table.Head
              id="next" label="Rendez-vous"
              className="hidden px-3 xl:table-cell xl:px-6"
            />
            <Table.Head
              id="updatedAt" label="Activité" allowsSorting
              className="hidden px-3 xl:table-cell xl:px-6"
            />
            <Table.Head
              id="phone" label="Téléphone" allowsSorting
              className="hidden px-3 2xl:table-cell 2xl:px-6"
            />
            <Table.Head
              id="attachments" label="Joint"
              className="hidden px-3 2xl:table-cell 2xl:px-6"
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
                        {/*
                          Sous 640 px, la colonne « Type » n'existe plus : la
                          pastille se replie ici plutôt que de disparaître. Elle
                          est en LECTURE SEULE à cette largeur — le sélecteur
                          aurait ajouté un troisième contrôle sur une ligne qui
                          en porte déjà deux, à portée du pouce.
                        */}
                        <span className="mt-1 flex sm:hidden">
                          <ProspectTypeBadge type={prospect.type} />
                        </span>
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

                  <Table.Cell className="hidden px-3 sm:table-cell sm:px-6">
                    <ProspectTypeSelect
                      prospectId={prospect._id}
                      type={prospect.type}
                      onChanged={onStatusChanged}
                    />
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

                  <Table.Cell className="hidden px-3 whitespace-nowrap xl:table-cell xl:px-6">
                    {dateCourte(prospect.updatedAt)}
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 2xl:table-cell 2xl:px-6">
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

                  <Table.Cell className="hidden px-3 2xl:table-cell 2xl:px-6">
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
