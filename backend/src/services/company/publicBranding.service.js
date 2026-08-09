/**
 * IDENTITÉ VISUELLE PUBLIQUE DU PANEL — le strict nécessaire, avant session.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * L'écran de connexion ne pouvait pas porter la marque du Panel. Les trois
 * données dont il a besoin — nom, logo, thème — vivaient derrière
 * `requirePanelUser` : `useThemeLoader()` recevait un 401 avant login, et
 * l'erreur était avalée par un `.catch(() => {})`. Le login restait donc sur
 * les couleurs par défaut, avec un titre « Panel L.Y Solution » écrit en dur —
 * c'est-à-dire une marque qui ne peut pas être livrée à une autre agence.
 *
 * ══ « PUBLIC » NE VEUT PAS DIRE « TOUT CE QUI EST DANS LA FICHE » ═══════════
 *
 * Cette surface n'est pas une version non authentifiée de `GET /api/company`.
 * C'est une LISTE BLANCHE, construite champ par champ : ce qu'un visiteur
 * anonyme voit de toute façon en arrivant sur l'écran de connexion — un logo,
 * un nom, des couleurs.
 *
 * Tout le reste de la fiche entreprise — contacts, signataire, références,
 * équipe, versions publiées, état de diffusion aux projets — reste derrière la
 * session. Une liste blanche se relit ; une liste noire s'oublie le jour où un
 * champ s'ajoute.
 *
 * ══ AUCUNE SECONDE SOURCE ══════════════════════════════════════════════════
 *
 * Le nom, le logo et le favicon viennent de la MÊME `PanelCompany` que la barre
 * latérale ; le thème du MÊME service que l'application authentifiée. Ce module
 * ne fait que RESTREINDRE une lecture existante — il n'en invente aucune.
 */
import { getActiveCompany, companyMediaResolution } from './company.service.js';
import { getPanelTheme } from '../theme/panelTheme.service.js';

/**
 * LES CLÉS PUBLIQUES DU THÈME — celles qui peignent, et rien d'autre.
 *
 * Le document de thème porte aussi des champs de persistance (`_id`,
 * horodatages, auteur de la dernière écriture). Ils ne servent à rien pour
 * peindre, et un identifiant technique publié sans raison est un identifiant
 * publié pour toujours.
 */
function themePublic(theme) {
  if (!theme) return null;
  return {
    colors: theme.colors ?? null,
    radius: theme.radius ?? null,
    // Les polices sont appliquées comme les couleurs : sans elles, le login
    // rendrait les bonnes teintes dans la mauvaise typographie — un demi-thème
    // est plus déroutant que pas de thème du tout.
    typography: theme.typography ?? null,
  };
}

/**
 * UNE ADRESSE AFFICHABLE, ou rien.
 *
 * Un chemin de stockage nu (`/uploads/…`) ne s'affiche que par chance, quand le
 * Panel sert lui-même ses fichiers. On préfère le repli textuel à une image
 * cassée — c'est déjà la règle de la barre latérale, et elle vaut ici.
 */
function adresseAffichable(valeur) {
  const brut = String(valeur ?? '').trim();
  return /^https?:\/\//i.test(brut) ? brut : null;
}

/**
 * Ce que l'écran de connexion a le droit de savoir. Ne lève JAMAIS : un Panel
 * dont la fiche n'est pas encore créée doit afficher son formulaire, pas une
 * erreur — c'est précisément l'état d'une installation neuve.
 */
export async function describePublicBranding() {
  let company = null;
  let media = {};
  let theme = null;

  try {
    company = await getActiveCompany();
    if (company) media = await companyMediaResolution(company);
  } catch {
    company = null;
  }

  try {
    theme = await getPanelTheme();
  } catch {
    theme = null;
  }

  /**
   * L'ADRESSE RÉSOLUE PAR LE SERVEUR D'ABORD — c'est lui qui sait si le média
   * est SERVI par une destination active. L'URL publiée ensuite, pour une fiche
   * antérieure au descripteur.
   */
  const logoUrl = adresseAffichable(
    media?.['branding.logo']?.url ?? company?.branding?.logoUrl,
  );
  const faviconUrl = adresseAffichable(
    media?.['branding.favicon']?.url ?? company?.branding?.faviconUrl,
  );
  const companyName = String(company?.identity?.name ?? '').trim() || null;

  return {
    companyName,
    logoUrl,
    faviconUrl,
    theme: themePublic(theme),
  };
}

/**
 * LES SEULES CLÉS QUE CETTE SURFACE PRODUIT — exportée pour être VÉRIFIÉE.
 *
 * Un test compare la réponse à cette liste. Sans elle, la garantie reposerait
 * sur la relecture d'un objet littéral, c'est-à-dire sur l'attention de celui
 * qui ajoutera un champ un jour.
 */
export const PUBLIC_BRANDING_KEYS = Object.freeze([
  'companyName', 'logoUrl', 'faviconUrl', 'theme',
]);

export default { describePublicBranding, PUBLIC_BRANDING_KEYS };
