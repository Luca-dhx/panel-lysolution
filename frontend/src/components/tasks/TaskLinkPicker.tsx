/**
 * RATTACHER UNE TÂCHE À CE QU'ELLE CONCERNE.
 *
 * ══ QUATRE FAMILLES, UN SEUL GESTE ══════════════════════════════════════════
 *
 * Projets, prospects, entreprises clientes, mouvements. Chacune est une liste :
 * « préparer la reprise du site » touche un projet ET l'entreprise qui le paie,
 * et forcer à choisir aurait obligé à créer deux tâches identiques.
 *
 * ══ POURQUOI UNE RECHERCHE PLUTÔT QU'UNE LISTE DÉROULANTE ══════════════════
 *
 * Le parc compte des dizaines de projets et des centaines de mouvements. Une
 * liste déroulante de cent cinquante entrées se parcourt à la molette ; un
 * champ qui filtre se parcourt en trois lettres. Les entrées déjà choisies
 * sortent des propositions — les reproposer inviterait à un doublon que le
 * serveur écarterait en silence.
 *
 * ══ CE QUI EST DÉJÀ CHOISI RESTE VISIBLE ═══════════════════════════════════
 *
 * Sous forme de puces retirables, au-dessus du champ. Un compteur seul
 * (« 3 projets ») obligerait à ouvrir pour savoir lesquels.
 */
import { useMemo, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Icon } from '@/components/Icon';
import { TASK_LINK_KINDS, TASK_LINK_LABELS } from '@/types.tasks';
import type { TaskLinkKind, TaskLinks } from '@/types.tasks';
import type { TaskTargetResolver } from '@/lib/useTaskTargets';

/** Au-delà, la liste des propositions se lit moins bien qu'elle ne se filtre. */
const PROPOSITIONS_MAX = 6;

function Famille({
  kind, ids, options, resolve, onAdd, onRemove,
}: {
  kind: TaskLinkKind;
  ids: string[];
  options: { id: string; label: string; hint?: string }[];
  resolve: TaskTargetResolver['resolve'];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [recherche, setRecherche] = useState('');

  const propositions = useMemo(() => {
    const terme = recherche.trim().toLowerCase();
    return options
      .filter((o) => !ids.includes(o.id))
      .filter((o) => !terme
        || o.label.toLowerCase().includes(terme)
        || (o.hint ?? '').toLowerCase().includes(terme))
      .slice(0, PROPOSITIONS_MAX);
  }, [options, ids, recherche]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold tracking-wide text-tertiary uppercase">
        {TASK_LINK_LABELS[kind].pluriel}
      </span>

      {ids.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {ids.map((id) => {
            const cible = resolve(kind, id);
            return (
              <li key={id}>
                <span className="inline-flex items-center gap-1 rounded-md border border-secondary bg-secondary px-2 py-1 text-xs text-secondary">
                  {cible.label}
                  <button
                    type="button"
                    onClick={() => onRemove(id)}
                    aria-label={`Retirer ${cible.label}`}
                    className="rounded-sm text-tertiary hover:text-primary"
                  >
                    <Icon name="x-lg" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Input
        size="sm"
        aria-label={`Rechercher parmi les ${TASK_LINK_LABELS[kind].pluriel.toLowerCase()}`}
        placeholder={`Rechercher — ${TASK_LINK_LABELS[kind].pluriel.toLowerCase()}`}
        value={recherche}
        onChange={setRecherche}
      />

      {recherche.trim() && propositions.length === 0 ? (
        <p className="text-xs text-tertiary">Aucun résultat.</p>
      ) : null}

      {propositions.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {propositions.map((o) => (
            <li key={o.id}>
              <Button
                size="sm"
                color="link-gray"
                onClick={() => { onAdd(o.id); setRecherche(''); }}
              >
                + {o.label}
                {o.hint ? <span className="ml-1 text-tertiary">· {o.hint}</span> : null}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TaskLinkPicker({
  value, onChange, cibles,
}: {
  value: TaskLinks;
  onChange: (liens: TaskLinks) => void;
  cibles: TaskTargetResolver;
}) {
  const [ouvert, setOuvert] = useState(false);
  const total = TASK_LINK_KINDS.reduce((n, k) => n + (value[k]?.length ?? 0), 0);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-secondary p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-secondary">
          Rattachements
          {total > 0 ? <span className="ml-1 text-tertiary">({total})</span> : null}
        </span>
        <Button size="sm" color="link-gray" onClick={() => setOuvert((v) => !v)} aria-expanded={ouvert}>
          {ouvert ? 'Réduire' : 'Rattacher'}
        </Button>
      </div>

      {/*
        REPLIÉ PAR DÉFAUT, MAIS OUVERT S'IL Y A DÉJÀ QUELQUE CHOSE.
        Le rattachement est du classement, pas de la décision : il ne doit pas
        occuper l'écran de celui qui note une tâche en trois secondes. Mais
        cacher un rattachement DÉJÀ posé le ferait oublier au moment de modifier.
      */}
      {ouvert || total > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {TASK_LINK_KINDS.map((kind) => (
            <Famille
              key={kind}
              kind={kind}
              ids={value[kind] ?? []}
              options={cibles.options(kind)}
              resolve={cibles.resolve}
              onAdd={(id) => onChange({ ...value, [kind]: [...(value[kind] ?? []), id] })}
              onRemove={(id) => onChange({ ...value, [kind]: (value[kind] ?? []).filter((x) => x !== id) })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default TaskLinkPicker;
