/**
 * L10.1 — L'INTERFACE DES FINANCES.
 *
 * Ce que ces contrôles verrouillent :
 *
 *   · qu'un montant s'affiche SIGNÉ — « +2 490,00 € », « −48,00 € » — et qu'un
 *     bénéfice négatif s'affiche négatif, sans valeur absolue complaisante ;
 *   · que le graphique ne casse sur AUCUN des cinq états d'un registre qui
 *     démarre : zéro point, un point, que des revenus, que des coûts, tout à
 *     zéro. Ce calcul-là est réellement exécuté, pas relu ;
 *   · que la fiche projet et la page globale montent LE MÊME moteur ;
 *   · que « Tout supprimer » exige un mot retapé, annonce un décompte, et
 *     n'apparaisse que pour un compte DEV ;
 *   · qu'aucun champ Stripe vide ne soit affiché par anticipation ;
 *   · que la récurrence soit annoncée DÉSACTIVÉE, jamais simulée ;
 *   · que l'écran ait un état vide, un état de chargement et un état d'erreur.
 *
 * Les contrôles d'écran portent sur les SOURCES quand le composant est en
 * `.tsx` : le dépôt n'embarque aucun moteur de rendu React. Tout ce qui pouvait
 * être extrait en module pur l'a été, et est exécuté pour de vrai.
 */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

register('./helpers/frontendLoader.mjs', import.meta.url);

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

/**
 * LA SOURCE DÉCOMMENTÉE — même discipline que `architecture.test.js`.
 *
 * Ces fichiers EXPLIQUENT longuement ce qu'ils refusent de faire : « pas de
 * `type="number"` », « pas de drapeau `isRecurring` ». Chercher ces chaînes
 * dans le texte brut ferait échouer les contrôles sur la documentation qui les
 * justifie — exactement l'inverse de ce qu'on veut vérifier.
 */
const code = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Alias lisible pour les sections L10.2, qui décommentent beaucoup. */
const code2 = code;

const money = await import('@/lib/money');
const echelle = await import('@/lib/netChartScale');
const libelles = await import('@/components/finance/financeLabels');

const workspace = lire('frontend/src/components/finance/FinanceWorkspace.tsx');
const formRegle = lire('frontend/src/components/finance/RecurringCostForm.tsx');
const listeRegles = lire('frontend/src/components/finance/RecurringCostList.tsx');
const recu = lire('frontend/src/components/finance/ReceiptCell.tsx');
const libelles2 = lire('frontend/src/components/finance/financeLabels.ts');
const formulaire = lire('frontend/src/components/finance/TransactionForm.tsx');
const detail = lire('frontend/src/components/finance/TransactionDetail.tsx');
const graphique = lire('frontend/src/components/finance/NetChart.tsx');
const pageGlobale = lire('frontend/src/pages/FinancesPage.tsx');
const ficheProjet = lire('frontend/src/pages/ProjectDetailPage.tsx');
const nav = lire('frontend/src/config/nav.ts');
const app = lire('frontend/src/App.tsx');
const api = lire('frontend/src/lib/api.ts');
const css = lire('frontend/src/components.css');

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. Les montants s’affichent signés — et le net peut être négatif');
{
  check('un revenu porte un plus', money.formatFlowCents(249_000, 'INFLOW').startsWith('+'));
  check('un coût porte un moins', money.formatFlowCents(4800, 'OUTFLOW').startsWith('−'));
  check('…le MOINS typographique, qui s’aligne sur le plus',
    money.formatFlowCents(4800, 'OUTFLOW').startsWith('−'));

  const revenu = money.formatFlowCents(249_000, 'INFLOW');
  check('2 490,00 € s’écrit en français', /2\s?490,00/.test(revenu));
  check('…avec le symbole euro', revenu.includes('€'));
  check('39,90 € ne perd pas son centime', money.formatCents(3990).includes('39,90'));
  check('un montant nul s’affiche, il ne disparaît pas', money.formatCents(0).includes('0,00'));
  check('un montant absent se lit « — »', money.formatCents(null) === '—');

  const negatif = money.formatNetCents(-15_050);
  check('UN BÉNÉFICE NÉGATIF S’AFFICHE NÉGATIF', negatif.startsWith('−'));
  check('…et pas en valeur absolue', /150,50/.test(negatif));
  check('un net nul n’a pas de signe', !money.formatNetCents(0).startsWith('+'));

  check('la tonalité suit le signe',
    money.netTone(10) === 'ok' && money.netTone(-10) === 'danger' && money.netTone(0) === 'neutral');

  // La division par cent n'a lieu qu'ICI : la preuve que l'arrondi tient.
  check('0,10 + 0,20 sommés EN CENTIMES puis affichés donnent 0,30',
    money.formatCents(10 + 20).includes('0,30'));
}

section('2. Le graphique ne casse sur aucun état d’un registre qui démarre');
{
  const GEO = { width: 720, height: 200, margin: { top: 16, bottom: 26, left: 8, right: 8 } };
  const point = (bucket, netCents) => ({
    bucket, netCents, inflowCents: Math.max(netCents, 0), outflowCents: Math.max(-netCents, 0),
  });
  const sain = (e) =>
    Number.isFinite(e.zeroY) && e.span > 0
    && e.bars.every((b) => [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.height > 0);

  const aucun = echelle.computeChartScale([], GEO);
  check('AUCUN point : aucune coordonnée n’est NaN', Number.isFinite(aucun.zeroY) && aucun.span > 0);
  check('…et il n’y a simplement pas de barre', aucun.bars.length === 0);

  const un = echelle.computeChartScale([point('2026-03-01T00:00:00.000Z', 24_900)], GEO);
  check('UN SEUL point : pas de division par zéro', sain(un));
  check('…et la barre ne prend pas toute la largeur', un.bars[0].width <= 56);
  check('…elle reste visible', un.bars[0].width >= 3);

  const revenusSeuls = echelle.computeChartScale(
    [point('a', 10_000), point('b', 25_000)], GEO,
  );
  check('QUE DES REVENUS : la ligne de zéro est en BAS du cadre',
    revenusSeuls.low === 0 && revenusSeuls.zeroY > GEO.height / 2 && sain(revenusSeuls));

  const coutsSeuls = echelle.computeChartScale(
    [point('a', -10_000), point('b', -25_000)], GEO,
  );
  check('QUE DES COÛTS : la ligne de zéro est en HAUT du cadre',
    coutsSeuls.high === 0 && coutsSeuls.zeroY < GEO.height / 2 && sain(coutsSeuls));
  check('…et toutes les barres sont marquées négatives',
    coutsSeuls.bars.every((b) => b.negative));

  const mixte = echelle.computeChartScale(
    [point('a', 30_000), point('b', -12_000)], GEO,
  );
  check('NET NÉGATIF ET POSITIF : le zéro tombe entre les deux',
    mixte.zeroY > 16 && mixte.zeroY < GEO.height - 26 && sain(mixte));

  const zeros = echelle.computeChartScale([point('a', 0), point('b', 0)], GEO);
  check('TOUT À ZÉRO : l’amplitude reste strictement positive', zeros.span > 0);
  check('…aucune coordonnée n’est NaN', sain(zeros));
  check('…et une barre nulle garde un filet visible', zeros.bars.every((b) => b.height >= 1));

  const trenteEtUn = echelle.computeChartScale(
    Array.from({ length: 31 }, (_, i) => point(`j${i}`, i * 100)), GEO,
  );
  check('31 jours : les libellés sont espacés, jamais tous affichés',
    trenteEtUn.labelEvery >= 3);

  check('le composant montre un état vide plutôt qu’un cadre sans barres',
    graphique.includes('series.length === 0') && graphique.includes('EmptyState'));
}

section('3. UN SEUL moteur — la fiche projet et la page globale le partagent');
{
  check('la fiche projet monte le moteur', ficheProjet.includes('<FinanceWorkspace'));
  check('…avec la portée verrouillée sur le projet',
    /<FinanceWorkspace[\s\S]{0,200}scope="project"/.test(ficheProjet));
  check('…et le projectId préselectionné',
    /<FinanceWorkspace[\s\S]{0,240}projectId=\{project\.projectId\}/.test(ficheProjet));

  check('la page globale monte LE MÊME moteur', pageGlobale.includes('<FinanceWorkspace'));
  check('…avec la portée ouverte', /<FinanceWorkspace[\s\S]{0,120}scope="all"/.test(pageGlobale));

  check('aucun second calcul de bénéfice côté écran',
    !workspace.includes('revenueCents -') && !pageGlobale.includes('- costCents'));
  check('le net vient du backend, jamais d’une soustraction locale',
    workspace.includes('summary.totals.netCents'));
}

section('4. L’onglet Finances et la page globale sont atteignables');
{
  check('l’onglet existe dans la fiche projet', /className=\{tab === 'finances'/.test(ficheProjet));
  check('…il est nommé « Finances »', /tab === 'finances'[\s\S]{0,200}Finances/.test(ficheProjet));
  check('…il vit dans l’URL comme les autres', ficheProjet.includes("'finances'"));
  check('…et il n’est PAS réservé aux DEV',
    !/isDev[\s\S]{0,120}tab === 'finances'/.test(ficheProjet));

  check('la page globale a sa route', app.includes('path="/finances"'));
  check('…hors de la garde DEV', !/dev\(<FinancesPage/.test(app));
  check('la navigation la propose', nav.includes("to: '/finances'"));
  check('…dans la section GESTION', /to: '\/finances'[^}]*section: 'GESTION'/.test(nav));
  check('…et pas en devOnly', !/to: '\/finances'[^}]*devOnly/.test(nav));
}

section('5. Les trois sous-onglets, et ce qu’ils filtrent');
{
  check('les trois sous-onglets existent',
    workspace.includes("key: 'general'")
    && workspace.includes("key: 'costs'")
    && workspace.includes("key: 'revenues'"));
  check('« Coûts » filtre sur la catégorie COST',
    /sousOnglet === 'costs' \? 'COST'/.test(workspace));
  /**
   * L10.4 — « REVENUS » RETIENT AUSSI LES REMBOURSEMENTS.
   *
   * Un remboursement est de catégorie REFUND : sur l'ancien filtre, il devenait
   * invisible, et l'écran des revenus montrait 500 € encaissés sans dire que
   * 100 étaient repartis. Le ranger en COST pour qu'il apparaisse quelque part
   * aurait gonflé les charges — c'est le filtre qui s'élargit, jamais la
   * taxonomie qui se déforme.
   */
  check('« Revenus » retient les encaissements ET les remboursements',
    /sousOnglet === 'revenues' \? 'REVENUE,REFUND'/.test(workspace));
  check('…et « Coûts » ne retient QUE les coûts',
    !/sousOnglet === 'costs' \? '[A-Z,]*REFUND/.test(workspace));
  check('« Général » ne filtre rien', /'REVENUE,REFUND' : null/.test(workspace));

  check('le graphique n’apparaît que sur « Général »',
    /sousOnglet === 'general' \?[\s\S]{0,200}<NetChart/.test(workspace));

  check('LES AGRÉGATS NE SUIVENT PAS LE SOUS-ONGLET — ils décrivent la période',
    workspace.includes('criteresResume') && workspace.includes('criteresListe')
    && /useFinanceWorkspace\(criteresResume, criteresListe\)/.test(workspace));
}

section('6. Les périodes, les filtres et le tri sont à l’écran');
{
  check('les six périodes du cahier des charges sont proposées',
    ['TODAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'CURRENT_MONTH', 'CURRENT_YEAR', 'CUSTOM']
      .every((clef) => libelles.PERIOD_ORDER.includes(clef)));
  check('…plus « depuis le début », qui n’en est pas une borne',
    libelles.PERIOD_ORDER.includes('ALL'));
  check('chacune porte un libellé lisible',
    libelles.PERIOD_ORDER.every((clef) => typeof libelles.PERIOD_LABELS[clef] === 'string'
      && libelles.PERIOD_LABELS[clef].length > 0));

  check('la période personnalisée ouvre deux bornes de date',
    /period === 'CUSTOM' \?[\s\S]{0,600}type="date"/.test(workspace));
  check('…et une borne manquante ne part pas en erreur serveur',
    workspace.includes('periodeUtilisable'));

  check('la recherche est branchée', workspace.includes('<SearchField'));
  check('le tri propose date et montant, dans les deux sens',
    libelles.SORT_ORDER.length === 4
    && libelles.SORT_ORDER.includes('AMOUNT_ASC')
    && libelles.SORT_ORDER.includes('DATE_DESC'));
  check('le filtre par rattachement n’apparaît QUE sur la page globale',
    /!verrouille \? \([\s\S]{0,400}Rattachement/.test(workspace));
  check('…et il propose L.Y Solution seule', workspace.includes('__COMPANY__'));

  check('les filtres passent par le sélecteur thémé, jamais par un select natif',
    workspace.includes('<ThemedFilter'));
}

section('7. Saisir : deux catégories, et une récurrence ANNONCÉE, pas simulée');
{
  check('le bouton d’ajout existe', workspace.includes('Ajouter une transaction'));
  const formCode = code(formulaire);
  check('la catégorie propose Revenu et Coût',
    />\s*Revenu\s*</.test(formCode) && />\s*Coût\s*</.test(formCode));
  check('le type propose « Ponctuel »', /Ponctuel/.test(formCode));
  check('…et « Récurrent » DÉSACTIVÉ',
    /disabled[\s\S]{0,300}Récurrent/.test(formCode));
  check('…avec la mention de ce qui viendra',
    /prochain lot/.test(formCode));
  check('AUCUNE fausse récurrence n’est envoyée au backend',
    !/recurring|isRecurring|RECURRING/i.test(formCode));

  check('le montant part en CHAÎNE, jamais en nombre flottant',
    /type="text"[\s\S]{0,200}inputMode="decimal"/.test(formCode)
    && !formCode.includes('type="number"'));
  check('la date est un jour, pas un horodatage', formulaire.includes('type="date"'));
  check('le rattachement est VERROUILLÉ depuis une fiche projet',
    formulaire.includes('lockedProjectId') && formulaire.includes('readOnly'));
  check('…et sans projet, le mouvement appartient à L.Y Solution',
    formulaire.includes('LY_SOLUTION'));
  check('le nom est obligatoire', /value=\{label\}[\s\S]{0,200}required/.test(formulaire));
}

section('8. Le détail n’affiche AUCUN champ Stripe vide par anticipation');
{
  check('le bouton « Voir les détails » existe', workspace.includes('Voir les détails'));

  check('l’identifiant interne est affiché', detail.includes('Identifiant interne'));
  check('le projet, le nom, la description, le montant, la date le sont aussi',
    detail.includes('Rattachement') && detail.includes('Date d’effet')
    && detail.includes('Description') && detail.includes('Montant brut'));
  check('l’origine et le statut sont affichés',
    detail.includes('ORIGIN_LABELS') && detail.includes('STATUS_LABELS'));
  check('l’auteur et les dates de création/modification aussi',
    detail.includes('Saisi par') && detail.includes('Dernière modification'));

  /**
   * L'INVARIANT N'A PAS CHANGÉ, SA FORME SI (L10.3).
   *
   * La provenance brute reste conditionnée à son existence — un bloc Stripe
   * vide sur une saisie manuelle serait toujours un mensonge poli. Elle est
   * désormais un REPLI : dès que le fait fournisseur complet est chargé, c'est
   * lui qui s'affiche, et afficher les deux dirait la même chose en double.
   */
  check('LA PROVENANCE N’EST RENDUE QUE SI ELLE EXISTE',
    /transaction\.provenance && !fait \?/.test(detail));
  check('…et elle s’efface devant le fait fournisseur complet',
    /\{fait \? <ProviderFactPanel/.test(detail));
  check('…chaque champ fournisseur est conditionné individuellement',
    /provenance\.provider \?/.test(detail)
    && /provenance\.environment \?/.test(detail)
    && /provenance\.externalId \?/.test(detail));
  check('la transaction parente n’apparaît que s’il y en a une',
    /transaction\.parentTransactionId \?/.test(detail));
  check('aucun libellé Stripe n’est écrit en dur',
    !/Stripe/.test(detail.replace(/\/\*[\s\S]*?\*\//g, '')));
}

section('9. Supprimer : une ligne, puis « tout », avec confirmation forte');
{
  check('la suppression unitaire passe par une confirmation',
    workspace.includes('SuppressionUnitaire') && workspace.includes('Supprimer ce mouvement ?'));
  check('…et annonce que le document reste auditable',
    /reste consultable pour l’audit/.test(workspace));

  check('« Tout supprimer » n’est proposé qu’à un compte DEV',
    /isDev \? \([\s\S]{0,200}Tout supprimer/.test(workspace));
  check('…il annonce un DÉCOMPTE avant d’agir',
    workspace.includes('bulkScope') && workspace.includes('Décompte en cours'));
  check('…il exige que le mot soit RETAPÉ',
    workspace.includes("CONFIRMATION_MASSE = 'SUPPRIMER'")
    && workspace.includes('phrase !== CONFIRMATION_MASSE'));
  check('…il nomme sa PORTÉE', /Portée : \$\{libelle\}/.test(workspace));
  check('…et dit qu’elle ignore la période affichée',
    /Toutes périodes confondues/.test(workspace));
  check('le bouton reste inerte s’il n’y a rien à supprimer',
    workspace.includes('compte === 0'));
}

section('10. États vides, chargement, erreur, et le tronquage dit son nom');
{
  check('un état de chargement existe', workspace.includes('Chargement des finances'));
  check('un état d’erreur existe', /alert alert-error/.test(workspace));
  check('un état vide existe pour la liste', workspace.includes('Aucun mouvement ne correspond'));
  check('…et il ne dit pas la même chose selon qu’on cherche ou non',
    /recherche\.trim\(\)[\s\S]{0,200}Élargissez la recherche/.test(workspace));
  check('le graphique a son propre état vide',
    graphique.includes('Aucun mouvement sur cette période'));
  check('la page globale a un état vide pour la répartition',
    pageGlobale.includes('Aucun mouvement enregistré'));

  check('une liste TRONQUÉE le dit, et rappelle que les totaux sont complets',
    /list\.truncated \?/.test(workspace) && /les totaux ci-dessus/.test(workspace));
  check('une relecture en cours ne vide pas l’écran',
    workspace.includes('isRefreshing') && workspace.includes('Mise à jour…'));
}

section('11. Responsive, thème et accessibilité');
{
  check('les montants sont en chiffres de largeur fixe — une colonne comparable',
    css.includes('font-variant-numeric: tabular-nums'));
  check('les tableaux défilent horizontalement plutôt que de déborder',
    workspace.includes('table-scroll'));
  check('la mise en page du détail passe à une colonne sur petit écran',
    /@media \(max-width: 40rem\)[\s\S]{0,400}finance-detail-row/.test(css));
  check('le formulaire aussi', /@media \(max-width: 40rem\)[\s\S]{0,400}finance-form-row/.test(css));

  check('AUCUNE couleur en dur dans les styles financiers',
    !/\.finance-[\s\S]{0,4000}#[0-9a-f]{3,6}/i.test(css.slice(css.indexOf('.finance-workspace'))));
  check('les couleurs viennent du thème', css.includes('.finance-amount-inflow')
    && /\.finance-amount-inflow[^}]*var\(--p-ok\)/.test(css));

  check('le graphique porte un rôle et une description',
    graphique.includes('role="img"') && graphique.includes('aria-label'));
  check('chaque barre porte sa valeur en infobulle native', graphique.includes('<title>'));
  check('la colonne d’actions a un intitulé pour les lecteurs d’écran',
    workspace.includes('sr-only'));
  check('les choix de catégorie annoncent leur état', formulaire.includes('aria-pressed'));
}

section('12. Le client d’API — un seul verbe fournisseur, et il passe par le Panel');
{
  const bloc = api.slice(api.indexOf('export const finances'), api.indexOf('export function errorMessage'));
  check('le client financier existe', bloc.length > 0);
  /**
   * CE CONTRÔLE INTERDISAIT « refund ». L10.4 l'ajoute, et l'interdiction change
   * d'objet plutôt que de disparaître : ce qui ne doit JAMAIS entrer dans ce
   * client, c'est une adresse Stripe, une clé, ou un identifiant fournisseur
   * construit côté navigateur. Le verbe, lui, est légitime — il s'adresse au
   * Panel, sur une identité INTERNE de mouvement.
   */
  check('le remboursement s’adresse au Panel, sous la transaction',
    bloc.includes('/refund') && bloc.includes('transactions/${transactionId}/refund'));
  check('…et son corps ne porte qu’un montant et deux raisons',
    /amountCents: number \| null; reason\?/.test(bloc));
  check('AUCUNE adresse Stripe', !/api\.stripe|stripe\.com/i.test(bloc));
  check('…aucune clé', !/sk_live|sk_test|secretKey/i.test(bloc));
  check('…aucun identifiant fournisseur construit ici',
    !/'pi_|'ch_|'re_|'cs_|'in_/.test(bloc));
  check('aucun import automatique', !/\bimport(er)?From|synchronis/i.test(bloc));
  check('la suppression est bien un retrait LOGIQUE annoncé comme tel',
    /Suppression LOGIQUE/.test(bloc));
  check('la portée de la suppression en masse est un paramètre EXIGÉ',
    /scope: FinanceScope; projectId\?: string \| null; confirm: string/.test(bloc));
}

/* ══════════════════════════════════════════════════════════════════════════
   L10.2 — COÛTS RÉCURRENTS ET JUSTIFICATIFS
   ══════════════════════════════════════════════════════════════════════════ */

section('13. Les règles vivent À CÔTÉ du livret, jamais dedans');
{
  check('le listing des règles n’apparaît que sous « Coûts »',
    /sousOnglet === 'costs' \?[\s\S]{0,400}<RecurringCostList/.test(workspace));
  check('il porte montant, fréquence, prochaine échéance, état',
    /Fréquence/.test(listeRegles) && /Prochaine/.test(listeRegles)
    && /frequenceLabel/.test(listeRegles) && /badge-ok/.test(listeRegles));
  check('…et les actions Modifier / Stopper',
    />\s*Modifier\s*</.test(listeRegles) && />\s*Stopper\s*</.test(listeRegles));

  check('la PRÉVISION est nommée comme telle, jamais comptée',
    /prévision — non comptabilisée/.test(listeRegles));
  check('…et le texte dit que seuls les mouvements comptent',
    /seuls ces mouvements comptent dans les\s+totaux/.test(listeRegles));

  check('une règle arrêtée reste visible, atténuée',
    /finance-row-muted/.test(listeRegles) && /finance-row-muted td \{ opacity/.test(css));

  check('une occurrence est identifiée dans le livret',
    /origin === 'RECURRING_COST'[\s\S]{0,160}cycle \$\{ligne\.cycleKey\}/.test(workspace));
}

section('14. Modifier : le bouton n’apparaît qu’après un changement, et il POSE une question');
{
  const code = code2(formRegle);
  check('« Enregistrer » n’existe que si quelque chose a changé',
    /!modification \|\| modifie \?/.test(code));
  check('…et il ouvre la question du moment, il n’enregistre pas',
    /if \(modification\) setMode\('NEXT'\)/.test(code));

  check('les TROIS modes sont proposés',
    /value: 'NEXT'/.test(code) && /value: 'CURRENT'/.test(code) && /value: 'FROM_START'/.test(code));
  check('…avec les libellés du cahier des charges',
    /Prochaine récurrence/.test(formRegle)
    && /Récurrence précédente/.test(formRegle)
    && /Depuis le début/.test(formRegle));
  check('…et chacun explique CE QUI BOUGE',
    /ne bougent pas/.test(formRegle)
    && /est corrigée, ainsi que toutes les suivantes/.test(formRegle)
    && /depuis la première/.test(formRegle));
  check('« depuis le début » promet explicitement de garder les pièces',
    /justificatifs déjà attachés sont conservés/.test(formRegle));

  check('la fréquence et l’ancre ne se modifient PAS après création',
    /disabled=\{modification\}/.test(code));
  check('…et l’écran dit pourquoi', /ancrent toute la suite des échéances/.test(formRegle));

  check('la règle du jour impossible est annoncée à la saisie',
    /dernier jour du mois/.test(formRegle));

  check('AUCUN justificatif dans le formulaire de définition',
    !/type="file"/.test(code) && !/uploadReceipt|ReceiptCell/.test(code));
}

section('15. Stopper : deux choix, et leurs conséquences écrites');
{
  check('la modale d’arrêt existe', /StopRecurringDialog/.test(formRegle));
  check('…avec « Actuelle » et « Prochaine »',
    /label: 'Actuelle'/.test(formRegle) && /label: 'Prochaine'/.test(formRegle));
  check('« Actuelle » annonce le RETRAIT du cycle en cours',
    /retiré des totaux/.test(formRegle));
  check('…et promet que la ligne reste auditable, avec sa pièce',
    /reste consultable pour l’audit, avec son justificatif/.test(formRegle));
  check('« Prochaine » annonce que le cycle en cours RESTE',
    /Le cycle en cours reste comptabilisé/.test(formRegle));
  check('les cycles antérieurs ne sont jamais touchés — c’est dit',
    /cycles antérieurs ne sont jamais touchés/.test(formRegle));
  check('l’immuabilité après arrêt est annoncée',
    /ne se modifie plus et ne se réactive pas/.test(formRegle));
}

section('16. Justificatifs : aucun lien, aucune URL, jamais');
{
  const code = code2(recu);
  check('la cellule de justificatif existe', /ReceiptCell/.test(recu));
  check('elle est branchée dans le LIVRET, ligne par ligne',
    /<th scope="col">Justificatif<\/th>/.test(workspace)
    && /<ReceiptCell transaction=\{ligne\}/.test(workspace));
  check('…et dans le détail d’un mouvement', /<ReceiptCell/.test(detail));

  check('AUCUN `<a href>` vers un document', !/<a\s[^>]*href/.test(code));
  check('…aucune URL, même relative',
    !/https?:\/\//.test(code) && !/\/uploads/.test(code) && !/storage\//.test(code));
  check('le téléchargement passe par l’appel AUTHENTIFIÉ',
    /finances\.downloadReceipt/.test(code));
  check('…et l’envoi aussi', /finances\.uploadReceipt/.test(code));

  check('les quatre gestes sont offerts',
    /Ajouter un justificatif/.test(recu) && /Télécharger/.test(recu)
    && /Remplacer/.test(recu) && /Retirer/.test(recu));
  check('un mouvement supprimé garde la LECTURE, perd l’écriture',
    /supprime \?[\s\S]{0,120}—/.test(recu) && /!supprime \?/.test(recu));

  check('`accept` est présenté comme une commodité, pas un contrôle',
    /ACCEPTED_RECEIPT_MIMES/.test(recu)
    && /COMMODIT./i.test(libelles2) && /pas un contr.le/i.test(libelles2));
  check('…le vrai contrôle est annoncé côté serveur',
    /signature des octets[\s\S]{0,12}c.t. serveur/i.test(libelles2));

  check('le champ fichier est vidé après usage — redéposer le même marche',
    /e\.target\.value = ''/.test(code));
}

section('17. Le client d’API respecte la doctrine du document privé');
{
  const bloc = api.slice(api.indexOf('export const finances'), api.indexOf('export function errorMessage'));
  check('l’envoi est multipart, sans Content-Type posé à la main',
    /uploadReceipt/.test(bloc) && !/'Content-Type': 'multipart/.test(bloc));
  check('le téléchargement lit la forme ENCODÉE du nom en premier',
    /UTF-8''/.test(bloc));
  check('…puis retombe sur la forme simple', /filename="\(\[\^"\]\+\)"/.test(bloc));
  check('l’URL objet est révoquée APRÈS le clic, jamais avant',
    /lien\.click\(\)[\s\S]{0,200}revokeObjectURL/.test(bloc));
  check('aucune adresse permanente n’est fabriquée',
    !/receiptUrl|\/uploads\//.test(bloc));
}

section('18. « Tout supprimer » prévient que les règles survivent');
{
  check('le décompte lit aussi les règles actives',
    /activeRecurringCosts/.test(workspace));
  check('…et l’écran le DIT avant le clic',
    /restent ACTIFS sur cette portée|reste ACTIF sur cette portée/.test(workspace));
  check('…en précisant que vider le livret n’arrête rien',
    /Vider le livret n’arrête\s+aucun abonnement/.test(workspace));
  check('…et où aller pour arrêter', /arrêtez chaque récurrence depuis l’onglet Coûts/.test(workspace));
}

/* ══════════════════════════════════════════════════════════════════════════
   L10.3 — REVENUS STRIPE PROJETÉS
   ══════════════════════════════════════════════════════════════════════════ */

section('19. Un revenu Stripe se lit comme un revenu manuel');
{
  const code = code2(workspace);
  /**
   * La fenêtre est large : L13 a inséré, entre le test d'origine et le libellé,
   * le cas de la LIGNE DE COMMISSION — qui doit se nommer autrement pour qu'on
   * ne la prenne pas pour un second paiement. Une fenêtre serrée aurait fait
   * échouer ce contrôle sur un ajout parfaitement légitime.
   */
  check('l’origine automatique est signalée DISCRÈTEMENT',
    /origin === 'STRIPE'[\s\S]{0,900}Encaissé via Stripe/.test(workspace));
  check('…et une commission ne se lit PAS comme un encaissement',
    /BALANCE_TRANSACTION[\s\S]{0,120}Coût de traitement du paiement/.test(workspace));
  check('…sans aucun identifiant Stripe dans la ligne',
    !/in_|pi_|cs_|sub_/.test(code.replace(/'STRIPE'/g, '')));
  check('le monde TEST est signalé par une pastille',
    /provenance\?\.environment === 'TEST'[\s\S]{0,120}badge-warn/.test(workspace));
  check('la liste ne charge AUCUN fait fournisseur',
    !/providerFact/.test(code));
}

section('20. Les identifiants Stripe vivent dans le détail, repliés');
{
  const panneau = lire('frontend/src/components/finance/ProviderFactPanel.tsx');
  const code = code2(panneau);

  check('le panneau existe et est monté depuis le détail',
    /<ProviderFactPanel/.test(detail) && /ProviderFactPanel/.test(panneau));
  check('…et il n’est chargé QU’À l’ouverture du détail',
    /finances\.detail\(transaction\.transactionId\)/.test(detail));
  check('…jamais si le mouvement n’a pas de provenance',
    /if \(!transaction\.provenance\) return undefined/.test(detail));

  check('le fournisseur et le MONDE sont affichés',
    /fact\.provider/.test(code) && /fact\.environment/.test(code));
  check('…l’environnement porte une pastille distincte PROD / TEST',
    /environment === 'PROD' \? 'badge badge-ok' : 'badge badge-warn'/.test(code));
  check('l’objet canonique est nommé en français',
    /INVOICE: 'Facture'/.test(panneau) && /CHECKOUT_SESSION: 'Session de paiement'/.test(panneau));
  check('l’état de projection est traduit', /PROJECTED: 'Porté au registre'/.test(panneau));
  check('une revendication divergente est SIGNALÉE',
    /claimMismatch/.test(code) && /Revendication divergente/.test(panneau));

  check('LES IDENTIFIANTS TECHNIQUES SONT REPLIÉS par défaut',
    /<details className="finance-technical">/.test(panneau));
  check('…et le CSS les traite comme un repli, pas comme un écran',
    /\.finance-technical \{/.test(css) && /finance-technical > summary/.test(css));
  check('abonnement, intention, débit, session et client y figurent',
    /subscriptionId/.test(code) && /paymentIntentId/.test(code)
    && /chargeId/.test(code) && /checkoutSessionId/.test(code) && /customerId/.test(code));
  check('…et chacun est copiable', /<CopyField/.test(panneau));
}

section('21. La facture Stripe est un LIEN, jamais un média local');
{
  const panneau = lire('frontend/src/components/finance/ProviderFactPanel.tsx');
  const code = code2(panneau);

  check('les deux adresses Stripe sont proposées',
    /doc\.hostedUrl/.test(code) && /doc\.pdfUrl/.test(code));
  check('…et s’ouvrent en toute sécurité',
    /rel="noopener noreferrer"/.test(panneau) && /target="_blank"/.test(panneau));
  check('AUCUNE URL absolue codée en dur', !/https?:\/\/(?!localhost)/.test(code));
  check('le panneau ne fabrique aucun média local',
    !/uploads|storePrivateDocument|mediaId/.test(code));
  check('…et l’écran dit que ces liens peuvent expirer',
    /peuvent expirer/.test(panneau));
  check('…en renvoyant vers le justificatif privé pour une copie durable',
    /espace\s+privé du Panel/.test(panneau));
}

section('22. Le client d’API n’interroge jamais Stripe');
{
  const bloc = api.slice(api.indexOf('export const finances'), api.indexOf('export function errorMessage'));
  check('aucun appel vers un domaine Stripe', !/stripe\.com|api\.stripe/.test(bloc));
  check('…aucun verbe de lecture fournisseur',
    !/listInvoices|retrieveInvoice|fetchStripe/i.test(bloc));
  check('le détail est la SEULE voie vers le fait fournisseur',
    /providerFact: ProviderFact \| null/.test(bloc));
  check('…et il passe par le Panel', /\/api\/finances\/transactions\/\$\{transactionId\}/.test(bloc));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('21. Les tables se lisent comme des tables — alignement et empilement');
{
  const modale = lire('frontend/src/components/finance/FinanceModal.tsx');
  const styles = lire('frontend/src/styles.css');

  /*
    ── L'ENTÊTE NUMÉRIQUE S'ALIGNE SUR SES VALEURS ────────────────────────

    `.data-table th` porte `text-align: left` et sa spécificité (classe +
    élément) l'emportait sur `.finance-cell-amount` (classe seule). « REVENUS »
    restait donc à gauche pendant que « 443,99 € » se rangeait à droite. Le
    contrôle porte sur le SÉLECTEUR, parce que c'est lui qui a été faux : une
    marge compensatoire aurait « corrigé » l'écran sans corriger la règle.
  */
  check('l’entête d’une colonne de montants est nommée à la même spécificité',
    /\.data-table th\.finance-cell-amount/.test(css));
  check('…et elle s’aligne à droite, comme ses valeurs',
    /\.finance-cell-amount,\s*\.data-table th\.finance-cell-amount \{[^}]*text-align: right/.test(css));

  /*
    ── LA CELLULE D'ACTIONS RESTE UNE CELLULE ─────────────────────────────

    `.row-actions` (display: flex) posée sur un `<td>` le sortait du modèle de
    tableau : ses boutons se calaient en haut d'une cellule anonyme pendant que
    les voisines restaient centrées.
  */
  for (const [nom, source] of [
    ['le livret', workspace],
    ['les demandes de paiement', lire('frontend/src/components/finance/PaymentRequestPanel.tsx')],
    ['les règles récurrentes', listeRegles],
  ]) {
    check(`${nom} n’applique plus le flex directement sur la cellule`,
      !/<td className="row-actions">/.test(code(source)));
    check(`…il l’enveloppe dans un conteneur (${nom})`,
      /<td className="cell-actions">/.test(code(source)));
  }
  check('la cellule d’actions est déclarée comme cellule de tableau',
    /\.data-table td\.cell-actions/.test(css));

  /*
    ── SIX COLONNES NE RENTRENT PAS DANS 390 px ───────────────────────────

    Mesuré avant correction : 557 px de contenu pour 390 px de vue. La bascule
    est une requête de CONTENEUR et non d'écran, parce que la place disponible
    ne suit pas la largeur de fenêtre : à 768 px le tableau dispose de 686 px,
    à 1024 px il en dispose de 684 — la barre latérale reprend ce que la
    fenêtre a gagné.
  */
  check('la bascule en fiches suit la largeur DISPONIBLE, pas celle de l’écran',
    /container-type: inline-size/.test(css) && /@container \(max-width/.test(css));
  check('les deux tables financières sont empilables',
    /finance-table-stackable/.test(code(workspace)) && /finance-table-stackable/.test(code(pageGlobale)));
  check('chaque cellule empilée garde le NOM de sa colonne',
    /td\[data-label\]::before[^}]*content: attr\(data-label\)/.test(css));
  for (const etiquette of ['Date', 'Mouvement', 'Rattachement', 'Montant', 'Justificatif']) {
    check(`« ${etiquette} » est portée par sa cellule`,
      new RegExp(`data-label="${etiquette}"`).test(code(workspace)));
  }
  for (const etiquette of ['Rattachement', 'Revenus', 'Coûts', 'Net', 'Mouvements']) {
    check(`la répartition porte « ${etiquette} »`,
      new RegExp(`data-label="${etiquette}"`).test(code(pageGlobale)));
  }
  /*
    La feuille EXPLIQUE qu'elle refuse `display: none` pour l'entête ; chercher
    la chaîne dans le texte brut ferait échouer le contrôle sur la phrase qui le
    justifie. On décommente d'abord — même discipline qu'ailleurs dans ce
    fichier.
  */
  const empilement = code(css).slice(code(css).indexOf('.finance-table-stackable'));
  check('aucune colonne n’est masquée en silence',
    !/display:\s*none/.test(empilement.slice(0, 3000)));

  /*
    ── LA FENÊTRE TIENT DANS LA VUE ───────────────────────────────────────

    Le fond défilait avec `align-items: center` : un enfant plus haut que son
    conteneur défilant sort par le HAUT, et cette partie devient inatteignable.
    Le titre du mouvement était perdu sur toutes les tailles mesurées, jusqu'au
    1280×900.
  */
  check('le fond ne défile plus', /\.modal-backdrop \{[^}]*overflow: hidden/.test(styles));
  check('la boîte est bornée à la vue visible (dvh, pas vh)',
    /\.modal \{[^}]*max-height: min\(100%, calc\(100dvh/.test(styles));
  check('…et c’est son CONTENU qui défile',
    /\.modal-body \{[^}]*overflow-y: auto/.test(styles) && /\.modal-body \{[^}]*min-height: 0/.test(styles));
  check('l’en-tête ne défile pas', /\.modal-head \{[^}]*flex: 0 0 auto/.test(styles));
  check('le pied reste visible', /\.modal-body > \.action-buttons[^{]*\{[^}]*position: sticky/.test(styles));
  check('le contenu est bien enveloppé dans la zone défilante',
    /<div className="modal-body">\{children\}<\/div>/.test(code(modale)));

  /*
    ── LA FENÊTRE SE FERME, ET LE FOCUS NE S'ÉCHAPPE PAS ──────────────────
  */
  check('une croix nommée ferme la fenêtre',
    /aria-label="Fermer la fenêtre"/.test(code(modale)));
  check('le focus est piégé pendant qu’elle est ouverte',
    /e\.key !== 'Tab'/.test(code(modale)) && /shiftKey/.test(code(modale)));
  check('…et rendu à son point de départ', /rendreLeFocus\.current\?\.focus/.test(code(modale)));

  /*
    ── LE « ⋮ » RANGE LE SECONDAIRE, JAMAIS L'IMPORTANT ───────────────────
  */
  const menu = lire('frontend/src/components/finance/RowMenu.tsx');
  check('le menu annonce qu’il ouvre un menu', /aria-haspopup="menu"/.test(code(menu)));
  check('…et son état', /aria-expanded=\{ouvert\}/.test(code(menu)));
  check('Échap le referme et rend le focus',
    /e\.key !== 'Escape'/.test(code(menu)) && /declencheur\.current\?\.focus\(\)/.test(code(menu)));
  check('un retrait garde son traitement destructif jusque dans le menu',
    /conn-menu-item-danger/.test(code(menu)) && /danger: true/.test(code(recu)));
  check('« Rembourser » reste un bouton visible, hors du menu',
    /className="btn btn-small btn-danger"[\s\S]{0,120}Rembourser/.test(code(workspace)));
  check('« Voir les détails » aussi', /Voir les détails/.test(code(workspace)));
  check('« Télécharger » reste visible', /Télécharger/.test(code(recu)));

  /* Le champ de fichier est une mécanique : il ne doit pas s’annoncer. */
  check('le champ de fichier est retiré de l’arbre d’accessibilité',
    /tabIndex=\{-1\}[\s\S]{0,60}aria-hidden="true"/.test(code(recu)));
}

/* ══════════════════════════════════════════════════════════════════════════
   L13 — BRUT · FRAIS · NET DANS L'ÉCRAN
   ══════════════════════════════════════════════════════════════════════════ */

section('L13. L’encaissement net se lit dans la liste, pas seulement au détail');
{
  const decompte = lire('frontend/src/components/finance/SettlementBreakdown.tsx');
  const codeDecompte = code2(decompte);

  check('le décompte affiche les TROIS lignes attendues',
    /Brut/.test(codeDecompte) && /Frais/.test(codeDecompte) && /Net/.test(codeDecompte));

  /**
   * LE CONTRÔLE LE PLUS IMPORTANT DE CETTE SECTION.
   *
   * Un frais inconnu et un frais nul se ressemblent dans une colonne et sont
   * opposés dans un bilan. « 0,00 € » affirme que le fournisseur n'a rien
   * prélevé ; quelqu'un le croira et ne reviendra pas vérifier.
   */
  check('un frais INCONNU s’écrit en toutes lettres, jamais « 0,00 € »',
    /Frais en cours de récupération/.test(decompte)
    && /status !== 'SETTLED'|providerCostCents !== null/.test(codeDecompte));
  check('…et le décompte n’est rendu QUE si le fournisseur a parlé',
    /const solde = settlement\.status === 'SETTLED'/.test(codeDecompte));

  check('le décompte est monté dans la LISTE',
    /<SettlementBreakdown[\s\S]{0,120}compact/.test(code2(workspace)));
  check('…et dans le DÉTAIL', /<SettlementBreakdown/.test(code2(detail)));

  /**
   * LE MONTANT DE LA LIGNE N'EST PAS REMPLACÉ. La colonne « Montant » rend
   * toujours `amountCents` : c'est lui qui fait le chiffre d'affaires.
   */
  check('le montant de la ligne reste le BRUT du mouvement',
    /formatFlowCents\(ligne\.amountCents, ligne\.flow\)/.test(code2(workspace)));

  check('aucun champ « stripe… » ne traverse l’écran',
    !/stripeFee|stripeCost|fraisStripe/i.test(codeDecompte));
}

section('L13. Les cartes disent que la commission est un COÛT, pas un revenu');
{
  const codeWorkspace = code2(workspace);
  check('« Revenus » reste le total de la CATÉGORIE revenu — donc le brut',
    /summary\.byCategory\.revenueCents/.test(codeWorkspace));
  check('« Coûts » annonce la part des commissions par un « dont »',
    /summary\.costs[\s\S]{0,240}dont \$\{formatCents\(summary\.costs\.providerFeeCents\)\} de commissions/.test(workspace));
  check('…et l’écran ne recompose AUCUN total lui-même',
    !/providerFeeCents \+|costCents \+ /.test(codeWorkspace));
  check('la ventilation n’apparaît pas quand il n’y a rien à ventiler',
    /summary\.costs\.providerFeeCents > 0/.test(codeWorkspace));
}

section('L13. Le détail sépare le commercial, l’encaissement et la preuve');
{
  const codeDetail = code2(detail);
  check('les informations commerciales sont un bloc à part',
    /Informations commerciales/.test(detail)
    && /transaction\.fiscal\.netExcludingTaxCents/.test(codeDetail)
    && /transaction\.fiscal\.taxCents/.test(codeDetail));
  check('…et ne s’affichent QUE si le document les portait',
    /transaction\.fiscal \?/.test(codeDetail));

  check('le résultat de l’encaissement est un bloc à part',
    /Résultat de l’encaissement/.test(detail));
  check('…qui nomme le fournisseur par sa VALEUR, pas par une constante',
    /transaction\.settlement\.provider/.test(codeDetail));
  check('…et qui donne le pont vers le mouvement de commission',
    /providerCostTransactionId/.test(codeDetail));

  const panneau = lire('frontend/src/components/finance/ProviderFactPanel.tsx');
  check('l’écriture de solde vit dans les identifiants TECHNIQUES, repliés',
    /Écriture de solde/.test(panneau)
    && /balanceTransactionId/.test(code2(panneau)));
  check('…et le motif d’une attente y est lisible',
    /settlement\.status !== 'SETTLED'[\s\S]{0,400}reason/.test(panneau));
}

finish();
