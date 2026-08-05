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

const { createCompany, getActiveCompany, updateCompany, publishConfiguration } = await import(
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
  check('le mode vient du Panel, pas de l’utilisateur', company.environment === config.env);
  check('…et rien n’est publié à la naissance', company.publishedVersion === null);
}

section('1 bis. L’identifiant technique est OPAQUE — aucun lien avec le nom');
{
  // Le nom est une donnée métier : il se corrige, il change au rebranding.
  // L'identifiant voyage jusqu'aux projets et doit rester stable à vie.
  await nettoyer();
  const c = await createCompany({ identity: { name: 'L.Y Solution' } });

  check('le slug ne contient RIEN du nom',
    !/ly|solution|l-y/i.test(c.slug));
  check('…il est opaque et de longueur fixe', /^c[0-9a-f]{20}$/.test(c.slug));

  // Deux entreprises du même nom obtiennent deux identifiants sans rapport.
  await nettoyer();
  const a = await createCompany({ identity: { name: 'Studio' } });
  const b = await createCompany({ identity: { name: 'Studio' }, active: false });
  check('deux homonymes → deux identifiants distincts', a.slug !== b.slug);
  check('…et aucun n’est suffixé à partir du nom',
    !/studio/i.test(a.slug) && !/studio/i.test(b.slug));
  check('…les identifiants internes diffèrent aussi', a.companyId !== b.companyId);

  // Deux créations successives ne tirent jamais le même identifiant.
  await nettoyer();
  const tirages = new Set();
  for (let i = 0; i < 5; i += 1) {
    await nettoyer();
    tirages.add((await createCompany({ identity: { name: 'Même nom' } })).slug);
  }
  check('cinq créations, cinq identifiants différents', tirages.size === 5);
}

section('1 ter. Renommer l’entreprise ne touche JAMAIS l’identifiant');
{
  await nettoyer();
  const cree = await createCompany({ identity: { name: 'Ancien nom' } });
  const slugOrigine = cree.slug;

  await updateCompany(cree.companyId, { identity: { name: 'Nom entièrement différent' } });
  const apres = await getActiveCompany();
  check('le nom a changé', apres.identity.name === 'Nom entièrement différent');
  check('…l’identifiant technique, non', apres.slug === slugOrigine);
  check('…ni l’identifiant interne', apres.companyId === cree.companyId);

  // Même une charge utile qui prétend le modifier est sans effet.
  await updateCompany(cree.companyId, { slug: 'force-a-la-main', environment: 'PROD' });
  const force = await getActiveCompany();
  check('un slug imposé par le client est ignoré', force.slug === slugOrigine);
  check('…et le mode aussi', force.environment === config.env);
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

  // Le slug fourni par un client n'est plus qu'une valeur parmi d'autres :
  // il reste accepté à la CRÉATION (compatibilité d'appel), mais l'interface
  // ne le propose plus et aucune modification ne peut le changer ensuite.
  await nettoyer();
  const impose = await createCompany({ identity: { name: 'Essai' }, slug: 'choisi-a-la-main' });
  check('un slug explicite reste honoré à la création', impose.slug === 'choisi-a-la-main');
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
  // Un seul libellé désormais : le geste est le même dans les deux cas, et
  // c'est le contexte (fiche absente ou non) qui décide de la route appelée.
  check('…sous un libellé unique', /busy \? 'Enregistrement…' : 'Enregistrer'/.test(rendu));
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

  /**
   * PUBLIER N'EST PLUS UN ACTE SÉPARÉ.
   *
   * Il l'était, avec une justification écrite exigée. En pratique elle valait
   * « maj » ou « correction » : un péage sans information. Le versionnement
   * reste entier côté serveur, avec le diff exact — ce qui se relit vraiment.
   */
  const page = lire('frontend/src/pages/CompanyPage.tsx');
  check('plus de bloc de publication séparé', !/Publier la configuration/.test(page));
  check('…ni de raison exigée', !/Raison de cette publication/.test(page));
  check('…ni d’appel de publication depuis l’écran', !/api\.publish\(/.test(page));
  check('l’historique des versions reste consultable', /Historique des versions/.test(page));
  check('…et la restauration reste possible', /api\.restore\(v\.version\)/.test(page));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. F5 avant publication — le brouillon est retrouvé, pas recréé');
{
  await nettoyer();

  // 1. Aucune entreprise : l'écran proposerait l'état vide.
  check('au départ, aucune entreprise', (await getActiveCompany()) === null);

  // 2. Création depuis le formulaire, puis premier enregistrement.
  const cree = await createCompany({
    identity: { name: 'Entreprise en cours', tagline: 'Brouillon' },
    domains: { websiteUrl: 'https://brouillon.test' },
  });
  await updateCompany(cree.companyId, {
    contacts: { email: 'contact@brouillon.test' },
    signer: { firstName: 'Jean', lastName: 'Dupont', jobTitle: 'Gérant', email: 'jean@brouillon.test' },
  });

  check('le brouillon existe', (await getActiveCompany())?.companyId === cree.companyId);
  check('…et n’est pas publié', (await getActiveCompany()).publishedVersion === null);

  // 3. F5 : le navigateur repart de zéro et redemande l’état au serveur.
  //    C’est exactement ce que fait la page au montage.
  const apresRechargement = await getActiveCompany();

  check('l’entreprise est RETROUVÉE', Boolean(apresRechargement));
  check('…avec le même identifiant interne', apresRechargement.companyId === cree.companyId);
  check('…et le même identifiant technique', apresRechargement.slug === cree.slug);
  check('le brouillon est restauré — identité', apresRechargement.identity.name === 'Entreprise en cours');
  check('…signature', apresRechargement.identity.tagline === 'Brouillon');
  check('…site', apresRechargement.domains.websiteUrl === 'https://brouillon.test');
  check('…contact', apresRechargement.contacts.email === 'contact@brouillon.test');
  check('…signataire', apresRechargement.signer?.email === 'jean@brouillon.test');

  // 4. Aucun doublon : une seule entreprise, une seule active.
  check('aucune deuxième entreprise', (await PanelCompany.countDocuments({})) === 1);
  check('…et une seule active', (await PanelCompany.countDocuments({ active: true })) === 1);

  // Le serveur refuse d’en créer une seconde tant que celle-ci est active :
  // même un double clic ou un client resté sur l’ancien écran ne peut pas
  // fabriquer un doublon.
  let refus = null;
  try { await createCompany({ identity: { name: 'Doublon' } }); }
  catch (err) { refus = err; }
  check('une seconde création est refusée', refus !== null);
  check('…avec un code explicite', refus?.code === 'PANEL_COMPANY_ALREADY_ACTIVE');
  check('…et rien n’a été créé', (await PanelCompany.countDocuments({})) === 1);

  // 5. La publication fonctionne ensuite normalement.
  const publiee = await publishConfiguration(cree.companyId, { reason: 'Première mise en service' });
  check('la publication aboutit', Boolean(publiee));
  const finale = await getActiveCompany();
  check('…en version 1', finale.publishedVersion === 1);
  check('…sans changer l’identifiant', finale.slug === cree.slug && finale.companyId === cree.companyId);
  check('…et le contenu du brouillon est celui publié',
    finale.identity.name === 'Entreprise en cours');
}
await stopMemoryMongo();
finish();
