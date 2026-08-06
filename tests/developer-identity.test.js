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
  // Le bloc « Marque » a disparu : couleurs et police n'étaient consommées
  // par personne, et le favicon — qui l'est — a rejoint la configuration
  // technique, là où l'on ne le prend plus pour une décision de design.
  check('le bloc « Marque » n’existe plus', !/Card title="Marque"/.test(page));
  check('le logo a sa propre carte', /<LogoField/.test(page));
  check('les quatre blocs sont importés d’un module dédié',
    /import \{[\s\S]{0,120}LogoField, ReferencesEditor, SignerSection, TeamEditor,[\s\S]{0,80}from '@\/components\/company\/DeveloperIdentity'/.test(page));
  check('…et l’équipe est réellement montée dans la page', /<TeamEditor/.test(page));
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
  // L'icône ne se saisit PLUS de mémoire : elle se choisit dans une grille.
  // Un nom tapé au jugé donnait un carré vide chez le client, sans signal ici.
  check('l’icône se choisit, elle ne se tape pas',
    /<IconPicker/.test(blocs) && !/placeholder="Icône/.test(blocs));
  check('…et la valeur par défaut vient du catalogue',
    /icon: ICONE_PAR_DEFAUT/.test(blocs) && !/icon: 'bi-star'/.test(blocs));
  // Le libellé ne contient plus d'URL littérale : la garde d'architecture
  // interdit toute adresse absolue dans le frontend, et une simple aide de
  // saisie ne justifie pas de l'affaiblir.
  check('valeur contextuelle selon le type',
    /r\.type === 'LINK' \? 'Adresse du lien' : 'Valeur'/.test(blocs));
  check('état vide explicite', /Aucune référence\. Ajoutez les liens/.test(blocs));
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
  // Le composant sert au logo ET aux portraits d'équipe : le dossier suit
  // l'usage. Deux composants jumeaux auraient divergé au premier correctif.
  // L'import passe le fichier ET le RÔLE MÉTIER. Le rôle n'est pas déduit du
  // préfixe : un préfixe nomme un fichier, il ne dit pas ce que l'image
  // représente — et c'est le rôle que le descripteur publié transporte.
  check('le fichier s’importe',
    /uploadImage\(/.test(blocs) && /kind === 'avatar' \? 'avatar' : 'logo'/.test(blocs));
  check('…en déclarant son rôle métier',
    /kind === 'avatar' \? 'team-photo' : 'logo'/.test(blocs));
  check('…au clic', /inputRef\.current\?\.click\(\)/.test(blocs));
  check('…et au glisser-déposer', /onDrop=/.test(blocs) && /dataTransfer\.files/.test(blocs));
  check('…au clavier aussi', /e\.key === 'Enter'/.test(blocs));
  check('l’envoi est signalé', /aria-busy=\{envoi\}/.test(blocs) && /Envoi…/.test(blocs));
  check('l’image se supprime', /aria-label=\{`Supprimer \$\{label\}`\}/.test(blocs));
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
  check('publication absolue', /export async function resolvePublicMediaUrl/.test(service));
  check('…sans adresse résolue, on ne publie RIEN plutôt qu’un lien brisé',
    /return null;/.test(service) && /await resolveBackendUrl\(\)/.test(service));
  check('la résolution a lieu à la publication',
    /logoUrl: await resolvePublicMediaUrl\(branding\.logoUrl\)/.test(companyService));

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
  check('l’équipe est un bloc, comme le signataire',
    /setDraft\(\{ \.\.\.draft, team \}\)/.test(page));

  /**
   * SAISIR ET PUBLIER SONT DÉSORMAIS LE MÊME GESTE.
   *
   * Le brouillon ne servait qu'à créer un état où ce que l'écran montre n'est
   * pas ce que les projets appliquent — exactement le malentendu qu'il
   * prétendait éviter. Il reste UN bouton, et il diffuse.
   */
  check('un seul bouton d’enregistrement', (page.match(/onClick=\{enregistrer\}/g) || []).length === 1);
  check('…qui publie du même geste', !/api\.publish\(/.test(page));
  check('plus aucune raison de publication demandée',
    !/Raison de cette publication/.test(page) && !/setReason/.test(page));
  check('enregistrer sans changement est un succès, pas une erreur',
    /if \(!r\.published\) return 'Aucune modification à diffuser\.'/.test(page));
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
  // Quatre blocs désormais : logo, signataire, références, ÉQUIPE. Cette
  // dernière vivait dans chaque projet — donc en autant d'exemplaires
  // divergents qu'il y avait de projets.
  check('les blocs sont des cartes', (blocs.match(/<Card title=/g) || []).length === 4);
  check('l’équipe est éditable ici', /export function TeamEditor/.test(blocs));
  check('…avec prénom et nom SÉPARÉS',
    /field-label">Prénom</.test(blocs) && /field-label">Nom</.test(blocs));
  check('…une photo importée, pas une URL collée',
    /<ImageField[\s\S]{0,220}kind="avatar"/.test(blocs));
  check('…des références propres à la personne',
    /<ReferenceRows[\s\S]{0,120}m\.references/.test(blocs));
  check('…un retrait qui n’efface pas',
    /Retirer de l’affichage/.test(blocs) && /Réafficher/.test(blocs));
  check('…et un ordre renuméroté après chaque retrait',
    /membres\.filter\(\(_, idx\) => idx !== i\)\.map\(\(m, idx\) => \(\{ \.\.\.m, order: idx \}\)\)/.test(blocs));

  // Les lignes de références sont MUTUALISÉES : l'entreprise et chaque membre
  // partagent le même composant, sinon un correctif manquerait à l'un des deux.
  check('les références ne sont écrites qu’une fois',
    (blocs.match(/export function ReferenceRows/g) || []).length === 1
    && (blocs.match(/<ReferenceRows/g) || []).length === 2);
  check('le signataire est sur deux colonnes dès 640 px',
    /@media \(min-width: 640px\)[\s\S]{0,160}\.company-grid-2 \{[\s\S]{0,80}grid-template-columns: 1fr 1fr/.test(css));
  check('une référence ne déborde pas', /\.company-ref-line input \{[\s\S]{0,120}min-width: 8rem/.test(css));
  check('la zone d’import est cadrée', /\.company-image-drop img \{[\s\S]{0,140}object-fit: contain/.test(css));
  check('…et un portrait est rond et recadré',
    /\.company-image-drop\.is-avatar img \{[\s\S]{0,160}object-fit: cover/.test(css));
  check('un membre retiré se voit au premier coup d’œil',
    /\.company-member\.is-inactive \{[\s\S]{0,120}opacity/.test(css));
  check('les erreurs ont leur style', /\.field-error \{/.test(css));
  check('aucune couleur en dur dans ces blocs',
    !/#[0-9a-fA-F]{3,8}\b/.test(css.slice(css.indexOf('.company-block-head'), css.indexOf('.company-logo-preview p'))));
  check('les cibles tactiles tiennent 40 px', /\.company-ref-line \.btn \{[\s\S]{0,80}min-height: 40px/.test(css));
}

/* -------------------------------------------------------------------------- */
section('9. Architecture — médias partagés et adresse dérivée, sans réglage manuel');
{
  const deployConfig = lire('deploy/lib/config.mjs');
  const deployPlan = lire('deploy/lib/plan.mjs');
  const env = lire('backend/src/config/env.js');
  const service = lire('backend/src/services/upload/upload.service.js');
  const companyService = lire('backend/src/services/company/company.service.js');

  // Les médias suivent l'architecture du stockage : shared/ + lien symbolique.
  check('le dossier partagé est déclaré', deployConfig.includes('sharedUploads: `${siteRoot}/shared/uploads`'));
  check('…créé s’il manque', deployPlan.includes('mkdir -p ${paths.sharedUploads}'));
  check('…et le lien refait à CHAQUE release',
    deployPlan.includes('ln -sfn ${paths.sharedUploads} ${releaseDir}/backend/uploads'));
  check('…après suppression, sinon le lien se créerait DANS le dossier',
    deployPlan.indexOf('rm -rf ${releaseDir}/backend/uploads')
      < deployPlan.indexOf('ln -sfn ${paths.sharedUploads}'));
  check('le code ne connaît qu’un chemin, le sien',
    /uploads: path\.resolve\(process\.cwd\(\), 'uploads'\)/.test(env));
  check('…et AUCUNE variable d’environnement dédiée aux médias',
    !/UPLOADS_DIR/.test(env) && !/UPLOADS_DIR/.test(service));

  // L'adresse publique vient de la configuration existante.
  check('l’URL est dérivée du résolveur canonique',
    /const \{ url \} = await resolveBackendUrl\(\);/.test(service));
  check('…et non d’une variable propre aux médias', !/config\.publicUrl/.test(service));
  check('la résolution n’a lieu qu’à la PUBLICATION',
    /export async function companyPublishedProfile/.test(companyService)
    && /const payload = await companyPublishedProfile\(company\);/.test(companyService));
  check('…la vue d’administration garde le chemin relatif',
    !/resolvePublicMediaUrl/.test(companyService.slice(
      companyService.indexOf('export function companyPublicProfile'),
      companyService.indexOf('export async function companyPublishedProfile'),
    )));
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
