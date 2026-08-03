/**
 * MICRO-EXÉCUTEUR DE HOOKS — juste assez de React pour éprouver un hook de
 * LECTURE, sans embarquer de moteur de rendu.
 *
 * ── POURQUOI IL EXISTE ──────────────────────────────────────────────────────
 * Le dépôt n'a ni jsdom ni react-test-renderer, et les suites sont des runners
 * node autonomes. Or ce qu'il faut prouver ici est un COMPORTEMENT — « les
 * anciennes données restent visibles pendant le rafraîchissement » — pas une
 * forme de source. Un contrôle textuel ne le dirait pas.
 *
 * ── CE QUE CE N'EST PAS ─────────────────────────────────────────────────────
 * Ce n'est pas React. Pas de concurrence, pas de batching, pas de StrictMode.
 * C'est suffisant parce que le hook testé ne repose que sur `useState`,
 * `useRef`, `useEffect` et `useCallback` — et sur des références, précisément
 * pour ne PAS dépendre des subtilités d'ordonnancement de React.
 */
let cells = [];
let cursor = 0;
let current = null;

function cell(init) {
  if (cursor === cells.length) cells.push(init());
  return cells[cursor++];
}

const sameDeps = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((v, i) => Object.is(v, b[i]));

export function useState(initial) {
  const slot = cell(() => ({
    value: typeof initial === 'function' ? initial() : initial,
  }));
  const set = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    current?.markDirty();
  };
  return [slot.value, set];
}

export function useRef(initial) {
  return cell(() => ({ current: initial }));
}

export function useCallback(fn, deps) {
  const slot = cell(() => ({ fn, deps }));
  if (!sameDeps(slot.deps, deps)) {
    slot.fn = fn;
    slot.deps = deps;
  }
  return slot.fn;
}

export function useMemo(factory, deps) {
  const slot = cell(() => ({ value: factory(), deps }));
  if (!sameDeps(slot.deps, deps)) {
    slot.value = factory();
    slot.deps = deps;
  }
  return slot.value;
}

export function useEffect(fn, deps) {
  const slot = cell(() => ({ deps: null, cleanup: null, first: true }));
  if (slot.first || !sameDeps(slot.deps, deps)) {
    slot.first = false;
    slot.deps = deps;
    current.pending.push(slot, fn);
  }
}

/**
 * Monte un hook et rend la main sur son résultat courant.
 *
 * `flush()` fait tourner rendus et effets jusqu'à stabilisation, en laissant
 * respirer la file des micro-tâches : c'est là que se résolvent les promesses
 * du fetcher.
 */
export function mount(hook) {
  cells = [];
  const state = { dirty: false, pending: [], result: null, renders: [] };
  state.markDirty = () => { state.dirty = true; };
  current = state;

  const render = () => {
    cursor = 0;
    state.dirty = false;
    state.result = hook();
    state.renders.push(state.result);
    // Effets : nettoyage de l'ancien, puis exécution du nouveau.
    const queued = state.pending;
    state.pending = [];
    for (let i = 0; i < queued.length; i += 2) {
      const slot = queued[i];
      const fn = queued[i + 1];
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = fn() ?? null;
    }
  };

  render();

  const flush = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      if (state.dirty) render();
    }
  };

  const unmount = () => {
    for (const slot of cells) {
      if (slot && typeof slot.cleanup === 'function') slot.cleanup();
    }
  };

  return {
    get result() { return state.result; },
    get renders() { return state.renders; },
    flush,
    /** Rejoue le hook — comme un rendu provoqué par un parent (autre route). */
    rerender: render,
    unmount,
  };
}

export default { useState, useRef, useEffect, useCallback, useMemo };
