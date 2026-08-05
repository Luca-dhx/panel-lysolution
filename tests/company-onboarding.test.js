// PREMIÈRE FOIS — créer son entreprise sans rien savoir de technique.
//
// ── CE QUI A ÉTÉ SUPPRIMÉ ───────────────────────────────────────────────────
// Un écran de création demandait un IDENTIFIANT et un ENVIRONNEMENT avant de
// laisser entrer dans la fiche. Deux notions de machine posées à quelqu'un qui
// veut simplement décrire son entreprise, et deux occasions de se tromper une
// fois pour toutes : l'identifiant voyage jusqu'aux projets, et l'environnement
// ne peut pas être choisi puisqu'il est celui du Panel qui tourne.
//
// Le serveur les déduit désormais tous les deux, et l'interface ne les montre
// jamais.
import { check, finish, section, setTestEnv, startMemoryMongo, connectTestDatabase, stopMemoryMongo } from './helpers/harness.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createCompany, getActiveCompany, updateCompany } = await import(
  '../backend/src/services/company/company.service.js'
);
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const config = (await import('../backend/src/config/env.js')).default;

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

const nettoyer = () => PanelCompany.deleteMany({});

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Première création — le nom suffit');
{
  await nettoyer();
  const company = await createCompany({ identity: { name: 'L.Y Solution' } });

  check('l’entreprise est créée', Boolean(company?.companyId));
  check('…avec un identifiant interne généré', typeof company.companyId === 'string' && company.companyId.length > 30);
  check('…et un slug dérivé du nom', company.slug === 'l-y-solution');
  check('le mode vient du Panel, pas de l’utilisateur', company.environment === config.env);
  check('…et rien n’est publié à la naissance', company.publishedVersion === null);
}

section('1 bis. Le slug se dérive proprement, quel que soit le nom');
{
  const cas = [
    ['Éditions Café & Co', 'editions-cafe-co'],
    ['   Espaces   Multiples   ', 'espaces-multiples'],
    ['---Tirets---', 'tirets'],
    ['ACCENTS ÀÉÎÕÜ', 'accents-aeiou'],
  ];
  for (const [nom, attendu] of cas) {
    await nettoyer();
    const c = await createCompany({ identity: { name: nom } });
    check(`« ${nom.trim()} » → ${attendu}`, c.slug === attendu);
  }

  // Un nom qui ne donne aucune lettre ne doit pas produire un slug vide.
  await nettoyer();
  const symboles = await createCompany({ identity: { name: '###' } });
  check('un nom sans lettre reste utilisable', symboles.slug === 'entreprise');
}

section('1 ter. Deux entreprises homonymes ne se marchent pas dessus');
{
  await nettoyer();
  const a = await createCompany({ identity: { name: 'Studio' } });
  // La phase n'autorise qu'une entreprise ACTIVE : la seconde est désactivée,
  // ce qui suffit à éprouver l'unicité du slug.
  const b = await createCompany({ identity: { name: 'Studio' }, active: false });
  check('le premier prend le nom', a.slug === 'studio');
  check('…le second est suffixé', b.slug === 'studio-2');
  check('…et les identifiants internes diffèrent', a.companyId !== b.companyId);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Le mode n’est JAMAIS pris du client');
{
  await nettoyer();
  // Même si le navigateur en envoie un — ancien client, requête forgée — c'est
  // l'environnement du Panel qui tranche.
  const c = await createCompany({
    identity: { name: 'Essai' },
    environment: config.env === 'TEST' ? 'PROD' : 'TEST',
  });
  check('l’environnement demandé est ignoré', c.environment === config.env);

  // Idem pour le slug : s'il est fourni, il est accepté (compatibilité), mais
  // plus rien dans l'interface ne le propose.
  await nettoyer();
  const impose = await createCompany({ identity: { name: 'Essai' }, slug: 'choisi-a-la-main' });
  check('un slug explicite reste honoré (compatibilité)', impose.slug === 'choisi-a-la-main');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Édition — on reste sur la même page');
{
  await nettoyer();
  const cree = await createCompany({ identity: { name: 'Avant' } });
  await updateCompany(cree.companyId, {
    identity: { name: 'Après', tagline: 'Une signature' },
    domains: { websiteUrl: 'https://exemple.test' },
  });

  const relu = await getActiveCompany();
  check('le nom est modifié', relu.identity.name === 'Après');
  check('…la signature aussi', relu.identity.tagline === 'Une signature');
  check('…et le site', relu.domains.websiteUrl === 'https://exemple.test');
  check('l’identifiant interne ne change JAMAIS', relu.companyId === cree.companyId);
  check('…ni le slug', relu.slug === cree.slug);
  check('…ni le mode', relu.environment === config.env);
  check('modifier ne publie rien', relu.publishedVersion === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. L’écran ne montre plus rien de technique');
{
  const page = lire('frontend/src/pages/CompanyPage.tsx');
  const rendu = page
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // L'écran de création séparé a disparu.
  check('plus d’écran de création dédié', !/function CompanyCreation/.test(page));
  check('plus de champ « Identifiant »', !/field-label">Identifiant/.test(rendu));
  check('plus de choix TEST / PROD',
    !/<option value="TEST">/.test(rendu) && !/<option value="PROD">/.test(rendu));
  check('l’identifiant interne n’est jamais affiché', !/\{c\.slug\}/.test(rendu));
  check('…ni l’environnement sur cette page', !/\{c\.environment\}/.test(rendu));

  // L'état vide mène directement au formulaire.
  check('un état vide élégant', /<EmptyState/.test(rendu));
  check('…avec un CTA explicite', /Créer mon entreprise/.test(rendu));
  check('…qui ouvre le formulaire, sans modale', /setCreating\(true\)/.test(rendu));

  // Un seul formulaire, deux chemins d'enregistrement.
  check('le bouton crée la première fois', /await api\.create\(patch\(\)\)/.test(rendu));
  check('…et enregistre ensuite', /await api\.update\(patch\(\)\)/.test(rendu));
  check('…le libellé suit', /existe \? 'Enregistrer le brouillon' : 'Créer mon entreprise'/.test(rendu));
  check('le nom est la seule exigence pour créer', /: !nomSaisi/.test(rendu));
  check('la fiche vierge a la forme du serveur', /const EMPTY_COMPANY = \{/.test(page));
  check('…sans slug ni environnement renseignés',
    /slug: '',/.test(page) && /environment: '',/.test(page));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Aucun autre écran ne dépend du mode ni d’une sélection d’entreprise');
{
  const app = lire('frontend/src/App.tsx');
  const layout = lire('frontend/src/components/Layout.tsx');

  check('aucune sélection d’entreprise dans la navigation',
    !/companyId|selectCompany|currentCompany/.test(app) && !/companyId/.test(layout));
  check('l’environnement reste indiqué globalement, une seule fois',
    /version\.environment/.test(layout));

  // La distinction saisir / publier n'a pas été perdue en route.
  const page = lire('frontend/src/pages/CompanyPage.tsx');
  check('publier reste un acte distinct', /Publier la configuration/.test(page));
  check('…et exige toujours une raison', /Raison de cette publication/.test(page));
  check('le bandeau de brouillon non publié subsiste', /hasUnpublishedChanges/.test(page));
}

await stopMemoryMongo();
finish();
