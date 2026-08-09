/**
 * LA MARQUE DU PANEL, AVANT TOUTE SESSION — une source, un cache, un applicateur.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * Trois données peignent l'identité du Panel : son nom, son logo, son thème.
 * Toutes trois vivaient derrière `requirePanelUser`. `useThemeLoader()` partait
 * pourtant dès le montage de l'application — donc AVANT le login — recevait un
 * 401, et l'erreur était avalée par un `.catch(() => {})`.
 *
 * L'écran de connexion restait donc sur les couleurs par défaut, avec un titre
 * « Panel L.Y Solution » écrit en dur : une marque qui ne peut pas être livrée
 * à une autre agence.
 *
 * ══ POURQUOI UN SEUL MODULE ═════════════════════════════════════════════════
 *
 * Le nom, le logo, le favicon et le thème arrivaient par TROIS appels
 * différents (`/api/company` ×2, `/api/theme`), tous authentifiés, tous
 * déclenchés au montage. Ils décrivent pourtant la même chose. Une seule
 * requête publique les remplace, et un seul endroit les applique.
 *
 * ══ LE CACHE N'EST JAMAIS L'AUTORITÉ ════════════════════════════════════════
 *
 * Il sert le PREMIER rendu, avant même que React ne monte : sans lui, l'écran
 * peint les couleurs par défaut puis se repeint une fois la réponse arrivée —
 * un flash à chaque chargement, sur l'élément le plus stable de l'interface.
 *
 * La requête part quand même, et sa réponse écrase ce qu'on avait peint. Un
 * logo retiré disparaît donc au chargement suivant. En cas de panne, on garde
 * ce qu'on savait plutôt que de faire clignoter la marque vers « Panel ».
 *
 * Ce sont des valeurs PUBLIQUES et lentes à changer : aucun secret, aucune
 * donnée client. Les mettre en cache n'expose rien de plus que l'écran
 * lui-même.
 */
import { request } from '@/lib/api';
import { applyTheme, type PanelTheme } from '@/lib/useTheme';

export interface PublicBranding {
  companyName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  theme: PanelTheme | null;
}

const CACHE_KEY = 'panel.branding';

const VIDE: PublicBranding = {
  companyName: null, logoUrl: null, faviconUrl: null, theme: null,
};

/**
 * Une adresse AFFICHABLE, ou rien. Un chemin de stockage nu (`/uploads/…`) ne
 * s'affiche que par chance, quand le Panel sert lui-même ses fichiers : on
 * préfère le repli textuel à une image cassée.
 */
function adresseAffichable(url: unknown): string | null {
  const brut = String(url ?? '').trim();
  return /^https?:\/\//i.test(brut) ? brut : null;
}

export function lireCacheBranding(): PublicBranding {
  try {
    const brut = window.localStorage.getItem(CACHE_KEY);
    if (!brut) return VIDE;
    const v = JSON.parse(brut);
    // On revalide la FORME : une valeur corrompue ne doit pas casser l'écran.
    return {
      companyName: typeof v?.companyName === 'string' ? v.companyName : null,
      logoUrl: adresseAffichable(v?.logoUrl),
      faviconUrl: adresseAffichable(v?.faviconUrl),
      theme: v?.theme ?? null,
    };
  } catch {
    return VIDE;
  }
}

function ecrireCache(valeur: PublicBranding): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(valeur));
  } catch {
    // Stockage indisponible (navigation privée, quota) : le cache est un
    // confort, jamais une dépendance. On continue sans lui.
  }
}

/** Pose (ou remplace) le `<link rel="icon">` — LA seule primitive du produit. */
export function applyFavicon(href: string | null): void {
  if (!href) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

/**
 * PEINT CE QU'ON SAIT DÉJÀ — synchrone, AVANT que React ne monte.
 *
 * Appelée depuis `main.tsx`. C'est ce qui supprime le flash : le document porte
 * déjà les bonnes variables CSS et le bon favicon quand le premier rendu a
 * lieu. Sans réseau, sans attente, sans écran de chargement.
 */
export function applyCachedBranding(): PublicBranding {
  const cache = lireCacheBranding();
  if (cache.theme) applyTheme(cache.theme);
  applyFavicon(cache.faviconUrl);
  return cache;
}

/**
 * VA CHERCHER LA VÉRITÉ, ET L'APPLIQUE.
 *
 * Ne lève jamais : un Panel dont la marque n'est pas joignable doit afficher
 * son formulaire de connexion, pas une erreur. On garde alors ce que le cache
 * avait peint — la meilleure réponse disponible.
 *
 * Aucune reprise automatique : un échec ici ne se réessaie pas en boucle. Le
 * prochain chargement suffira, et une identité visuelle ne justifie pas de
 * marteler un serveur en difficulté.
 */
export async function loadPublicBranding(): Promise<PublicBranding | null> {
  try {
    const data = await request<PublicBranding>('/api/public/branding');
    const frais: PublicBranding = {
      companyName: String(data?.companyName ?? '').trim() || null,
      logoUrl: adresseAffichable(data?.logoUrl),
      faviconUrl: adresseAffichable(data?.faviconUrl),
      theme: data?.theme ?? null,
    };
    // LA RÉPONSE FAIT AUTORITÉ : elle écrase le cache, y compris pour RETIRER
    // un logo qui n'existe plus.
    ecrireCache(frais);
    if (frais.theme) applyTheme(frais.theme);
    applyFavicon(frais.faviconUrl);
    return frais;
  } catch {
    return null;
  }
}

/**
 * LE LIBELLÉ DE REPLI — fonction PURE, testable sans monter React.
 *
 * Trois cas, et un seul est ambigu si on ne l'écrit pas : une agence dont on
 * connaît le nom mérite de le voir ; une installation neuve, pas encore
 * configurée, doit dire « Panel » et non « Panel null ».
 *
 * C'est la MÊME doctrine que la barre latérale, et c'est volontaire : deux
 * écrans qui nomment le produit différemment donneraient l'impression de deux
 * produits.
 */
export function panelTitleFor(companyName: string | null | undefined): string {
  const nom = String(companyName ?? '').trim();
  return nom ? `Panel ${nom}` : 'Panel';
}

export default { applyCachedBranding, loadPublicBranding, panelTitleFor, applyFavicon };
