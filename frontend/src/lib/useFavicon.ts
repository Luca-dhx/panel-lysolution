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
import { loadPublicBranding } from '@/lib/publicBranding';

export function useFaviconLoader(): void {
  /**
   * ── PLUS AUCUNE REQUÊTE PROPRE ────────────────────────────────────────────
   *
   * Ce chargeur appelait `GET /api/company` — une surface AUTHENTIFIÉE — pour
   * la seule adresse du favicon. Trois conséquences : un appel de plus au
   * montage, un favicon absent avant login, et une seconde primitive de pose
   * du `<link rel="icon">` à maintenir.
   *
   * Le favicon arrive désormais avec le reste de la marque
   * (`/api/public/branding`), et `applyFavicon` est la SEULE primitive qui
   * touche le document — appelée depuis le cache avant le premier rendu, puis
   * depuis la réponse réseau.
   *
   * Ce hook subsiste pour ne pas disperser l'ordre d'amorçage dans `App` : il
   * déclenche le même chargement, idempotent, que `useThemeLoader`.
   */
  useEffect(() => {
    void loadPublicBranding();
  }, []);
}

export default useFaviconLoader;
