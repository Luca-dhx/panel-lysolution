/**
 * LA REFONTE D'INTERFACE — ce qui doit rester vrai après elle.
 *
 * ══ CE QUE CETTE SUITE PROTÈGE ══════════════════════════════════════════════
 *
 * Quatre écosystèmes d'interface cohabitent désormais dans le Panel : Untitled
 * UI, Bklit, Kokonut UI et Radix Themes. Chacun arrive avec sa palette, sa
 * remise à zéro et ses hypothèses de mise en page. Ce qui les empêche de
 * produire une soupe n'est pas une intention, ce sont des PONTS — trois
 * fichiers CSS qui traduisent leurs vocabulaires vers les quatre couleurs
 * réglables du Panel.
 *
 * Ces contrôles sont STATIQUES et lisent les fichiers. C'est délibéré : les
 * défauts qu'ils ferment ne se voient pas à l'exécution d'un test fonctionnel.
 * Une couleur figée reste une couleur — jusqu'au jour où l'exploitant change de
 * thème et découvre une carte blanche sur un fond noir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
const existe = (rel) => fs.existsSync(path.join(racine, rel));

/** Un fichier privé de ses commentaires : sinon une assertion se valide sur sa propre explication. */
const sansCommentaires = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Les registres sont déclarés, et Claude Code peut les explorer');
{
  const config = JSON.parse(lire('frontend/components.json'));
  check('`components.json` existe et déclare des registres', Boolean(config.registries));
  check('…celui de Bklit', config.registries['@bklit'] === 'https://ui.bklit.com/r/{name}.json');
  check('…celui de Kokonut UI', config.registries['@kokonutui'] === 'https://kokonutui.com/r/{name}.json');
  check('la feuille visée par la CLI est le fichier GÉNÉRÉ, pas la nôtre',
    config.tailwind.css === 'src/styles/registry-generated.css');
  check('les alias pointent le dossier `src`', config.aliases.utils === '@/lib/utils');

  const mcp = JSON.parse(lire('.mcp.json'));
  check('le serveur MCP shadcn est déclaré', Boolean(mcp.mcpServers.shadcn));
  check('…avec le répertoire du frontend', mcp.mcpServers.shadcn.args.includes('frontend'));
  check('le serveur MCP Untitled UI est déclaré', Boolean(mcp.mcpServers.untitledui));
  check('…en HTTP, sur l’adresse officielle',
    mcp.mcpServers.untitledui.url === 'https://www.untitledui.com/react/api/mcp');

  /**
   * AUCUN SECRET DANS LA CONFIGURATION MCP.
   *
   * Les composants PRO d'Untitled UI s'obtiennent par OAuth, que le client
   * gère. Une clef écrite ici serait committée, et un `Authorization: Bearer`
   * en clair dans un dépôt est exactement le genre de motif qu'un scanner
   * reconnaît — à raison.
   */
  const brut = lire('.mcp.json');
  check('aucun jeton, aucune clef dans la configuration MCP',
    !/(bearer|api[-_]?key|token|secret|password)/i.test(brut));

  check('le skill Bklit est installé', existe('.claude/skills/bklit-ui/SKILL.md'));
  check('…et il est PORTABLE — un vrai dossier, pas un lien vers ce poste',
    fs.statSync(path.join(racine, '.claude/skills/bklit-ui')).isDirectory()
    && !fs.lstatSync(path.join(racine, '.claude/skills/bklit-ui')).isSymbolicLink());
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Les ponts : aucune librairie n’impose sa palette');
{
  const bridge = lire('frontend/src/styles/bridge.css');
  const registry = lire('frontend/src/styles/registry.css');
  const radix = lire('frontend/src/styles/radix-scope.css');

  for (const [nom, source] of [
    ['bridge.css (Untitled UI)', bridge],
    ['registry.css (Bklit / Kokonut)', registry],
    ['radix-scope.css (Radix Themes)', radix],
  ]) {
    /**
     * PAS UN SEUL CODE HEXADÉCIMAL.
     *
     * C'est la règle du Panel depuis `tokens.css`, et elle vaut pour les ponts :
     * une teinte écrite ici serait figée sur le thème du jour, et le graphique
     * serait le seul élément de l'écran à ignorer les couleurs choisies.
     */
    const enDur = [...sansCommentaires(source).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    check(`${nom} : aucune couleur en dur (${enDur.join(', ') || 'aucune'})`, enDur.length === 0);
    check(`${nom} : tout dérive des quatre couleurs du thème`, /var\(--p-/.test(source));
  }

  check('la palette des séries est branchée sur le thème',
    /--chart-1:\s*var\(--p-primary\)/.test(registry));
  check('…et les cinq rangs sont définis',
    ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5']
      .every((v) => registry.includes(`${v}:`)));
  check('les variables propres à Bklit sont traduites',
    registry.includes('--chart-tooltip-background:') && registry.includes('--legend-foreground:'));

  /**
   * LE PONT ÉCRASE CE QUE LA CLI DÉPOSE — par l'ordre d'import, pas à la main.
   */
  const entree = lire('frontend/src/styles/uui.css');
  const iGenere = entree.indexOf('./registry-generated.css');
  const iPont = entree.indexOf('./registry.css');
  check('le fichier généré est importé AVANT notre traduction',
    iGenere !== -1 && iPont !== -1 && iGenere < iPont);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Radix est SCOPÉ : aucun écran non refondu ne peut être repeint');
{
  const radix = lire('frontend/src/styles/radix-scope.css');
  check('la feuille complète de Radix n’est PAS importée',
    !radix.includes('@radix-ui/themes/styles.css'));
  check('…seuls les jetons et les composants le sont',
    radix.includes('tokens/base.css') && radix.includes('components.css'));
  // On lit les IMPORTS, pas la prose : le commentaire d'en-tête cite
  // justement ces deux feuilles pour expliquer pourquoi elles restent dehors.
  const importsRadix = [...radix.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
  check('ni les utilitaires ni la mise en page de Radix n’entrent',
    !importsRadix.some((i) => /utilities\.css|layout\.css/.test(i)));

  /**
   * LE CONTENEUR N'EST PAS UNE PAGE.
   *
   * Radix pose `min-height: 100dvh` sur tout conteneur qu'il croit racine. Nos
   * conteneurs sont LOCAUX et n'ont aucun `Theme` parent : chacun se déclarait
   * donc racine et réclamait une hauteur d'écran. Constaté : 450 px de vide
   * dans le bloc des filtres de la page Finances.
   */
  check('la hauteur de « racine » est neutralisée',
    /\.radix-themes\[data-is-root-theme='true'\][\s\S]{0,80}min-height:\s*0/.test(radix));

  const scope = lire('frontend/src/components/radix/RadixScope.tsx');
  check('le conteneur ne peint aucun fond', scope.includes('hasBackground={false}'));
  check('l’apparence est DÉDUITE de la luminance du thème, jamais figée',
    scope.includes('luminance') && scope.includes('--p-background'));
  check('…et recalculée quand le thème change sans rechargement',
    scope.includes('MutationObserver'));

  /**
   * AUCUN `<Theme>` GLOBAL. La racine porte déjà 190 ko de CSS écrit à la main :
   * un cinquième système revendiquant `background`, `color` et la police sur
   * `<body>` aurait repeint les quinze écrans hors périmètre.
   */
  const main = lire('frontend/src/main.tsx');
  const app = lire('frontend/src/App.tsx');
  check('aucun conteneur Radix à la racine de l’application',
    !/@radix-ui\/themes/.test(main) && !/@radix-ui\/themes/.test(app));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Le préflight de Tailwind reste dehors');
{
  const entree = lire('frontend/src/styles/uui.css');
  check('l’import complet de Tailwind — qui embarque le préflight — est écarté',
    !/@import\s+"tailwindcss"\s*;/.test(entree));
  check('…seuls le thème et les utilitaires entrent',
    entree.includes('tailwindcss/theme.css') && entree.includes('tailwindcss/utilities.css'));
  check('la remise à zéro est LOCALE, sous `.uui`', entree.includes(':where(.uui)'));
  check('…et de spécificité nulle, pour que `.btn` gagne toujours',
    /:where\(\.uui\)\s+button/.test(entree));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Les écrans refondus ne fabriquent aucun chiffre');
{
  const dashboard = sansCommentaires(lire('frontend/src/components/finance/FinanceDashboard.tsx'));
  const evolution = sansCommentaires(lire('frontend/src/components/finance/charts/FinanceEvolutionChart.tsx'));
  const breakdown = sansCommentaires(lire('frontend/src/components/finance/charts/FinanceBreakdownChart.tsx'));

  /**
   * AUCUNE SOMME DE LIGNES PAGINÉES.
   *
   * La liste est bornée par `limit` : additionner ses items donnerait un total
   * plausible et faux. Tous les agrégats viennent de `/summary` et
   * `/by-project`, calculés par le serveur sur l'ENSEMBLE du périmètre.
   */
  for (const [nom, source] of [
    ['FinanceDashboard', dashboard],
    ['FinanceEvolutionChart', evolution],
    ['FinanceBreakdownChart', breakdown],
  ]) {
    check(`${nom} : aucune addition de \`list.items\``,
      !/list\.items[\s\S]{0,120}reduce/.test(source));
    check(`${nom} : aucune division par cent hors des formateurs`,
      !/\/\s*100\b/.test(source));
  }

  check('la tendance est demandée au SERVEUR, sur la fenêtre précédente',
    dashboard.includes('previousWindow') && dashboard.includes("period: 'CUSTOM'"));

  /**
   * AUCUNE DONNÉE DE DÉMONSTRATION.
   *
   * Les exemples de Bklit et d'Untitled UI vivent sur des jeux fictifs. Ils
   * servent à comprendre l'API ; en laisser un dans l'application afficherait
   * des chiffres inventés sous un titre sérieux.
   */
  const ecrans = [
    'frontend/src/pages/FinancesPage.tsx',
    'frontend/src/pages/ProjectsPage.tsx',
    'frontend/src/pages/ClientCompaniesPage.tsx',
    'frontend/src/components/finance/FinanceDashboard.tsx',
    'frontend/src/components/projects/ProjectsTable.tsx',
    'frontend/src/components/company/ClientCompaniesTable.tsx',
  ];
  for (const rel of ecrans) {
    const source = lire(rel);
    check(`${path.basename(rel)} : aucun jeu de démonstration importé`,
      !/customers\.json|table\/customers|placeholder-data|mock/i.test(source));
  }

  check('aucun composant d’exemple Bklit n’a été installé',
    !existe('frontend/src/components/charts/area-chart-example.tsx'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Les paliers responsive se calent sur la largeur du CONTENU');
{
  /**
   * ══ LE PIÈGE QUE CES CONTRÔLES FERMENT ═════════════════════════════════════
   *
   * La barre latérale du Panel reprend 250 px dès 900 px de fenêtre. Il y a
   * donc MOINS de place utile à 900 px (≈ 570 px) qu'à 768 px, où elle est
   * encore un tiroir. Un palier posé au réflexe `md:` fait déborder le tableau
   * juste après le seuil du tiroir — sur la seule largeur où personne ne pense
   * à regarder.
   *
   * Les colonnes sortent donc à `sm`, `lg`, `xl` ou `2xl`. On interdit ici
   * `md:table-cell`, qui est la forme exacte du défaut.
   */
  const tableaux = [
    'frontend/src/components/prospection/ProspectsTable.tsx',
    'frontend/src/components/projects/ProjectsTable.tsx',
    'frontend/src/components/company/ClientCompaniesTable.tsx',
  ];
  for (const rel of tableaux) {
    const source = lire(rel);
    check(`${path.basename(rel)} : aucune colonne n’apparaît au palier « md »`,
      !/md:table-cell/.test(source));
    check(`${path.basename(rel)} : le cadre défile, pas la page`,
      source.includes('TableCard.Root'));
    /*
      Deux formes légitimes : un `EmptyPanel` posé à la place du tableau quand
      la liste entière est vide, ou le `renderEmptyState` de React Aria quand
      seul le filtre ne ramène rien. Les deux disent quelque chose ; c'est le
      silence qu'on interdit.
    */
    check(`${path.basename(rel)} : un état vide est prévu`,
      source.includes('EmptyPanel') || source.includes('renderEmptyState'));
  }

  const entete = lire('frontend/src/components/ui-kit/Panel.tsx');
  check('l’en-tête d’un bloc ne passe en ligne qu’à 1024 px',
    entete.includes('lg:flex-row'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Les trois états, et l’accessibilité des nouveaux contrôles');
{
  const etats = lire('frontend/src/components/ui-kit/States.tsx');
  check('l’attente est structurelle (squelette), jamais un tourniquet',
    etats.includes('Skeleton') && !/spinner/i.test(etats));
  check('le squelette est annoncé', etats.includes('aria-busy'));
  check('une erreur reste réparable quand l’appelant sait réessayer',
    etats.includes('onRetry'));
  check('un vide peut porter une action', etats.includes('action'));

  const onglets = lire('frontend/src/components/ui-kit/SmoothTabs.tsx');
  check('les onglets portent les rôles ARIA',
    onglets.includes('role="tablist"') && onglets.includes('role="tab"'));
  check('…un seul arrêt de tabulation pour le groupe',
    onglets.includes('tabIndex={actif ? 0 : -1}'));
  check('…et les flèches changent d’onglet',
    onglets.includes("'ArrowRight'") && onglets.includes("'ArrowLeft'"));

  const periode = lire('frontend/src/components/ui-kit/PeriodPicker.tsx');
  check('le choix de période est un contrôle segmenté accessible',
    periode.includes('SegmentedControl') && periode.includes('aria-label="Période"'));
  check('…et il ne calcule aucune fenêtre lui-même',
    !/Date\.now\(\)/.test(sansCommentaires(periode)));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. Le poids : les écrans lourds sont chargés à la demande');
{
  const app = lire('frontend/src/App.tsx');
  for (const ecran of [
    'FinancesPage', 'ProjectsPage', 'ProjectDetailPage',
    'ClientCompaniesPage', 'ClientCompanyDetailPage',
  ]) {
    check(`${ecran} est chargé à la demande`,
      new RegExp(`const ${ecran} = lazy\\(`).test(app));
  }

  const layout = lire('frontend/src/components/Layout.tsx');
  check('une frontière d’attente existe, DANS le gabarit',
    layout.includes('<Suspense') && layout.includes('<Outlet />'));

  const dashboard = lire('frontend/src/components/finance/FinanceDashboard.tsx');
  check('les graphiques eux-mêmes sont chargés à la demande',
    /lazy\(\(\) => import\('\.\/charts\/FinanceEvolutionChart'\)\)/.test(dashboard));
}

section('9. Aucune classe n’est posée sans exister');
{
  /**
   * CE QUE CE CONTROLE FERME.
   *
   * `.input` et `.form-actions` etaient ecrites sur onze controles de la
   * famille « entreprise cliente » sans qu'aucune regle ne les definisse. Les
   * champs de texte s'en tiraient par le selecteur d'element ; un `<select>`,
   * lui, sortait au rendu brut du navigateur ET DIMENSIONNE PAR SA PLUS LONGUE
   * OPTION.
   *
   * Releve sur l'instance deployee, a 320 px : le selecteur d'entreprise de la
   * fiche projet mesurait 334 px et poussait le document a 371 px. Le defaut
   * grandissait avec les donnees -- une raison sociale plus longue l'aggravait.
   */
  const css = lire('frontend/src/components.css') + '\n' + lire('frontend/src/styles.css');
  const utilisees = ['input', 'form-actions'];
  for (const classe of utilisees) {
    check(`« ${classe} » est posée ET définie`,
      new RegExp(`\\.${classe}\\s*(,|\\{|:)`).test(css));
  }

  /**
   * LES DEUX MOITIES DU CORRECTIF. `max-width` seul ne peut rien : la largeur
   * minimale intrinseque d'un select reste celle de son contenu tant que
   * `min-width` vaut auto.
   */
  /*
    L'ancrage en debut de ligne n'est pas un detail : `.conn-search .input {`
    contient la meme sous-chaine, vit plus haut dans le fichier, et une
    recherche naive lisait donc 400 caracteres d'une regle sans rapport.
  */
  const regleInput = (css.match(/^\.input \{[^}]*\}/m) || [''])[0];
  check('…et un select ne peut plus dépasser son conteneur',
    /min-width:\s*0/.test(regleInput) && /max-width:\s*100%/.test(regleInput));

  check('…les actions se replient au lieu de déborder',
    /\.form-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(css));

  /**
   * ET LA REGLE RESTE DANS LE VOCABULAIRE DU PANEL : pas un code hexadecimal,
   * sinon le controle change de couleur avec le theme et pas le reste.
   */
  check('…sans une seule couleur en dur', !/#[0-9a-fA-F]{3,8}/.test(regleInput));
}

section('10. La mention d’un projet disparu n’existe qu’en un endroit');
{
  /**
   * `ownershipLabel` nomme le rattachement dans le registre, dans la fiche d'un
   * mouvement et dans la liste des couts recurrents ; `toBreakdownRows` le
   * nomme dans le graphique de repartition. Les deux doivent lire la MEME
   * fonction : deux copies identiques finissent toujours par diverger, et le
   * meme projet se lirait alors sous deux libelles selon l'ecran.
   */
  const etiquettes = lire('frontend/src/components/finance/financeLabels.ts');
  const pur = lire('frontend/src/lib/financeAnalytics.ts');

  check('la règle vit dans la couche pure',
    /export function missingProjectLabel/.test(pur));
  check('…le graphique de répartition la lit',
    /\?\? missingProjectLabel\(ligne\.projectId\)/.test(pur));
  check('…les libellés la lisent aussi',
    /import \{ missingProjectLabel \} from '@\/lib\/financeAnalytics'/.test(etiquettes)
    && /\?\? missingProjectLabel\(projectId\)/.test(etiquettes));
  check('…et personne n’en garde une copie',
    !/Projet supprimé —/.test(etiquettes));
}

section('11. Les graphiques parlent français, comme le reste du Panel');
{
  /**
   * -- CE QUE LE REGISTRE LIVRE, ET POURQUOI ON LE CHANGE --------------------
   *
   * `@bklit` livre ses formateurs en `en-US`. Constate en production sur
   * l'ecran financier :
   *
   *     axe horizontal   Feb 1 · Feb 15 · Feb 28
   *     tableau dessous  01 fevr. · 15 fevr. · 28 fevr.
   *
   * Les deux decrivent les MEMES seaux. Un lecteur qui les compare se demande
   * legitimement s'il regarde la meme chose.
   *
   * `intFmt` comptait autant : le separateur anglais des milliers est le
   * separateur francais des DECIMALES. Sur des montants, la confusion n'est
   * pas cosmetique.
   */
  const formateurs = lire('frontend/src/components/charts/chart-formatters.ts');
  check('les formateurs des graphiques sont en français',
    !/["']en-US["']/.test(formateurs) && /["']fr-FR["']/.test(formateurs));
  check('…les quatre, pas seulement celui des dates',
    (formateurs.match(/LOCALE/g) || []).length >= 4);

  /**
   * ET LE COMPOSANT NE REPASSE PAS PAR UN FORMATEUR ANGLAIS EN DOUBLE : ses
   * propres etiquettes viennent du module pur, deja localise.
   */
  const graphique = lire('frontend/src/components/finance/charts/FinanceEvolutionChart.tsx');
  check('le graphique financier n’embarque aucune locale en dur',
    !/en-US|en-GB/.test(graphique));

  /**
   * -- UN TABLEAU MASQUE DOIT ETRE ENVELOPPE DANS UN BLOC --------------------
   *
   * `sr-only` sort l'element du flux et le reduit a un pixel. Elle ne CLIPPE
   * pourtant pas un `<table>` : `overflow: hidden` sur une boite de type table
   * n'est pas honore comme sur un bloc, et la zone de defilement d'un element
   * positionne en absolu remonte quand meme a son bloc conteneur.
   *
   * Releve sur l'instance deployee, a 1024 px : la legende du tableau mesurait
   * 894 px en `white-space: nowrap`, et le document passait a 1167 px pour une
   * fenetre de 1024. Le defaut est apparu quand l'axe est devenu complet -- un
   * tableau d'une seule ligne tenait sous la fenetre.
   */
  check('le tableau accessible est enveloppé dans un bloc qui clippe',
    /<div className="sr-only">\s*<table>/.test(graphique)
    && !/<table className="sr-only">/.test(graphique));
}

section('12. Un onglet déclaré est un onglet ATTEIGNABLE');
{
  /**
   * -- LE DEFAUT QUE CE CONTROLE FERME --------------------------------------
   *
   * L'onglet de la fiche projet vit dans l'URL, et sa valeur est VALIDEE
   * contre une liste close avant d'etre acceptee : une valeur inconnue retombe
   * sur « Vue d'ensemble », ce qui est la bonne facon de traiter une URL
   * bricolee a la main.
   *
   * La contrepartie est qu'un onglet ajoute a la barre SANS etre ajoute a la
   * liste devient inatteignable -- et en silence. Constate sur l'instance
   * deployee : l'onglet « Taches » s'affichait, se cliquait, et ne se
   * selectionnait jamais.
   *
   * Le controle compare donc les DEUX sources : ce que la barre propose, et ce
   * que l'URL accepte.
   */
  const fiche = lire('frontend/src/pages/ProjectDetailPage.tsx');

  const declares = [...fiche.matchAll(/\{ value: '([a-z]+)' as const, label:/g)].map((m) => m[1]);
  const acceptes = (fiche.match(/const TABS: Tab\[\] = \[([^\]]+)\]/) || [, ''])[1]
    .split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean);

  check('la barre déclare au moins cinq onglets', declares.length >= 5);
  const manquants = declares.filter((v) => !acceptes.includes(v));
  check(`chaque onglet déclaré est accepté par l’URL${manquants.length ? ` — absents : ${manquants.join(', ')}` : ''}`,
    manquants.length === 0);

  const orphelins = acceptes.filter((v) => !declares.includes(v));
  /*
    L'INVERSE COMPTE AUSSI : une valeur acceptee que la barre ne propose plus
    laisse une URL vivante vers un onglet qui n'existe pas, et l'ecran rend
    alors une page vide sans rien dire.
  */
  check(`…et chaque valeur acceptée est proposée${orphelins.length ? ` — orphelines : ${orphelins.join(', ')}` : ''}`,
    orphelins.length === 0);
}

section('13. Les tâches : deux décisions, deux couleurs, et un choix multiple');
{
  const carte = lire('frontend/src/components/tasks/TaskCard.tsx');
  const picker = lire('frontend/src/components/tasks/TaskLinkPicker.tsx');
  const css = lire('frontend/src/components.css');

  /**
   * -- LES DEUX DECISIONS D'UNE TACHE ECHUE ---------------------------------
   *
   * Une echeance passee pose exactement deux questions -- « c'est fait ? » ou
   * « on repousse ? » -- et ce sont deux reponses OPPOSEES. Les peindre du meme
   * gris obligeait a lire les deux libelles avant de cliquer, a chaque fois.
   */
  check('« Fait » et « Reporter » portent chacun sa couleur',
    /className=\{VERT\}/.test(carte) && /className=\{ORANGE\}/.test(carte));
  check('…et chacun son icône',
    /iconLeading=\{\(\) => <Icon name="check2" \/>\}/.test(carte)
    && /iconLeading=\{\(\) => <Icon name="clock" \/>\}/.test(carte));

  /**
   * LA TEINTE DE SURVOL DOIT EXISTER. Un bouton dont le survol ne repond pas se
   * lit comme un bouton mort -- et c'est exactement ce que produisait
   * `hover:bg-utility-green-600`, qui n'etait emis dans AUCUNE des feuilles.
   */
  check('les deux styles sont de vraies règles, pas des utilitaires absents',
    /button\.task-btn-done\s*\{/.test(css) && /button\.task-btn-postpone\s*\{/.test(css)
    && /button\.task-btn-done:hover/.test(css) && /button\.task-btn-postpone:hover/.test(css));
  /**
   * LE SELECTEUR PORTE LA BALISE, ET C'EST LA MOITIE QUI COMPTE.
   *
   * `.task-btn-done` seul PERDAIT : les utilitaires Tailwind sont importes
   * APRES `components.css`, et a specificite egale -- une classe contre une
   * classe -- c'est l'ordre qui tranche. Le bouton sortait bleu, la couleur de
   * `primary`. Constate sur l'instance deployee : `rgb(59, 130, 246)` sur les
   * deux boutons, alors que les regles etaient bien emises.
   */
  check('…et leur sélecteur porte la balise, sinon Tailwind l’emporte',
    !/(^|[^n])\.task-btn-done\s*[,{]/m.test(css.replace(/button\.task-btn-done/g, 'BTNDONE')));
  /* ET DANS LE VOCABULAIRE DU PANEL : sinon les boutons ne suivraient pas le
     theme, et seuls eux resteraient de la couleur d'hier. */
  const regles = (css.match(/\.task-btn-[\s\S]*?$/) || [''])[0];
  check('…sans une seule couleur en dur',
    /var\(--p-ok\)/.test(regles) && /var\(--p-warn\)/.test(regles)
    && !/#[0-9a-fA-F]{3,8}/.test(regles));

  /**
   * EDITER EST ATTEIGNABLE DEPUIS LA CARTE, donc depuis « Voir » -- tableau de
   * bord compris. Corriger un mot dans un intitule ne doit pas obliger a
   * quitter l'ecran pour y revenir.
   */
  check('la carte propose « Éditer »', /Éditer/.test(carte));
  const bord = lire('frontend/src/components/tasks/UpcomingTasksPanel.tsx');
  check('…et le tableau de bord la câble à un formulaire',
    /onEdit=\{\(\) => \{ setEnEdition\(ouverte\); setOuverte\(null\); \}\}/.test(bord)
    && /<TaskForm/.test(bord));

  /**
   * -- LE RATTACHEMENT : UN TABLEAU, PUIS DES CASES A COCHER -----------------
   *
   * Quatre familles, quatre lignes. Cliquer ouvre un selecteur sur CETTE
   * famille. Des cases plutot qu'une liste cliquable, parce qu'on en choisit
   * PLUSIEURS : une case cochee porte son etat sur elle.
   */
  check('les rattachements se présentent en tableau',
    /<table/.test(picker) && /<thead>/.test(picker) && /scope="row"/.test(picker));
  check('…une ligne par famille, ouvrant un sélecteur',
    /setOuverte\(kind\)/.test(picker) && /<SelecteurFamille/.test(picker));
  check('…et le sélecteur coche, il ne clique pas',
    /<Checkbox/.test(picker) && /isSelected=\{choisis\.includes\(o\.id\)\}/.test(picker));
  /* CE QUI EST DEJA CHOISI REMONTE EN TETE : sur deux cents lignes, on ne
     retrouve pas autrement ce qu'on vient de cocher. */
  check('…ce qui est coché remonte en tête', /listes\.coches\.map\(ligne\)/.test(picker));
}

section('14. La liste des prospects : sélection, rangement, et aucune surprise');
{
  const tableau = lire('frontend/src/components/prospection/ProspectsTable.tsx');
  const page = lire('frontend/src/pages/ProspectionPage.tsx');
  const move = lire('frontend/src/components/prospection/MoveDialog.tsx');

  /**
   * -- LE DEFAUT QUE CE CONTROLE FERME --------------------------------------
   *
   * Les colonnes sortaient a `xl:` et `2xl:` -- des paliers de FENETRE. Or ce
   * tableau ne dispose jamais de la fenetre : la page du Panel est bornee a
   * 1200 px, la barre laterale en prend 250 et l'arbre des dossiers 224.
   *
   * Mesure sur l'instance deployee, arbre ouvert : 1241 px de tableau pour
   * 1128 px de place a 1920 de fenetre. Il defilait lateralement A TOUTES les
   * largeurs de bureau -- et un tableau qu'il faut faire defiler pour lire une
   * colonne est un tableau dont la moitie n'existe pas.
   */
  check('les paliers du tableau suivent le CONTENEUR',
    /className="uui @container"/.test(tableau));
  const paliersFenetre = tableau.match(/(?<![@\w-])(sm|md|lg|xl|2xl):(table-cell|hidden)/g) || [];
  check(`aucun palier de FENÊTRE ne masque une colonne${paliersFenetre.length ? ` — ${paliersFenetre.join(', ')}` : ''}`,
    paliersFenetre.length === 0);

  /**
   * LA CASE A COCHER EST CELLE DE LA LIBRAIRIE : `selectionMode` suffit, et
   * React Aria pose la colonne, la case « tout cocher », `aria-selected` et la
   * selection au clavier. Une colonne maison aurait tout laisse a faire.
   */
  check('les lignes se cochent', /selectionMode=\{onSelectionChange \? 'multiple' : 'none'\}/.test(tableau));
  /*
    « TOUT COCHER » NE COCHE QUE CE QUE LE FILTRE MONTRE. Armer une suppression
    sur des fiches qu'on ne voit pas serait le pire des pieges.
  */
  check('…et « tout cocher » ne dépasse jamais le filtre',
    /k === 'all' \? new Set\(filtres\.map\(\(p\) => p\._id\)\) : k/.test(page));

  /**
   * LA BARRE N'EXISTE QUE LORSQU'UNE CASE EST COCHEE. Presente en permanence et
   * grisee, elle occuperait une ligne a ne rien dire, et l'oeil apprendrait a
   * ne plus la lire.
   */
  check('la barre d’actions n’apparaît qu’avec une sélection',
    /\{selectionnes\.length > 0 \? \(/.test(page));
  check('…et ses deux actions portent leur icône',
    /iconLeading=\{FolderCheck\}/.test(page) && /iconLeading=\{Trash01\}/.test(page));

  /** DEPLACER EST UN RANGEMENT, pas une modification : entree propre. */
  check('le menu de ligne propose « Déplacer »',
    /icon=\{FolderCheck\}/.test(tableau) && /textValue="Déplacer"/.test(tableau));
  /* « SANS DOSSIER » EST UNE DESTINATION : sortir une fiche d'un dossier est un
     geste courant, et sans elle il faudrait supprimer le dossier. */
  check('…et « Sans dossier » est une destination',
    /ligne\(null, 'Sans dossier'/.test(move));

  /**
   * AUCUNE SUPPRESSION SANS CONFIRMATION. Celle du groupe NOMME les fiches :
   * « 12 prospects » ne permet pas de verifier qu'on a coche ce qu'on croit.
   */
  check('la suppression groupée passe par une confirmation',
    /\{suppressionGroupee \? \(/.test(page) && /Supprimer \$\{selectionnes\.length\}/.test(page));
  check('…qui NOMME les fiches concernées',
    /selectionnes\.slice\(0, 8\)\.map/.test(page));
  /* Le bouton de la barre OUVRE la confirmation ; il ne supprime jamais. */
  check('…et le bouton de la barre ne supprime pas directement',
    /onClick=\{\(\) => setSuppressionGroupee\(true\)\}/.test(page));
}

finish();
