/**
 * LE PARC, EN TABLEAU — pour décider vite sur quelle fiche ouvrir.
 *
 * ══ POURQUOI UN TABLEAU PLUTÔT QUE DES CARTES ═══════════════════════════════
 *
 * La liste était une grille de cartes. Une carte est excellente pour PRÉSENTER
 * un objet ; elle est mauvaise pour en COMPARER trente. Chaque carte reprenait
 * son propre gabarit — logo, nom, accroche, pastilles, adresse — et rien ne
 * s'alignait d'une carte à l'autre : pour trouver quel site est hors ligne, il
 * fallait lire les trente accroches.
 *
 * En colonnes, l'état se lit verticalement, en un balayage. C'est exactement ce
 * qu'on vient chercher sur une page de pilotage.
 *
 * Ce qui a été GARDÉ des cartes : la retenue. La liste ne montre que ce qui
 * aide à choisir — identité, client, état du site, contrat, adresse, dernière
 * activité. Le reste est sur la fiche, où il est lisible.
 *
 * ══ D'OÙ VIENNENT LES COLONNES ══════════════════════════════════════════════
 *
 * Toutes de `PublicProject`, via les lecteurs de `projectPresentation` — le
 * même vocabulaire que la fiche. Aucune n'est calculée ici : l'état d'une
 * vitrine est celui que le PROJET a projeté, pas une déduction de l'écran.
 *
 * ══ RESPONSIVE — LES PALIERS SUIVENT LE CONTENU, PAS LA FENÊTRE ═════════════
 *
 * La barre latérale reprend 250 px dès 900 px : il y a MOINS de place à 900 px
 * qu'à 768 px, où elle est encore un tiroir. Les colonnes sortent donc à `sm`,
 * `xl` et `2xl`, jamais à `md`.
 *
 *   toujours   le projet (logo, nom, client), l'état, les actions
 *   ≥ 640 px   l'état du contrat
 *   ≥ 1280 px  l'adresse du site
 *   ≥ 1536 px  la dernière activité
 */
import { useMemo, useState } from 'react';
import type { SortDescriptor } from 'react-aria-components';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, LinkExternal01, Settings01 } from '@untitledui/icons';
import { Table, TableCard } from '@/components/application/table/table';
import { Avatar } from '@/components/base/avatar/avatar';
import { BadgeWithDot } from '@/components/base/badges/badges';
import { Dropdown } from '@/components/base/dropdown/dropdown';
import { EmptyPanel } from '@/components/ui-kit';
import { sansProtocole } from '@/components/Links';
import {
  contractState,
  isBusinessSynchronized,
  projectDescription,
  projectDisplayName,
  projectDomain,
  projectInitials,
  projectLogoUrl,
  projectSiteUrl,
  vitrineState,
} from '@/lib/projectPresentation';
import type { PublicProject } from '@/types';

/**
 * LA TONALITÉ MAISON, TRADUITE EN COULEUR DE LA LIBRAIRIE.
 *
 * `projectPresentation` rend une INTENTION (`ok`, `warn`, `error`, `neutral`),
 * pas une teinte — c'est ce qui permet au même verdict d'être peint de la même
 * façon sur la liste, la fiche et l'agenda. Cette table est le seul point de
 * traduction ; ce que les couleurs VALENT est décidé dans `styles/bridge.css`,
 * à partir du thème réglable.
 */
type Tone = 'ok' | 'warn' | 'error' | 'neutral' | 'muted' | 'danger';

const COULEUR: Record<string, 'success' | 'warning' | 'error' | 'gray'> = {
  ok: 'success',
  warn: 'warning',
  error: 'error',
  danger: 'error',
  neutral: 'gray',
  muted: 'gray',
};

const toBadgeColor = (tone: Tone) => COULEUR[tone] ?? 'gray';

const DATE_COURTE = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: 'short', year: '2-digit',
});

/**
 * LA DERNIÈRE FOIS QUE LE PROJET A DONNÉ SIGNE DE VIE.
 *
 * ── C'EST LE BATTEMENT DE CŒUR, PAS `updatedAt` ─────────────────────────────
 * `updatedAt` est la date du dernier ÉCRIT dans le registre du Panel : elle
 * bouge quand quelqu'un renomme la fiche, et pas quand le site tombe. La seule
 * mesure qui réponde à « a-t-on eu de ses nouvelles ? » est
 * `runtime.lastHeartbeatAt` — c'est aussi celle que lit `projectFreshness`.
 *
 * `null` est une valeur NORMALE : une fiche déclarée mais jamais appairée n'a
 * jamais battu. L'écran écrit « Jamais vu » plutôt qu'une date empruntée
 * ailleurs.
 */
function derniereActivite(project: PublicProject): Date | null {
  const brut = project.runtime?.lastHeartbeatAt ?? null;
  if (!brut) return null;
  const date = new Date(brut);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ProjectsTableProps {
  projects: PublicProject[];
  /** Le nom de l'entreprise cliente, par identifiant de projet. */
  clientNames?: Map<string, string>;
  title: string;
  description?: string;
  contentTrailing?: React.ReactNode;
  emptyTitle: string;
  emptyHint?: string;
  emptyAction?: React.ReactNode;
}

export function ProjectsTable({
  projects,
  clientNames,
  title,
  description,
  contentTrailing,
  emptyTitle,
  emptyHint,
  emptyAction,
}: ProjectsTableProps) {
  const navigate = useNavigate();
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: 'name',
    direction: 'ascending',
  });

  const triees = useMemo(() => {
    const colonne = String(sortDescriptor.column ?? 'name');
    const sens = sortDescriptor.direction === 'descending' ? -1 : 1;

    // Une COPIE : `sort` modifie en place, et la liste vient d'une lecture
    // vivante. La trier sur place ferait muter l'état d'un hook.
    return [...projects].sort((a, b) => {
      if (colonne === 'site') {
        const ecart = vitrineState(a).label.localeCompare(vitrineState(b).label, 'fr');
        return ecart !== 0
          ? ecart * sens
          : projectDisplayName(a).localeCompare(projectDisplayName(b), 'fr');
      }
      if (colonne === 'activity') {
        const va = derniereActivite(a)?.getTime() ?? 0;
        const vb = derniereActivite(b)?.getTime() ?? 0;
        return (va - vb) * sens;
      }
      return projectDisplayName(a).localeCompare(projectDisplayName(b), 'fr') * sens;
    });
  }, [projects, sortDescriptor]);

  if (projects.length === 0) {
    return (
      <div className="uui">
        <TableCard.Root>
          <TableCard.Header
            title={title}
            description={description}
            contentTrailing={contentTrailing}
            className="md:flex-col lg:flex-row lg:items-center"
          />
          <EmptyPanel title={emptyTitle} hint={emptyHint} action={emptyAction} />
        </TableCard.Root>
      </div>
    );
  }

  return (
    <div className="uui">
      <TableCard.Root>
        <TableCard.Header
          title={title}
          badge={String(projects.length)}
          description={description}
          contentTrailing={contentTrailing}
          className="md:flex-col lg:flex-row lg:items-center"
        />

        <Table
          aria-label="Projets clients"
          selectionMode="none"
          sortDescriptor={sortDescriptor}
          onSortChange={setSortDescriptor}
        >
          <Table.Header>
            <Table.Head
              id="name" label="Projet" isRowHeader allowsSorting
              className="min-w-0 px-3 md:px-6 lg:min-w-64"
            />
            <Table.Head id="site" label="Site" allowsSorting className="px-3 md:px-6" />
            <Table.Head
              id="contract" label="Contrat"
              className="hidden px-3 sm:table-cell sm:px-6"
            />
            <Table.Head
              id="url" label="Adresse"
              className="hidden px-3 xl:table-cell xl:px-6"
            />
            <Table.Head
              id="activity" label="Activité" allowsSorting
              className="hidden px-3 2xl:table-cell 2xl:px-6"
            />
            <Table.Head id="actions" className="px-2 md:px-4" />
          </Table.Header>

          <Table.Body items={triees} dependencies={[clientNames]}>
            {(project: PublicProject) => {
              const nom = projectDisplayName(project);
              const site = vitrineState(project);
              const contract = project.business?.contract ?? null;
              const url = projectSiteUrl(project);
              const domain = projectDomain(project);
              const activite = derniereActivite(project);
              const client = clientNames?.get(project.projectId) ?? null;
              const accroche = projectDescription(project);

              return (
                <Table.Row id={project.projectId}>
                  <Table.Cell className="px-3 md:px-6">
                    <div className="flex items-center gap-3">
                      {/* Le logo vient du projet ; à défaut les initiales —
                          jamais une image manquante. */}
                      <Avatar
                        src={projectLogoUrl(project)}
                        alt={nom}
                        initials={projectInitials(project)}
                        size="md"
                        className="hidden sm:flex"
                      />
                      <div className="min-w-0">
                        <Link
                          to={`/projects/${project.projectId}`}
                          className="block truncate text-sm font-medium text-primary hover:underline"
                        >
                          {nom}
                        </Link>
                        {/*
                          LE CLIENT D'ABORD, L'ACCROCHE ENSUITE.
                          Savoir À QUI appartient le site prime sur ce que le
                          site raconte de lui-même. L'accroche ne s'affiche donc
                          que faute de client rattaché.
                        */}
                        {client ? (
                          <span className="block truncate text-sm text-tertiary" title={client}>
                            {client}
                          </span>
                        ) : accroche ? (
                          <span className="block truncate text-sm text-quaternary" title={accroche}>
                            {accroche}
                          </span>
                        ) : (
                          <span className="block text-sm text-quaternary">
                            Aucune entreprise rattachée
                          </span>
                        )}
                      </div>
                    </div>
                  </Table.Cell>

                  <Table.Cell className="px-3 md:px-6">
                    <div className="flex flex-col items-start gap-1">
                      <BadgeWithDot size="sm" color={toBadgeColor(site.tone as Tone)}>
                        {site.label}
                      </BadgeWithDot>
                      {/*
                        Un projet relié qui n'a jamais rien poussé affiche son
                        manifeste : on le DIT, sinon une panne de synchronisation
                        ressemble à une donnée à jour.
                      */}
                      {project.pairing.status === 'PAIRED' && !isBusinessSynchronized(project) ? (
                        <span className="text-xs text-utility-orange-700">
                          Identité non synchronisée
                        </span>
                      ) : null}
                    </div>
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 sm:table-cell sm:px-6">
                    {/*
                      Sans contrat EN COURS, aucune pastille : afficher l'état
                      d'un contrat terminé laisserait croire à un engagement
                      encore en vigueur.
                    */}
                    {contract?.status && contract.hasCurrent !== false ? (
                      <BadgeWithDot
                        size="sm"
                        color={toBadgeColor(contractState(contract.status).tone as Tone)}
                      >
                        {contractState(contract.status).label}
                      </BadgeWithDot>
                    ) : (
                      <span className="text-sm text-quaternary">—</span>
                    )}
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 xl:table-cell xl:px-6">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={url}
                        className="flex max-w-56 items-center gap-1.5 text-sm text-tertiary hover:underline"
                      >
                        <span className="truncate">{sansProtocole(url)}</span>
                        <LinkExternal01 className="size-3.5 shrink-0" aria-hidden="true" />
                      </a>
                    ) : domain ? (
                      <span className="text-sm text-quaternary">{domain}</span>
                    ) : (
                      <span className="text-sm text-quaternary">—</span>
                    )}
                  </Table.Cell>

                  <Table.Cell className="hidden px-3 whitespace-nowrap 2xl:table-cell 2xl:px-6">
                    {activite ? DATE_COURTE.format(activite) : (
                      <span className="text-quaternary">Jamais vu</span>
                    )}
                  </Table.Cell>

                  <Table.Cell className="px-2 md:px-4">
                    <div className="flex items-center justify-end">
                      <Dropdown.Root>
                        <Dropdown.DotsButton />
                        <Dropdown.Popover className="w-min">
                          <Dropdown.Menu>
                            {/*
                              `onAction` + `navigate`, et non `href` : un lien
                              natif rechargerait l'application entière au lieu
                              de changer de route.
                            */}
                            <Dropdown.Item
                              icon={ArrowRight}
                              onAction={() => navigate(`/projects/${project.projectId}`)}
                              textValue="Ouvrir la fiche"
                            >
                              <span className="pr-4">Ouvrir la fiche</span>
                            </Dropdown.Item>
                            <Dropdown.Item
                              icon={Settings01}
                              onAction={() => navigate(`/projects/${project.projectId}?tab=finances`)}
                              textValue="Voir les finances"
                            >
                              <span className="pr-4">Voir les finances</span>
                            </Dropdown.Item>
                            {url ? (
                              <Dropdown.Item
                                icon={LinkExternal01}
                                onAction={() => window.open(url, '_blank', 'noopener,noreferrer')}
                                textValue="Ouvrir le site"
                              >
                                <span className="pr-4">Ouvrir le site</span>
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

export default ProjectsTable;
