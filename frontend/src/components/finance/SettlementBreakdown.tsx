/**
 * BRUT · FRAIS · NET — la lecture d'un encaissement, en trois lignes (L13).
 *
 * ══ CE QUE CE COMPOSANT NE FAIT JAMAIS ══════════════════════════════════════
 *
 * Il ne remplace pas le montant du mouvement. Le « Brut » qu'il affiche EST le
 * montant de la ligne — la même valeur, répétée pour que la soustraction se
 * lise. Le jour où le net prendrait la place du brut dans la colonne Montant,
 * le chiffre d'affaires du Panel cesserait d'être celui des factures émises.
 *
 * ══ « EN COURS DE RÉCUPÉRATION » N'EST PAS « 0,00 € » ═══════════════════════
 *
 * C'est la décision d'affichage la plus importante du lot. Un frais inconnu et
 * un frais nul se ressemblent dans une colonne, et sont opposés dans un bilan :
 *
 *   · `0,00 €` affirme que le fournisseur n'a rien prélevé — quelqu'un lira ce
 *     chiffre, le croira, et ne reviendra jamais vérifier ;
 *   · « en cours de récupération » dit qu'on ne sait pas ENCORE, et invite à
 *     revenir.
 *
 * Le serveur distingue déjà les deux (`status` contre `providerCostCents`) ;
 * cet écran se contente de ne pas les reconfondre.
 *
 * ══ IL NE NOMME AUCUN FOURNISSEUR PAR DÉFAUT ═══════════════════════════════
 *
 * « Frais », pas « Frais Stripe ». Le nom du fournisseur est une VALEUR portée
 * par la donnée, affichée dans le détail où il fait sens — pas une constante de
 * ce fichier. Un second PSP n'obligera donc pas à rouvrir ce composant.
 */
import { formatCents } from '@/lib/money';
import type { TransactionSettlement } from '@/types.finance';

/** La phrase d'attente, écrite une fois. Jamais un montant. */
export const FRAIS_EN_ATTENTE = 'Frais en cours de récupération';

/**
 * Ce que l'on peut dire d'un encaissement, en une expression.
 *
 * `UNAVAILABLE` et `UNUSABLE` ne sont pas des attentes : ce sont des verdicts,
 * et les afficher comme « en cours » ferait espérer un chiffre qui ne viendra
 * pas. Ils se lisent « non applicable », et le détail en donne le motif.
 */
function attente(settlement: TransactionSettlement): string {
  if (settlement.status === 'PENDING') return FRAIS_EN_ATTENTE;
  return 'Frais non communiqués par le fournisseur';
}

/**
 * LES TROIS LIBELLÉS DÉPENDENT DU SENS, ET C'EST TOUT SAUF COSMÉTIQUE.
 *
 * Sur un ENCAISSEMENT, le fournisseur RETIENT sa commission : le compte reçoit
 * `brut − frais`. Sur un REMBOURSEMENT, il la PRÉLÈVE EN PLUS de la somme
 * rendue : le compte perd `rendu + frais`.
 *
 * Écrire « Brut / Frais / Net » sur une sortie d'argent était doublement faux :
 * « Net 120,00 € » se lit comme une recette, et la soustraction sous-évaluait
 * ce qui a réellement quitté le compte. La recette déployée l'a montré sur un
 * remboursement réel.
 */
const LIBELLES = {
  IN: { montant: 'Brut', frais: 'Frais', resultat: 'Net' },
  OUT: { montant: 'Rendu', frais: 'Frais', resultat: 'Sorti du compte' },
} as const;

export function SettlementBreakdown({
  settlement,
  compact = false,
}: {
  settlement: TransactionSettlement;
  compact?: boolean;
}) {
  const solde = settlement.status === 'SETTLED' && settlement.providerCostCents !== null;

  if (!solde) {
    return (
      <div className="finance-settlement finance-settlement-pending">
        <span className="finance-settlement-note">{attente(settlement)}</span>
      </div>
    );
  }

  const frais = settlement.providerCostCents as number;

  /**
   * UNE DÉCOMPOSITION QUI NE DÉCOMPOSE RIEN N'EST PAS UNE INFORMATION.
   *
   * Frais nul : le montant du mouvement, déjà affiché juste au-dessus, dit tout.
   * Répéter « Brut 120 · Frais −0,00 € · Net 120 » ajoute trois lignes qui ne
   * disent rien — et surtout, ce « −0,00 € » est exactement le zéro que la
   * doctrine du lot interdit d'écrire, parce qu'il est indiscernable d'un frais
   * qu'on n'aurait pas su lire.
   *
   * Le fait qu'il soit CONNU et nul se lit, lui, dans le détail du mouvement.
   */
  if (frais === 0) return null;

  const mots = LIBELLES[settlement.direction ?? 'IN'];

  return (
    <div className={compact ? 'finance-settlement finance-settlement-compact' : 'finance-settlement'}>
      <span className="finance-settlement-line">
        <span className="finance-settlement-label">{mots.montant}</span>
        <span className="finance-settlement-value">{formatCents(settlement.grossCents)}</span>
      </span>
      <span className="finance-settlement-line">
        <span className="finance-settlement-label">{mots.frais}</span>
        {/*
          LE SIGNE EST ÉCRIT ICI, ET SEULEMENT ICI.

          Le montant persisté est positif — la doctrine du registre veut que le
          sens soit porté par le flux, jamais par un signe. Mais dans CETTE
          soustraction, le lecteur a besoin de voir que la commission se
          retranche : « 2,15 € » entre un brut et un net se lit comme une
          addition. Le moins typographique (U+2212) s'aligne sur les chiffres.
        */}
        <span className="finance-settlement-value finance-amount-outflow">
          {`${settlement.direction === 'OUT' ? '+' : '−'}${formatCents(frais)}`}
        </span>
      </span>
      <span className="finance-settlement-line finance-settlement-net">
        <span className="finance-settlement-label">{mots.resultat}</span>
        <span className="finance-settlement-value">{formatCents(settlement.netCents)}</span>
      </span>
    </div>
  );
}

export default SettlementBreakdown;
