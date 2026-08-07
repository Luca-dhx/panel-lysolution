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

export function usePanelBranding(): PanelBranding {
  const [branding, setBranding] = useState<PanelBranding>({
    logoUrl: null, companyName: null, loading: true,
  });

  useEffect(() => {
    let annule = false;
    company.current()
      .then((state) => {
        if (annule) return;
        setBranding({
          /**
           * L'aperçu résolu par le SERVEUR d'abord — lui seul sait si le média
           * est servi par une destination active. L'URL publiée ensuite, pour
           * une fiche antérieure au descripteur.
           */
          logoUrl: logoAffichable(state.media?.['branding.logo']?.url)
            ?? logoAffichable(state.company?.branding?.logoUrl),
          companyName: state.company?.identity?.name?.trim() || null,
          loading: false,
        });
      })
      // Une fiche indisponible n'empêche pas de travailler : on retombe sur
      // « Panel », qui est vrai dans tous les cas.
      .catch(() => { if (!annule) setBranding({ logoUrl: null, companyName: null, loading: false }); });
    return () => { annule = true; };
  }, []);

  return branding;
}

export default usePanelBranding;
