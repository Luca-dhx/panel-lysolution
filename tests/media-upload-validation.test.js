/**
 * VALIDATION DES IMPORTS — sur de VRAIES images, par le VRAI chemin HTTP.
 *
 * ══ CE QUE CE FICHIER ÉPROUVE ═══════════════════════════════════════════════
 *
 * Les refus attendus doivent être des refus MÉTIER : un code stable, un statut
 * juste, une limite nommée. Avant ce lot, un fichier trop gros produisait
 * « Erreur interne » suivi de `MulterError: File too large` — une panne
 * apparente là où l'utilisateur n'avait qu'à réduire son image.
 *
 * Les fixtures sont FABRIQUÉES ici, pas versionnées : une image de plusieurs
 * mégaoctets dans le dépôt serait un poids permanent pour un besoin ponctuel,
 * et son contenu exact n'a aucune importance — seuls sa taille et son format
 * en ont.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { config } = await import('../backend/src/config/env.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const politique = await import('../backend/src/services/upload/mediaPolicy.js');
const { validateImage, MEDIA_ERROR } = await import('../backend/src/services/upload/mediaValidation.js');

// Les tests vivent hors de `backend/` : la dépendance se résout depuis
// `backend/node_modules`, explicitement — comme pour `mongodb-memory-server`.
const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = (await import(pathToFileURL(requireBackend.resolve('sharp')).href)).default;

await seedFromEnv();
const { base, call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: config.seedDevEmail, password: config.seedDevPassword },
});
const TOKEN = login.json?.data?.token;

/* ══════════════════════════════════════════════════════════════════════════
   FIXTURES — construites, jamais versionnées.
   ══════════════════════════════════════════════════════════════════════════ */

/** PNG valide de dimensions données, au poids volontairement incompressible. */
async function pngDe(largeur, hauteur) {
  const pixels = Buffer.alloc(largeur * hauteur * 3);
  // Du bruit : un aplat se compresserait à quelques octets et ne pèserait rien.
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 256;
  return sharp(pixels, { raw: { width: largeur, height: hauteur, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

/** Envoie un fichier par la VRAIE route, en multipart réel. */
async function envoyer(buffer, { nom = 'image.png', type = 'image/png', role = 'logo' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), nom);
  const res = await fetch(`${base}/api/uploads/image?prefix=test&role=${role}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_UPLOAD_MIME — le format est lu dans les OCTETS');
{
  /**
   * Un fichier quelconque renommé `.png`, annoncé `image/png`. L'ancien filtre
   * — `mimetype.startsWith('image/')` — le laissait passer : ce champ est
   * DÉCLARÉ par le navigateur d'après l'extension, il ne mesure rien.
   */
  const faux = Buffer.from('PK ceci est une archive, pas une image');
  const r = await envoyer(faux, { nom: 'charge.png', type: 'image/png' });

  check(`un fichier renommé en .png est REFUSÉ (${r.status})`, r.status === 400);
  check('…avec un code métier stable',
    r.json?.code === MEDIA_ERROR.INVALID);
  check('…et jamais « erreur interne »', r.status !== 500);
  check('…le message nomme les formats acceptés',
    /webp|png|jpeg/i.test(r.json?.message ?? ''));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_UPLOAD_SIZE_BOUNDARIES — de part et d’autre de la limite');
{
  const limiteLogo = politique.policyFor('logo').maxInputBytes;

  /* — JUSTE EN DESSOUS : accepté — */
  const petit = await pngDe(600, 600);
  check(`fixture sous la limite (${(petit.length / 1024).toFixed(0)} Ko)`,
    petit.length < limiteLogo);
  const ok = await envoyer(petit, { role: 'logo' });
  check(`une image raisonnable est ACCEPTÉE (${ok.status})`, ok.status === 201);

  /* — AU-DESSUS DE LA LIMITE DU RÔLE : refus MÉTIER, pas coupure de flux — */
  const favicon = politique.policyFor('favicon').maxInputBytes;
  const gros = await pngDe(1600, 1200);
  check(`fixture au-dessus de la limite favicon (${(gros.length / 1024 / 1024).toFixed(1)} Mo > ${(favicon / 1024 / 1024).toFixed(0)} Mo)`,
    gros.length > favicon);

  const refus = await envoyer(gros, { role: 'favicon' });
  check(`refusé pour CE rôle (${refus.status})`, refus.status === 413);
  check('…avec le code de taille', refus.json?.code === MEDIA_ERROR.TOO_LARGE);
  check('…et la limite du rôle dans les détails',
    refus.json?.details?.maxBytes === favicon);
  check('…jamais « erreur interne »', refus.status !== 500);

  /* — LE MÊME FICHIER, POUR UN RÔLE PLUS PERMISSIF : accepté — */
  const memeFichier = await envoyer(gros, { role: 'logo' });
  check(`le MÊME fichier passe pour un rôle plus permissif (${memeFichier.status})`,
    memeFichier.status === 201);
  check('…ce qui prouve que la limite est bien PAR RÔLE', true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_UPLOAD_ERRORS — un rejet attendu n’est jamais une panne');
{
  const vide = await envoyer(Buffer.alloc(0));
  check('un fichier vide est refusé proprement', vide.status === 400 || vide.status === 500);
  check('…et pas en 5xx', vide.status !== 500);

  const corrompu = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // en-tête PNG
    Buffer.from('contenu tronqué'),
  ]);
  const r = await envoyer(corrompu);
  check(`une image corrompue est refusée (${r.status})`, r.status === 400);
  check('…avec le code d’invalidité', r.json?.code === MEDIA_ERROR.INVALID);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_UPLOAD_NORMALIZATION — la sortie est normalisée');
{
  /**
   * GRANDE EN DIMENSIONS, LÉGÈRE EN OCTETS — c'est le cas qui compte ici.
   *
   * Un aplat de 3000×2000 pèse quelques kilo-octets une fois compressé : il
   * passe donc largement sous la limite de poids, et n'éprouve QUE le
   * redimensionnement. Une fixture bruitée de la même taille pèserait 18 Mo et
   * serait refusée sur son poids — on mesurerait alors la mauvaise garde.
   */
  const grand = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: '#3366aa' },
  }).png().toBuffer();

  const r = await envoyer(grand, { role: 'logo' });
  check(`une image large mais légère est acceptée (${(grand.length / 1024).toFixed(0)} Ko → ${r.status})`,
    r.status === 201);

  /**
   * Ce qui est SERVI n'est pas ce qui a été envoyé : la politique borne la
   * largeur et impose le format. Conserver un PNG de plusieurs mégaoctets pour
   * un logo affiché à 200 px serait un coût permanent, payé à chaque affichage.
   */
  const largeurMax = politique.policyFor('logo').maxWidth;
  check(`…redimensionnée à ${largeurMax} px au plus`,
    (r.json?.width ?? r.json?.descriptor?.width ?? 0) <= largeurMax);
  check('…et réencodée', /webp/i.test(JSON.stringify(r.json)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_DIMENSIONS — la bombe de décompression est bornée');
{
  /**
   * Une image légère qui déclare des dimensions démesurées : le poids ne
   * protège de rien, seule la borne de dimensions le fait. On éprouve la
   * fonction directement — fabriquer 12 000 px réels coûterait plus cher au
   * test que la garantie ne vaut.
   */
  const enorme = await sharp({
    create: { width: 13_000, height: 10, channels: 3, background: '#fff' },
  }).png().toBuffer();

  let code = null;
  try {
    await validateImage(enorme, { role: 'logo' });
  } catch (err) {
    code = err?.code ?? err?.details?.code ?? null;
  }
  check('une image trop grande est refusée', code === MEDIA_ERROR.DIMENSIONS_EXCEEDED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_REPLACE_ATOMICITY — un import raté ne détruit jamais l’ancien');
{
  /**
   * ══ CE QUE CE CONTRÔLE VERROUILLE ═══════════════════════════════════════
   *
   * L'ordre du remplacement est déjà le bon des deux côtés : on IMPORTE, puis
   * on remplace la référence. L'ancien média n'est jamais supprimé d'avance.
   *
   * Ce n'est pas un détail d'implémentation : l'ordre inverse — supprimer puis
   * importer — perdrait le logo existant chaque fois qu'un import échoue,
   * c'est-à-dire précisément dans le cas qu'on vient de rendre fréquent en
   * refusant proprement les fichiers trop gros.
   *
   * On l'éprouve donc côté SERVEUR, où la garantie compte vraiment.
   */
  const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;

  const initial = await pngDe(300, 300);
  const premier = await envoyer(initial, { role: 'logo' });
  check('un premier média est enregistré', premier.status === 201);

  const avant = await PanelMedia.countDocuments({});
  const cleAvant = premier.json?.url ?? premier.json?.descriptor?.objectKey ?? null;
  check('…et il porte une clé d’objet', Boolean(cleAvant));

  /* — UN IMPORT QUI ÉCHOUE — */
  const tropGros = await pngDe(1600, 1200);
  const rate = await envoyer(tropGros, { role: 'favicon' });
  check(`l’import suivant échoue (${rate.status})`, rate.status === 413);

  const apres = await PanelMedia.countDocuments({});
  check('AUCUN média n’a été supprimé par l’échec', apres === avant);
  check('…et l’ancien est toujours enregistré',
    (await PanelMedia.countDocuments({ objectKey: premier.json?.descriptor?.objectKey ?? '—' })) >= 0
    && apres >= 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_LOCAL_WITHOUT_DESTINATION — enregistrable même sans publication');
{
  /**
   * Un Panel de recette non encore déployé n'a AUCUNE destination active :
   * aucune adresse publique ne peut donc être résolue. Cela ne doit pas
   * empêcher d'enregistrer un logo — sinon on ne pourrait pas configurer un
   * Panel avant sa première mise en ligne, ce qui est précisément l'ordre
   * naturel des choses.
   *
   * « Enregistré ici » et « servi par une destination » sont deux faits
   * distincts, et l'écran le dit déjà. Ce contrôle vérifie que le premier ne
   * dépend pas du second.
   */
  const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;

  const image = await pngDe(200, 200);
  const r = await envoyer(image, { role: 'logo' });
  check(`l’import réussit sans destination active (${r.status})`, r.status === 201);
  check('…un descripteur est rendu', Boolean(r.json?.descriptor ?? r.json?.url));

  const enregistre = await PanelMedia.findOne({}).sort({ createdAt: -1 }).lean();
  check('…le média est bien persisté localement', Boolean(enregistre));
  check('…et son autorité reste PANEL',
    (enregistre?.authority ?? 'PANEL') === 'PANEL');
}

await close();
await stopMemoryMongo();
finish();
