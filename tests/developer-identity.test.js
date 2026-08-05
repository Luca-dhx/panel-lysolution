/**
 * IDENTITÉ DÉVELOPPEUR — la page du Manager, portée dans le Panel.
 *
 * ── CE QUI MANQUAIT ─────────────────────────────────────────────────────────
 * Le Panel était devenu l'autorité de cette identité, mais sa fiche
 * d'entreprise n'offrait que des champs texte bruts : aucun éditeur de
 * références — le bloc était purement absent —, aucun aperçu de logo, aucune
 * validation du signataire. On y saisissait donc à l'aveugle ce que TOUS les
 * projets affichent, et les références n'étaient plus saisissables nulle part
 * une fois le Manager passé en lecture seule.
 *
 * Ces contrôles vérifient la migration : champs, validations, composants et
 * comportements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const check = (nom, ok) => {
  if (ok) { pass += 1; console.log(`  ✓ ${nom}`); } else { fail += 1; console.error(`  ✗ ${nom}`); }
};
const section = (t) => console.log(`\n${t}`);

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

const page = lire('frontend/src/pages/CompanyPage.tsx');
const blocs = lire('frontend/src/components/company/DeveloperIdentity.tsx');
const css = lire('frontend/src/components.css');
const modele = lire('backend/src/models/PanelCompany.model.js');
const validation = lire('backend/src/services/company/company.validation.js');
const contrat = lire('backend/src/bridge/bridgeContract.js');

const sansCommentaires = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Tous les champs de la page Manager existent dans le Panel');
{
  // Structure RÉELLE de la page d'origine : nom, slogan, logo, références,
  // signataire. Rien d'autre n'y figurait — et rien d'autre n'a été inventé.
  check('nom', /field\('identity\.name'/.test(page));
  check('slogan (« signature »)', /field\('identity\.tagline'/.test(page));
  check('logo', /<LogoField value=\{logo\}/.test(page));
  check('références', /<ReferencesEditor/.test(page));
  check('signataire', /<SignerSection/.test(page));
  check('site internet', /field\('domains\.websiteUrl'/.test(page));

  check('le modèle porte le signataire', /signer: \{ type: signerSchema, default: null \}/.test(modele));
  check('…et les références', /references: \{ type: \[referenceSchema\], default: \[\] \}/.test(modele));
  check('la validation les couvre', /signer: signerSchema/.test(validation) && /references: referencesSchema/.test(validation));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Le formulaire brut a disparu au profit des blocs du Manager');
{
  const rendu = sansCommentaires(page);
  check('plus de champ texte pour le signataire',
    !/field\('signer\.firstName'/.test(rendu) && !/field\('signer\.email'/.test(rendu));
  check('plus de champ texte pour le logo', !/field\('branding\.logoUrl'/.test(rendu));
  check('le logo a sa propre carte, hors du bloc « Marque »',
    page.indexOf('<LogoField') > page.indexOf('Card title="Marque"'));
  check('les trois blocs sont importés d’un module dédié',
    /import \{ LogoField, ReferencesEditor, SignerSection \} from '@\/components\/company\/DeveloperIdentity'/.test(page));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Le signataire retrouve sa validation et son état');
{
  check('règles portées par un module miroir', fs.existsSync(path.join(racine, 'frontend/src/lib/signer.ts')));
  const signer = lire('frontend/src/lib/signer.ts');
  check('…prénom, nom et e-mail requis',
    /SIGNER_REQUIRED_FIELDS: SignerField\[\] = \['firstName', 'lastName', 'email'\]/.test(signer));
  check('…la fonction reste facultative', !/'jobTitle'/.test(signer.split('SIGNER_REQUIRED_FIELDS')[1] || ''));
  check('…un e-mail malformé est un manque', /field === 'email' && !isValidEmail\(value\)/.test(signer));
  check('…un signataire vierge n’est pas « incomplet »', /export function isSignerEmpty/.test(signer));

  check('l’état est annoncé par un badge',
    /badge badge-muted">À configurer/.test(blocs)
    && /badge badge-ok">Complet/.test(blocs)
    && /badge badge-warn">Incomplet/.test(blocs));
  check('les erreurs n’apparaissent qu’après interaction',
    /touched\[field\] && gaps\.includes\(field\)/.test(blocs));
  check('…et jamais en même temps que l’aide',
    /erreur \? \([\s\S]{0,120}\) : hint \? \(/.test(blocs));
  check('les champs portent des exemples',
    /placeholder="Jean"/.test(blocs) && /placeholder="jean\.dupont@exemple\.fr"/.test(blocs));
  check('la conséquence d’un signataire incomplet est dite',
    /refusera de valider un contrat/.test(blocs));
  check('tout effacer repasse à « non configuré »',
    /onChange\(isSignerEmpty\(next\) \? null : next\)/.test(blocs));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Les références sont éditables — le bloc était absent');
{
  check('ajout', /const ajouter = \(\) =>/.test(blocs));
  check('suppression', /const retirer = \(i: number\) =>/.test(blocs));
  check('…qui renumérote l’ordre', /\.map\(\(r, idx\) => \(\{ \.\.\.r, order: idx \}\)\)/.test(blocs));
  check('bascule texte / lien', /type: r\.type === 'TEXT' \? 'LINK' : 'TEXT'/.test(blocs));
  check('icône Bootstrap', /placeholder="Icône \(bi-star\)"/.test(blocs));
  check('valeur contextuelle selon le type',
    /r\.type === 'LINK' \? 'https:\/\/…' : 'Valeur'/.test(blocs));
  check('état vide explicite', /Aucune référence\. Ajoutez des liens/.test(blocs));
  check('une adresse invalide est signalée pendant la saisie',
    /!\/\^https\?:\\\/\\\/\/i\.test\(r\.value \|\| ''\)/.test(blocs));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Le logo a son aperçu');
{
  check('aperçu rendu', /<img src=\{url\} alt="Aperçu du logo" \/>/.test(blocs));
  check('…seulement sur une adresse affichable', /const affichable = \/\^https\?:\\\/\\\/\/i\.test\(url\)/.test(blocs));
  check('…sinon la raison est dite', /Adresse non affichable/.test(blocs));
  check('l’absence de stockage est annoncée', /Le Panel n’héberge pas de fichiers/.test(blocs));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Le brouillon accepte des blocs entiers, pas seulement des champs');
{
  check('un chemin sans point s’écrit tel quel',
    /if \(!path\.includes\('\.'\)\) \{ body\[path\] = value; continue; \}/.test(page));
  check('le signataire est un bloc', /setDraft\(\{ \.\.\.draft, signer \}\)/.test(page));
  check('les références aussi', /setDraft\(\{ \.\.\.draft, references: refs \}\)/.test(page));
  check('le brouillon prime sur la valeur publiée',
    /\(draft\.signer as typeof c\.signer\) \?\? c\.signer \?\? null/.test(page));
  check('la distinction saisir / publier est conservée',
    /hasUnpublishedChanges/.test(page) && /Publiez pour les diffuser/.test(page));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Le Bridge publie l’intégralité de cette identité');
{
  check('le signataire voyage', /signer: z\.record\(z\.string\(\), z\.any\(\)\)\.nullable\(\)\.optional\(\)/.test(contrat));
  check('les références aussi', /references: z\.array\(z\.record\(z\.string\(\), z\.any\(\)\)\)\.optional\(\)/.test(contrat));
  check('…en ADDITIF, sans casser un projet antérieur', /ADDITIF/.test(contrat));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. Présentation — cartes, grille, responsive');
{
  check('les blocs sont des cartes', (blocs.match(/<Card title=/g) || []).length === 3);
  check('le signataire est sur deux colonnes dès 640 px',
    /@media \(min-width: 640px\)[\s\S]{0,160}\.company-grid-2 \{[\s\S]{0,80}grid-template-columns: 1fr 1fr/.test(css));
  check('une référence ne déborde pas', /\.company-ref-line input \{[\s\S]{0,120}min-width: 8rem/.test(css));
  check('l’aperçu du logo est cadré', /\.company-logo-preview img \{[\s\S]{0,140}object-fit: contain/.test(css));
  check('les erreurs ont leur style', /\.field-error \{/.test(css));
  check('aucune couleur en dur dans ces blocs',
    !/#[0-9a-fA-F]{3,8}\b/.test(css.slice(css.indexOf('.company-block-head'), css.indexOf('.company-logo-preview p'))));
  check('les cibles tactiles tiennent 40 px', /\.company-ref-line \.btn \{[\s\S]{0,80}min-height: 40px/.test(css));
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
