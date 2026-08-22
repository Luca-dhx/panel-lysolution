/**
 * LA REFONTE « CLIENTS » — ce qu'elle promet, et ce qu'elle interdit.
 *
 * ══ POURQUOI UNE SUITE QUI LIT DES SOURCES ══════════════════════════════════
 *
 * Parce que ce lot est UI, et que l'essentiel de ce qu'il garantit ne se
 * démontre pas par un appel HTTP : qu'aucun `<select>` natif n'ait survécu,
 * qu'aucune couleur ne soit écrite en dur, qu'un bouton porte un nom
 * accessible, que le mode édition n'ouvre pas de fenêtre. Ce sont des
 * propriétés du CODE — et ce sont exactement celles qui se perdent
 * silencieusement au prochain « petit ajustement ».
 *
 * Le Panel n'embarque aucun moteur de rendu de composants : monter React dans
 * une suite Node exigerait jsdom, testing-library et leur arbre de
 * dépendances, dans un projet qui n'a pour tout front que React et son
 * routeur. On lit donc la source, et on éprouve par HTTP les seules choses qui
 * traversent l'API — l'appartenance d'un projet et l'attribution des erreurs
 * de validation, qui sont les deux ajustements que cette refonte a exigés.
 *
 * ══ CE QUI EST VÉRIFIÉ ══════════════════════════════════════════════════════
 *
 *   · la liste n'est plus un tableau, et chaque item porte icône + bouton ;
 *   · la barre d'actions ouvre par « Nouvelle entreprise », suivie de la case ;
 *   · la case à cocher est CELLE du design system, et il n'y en a qu'une ;
 *   · « Modifier » ne monte aucune modale — l'édition est en ligne ;
 *   · les erreurs sont posées sous leur champ, et le serveur nomme ce champ ;
 *   · le sélecteur de projet n'est pas natif, et n'offre que les projets LIBRES ;
 *   · le retrait d'un projet se confirme ;
 *   · aucune couleur en dur, et un point d'arrêt mobile existe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');

await seedFromEnv();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

/**
 * LE CODE SEUL — commentaires et chaînes JSX de prose retirés.
 *
 * ══ POURQUOI CE HELPER EXISTE ════════════════════════════════════════════
 *
 * Une assertion d’ABSENCE (« aucun `<select>` natif ne subsiste ») lit
 * naïvement toute la source — commentaires compris. Or ce dépôt EXPLIQUE ce
 * qu’il a retiré : « LE SÉLECTEUR REMPLACE UN `<select>` NATIF » est écrit
 * juste au-dessus du composant qui le remplace.
 *
 * La preuve échouait donc précisément parce que le travail avait été fait ET
 * documenté — et la seule façon de la faire passer aurait été d’effacer
 * l’explication. C’est exactement le mauvais incitatif.
 */
function codeSeul(source) {
  return source
    // Les blocs `/* … */` — ce qui couvre AUSSI les commentaires JSX, qui sont
    // un bloc enveloppé d'accolades. C'est là que vit toute la prose de ce dépôt.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Les lignes `// …`, uniquement quand elles ouvrent la ligne : couper à un
    // `//` en milieu de ligne mutilerait une URL ou une expression régulière.
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const LISTE_CODE = () => codeSeul(LISTE);
const FICHE_CODE = () => codeSeul(FICHE);
const UI_CODE = () => codeSeul(UI);

const LISTE = lire('frontend/src/pages/ClientCompaniesPage.tsx');
const FICHE = lire('frontend/src/pages/ClientCompanyDetailPage.tsx');
const UI = lire('frontend/src/components/ui.tsx');
const SELECT = lire('frontend/src/components/ThemedSelect.tsx');
const CSS = lire('frontend/src/components.css');
const ICONES = lire('frontend/src/components/Icon.tsx');

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. La liste : des items, pas un tableau');
{
  /**
   * LE TABLEAU EST PARTI, ET C'EST LE POINT DE DÉPART DU LOT.
   * Un `<td>` n'a pas d'espacement propre : tout ce qu'on y met se touche.
   */
  check('aucun <table> ne subsiste sur la page Clients', !/<table/.test(LISTE_CODE()));
  check('…ni <thead>, ni <th>', !/<thead|<th>/.test(LISTE_CODE()));
  check('la liste est une <ul> d’items', /className="cc-list"/.test(LISTE));

  check('chaque item porte une icône d’entreprise', /cc-item-avatar[\s\S]{0,200}name="building"/.test(LISTE));
  /**
   * L'ICÔNE DOUBLE UN NOM DÉJÀ LISIBLE : l'annoncer ferait entendre « image,
   * bâtiment » avant chaque entreprise, à chaque ligne.
   */
  check('…décorative, masquée aux lecteurs d’écran',
    /cc-item-avatar" aria-hidden="true"/.test(LISTE));

  check('l’identité, les métadonnées et les badges sont trois blocs distincts',
    /cc-item-identity/.test(LISTE) && /cc-item-meta/.test(LISTE) && /cc-item-badges/.test(LISTE));

  check('les deux verdicts sont affichés séparément',
    /titre="Paiements"/.test(LISTE) && /titre="Signatures"/.test(LISTE));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Le bouton « Voir »');
{
  check('chaque item porte une action « Voir »', /cc-item-action/.test(LISTE) && />\s*Voir/.test(LISTE));
  check('…avec un chevron', /cc-item-action[\s\S]{0,300}name="chevron-right"/.test(LISTE));
  /**
   * UN LIEN, PEINT EN BOUTON. Le clic milieu, l'ouverture dans un onglet et
   * l'aperçu de la destination au survol sont des comportements du navigateur :
   * un `<button onClick>` les perd tous, silencieusement.
   */
  check('…c’est un LIEN, pas un bouton qui navigue',
    /<Link[\s\S]{0,300}cc-item-action/.test(LISTE));
  /**
   * Dans une liste de dix boutons « Voir », un lecteur d'écran doit pouvoir
   * dire lequel mène où.
   */
  check('…nommé par l’entreprise qu’il ouvre',
    /aria-label=\{`Voir la fiche de \$\{row\.legalName\}`\}/.test(LISTE));

  /**
   * L'ITEM ENTIER N'EST PAS CLIQUABLE : il contient du texte qu'on sélectionne
   * et un badge à infobulle. Un bloc cliquable ferait naviguer au moindre
   * glissement pendant une sélection.
   */
  check('l’item entier n’est PAS une cible de navigation',
    !/<li[^>]*onClick/.test(LISTE_CODE()) && !/cc-item"[\s\S]{0,60}onClick/.test(LISTE_CODE()));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. La barre d’actions : l’action d’abord, le filtre ensuite');
{
  const barre = LISTE.slice(LISTE.indexOf('cc-toolbar-actions'), LISTE.indexOf('</div>', LISTE.indexOf('cc-toolbar-actions')) + 200);
  const posBouton = barre.indexOf('Nouvelle entreprise');
  const posCase = barre.indexOf('<Checkbox');
  check('« Nouvelle entreprise » est présent dans la barre', posBouton >= 0);
  check('…la case à cocher aussi', posCase >= 0);
  /**
   * L'ORDRE N'EST PAS COSMÉTIQUE : le geste le plus structurant de la page
   * était rangé tout à droite, c'est-à-dire là où l'œil arrive en dernier.
   */
  check('…et le bouton vient AVANT la case', posBouton >= 0 && posCase > posBouton);
  check('le bouton porte l’icône « ajouter »', /Nouvelle entreprise/.test(LISTE) && /name="plus-lg"/.test(LISTE));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. La case à cocher est celle du design system — et il n’y en a qu’une');
{
  check('un composant Checkbox est exporté par le design system', /export function Checkbox\(/.test(UI));
  /**
   * L'`<input>` NATIF EST CONSERVÉ, simplement invisible : c'est lui qui porte
   * l'état, le focus, la touche Espace et l'annonce. Un `<div role="checkbox">`
   * aurait exigé de tout réécrire — et d'en oublier au moins une partie.
   */
  check('…bâtie sur un <input> natif, jamais sur un div role="checkbox"',
    /type="checkbox"/.test(UI) && !/role="checkbox"/.test(UI_CODE()));
  check('…dont le libellé entier est cliquable (label enveloppant)',
    /<label className=\{disabled \? 'checkbox checkbox-disabled' : 'checkbox'\}>/.test(UI));

  check('la page Clients n’utilise plus de case native',
    !/type="checkbox"/.test(LISTE_CODE()));
  check('…ni la fiche', !/type="checkbox"/.test(FICHE_CODE()));

  /* Le focus doit se voir SUR LA PEINTURE, puisque l'input ne se voit pas. */
  check('le focus clavier est visible', /\.checkbox-input:focus-visible \+ \.checkbox-box/.test(CSS));
  check('…et l’état coché est peint', /\.checkbox-input:checked \+ \.checkbox-box/.test(CSS));
  /**
   * `display: none` retirerait l'input du flux — donc du parcours clavier.
   * L'invisibilité doit être visuelle, jamais structurelle.
   */
  const bloc = CSS.slice(CSS.indexOf('.checkbox-input {'), CSS.indexOf('.checkbox-box {'));
  check('…sans jamais retirer l’input du parcours clavier', !/display:\s*none/.test(bloc));

  /* « Ne pas inventer une deuxième checkbox custom. » */
  const definitions = [...CSS.matchAll(/^\.checkbox \{/gm)].length;
  check('il n’existe qu’UNE case personnalisée dans la feuille', definitions === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. La fiche : des sections illustrées');
{
  check('un composant de section porte une icône', /function Section\(\{[\s\S]{0,200}icon: IconName/.test(FICHE));
  for (const [titre, icone] of [
    ['Identité', 'building'],
    ['Coordonnées', 'geo-alt'],
    ['Facturation', 'credit-card'],
    ['Signataire contractuel', 'person'],
    ['Projets rattachés', 'stack'],
    ['Documents', 'file-earmark-text'],
  ]) {
    check(`section « ${titre} » illustrée par « ${icone} »`,
      new RegExp(`icon="${icone}"[\\s\\S]{0,120}titre="${titre}"`).test(FICHE));
  }
  /* Un nom d'icône absent du jeu rendrait `null` — une section sans pastille. */
  for (const icone of ['building', 'geo-alt', 'credit-card', 'person', 'stack', 'file-earmark-text', 'chevron-right', 'pencil', 'plus-lg', 'x-lg', 'check2', 'search']) {
    check(`…et « ${icone} » existe réellement dans le jeu`,
      new RegExp(`^\\s+'?${icone}'?:`, 'm').test(ICONES));
  }
  check('l’en-tête porte l’identité, ses badges et ses actions',
    /cc-hero-identity/.test(FICHE) && /cc-hero-badges/.test(FICHE) && /cc-hero-actions/.test(FICHE));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. « Modifier » n’ouvre AUCUNE fenêtre');
{
  /**
   * ══ CE QUE LA MODALE COÛTAIT ═══════════════════════════════════════════
   *
   * On ouvrait une modale pour corriger un SIREN, et la fiche — dont la
   * bannière dit précisément CE QUI manque — passait derrière un voile. On
   * corrigeait de mémoire, dans une grille de formulaire où plus rien n'était
   * à la place où on venait de le lire.
   */
  const bouton = FICHE.indexOf('onClick={ouvrirEdition}');
  check('le bouton « Modifier » existe', bouton > 0);
  check('…et il bascule un état, il n’ouvre pas de modale',
    /const ouvrirEdition = \(\) => \{[\s\S]{0,200}setEdition\(formulaireDepuis\(fiche\)\)/.test(FICHE));

  /**
   * Les modales restantes sont LÉGITIMES et nommément identifiées : la
   * confirmation d'un retrait et le dépôt d'un fichier. Ce ne sont pas des
   * éditions de la fiche.
   */
  const modales = [...FICHE.matchAll(/\{(\w+) \? \(\s*<Modal/g)].map((m) => m[1]);
  check(`les seules modales sont la confirmation et le dépôt (${modales.join(', ') || 'aucune'})`,
    modales.length === 2 && modales.includes('aRetirer') && modales.includes('depot'));
  check('…aucune n’est déclenchée par l’édition', !modales.includes('edition'));

  /* Le formulaire complet n'est plus monté sur la fiche : ce sont ses lignes
     qui deviennent des champs, à leur place. */
  /*
    Le délimiteur n’est pas un détail : `<ClientCompanyForm` est aussi le
    PRÉFIXE de `useState<ClientCompanyFormValue>`, une annotation de type
    parfaitement légitime. Sans lui, l’assertion accusait le typage.
  */
  check('le formulaire monolithique n’est plus monté sur la fiche',
    !/<ClientCompanyForm[s/>]/.test(FICHE_CODE()));

  check('en édition, le bouton devient Annuler + Enregistrer',
    /onClick=\{annulerEdition\}/.test(FICHE) && /onClick=\{enregistrer\}/.test(FICHE));
  /**
   * ANNULER N'A RIEN À DÉFAIRE : le brouillon vit dans `edition`, la vérité
   * dans `fiche`. Abandonner, c'est jeter le brouillon.
   */
  check('…et Annuler rend les valeurs d’origine sans écrire',
    /const annulerEdition = \(\) => \{\s*setEdition\(null\);/.test(FICHE));
  check('…Enregistrer repasse la fiche en lecture', /setFiche\(resultat\.clientCompany\);\s*setEdition\(null\)/.test(FICHE));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. L’édition est EN LIGNE — la fiche ne saute pas');
{
  /**
   * LE LIBELLÉ NE BOUGE JAMAIS. Une seule ligne rend soit un texte, soit un
   * champ, au même endroit et dans la même colonne. C'est ce qui permet de
   * retrouver la ligne qu'on regardait.
   */
  check('une même ligne rend soit une valeur, soit un champ',
    /className="cc-field-value"/.test(FICHE) && /className="input cc-field-input"/.test(FICHE));
  check('…le libellé garde sa colonne dans les deux états',
    /\.cc-field \{[\s\S]{0,220}grid-template-columns/.test(CSS));
  check('…et le champ occupe la colonne de la valeur',
    /\.cc-field-input \{[\s\S]{0,120}grid-column: 2;/.test(CSS));

  /* Le champ est plus haut qu'un texte : une ligne de base commune ferait
     remonter le libellé au moment de la bascule. */
  check('l’alignement s’adapte à la hauteur d’un champ',
    /\.cc-field-editing \{ align-items: start; \}/.test(CSS));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. Les erreurs sont posées SOUS leur champ');
{
  check('la ligne sait afficher une erreur', /className="cc-field-error"/.test(FICHE));
  check('…dans la colonne du champ, pas sous le libellé',
    /\.cc-field-error,\s*\.cc-field-hint \{\s*grid-column: 2;/.test(CSS));
  check('…et le champ invalide est signalé aux technologies d’assistance',
    /aria-invalid=\{edition\.erreur \? true : undefined\}/.test(FICHE));

  /**
   * ══ POURQUOI LE CHEMIN, ET NON LA PHRASE ═════════════════════════════════
   *
   * Découper « siren : SIREN : 9 chiffres attendus. » au premier « : » aurait
   * marché — jusqu'au premier message reformulé. C'est le chemin qui fait foi.
   */
  check('l’attribution se fait par CHEMIN de champ, jamais en découpant le message',
    /details\?\.issues \?\? \[\]/.test(FICHE) && !/split\(':'\)/.test(FICHE));

  /* Un refus ne doit pas jeter la saisie qu'il demande de corriger. */
  check('un refus laisse la fiche EN ÉDITION',
    /setErreursChamps\(parChamp\);/.test(FICHE));

  /* ── Le serveur tient réellement sa part du contrat ────────────────────── */
  const cree = await call('POST', '/api/client-companies', {
    headers: AUTH,
    body: { legalName: 'RECETTE UI CLIENTS', siren: '123' },
  });
  check('le serveur refuse un SIREN invalide', cree.status === 400);
  check('…avec le catalogue attendu', cree.json?.code === 'PANEL_CLIENT_COMPANY_INVALID');
  const issues = cree.json?.details?.issues ?? [];
  check('…et il NOMME le champ fautif', issues.some((i) => i.path === 'siren'));
  check('…avec un message lisible sans le chemin',
    issues.some((i) => i.path === 'siren' && typeof i.message === 'string' && i.message.length > 0));
  /* `errors` est conservé : des appelants le lisent déjà, on ajoute à côté. */
  check('…sans avoir retiré la forme historique', Array.isArray(cree.json?.details?.errors));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. Les projets : une liste, et un sélecteur qui n’est pas natif');
{
  check('les projets rattachés sont une liste illustrée',
    /className="cc-rows"/.test(FICHE) && /cc-row-icon/.test(FICHE));
  check('…chacun avec son environnement et son appairage',
    /p\.environment \?\? 'Environnement inconnu'/.test(FICHE) && /p\.paired \? 'Appairé' : 'Non appairé'/.test(FICHE));
  check('…un bouton Voir et un bouton Retirer', /Voir le projet \$\{p\.projectName\}/.test(FICHE)
    && /Retirer le projet \$\{p\.projectName\}/.test(FICHE));

  /**
   * LE `<select>` NATIF OUVRAIT UNE LISTE DESSINÉE PAR LE SYSTÈME : hors
   * thème, et réduite à une ligne de texte par option — impossible d'y
   * distinguer deux instances d'un même projet sur deux environnements.
   */
  check('aucun <select> natif ne subsiste sur la fiche', !/<select/.test(FICHE_CODE()));
  check('…c’est le sélecteur thémé qui sert', /<ThemedSelect/.test(FICHE));
  check('…en mode cherchable', /searchable/.test(FICHE));
  check('…avec une seconde ligne par option', /hint:/.test(FICHE) && /tselect-option-hint/.test(CSS));

  /* La recherche doit porter sur l'indice aussi : taper « PROD » doit trouver
     un projet dont seul l'environnement le dit. */
  check('la recherche porte sur le libellé ET sur l’indice',
    /\$\{o\.label\} \$\{o\.hint \?\? ''\}/.test(SELECT));
  /* Dans un menu cherchable l'espace appartient à la saisie. */
  check('…et l’espace n’est pas détourné quand on peut taper',
    /e\.key === ' ' && !searchable/.test(SELECT));
  check('…le champ reçoit le focus à l’ouverture', /if \(ouvert && searchable\) champ\.current\?\.focus\(\)/.test(SELECT));
  check('…et le filtre repart à vide à chaque ouverture', /setFiltre\(''\);/.test(SELECT));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. Seuls les projets LIBRES sont proposés');
{
  /**
   * ══ CE QUE L'ANCIEN FILTRE LAISSAIT PASSER ═══════════════════════════════
   *
   * Il n'écartait que les projets déjà rattachés à CETTE fiche. Un projet
   * appartenant à une AUTRE entreprise restait proposé — et le choisir le lui
   * PRENAIT : un changement de client légal, avec ses conséquences de
   * facturation, présenté comme un simple ajout.
   */
  check('le sélecteur n’offre que les projets sans entreprise',
    /\.filter\(\(p\) => !p\.clientCompanyId\)/.test(FICHE));
  check('…et le dit quand il n’en reste aucun',
    /Un projet déjà rattaché se change depuis sa propre fiche/.test(FICHE));

  /* ── L'API doit publier cette appartenance, sinon l'écran ne peut rien ─── */
  const liste = await call('GET', '/api/projects', { headers: AUTH });
  check('la LISTE des projets répond', liste.status === 200);
  const projets = liste.json?.data?.projects ?? [];
  check('…et chaque projet déclare son appartenance (même absente)',
    projets.every((p) => Object.prototype.hasOwnProperty.call(p, 'clientCompanyId')));
  /**
   * `null` = libre, jamais « inconnu ». C'est la distinction qui permet au
   * sélecteur de trancher sans lire trente fiches clientes.
   */
  check('…sous la forme d’un identifiant ou de null',
    projets.every((p) => p.clientCompanyId === null || typeof p.clientCompanyId === 'string'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('11. Retirer un projet se confirme, et dit ce que ça coûte');
{
  check('le retrait passe par une confirmation', /setARetirer\(\{ projectId: p\.projectId/.test(FICHE));
  check('…marquée comme destructive', /title=\{`Retirer « \$\{aRetirer\.projectName\} » \?`\}[\s\S]{0,80}danger/.test(FICHE));
  /**
   * LA CONSÉQUENCE EST ÉCRITE AVANT LE BOUTON, pas découverte après le clic.
   */
  check('…qui annonce le blocage des paiements et des signatures',
    /opérations de paiement et de signature seront bloquées/.test(FICHE));
  check('…et rassure sur le passé', /rien de passé n’est réécrit|Les contrats et factures déjà émis/.test(FICHE));
  check('…le retrait n’a lieu qu’après confirmation',
    /const detacher = async \(\) => \{\s*if \(!aRetirer\) return;/.test(FICHE));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('12. Les documents ne sont plus une liste de noms de fichiers');
{
  check('chaque document a son icône', /name="file-earmark-text" size=\{16\}/.test(FICHE));
  check('…sa catégorie et ses dates', /d\.type \?\? 'Sans catégorie'/.test(FICHE) && /déposé le \$\{formatDateTime\(d\.uploadedAt\)\}/.test(FICHE));
  check('…un téléchargement nommé', /aria-label=\{`Télécharger \$\{d\.label\}`\}/.test(FICHE));
  /**
   * PAS DE BOUTON « VOIR » : ces fichiers vivent dans un stockage privé
   * qu'aucun serveur statique ne dessert. Proposer un aperçu obligerait à les
   * servir par une adresse — exactement ce que ce stockage refuse.
   */
  check('…et aucun aperçu promis, faute d’URL publique',
    /aucune façon|il n’y a rien à ouvrir|rien à ouvrir dans un onglet/.test(FICHE));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('13. Espacements, tokens et responsive');
{
  /* Le thème est éditable : une couleur en dur ne le suivrait pas. */
  const enDur = [...CSS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  check(`components.css : aucune couleur hexadécimale (${enDur.join(', ') || 'aucune'})`, enDur.length === 0);

  for (const [nom, motif] of [
    ['les items respirent entre eux', /\.cc-list \{[\s\S]{0,240}gap: var\(--p-space-3\)/],
    ['…et ont un rembourrage interne', /\.cc-item \{[\s\S]{0,400}padding: var\(--p-space-4\)/],
    ['le nom est séparé de ses métadonnées', /\.cc-item-body \{[\s\S]{0,300}gap: var\(--p-space-2\)/],
    ['les badges ne touchent pas le texte', /\.cc-item-badges \{[\s\S]{0,200}margin-top: var\(--p-space-1\)/],
    ['l’icône est alignée sur la première ligne', /\.cc-item-avatar \{[\s\S]{0,400}margin-top: 2px/],
    ['le bouton « Voir » est centré sur l’item', /\.cc-item-action \{[\s\S]{0,120}align-self: center/],
  ]) {
    check(nom, motif.test(CSS));
  }

  /**
   * SOUS 48rem, RIEN NE RÉTRÉCIT : tout s'EMPILE. Une grille à trois colonnes
   * sur 390 px donne des colonnes de quelques caractères — et c'est ainsi
   * qu'une page se met à déborder horizontalement.
   */
  check('un point d’arrêt mobile existe', /@media \(max-width: 48rem\)/.test(CSS));
  const mobile = CSS.slice(CSS.indexOf('@media (max-width: 48rem)'));
  check('…où l’item passe à deux colonnes', /\.cc-item,\s*\.cc-hero \{\s*grid-template-columns: auto minmax\(0, 1fr\);/.test(mobile));
  check('…où l’action prend sa propre ligne', /grid-column: 1 \/ -1;/.test(mobile));
  check('…et où le libellé passe au-dessus de sa valeur',
    /\.cc-field \{\s*grid-template-columns: minmax\(0, 1fr\);/.test(mobile));

  /* Un long SIREN ou une URL sans espace déborderaient sinon leur colonne. */
  check('rien ne déborde d’une colonne étroite',
    /\.cc-item-name \{[\s\S]{0,260}overflow-wrap: anywhere/.test(CSS)
    && /\.cc-item-meta \{[\s\S]{0,220}overflow-wrap: anywhere/.test(CSS));

  /* Un point d'arrêt intermédiaire pour le sélecteur, qui a besoin de largeur. */
  check('une étape tablette existe pour le sélecteur', /@media \(max-width: 64rem\)/.test(CSS));
}

await close();
await stopMemoryMongo();
finish();
