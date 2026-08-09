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
import { lireCacheBranding, loadPublicBranding } from '@/lib/publicBranding';

export interface PanelBranding {
  /** Adresse du logo, résolue par le serveur. `null` = aucun logo exploitable. */
  logoUrl: string | null;
  /** Raison sociale ou nom d'usage de l'agence. `null` = fiche non renseignée. */
  companyName: string | null;
  /** Vrai tant que la fiche n'a pas répondu — évite un titre qui clignote. */
  loading: boolean;
}

/**
 * LE LIBELLÉ DE REPLI — défini UNE fois, avec la source publique.
 *
 * Réexporté ici pour les importateurs existants. Deux définitions de la même
 * règle finiraient par diverger, et deux écrans nommeraient le produit
 * différemment — ce qui donne l'impression de deux produits.
 */
export { panelTitleFor } from '@/lib/publicBranding';

/**
 * LA RÈGLE D'ADRESSE A DÉMÉNAGÉ elle aussi, dans `lib/publicBranding.ts`.
 *
 * `/uploads/…` ne s'affiche que par chance, quand le Panel sert lui-même ses
 * fichiers : on préfère le repli textuel à une image cassée. La règle est
 * appliquée à la SOURCE, une fois, plutôt que par chaque consommateur.
 */

/**
 * LE CACHE A DÉMÉNAGÉ dans `lib/publicBranding.ts`, avec la source qu'il sert.
 *
 * Il y peint désormais AVANT que React ne monte, et couvre aussi le thème et le
 * favicon. Le garder ici en aurait fait un second cache de la même marque.
 *
 * ── CE QU'IL ÉTAIT, ET POURQUOI IL RESTE LÉGITIME ──────────────────────────
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
export function usePanelBranding(): PanelBranding {
  /**
   * L'ÉTAT INITIAL EST DÉJÀ LA DERNIÈRE MARQUE CONNUE — pas un vide.
   *
   * Le premier rendu peint donc le logo, sans attendre le réseau. `loading`
   * reste vrai : la requête est en cours, et ce qu'on affiche est une mémoire,
   * pas encore un constat.
   */
  const [branding, setBranding] = useState<PanelBranding>(() => {
    const cache = lireCacheBranding();
    return {
      logoUrl: cache.logoUrl,
      companyName: cache.companyName,
      loading: true,
    };
  });

  useEffect(() => {
    let annule = false;
    /**
     * ── UNE SEULE SOURCE, ET ELLE EST PUBLIQUE ────────────────────────────
     *
     * Ce hook lisait `GET /api/company` — une surface AUTHENTIFIÉE. La barre
     * latérale ne s'affiche qu'après login, cela fonctionnait donc ; mais
     * l'écran de connexion, lui, ne pouvait rien en tirer, et le titre y était
     * écrit en dur.
     *
     * La marque vient désormais de `/api/public/branding` : la MÊME fiche
     * entreprise, restreinte à ce qui est public par nature. Un seul appel
     * sert les deux côtés de l'authentification, et personne n'a deux vérités
     * à réconcilier.
     */
    void loadPublicBranding().then((frais) => {
      if (annule || !frais) return;
      setBranding({
        logoUrl: frais.logoUrl,
        companyName: frais.companyName,
        loading: false,
      });
    }).finally(() => {
      /**
       * Marque indisponible : on GARDE ce qu'on avait peint. Retomber sur
       * « Panel » ferait clignoter la marque à chaque hoquet du réseau, alors
       * que la dernière valeur connue reste la meilleure réponse disponible.
       */
      if (!annule) setBranding((b) => ({ ...b, loading: false }));
    });
    return () => { annule = true; };
  }, []);

  return branding;
}
