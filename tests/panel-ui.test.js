/**
 * DESIGN SYSTEM DU PANEL — tokens, thème, responsive, mouvement.
 *
 * Ce que ces contrôles verrouillent : qu'aucune couleur ne soit écrite en dur
 * dans les écrans refondus, que le thème s'applique sans rechargement, qu'un
 * contraste insuffisant soit REFUSÉ, que la barre latérale devienne un tiroir
 * sur mobile, et qu'une personne ayant demandé moins d'animations soit
 * écoutée.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const { contrastRatio, MIN_CONTRAST } = await import(
  '../backend/src/services/theme/panelTheme.service.js'
);

await seedFromEnv();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Les tokens sont la seule source des couleurs');
{
  const tokens = lire('frontend/src/tokens.css');

  for (const base of ['--p-background', '--p-foreground', '--p-primary', '--p-accent']) {
    check(`${base} est défini`, tokens.includes(`${base}:`));
  }
  check('les surfaces sont DÉRIVÉES, pas ressaisies', tokens.includes('color-mix'));
  for (const famille of [
    '--p-space-', '--p-text-', '--p-radius-', '--p-shadow', '--p-motion',
  ]) {
    check(`échelle ${famille} présente`, tokens.includes(famille));
  }
  check('les anciens noms restent branchés sur les tokens',
    /--bg: var\(--p-background\)/.test(tokens) && /--accent: var\(--p-primary\)/.test(tokens));
}

section('2. Aucune couleur en dur dans les écrans refondus');
{
  const refondus = [
    'frontend/src/components.css',
    'frontend/src/components/DateTimeField.tsx',
    'frontend/src/components/EventForms.tsx',
    'frontend/src/components/EventLists.tsx',
    'frontend/src/components/Participants.tsx',
    'frontend/src/components/Layout.tsx',
    'frontend/src/pages/ThemePage.tsx',
    'frontend/src/pages/AgendaPage.tsx',
  ];
  for (const fichier of refondus) {
    const source = lire(fichier);
    // On tolère le noir/blanc translucide d'un voile : ce n'est pas une
    // couleur de marque, et aucun thème ne doit l'éclaircir.
    const enDur = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    check(`${path.basename(fichier)} : aucune couleur hexadécimale (${enDur.join(', ') || 'aucune'})`,
      enDur.length === 0);
  }
}

section('3. Le thème s’enregistre, et refuse l’illisible');
{
  const initial = await call('GET', '/api/theme', { headers: AUTH });
  check('le thème est lisible', initial.status === 200);
  check('…avec exactement quatre couleurs',
    Object.keys(initial.json.data.theme.colors).length === 4);
  check('…un rayon', typeof initial.json.data.theme.radius === 'string');
  check('…et deux polices',
    typeof initial.json.data.theme.typography.headingFont === 'string'
    && typeof initial.json.data.theme.typography.bodyFont === 'string');

  const bon = await call('PUT', '/api/theme', {
    headers: AUTH,
    body: { colors: { background: '#101418', foreground: '#f0f4f8', primary: '#7c5cff', accent: '#12b981' } },
  });
  check('un thème lisible est accepté', bon.status === 200);
  check('…et relu tel quel', bon.json.data.theme.colors.primary === '#7c5cff');

  const illisible = await call('PUT', '/api/theme', {
    headers: AUTH, body: { colors: { background: '#101418', foreground: '#12161a' } },
  });
  check('un texte qui ne ressort pas du fond est REFUSÉ', illisible.status === 400);
  check('…avec un code explicite', illisible.json.code === 'PANEL_THEME_CONTRAST_TOO_LOW');
  check('…et le thème précédent est conservé',
    (await call('GET', '/api/theme', { headers: AUTH })).json.data.theme.colors.foreground === '#f0f4f8');

  const pasUneCouleur = await call('PUT', '/api/theme', {
    headers: AUTH, body: { colors: { primary: 'rouge' } },
  });
  check('une couleur invalide est refusée', pasUneCouleur.status === 400);

  const policeInconnue = await call('PUT', '/api/theme', {
    headers: AUTH, body: { typography: { headingFont: 'Comic Sans MS' } },
  });
  check('une police hors catalogue est refusée', policeInconnue.status === 400);

  const remis = await call('POST', '/api/theme/reset', { headers: AUTH });
  check('le retour au thème d’origine fonctionne', remis.status === 200);
  check('…et rend bien les valeurs par défaut',
    remis.json.data.theme.colors.background === '#0b0f17');

  // Le calcul de contraste doit être juste : noir sur blanc = 21:1.
  check('contraste noir sur blanc = 21',
    Math.round(contrastRatio('#000000', '#ffffff')) === 21);
  check('contraste d’une couleur avec elle-même = 1',
    Math.round(contrastRatio('#3b82f6', '#3b82f6')) === 1);
  check(`le seuil retenu est ${MIN_CONTRAST}`, MIN_CONTRAST === 4.5);
}

section('4. L’écriture du thème est réservée aux comptes DEV');
{
  const admin = await call('POST', '/api/auth/login', {
    body: { email: 'admin@panel.test', password: 'motdepasse-test' },
  });
  if (admin.status === 200) {
    const jeton = { authorization: `Bearer ${admin.json.data.token}` };
    check('un ADMIN peut LIRE le thème',
      (await call('GET', '/api/theme', { headers: jeton })).status === 200);
    check('…mais pas l’écrire',
      (await call('PUT', '/api/theme', { headers: jeton, body: {} })).status === 403);
  } else {
    check('aucun compte ADMIN de test — garde vérifiée par la route', true);
  }
  check('sans authentification, le thème est inaccessible',
    (await call('GET', '/api/theme')).status === 401);
}

section('5. Le thème s’applique SANS rechargement');
{
  const hook = lire('frontend/src/lib/useTheme.ts');
  check('les couleurs sont posées sur la racine du document',
    hook.includes('document.documentElement') && hook.includes('setProperty'));
  check('…et rien ne recharge la page',
    !/location\.reload|window\.location\s*=/.test(hook));
  check('l’aperçu repeint avant d’enregistrer',
    /previsualiser[\s\S]{0,200}applyTheme/.test(hook));
  check('« Annuler » remet ce qui est enregistré',
    /annuler[\s\S]{0,160}applyTheme\(enregistre\)/.test(hook));

  const page = lire('frontend/src/pages/ThemePage.tsx');
  check('la page propose la remise à l’état d’origine',
    page.includes('Revenir au thème d’origine'));
  check('…et bloque l’enregistrement d’un thème illisible',
    /disabled=\{[^}]*!lisible/.test(page));
}

section('6. Responsive : tiroir mobile, tableaux contenus');
{
  const css = lire('frontend/src/components.css');
  const layout = lire('frontend/src/components/Layout.tsx');

  check('la barre latérale devient un tiroir sous 900 px',
    /@media \(max-width: 900px\)[\s\S]{0,900}\.sidebar\s*\{[\s\S]{0,200}position: fixed/.test(css));
  check('…avec une barre supérieure et un bouton de menu',
    layout.includes('topbar-burger') && css.includes('.topbar'));
  check('…un voile qui ferme le tiroir', layout.includes('drawer-scrim'));
  check('…une fermeture au clavier (Échap)', layout.includes("e.key === 'Escape'"));
  check('…une fermeture au changement de page', /useEffect\(\(\) => \{ setTiroir\(false\); \}/.test(layout));
  check('…et le fond qui ne défile plus', layout.includes('no-scroll'));

  check('les cibles tactiles font au moins 44 px', /min-height: 44px/.test(css));
  check('les formulaires passent en UNE colonne sur mobile',
    /@media \(max-width: 900px\)[\s\S]{0,1400}grid-template-columns: 1fr/.test(css));
  // Une liste de participants tient trois champs par personne : sur un mobile,
  // ils DOIVENT retomber en colonne, sinon aucun n'est lisible.
  const bloc900 = css.slice(
    css.indexOf('@media (max-width: 900px)'),
    css.indexOf('@media (max-width: 480px)'),
  );
  check('un participant passe en une seule colonne sur mobile',
    /\.participant \{\s*grid-template-columns: 1fr;/.test(bloc900));
  check('…et son sélecteur de type occupe toute la largeur',
    /\.participant \.segmented \{\s*width: 100%;/.test(bloc900));

  check('un tableau défile dans son cadre, pas la page',
    /table[\s\S]{0,120}overflow-x: auto/.test(css));
  check('une taille tablette est prévue', css.includes('@media (max-width: 1200px)'));
  check('…et un très grand écran ne s’étire pas', css.includes('@media (min-width: 1600px)'));
  check('un petit mobile est prévu', css.includes('@media (max-width: 480px)'));
}

section('7. Le mouvement reste discret, et se coupe si on le demande');
{
  const tokens = lire('frontend/src/tokens.css');
  const css = lire('frontend/src/components.css');

  check('les durées sont des tokens, pas des valeurs éparpillées',
    /--p-motion: \d+ms/.test(tokens));
  const durees = [...css.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
  check(`aucune animation interminable (${durees.join(', ') || 'aucune valeur brute'})`,
    durees.every((d) => d <= 400));
  check('prefers-reduced-motion est respecté',
    tokens.includes('prefers-reduced-motion'));
  check('…en COUPANT le mouvement, pas en l’accélérant',
    /prefers-reduced-motion[\s\S]{0,400}--p-motion: 0ms/.test(tokens));

  // Ce qui vit ne doit pas clignoter : la lecture silencieuse reste en place.
  const agenda = lire('frontend/src/pages/AgendaPage.tsx');
  const hookEvents = lire('frontend/src/lib/useEvents.ts');
  check('les écrans vivants passent par la lecture silencieuse',
    hookEvents.includes('useLiveQuery'));
  check('…et ne posent aucun minuteur à eux', !/setInterval/.test(agenda));
}

section('8. Sélecteurs de date et d’heure faits maison');
{
  const picker = lire('frontend/src/components/DateTimeField.tsx');
  const formulaires = lire('frontend/src/components/EventForms.tsx');
  const confirmation = lire('frontend/src/components/EventConfirmation.tsx');

  check('aucun champ de date natif ne subsiste dans les formulaires',
    !/type="date"|type="datetime-local"/.test(formulaires + confirmation));
  check('le calendrier est en français', picker.includes('janvier') && picker.includes('décembre'));
  check('…la semaine commence le lundi', /JOURS = \['L'/.test(picker));
  check('…avec navigation mois précédent / suivant',
    picker.includes('Mois précédent') && picker.includes('Mois suivant'));
  check('…une fermeture au clavier', picker.includes("e.key === 'Escape'"));
  check('…un raccourci « Aujourd’hui »', picker.includes('Aujourd’hui'));
  check('…et des rôles accessibles',
    picker.includes('aria-haspopup') && picker.includes("role=\"dialog\""));
  check('aucune bibliothèque de dates n’a été ajoutée',
    !/from 'date-fns'|from 'dayjs'|from 'moment'/.test(picker));
  check('l’heure locale est respectée, jamais toISOString pour une date',
    picker.includes('toDateKey') && !/toISOString\(\)\.slice\(0, 10\)/.test(picker));
}

section('9. Vocabulaire : rien de technique dans l’espace métier');
{
  const ecrans = [
    'frontend/src/pages/AgendaPage.tsx',
    'frontend/src/pages/ThemePage.tsx',
    'frontend/src/components/EventForms.tsx',
    'frontend/src/components/EventConfirmation.tsx',
  ].map(lire).join(' ');

  // On regarde ce que l'utilisateur LIT — le texte entre deux balises — et non
  // le code : un identifiant de statut dans un filtre ne s'affiche nulle part,
  // alors que le même mot dans un libellé serait une fuite de jargon.
  // Sur UNE ligne : sans cela la capture enjamberait des lignes de code
  // entières et prendrait un filtre pour un libellé.
  const texteAffiche = [...ecrans.split('\n').flatMap((l) => [...l.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]))].join(' ');
  for (const terme of ['PENDING_CONFIRMATION', 'DONE_PENDING', 'projectId', 'payload', 'endpoint']) {
    check(`« ${terme} » n’apparaît dans aucun libellé`, !texteAffiche.includes(terme));
  }
  check('les libellés d’action sont en français',
    ['Planifier', 'Enregistrer', 'Annuler', 'Modifier'].every((mot) => ecrans.includes(mot)));
}

await close();
await stopMemoryMongo();
finish();
