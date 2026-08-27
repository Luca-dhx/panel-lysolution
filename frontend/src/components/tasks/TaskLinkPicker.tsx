/**
 * RATTACHER UNE TÂCHE À CE QU'ELLE CONCERNE.
 *
 * ══ UN TABLEAU DE CATÉGORIES, PUIS UN SÉLECTEUR ═════════════════════════════
 *
 * Quatre familles — projets, prospects, entreprises clientes, mouvements — et
 * chacune est une LIGNE : ce qu'elle contient déjà, combien il y en a, et un
 * chemin pour en choisir d'autres. Cliquer ouvre un sélecteur à cases à cocher
 * sur les éléments de CETTE famille, et de celle-là seulement.
 *
 * ── POURQUOI PAS LES QUATRE CHAMPS DÉPLIÉS EN MÊME TEMPS ───────────────────
 *
 * La version précédente les montrait tous à la fois : quatre champs de
 * recherche, quatre listes de propositions, dans un formulaire qui porte déjà
 * un nom, une échéance, une description et des sous-tâches. Le rattachement est
 * du CLASSEMENT, pas de la décision — il ne doit pas occuper la moitié de
 * l'écran de celui qui note une tâche en trois secondes.
 *
 * Le tableau tient en quatre lignes, dit tout ce qui est déjà rattaché, et
 * n'ouvre qu'à la demande.
 *
 * ── POURQUOI DES CASES À COCHER PLUTÔT QU'UNE LISTE CLIQUABLE ──────────────
 *
 * Parce qu'on en choisit PLUSIEURS. Une liste où chaque clic ajoute une entrée
 * ne montre pas l'état : pour savoir si un projet est déjà pris, il faut
 * remonter voir les puces. Une case cochée porte son état sur elle, et la
 * décocher est le même geste que la cocher.
 */
import { useMemo, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Input } from '@/components/base/input/input';
import { Icon } from '@/components/Icon';
import { TASK_LINK_KINDS, TASK_LINK_LABELS } from '@/types.tasks';
import type { TaskLinkKind, TaskLinks } from '@/types.tasks';
import type { TaskTargetResolver } from '@/lib/useTaskTargets';

/** L'icône qui dit de quelle famille il s'agit, avant même de lire. */
const ICONES: Record<TaskLinkKind, 'stack' | 'person' | 'building' | 'credit-card'> = {
  projectIds: 'stack',
  prospectIds: 'person',
  clientCompanyIds: 'building',
  transactionIds: 'credit-card',
};

/**
 * LE SÉLECTEUR D'UNE FAMILLE.
 *
 * ── LA RECHERCHE N'APPARAÎT QU'AU-DELÀ D'UNE DIZAINE ───────────────────────
 *
 * Sur huit projets, un champ de recherche est un obstacle de plus entre le clic
 * et le choix. Sur deux cents mouvements, c'est le seul chemin praticable.
 *
 * ── CE QUI EST COCHÉ REMONTE EN TÊTE ───────────────────────────────────────
 *
 * Sinon, sur deux cents lignes, on ne retrouve pas ce qu'on vient de choisir —
 * et on le coche une seconde fois, sans effet visible.
 */
function SelecteurFamille({
  kind, ids, options, onValider, onFermer,
}: {
  kind: TaskLinkKind;
  ids: string[];
  options: { id: string; label: string; hint?: string }[];
  onValider: (ids: string[]) => void;
  onFermer: () => void;
}) {
  const [choisis, setChoisis] = useState<string[]>(ids);
  const [recherche, setRecherche] = useState('');

  const avecRecherche = options.length > 10;

  const listes = useMemo(() => {
    const terme = recherche.trim().toLowerCase();
    const filtre = (o: { label: string; hint?: string }) => !terme
      || o.label.toLowerCase().includes(terme)
      || (o.hint ?? '').toLowerCase().includes(terme);

    const coches = options.filter((o) => choisis.includes(o.id));
    const autres = options.filter((o) => !choisis.includes(o.id)).filter(filtre);
    return { coches, autres };
  }, [options, choisis, recherche]);

  const basculer = (id: string, coche: boolean) => {
    setChoisis((actuels) => (coche
      ? [...actuels, id]
      : actuels.filter((x) => x !== id)));
  };

  const ligne = (o: { id: string; label: string; hint?: string }) => (
    <li key={o.id} className="border-b border-secondary last:border-0">
      <Checkbox
        isSelected={choisis.includes(o.id)}
        onChange={(v) => basculer(o.id, v)}
        className="w-full px-3 py-2.5 hover:bg-secondary"
        label={(
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-primary">{o.label}</span>
            {o.hint ? <span className="truncate text-xs text-tertiary">{o.hint}</span> : null}
          </span>
        )}
      />
    </li>
  );

  return (
    <ModalOverlay isOpen onOpenChange={(v) => { if (!v) onFermer(); }} isDismissable>
      <Modal className="w-full max-w-lg">
        <Dialog>
          <div className="uui flex max-h-[80vh] flex-col p-5 sm:p-6">
            <header className="shrink-0">
              <h3 className="text-lg font-semibold text-primary">
                {TASK_LINK_LABELS[kind].pluriel}
              </h3>
              <p className="mt-1 text-sm text-tertiary">
                Cochez ce que cette tâche concerne. On peut en choisir plusieurs.
              </p>
            </header>

            {avecRecherche ? (
              <div className="mt-4 shrink-0">
                <Input
                  size="sm"
                  icon={() => <Icon name="search" />}
                  aria-label={`Rechercher parmi les ${TASK_LINK_LABELS[kind].pluriel.toLowerCase()}`}
                  placeholder="Rechercher…"
                  value={recherche}
                  onChange={setRecherche}
                />
              </div>
            ) : null}

            {/* La liste défile DANS le dialogue : deux cents lignes ne doivent
                pas faire défiler la page qui est derrière. */}
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-secondary">
              {options.length === 0 ? (
                <p className="p-4 text-sm text-tertiary">
                  Aucun élément de cette famille dans le Panel.
                </p>
              ) : (
                <ul>
                  {listes.coches.map(ligne)}
                  {listes.coches.length > 0 && listes.autres.length > 0 ? (
                    <li className="border-b border-secondary bg-secondary px-3 py-1 text-xs text-tertiary">
                      Non rattachés
                    </li>
                  ) : null}
                  {listes.autres.map(ligne)}
                  {listes.autres.length === 0 && recherche.trim() ? (
                    <li className="p-4 text-sm text-tertiary">Aucun résultat.</li>
                  ) : null}
                </ul>
              )}
            </div>

            <footer className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-secondary pt-4">
              <span className="text-sm text-tertiary">
                {choisis.length} sélectionné{choisis.length > 1 ? 's' : ''}
              </span>
              <div className="flex gap-2">
                <Button color="secondary" onClick={onFermer}>Annuler</Button>
                <Button color="primary" onClick={() => onValider(choisis)}>Valider</Button>
              </div>
            </footer>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function TaskLinkPicker({
  value, onChange, cibles,
}: {
  value: TaskLinks;
  onChange: (liens: TaskLinks) => void;
  cibles: TaskTargetResolver;
}) {
  const [ouverte, setOuverte] = useState<TaskLinkKind | null>(null);
  const total = TASK_LINK_KINDS.reduce((n, k) => n + (value[k]?.length ?? 0), 0);

  return (
    <section className="uui flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-secondary">
          Rattachements
          {total > 0 ? <span className="ml-1 text-tertiary">({total})</span> : null}
        </span>
      </div>

      {/*
        UN TABLEAU, ET IL DÉFILE DANS SON CADRE.
        Trois colonnes ne tiennent pas sous 360 px sans écraser les noms : le
        conteneur défile plutôt que la page.
      */}
      <div className="overflow-x-auto rounded-lg border border-secondary">
        <table className="w-full min-w-[420px] border-collapse text-left">
          <thead>
            <tr className="border-b border-secondary bg-secondary">
              <th scope="col" className="px-3 py-2 text-xs font-semibold tracking-wide text-tertiary uppercase">
                Catégorie
              </th>
              <th scope="col" className="px-3 py-2 text-xs font-semibold tracking-wide text-tertiary uppercase">
                Rattaché
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-semibold tracking-wide text-tertiary uppercase">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {TASK_LINK_KINDS.map((kind) => {
              const ids = value[kind] ?? [];
              return (
                <tr key={kind} className="border-b border-secondary last:border-0">
                  <th scope="row" className="px-3 py-2.5 align-top">
                    <span className="flex items-center gap-2 text-sm font-medium text-primary">
                      <Icon name={ICONES[kind]} className="text-tertiary" />
                      {TASK_LINK_LABELS[kind].pluriel}
                    </span>
                  </th>
                  <td className="px-3 py-2.5 align-top">
                    {ids.length === 0 ? (
                      <span className="text-sm text-quaternary">—</span>
                    ) : (
                      /*
                        LES NOMS, PAS UN COMPTE.
                        « 3 projets » obligerait à ouvrir le sélecteur pour
                        savoir lesquels — c'est-à-dire à faire le geste qu'on
                        essaie d'éviter.
                      */
                      <ul className="flex flex-wrap gap-1.5">
                        {ids.map((id) => {
                          const cible = cibles.resolve(kind, id);
                          return (
                            <li
                              key={id}
                              className="inline-flex items-center gap-1 rounded-md border border-secondary px-2 py-0.5 text-xs text-secondary"
                            >
                              {cible.label}
                              <button
                                type="button"
                                onClick={() => onChange({
                                  ...value,
                                  [kind]: ids.filter((x) => x !== id),
                                })}
                                aria-label={`Retirer ${cible.label}`}
                                className="rounded-sm text-tertiary hover:text-primary"
                              >
                                <Icon name="x-lg" size={12} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right align-top">
                    <Button
                      size="sm"
                      color="secondary"
                      onClick={() => setOuverte(kind)}
                      aria-label={`Choisir parmi les ${TASK_LINK_LABELS[kind].pluriel.toLowerCase()}`}
                    >
                      Choisir
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {ouverte ? (
        <SelecteurFamille
          kind={ouverte}
          ids={value[ouverte] ?? []}
          options={cibles.options(ouverte)}
          onFermer={() => setOuverte(null)}
          onValider={(ids) => {
            onChange({ ...value, [ouverte]: ids });
            setOuverte(null);
          }}
        />
      ) : null}
    </section>
  );
}

export default TaskLinkPicker;
