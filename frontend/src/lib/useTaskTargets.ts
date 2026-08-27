/**
 * CE À QUOI UNE TÂCHE PEUT SE RATTACHER, RÉSOLU CONTRE LES REGISTRES VIVANTS.
 *
 * ══ POURQUOI UN SEUL CROCHET POUR QUATRE REGISTRES ══════════════════════════
 *
 * Une tâche peut nommer un projet, un prospect, une entreprise et un mouvement
 * à la fois. Chaque carte interrogeant les quatre pour son compte, une liste de
 * vingt tâches déclencherait quatre-vingts requêtes pour afficher des noms que
 * trois registres sur quatre ont déjà en mémoire.
 *
 * Les quatre listes sont donc chargées UNE FOIS, au niveau de l'écran, et le
 * résolveur qui en sort est passé aux cartes.
 *
 * ══ CE QU'IL FAIT QUAND IL NE TROUVE PAS ═══════════════════════════════════
 *
 * Il le DIT. Une tâche porte des identifiants, jamais des noms recopiés — c'est
 * ce qui permet à un projet renommé de se lire sous son nouveau nom partout. La
 * contrepartie est qu'une cible supprimée laisse un identifiant orphelin :
 * l'écran écrit alors « Projet supprimé », pas trente-six caractères
 * d'identifiant technique. Nommer l'absence n'est pas inventer une donnée.
 */
import { useCallback, useMemo } from 'react';
import { api, clientCompanies as apiClientCompanies, finances } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { TaskLinkKind } from '@/types.tasks';

const REFRESH_MS = 120_000;

export interface TaskTarget {
  id: string;
  /** Le nom courant, ou la mention d'absence. Jamais un identifiant nu. */
  label: string;
  /** Une précision qui aide à distinguer deux homonymes. */
  hint?: string;
  /** La route de la fiche, ou `null` si la cible n'existe plus. */
  to: string | null;
}

interface Registres {
  projects: { id: string; label: string; hint?: string }[];
  prospects: { id: string; label: string; hint?: string }[];
  clientCompanies: { id: string; label: string; hint?: string }[];
  transactions: { id: string; label: string; hint?: string }[];
}

const VIDE: Registres = { projects: [], prospects: [], clientCompanies: [], transactions: [] };

const MONNAIE = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

export function useTaskTargets() {
  const fetcher = useCallback(async (): Promise<Registres> => {
    /*
      LES QUATRE EN PARALLÈLE, ET AUCUNE NE FAIT TOMBER LES AUTRES.
      Un registre indisponible ne doit pas priver la carte des trois autres :
      mieux vaut trois noms et une mention d'absence que rien du tout.
    */
    const [projets, prospects, entreprises, mouvements] = await Promise.all([
      api.listProjects().catch(() => ({ projects: [] })),
      api.listProspects().catch(() => ({ prospects: [] })),
      apiClientCompanies.listClientCompanies().catch(() => ({ clientCompanies: [] })),
      finances.list({ period: 'ALL', limit: 200 }).catch(() => ({ items: [] })),
    ]);

    return {
      projects: (projets.projects ?? []).map((p) => ({
        id: p.projectId,
        label: p.projectName || p.projectKey || p.projectId,
        hint: p.projectKey && p.projectKey !== p.projectName ? p.projectKey : undefined,
      })),
      prospects: (prospects.prospects ?? []).map((p) => ({
        id: p._id,
        label: p.name,
        hint: p.email || undefined,
      })),
      clientCompanies: (entreprises.clientCompanies ?? []).map((c) => ({
        id: c.clientCompanyId,
        label: c.legalName,
        hint: c.tradingName && c.tradingName !== c.legalName ? c.tradingName : undefined,
      })),
      transactions: (mouvements.items ?? []).map((t) => ({
        id: t.transactionId,
        label: t.label || 'Mouvement',
        hint: MONNAIE.format(t.amountCents / 100),
      })),
    };
  }, []);

  const q = useLiveQuery<Registres>(fetcher, {
    intervalMs: REFRESH_MS,
    fallbackError: 'Impossible de charger les éléments rattachables.',
    key: 'task-targets',
  });

  const registres = q.data ?? VIDE;

  const index = useMemo(() => {
    const faire = (liste: { id: string; label: string; hint?: string }[]) => (
      new Map(liste.map((e) => [e.id, e]))
    );
    return {
      projectIds: faire(registres.projects),
      prospectIds: faire(registres.prospects),
      clientCompanyIds: faire(registres.clientCompanies),
      transactionIds: faire(registres.transactions),
    };
  }, [registres]);

  /** La route d'une fiche, par famille. `null` quand la cible a disparu. */
  const routes: Record<TaskLinkKind, (id: string) => string> = {
    projectIds: (id) => `/projects/${id}`,
    prospectIds: (id) => `/prospection/${id}`,
    clientCompanyIds: (id) => `/clients/${id}`,
    transactionIds: () => '/finances',
  };

  const ABSENTS: Record<TaskLinkKind, string> = {
    projectIds: 'Projet supprimé',
    prospectIds: 'Prospect supprimé',
    clientCompanyIds: 'Entreprise supprimée',
    transactionIds: 'Mouvement introuvable',
  };

  const resolve = useCallback((kind: TaskLinkKind, id: string): TaskTarget => {
    const trouve = index[kind].get(id);
    if (!trouve) {
      /* On garde huit caractères de l'identifiant RÉEL : le registre peut
         compter plusieurs disparus, et ils ne doivent pas se confondre. */
      return { id, label: `${ABSENTS[kind]} — ${id.slice(0, 8)}`, to: null };
    }
    return { id, label: trouve.label, hint: trouve.hint, to: routes[kind](id) };
  }, [index]);

  const options = useCallback((kind: TaskLinkKind) => (
    [...index[kind].values()].sort((a, b) => a.label.localeCompare(b.label, 'fr'))
  ), [index]);

  return { resolve, options, isLoading: q.isInitialLoading, error: q.error };
}

export type TaskTargetResolver = ReturnType<typeof useTaskTargets>;
