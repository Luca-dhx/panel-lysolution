/**
 * LE FAVICON DU PANEL — celui que l'agence a configuré dans « Mon entreprise ».
 *
 * ── LE DÉFAUT QUE CE MODULE FERME ───────────────────────────────────────────
 * Le favicon se saisissait, se téléversait, se validait, se résolvait contre
 * une destination active, et partait sur le pont vers chaque projet. Puis rien.
 * Aucun écran ne le lisait : `index.html` ne déclarait aucun `<link rel="icon">`,
 * et le Panel s'affichait sous l'icône par défaut du navigateur. Le champ
 * décrivait une intention que le produit n'honorait nulle part.
 *
 * L'onglet du Panel est le lieu ÉVIDENT de cette image : c'est l'outil de
 * l'agence, et c'est l'identité de l'agence qu'on y configure.
 *
 * ── POURQUOI À L'EXÉCUTION, ET PAS DANS `index.html` ────────────────────────
 * Le favicon n'est pas connu à la construction : il dépend de la fiche
 * entreprise, qui change sans redéploiement. Une adresse figée dans le HTML
 * serait fausse dès le premier remplacement d'image. On le pose donc au
 * démarrage, exactement comme le thème — même pattern, même endroit
 * (`App.tsx`), même tolérance à la panne.
 *
 * ── AUCUNE ADRESSE FABRIQUÉE ────────────────────────────────────────────────
 * On n'utilise QUE ce que le serveur a déjà résolu (`media['branding.favicon']`,
 * ou l'URL publiée). Recomposer un domaine et un chemin ici ferait un second
 * producteur d'adresses, qui finirait par diverger de `resolvePanelMediaUrl`.
 * Sans favicon configuré, on ne touche à rien : l'icône par défaut du
 * navigateur reste, ce qui vaut mieux qu'un lien mort.
 */
import { useEffect } from 'react';
import { company } from '@/lib/api';

/** Pose (ou remplace) le `<link rel="icon">` du document. */
function applyFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  // Remplacer le favicon change sa clé d'objet, donc son adresse : aucune
  // ancienne icône ne peut réapparaître depuis le cache, et aucun paramètre
  // anti-cache n'est nécessaire.
  if (link.href !== href) link.href = href;
}

export function useFaviconLoader(): void {
  useEffect(() => {
    let annule = false;
    company.current()
      .then((state) => {
        if (annule) return;
        /**
         * L'aperçu résolu par le serveur d'abord — c'est lui qui sait si le
         * média est SERVI par une destination active. L'URL publiée ensuite,
         * pour une fiche antérieure au descripteur. Un chemin de stockage nu
         * (`/uploads/…`) n'est pas retenu : il ne s'affiche que par chance,
         * quand le Panel sert lui-même ses fichiers.
         */
        const href = state.media?.['branding.favicon']?.url
          ?? state.company?.branding?.faviconUrl
          ?? null;
        if (href) applyFavicon(href);
      })
      // Une fiche indisponible n'empêche pas de travailler : on garde l'icône
      // par défaut plutôt que d'afficher une image cassée.
      .catch(() => {});
    return () => { annule = true; };
  }, []);
}

export default useFaviconLoader;
