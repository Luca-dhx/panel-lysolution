/**
 * LA MARQUE DU PANEL — ce que la barre latérale affiche en haut.
 *
 * ── CE QU'IL Y AVAIT ────────────────────────────────────────────────────────
 * Un titre écrit en dur : « Panel L.Y Solution ». Le nom de l'agence était
 * saisi dans « Mon entreprise », son logo téléversé, résolu, publié aux
 * projets — et l'écran qui la représente le plus, sa propre barre latérale,
 * n'en lisait rien. Un produit qui affiche une marque codée en dur ne peut
 * pas être livré à une autre agence.
 *
 * ── AUCUNE SECONDE SOURCE ───────────────────────────────────────────────────
 * Ce module lit la MÊME fiche entreprise que le favicon, par le même appel,
 * et n'utilise QUE des adresses déjà résolues par le serveur
 * (`media['branding.logo']`). Recomposer un domaine et un chemin ici créerait
 * un second producteur d'adresses, qui finirait par diverger de
 * `resolvePanelMediaUrl` — exactement le défaut que l'autorité média a fermé.
 *
 * ── LE « LOGO SOMBRE » N'EXISTE PLUS ────────────────────────────────────────
 * Il a été retiré du produit : plus d'écran, plus de champ. On ne le
 * réintroduit pas par la bande sous prétexte de thème. Un seul logo, et il
 * doit rester lisible sur le fond de la barre.
 */
import { useEffect, useState } from 'react';
import { company } from '@/lib/api';

export interface PanelBranding {
  /** Adresse du logo, résolue par le serveur. `null` = aucun logo exploitable. */
  logoUrl: string | null;
  /** Raison sociale ou nom d'usage de l'agence. `null` = fiche non renseignée. */
  companyName: string | null;
  /** Vrai tant que la fiche n'a pas répondu — évite un titre qui clignote. */
  loading: boolean;
}

/**
 * LE LIBELLÉ DE REPLI — fonction PURE, testable sans monter React.
 *
 * Trois cas, et un seul est ambigu si on ne l'écrit pas : une agence dont on
 * connaît le nom mérite de le voir ; une installation neuve, pas encore
 * configurée, doit dire « Panel » et non « Panel null ».
 */
export function panelTitleFor(companyName: string | null | undefined): string {
  const nom = String(companyName ?? '').trim();
  return nom ? `Panel ${nom}` : 'Panel';
}

/**
 * Une adresse d'image AFFICHABLE — absolue, jamais un chemin de stockage nu.
 *
 * `/uploads/…` ne s'affiche que par chance, quand le Panel sert lui-même ses
 * fichiers. On préfère le repli textuel à une image cassée.
 */
function logoAffichable(url: string | null | undefined): string | null {
  const brut = String(url ?? '').trim();
  return /^https?:\/\//i.test(brut) ? brut : null;
}

/**
 * LA DERNIÈRE MARQUE CONNUE — pour peindre AVANT le premier aller-retour.
 *
 * ══ LE DÉFAUT QUE CE CACHE FERME ════════════════════════════════════════════
 *
 * La marque n'est connue qu'après `GET /api/company`. À chaque rechargement,
 * la barre latérale affichait donc « Panel » (le repli), puis basculait sur le
 * logo une fois la réponse arrivée. Un saut visible à chaque F5, sur l'élément
 * le plus stable de l'écran.
 *
 * ══ POURQUOI UN CACHE EST LÉGITIME ICI ══════════════════════════════════════
 *
 * Ce sont deux valeurs PUBLIQUES et lentes à changer : le nom de l'agence et
 * l'adresse de son logo. Aucun secret, aucune donnée client. Et l'adresse
 * porte l'empreinte du contenu — un logo remplacé a une autre adresse — donc
 * une valeur en cache ne peut jamais afficher une ancienne image sous une
 * adresse actuelle.
 *
 * ══ LE CACHE N'EST JAMAIS L'AUTORITÉ ════════════════════════════════════════
 *
 * Il sert le PREMIER rendu ; la requête part quand même, et sa réponse écrase
 * ce qu'on avait peint. Un logo retiré du Panel disparaît donc au chargement
 * suivant. En cas de panne de la fiche, on garde ce qu'on savait plutôt que
 * de faire clignoter la marque vers « Panel ».
 */
const CACHE_KEY = 'panel.branding';

function lireCache(): { logoUrl: string | null; companyName: string | null } | null {
  try {
    const brut = window.localStorage.getItem(CACHE_KEY);
    if (!brut) return null;
    const v = JSON.parse(brut);
    // On revalide la forme : une valeur corrompue ne doit pas casser l'écran.
    return {
      logoUrl: logoAffichable(v?.logoUrl),
      companyName: typeof v?.companyName === 'string' ? v.companyName : null,
    };
  } catch {
    return null;
  }
}

function ecrireCache(valeur: { logoUrl: string | null; companyName: string | null }): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(valeur));
  } catch {
    // Stockage indisponible (navigation privée, quota) : le cache est un
    // confort, jamais une dépendance. On continue sans lui.
  }
}

export function usePanelBranding(): PanelBranding {
  /**
   * L'ÉTAT INITIAL EST DÉJÀ LA DERNIÈRE MARQUE CONNUE — pas un vide.
   *
   * Le premier rendu peint donc le logo, sans attendre le réseau. `loading`
   * reste vrai : la requête est en cours, et ce qu'on affiche est une mémoire,
   * pas encore un constat.
   */
  const [branding, setBranding] = useState<PanelBranding>(() => {
    const cache = lireCache();
    return {
      logoUrl: cache?.logoUrl ?? null,
      companyName: cache?.companyName ?? null,
      loading: true,
    };
  });

  useEffect(() => {
    let annule = false;
    company.current()
      .then((state) => {
        if (annule) return;
        /**
         * L'aperçu résolu par le SERVEUR d'abord — lui seul sait si le média
         * est servi par une destination active. L'URL publiée ensuite, pour
         * une fiche antérieure au descripteur.
         */
        const frais = {
          logoUrl: logoAffichable(state.media?.['branding.logo']?.url)
            ?? logoAffichable(state.company?.branding?.logoUrl),
          companyName: state.company?.identity?.name?.trim() || null,
        };
        // La réponse fait autorité : elle écrase le cache, y compris pour
        // retirer un logo qui n'existe plus.
        ecrireCache(frais);
        setBranding({ ...frais, loading: false });
      })
      /**
       * Fiche indisponible : on GARDE ce qu'on avait peint. Retomber sur
       * « Panel » ferait clignoter la marque à chaque hoquet du réseau, alors
       * que la dernière valeur connue reste la meilleure réponse disponible.
       */
      .catch(() => { if (!annule) setBranding((p) => ({ ...p, loading: false })); });
    return () => { annule = true; };
  }, []);

  return branding;
}

export default usePanelBranding;
