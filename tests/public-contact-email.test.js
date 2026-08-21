/**
 * L'ADRESSE DE CONTACT PUBLIC — une autorité, et la preuve que c'est la seule.
 *
 * ══ CE QUE CE FICHIER VERROUILLE ════════════════════════════════════════════
 *
 *   · l'adresse est un CHAMP de l'identité, plus une déduction de l'ordre des
 *     références ;
 *   · elle voyage par le canal existant (`contacts` est publié en entier) — pas
 *     de nouveau modèle d'e-mail, pas de provisionnement par projet ;
 *   · elle n'est PAS l'expéditeur du parc, ni l'adresse Let's Encrypt, ni
 *     l'adresse administrative, ni celle d'un SUPER_ADMIN ;
 *   · une chaîne vide devient `null`, jamais une valeur « présente mais vide » ;
 *   · la migration reprend la valeur qui servait DÉJÀ à cet usage, et n'en
 *     invente aucune.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
/** Ces fichiers EXPLIQUENT longuement ce qu'ils refusent : on décommente. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const { validateCompanyInput } = await import('../backend/src/services/company/company.validation.js');
const { companyPublicProfile } = await import('../backend/src/services/company/company.service.js');
const { migratePublicContactEmail } = await import(
  '../backend/src/scripts/migrations/2026-08-21-public-contact-email.js'
);

const ficheMinimale = (extra = {}) => ({
  companyId: 'c-1',
  slug: 'agence',
  environment: 'TEST',
  identity: { name: 'Agence Démo' },
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. L’adresse est un CHAMP, validé comme les autres');
{
  const bon = validateCompanyInput(
    ficheMinimale({ contacts: { publicContactEmail: '  Contact@Exemple.FR ' } }),
    { creating: true },
  );
  check('une adresse valide est acceptée', bon.valid);
  check('…normalisée : sans espaces, en minuscules',
    bon.value?.contacts?.publicContactEmail === 'contact@exemple.fr');

  const mauvais = validateCompanyInput(
    ficheMinimale({ contacts: { publicContactEmail: 'pas-une-adresse' } }),
    { creating: true },
  );
  check('une adresse illisible est refusée', !mauvais.valid);
  check('…et le message NOMME le champ',
    mauvais.errors.some((e) => e.includes('contacts.publicContactEmail')));

  /*
    EFFACER EST UNE INTENTION, PAS UNE ERREUR.

    L'ancienne règle validait le format AVANT de transformer : `''` échouait au
    contrôle e-mail et n'atteignait jamais la normalisation en `null`. Vider le
    champ était donc impossible — le seul contournement était de laisser une
    adresse périmée publiée aux projets.
  */
  const efface = validateCompanyInput(
    ficheMinimale({ contacts: { publicContactEmail: '' } }),
    { creating: true },
  );
  check('une chaîne vide est acceptée…', efface.valid);
  check('…et devient NULL, jamais une chaîne vide',
    efface.value?.contacts?.publicContactEmail === null);
  check('la même règle vaut pour les autres adresses de la fiche',
    validateCompanyInput(ficheMinimale({ contacts: { email: '', supportEmail: '' } }), { creating: true }).valid);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Elle voyage par le canal EXISTANT — rien de neuf à provisionner');
{
  const profil = companyPublicProfile({
    companyId: 'c-1',
    slug: 'agence',
    environment: 'TEST',
    identity: { name: 'Agence Démo' },
    contacts: { email: 'admin@agence.fr', supportEmail: 'certs@agence.fr', publicContactEmail: 'bonjour@agence.fr' },
    references: [],
    team: [],
  });
  check('la projection publiée porte l’adresse',
    profil.contacts.publicContactEmail === 'bonjour@agence.fr');
  check('…dans le bloc `contacts` déjà publié, sans clé nouvelle au sommet',
    !Object.keys(profil).includes('publicContactEmail'));

  const service = code(lire('backend/src/services/company/company.service.js'));
  check('aucun modèle d’e-mail n’est créé pour elle',
    !/publicContactEmail[\s\S]{0,200}templateCode/.test(service));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. Trois adresses, trois métiers — et aucune ne se substitue');
{
  const modele = code(lire('backend/src/models/PanelCompany.model.js'));
  check('l’adresse Let’s Encrypt existe toujours, à part', /supportEmail: \{ type: String/.test(modele));
  check('le contact public est un champ distinct', /publicContactEmail: \{ type: String/.test(modele));

  const ecran = code(lire('backend/src/services/email/panelEmailSenderTest.service.js'));
  check('l’écran lit le contact depuis l’ENTREPRISE, pas depuis l’expéditeur',
    /getActiveCompany\(\)[\s\S]{0,200}contacts\?\.publicContactEmail/.test(ecran));
  check('…et ne le recopie jamais dans la configuration d’expéditeur',
    !/senderEmail[\s\S]{0,80}publicContactEmail/.test(ecran));

  const routes = code(lire('backend/src/routes/emailSender.routes.js'));
  check('l’écriture est réservée aux DEV',
    /public-contact', requirePanelDev/.test(routes));

  const controleur = code(lire('backend/src/controllers/emailSender.controller.js'));
  check('l’écriture passe par l’autorité d’identité, qui publie',
    /saveCompany\(/.test(controleur));
  check('…jamais par une écriture directe en base',
    !/PanelCompany\.updateOne/.test(controleur));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. La migration reprend l’existant — elle n’invente aucune identité');
{
  await PanelCompany.deleteMany({});
  /* `createdAt`/`updatedAt` sont requis par le modèle : le Panel les écrit
     lui-même partout, ce test doit donc les fournir comme le ferait le
     service — sans quoi il éprouverait le schéma, pas la migration. */
  const horodatage = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  await PanelCompany.create([
    {
      companyId: 'c-refs', slug: 'a', environment: 'TEST', active: true,
      ...horodatage,
      identity: { name: 'Avec références' },
      contacts: { email: 'admin@a.fr', supportEmail: 'certs@a.fr' },
      references: [
        { type: 'LINK', name: 'Site', value: 'https://a.fr', order: 0 },
        { type: 'LINK', name: 'Support', value: 'Bonjour@A.FR', order: 1 },
      ],
    },
    {
      companyId: 'c-vide', slug: 'b', environment: 'TEST', active: false,
      ...horodatage,
      identity: { name: 'Sans référence e-mail' },
      contacts: { email: 'admin@b.fr', supportEmail: 'certs@b.fr' },
      references: [{ type: 'LINK', name: 'Site', value: 'https://b.fr', order: 0 }],
    },
    {
      companyId: 'c-deja', slug: 'c', environment: 'TEST', active: false,
      ...horodatage,
      identity: { name: 'Déjà décidée' },
      contacts: { publicContactEmail: 'choisi@c.fr' },
      references: [{ type: 'LINK', name: 'Autre', value: 'autre@c.fr', order: 0 }],
    },
  ]);

  const rapport = await migratePublicContactEmail({ dryRun: true });
  check('la simulation compte ce qu’elle FERAIT', rapport.reprises === 1 && rapport.vides === 1 && rapport.deja === 1);
  const apresSimulation = await PanelCompany.findOne({ companyId: 'c-refs' }).lean();
  check('…et n’écrit rien', !apresSimulation.contacts?.publicContactEmail);

  await migratePublicContactEmail();
  const refs = await PanelCompany.findOne({ companyId: 'c-refs' }).lean();
  check('la première adresse des références est reprise',
    refs.contacts.publicContactEmail === 'bonjour@a.fr');
  check('…normalisée en minuscules', refs.contacts.publicContactEmail === refs.contacts.publicContactEmail.toLowerCase());

  const vide = await PanelCompany.findOne({ companyId: 'c-vide' }).lean();
  /*
    AUCUNE ADRESSE N'EST INVENTÉE. Les trois candidats évidents sont refusés :
    l'adresse administrative, l'adresse Let's Encrypt, et l'expéditeur du parc.
    Publier au nom de l'agence une adresse que personne n'a choisie serait une
    décision d'identité prise à la place de l'opérateur.
  */
  check('sans référence e-mail, le champ reste VIDE',
    (vide.contacts.publicContactEmail ?? null) === null);
  check('…surtout pas l’adresse administrative', vide.contacts.publicContactEmail !== 'admin@b.fr');
  check('…ni l’adresse des certificats', vide.contacts.publicContactEmail !== 'certs@b.fr');

  const deja = await PanelCompany.findOne({ companyId: 'c-deja' }).lean();
  check('une décision déjà prise n’est jamais écrasée', deja.contacts.publicContactEmail === 'choisi@c.fr');

  const second = await migratePublicContactEmail();
  check('un second passage ne reprend plus rien', second.reprises === 0);
  const relu = await PanelCompany.findOne({ companyId: 'c-refs' }).lean();
  check('…et la valeur est inchangée', relu.contacts.publicContactEmail === 'bonjour@a.fr');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. Aucune adresse en dur dans le runtime');
{
  const racineSrc = path.join(racine, 'backend', 'src');
  const fichiers = [];
  const parcourir = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const complet = path.join(dir, e.name);
      if (e.isDirectory()) parcourir(complet);
      else if (e.name.endsWith('.js')) fichiers.push(complet);
    }
  };
  parcourir(racineSrc);

  const fautifs = fichiers.filter((f) => {
    const brut = fs.readFileSync(f, 'utf8');
    /* Les commentaires citent les adresses pour EXPLIQUER ce qui est refusé. */
    return /@lycarz\.com/.test(code(brut));
  }).map((f) => path.relative(racine, f));

  check('aucune adresse de contact codée en dur', fautifs.length === 0, fautifs.join(' | '));

  /*
    L'ADRESSE DU COMPTE SOUVERAIN N'EST PAS UN CONTACT PUBLIC.

    `SOVEREIGN_BOOTSTRAP_EMAIL` existe et doit exister : c'est le compte qui
    permet d'ouvrir un Panel neuf. Elle est nominative, elle appartient à une
    personne, et la publier au nom de l'entreprise en ferait l'adresse de
    support de tous les clients du parc — sans que personne l'ait décidé.

    Le contrôle porte sur la PROXIMITÉ : ce qui serait grave, c'est qu'un
    module la lise pour en faire un repli de contact.
  */
  const auth = code(lire('backend/src/services/auth/panelUsers.service.js'));
  check('le compte souverain reste une porte d’entrée, pas un contact',
    !/SOVEREIGN_BOOTSTRAP_EMAIL[\s\S]{0,200}(publicContact|supportEmail)/.test(auth));
  for (const rel of [
    'backend/src/services/email/panelEmailSenderTest.service.js',
    'backend/src/controllers/emailSender.controller.js',
    'backend/src/services/company/company.service.js',
  ]) {
    check(`${path.basename(rel)} n’en fait aucun repli`,
      !/SOVEREIGN_BOOTSTRAP_EMAIL/.test(code(lire(rel))));
  }
}

await stopMemoryMongo();
finish();
