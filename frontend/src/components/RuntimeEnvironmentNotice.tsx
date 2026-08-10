// LE MONDE FOURNISSEUR, ANNONCÉ — jamais proposé (lot L2.1).
//
// ── POURQUOI UN COMPOSANT, ET PAS TROIS LIGNES RECOPIÉES ────────────────────
//
// Deux écrans doivent dire la même chose : le plan de contrôle et l'ancien
// coffre. Recopier la phrase, c'est accepter qu'un jour l'une des deux dise
// autre chose — et c'est précisément ce désaccord qui a produit la doctrine
// qu'on vient de révoquer.
//
// ── CE QU'IL AFFICHE, ET DANS CET ORDRE ─────────────────────────────────────
//
//   Environnement runtime      : TEST
//   Mode fournisseur utilisé   : TEST
//   Source                     : environnement de l'instance
//
// La troisième ligne est la plus importante. Sans elle, un lecteur peut croire
// que les deux premières sont deux réglages qui se trouvent coïncider. Elle dit
// que la seconde DÉCOULE de la première, et qu'il n'y a rien à choisir.
import { useEffect, useState } from 'react';

import { integratedApis } from '@/lib/api';
import type { IntegratedApiEnvironment } from '@/types.integratedApi';

interface Routage {
  runtime: IntegratedApiEnvironment;
  /** `null` pour un parc entièrement `PANEL_GLOBAL` — cas théorique. */
  provider: IntegratedApiEnvironment | null;
  /** Fournisseurs sans monde : on ne leur en invente pas un. */
  globaux: string[];
}

export function RuntimeEnvironmentNotice() {
  const [routage, setRoutage] = useState<Routage | null>(null);

  useEffect(() => {
    let vivant = true;
    void (async () => {
      try {
        const { items } = await integratedApis.list();
        if (!vivant || items.length === 0) return;
        const parEnvironnement = items.filter((i) => i.definition.scope === 'ENVIRONMENT');
        setRoutage({
          runtime: items[0].runtimeEnvironment,
          provider: parEnvironnement[0]?.effectiveEnvironment ?? null,
          globaux: items
            .filter((i) => i.definition.scope === 'PANEL_GLOBAL')
            .map((i) => i.definition.label),
        });
      } catch {
        // Un bandeau d'information ne fait pas échouer un écran : mieux vaut
        // ne rien annoncer qu'annoncer une valeur qu'on n'a pas lue.
      }
    })();
    return () => { vivant = false; };
  }, []);

  if (!routage) return null;

  return (
    <div className={`mode-notice ${routage.runtime === 'PROD' ? 'mode-reel' : 'mode-simulation'}`}>
      <div>Environnement runtime : <strong>{routage.runtime}</strong></div>
      <div>
        Mode fournisseur utilisé :{' '}
        <strong>{routage.provider ?? '—'}</strong>
      </div>
      <div className="muted">Source : environnement de l’instance — aucun réglage ne le change.</div>
      {routage.globaux.length > 0 ? (
        <div className="muted">
          Sans environnement (compte unique) : {routage.globaux.join(', ')}.
        </div>
      ) : null}
    </div>
  );
}

export default RuntimeEnvironmentNotice;
