/**
 * LES TO-DO LISTS — par jour, en liste ou en calendrier.
 *
 * ══ DEUX VUES PARCE QU'IL Y A DEUX QUESTIONS ════════════════════════════════
 *
 *   la LISTE       « qu'est-ce que j'ai aujourd'hui, puis demain ? » — les
 *                  listes groupées par jour, du plus proche au plus lointain ;
 *   le CALENDRIER  « comment se remplit le mois ? » — et, en touchant un jour,
 *                  ses listes à cocher juste à côté (dessous sur téléphone).
 *
 * La vue et le jour choisis vivent dans l'ADRESSE (`?vue=…&jour=…`) : l'écran
 * d'édition y renvoie après l'enregistrement, et l'on retrouve exactement ce
 * qu'on regardait. La vue est aussi retenue pour la session.
 *
 * ══ L'AVANCEMENT EST CALCULÉ À CHAQUE RENDU ═════════════════════════════════
 *
 * Cocher met à jour l'état local AVANT la réponse du serveur (voir
 * `useTodoLists`) : les barres de la carte, du jour et des compteurs avancent
 * au clic, en même temps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarPlus01, Plus } from '@untitledui/icons';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Button } from '@/components/base/buttons/button';
import { Toggle } from '@/components/base/toggle/toggle';
import { SearchField } from '@/components/SearchField';
import { useToast } from '@/components/ToastProvider';
import { TodoCalendar } from '@/components/todo/TodoCalendar';
import { TodoListCard } from '@/components/todo/TodoListCard';
import { TodoProgress } from '@/components/todo/TodoProgress';
import { EmptyPanel, PageHeader, Panel, SkeletonRows, SmoothTabs } from '@/components/ui-kit';
import {
  avancement, clefJour, dateCivile, decalerJour, jourDepuisClef, jourRelatif, libelleJour, useTodoLists,
} from '@/lib/todoLists';
import { cx } from '@/utils/cx';
import type { TodoList } from '@/types.todoLists';

type Vue = 'liste' | 'calendrier';
type Periode = 'avenir' | 'passees' | 'toutes';
const CLEF_VUE = 'panel.todo.vue';

const ENTREE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97 },
  transition: { duration: 0.2, ease: 'easeOut' as const },
};

/** Le jour change à minuit : sans cela « Aujourd'hui » resterait celui d'hier. */
function useAujourdHui(): string {
  const [jour, setJour] = useState(() => clefJour(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setJour(clefJour(new Date())), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return jour;
}

export default function TodoListsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const aujourdHui = useAujourdHui();
  const [params, setParams] = useSearchParams();
  const { listes, chargement, erreur, cocher, supprimer } = useTodoLists();

  const vue: Vue = (params.get('vue') as Vue) || (() => {
    try { return (sessionStorage.getItem(CLEF_VUE) as Vue) || 'liste'; } catch { return 'liste'; }
  })();
  const selection = params.get('jour') || aujourdHui;

  const majParams = useCallback((patch: Record<string, string>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) n.set(k, v);
      return n;
    }, { replace: true });
  }, [setParams]);

  const changerVue = (v: Vue) => {
    try { sessionStorage.setItem(CLEF_VUE, v); } catch { /* sans conséquence */ }
    majParams({ vue: v });
  };

  const [mois, setMois] = useState(() => {
    const d = jourDepuisClef(selection);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [periode, setPeriode] = useState<Periode>('avenir');
  const [recherche, setRecherche] = useState('');
  const [masquerTerminees, setMasquerTerminees] = useState(false);
  const [aSupprimer, setASupprimer] = useState<TodoList | null>(null);
  const [suppressionEnCours, setSuppressionEnCours] = useState(false);
  const panneauJour = useRef<HTMLDivElement>(null);

  const filtrees = useMemo(() => {
    const q = recherche.trim().toLocaleLowerCase('fr');
    return listes.filter((l) => {
      if (masquerTerminees && avancement(l.items).complete) return false;
      if (!q) return true;
      return l.title.toLocaleLowerCase('fr').includes(q)
        || l.items.some((i) => i.label.toLocaleLowerCase('fr').includes(q));
    });
  }, [listes, recherche, masquerTerminees]);

  /* ── Les compteurs du haut ─────────────────────────────────────────────── */
  const stats = useMemo(() => {
    const duJour = listes.filter((l) => l.date === aujourdHui);
    const finSemaine = decalerJour(aujourdHui, 6);
    const semaine = listes.filter((l) => l.date >= aujourdHui && l.date <= finSemaine);
    const enRetard = listes.filter((l) => l.date < aujourdHui && !avancement(l.items).complete && l.items.length > 0);
    return {
      duJour,
      itemsJour: duJour.flatMap((l) => l.items),
      semaine,
      itemsSemaine: semaine.flatMap((l) => l.items),
      enRetard,
    };
  }, [listes, aujourdHui]);

  /* ── Vue liste : groupée par jour ──────────────────────────────────────── */
  const groupes = useMemo(() => {
    const retenues = filtrees.filter((l) => (
      periode === 'toutes' ? true : periode === 'avenir' ? l.date >= aujourdHui : l.date < aujourdHui
    ));
    const parJour = new Map<string, TodoList[]>();
    for (const l of retenues) parJour.set(l.date, [...(parJour.get(l.date) ?? []), l]);
    const jours = [...parJour.keys()].sort();
    /* Les passées se lisent de la plus récente à la plus ancienne. */
    if (periode === 'passees') jours.reverse();
    return jours.map((jour) => ({ jour, listes: parJour.get(jour)! }));
  }, [filtrees, periode, aujourdHui]);

  const duJourSelectionne = useMemo(
    () => filtrees.filter((l) => l.date === selection),
    [filtrees, selection],
  );

  const basculer = useCallback((listId: string, itemId: string, done: boolean) => {
    cocher(listId, itemId, done).catch((e) => {
      toast.error(e instanceof Error ? e.message : 'La case n’a pas pu être enregistrée.');
    });
  }, [cocher, toast]);

  const nouvelle = (jour = vue === 'calendrier' ? selection : aujourdHui) => {
    navigate(`/todo/nouvelle?date=${jour}`);
  };

  const choisirJour = (jour: string) => {
    majParams({ jour });
    /* Sur téléphone le panneau du jour est SOUS la grille : on l'amène à
       l'écran, sinon le toucher semble ne rien faire. */
    if (window.matchMedia('(max-width: 1023px)').matches) {
      window.setTimeout(() => panneauJour.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  };

  const confirmerSuppression = async () => {
    if (!aSupprimer) return;
    setSuppressionEnCours(true);
    try {
      await supprimer(aSupprimer._id);
      toast.success(`« ${aSupprimer.title} » supprimée.`);
      setASupprimer(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Suppression impossible.');
    } finally {
      setSuppressionEnCours(false);
    }
  };

  const carte = (l: TodoList, afficherDate = false) => (
    <motion.div key={l._id} layout {...ENTREE}>
      <TodoListCard
        liste={l}
        aujourdHui={aujourdHui}
        afficherDate={afficherDate}
        onToggle={(itemId, done) => basculer(l._id, itemId, done)}
        onEdit={() => navigate(`/todo/${l._id}`)}
        onDelete={() => setASupprimer(l)}
      />
    </motion.div>
  );

  const avJour = avancement(stats.itemsJour);
  const avSemaine = avancement(stats.itemsSemaine);

  return (
    <div className="page">
      <PageHeader
        title="To-do list"
        description="Vos listes du jour et à venir. Cochez au fil de l’eau : l’avancement se met à jour en direct."
        actions={(
          <Button color="primary" iconLeading={Plus} onClick={() => nouvelle()}>
            Nouvelle liste
          </Button>
        )}
      />

      {/* ── Les trois chiffres de la journée ─────────────────────────────── */}
      <div className="uui grid grid-cols-1 gap-3 sm:grid-cols-3">
        <section className="rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary">
          <p className="text-sm font-medium text-tertiary">Aujourd’hui</p>
          <p className="mt-1 text-display-xs font-semibold text-primary tabular-nums">
            {avJour.faits}<span className="text-lg text-quaternary"> / {avJour.total}</span>
          </p>
          <TodoProgress items={stats.itemsJour} size="sm" className="mt-2" />
          <p className="mt-1.5 text-xs text-tertiary">
            {stats.duJour.length === 0 ? 'Aucune liste aujourd’hui' : `${stats.duJour.length} liste${stats.duJour.length > 1 ? 's' : ''}`}
          </p>
        </section>
        <section className="rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary">
          <p className="text-sm font-medium text-tertiary">7 prochains jours</p>
          <p className="mt-1 text-display-xs font-semibold text-primary tabular-nums">
            {avSemaine.faits}<span className="text-lg text-quaternary"> / {avSemaine.total}</span>
          </p>
          <TodoProgress items={stats.itemsSemaine} size="sm" className="mt-2" />
          <p className="mt-1.5 text-xs text-tertiary">
            {stats.semaine.length} liste{stats.semaine.length > 1 ? 's' : ''} prévue{stats.semaine.length > 1 ? 's' : ''}
          </p>
        </section>
        <section className="rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary">
          <p className="text-sm font-medium text-tertiary">Inachevées passées</p>
          <p className={cx('mt-1 text-display-xs font-semibold tabular-nums', stats.enRetard.length ? 'text-utility-orange-700' : 'text-primary')}>
            {stats.enRetard.length}
          </p>
          <p className="mt-1.5 text-xs text-tertiary">
            {stats.enRetard.length
              ? 'Des listes d’avant aujourd’hui ont encore des cases vides.'
              : 'Rien ne traîne. Tout ce qui est passé est bouclé.'}
          </p>
        </section>
      </div>

      {/* ── La barre d'outils ─────────────────────────────────────────────── */}
      <div className="uui flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SmoothTabs
          layoutId="todo-vue"
          value={vue}
          onChange={changerVue}
          tabs={[
            { value: 'liste', label: 'Liste' },
            { value: 'calendrier', label: 'Calendrier' },
          ]}
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="sm:w-64">
            <SearchField
              label="Rechercher une liste ou un élément"
              placeholder="Rechercher une liste, un élément…"
              value={recherche}
              onChange={setRecherche}
            />
          </div>
          <Toggle
            size="sm"
            label="Masquer les terminées"
            isSelected={masquerTerminees}
            onChange={setMasquerTerminees}
          />
        </div>
      </div>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      {chargement ? (
        <Panel><SkeletonRows rows={5} /></Panel>
      ) : vue === 'calendrier' ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
          <Panel>
            <TodoCalendar
              listes={filtrees}
              mois={mois}
              onMoisChange={setMois}
              selection={selection}
              onSelect={choisirJour}
              aujourdHui={aujourdHui}
            />
          </Panel>

          <div ref={panneauJour} className="flex scroll-mt-4 flex-col gap-3">
            <div className="uui flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-md font-semibold text-primary">{libelleJour(selection, aujourdHui)}</h2>
                {duJourSelectionne.length > 0 ? (
                  <TodoProgress items={duJourSelectionne.flatMap((l) => l.items)} size="sm" className="mt-1 w-48" />
                ) : null}
              </div>
              <Button size="sm" color="secondary" iconLeading={CalendarPlus01} onClick={() => nouvelle(selection)}>
                Ajouter
              </Button>
            </div>
            <AnimatePresence mode="popLayout" initial={false}>
              {duJourSelectionne.length === 0 ? (
                <motion.div key={`vide-${selection}`} {...ENTREE}>
                  <Panel>
                    <EmptyPanel
                      icon="calendar-event"
                      title="Aucune liste ce jour-là"
                      hint="Préparez la journée : une liste, quelques cases, et l’avancement se suit tout seul."
                      action={<Button size="sm" iconLeading={Plus} onClick={() => nouvelle(selection)}>Créer une liste</Button>}
                    />
                  </Panel>
                </motion.div>
              ) : duJourSelectionne.map((l) => carte(l))}
            </AnimatePresence>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <SmoothTabs
            layoutId="todo-periode"
            value={periode}
            onChange={setPeriode}
            className="self-start"
            tabs={[
              { value: 'avenir', label: 'À venir' },
              { value: 'passees', label: 'Passées' },
              { value: 'toutes', label: 'Toutes' },
            ]}
          />

          {groupes.length === 0 ? (
            <Panel>
              <EmptyPanel
                icon="check-circle"
                title={recherche ? 'Aucune liste ne correspond' : periode === 'passees' ? 'Aucune liste passée' : 'Aucune liste à venir'}
                hint={recherche ? 'Essayez un autre mot, ou videz la recherche.' : 'Créez une liste pour aujourd’hui ou pour un autre jour.'}
                action={recherche ? undefined : <Button size="sm" iconLeading={Plus} onClick={() => nouvelle()}>Nouvelle liste</Button>}
              />
            </Panel>
          ) : (
            <AnimatePresence initial={false}>
              {groupes.map(({ jour, listes: duJour }) => (
                <motion.section key={jour} layout {...ENTREE} className="flex flex-col gap-3">
                  <div className="uui flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <div className="flex items-baseline gap-2">
                      <h2 className={cx('text-md font-semibold', jour === aujourdHui ? 'text-brand-secondary' : 'text-primary')}>
                        {libelleJour(jour, aujourdHui)}
                      </h2>
                      {jourRelatif(jour, aujourdHui) ? (
                        <span className="text-sm text-tertiary">{dateCivile(jour, true)}</span>
                      ) : null}
                    </div>
                    <TodoProgress items={duJour.flatMap((l) => l.items)} size="sm" className="w-40" />
                  </div>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                    <AnimatePresence initial={false} mode="popLayout">
                      {duJour.map((l) => carte(l))}
                    </AnimatePresence>
                  </div>
                </motion.section>
              ))}
            </AnimatePresence>
          )}
        </div>
      )}

      {/* ── Confirmation de suppression ───────────────────────────────────── */}
      <ModalOverlay isOpen={aSupprimer !== null} onOpenChange={(v) => { if (!v) setASupprimer(null); }} isDismissable>
        <Modal className="w-full max-w-md">
          <Dialog>
            <div className="uui flex flex-col gap-4 p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-primary">Supprimer cette liste ?</h2>
              <p className="text-sm text-tertiary">
                « {aSupprimer?.title} » et ses {aSupprimer?.items.length ?? 0} élément
                {(aSupprimer?.items.length ?? 0) > 1 ? 's' : ''} seront définitivement supprimés.
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button color="secondary" onClick={() => setASupprimer(null)} isDisabled={suppressionEnCours}>Annuler</Button>
                <Button color="primary-destructive" onClick={confirmerSuppression} isLoading={suppressionEnCours}>Supprimer</Button>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
