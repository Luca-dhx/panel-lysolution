/**
 * QUAND LE GRAPHIQUE NE PEUT PAS S'AFFICHER.
 *
 * ══ LE CAS QUE CE COMPOSANT COUVRE ══════════════════════════════════════════
 *
 * Les graphiques Bklit sont chargés à la demande : visx, d3 et motion pèsent
 * environ 200 ko, et les quinze écrans du Panel qui n'affichent aucun graphique
 * n'ont pas à les télécharger. Ce fractionnement a une contrepartie : le
 * fragment peut ne pas arriver.
 *
 *   · une coupure réseau au moment précis de la navigation ;
 *   · un déploiement pendant qu'un onglet est resté ouvert — les fragments de
 *     l'ancienne version portent une empreinte de contenu, et ils ont disparu ;
 *   · un cache intermédiaire qui rend un fichier tronqué.
 *
 * Sans frontière d'erreur, `Suspense` laisse l'exception remonter : React
 * démonte l'arbre, et l'écran FINANCIER ENTIER devient blanc. Les chiffres, les
 * filtres et le registre — qui n'ont rien demandé au graphique — disparaissent
 * avec lui.
 *
 * ══ POURQUOI UN REPLI PLUTÔT QU'UN MESSAGE ══════════════════════════════════
 *
 * `NetChart` est le tracé maison d'avant la refonte : un SVG écrit à la main,
 * SANS aucune dépendance externe. Il vit donc dans le paquet principal, celui
 * qui est déjà là. Il montre moins que le graphique composé — le net seul, pas
 * les trois séries — mais il montre quelque chose de vrai, tout de suite, sur
 * exactement les mêmes données.
 *
 * C'est aussi ce qui garde son module de calcul (`lib/netChartScale`) vivant et
 * utile : il porte une arithmétique éprouvée — valeurs négatives, séries
 * plates, espacement des étiquettes — qu'il aurait été dommage de perdre en
 * même temps que le composant.
 *
 * ── LA FRONTIÈRE EST UNE CLASSE, ET IL N'Y A PAS D'ALTERNATIVE ──────────────
 * React n'expose `componentDidCatch` que sur une classe. C'est le seul endroit
 * du frontend qui en emploie une, et c'est pour cette raison-là.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { NetChart } from '@/components/finance/NetChart';
import type { FinancePeriod, FinanceSeriesPoint } from '@/types.finance';

interface Props {
  children: ReactNode;
  series: FinanceSeriesPoint[];
  period: FinancePeriod;
}

interface State {
  tombe: boolean;
}

export class ChartBoundary extends Component<Props, State> {
  state: State = { tombe: false };

  static getDerivedStateFromError(): State {
    return { tombe: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    /**
     * ON TRACE, ON N'ALERTE PAS.
     *
     * L'utilisateur voit déjà un tracé — le repli. Lui pousser en plus une
     * erreur ferait passer une dégradation invisible pour une panne. La console
     * du navigateur, elle, doit garder de quoi diagnostiquer : sans cette
     * ligne, un fragment manquant en production serait indétectable.
     */
    // eslint-disable-next-line no-console
    console.error('[finances] le graphique détaillé n’a pas pu être chargé', error, info);
  }

  render(): ReactNode {
    if (!this.state.tombe) return this.props.children;

    return (
      <div className="uui">
        <NetChart series={this.props.series} period={this.props.period} />
        <p className="mt-2 text-xs text-quaternary">
          Le graphique détaillé n’a pas pu être chargé. Le bénéfice net reste
          affiché ci-dessus, sur les mêmes données. Rechargez la page pour
          réessayer.
        </p>
      </div>
    );
  }
}

export default ChartBoundary;
