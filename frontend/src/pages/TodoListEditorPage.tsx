/**
 * CRÉER OU MODIFIER UNE TO-DO LIST — un écran à part, en blocs.
 *
 * ══ POURQUOI UN ÉCRAN, ET PAS UNE MODALE ════════════════════════════════════
 *
 * Préparer une liste, c'est en écrire dix lignes, en remonter deux, choisir un
 * jour. Dans une modale, sur téléphone, le clavier mange la moitié de l'écran
 * et le calendrier l'autre. Ici chaque question a son bloc :
 *
 *   INFORMATIONS   le titre, une note, une couleur ;
 *   ÉLÉMENTS       les cases — c'est le bloc principal, il prend la largeur ;
 *   DATE           le jour, avec ses raccourcis ;
 *   APERÇU         l'avancement tel qu'il s'affichera, recalculé en direct.
 *
 * ══ LA SAISIE DES ÉLÉMENTS SE FAIT AU CLAVIER, SANS LA SOURIS ═══════════════
 *
 *   Entrée              ajoute la ligne et garde le curseur dans le champ ;
 *   Entrée sur une ligne insère une ligne vide juste dessous ;
 *   Retour arrière      sur une ligne vide la supprime et remonte ;
 *   coller plusieurs lignes crée autant d'éléments ;
 *   Ctrl/⌘ + S          enregistre.
 *
 * ══ RIEN N'EST ENVOYÉ AVANT « ENREGISTRER » ════════════════════════════════
 *
 * Une écriture par frappe transformerait une hésitation en historique. Quitter
 * l'onglet avec des modifications non enregistrées demande confirmation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDate } from '@internationalized/date';
import type { DateValue } from 'react-aria-components';
import { ArrowDown, ArrowUp, Check, Plus, Save01, Trash01, XClose } from '@untitledui/icons';
import { Calendar } from '@/components/application/date-picker/calendar';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Button } from '@/components/base/buttons/button';
import { CheckboxBase } from '@/components/base/checkbox/checkbox';
import { Input } from '@/components/base/input/input';
import { TextArea } from '@/components/base/textarea/textarea';
import { useToast } from '@/components/ToastProvider';
import { TodoProgress } from '@/components/todo/TodoProgress';
import { PageHeader, Panel, SkeletonRows } from '@/components/ui-kit';
import { api } from '@/lib/api';
import { avancement, clefJour, dateCivile, decalerJour, jourDepuisClef, libelleJour, TEINTES } from '@/lib/todoLists';
import { cx } from '@/utils/cx';
import { TODO_LIST_COLORS } from '@/types.todoLists';
import type { TodoListColor } from '@/types.todoLists';

interface Ligne { id: string; label: string; done: boolean }

const identifiant = () => (
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
);

const JOUR_VALIDE = /^\d{4}-\d{2}-\d{2}$/;

interface Brouillon {
  title: string;
  description: string;
  date: string;
  color: TodoListColor;
  items: Ligne[];
}

const empreinte = (b: Brouillon) => JSON.stringify({
  ...b, title: b.title.trim(), items: b.items.filter((i) => i.label.trim()),
});

export default function TodoListEditorPage() {
  const { listId } = useParams();
  const creation = !listId || listId === 'nouvelle';
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const aujourdHui = clefJour(new Date());

  const dateInitiale = params.get('date');
  const [brouillon, setBrouillon] = useState<Brouillon>(() => ({
    title: '',
    description: '',
    date: dateInitiale && JOUR_VALIDE.test(dateInitiale) ? dateInitiale : aujourdHui,
    color: 'brand',
    items: [],
  }));
  const [reference, setReference] = useState<string>(() => empreinte(brouillon));
  const [chargement, setChargement] = useState(!creation);
  const [erreurChargement, setErreurChargement] = useState<string | null>(null);
  const [erreurTitre, setErreurTitre] = useState<string | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  const [confirmerSuppression, setConfirmerSuppression] = useState(false);
  const [suppression, setSuppression] = useState(false);
  const [saisie, setSaisie] = useState('');
  const [aFocaliser, setAFocaliser] = useState<string | null>(null);
  const champSaisie = useRef<HTMLInputElement>(null);

  /* ── Chargement en édition ─────────────────────────────────────────────── */
  useEffect(() => {
    if (creation) return;
    let actif = true;
    setChargement(true);
    api.getTodoList(listId!)
      .then(({ todoList }) => {
        if (!actif) return;
        const b: Brouillon = {
          title: todoList.title,
          description: todoList.description ?? '',
          date: todoList.date,
          color: todoList.color ?? 'brand',
          items: todoList.items.map((i) => ({ id: i.id, label: i.label, done: i.done })),
        };
        setBrouillon(b);
        setReference(empreinte(b));
      })
      .catch((e) => { if (actif) setErreurChargement(e instanceof Error ? e.message : 'Liste introuvable.'); })
      .finally(() => { if (actif) setChargement(false); });
    return () => { actif = false; };
  }, [creation, listId]);

  const modifie = empreinte(brouillon) !== reference;

  /* Fermer l'onglet avec des changements en cours demande confirmation. */
  useEffect(() => {
    if (!modifie) return undefined;
    const avertir = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', avertir);
    return () => window.removeEventListener('beforeunload', avertir);
  }, [modifie]);

  /* Le focus suit la ligne qu'on vient de créer ou d'atteindre. */
  useEffect(() => {
    if (!aFocaliser) return;
    const champ = document.querySelector<HTMLInputElement>(`[data-ligne="${aFocaliser}"]`);
    if (champ) {
      champ.focus();
      const fin = champ.value.length;
      champ.setSelectionRange(fin, fin);
    }
    setAFocaliser(null);
  }, [aFocaliser, brouillon.items]);

  const maj = <K extends keyof Brouillon>(clef: K, valeur: Brouillon[K]) => {
    setBrouillon((b) => ({ ...b, [clef]: valeur }));
  };
  const majItems = (f: (items: Ligne[]) => Ligne[]) => setBrouillon((b) => ({ ...b, items: f(b.items) }));

  /* ── Éléments ──────────────────────────────────────────────────────────── */
  const ajouterDepuisSaisie = () => {
    const lignes = saisie.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lignes.length === 0) return;
    majItems((items) => [...items, ...lignes.map((label) => ({ id: identifiant(), label, done: false }))]);
    setSaisie('');
    champSaisie.current?.focus();
  };

  const collerDansSaisie = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const texte = e.clipboardData.getData('text');
    if (!/\r?\n/.test(texte)) return;
    e.preventDefault();
    const lignes = `${saisie}${texte}`.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s*/, '').trim()).filter(Boolean);
    majItems((items) => [...items, ...lignes.map((label) => ({ id: identifiant(), label, done: false }))]);
    setSaisie('');
  };

  const insererApres = (index: number) => {
    const id = identifiant();
    majItems((items) => [...items.slice(0, index + 1), { id, label: '', done: false }, ...items.slice(index + 1)]);
    setAFocaliser(id);
  };

  const retirer = (index: number, focaliserPrecedent = false) => {
    const precedent = brouillon.items[index - 1]?.id ?? null;
    majItems((items) => items.filter((_, i) => i !== index));
    if (focaliserPrecedent) {
      if (precedent) setAFocaliser(precedent);
      else champSaisie.current?.focus();
    }
  };

  const deplacer = (index: number, sens: -1 | 1) => {
    majItems((items) => {
      const cible = index + sens;
      if (cible < 0 || cible >= items.length) return items;
      const copie = [...items];
      [copie[index], copie[cible]] = [copie[cible], copie[index]];
      return copie;
    });
  };

  const toucheLigne = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    const ligne = brouillon.items[index];
    if (e.key === 'Enter') { e.preventDefault(); insererApres(index); }
    else if (e.key === 'Backspace' && ligne.label === '') { e.preventDefault(); retirer(index, true); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); deplacer(index, -1); setAFocaliser(ligne.id); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); deplacer(index, 1); setAFocaliser(ligne.id); }
    else if (e.key === 'ArrowUp' && brouillon.items[index - 1]) { e.preventDefault(); setAFocaliser(brouillon.items[index - 1].id); }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (brouillon.items[index + 1]) setAFocaliser(brouillon.items[index + 1].id);
      else champSaisie.current?.focus();
    }
  };

  /* ── Enregistrer ───────────────────────────────────────────────────────── */
  const enregistrer = useCallback(async () => {
    if (!brouillon.title.trim()) {
      setErreurTitre('Donnez un titre à la liste.');
      document.querySelector<HTMLInputElement>('[data-champ="titre"] input')?.focus();
      return;
    }
    setEnregistrement(true);
    try {
      /* Une saisie en attente dans le champ d'ajout est un élément qu'on a
         tapé : la perdre au clic sur « Enregistrer » serait une mauvaise
         surprise. */
      const enAttente = saisie.trim()
        ? saisie.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((label) => ({ id: identifiant(), label, done: false }))
        : [];
      const corps = {
        title: brouillon.title.trim(),
        description: brouillon.description,
        date: brouillon.date,
        color: brouillon.color,
        items: [...brouillon.items, ...enAttente].filter((i) => i.label.trim()),
      };
      if (creation) await api.createTodoList(corps);
      else await api.updateTodoList(listId!, corps);
      setReference(empreinte({ ...brouillon, items: corps.items }));
      toast.success(creation ? 'Liste créée.' : 'Modifications enregistrées.');
      navigate(`/todo?jour=${brouillon.date}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Enregistrement impossible.');
    } finally {
      setEnregistrement(false);
    }
  }, [brouillon, creation, listId, navigate, saisie, toast]);

  useEffect(() => {
    const raccourci = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void enregistrer();
      }
    };
    window.addEventListener('keydown', raccourci);
    return () => window.removeEventListener('keydown', raccourci);
  }, [enregistrer]);

  const supprimer = async () => {
    setSuppression(true);
    try {
      await api.deleteTodoList(listId!);
      setReference(empreinte(brouillon));
      toast.success('Liste supprimée.');
      navigate(`/todo?jour=${brouillon.date}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Suppression impossible.');
      setSuppression(false);
    }
  };

  const quitter = () => navigate(`/todo?jour=${brouillon.date}`);

  /* ── Date ──────────────────────────────────────────────────────────────── */
  const jourCalendrier: DateValue = useMemo(() => {
    const d = jourDepuisClef(brouillon.date);
    return new CalendarDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }, [brouillon.date]);

  const raccourcisDate = useMemo(() => {
    const lundi = jourDepuisClef(aujourdHui);
    lundi.setDate(lundi.getDate() + (((8 - lundi.getDay()) % 7) || 7));
    return [
      { label: 'Aujourd’hui', jour: aujourdHui },
      { label: 'Demain', jour: decalerJour(aujourdHui, 1) },
      { label: 'Lundi prochain', jour: clefJour(lundi) },
    ];
  }, [aujourdHui]);

  const av = avancement(brouillon.items.filter((i) => i.label.trim()));

  if (chargement) {
    return (
      <div className="page">
        <PageHeader title="Modifier la liste" backTo={{ to: '/todo', label: 'To-do list' }} />
        <Panel><SkeletonRows rows={6} /></Panel>
      </div>
    );
  }
  if (erreurChargement) {
    return (
      <div className="page">
        <PageHeader title="Modifier la liste" backTo={{ to: '/todo', label: 'To-do list' }} />
        <div className="alert alert-error">{erreurChargement}</div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={creation ? 'Nouvelle liste' : 'Modifier la liste'}
        description={creation
          ? 'Un titre, un jour, des cases à cocher. Entrée ajoute un élément, Ctrl + S enregistre.'
          : 'Renommez, réordonnez, ajoutez des éléments. Les cases déjà cochées le restent.'}
        backTo={{ to: `/todo?jour=${brouillon.date}`, label: 'To-do list' }}
        actions={(
          <div className="hidden items-center gap-2 sm:flex">
            <Button color="secondary" onClick={quitter} isDisabled={enregistrement}>Annuler</Button>
            <Button color="primary" iconLeading={Save01} onClick={enregistrer} isLoading={enregistrement}>
              {creation ? 'Créer la liste' : 'Enregistrer'}
            </Button>
          </div>
        )}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:items-start">
        {/* ── Colonne principale ────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Informations" description="Ce que la liste couvre, en quelques mots.">
            <div className="flex flex-col gap-4">
              <div data-champ="titre">
                <Input
                  label="Titre"
                  isRequired
                  autoFocus={creation}
                  value={brouillon.title}
                  onChange={(v) => { maj('title', v); if (erreurTitre) setErreurTitre(null); }}
                  placeholder="Préparation du rendez-vous client"
                  isInvalid={Boolean(erreurTitre)}
                  hint={erreurTitre ?? undefined}
                  maxLength={200}
                />
              </div>
              <TextArea
                label="Note"
                value={brouillon.description}
                onChange={(v) => maj('description', v)}
                rows={3}
                placeholder="Contexte, lien utile, ce qu’il faut savoir avant de commencer (facultatif)."
              />
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-secondary">Couleur</span>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Couleur de la liste">
                  {TODO_LIST_COLORS.map((c) => {
                    const actif = brouillon.color === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={actif}
                        aria-label={TEINTES[c].nom}
                        title={TEINTES[c].nom}
                        onClick={() => maj('color', c)}
                        className={cx(
                          'flex size-8 items-center justify-center rounded-full transition-transform duration-150',
                          'outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2',
                          TEINTES[c].pastille,
                          actif ? 'scale-110 ring-2 ring-primary ring-offset-2 ring-offset-bg-primary' : 'hover:scale-105',
                        )}
                      >
                        {actif ? <Check className="size-4 text-white" aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </Panel>

          <Panel
            title="Éléments"
            badge={<span className="rounded-full bg-secondary px-2 text-xs font-semibold text-secondary tabular-nums">{av.total}</span>}
            description="Chaque élément est une case à cocher. L’ordre ici est l’ordre affiché."
            actions={brouillon.items.length > 0 ? (
              <>
                <Button size="sm" color="link-gray" onClick={() => majItems((items) => items.map((i) => ({ ...i, done: true })))}>
                  Tout cocher
                </Button>
                <Button size="sm" color="link-gray" onClick={() => majItems((items) => items.map((i) => ({ ...i, done: false })))}>
                  Tout décocher
                </Button>
              </>
            ) : null}
          >
            <div className="flex flex-col gap-4">
              <TodoProgress items={brouillon.items.filter((i) => i.label.trim())} color={brouillon.color} />

              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <label className="sr-only" htmlFor="todo-ajout">Nouvel élément</label>
                  <input
                    id="todo-ajout"
                    ref={champSaisie}
                    value={saisie}
                    onChange={(e) => setSaisie(e.target.value)}
                    onPaste={collerDansSaisie}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); ajouterDepuisSaisie(); }
                      else if (e.key === 'ArrowUp' && brouillon.items.length) {
                        e.preventDefault();
                        setAFocaliser(brouillon.items[brouillon.items.length - 1].id);
                      }
                    }}
                    placeholder="Ajouter un élément, puis Entrée…"
                    maxLength={300}
                    className="w-full rounded-lg bg-primary px-3 py-2 text-md text-primary shadow-xs ring-1 ring-primary transition-shadow ring-inset outline-none placeholder:text-placeholder focus:ring-2 focus:ring-brand sm:text-sm"
                  />
                </div>
                <Button color="secondary" iconLeading={Plus} onClick={ajouterDepuisSaisie} isDisabled={!saisie.trim()}>
                  <span className="hidden sm:inline">Ajouter</span>
                </Button>
              </div>

              {brouillon.items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-secondary px-4 py-6 text-center text-sm text-tertiary">
                  Aucun élément pour l’instant. Tapez-en un ci-dessus — ou collez une liste entière,
                  une ligne par élément.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  <AnimatePresence initial={false}>
                    {brouillon.items.map((item, index) => (
                      <motion.li
                        key={item.id}
                        layout
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -12, transition: { duration: 0.12 } }}
                        transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                        className={cx(
                          'group flex items-center gap-2 rounded-lg bg-primary py-1 pr-1 pl-3 ring-1 ring-secondary transition-shadow',
                          'focus-within:ring-2 focus-within:ring-brand',
                        )}
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={item.done}
                          aria-label={item.done ? `Décocher « ${item.label || 'élément'} »` : `Cocher « ${item.label || 'élément'} »`}
                          onClick={() => majItems((items) => items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))}
                          className="flex size-8 shrink-0 items-center justify-center rounded-md outline-focus-ring focus-visible:outline-2"
                        >
                          <CheckboxBase size="md" isSelected={item.done} />
                        </button>
                        <input
                          data-ligne={item.id}
                          aria-label={`Élément ${index + 1}`}
                          value={item.label}
                          maxLength={300}
                          onChange={(e) => majItems((items) => items.map((i) => (i.id === item.id ? { ...i, label: e.target.value } : i)))}
                          onKeyDown={(e) => toucheLigne(e, index)}
                          placeholder="Élément vide — il sera ignoré"
                          className={cx(
                            'min-w-0 flex-1 bg-transparent py-1.5 text-md outline-none placeholder:text-placeholder sm:text-sm',
                            item.done ? 'text-quaternary line-through' : 'text-primary',
                          )}
                        />
                        <div className="flex shrink-0 items-center transition-opacity lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
                          <Button size="sm" color="tertiary" aria-label={`Monter l’élément ${index + 1}`} isDisabled={index === 0} onClick={() => deplacer(index, -1)} iconLeading={ArrowUp} />
                          <Button size="sm" color="tertiary" aria-label={`Descendre l’élément ${index + 1}`} isDisabled={index === brouillon.items.length - 1} onClick={() => deplacer(index, 1)} iconLeading={ArrowDown} />
                          <Button size="sm" color="tertiary-destructive" aria-label={`Supprimer l’élément ${index + 1}`} onClick={() => retirer(index)} iconLeading={XClose} />
                        </div>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
              {brouillon.items.length > 1 ? (
                <p className="hidden text-xs text-quaternary lg:block">
                  Astuce : Entrée insère une ligne dessous, Alt + ↑/↓ déplace l’élément, Retour arrière sur une ligne vide la supprime.
                </p>
              ) : null}
            </div>
          </Panel>
        </div>

        {/* ── Colonne latérale : date et aperçu ─────────────────────────── */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-4">
          <Panel title="Date" description={dateCivile(brouillon.date)}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-1.5">
                {raccourcisDate.map((r) => (
                  <Button
                    key={r.label}
                    size="sm"
                    color={brouillon.date === r.jour ? 'primary' : 'secondary'}
                    onClick={() => maj('date', r.jour)}
                  >
                    {r.label}
                  </Button>
                ))}
              </div>
              <div className="flex justify-center rounded-lg border border-secondary p-3">
                <Calendar
                  aria-label="Jour de la liste"
                  value={jourCalendrier}
                  onChange={(v: DateValue | null) => {
                    if (v) maj('date', `${v.year}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`);
                  }}
                >
                  {null}
                </Calendar>
              </div>
            </div>
          </Panel>

          <Panel title="Aperçu">
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span className={cx('mt-1.5 size-2.5 shrink-0 rounded-full', av.complete ? 'bg-utility-green-500' : TEINTES[brouillon.color].pastille)} />
                <div className="min-w-0">
                  <p className={cx('truncate text-md font-semibold', brouillon.title.trim() ? 'text-primary' : 'text-quaternary')}>
                    {brouillon.title.trim() || 'Sans titre'}
                  </p>
                  <p className="text-sm text-tertiary">{libelleJour(brouillon.date, aujourdHui)}</p>
                </div>
              </div>
              <TodoProgress items={brouillon.items.filter((i) => i.label.trim())} color={brouillon.color} />
              <p className="text-sm text-tertiary">
                {av.total === 0
                  ? 'Aucun élément.'
                  : av.complete
                    ? `Les ${av.total} éléments sont cochés.`
                    : `${av.faits} élément${av.faits > 1 ? 's' : ''} coché${av.faits > 1 ? 's' : ''} sur ${av.total}.`}
              </p>
              {!creation ? (
                <div className="border-t border-secondary pt-3">
                  <Button size="sm" color="link-destructive" iconLeading={Trash01} onClick={() => setConfirmerSuppression(true)}>
                    Supprimer cette liste
                  </Button>
                </div>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>

      {/* ── Barre d'actions collée en bas, sur téléphone ─────────────────── */}
      {/* Réserve la hauteur de la barre fixe : sans elle, le dernier bloc passerait dessous. */}
      <div aria-hidden="true" className="h-16 sm:hidden" />
      <div className="uui fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-secondary bg-primary px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg sm:hidden">
        <Button className="flex-1" color="secondary" onClick={quitter} isDisabled={enregistrement}>Annuler</Button>
        <Button className="flex-1" color="primary" iconLeading={Save01} onClick={enregistrer} isLoading={enregistrement}>
          {creation ? 'Créer' : 'Enregistrer'}
        </Button>
      </div>

      <ModalOverlay isOpen={confirmerSuppression} onOpenChange={setConfirmerSuppression} isDismissable>
        <Modal className="w-full max-w-md">
          <Dialog>
            <div className="uui flex flex-col gap-4 p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-primary">Supprimer cette liste ?</h2>
              <p className="text-sm text-tertiary">
                « {brouillon.title || 'Sans titre'} » et ses éléments seront définitivement supprimés.
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button color="secondary" onClick={() => setConfirmerSuppression(false)} isDisabled={suppression}>Annuler</Button>
                <Button color="primary-destructive" onClick={supprimer} isLoading={suppression}>Supprimer</Button>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
