/**
 * L'IMPORT D'UN PROSPECT — de l'aperçu à l'écriture.
 *
 * ══ POURQUOI L'IMPORT EST UNE OPÉRATION, ET NON UN PRÉ-REMPLISSAGE ══════════
 *
 * On aurait pu se contenter de verser le contenu du fichier dans les champs du
 * formulaire et laisser l'utilisateur enregistrer. Ça ne marchait pour aucune
 * des trois choses qui font l'intérêt de l'import :
 *
 *   · les TÂCHES vivent dans une autre collection et se rattachent par
 *     identifiant — il n'y en a pas tant que la fiche n'existe pas ;
 *   · les RENDEZ-VOUS sont dans l'agenda, avec leur propre validation ;
 *   · les MESSAGES ne sont pas dans le formulaire du tout : ils s'écrivent
 *     depuis l'onglet « communication » de la fiche.
 *
 * L'import est donc une écriture à part entière, faite par le serveur, et ce
 * qu'il rend n'est pas un brouillon : c'est une fiche.
 *
 * ══ L'APERÇU ET L'ÉCRITURE PARTAGENT LE MÊME CALCUL ════════════════════════
 *
 * `planifier()` et `appliquer()` appellent tous deux `construire()`. L'écriture
 * ne fait JAMAIS confiance au plan renvoyé au navigateur : elle le recalcule
 * contre la base au moment d'écrire. Un plan transmis par le client aurait été
 * une écriture arbitraire déguisée en confirmation — et il aurait de toute
 * façon menti dès qu'un autre poste aurait touché la fiche entre-temps.
 *
 * ══ CE QU'UN IMPORT NE DÉTRUIT JAMAIS ══════════════════════════════════════
 *
 * Le mode REMPLACER ne s'applique qu'aux listes que la fiche PORTE elle-même :
 * liens, informations, images, messages. Les TÂCHES et les RENDEZ-VOUS ne sont
 * jamais supprimés, quel que soit le mode.
 *
 * La raison n'est pas la timidité : une tâche et un rendez-vous appartiennent à
 * l'agenda de l'équipe, pas à la fiche. Un fichier réimporté sans sa colonne
 * « tâches » aurait effacé la relance que quelqu'un avait notée à la main la
 * veille — sans erreur, sans trace, et sans que personne ne s'en aperçoive
 * avant l'échéance manquée.
 */
import crypto from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import { PanelProspect, PROSPECT_STATUS, PROSPECT_TYPE } from '../../models/PanelProspect.model.js';
import { PanelProspectFolder, FOLDER_KIND } from '../../models/PanelProspectFolder.model.js';
import { PanelTask, TASK_STATUS } from '../../models/PanelTask.model.js';
import { PanelMeeting } from '../../models/PanelMeeting.model.js';
import { createMeeting } from '../events/meetings.service.js';
import {
  IMPORT_MODES,
  IMPORT_MODE_VALUES,
  PROSPECT_IMPORT_VERSION,
  SECTIONS,
  aplatir,
  lireDocumentProspect,
} from './prospectImport.contract.js';

const identifiant = () => crypto.randomUUID();

/** Un extrait lisible dans un aperçu : le texte, borné, sur une ligne. */
const extrait = (valeur, taille = 120) => {
  const plat = String(valeur ?? '').replace(/\s+/g, ' ').trim();
  return plat.length > taille ? `${plat.slice(0, taille - 1)}…` : plat;
};

const dateCourte = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : 'sans date');

function normaliserMode(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return IMPORT_MODES.MERGE;
  if (!IMPORT_MODE_VALUES.includes(valeur)) {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_IMPORT_MODE_UNKNOWN',
      'Un import complète la fiche ou la remplace.',
    );
  }
  return valeur;
}

/* ══════════════════════════════════════════════════════════════════════════
   LA COMPARAISON D'UNE LISTE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * RAPPROCHER DEUX LISTES — par identifiant, sinon par CLEF NATURELLE.
 *
 * ══ POURQUOI LA CLEF NATURELLE EST LE CŒUR DE CETTE FONCTION ═══════════════
 *
 * Un rapport corrigé est réimporté. Sans rapprochement, le second import
 * ajouterait une deuxième « Fiche Google », un deuxième « Budget annoncé » et
 * une deuxième accroche — et il faudrait retirer les doublons à la main, ce que
 * l'import était censé éviter.
 *
 * L'identifiant vient de l'export du Panel ; la clef naturelle (une adresse,
 * une étiquette, un titre) est ce dont dispose un fichier écrit à la main.
 *
 * ── UN ÉLÉMENT RAPPROCHÉ GARDE SON IDENTIFIANT ──────────────────────────────
 * C'est ce qui permet à l'écran de continuer à le modifier et à le supprimer
 * un par un : réécrire un `id` à chaque import aurait fait clignoter la liste
 * et perdu la sélection en cours.
 */
function rapprocher({ existants, entrants, cle, decrire, comparer, mode, retirer = true }) {
  const parCle = new Map();
  const parId = new Map();
  for (const item of existants) {
    parId.set(String(item.id), item);
    const k = cle(item);
    if (k && !parCle.has(k)) parCle.set(k, item);
  }

  const added = [];
  const changed = [];
  const consommes = new Set();
  const resultat = [...existants];

  const dejaVus = new Set();
  for (const entrant of entrants) {
    const k = cle(entrant);
    if (k && dejaVus.has(k)) continue; // doublon interne au fichier : le premier gagne
    if (k) dejaVus.add(k);

    const ancien = (entrant.id && parId.get(String(entrant.id)))
      || (k ? parCle.get(k) : null)
      || null;

    if (!ancien) {
      const neuf = { ...entrant, id: entrant.id || identifiant() };
      resultat.push(neuf);
      added.push(decrire(neuf));
      continue;
    }

    consommes.add(String(ancien.id));
    const fusionne = { ...ancien, ...entrant, id: ancien.id };
    const avant = comparer(ancien);
    const apres = comparer(fusionne);
    if (avant !== apres) {
      changed.push({ ...decrire(fusionne), from: avant, to: apres });
    }
    const rang = resultat.findIndex((x) => String(x.id) === String(ancien.id));
    resultat[rang] = fusionne;
  }

  const removed = [];
  if (mode === IMPORT_MODES.REPLACE && retirer) {
    for (const ancien of existants) {
      if (consommes.has(String(ancien.id))) continue;
      removed.push(decrire(ancien));
    }
    const aRetirer = new Set(removed.length ? existants
      .filter((x) => !consommes.has(String(x.id)))
      .map((x) => String(x.id)) : []);
    for (let i = resultat.length - 1; i >= 0; i -= 1) {
      if (aRetirer.has(String(resultat[i].id))) resultat.splice(i, 1);
    }
  }

  const kept = existants.length - removed.length - changed.length;
  return { added, changed, removed, kept: Math.max(kept, 0), resultat };
}

/* ══════════════════════════════════════════════════════════════════════════
   LES DOSSIERS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * RÉSOUDRE UN CHEMIN DE DOSSIER — « Restaurants / Marseille ».
 *
 * ── POURQUOI LE CHEMIN, ET NON L'IDENTIFIANT ────────────────────────────────
 * Celui qui écrit le fichier ne connaît pas les identifiants du Panel, et n'a
 * aucune raison de les connaître. Il connaît le rangement : « Restaurants », et
 * dedans « Marseille ». C'est ce qu'il écrit.
 *
 * ── LES DOSSIERS MANQUANTS SONT CRÉÉS, ET C'EST ANNONCÉ ─────────────────────
 * Refuser un chemin inconnu aurait obligé à créer l'arborescence à la main
 * avant chaque import — exactement le travail qu'on supprime. La création est
 * donc faite, mais elle apparaît dans l'aperçu AVANT la validation : rien
 * n'apparaît dans l'arbre sans qu'on l'ait vu venir.
 */
async function resoudreChemin(chemin, { creer, actor }) {
  const segments = String(chemin ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (segments.length === 0) return { folderId: null, aCreer: [] };

  const tous = await PanelProspectFolder.find({ kind: FOLDER_KIND.PROSPECT }).lean();
  let parentId = null;
  const aCreer = [];

  for (let rang = 0; rang < segments.length; rang += 1) {
    const segment = segments[rang];
    const trouve = tous.find(
      (f) => String(f.parentId ?? '') === String(parentId ?? '')
        && aplatir(f.name) === aplatir(segment),
    );
    if (trouve) {
      parentId = String(trouve._id);
      continue;
    }
    if (!creer) {
      /* L'APERÇU ANNONCE TOUTE LA BRANCHE, pas seulement son premier maillon.
         Un dossier manquant rend manquants tous ceux qu'il contient : s'arrêter
         au premier aurait annoncé « Garages » et créé « Garages / Marseille ».
         L'aperçu ne peut pas nommer un identifiant qui n'existe pas encore, il
         rend donc `null` — la fiche sera rangée par l'écriture, pas par lui. */
      for (let reste = rang; reste < segments.length; reste += 1) {
        aCreer.push(segments.slice(0, reste + 1).join(' / '));
      }
      return { folderId: null, aCreer };
    }
    aCreer.push(segments.slice(0, rang + 1).join(' / '));
    // eslint-disable-next-line no-await-in-loop
    const cree = await PanelProspectFolder.create({
      name: segment.slice(0, 120),
      parentId,
      kind: FOLDER_KIND.PROSPECT,
      createdBy: actor?.email ?? null,
      updatedBy: actor?.email ?? null,
    });
    tous.push({ _id: cree._id, name: cree.name, parentId: cree.parentId, kind: cree.kind });
    parentId = String(cree._id);
  }

  return { folderId: parentId, aCreer };
}

/* ══════════════════════════════════════════════════════════════════════════
   LA CONSTRUCTION DU PLAN
   ══════════════════════════════════════════════════════════════════════════ */

const CLE_LIEN = (l) => aplatir(l.url).replace(/\/$/, '');
const CLE_INFO = (f) => aplatir(f.label);
const CLE_IMAGE = (i) => aplatir(i.url);
const CLE_MESSAGE = (m) => (aplatir(m.title)
  ? `${aplatir(m.title)}|${aplatir(m.channel)}`
  : `${aplatir(String(m.body ?? '').slice(0, 120))}|${aplatir(m.channel)}`);

/**
 * LE PLAN — ce qui va changer, section par section, et rien d'autre.
 *
 * Il est calculé contre l'état RÉEL de la fiche, et il est recalculé à
 * l'écriture. Ce que l'écran affiche est donc ce qui sera fait, à ceci près
 * qu'un autre poste peut écrire entre l'aperçu et la validation — auquel cas
 * c'est l'état du moment de l'écriture qui fait foi, jamais celui de l'aperçu.
 */
async function construire({ document, prospectId, mode, now, ecrire, actor }) {
  const lecture = lireDocumentProspect(document, { now });
  if (!lecture.ok) {
    throw ApiError.badRequest('PANEL_PROSPECT_IMPORT_INVALID', lecture.raison);
  }
  const { entree } = lecture;
  const ignored = [...lecture.ignores];

  const fiche = prospectId ? await PanelProspect.findById(prospectId).catch(() => null) : null;
  if (prospectId && !fiche) {
    throw ApiError.notFound('PANEL_PROSPECT_NOT_FOUND', 'Prospect introuvable.');
  }

  const nomCible = entree.name !== undefined && entree.name
    ? entree.name
    : (fiche?.name ?? '');
  if (!nomCible) {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_IMPORT_NAME_REQUIRED',
      'Ce document ne porte pas de nom d’entreprise, et il n’y a pas de fiche à compléter.',
    );
  }

  const sections = new Map(SECTIONS.map((s) => [s.key, {
    key: s.key, label: s.label, added: [], changed: [], removed: [], kept: 0,
  }]));
  const S = (clef) => sections.get(clef);

  /* ── COORDONNÉES ─────────────────────────────────────────────────────────
     Un scalaire absent du document ne touche à rien. Un scalaire PRÉSENT et
     vide efface : c'est la seule façon de retirer par import un téléphone
     erroné, et le retrait apparaît dans l'aperçu comme tout le reste. */
  const scalaires = {};
  const comparerScalaire = (clef, etiquette, valeur, actuel) => {
    if (valeur === undefined) return;
    const avant = String(actuel ?? '');
    const apres = String(valeur ?? '');
    if (avant === apres) { S('identity').kept += 1; return; }
    scalaires[clef] = valeur;
    if (!avant) S('identity').added.push({ label: etiquette, detail: extrait(apres) });
    else if (!apres) S('identity').removed.push({ label: etiquette, detail: extrait(avant) });
    else S('identity').changed.push({ label: etiquette, from: extrait(avant), to: extrait(apres) });
  };

  comparerScalaire('name', 'Nom', entree.name, fiche?.name ?? '');
  comparerScalaire('email', 'Adresse e-mail', entree.email, fiche?.email ?? '');
  comparerScalaire('phone', 'Téléphone', entree.phone, fiche?.phone ?? '');

  /* ── CLASSEMENT — statut, nature, dossier ─────────────────────────────── */
  const statutActuel = fiche?.status ?? PROSPECT_STATUS.WAITING;
  if (entree.status !== undefined && entree.status !== statutActuel) {
    scalaires.status = entree.status;
    S('classement').changed.push({ label: 'Statut', from: statutActuel, to: entree.status });
  }
  const typeActuel = fiche?.type ?? PROSPECT_TYPE.CREATION;
  if (entree.type !== undefined && entree.type !== typeActuel) {
    scalaires.type = entree.type;
    S('classement').changed.push({ label: 'Nature de l’affaire', from: typeActuel, to: entree.type });
  }

  let dossierCible;
  let dossiersACreer = [];
  if (entree.folderId !== undefined) {
    dossierCible = entree.folderId;
  } else if (entree.folderPath !== undefined && entree.folderPath) {
    const r = await resoudreChemin(entree.folderPath, { creer: ecrire, actor });
    dossierCible = r.folderId;
    dossiersACreer = r.aCreer;
  }
  if (dossierCible !== undefined) {
    const actuel = fiche?.folderId ?? null;
    if (String(dossierCible ?? '') !== String(actuel ?? '')) {
      scalaires.folderId = dossierCible;
      S('classement').changed.push({
        label: 'Dossier',
        from: actuel ? 'un dossier existant' : 'Sans dossier',
        to: entree.folderPath || (dossierCible ? 'un dossier existant' : 'Sans dossier'),
      });
    }
  }
  for (const chemin of dossiersACreer) {
    S('classement').added.push({ label: 'Dossier créé', detail: chemin });
  }

  /* ── NOTES ────────────────────────────────────────────────────────────────
     Le seul champ qui s'AJOUTE au lieu de se remplacer en mode « compléter ».
     Un rapport de qualification apporte ce qu'il a appris ; il ne connaît pas
     ce que l'équipe avait déjà noté, et l'écraser serait perdre le seul texte
     de la fiche qui ne se reconstruit pas. */
  if (entree.notes !== undefined) {
    const avant = String(fiche?.notes ?? '');
    const apporte = String(entree.notes ?? '').trim();
    if (mode === IMPORT_MODES.REPLACE) {
      if (avant.trim() !== apporte) {
        scalaires.notes = entree.notes;
        if (!avant.trim()) S('notes').added.push({ label: 'Notes internes', detail: extrait(apporte, 200) });
        else S('notes').changed.push({ label: 'Notes internes', from: extrait(avant, 160), to: extrait(apporte, 160) });
      } else S('notes').kept += 1;
    } else if (!apporte || avant.includes(apporte)) {
      S('notes').kept += 1;
    } else if (!avant.trim()) {
      scalaires.notes = apporte;
      S('notes').added.push({ label: 'Notes internes', detail: extrait(apporte, 200) });
    } else {
      const entete = `— Import du ${now.toISOString().slice(0, 10)} —`;
      scalaires.notes = `${avant.trimEnd()}\n\n${entete}\n${apporte}`;
      S('notes').added.push({ label: 'Ajout en fin de notes', detail: extrait(apporte, 200) });
    }
  }

  /* ── LES QUATRE LISTES DE LA FICHE ────────────────────────────────────── */
  const listes = {};

  if (entree.links !== null) {
    const r = rapprocher({
      existants: (fiche?.links ?? []).map((l) => ({ id: l.id, label: l.label, url: l.url })),
      entrants: entree.links,
      cle: CLE_LIEN,
      decrire: (l) => ({ label: l.label || l.url, detail: l.url }),
      comparer: (l) => `${l.label} ${l.url}`,
      mode,
    });
    Object.assign(S('links'), r);
    listes.links = r.resultat;
  }

  if (entree.infoFields !== null) {
    const r = rapprocher({
      existants: (fiche?.infoFields ?? []).map((f) => ({ id: f.id, label: f.label, value: f.value })),
      entrants: entree.infoFields,
      cle: CLE_INFO,
      decrire: (f) => ({ label: f.label, detail: extrait(f.value) }),
      comparer: (f) => extrait(f.value, 4000),
      mode,
    });
    Object.assign(S('infoFields'), r);
    listes.infoFields = r.resultat.slice(0, 100);
  }

  if (entree.images !== null) {
    const r = rapprocher({
      existants: (fiche?.images ?? []).map((i) => ({
        id: i.id, url: i.url, filename: i.filename, caption: i.caption,
      })),
      entrants: entree.images,
      cle: CLE_IMAGE,
      decrire: (i) => ({ label: i.caption || i.filename || i.url, detail: i.url }),
      comparer: (i) => String(i.caption ?? ''),
      mode,
    });
    Object.assign(S('images'), r);
    listes.images = r.resultat;
  }

  if (entree.messages !== null) {
    const etat = (m) => (m.sentAt ? `envoyé le ${dateCourte(m.sentAt)}` : 'à envoyer');
    const r = rapprocher({
      existants: (fiche?.messages ?? []).map((m) => ({
        id: m.id, channel: m.channel, title: m.title, body: m.body, sentAt: m.sentAt ?? null,
        createdAt: m.createdAt, createdBy: m.createdBy,
      })),
      entrants: entree.messages,
      cle: CLE_MESSAGE,
      decrire: (m) => ({
        label: m.title || extrait(m.body, 60) || 'Sans titre',
        detail: `${m.channel || 'canal non précisé'} — ${etat(m)}`,
      }),
      comparer: (m) => `${etat(m)} ${String(m.body ?? '')}`,
      mode,
    });
    Object.assign(S('messages'), r);
    listes.messages = r.resultat.slice(0, 200).map((m) => ({
      ...m,
      createdAt: m.createdAt ?? now,
      createdBy: m.createdBy ?? actor?.email ?? null,
    }));
  }

  /* ── LES TÂCHES — jamais supprimées, jamais dupliquées ─────────────────── */
  const tachesAEcrire = { creer: [], majs: [] };
  if (entree.tasks !== null) {
    const existantes = fiche
      ? await PanelTask.find({ 'links.prospectIds': String(fiche._id) }).lean()
      : [];
    const parNom = new Map(existantes.map((t) => [aplatir(t.name), t]));
    const vues = new Set();
    for (const tache of entree.tasks) {
      const k = aplatir(tache.name);
      if (vues.has(k)) continue;
      vues.add(k);
      const ancienne = parNom.get(k) ?? null;
      const detail = `${tache.dueAt ? `échéance ${dateCourte(tache.dueAt)}` : 'sans échéance'}${tache.done ? ' — faite' : ''}`;
      if (!ancienne) {
        tachesAEcrire.creer.push(tache);
        S('tasks').added.push({ label: tache.name, detail });
        continue;
      }
      const avant = `${dateCourte(ancienne.dueAt)} — ${ancienne.status}`;
      const apres = `${dateCourte(tache.dueAt)} — ${tache.done ? TASK_STATUS.DONE : ancienne.status}`;
      if (avant !== apres || String(ancienne.description ?? '') !== tache.description) {
        tachesAEcrire.majs.push({ id: String(ancienne._id), tache });
        S('tasks').changed.push({ label: tache.name, from: avant, to: apres });
      } else {
        S('tasks').kept += 1;
      }
    }
    if (mode === IMPORT_MODES.REPLACE && existantes.length > vues.size) {
      ignored.push({
        path: 'tasks',
        reason: 'Les tâches existantes que le document ne reprend pas sont CONSERVÉES : un import ne vide jamais un échéancier.',
      });
    }
  }

  /* ── LES RENDEZ-VOUS — ajoutés seulement ──────────────────────────────── */
  const rdvACreer = [];
  if (entree.meetings !== null) {
    const existants = fiche
      ? await PanelMeeting.find({ projectId: String(fiche._id), subjectType: 'PROSPECT' }).lean()
      : [];
    const cle = (m) => `${aplatir(m.title)}|${new Date(m.scheduledAt).toISOString()}`;
    const connus = new Set(existants.map(cle));
    for (const rdv of entree.meetings) {
      if (connus.has(cle(rdv))) { S('meetings').kept += 1; continue; }
      connus.add(cle(rdv));
      rdvACreer.push(rdv);
      S('meetings').added.push({
        label: rdv.title,
        detail: `${dateCourte(rdv.scheduledAt)} — ${rdv.mode === 'REMOTE' ? 'à distance' : 'sur place'}`,
      });
    }
  }

  const listeSections = SECTIONS.map((s) => S(s.key)).filter(
    (s) => s.added.length || s.changed.length || s.removed.length || s.kept,
  );

  const plan = {
    mode,
    version: PROSPECT_IMPORT_VERSION,
    target: {
      action: fiche ? 'UPDATE' : 'CREATE',
      prospectId: fiche ? String(fiche._id) : null,
      name: nomCible,
    },
    sections: listeSections,
    ignored,
    counts: listeSections.reduce(
      (acc, s) => ({
        added: acc.added + s.added.length,
        changed: acc.changed + s.changed.length,
        removed: acc.removed + s.removed.length,
      }),
      { added: 0, changed: 0, removed: 0 },
    ),
  };

  return { plan, fiche, scalaires, listes, tachesAEcrire, rdvACreer, nomCible };
}

/* ══════════════════════════════════════════════════════════════════════════
   LES DEUX ENTRÉES PUBLIQUES
   ══════════════════════════════════════════════════════════════════════════ */

/** L'APERÇU. Rien n'est écrit — pas même un dossier manquant. */
export async function planifierImport(
  { document, prospectId = null, mode } = {},
  actor = {},
) {
  const { plan } = await construire({
    document,
    prospectId: prospectId || null,
    mode: normaliserMode(mode),
    now: new Date(),
    ecrire: false,
    actor,
  });
  return plan;
}

/**
 * L'ÉCRITURE.
 *
 * ── L'ORDRE COMPTE ──────────────────────────────────────────────────────────
 * La fiche d'abord : les tâches et les rendez-vous la citent par identifiant,
 * et à la création cet identifiant n'existe pas avant. Une tâche écrite avant
 * la fiche se serait rattachée à rien.
 *
 * ── PAS DE TRANSACTION, ET C'EST UN CHOIX ───────────────────────────────────
 * MongoDB n'offre de transaction qu'en jeu de réplicas ; le Panel n'en exige
 * pas. Ce que l'on garantit à la place est plus utile ici : chaque écriture est
 * IDEMPOTENTE. Un import interrompu à mi-parcours se rejoue tel quel — le
 * rapprochement par clef naturelle ne recrée pas ce qui est déjà passé.
 */
export async function appliquerImport(
  { document, prospectId = null, mode } = {},
  actor = {},
) {
  const modeChoisi = normaliserMode(mode);
  const construit = await construire({
    document,
    prospectId: prospectId || null,
    mode: modeChoisi,
    now: new Date(),
    ecrire: true,
    actor,
  });
  const { plan, scalaires, listes, tachesAEcrire, rdvACreer, nomCible } = construit;
  let { fiche } = construit;

  if (!fiche) {
    const statut = scalaires.status ?? PROSPECT_STATUS.WAITING;
    fiche = await PanelProspect.create({
      name: nomCible,
      email: scalaires.email ?? '',
      phone: scalaires.phone ?? '',
      notes: scalaires.notes ?? '',
      links: listes.links ?? [],
      images: listes.images ?? [],
      folderId: scalaires.folderId ?? null,
      infoFields: listes.infoFields ?? [],
      messages: listes.messages ?? [],
      status: statut,
      type: scalaires.type ?? PROSPECT_TYPE.CREATION,
      statusHistory: [{
        at: new Date(), from: null, to: statut, actorEmail: actor.email ?? null,
        note: 'Fiche créée par import JSON.',
      }],
      createdBy: actor.email ?? null,
      updatedBy: actor.email ?? null,
    });
    plan.target.action = 'CREATE';
    plan.target.prospectId = String(fiche._id);
  } else {
    for (const [clef, valeur] of Object.entries(scalaires)) {
      /* LE STATUT NE SE POSE PAS EN SILENCE : comme partout ailleurs dans le
         Panel, il laisse sa trace — qui l'a bougé, quand, et depuis quoi. Un
         import qui ferait passer une affaire en « signé » sans ligne
         d'historique serait la seule décision commerciale sans auteur. */
      if (clef === 'status') {
        fiche.statusHistory.push({
          at: new Date(),
          from: fiche.status,
          to: valeur,
          actorEmail: actor.email ?? null,
          note: 'Import JSON.',
        });
      }
      fiche[clef] = valeur;
    }
    for (const [clef, valeur] of Object.entries(listes)) fiche[clef] = valeur;
    fiche.updatedBy = actor.email ?? null;
    await fiche.save();
  }

  const prospectIdFinal = String(fiche._id);

  for (const tache of tachesAEcrire.creer) {
    // eslint-disable-next-line no-await-in-loop
    await PanelTask.create({
      name: tache.name,
      description: tache.description,
      subtasks: tache.subtasks.map((s) => ({ id: identifiant(), ...s })),
      links: {
        projectIds: [], prospectIds: [prospectIdFinal], transactionIds: [], clientCompanyIds: [],
      },
      dueAt: tache.dueAt,
      status: tache.done ? TASK_STATUS.DONE : TASK_STATUS.OPEN,
      completedAt: tache.done ? new Date() : null,
      completedBy: tache.done ? (actor.email ?? null) : null,
      createdBy: actor.email ?? null,
      updatedBy: actor.email ?? null,
    });
  }

  for (const { id, tache } of tachesAEcrire.majs) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await PanelTask.findById(id);
    if (!doc) continue;
    doc.description = tache.description || doc.description;
    doc.dueAt = tache.dueAt ?? doc.dueAt;
    if (tache.subtasks.length) {
      doc.subtasks = tache.subtasks.map((s) => ({ id: identifiant(), ...s }));
    }
    if (tache.done && doc.status !== TASK_STATUS.DONE) {
      doc.status = TASK_STATUS.DONE;
      doc.completedAt = new Date();
      doc.completedBy = actor.email ?? null;
    }
    doc.updatedBy = actor.email ?? null;
    // eslint-disable-next-line no-await-in-loop
    await doc.save();
  }

  for (const rdv of rdvACreer) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await createMeeting({
        ...rdv,
        projectId: prospectIdFinal,
        projectName: fiche.name,
        subjectType: 'PROSPECT',
        participants: rdv.participants.map((p) => ({ ...p, id: identifiant() })),
      }, actor);
    } catch (err) {
      /* L'AGENDA A SES PROPRES RÈGLES, et elles sont plus strictes que celles
         d'un fichier. Un rendez-vous refusé ne doit pas emporter la fiche, les
         messages et les tâches déjà écrits : il est consigné, et l'import
         rend compte de ce qu'il n'a pas su poser. */
      plan.ignored.push({
        path: `meetings[${rdv.title}]`,
        reason: err?.message ?? 'Rendez-vous refusé par l’agenda.',
      });
    }
  }

  const complet = await PanelProspect.findById(prospectIdFinal).lean();
  return { prospect: complet, plan };
}

export default { planifierImport, appliquerImport };
