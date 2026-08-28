/**
 * L'ARBRE DES DOSSIERS.
 *
 * ══ POURQUOI UN VRAI `Tree`, ET PAS UNE LISTE INDENTÉE ══════════════════════
 *
 * Parce qu'une liste indentée ne s'annonce pas. Le `Tree` de React Aria — la
 * base sur laquelle Untitled UI est construit — pose `role="tree"`,
 * `aria-expanded`, `aria-level`, un seul arrêt de tabulation pour le groupe, et
 * la navigation aux flèches : haut/bas pour parcourir, droite pour déplier,
 * gauche pour replier ou remonter au parent. Rien de cela ne s'obtient d'une
 * `<ul>` à `padding-left`.
 *
 * ══ DEUX ENTRÉES QUI NE SONT PAS DES DOSSIERS ══════════════════════════════
 *
 *   « Tout »          ne filtre rien. C'est l'état d'arrivée : on ouvre l'écran
 *                     pour voir ce qu'on a, pas pour choisir un rayon.
 *   « Sans dossier »  ce qui n'est rangé nulle part. Sans cette entrée, un
 *                     prospect noté pendant un appel disparaîtrait de l'écran
 *                     dès qu'un dossier est sélectionné, et on le croirait
 *                     perdu.
 *
 * Elles vivent DANS l'arbre, à la racine, et pas dans une barre d'outils à
 * côté : ce sont trois réponses à la même question — « qu'est-ce que je
 * regarde ? » — et les séparer obligerait à chercher à deux endroits.
 *
 * ══ LE COMPTE EST CELUI DE LA BRANCHE, PAS DU DOSSIER ══════════════════════
 *
 * « Restaurants (12) » où le dossier lui-même n'en porte que deux, les dix
 * autres étant dans « Restaurants/Paris », est la seule lecture utile : sinon
 * un dossier de rangement pur afficherait zéro, et on le croirait vide.
 */
import { useMemo } from 'react';
import {
  Button as AriaButton,
  Collection as AriaCollection,
  Tree as AriaTree,
  TreeItem as AriaTreeItem,
  TreeItemContent as AriaTreeItemContent,
} from 'react-aria-components';
import { Icon } from '@/components/Icon';
import type { ProspectFolder } from '@/types.prospection';

/** La sélection de l'écran : un dossier, la racine, ou tout. */
export type FolderSelection = string | 'ALL' | 'NONE';

export interface FolderNode {
  id: string;
  name: string;
  children: FolderNode[];
  /** Ce que porte ce dossier seul. */
  compte: number;
  /** Ce que porte la BRANCHE — lui et toute sa descendance. */
  compteBranche: number;
}

/**
 * L'ARBRE, DEPUIS LA LISTE PLATE DU SERVEUR.
 *
 * ── LA BORNE N'EST PAS DE LA SUPERSTITION ─────────────────────────────────
 * Un cycle déjà présent en base — écrit par une version antérieure, ou par une
 * écriture concurrente — ferait boucler l'écran sans fin. Le serveur l'interdit
 * à l'écriture ; l'écran refuse de s'y perdre à la lecture.
 */
export function buildFolderTree(
  folders: ProspectFolder[],
  comptes: Map<string | null, number>,
): { racines: FolderNode[]; total: number; sansDossier: number } {
  const parParent = new Map<string | null, ProspectFolder[]>();
  for (const f of folders) {
    const clef = f.parentId ?? null;
    parParent.set(clef, [...(parParent.get(clef) ?? []), f]);
  }

  const vus = new Set<string>();
  const construire = (parentId: string | null, profondeur: number): FolderNode[] => {
    if (profondeur > 20) return [];
    return (parParent.get(parentId) ?? [])
      .filter((f) => !vus.has(f._id))
      .map((f) => {
        vus.add(f._id);
        const enfants = construire(f._id, profondeur + 1);
        const compte = comptes.get(f._id) ?? 0;
        return {
          id: f._id,
          name: f.name,
          children: enfants,
          compte,
          compteBranche: compte + enfants.reduce((n, e) => n + e.compteBranche, 0),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  };

  const racines = construire(null, 0);
  let total = 0;
  for (const n of comptes.values()) total += n;

  return { racines, total, sansDossier: comptes.get(null) ?? 0 };
}

/** Tous les identifiants de la branche, sélection comprise. */
export function branche(noeud: FolderNode): string[] {
  return [noeud.id, ...noeud.children.flatMap(branche)];
}

function trouver(noeuds: FolderNode[], id: string): FolderNode | null {
  for (const n of noeuds) {
    if (n.id === id) return n;
    const trouve = trouver(n.children, id);
    if (trouve) return trouve;
  }
  return null;
}

/** Les identifiants couverts par une sélection — la branche entière. */
export function idsCouverts(racines: FolderNode[], selection: FolderSelection): string[] {
  if (selection === 'ALL' || selection === 'NONE') return [];
  const noeud = trouver(racines, selection);
  return noeud ? branche(noeud) : [selection];
}

const LIGNE = [
  'group flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm outline-hidden',
  'cursor-pointer transition-colors',
  'hover:bg-secondary',
  'focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
  'selected:bg-secondary selected:font-medium',
].join(' ');

/**
 * UNE ENTRÉE DE L'ARBRE — dossier, ou raccourci.
 *
 * « Tout » et « Sans dossier » ne sont pas des dossiers, mais ils vivent dans
 * la MÊME collection : ce sont trois réponses à la même question — « qu'est-ce
 * que je regarde ? » — et les séparer en deux listes obligerait à chercher à
 * deux endroits, et à gérer deux sélections qui doivent n'en faire qu'une.
 */
interface Entree {
  id: string;
  name: string;
  compteBranche: number;
  children: Entree[];
  /** VRAI pour « Tout » et « Sans dossier » : ni renommables, ni supprimables. */
  raccourci: boolean;
  icone: 'stack' | 'journal-text' | 'archive';
}

function versEntree(n: FolderNode): Entree {
  return {
    id: n.id,
    name: n.name,
    compteBranche: n.compteBranche,
    children: n.children.map(versEntree),
    raccourci: false,
    icone: n.children.length > 0 ? 'stack' : 'journal-text',
  };
}

export function FolderTree({
  racines, total, sansDossier, selection, onSelectionChange,
  onRenommer, onSupprimer, onAjouterEnfant, labelTout = 'Tout',
}: {
  racines: FolderNode[];
  total: number;
  sansDossier: number;
  selection: FolderSelection;
  onSelectionChange: (s: FolderSelection) => void;
  onRenommer?: (n: FolderNode) => void;
  onSupprimer?: (n: FolderNode) => void;
  onAjouterEnfant?: (n: FolderNode) => void;
  labelTout?: string;
}) {
  const cles = useMemo(() => new Set([selection]), [selection]);

  const entrees = useMemo<Entree[]>(() => [
    { id: 'ALL', name: labelTout, compteBranche: total, children: [], raccourci: true, icone: 'stack' },
    { id: 'NONE', name: 'Sans dossier', compteBranche: sansDossier, children: [], raccourci: true, icone: 'archive' },
    ...racines.map(versEntree),
  ], [racines, total, sansDossier, labelTout]);

  /** Retrouver le nœud d'origine : les rappels parlent en `FolderNode`. */
  const parId = useMemo(() => {
    const index = new Map<string, FolderNode>();
    const visiter = (liste: FolderNode[]) => {
      for (const n of liste) { index.set(n.id, n); visiter(n.children); }
    };
    visiter(racines);
    return index;
  }, [racines]);

  /**
   * ── LE RENDU EST UNE FONCTION, ET CE N'EST PAS UN DÉTAIL ──────────────────
   *
   * Une première version enveloppait chaque nœud dans un composant maison.
   * L'arbre ne rendait alors RIEN : le constructeur de collection de React Aria
   * ne voit pas à travers un composant arbitraire — il ne connaît que ses
   * propres primitives (`TreeItem`, `Collection`). Constaté sur l'instance
   * déployée : `role="tree"` introuvable, aucune erreur en console.
   *
   * La récursion passe donc par `<Collection items>`, qui est la seule façon
   * supportée d'imbriquer.
   */
  const rendre = (entree: Entree) => {
    const aDesEnfants = entree.children.length > 0;
    const noeud = parId.get(entree.id) ?? null;
    const gerable = !entree.raccourci && noeud !== null;

    return (
      <AriaTreeItem id={entree.id} textValue={entree.name} className={LIGNE}>
        <AriaTreeItemContent>
          {/*
            LE CHEVRON EST UN BOUTON `slot="chevron"` : React Aria lui câble le
            dépliage, l'état `aria-expanded` et la touche Entrée. Un `<span>`
            avec un `onClick` aurait tout laissé au clavier sans réponse.

            Une feuille garde son emplacement, vide : sans lui, les noms des
            feuilles et ceux des dossiers ne s'aligneraient pas, et l'œil lirait
            deux niveaux là où il n'y en a qu'un.
          */}
          {aDesEnfants ? (
            <AriaButton
              slot="chevron"
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-tertiary outline-hidden hover:text-primary"
            >
              <Icon name="chevron-right" size={12} className="transition-transform group-expanded:rotate-90" />
            </AriaButton>
          ) : (
            <span aria-hidden="true" className="size-5 shrink-0" />
          )}

          <Icon name={entree.icone} size={14} className="shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-secondary group-selected:text-primary">
            {entree.name}
          </span>
          <span className="shrink-0 text-xs text-quaternary">{entree.compteBranche}</span>

          {/*
            LES ACTIONS N'APPARAISSENT QU'AU SURVOL ET AU FOCUS.
            `focus-within` est la moitié qui compte : sans elle, un utilisateur
            au clavier atteindrait des boutons invisibles.
          */}
          {gerable && (onAjouterEnfant || onRenommer || onSupprimer) ? (
            <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {onAjouterEnfant ? (
                <button
                  type="button" aria-label={`Ajouter un sous-dossier à ${entree.name}`}
                  className="rounded-sm p-0.5 text-tertiary hover:text-primary"
                  onClick={(e) => { e.stopPropagation(); onAjouterEnfant(noeud); }}
                ><Icon name="plus-lg" size={12} /></button>
              ) : null}
              {onRenommer ? (
                <button
                  type="button" aria-label={`Renommer ${entree.name}`}
                  className="rounded-sm p-0.5 text-tertiary hover:text-primary"
                  onClick={(e) => { e.stopPropagation(); onRenommer(noeud); }}
                ><Icon name="pencil" size={12} /></button>
              ) : null}
              {onSupprimer ? (
                <button
                  type="button" aria-label={`Supprimer ${entree.name}`}
                  className="rounded-sm p-0.5 text-tertiary hover:text-primary"
                  onClick={(e) => { e.stopPropagation(); onSupprimer(noeud); }}
                ><Icon name="trash" size={12} /></button>
              ) : null}
            </span>
          ) : null}
        </AriaTreeItemContent>

        <AriaCollection items={entree.children}>{rendre}</AriaCollection>
      </AriaTreeItem>
    );
  };

  return (
    <AriaTree
      aria-label="Dossiers"
      selectionMode="single"
      selectedKeys={cles}
      disallowEmptySelection
      items={entrees}
      onSelectionChange={(k) => {
        const premier = [...k][0];
        if (typeof premier === 'string') onSelectionChange(premier as FolderSelection);
      }}
      className="uui flex flex-col gap-0.5 outline-hidden"
    >
      {rendre}
    </AriaTree>
  );
}

export default FolderTree;
