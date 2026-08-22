/**
 * L10.6B-3 — CE QUE L'ÉCRAN A LE DROIT DE DIRE.
 *
 * ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
 *
 * L'UI affiche, elle ne décide pas. Ni la grâce, ni la cause, ni
 * l'accessibilité ne se recalculent devant l'utilisateur : elles viennent des
 * autorités qui les ont décidées.
 *
 * Ces contrôles portent sur un module PUR. C'est délibéré : la traduction d'un
 * état en phrase est la partie la plus facile à rendre fausse, et la plus
 * difficile à voir. Une échéance reconstruite, un `null` lu comme un zéro, une
 * demande affichée comme un fait — rien de tout cela ne fait planter quoi que
 * ce soit. Cela produit simplement un écran qui ment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, finish, section } from './helpers/harness.js';

const P = await import('../backend/src/services/finance/paymentDefaults/paymentDefaultPresentation.js');
const {
  describeIncidentForDisplay, describePolicyDrift,
  PAYMENT_STATE, GRACE_STATE, CAUSE_STATE, SITE_STATE,
} = P;

/** Un incident, tel que `toPublicPaymentDefault` le rend. */
const incident = (patch = {}) => ({
  paymentDefaultId: 'pd-1',
  projectId: 'atelier-nord',
  contractId: 'ct-1',
  environment: 'TEST',
  status: 'OPEN',
  amountDueCents: 24_900,
  currency: 'EUR',
  invoiceNumber: 'F-2026-0042',
  hostedInvoiceUrl: null,
  invoicePdfUrl: null,
  firstFailedAt: '2026-08-01T10:00:00Z',
  lastFailedAt: null,
  nextPaymentAttemptAt: null,
  attemptCount: 1,
  graceDaysSnapshot: 7,
  graceDeadlineAt: '2026-08-08T10:00:00Z',
  suspensionRequestedAt: null,
  suspensionConfirmedAt: null,
  causeRemovalConfirmedAt: null,
  invoiceId: 'in_123',
  subscriptionId: 'sub_123',
  paymentIntentId: 'pi_123',
  resolvedAt: null,
  ...patch,
});

/** Un instantané de site, tel que le projet le publie. */
const site = ({ accessible, source = 'NONE', technical = false, contract = false, paymentDefault = false }) => ({
  accessible,
  suspensionSource: source,
  causes: { technical, contract, paymentDefault },
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('A. Premier échec — un incident, aucune suspension annoncée');
{
  const v = describeIncidentForDisplay(incident(), { now: '2026-08-02T00:00:00Z' });

  check('le paiement est en échec', v.payment.state === PAYMENT_STATE.FAILED);
  check('…et le titre le dit', v.headline === 'Paiement en échec');
  check('la grâce est EN COURS', v.grace.state === GRACE_STATE.RUNNING);
  check('AUCUNE suspension n’est demandée', v.cause.state === CAUSE_STATE.NONE);
  check('…ni confirmée', v.cause.confirmedAt === null);
  check('le motif est canonique', v.reasonLabel === 'Défaut de paiement');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B. Grâce active — la date affichée est celle du moteur');
{
  const v = describeIncidentForDisplay(incident(), { now: '2026-08-03T00:00:00Z' });

  check('le délai figé est publié', v.grace.graceDaysSnapshot === 7);
  check('L’ÉCHÉANCE EST CELLE DE L’INCIDENT, telle quelle',
    v.grace.graceDeadlineAt === '2026-08-08T10:00:00Z');
  check('…et elle n’est pas encore atteinte', v.grace.state === GRACE_STATE.RUNNING);

  /** Le même incident, plus tard : seule la comparaison change. */
  const apres = describeIncidentForDisplay(incident(), { now: '2026-08-09T00:00:00Z' });
  check('après l’échéance, la grâce est EXPIRÉE', apres.grace.state === GRACE_STATE.EXPIRED);
  check('…mais la date, elle, n’a pas bougé',
    apres.grace.graceDeadlineAt === '2026-08-08T10:00:00Z');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C+D. Les tentatives de Stripe sont observées, jamais promises');
{
  const connue = describeIncidentForDisplay(
    incident({ attemptCount: 2, nextPaymentAttemptAt: '2026-08-05T10:00:00Z' }),
    { now: '2026-08-03T00:00:00Z' },
  );
  check('le nombre de tentatives est celui de Stripe', connue.payment.attemptCount === 2);
  check('la date est publiée telle quelle',
    connue.payment.nextPaymentAttemptAt === '2026-08-05T10:00:00Z');
  check('LA FORMULATION ATTRIBUE LA TENTATIVE À STRIPE',
    connue.payment.nextAttemptLabel === 'Prochaine tentative prévue par Stripe');
  check('…et jamais au Panel', !/nous|Nous/.test(connue.payment.nextAttemptLabel));

  /**
   * DATE ABSENTE ≠ AUCUNE TENTATIVE.
   *
   * Stripe ne l'a pas communiquée, voilà tout. Écrire « aucune tentative
   * prévue » ferait croire au client que plus rien n'arrivera — et il
   * découvrirait un prélèvement le lendemain.
   */
  const inconnue = describeIncidentForDisplay(incident({ nextPaymentAttemptAt: null }), { now: '2026-08-03T00:00:00Z' });
  check('sans date, on dit qu’elle n’est PAS COMMUNIQUÉE',
    inconnue.payment.nextAttemptLabel === 'Prochaine tentative non communiquée');
  check('…et surtout pas qu’il n’y en aura aucune',
    !/aucune tentative/i.test(inconnue.payment.nextAttemptLabel));
  check('aucune date n’est inventée', inconnue.payment.nextPaymentAttemptAt === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('E. Demandée mais pas confirmée — le projet est peut-être hors ligne');
{
  const v = describeIncidentForDisplay(
    incident({ status: 'GRACE_EXPIRED', suspensionRequestedAt: '2026-08-08T10:00:00Z' }),
    { now: '2026-08-09T00:00:00Z' },
  );

  check('LA SUSPENSION EST « EN COURS D’APPLICATION »',
    v.cause.state === CAUSE_STATE.REQUESTED);
  check('…et JAMAIS présentée comme un fait',
    v.cause.label !== 'Site suspendu pour défaut de paiement'
    && v.headline !== 'Site suspendu pour défaut de paiement');
  check('la demande est datée', v.cause.requestedAt === '2026-08-08T10:00:00Z');
  check('…la confirmation ne l’est pas', v.cause.confirmedAt === null);
  check('la cause n’est pas appliquée', v.cause.appliedNow === false);
  check('SANS INSTANTANÉ, L’ÉTAT DU SITE EST « INCONNU »', v.site.state === SITE_STATE.UNKNOWN);
  check('…et surtout pas « accessible »', v.site.accessible === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('F. Le retour du projet confirme');
{
  const v = describeIncidentForDisplay(
    incident({
      status: 'GRACE_EXPIRED',
      suspensionRequestedAt: '2026-08-08T10:00:00Z',
      suspensionConfirmedAt: '2026-08-08T10:05:00Z',
    }),
    {
      now: '2026-08-09T00:00:00Z',
      siteStatus: site({ accessible: false, source: 'PAYMENT_DEFAULT', paymentDefault: true }),
    },
  );

  check('la cause est APPLIQUÉE', v.cause.state === CAUSE_STATE.APPLIED);
  check('…et le titre le dit', v.headline === 'Site suspendu pour défaut de paiement');
  check('les deux dates coexistent',
    v.cause.requestedAt !== null && v.cause.confirmedAt !== null);
  check('…et elles sont DIFFÉRENTES', v.cause.requestedAt !== v.cause.confirmedAt);
  check('le site est suspendu', v.site.state === SITE_STATE.SUSPENDED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('G. LE CAS QUI JUSTIFIE LE LOT — maintenance ET impayé');
{
  const v = describeIncidentForDisplay(
    incident({
      status: 'GRACE_EXPIRED',
      suspensionRequestedAt: '2026-08-08T10:00:00Z',
      suspensionConfirmedAt: '2026-08-08T10:05:00Z',
    }),
    {
      now: '2026-08-09T00:00:00Z',
      siteStatus: site({ accessible: false, source: 'TECHNICAL', technical: true, paymentDefault: true }),
    },
  );

  check('LE DÉFAUT DE PAIEMENT EST APPLIQUÉ', v.cause.state === CAUSE_STATE.APPLIED);
  check('…et la cause est active maintenant', v.cause.appliedNow === true);
  check('LA MAINTENANCE RESTE VISIBLE À CÔTÉ',
    v.site.otherCauses.some((c) => c.key === 'technical'));
  check('…nommée pour un humain',
    v.site.otherCauses.find((c) => c.key === 'technical').label === 'Maintenance technique');
  check('la cause dominante est publiée telle quelle', v.site.dominantSource === 'TECHNICAL');
  check('…mais elle n’a PAS servi de preuve',
    v.cause.state === CAUSE_STATE.APPLIED && v.site.dominantSource !== 'PAYMENT_DEFAULT');
  check('les deux affirmations tiennent EN MÊME TEMPS',
    v.cause.appliedNow === true && v.site.otherCauses.length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('H. Régularisation simple — le site rouvre');
{
  const v = describeIncidentForDisplay(
    incident({
      status: 'RESOLVED',
      suspensionRequestedAt: '2026-08-08T10:00:00Z',
      suspensionConfirmedAt: '2026-08-08T10:05:00Z',
      causeRemovalConfirmedAt: '2026-08-10T09:00:00Z',
      resolvedAt: '2026-08-10T08:00:00Z',
    }),
    { now: '2026-08-11T00:00:00Z', siteStatus: site({ accessible: true }) },
  );

  check('le paiement est régularisé', v.payment.state === PAYMENT_STATE.SETTLED);
  check('la cause est retirée', v.cause.state === CAUSE_STATE.REMOVED);
  check('le site est accessible', v.site.state === SITE_STATE.ACCESSIBLE);
  check('…et aucune autre cause ne subsiste', v.site.otherCauses.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('I. Régularisation SOUS MAINTENANCE — aucun faux badge vert');
{
  const v = describeIncidentForDisplay(
    incident({
      status: 'RESOLVED',
      suspensionRequestedAt: '2026-08-08T10:00:00Z',
      suspensionConfirmedAt: '2026-08-08T10:05:00Z',
      causeRemovalConfirmedAt: '2026-08-10T09:00:00Z',
      resolvedAt: '2026-08-10T08:00:00Z',
    }),
    {
      now: '2026-08-11T00:00:00Z',
      siteStatus: site({ accessible: false, source: 'TECHNICAL', technical: true, paymentDefault: false }),
    },
  );

  /**
   * LES QUATRE DIMENSIONS DISENT QUATRE CHOSES DIFFÉRENTES, ET TOUTES SONT
   * VRAIES. Un badge unique en aurait effacé trois.
   */
  check('paiement        : régularisé', v.payment.state === PAYMENT_STATE.SETTLED);
  check('défaut paiement : retiré', v.cause.state === CAUSE_STATE.REMOVED);
  check('site            : SUSPENDU', v.site.state === SITE_STATE.SUSPENDED);
  check('autre cause     : maintenance technique',
    v.site.otherCauses.some((c) => c.label === 'Maintenance technique'));
  check('RESOLVED NE SIGNIFIE PAS « site réactivé »', v.site.accessible === false);
  check('…et le titre ne prétend pas le contraire',
    v.headline === 'Paiement régularisé' && v.site.label === 'Site suspendu');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('J. Politique modifiée pendant l’incident');
{
  const v = describeIncidentForDisplay(incident({ graceDaysSnapshot: 7 }), {
    now: '2026-08-03T00:00:00Z',
    contractPaymentGraceDays: 15,
  });

  check('l’INCIDENT continue d’afficher 7', v.policy.snapshot === 7);
  check('…la CONFIGURATION affiche 15', v.policy.current === 15);
  check('l’écart est signalé', v.policy.drifted === true);
  check('…avec la phrase exacte',
    v.policy.note === 'La modification s’appliquera aux prochains incidents. '
      + 'Le délai d’un incident déjà ouvert reste inchangé.');
  check('L’ÉCHÉANCE N’EST PAS RECALCULÉE',
    v.grace.graceDeadlineAt === '2026-08-08T10:00:00Z');

  const aligne = describeIncidentForDisplay(incident({ graceDaysSnapshot: 7 }), {
    now: '2026-08-03T00:00:00Z', contractPaymentGraceDays: 7,
  });
  check('sans écart, rien n’est signalé', aligne.policy.drifted === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('K+L. « Aucune politique » et « zéro jour » ne se disent pas pareil');
{
  const sans = describeIncidentForDisplay(
    incident({ graceDaysSnapshot: null, graceDeadlineAt: null }),
    { now: '2026-08-03T00:00:00Z' },
  );
  check('sans politique, l’état est NON CONFIGURÉ', sans.grace.state === GRACE_STATE.UNCONFIGURED);
  check('AUCUNE échéance n’est affichée', sans.grace.graceDeadlineAt === null);
  check('…et surtout aucune n’est inventée', sans.grace.graceDaysSnapshot === null);
  check('la phrase promet explicitement l’ABSENCE de suspension automatique',
    sans.grace.note.includes('ne sera pas suspendu automatiquement'));

  const zero = describeIncidentForDisplay(
    incident({ graceDaysSnapshot: 0, graceDeadlineAt: '2026-08-01T10:00:00Z' }),
    { now: '2026-08-03T00:00:00Z' },
  );
  check('ZÉRO EST UNE POLITIQUE, pas une absence', zero.grace.graceDaysSnapshot === 0);
  check('…son état n’est PAS « non configuré »', zero.grace.state !== GRACE_STATE.UNCONFIGURED);
  check('…et sa phrase annonce l’inverse de celle de null',
    zero.grace.note.includes('0 jour') && !zero.grace.note.includes('ne sera pas suspendu'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('O+N. Incidents successifs et historique');
{
  const ancien = describeIncidentForDisplay(
    incident({ paymentDefaultId: 'pd-ancien', status: 'RESOLVED', graceDaysSnapshot: 7, resolvedAt: '2026-06-10T08:00:00Z' }),
    { now: '2026-09-01T00:00:00Z' },
  );
  const recent = describeIncidentForDisplay(
    incident({ paymentDefaultId: 'pd-recent', status: 'OPEN', graceDaysSnapshot: 15, graceDeadlineAt: '2026-09-05T10:00:00Z' }),
    { now: '2026-09-01T00:00:00Z' },
  );

  check('DEUX INCIDENTS NE FUSIONNENT PAS',
    ancien.paymentDefaultId !== recent.paymentDefaultId);
  check('…chacun garde SA politique figée',
    ancien.grace.graceDaysSnapshot === 7 && recent.grace.graceDaysSnapshot === 15);
  check('le résolu reste lisible', ancien.payment.state === PAYMENT_STATE.SETTLED);
  check('…et daté', ancien.payment.resolvedAt === '2026-06-10T08:00:00Z');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('P. Les identifiants techniques sont à part');
{
  const v = describeIncidentForDisplay(incident(), { now: '2026-08-03T00:00:00Z' });
  const lectureCourante = JSON.stringify({
    headline: v.headline, payment: v.payment, grace: v.grace, cause: v.cause, site: v.site,
  });

  check('les identifiants du fournisseur sont dans « détails »',
    v.technical.invoiceId === 'in_123'
    && v.technical.subscriptionId === 'sub_123'
    && v.technical.paymentIntentId === 'pi_123');
  check('AUCUN N’APPARAÎT DANS LA LECTURE COURANTE',
    !lectureCourante.includes('in_123')
    && !lectureCourante.includes('sub_123')
    && !lectureCourante.includes('pi_123'));
  check('…le numéro de facture, lui, est lisible', v.payment.invoiceNumber === 'F-2026-0042');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Q. Données partielles — inconnu n’est jamais faux');
{
  const nu = describeIncidentForDisplay(
    { paymentDefaultId: 'pd-nu', status: 'OPEN', firstFailedAt: '2026-08-01T10:00:00Z' },
    { now: '2026-08-03T00:00:00Z' },
  );
  check('un incident dépouillé se rend quand même', nu.headline === 'Paiement en échec');
  check('…sans échéance inventée', nu.grace.graceDeadlineAt === null);
  check('…sans tentative inventée', nu.payment.nextPaymentAttemptAt === null);
  check('…et sans conclusion sur le site', nu.site.state === SITE_STATE.UNKNOWN);

  /** Un instantané SANS causes : on publie l'accessibilité, pas de causes inventées. */
  const sansCauses = describeIncidentForDisplay(incident(), {
    now: '2026-08-03T00:00:00Z',
    siteStatus: { accessible: false, suspensionSource: 'TECHNICAL' },
  });
  check('un instantané sans causes ne fabrique aucune cause',
    sansCauses.site.otherCauses.length === 0 && sansCauses.site.causesKnown === false);
  check('…mais l’accessibilité, elle, est connue', sansCauses.site.accessible === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Garde-fous — l’écran affiche, il ne décide pas');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const nu = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

  const presentation = nu(lire('backend/src/services/finance/paymentDefaults/paymentDefaultPresentation.js'));

  /**
   * 1 + 2 — AUCUN ACCÈS AU FOURNISSEUR DE PAIEMENT.
   *
   * On ne peut pas interdire le mot « Stripe » : il apparaît légitimement dans
   * la phrase montrée à l'utilisateur (« Prochaine tentative prévue par
   * Stripe »), et c'est précisément la formulation que le lot EXIGE. Le
   * garde-fou vise donc les ACCÈS — appels réseau, SDK, clés — pas la marque
   * dans une phrase.
   */
  check('1 · aucun appel réseau vers le fournisseur',
    !/api\.stripe|fetch\s*\(|axios|sk_(test|live)|https?:\/\//i.test(presentation));
  check('2 · aucun SDK ni import de fournisseur',
    !/require\s*\(|from\s+['"]stripe|import\s+.*stripe/i.test(presentation));
  /**
   * La formulation elle-même est un invariant : « prévue PAR STRIPE » attribue
   * la tentative à qui la programme. « Nous retenterons » ferait attendre au
   * client une action que personne ne déclenchera.
   */
  check('…la tentative est attribuée à Stripe, jamais au Panel',
    /Prochaine tentative prévue par Stripe/.test(presentation)
    && !/[Nn]ous (retenter|relancer|réessa)/.test(presentation));
  // 3 — la source dominante n'est jamais une preuve
  check('3 · suspensionSource n’est jamais comparé à PAYMENT_DEFAULT',
    !/suspensionSource\s*===\s*['"]PAYMENT_DEFAULT/.test(presentation));
  // 4 — l'échéance n'est jamais reconstruite
  check('4 · aucune reconstruction d’échéance',
    !/firstFailedAt[^;]*\+[^;]*grace|grace[^;]*\*\s*24|86_?400_?000/.test(presentation));
  // 5 — l'accessibilité n'est jamais recalculée
  check('5 · aucune formule d’accessibilité',
    !/!technical\s*&&|technical\s*\|\|\s*contract/.test(presentation));
  /**
   * ── 6 + 7 : LA RELANCE — CE QUI RESTE INTERDIT, ET CE QUI NE L’EST PLUS ──
   *
   * L’invariant disait « aucune mention de relance ». Il visait juste tant
   * qu’aucune relance n’existait : la présentation ne devait ni en programmer,
   * ni en déclencher, ni laisser croire qu’elle le ferait.
   *
   * Une tentative MANUELLE existe désormais, déclenchée par un exploitant. La
   * présentation doit pouvoir dire si elle est possible — sinon l’écran
   * afficherait un bouton qui échoue, ou le cacherait quand il servirait.
   *
   * Ce qui reste interdit, et qui est le vrai danger :
   *   · PROGRAMMER une cadence — deux calendriers sur une facture, c’est le
   *     double débit ;
   *   · DÉCLENCHER quoi que ce soit depuis une fonction d’affichage.
   *
   * Décrire une éligibilité n’est ni l’un ni l’autre.
   */
  check('6 · aucune cadence, aucun minuteur',
    !/retryInterval|setInterval|setTimeout|nextRetryAt/.test(presentation));
  check('7 · aucun déclenchement depuis l’affichage',
    !/retryPaymentDefault|invokeCapability|payInvoice/.test(presentation));
  check('7 bis · l’éligibilité est DÉCRITE, pas décidée',
    /describeRetryEligibility/.test(presentation));
  // 10 — une lecture n'envoie rien
  check('10 · aucune notification déclenchée par une lecture',
    !/announce|sendTemplate|invokeCapability|email\.send/.test(presentation));
  // 12 — une lecture ne mute rien
  check('12 · aucune écriture en base',
    !/updateOne|updateMany|findOneAndUpdate|\.save\(|create\(/.test(presentation));
  // Le module reste PUR : aucune horloge implicite dans les décisions.
  check('la comparaison temporelle exige un instant EXPLICITE',
    /function describeGrace\(incident, now\)/.test(presentation));
  check('…et le motif est défini une seule fois',
    (presentation.match(/'Défaut de paiement'/g) || []).length === 1);
}

finish();
