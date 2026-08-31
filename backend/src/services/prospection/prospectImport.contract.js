/**
 * LE CONTRAT D'IMPORT D'UN PROSPECT — lecture pure d'un document JSON.
 *
 * ══ POURQUOI CE MODULE NE TOUCHE PAS LA BASE ════════════════════════════════
 *
 * Lire un document reçu d'un tiers et l'écrire sont deux gestes distincts, et
 * c'est le premier qui porte tout le risque. Ce fichier ne fait QUE le premier :
 * il transforme un objet quelconque en une structure connue, et il dit ce qu'il
 * n'a pas su lire. Aucune connexion, aucun identifiant de fiche, aucune date de
 * modification — donc une fonction éprouvable ligne à ligne, sans base de
 * données ni serveur.
 *
 * ══ LA RÈGLE CARDINALE : ON N'ÉCHOUE PAS SUR UN DÉTAIL ═════════════════════
 *
 * Un rapport de qualification est écrit par une équipe, à la main, souvent
 * depuis un tableur. Il contiendra des colonnes qu'on n'attendait pas, des
 * dates au mauvais format, un lien vide, une tâche sans intitulé.
 *
 * Refuser le document entier pour l'une de ces raisons rendrait l'import
 * inutilisable : personne ne corrige un fichier de quarante entreprises parce
 * que la troisième a un `sentAt` illisible. Chaque élément fautif est donc
 * ÉCARTÉ et CONSIGNÉ — `ignores` porte le chemin et la raison, et l'écran les
 * montre AVANT que quoi que ce soit ne soit écrit.
 *
 * Les deux seuls refus durs sont : le document n'est pas un objet, et la fiche
 * n'a pas de nom alors qu'il faut la créer. Dans les deux cas, il n'y a
 * simplement rien à importer.
 *
 * ══ CE QUI N'EST PAS RECONNU N'EST PAS DEVINÉ ══════════════════════════════
 *
 * Une clef inconnue n'est jamais convertie en information libre « au cas où ».
 * Le carnet se remplirait de `rowId`, `_source` et `scrapedAt`, et il faudrait
 * les retirer un par un. Elle est listée dans `ignores` : celui qui produit le
 * fichier voit ce que le Panel n'a pas su placer, et corrige la SOURCE.
 */

/* ══════════════════════════════════════════════════════════════════════════
   LES DEUX MANIÈRES D'APPLIQUER
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * COMPLÉTER ou REMPLACER — et rien entre les deux.
 *
 * `MERGE`   ce que le document apporte s'ajoute ; ce que la fiche portait déjà
 *           et que le document ne mentionne pas RESTE. C'est le défaut, parce
 *           qu'un rapport de qualification complète un carnet, il ne le refait
 *           pas.
 * `REPLACE` chaque section PRÉSENTE dans le document devient exactement ce
 *           qu'il dit ; ce qu'elle contenait et qu'il ne reprend pas est
 *           retiré. Une section absente du document n'est jamais touchée —
 *           sans quoi un fichier qui ne parle que des messages viderait les
 *           liens.
 */
export const IMPORT_MODES = Object.freeze({ MERGE: 'MERGE', REPLACE: 'REPLACE' });
export const IMPORT_MODE_VALUES = Object.freeze(Object.values(IMPORT_MODES));

/** La version du contrat que ce module sait lire. Voir la documentation. */
export const PROSPECT_IMPORT_VERSION = 1;

/* ══════════════════════════════════════════════════════════════════════════
   OUTILS
   ══════════════════════════════════════════════════════════════════════════ */

const estObjet = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const texte = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

/**
 * LA CLEF DE COMPARAISON — sans accent, sans casse, sans espace superflu.
 *
 * Elle sert à reconnaître « Fiche Google » et « fiche google » comme la même
 * chose. Sans elle, un second import créerait un doublon de chaque étiquette
 * dont la casse a changé entre deux rapports.
 */
export const aplatir = (v) => texte(v)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

/**
 * UNE DATE, OU RIEN — et « rien » n'est pas une erreur.
 *
 * `null` remonte pour une valeur absente ; `undefined` pour une valeur PRÉSENTE
 * mais illisible. Les deux ne se traitent pas pareil : la première ne dit rien,
 * la seconde doit être consignée dans `ignores`.
 */
function date(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const d = new Date(valeur);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * UNE ADRESSE CLIQUABLE.
 *
 * Personne ne tape « https:// » devant l'adresse d'un site : on préfixe. Un
 * schéma exotique (`javascript:`, `data:`) est en revanche REFUSÉ — c'est la
 * seule chose que cette fonction protège vraiment, et la même règle que la
 * saisie manuelle d'un lien.
 */
export function lienValide(brut) {
  const url = texte(brut);
  if (!url) return null;
  const candidat = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  let analyse;
  try {
    analyse = new URL(candidat);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(analyse.protocol)) return null;
  return analyse.toString();
}

/* ══════════════════════════════════════════════════════════════════════════
   LES SYNONYMES — ce que l'équipe écrit vraiment
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * LES ÉTATS, ET LEURS NOMS FRANÇAIS.
 *
 * Le Panel stocke `IN_PROGRESS`. Le rapport écrit « en cours ». Exiger la
 * constante aurait obligé l'équipe à apprendre un vocabulaire technique pour
 * remplir une colonne — et un seul « En cours » avec une majuscule aurait fait
 * retomber la fiche sur le défaut sans un mot.
 */
const ALIAS_STATUT = new Map(Object.entries({
  waiting: 'WAITING', 'a contacter': 'WAITING', 'a faire': 'WAITING',
  'en attente': 'WAITING', nouveau: 'WAITING',
  in_progress: 'IN_PROGRESS', 'in progress': 'IN_PROGRESS', 'en cours': 'IN_PROGRESS',
  contacte: 'IN_PROGRESS', relance: 'IN_PROGRESS',
  planned: 'PLANNED', planifie: 'PLANNED', rdv: 'PLANNED', 'rendez-vous': 'PLANNED',
  lost: 'LOST', perdu: 'LOST', refuse: 'LOST', 'sans suite': 'LOST',
  signed: 'SIGNED', signe: 'SIGNED', gagne: 'SIGNED', client: 'SIGNED',
}));

const ALIAS_TYPE = new Map(Object.entries({
  creation: 'CREATION', conception: 'CREATION', 'nouveau site': 'CREATION',
  'sans site': 'CREATION', new: 'CREATION',
  redesign: 'REDESIGN', refonte: 'REDESIGN', 'site existant': 'REDESIGN',
  'avec site': 'REDESIGN',
}));

/**
 * LES CLEFS DE COORDONNÉES, ET LEURS SYNONYMES.
 *
 * Un rapport écrit `nom`, `telephone`, `mail`. Le modèle dit `name`, `phone`,
 * `email`. Traduire ici coûte trois lignes ; l'exiger de l'équipe coûte un
 * aller-retour par fichier.
 */
const ALIAS_CHAMPS = new Map(Object.entries({
  nom: 'name', raisonsociale: 'name', entreprise: 'name', societe: 'name',
  mail: 'email', courriel: 'email', 'e-mail': 'email',
  telephone: 'phone', tel: 'phone', portable: 'phone', mobile: 'phone',
  notesinternes: 'notes', commentaire: 'notes', commentaires: 'notes', remarques: 'notes',
  statut: 'status', etat: 'status',
  nature: 'type', typeaffaire: 'type',
  dossier: 'folderPath', chemin: 'folderPath',
  informations: 'infoFields', infos: 'infoFields', info: 'infoFields',
  liens: 'links',
  concurrents: 'competitors',
  messages: 'messages', communication: 'messages', mails: 'messages', emails: 'messages',
  taches: 'tasks',
  rendezvous: 'meetings', reunions: 'meetings',
  images: 'images', photos: 'images',
}));

/**
 * LES LIENS QU'ON REÇOIT SOUS FORME DE COLONNE.
 *
 * Le rapport de qualification porte `googleUrl`, `instagram`, `siteActuel` —
 * une colonne par réseau, pas une liste d'objets. Les nommer ici évite à
 * l'équipe de reconstruire un tableau `links` à la main, ce qu'un tableur ne
 * sait pas faire.
 */
const LIENS_CONNUS = new Map(Object.entries({
  website: 'Site officiel', site: 'Site officiel', siteweb: 'Site officiel',
  siteurl: 'Site officiel', websiteurl: 'Site officiel', siteactuel: 'Site actuel',
  google: 'Fiche Google', googleurl: 'Fiche Google', fichegoogle: 'Fiche Google',
  googlebusiness: 'Fiche Google', googlebusinessurl: 'Fiche Google',
  googlemaps: 'Google Maps', maps: 'Google Maps', mapsurl: 'Google Maps',
  instagram: 'Instagram', instagramurl: 'Instagram',
  facebook: 'Facebook', facebookurl: 'Facebook',
  linkedin: 'LinkedIn', linkedinurl: 'LinkedIn',
  tiktok: 'TikTok', youtube: 'YouTube', x: 'X', twitter: 'X',
  tripadvisor: 'TripAdvisor', thefork: 'TheFork', ubereats: 'Uber Eats',
  deliveroo: 'Deliveroo', pagesjaunes: 'Pages Jaunes',
}));

/** Ce qui est reconnu à la racine du document, hors coordonnées. */
const CLEFS_ENVELOPPE = new Set([
  '$schema', 'version', 'prospect', 'messages', 'tasks', 'meetings', 'source', 'generatedAt',
]);

const CLEFS_PROSPECT = new Set([
  'name', 'email', 'phone', 'notes', 'status', 'type',
  'folderId', 'folderPath', 'links', 'infoFields', 'images', 'competitors',
]);

/* ══════════════════════════════════════════════════════════════════════════
   LES SECTIONS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * L'ORDRE DES SECTIONS EST CELUI DE L'APERÇU.
 *
 * Il va de ce qui identifie la fiche vers ce qui s'y rattache : on lit d'abord
 * QUI, puis OÙ c'est rangé, puis ce qu'on en sait, puis ce qui reste à faire.
 * L'écran ne décide donc de rien — il suit cette liste, et une section ajoutée
 * ici apparaît sans qu'on touche au frontend.
 */
export const SECTIONS = Object.freeze([
  { key: 'identity', label: 'Coordonnées' },
  { key: 'classement', label: 'Classement' },
  { key: 'notes', label: 'Notes internes' },
  { key: 'infoFields', label: 'Informations' },
  { key: 'links', label: 'Liens' },
  { key: 'images', label: 'Images' },
  { key: 'messages', label: 'Communication' },
  { key: 'tasks', label: 'Tâches' },
  { key: 'meetings', label: 'Rendez-vous' },
]);

/* ══════════════════════════════════════════════════════════════════════════
   LECTURE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * DÉPLIER L'ENVELOPPE — les deux formes acceptées.
 *
 * ── LA FORME COMPLÈTE ───────────────────────────────────────────────────────
 *   { "version": 1, "prospect": { … }, "messages": [ … ], "tasks": [ … ] }
 *
 * ── LA FORME PLATE ──────────────────────────────────────────────────────────
 *   { "name": "…", "email": "…", "messages": [ … ] }
 *
 * La seconde est celle qu'un tableur produit sans effort, et refuser de la lire
 * aurait obligé l'équipe à emboîter ses colonnes à la main. On reconnaît la
 * forme complète à la seule présence de `prospect` ; sinon, la racine EST la
 * fiche, et `messages` / `tasks` / `meetings` y cohabitent.
 */
function deplier(document) {
  if (estObjet(document.prospect)) {
    return {
      fiche: document.prospect,
      messages: document.messages,
      tasks: document.tasks,
      meetings: document.meetings,
      racineEstFiche: false,
    };
  }
  return {
    fiche: document,
    messages: document.messages,
    tasks: document.tasks,
    meetings: document.meetings,
    racineEstFiche: true,
  };
}

/** Traduit les synonymes de clefs, sans écraser une clef canonique présente. */
function canoniser(brut) {
  const sortie = {};
  const inconnues = [];
  for (const [clef, valeur] of Object.entries(brut ?? {})) {
    if (CLEFS_ENVELOPPE.has(clef)) continue;
    const plate = aplatir(clef).replace(/[\s_-]/g, '');
    const canonique = CLEFS_PROSPECT.has(clef)
      ? clef
      : (ALIAS_CHAMPS.get(plate) ?? null);
    if (canonique) {
      if (sortie[canonique] === undefined) sortie[canonique] = valeur;
      continue;
    }
    if (LIENS_CONNUS.has(plate)) {
      sortie.__liensPlats = sortie.__liensPlats ?? [];
      sortie.__liensPlats.push({ label: LIENS_CONNUS.get(plate), url: valeur });
      continue;
    }
    inconnues.push(clef);
  }
  return { sortie, inconnues };
}

/**
 * LES INFORMATIONS LIBRES — liste d'objets OU dictionnaire.
 *
 * `{ "Budget annoncé": "3 000 €" }` est ce qu'un rapport écrit naturellement ;
 * `[{ "label": …, "value": … }]` est ce que le Panel renvoie. Les deux entrent,
 * parce qu'obliger l'équipe à produire la seconde forme serait la faire coder.
 */
function lireInformations(brut, ignores, chemin) {
  if (brut === undefined || brut === null) return null;

  const entrees = Array.isArray(brut)
    ? brut.map((e, i) => [i, e])
    : (estObjet(brut) ? Object.entries(brut) : null);

  if (entrees === null) {
    ignores.push({ path: chemin, reason: 'Attendu : une liste ou un dictionnaire.' });
    return null;
  }

  const sortie = [];
  for (const [clef, valeur] of entrees) {
    const objet = estObjet(valeur);
    const label = texte(objet ? (valeur.label ?? valeur.nom ?? valeur.name) : clef).slice(0, 120);
    const contenu = texte(objet ? (valeur.value ?? valeur.valeur ?? valeur.contenu) : valeur)
      .slice(0, 4000);
    if (!label) {
      ignores.push({ path: `${chemin}[${clef}]`, reason: 'Une information sans nom est illisible.' });
      continue;
    }
    sortie.push({ id: texte(objet ? valeur.id : '') || null, label, value: contenu });
  }
  return sortie;
}

function lireLiens(brut, plats, ignores, chemin) {
  const sortie = [];
  const pousser = (label, url, ou) => {
    const adresse = lienValide(url);
    if (!adresse) {
      if (texte(url)) ignores.push({ path: ou, reason: `Adresse inutilisable : ${texte(url)}` });
      return;
    }
    sortie.push({ id: null, label: texte(label).slice(0, 120), url: adresse });
  };

  for (const plat of plats ?? []) pousser(plat.label, plat.url, `${chemin}.${plat.label}`);

  if (brut === undefined || brut === null) return sortie.length ? sortie : null;

  if (Array.isArray(brut)) {
    brut.forEach((lien, i) => {
      if (estObjet(lien)) {
        pousser(lien.label ?? lien.nom ?? lien.title, lien.url ?? lien.href ?? lien.lien, `${chemin}[${i}]`);
      } else {
        pousser('', lien, `${chemin}[${i}]`);
      }
    });
    return sortie;
  }
  if (estObjet(brut)) {
    for (const [label, url] of Object.entries(brut)) pousser(label, url, `${chemin}.${label}`);
    return sortie;
  }
  ignores.push({ path: chemin, reason: 'Attendu : une liste de liens ou un dictionnaire.' });
  return sortie.length ? sortie : null;
}

/**
 * LES CONCURRENTS — un nom et une adresse, donc un LIEN.
 *
 * Les ranger ailleurs qu'avec les liens aurait créé une troisième liste dont
 * personne n'aurait su qu'elle existe. Ils sont donc des liens, étiquetés
 * « Concurrent — … », et leur commentaire éventuel devient une information
 * libre du même nom : le lien s'ouvre, la note se lit.
 */
function lireConcurrents(brut, ignores, chemin) {
  if (brut === undefined || brut === null) return { liens: [], infos: [] };
  if (!Array.isArray(brut)) {
    ignores.push({ path: chemin, reason: 'Attendu : une liste de concurrents.' });
    return { liens: [], infos: [] };
  }
  const liens = [];
  const infos = [];
  brut.forEach((c, i) => {
    const objet = estObjet(c);
    const nom = texte(objet ? (c.name ?? c.nom ?? c.label) : '').slice(0, 90);
    const url = lienValide(objet ? (c.url ?? c.site ?? c.website) : c);
    const note = texte(objet ? (c.note ?? c.notes ?? c.commentaire) : '');
    const etiquette = nom ? `Concurrent — ${nom}` : 'Concurrent';
    if (url) liens.push({ id: null, label: etiquette, url });
    else if (!note) {
      ignores.push({ path: `${chemin}[${i}]`, reason: 'Un concurrent sans adresse ni note n’apporte rien.' });
      return;
    }
    if (note) infos.push({ id: null, label: etiquette.slice(0, 120), value: note.slice(0, 4000) });
  });
  return { liens, infos };
}

/**
 * LES IMAGES — seulement celles que le Panel héberge déjà.
 *
 * Une adresse externe serait morte le jour où le site d'en face change, et le
 * Panel n'ira pas la télécharger : rapatrier un fichier depuis une adresse
 * fournie par un tiers, c'est ouvrir une porte vers le réseau interne. Les
 * images s'importent par le formulaire, qui les réencode.
 */
function lireImages(brut, ignores, chemin) {
  if (brut === undefined || brut === null) return null;
  if (!Array.isArray(brut)) {
    ignores.push({ path: chemin, reason: 'Attendu : une liste d’images.' });
    return null;
  }
  const sortie = [];
  brut.forEach((img, i) => {
    const objet = estObjet(img);
    const url = texte(objet ? img.url : img);
    if (!url.startsWith('/uploads/')) {
      ignores.push({
        path: `${chemin}[${i}]`,
        reason: 'Seule une image déjà importée dans le Panel (/uploads/…) peut être citée.',
      });
      return;
    }
    sortie.push({
      id: texte(objet ? img.id : '') || null,
      url,
      filename: texte(objet ? img.filename : '') || null,
      caption: texte(objet ? img.caption : '').slice(0, 200),
    });
  });
  return sortie;
}

/**
 * UN MESSAGE — et la question qui décide de tout : est-il PARTI ?
 *
 * `sentAt` porte l'état à lui seul, côté modèle. Le document, lui, peut le dire
 * de trois façons : une date, un booléen `sent`, ou un `status` textuel. Les
 * trois entrent, et une seule sort — la date, ou `null`.
 *
 * Un `sent: true` sans date reçoit l'instant de l'import, et le dit dans
 * `ignores` : une date fausse vaut mieux qu'un message qu'on croit à envoyer et
 * qu'on renvoie une seconde fois, mais elle ne doit pas passer inaperçue.
 */
function lireMessages(brut, ignores, chemin) {
  if (brut === undefined || brut === null) return null;
  if (!Array.isArray(brut)) {
    ignores.push({ path: chemin, reason: 'Attendu : une liste de messages.' });
    return null;
  }
  const maintenant = new Date();
  const sortie = [];
  brut.forEach((m, i) => {
    if (!estObjet(m)) {
      ignores.push({ path: `${chemin}[${i}]`, reason: 'Attendu : un objet message.' });
      return;
    }
    const channel = texte(m.channel ?? m.canal ?? 'E-mail').slice(0, 120);
    const title = texte(m.title ?? m.titre ?? m.objet ?? m.subject).slice(0, 200);
    const body = typeof m.body === 'string' ? m.body
      : (typeof m.contenu === 'string' ? m.contenu
        : (typeof m.message === 'string' ? m.message : ''));
    if (!title && !body.trim()) {
      ignores.push({ path: `${chemin}[${i}]`, reason: 'Un message sans titre ni contenu n’est rien.' });
      return;
    }

    const brutDate = m.sentAt ?? m.envoyeLe ?? m.date ?? null;
    let sentAt = date(brutDate);
    if (sentAt === undefined) {
      ignores.push({ path: `${chemin}[${i}].sentAt`, reason: `Date illisible : ${texte(brutDate)} — le message est noté « à envoyer ».` });
      sentAt = null;
    }

    const statut = aplatir(m.status ?? m.statut ?? '');
    const dit = m.sent === true || statut === 'sent' || statut === 'envoye' || statut === 'envoyé';
    if (!sentAt && dit) {
      sentAt = maintenant;
      ignores.push({
        path: `${chemin}[${i}].sentAt`,
        reason: 'Message déclaré envoyé sans date : la date de l’import est retenue.',
      });
    }
    if (sentAt && (m.sent === false || statut === 'to_send' || statut === 'a envoyer')) {
      ignores.push({
        path: `${chemin}[${i}].sent`,
        reason: 'Une date d’envoi est présente : le message est compté comme envoyé.',
      });
    }

    sortie.push({
      id: texte(m.id) || null,
      channel,
      title,
      body: body.slice(0, 20_000),
      sentAt,
    });
  });
  return sortie;
}

/**
 * UNE TÂCHE — et l'échéance, qu'on peut donner de deux façons.
 *
 * `dueAt` est une date. `dueInDays` est un NOMBRE DE JOURS à compter de
 * l'import : c'est la seule forme utilisable dans un modèle réutilisé d'une
 * entreprise à l'autre — « relancer sous trois jours » ne s'écrit pas en date
 * absolue quand on ne sait pas quel jour le fichier sera importé.
 */
function lireTaches(brut, ignores, chemin, maintenant) {
  if (brut === undefined || brut === null) return null;
  if (!Array.isArray(brut)) {
    ignores.push({ path: chemin, reason: 'Attendu : une liste de tâches.' });
    return null;
  }
  const sortie = [];
  brut.forEach((t, i) => {
    const objet = estObjet(t);
    const name = texte(objet ? (t.name ?? t.nom ?? t.titre ?? t.title) : t).slice(0, 200);
    if (!name) {
      ignores.push({ path: `${chemin}[${i}]`, reason: 'Une tâche sans intitulé ne se lit pas.' });
      return;
    }
    let dueAt = date(objet ? (t.dueAt ?? t.echeance ?? t.due) : null);
    if (dueAt === undefined) {
      ignores.push({ path: `${chemin}[${i}].dueAt`, reason: 'Échéance illisible : la tâche est créée sans date.' });
      dueAt = null;
    }
    const jours = objet ? Number(t.dueInDays ?? t.dansJours) : Number.NaN;
    if (!dueAt && Number.isFinite(jours)) {
      dueAt = new Date(maintenant.getTime() + Math.round(jours) * 86_400_000);
    }

    const sousTaches = Array.isArray(objet ? t.subtasks ?? t.sousTaches : null)
      ? (t.subtasks ?? t.sousTaches).map((s) => {
        const objetS = estObjet(s);
        return {
          name: texte(objetS ? (s.name ?? s.nom) : s).slice(0, 200),
          description: texte(objetS ? s.description : '').slice(0, 2000),
          done: objetS ? s.done === true : false,
        };
      }).filter((s) => s.name)
      : [];

    const statut = aplatir(objet ? (t.status ?? t.statut ?? '') : '');
    sortie.push({
      name,
      description: texte(objet ? t.description : '').slice(0, 20_000),
      dueAt,
      subtasks: sousTaches,
      done: statut === 'done' || statut === 'fait' || statut === 'terminee'
        || (objet ? t.done === true : false),
    });
  });
  return sortie;
}

/**
 * UN RENDEZ-VOUS — et pourquoi le lieu est exigé ici comme ailleurs.
 *
 * L'agenda du Panel refuse un présentiel sans adresse et une visio sans lien :
 * un rendez-vous dont on ne sait ni où ni comment il se tient n'en est pas un.
 * L'import ne contourne pas cette règle — il ÉCARTE l'entrée fautive et le
 * dit, au lieu de faire échouer les quarante autres.
 */
function lireRendezVous(brut, ignores, chemin) {
  if (brut === undefined || brut === null) return null;
  if (!Array.isArray(brut)) {
    ignores.push({ path: chemin, reason: 'Attendu : une liste de rendez-vous.' });
    return null;
  }
  const sortie = [];
  brut.forEach((r, i) => {
    if (!estObjet(r)) {
      ignores.push({ path: `${chemin}[${i}]`, reason: 'Attendu : un objet rendez-vous.' });
      return;
    }
    const title = texte(r.title ?? r.titre ?? r.objet).slice(0, 200);
    const quand = date(r.scheduledAt ?? r.date ?? r.debut);
    if (!title || !quand) {
      ignores.push({
        path: `${chemin}[${i}]`,
        reason: 'Un rendez-vous demande un intitulé et une date lisible.',
      });
      return;
    }

    const mode = aplatir(r.mode) === 'remote' || aplatir(r.mode) === 'distanciel'
      ? 'REMOTE' : 'ONSITE';
    const commun = {
      title,
      description: texte(r.description ?? r.ordreDuJour).slice(0, 20_000),
      scheduledAt: quand,
      durationMinutes: Number.isFinite(Number(r.durationMinutes)) ? Number(r.durationMinutes) : 60,
      participants: Array.isArray(r.participants)
        ? r.participants.map((p) => {
          const objet = estObjet(p);
          return {
            type: aplatir(objet ? p.type : '') === 'internal' ? 'INTERNAL' : 'EXTERNAL',
            name: texte(objet ? (p.name ?? p.nom) : p).slice(0, 120),
            email: texte(objet ? p.email : ''),
            phone: texte(objet ? p.phone : ''),
          };
        }).filter((p) => p.name)
        : [],
    };

    if (mode === 'ONSITE') {
      const address = texte(r.address ?? r.adresse ?? r.lieu);
      if (!address) {
        ignores.push({ path: `${chemin}[${i}].address`, reason: 'Un rendez-vous en présentiel demande une adresse.' });
        return;
      }
      sortie.push({ ...commun, mode, address, addressComplement: texte(r.addressComplement), accessNotes: texte(r.accessNotes) });
      return;
    }

    const genre = aplatir(r.remoteKind ?? r.canal);
    const visio = genre === 'video' || genre === 'visio' || Boolean(r.meetingUrl);
    if (visio) {
      const meetingUrl = texte(r.meetingUrl ?? r.lien);
      if (!meetingUrl) {
        ignores.push({ path: `${chemin}[${i}].meetingUrl`, reason: 'Une visioconférence demande son lien.' });
        return;
      }
      sortie.push({ ...commun, mode, remoteKind: 'VIDEO', meetingUrl });
      return;
    }
    const phone = texte(r.phone ?? r.telephone);
    if (!phone) {
      ignores.push({ path: `${chemin}[${i}].phone`, reason: 'Un rendez-vous téléphonique demande un numéro.' });
      return;
    }
    sortie.push({ ...commun, mode, remoteKind: 'CALL', phone });
  });
  return sortie;
}

/* ══════════════════════════════════════════════════════════════════════════
   L'ENTRÉE PUBLIQUE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * LIRE UN DOCUMENT — et ne rien deviner.
 *
 * Le résultat sépare volontairement ce qui EST PRÉSENT de ce qui est vide :
 * `null` signifie « le document ne parle pas de cette section », et un tableau
 * vide signifie « il en parle, et il dit qu'il n'y a rien ». Cette différence
 * décide de tout en mode REMPLACER — sans elle, un fichier qui ne mentionne pas
 * les liens les effacerait.
 *
 * @param {unknown} document           l'objet issu du fichier JSON
 * @param {{ now?: Date }} [options]   l'instant de référence des échéances
 *                                     relatives — injectable pour les tests
 */
export function lireDocumentProspect(document, { now = new Date() } = {}) {
  const ignores = [];

  if (!estObjet(document)) {
    return {
      ok: false,
      raison: 'Le fichier doit contenir un objet JSON décrivant un prospect.',
      ignores,
      entree: null,
    };
  }

  const version = Number(document.version ?? PROSPECT_IMPORT_VERSION);
  if (Number.isFinite(version) && version > PROSPECT_IMPORT_VERSION) {
    ignores.push({
      path: 'version',
      reason: `Document en version ${version} ; ce Panel lit la version ${PROSPECT_IMPORT_VERSION}. Les nouveautés seront ignorées.`,
    });
  }

  const { fiche, messages, tasks, meetings, racineEstFiche } = deplier(document);
  const { sortie: brut, inconnues } = canoniser(fiche);
  for (const clef of inconnues) {
    ignores.push({
      path: racineEstFiche ? clef : `prospect.${clef}`,
      reason: 'Champ inconnu du Panel — rien n’a été deviné.',
    });
  }

  /* Les coordonnées. Une clef ABSENTE reste `undefined` : elle ne touchera pas
     la fiche. Une clef présente et vide, elle, efface — c'est la seule façon de
     retirer un téléphone erroné par un import. */
  const entree = {
    name: brut.name === undefined ? undefined : texte(brut.name).slice(0, 200),
    email: brut.email === undefined ? undefined : texte(brut.email).slice(0, 200),
    phone: brut.phone === undefined ? undefined : texte(brut.phone).slice(0, 60),
    notes: brut.notes === undefined ? undefined : String(brut.notes ?? ''),
    status: undefined,
    type: undefined,
    folderId: brut.folderId === undefined ? undefined : (texte(brut.folderId) || null),
    folderPath: brut.folderPath === undefined ? undefined : texte(brut.folderPath),
  };

  if (brut.status !== undefined) {
    const cible = ALIAS_STATUT.get(aplatir(brut.status)) ?? null;
    if (cible) entree.status = cible;
    else ignores.push({ path: 'status', reason: `Statut inconnu : ${texte(brut.status)}` });
  }
  if (brut.type !== undefined) {
    const cible = ALIAS_TYPE.get(aplatir(brut.type)) ?? null;
    if (cible) entree.type = cible;
    else ignores.push({ path: 'type', reason: `Nature d’affaire inconnue : ${texte(brut.type)}` });
  }

  const concurrents = lireConcurrents(brut.competitors, ignores, 'competitors');
  const liens = lireLiens(brut.links, brut.__liensPlats, ignores, 'links');
  const infos = lireInformations(brut.infoFields, ignores, 'infoFields');

  entree.links = (liens === null && concurrents.liens.length === 0)
    ? null
    : [...(liens ?? []), ...concurrents.liens];
  entree.infoFields = (infos === null && concurrents.infos.length === 0)
    ? null
    : [...(infos ?? []), ...concurrents.infos];
  entree.images = lireImages(brut.images, ignores, 'images');
  entree.messages = lireMessages(brut.messages ?? messages, ignores, 'messages');
  entree.tasks = lireTaches(brut.tasks ?? tasks, ignores, 'tasks', now);
  entree.meetings = lireRendezVous(brut.meetings ?? meetings, ignores, 'meetings');

  return { ok: true, raison: null, ignores, entree };
}

/**
 * EXTRAIRE LES FICHES D'UN FICHIER — une, ou quarante.
 *
 * Un rapport de qualification couvre une TOURNÉE, pas une entreprise. Obliger
 * l'équipe à découper son fichier en quarante aurait déplacé le travail manuel
 * plutôt que de le supprimer. Le fichier peut donc être un tableau, ou porter
 * une clef `prospects`, et l'écran fait choisir laquelle importer.
 */
export function extraireFiches(document) {
  if (Array.isArray(document)) return document.filter(estObjet);
  if (estObjet(document) && Array.isArray(document.prospects)) {
    return document.prospects.filter(estObjet);
  }
  return estObjet(document) ? [document] : [];
}

export default {
  IMPORT_MODES,
  IMPORT_MODE_VALUES,
  PROSPECT_IMPORT_VERSION,
  SECTIONS,
  lireDocumentProspect,
  extraireFiches,
};
