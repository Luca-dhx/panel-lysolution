/**
 * LA RÉCURRENCE D'UN ABONNEMENT PROJETÉ — lecture, et rien que lecture.
 *
 * ══ POURQUOI CE MODULE N'EST PAS `finance/recurrence.js` ════════════════════
 *
 * Les deux parlent la même FORME — `{ unit, interval }` — et c'est voulu : deux
 * grammaires de périodicité dans un même Panel finiraient par afficher deux
 * phrases différentes pour la même réalité. Mais ils ne font pas le même
 * métier, et les fondre aurait été une erreur :
 *
 *   · `finance/recurrence.js` VALIDE une saisie et CALCULE des échéances. Il
 *     connaît `DAY`, refuse ce qui est invalide, et progresse sur le calendrier
 *     d'Europe/Paris. C'est un moteur.
 *
 *   · celui-ci LIT une projection reçue d'un projet. Il ne valide rien — la
 *     validation a eu lieu à la frontière (`bridgeContract`) — et ne calcule
 *     aucune date : l'échéancier d'un abonnement est tenu par Stripe, pas ici.
 *
 * ══ IL NE LÈVE JAMAIS ═══════════════════════════════════════════════════════
 *
 * Un contrat déjà projeté ne doit pas rendre un écran inutilisable parce que sa
 * périodicité est ancienne ou absente. La priorité de lecture est fixe :
 *
 *     1. `recurrence` complet          il fait foi
 *     2. `interval` hérité (MONTH|YEAR) « tous les 1 <unité> »
 *     3. rien d'exploitable            `null` — et le null est DIT, pas comblé
 *
 * Le troisième cas rend `null` et non « tous les mois » : supposer une
 * périodicité, c'est décider à la place du contrat de la fréquence à laquelle
 * un client sera débité. L'appelant choisit alors ce qu'il fait de ce silence —
 * l'écran l'affiche en tiret, le tarif Stripe REFUSE.
 */

const UNITS = Object.freeze(['MONTH', 'YEAR']);

/**
 * La récurrence effective d'une ligne d'abonnement projetée.
 * @param {object|null|undefined} line `pricing.subscription` de la projection
 * @returns {{unit:string, interval:number}|null}
 */
export function readRecurrence(line) {
  const unit = String(line?.recurrence?.unit ?? '').trim().toUpperCase();
  const interval = Number(line?.recurrence?.interval);
  if (UNITS.includes(unit) && Number.isInteger(interval) && interval >= 1) {
    return { unit, interval };
  }

  const herite = String(line?.interval ?? '').trim().toUpperCase();
  if (UNITS.includes(herite)) return { unit: herite, interval: 1 };

  return null;
}

/**
 * L'étiquette française — « Tous les 3 mois », « Tous les ans ».
 *
 * Le projet en publie déjà une (`recurrenceLabel`) et on la préfère quand elle
 * est là : c'est la même donnée dite par celui qui la détient. On sait toutefois
 * la reconstruire, pour les projections antérieures qui ne la portent pas.
 */
export function describeRecurrence(recurrence) {
  if (!recurrence) return null;
  const { unit, interval } = recurrence;
  const annee = unit === 'YEAR';
  if (interval === 1) return annee ? 'Tous les ans' : 'Tous les mois';
  return annee ? `Tous les ${interval} ans` : `Tous les ${interval} mois`;
}

/** Le libellé publié par le projet, ou celui qu'on reconstruit. */
export function recurrenceLabelOf(line) {
  const publie = typeof line?.recurrenceLabel === 'string' ? line.recurrenceLabel.trim() : '';
  return publie || describeRecurrence(readRecurrence(line));
}

/**
 * `MONTH + 3` → `{ interval: 'month', interval_count: 3 }`.
 * Traduction mécanique vers Stripe — aucun plan prédéfini.
 */
export function toStripeRecurring(recurrence) {
  return {
    interval: recurrence.unit === 'YEAR' ? 'year' : 'month',
    interval_count: recurrence.interval,
  };
}

export default { readRecurrence, describeRecurrence, recurrenceLabelOf, toStripeRecurring };
