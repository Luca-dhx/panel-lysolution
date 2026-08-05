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
section('5. Le logo s’IMPORTE — même geste que dans le Manager');
{
  const routes = lire('backend/src/routes/upload.routes.js');
  const service = lire('backend/src/services/upload/upload.service.js');
  const app = lire('backend/src/app.js');
  const client = lire('frontend/src/lib/api.ts');
  const companyService = lire('backend/src/services/company/company.service.js');

  // Le champ URL a disparu : c'était une expérience dégradée née d'une limite
  // technique, pas d'un choix.
  check('plus aucun champ « adresse du logo »', !/Adresse du logo/.test(blocs));
  check('le fichier s’importe', /uploadImage\(file, 'logo'\)/.test(blocs));
  check('…au clic', /inputRef\.current\?\.click\(\)/.test(blocs));
  check('…et au glisser-déposer', /onDrop=/.test(blocs) && /dataTransfer\.files/.test(blocs));
  check('…au clavier aussi', /e\.key === 'Enter'/.test(blocs));
  check('l’envoi est signalé', /aria-busy=\{envoi\}/.test(blocs) && /Envoi…/.test(blocs));
  check('l’image se supprime', /Supprimer l’image/.test(blocs));
  check('un échec dit sa cause', /setErreur\(errorMessage\(err/.test(blocs));
  check('…et réimporter le même fichier reste possible',
    /inputRef\.current\.value = ''/.test(blocs));

  // Backend : le Panel héberge désormais ses médias.
  check('la route d’import existe', /router\.post\('\/image', upload\.single\('file'\)/.test(routes));
  check('…réservée aux DEV', /router\.use\(requirePanelDev\)/.test(routes));
  check('…limitée en taille', /fileSize: 12 \* 1024 \* 1024/.test(routes));
  check('…et aux images', /startsWith\('image\//.test(routes));
  check('le nom de fichier ne peut pas sortir du dossier', /a-z0-9_-/.test(routes));
  check('le fichier est RÉÉCRIT, jamais servi tel quel',
    /sharp\(buffer\)/.test(service) && /\.webp\(/.test(service));
  check('…et redimensionné', /withoutEnlargement: true/.test(service));
  check('les médias sont servis en statique', /express\.static\(uploadsDir\(\)/.test(app));
  check('…sans exposer de fichiers cachés', /dotfiles: 'deny'/.test(app));

  // Le chemin stocké est relatif ; l'URL publiée est absolue.
  check('stockage relatif', /UPLOADS_PUBLIC_PREFIX = '\/uploads'/.test(service));
  check('publication absolue', /export function resolvePublicMediaUrl/.test(service));
  check('…sans adresse publique, on ne publie RIEN plutôt qu’un lien brisé',
    /return null;/.test(service) && /config\.publicUrl/.test(service));
  check('la résolution a lieu à la publication',
    /logoUrl: resolvePublicMediaUrl\(branding\.logoUrl\)/.test(companyService));

  check('le client n’impose pas le Content-Type du multipart',
    /body: form,/.test(client) && !/'Content-Type': 'multipart/.test(client));
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
  check('la zone d’import est cadrée', /\.company-logo-drop img \{[\s\S]{0,140}object-fit: contain/.test(css));
  check('les erreurs ont leur style', /\.field-error \{/.test(css));
  check('aucune couleur en dur dans ces blocs',
    !/#[0-9a-fA-F]{3,8}\b/.test(css.slice(css.indexOf('.company-block-head'), css.indexOf('.company-logo-preview p'))));
  check('les cibles tactiles tiennent 40 px', /\.company-ref-line \.btn \{[\s\S]{0,80}min-height: 40px/.test(css));
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
