// SERVICE DES ENTREPRISES CLIENTES — l'autorité de l'identité juridique.
//
// ══ CE QUI DISTINGUE CE SERVICE DE `company.service.js` ═════════════════════
//
// L'entreprise DÉVELOPPEUR sépare la saisie de la publication : corriger une
// faute de frappe dans le slogan de L.Y Solution ne doit pas déclencher une
// diffusion vers tout le parc, et un opérateur à mi-chemin d'une refonte de
// marque ne doit pas répandre un état incohérent.
//
// L'entreprise CLIENTE ne se comporte pas ainsi, et lui imposer un brouillon
// serait une faute :
//
//   · sa diffusion est NOMINATIVE — elle ne part qu'aux projets de CE client,
//     jamais au parc. Le risque de « répandre » n'existe pas ;
//   · ce qu'elle porte est BLOQUANT. Tant qu'une adresse manque, le client ne
//     peut ni payer ni signer. Laisser une correction en brouillon, c'est
//     laisser un client bloqué par un champ que quelqu'un a déjà rempli ;
//   · il n'y a rien à composer. On ne « refond » pas un SIREN.
//
// Enregistrer EST donc publier, et `publishedVersion` s'incrémente à chaque
// écriture. Le numéro ne sert pas à choisir quoi diffuser : il sert à
// l'applicateur du projet, qui écarte une écriture plus ancienne que celle
// qu'il applique déjà — le cas normal après un rattrapage désordonné.
//
// ══ CE SERVICE NE TOUCHE JAMAIS AUX DOCUMENTS DÉJÀ ÉMIS ═════════════════════
//
// Modifier une fiche ne réécrit aucune facture, aucun contrat, aucune demande
// de signature. Ces actes portent leur propre instantané — voir
// `clientLegalSnapshot.js`. C'est la règle qui rend une correction d'adresse
// anodine plutôt que dangereuse.
import { randomUUID } from 'node:crypto';

import PanelClientCompany, {
  CLIENT_COMPANY_STATUS,
} from '../../models/PanelClientCompany.model.js';
import PanelProject from '../../models/PanelProject.model.js';
import ApiError from '../../utils/ApiError.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import { nowIso, stableBridgeId } from '../../bridge/bridgeContract.js';
import { emitChange } from '../sync/syncCore.service.js';
import { recordEvent } from '../supervision/timeline.service.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import { validateClientCompanyInput } from './clientCompany.validation.js';
import {
  describeClientCompanyReadiness,
  effectiveBillingAddress,
} from './clientCompanyReadiness.js';

/**
 * LE TYPE D'ENTITÉ DE SYNCHRONISATION — distinct de `DEV_COMPANY`, et il DOIT
 * l'être.
 *
 *   DEV_COMPANY     = L.Y Solution. Le prestataire. Diffusé à TOUT le parc.
 *   CLIENT_COMPANY  = le client de CE projet. Nominatif.
 *
 * Les faire voyager sous la même étiquette aurait obligé le projet à deviner,
 * à la lecture, laquelle des deux identités il reçoit — et un site aurait fini
 * par afficher les mentions légales de son prestataire à la place des siennes.
 */
export const CLIENT_COMPANY_ENTITY = 'CLIENT_COMPANY';

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * L'IDENTIFIANT — OPAQUE, et indépendant de la raison sociale.
 *
 * Même raisonnement que pour l'entreprise développeur : le nom est une donnée
 * MÉTIER qui se corrige et change au rebranding ; l'identifiant est une donnée
 * TECHNIQUE qui voyage jusqu'aux projets, entre dans des instantanés de
 * factures et doit rester stable à vie. Les lier ferait dépendre une clé d'une
 * information faite pour bouger.
 */
async function opaqueId() {
  for (let essai = 0; essai < 5; essai += 1) {
    const candidat = `cc${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    if (!(await PanelClientCompany.exists({ clientCompanyId: candidat }))) return candidat;
  }
  throw ApiError.conflict(
    'PANEL_CLIENT_COMPANY_ID_EXHAUSTED',
    'Identifiant interne introuvable après plusieurs tirages : anomalie à signaler.',
  );
}

export async function getClientCompanyOrThrow(clientCompanyId) {
  const fiche = await PanelClientCompany.findOne({ clientCompanyId }).lean();
  if (!fiche) {
    throw ApiError.notFound('PANEL_CLIENT_COMPANY_NOT_FOUND', 'Entreprise cliente inconnue.');
  }
  /**
   * LE MONDE DOIT CONCORDER, MÊME EN LECTURE.
   *
   * Les deux environnements partagent parfois une base de développement. Rendre
   * une fiche de production depuis une instance de recette permettrait de la
   * rattacher à un projet de recette — et de facturer un vrai client au nom
   * d'un essai. Le refus est indistinct d'un « inconnu » : une instance n'a pas
   * à apprendre le contenu de l'autre.
   */
  if (fiche.environment !== config.env) {
    throw ApiError.notFound('PANEL_CLIENT_COMPANY_NOT_FOUND', 'Entreprise cliente inconnue.');
  }
  return fiche;
}

/**
 * LES PROJETS D'UNE ENTREPRISE — la relation lue dans le sens utile.
 *
 * Le lien est porté par le PROJET (`clientCompanyId`) et non par une liste sur
 * l'entreprise. C'est la seule forme qui garantisse qu'un projet a AU PLUS un
 * client : une liste des deux côtés se désynchronise, et rien ne dirait
 * laquelle fait foi.
 */
export async function projectsOfClientCompany(clientCompanyId) {
  return PanelProject
    .find({ clientCompanyId })
    .select('projectId projectKey projectName pairing.status runtime.environment')
    .sort({ projectName: 1 })
    .lean();
}

/**
 * LA LISTE — avec le nombre de projets, résolu en UNE agrégation.
 *
 * ══ POURQUOI PAS UNE BOUCLE DE COMPTAGES ════════════════════════════════════
 *
 * Une requête par fiche produirait N+1 allers-retours pour peindre un tableau.
 * Ce n'est pas encore un problème de performance sur ce parc — c'en devient un
 * dès la centième fiche, et le corriger plus tard demanderait de rouvrir
 * l'écran, le service et les tests. Une agrégation coûte le même effort
 * aujourd'hui.
 */
export async function listClientCompanies({ search = '', status = null } = {}) {
  const filtre = { environment: config.env };
  if (status) filtre.status = status;

  const terme = String(search ?? '').trim();
  if (terme) {
    /**
     * DEUX ENTRÉES DE RECHERCHE, ET DEUX SEULEMENT — le nom et le SIREN.
     *
     * Ce sont les deux façons dont on désigne une entreprise dans la vraie vie.
     * Le terme est ÉCHAPPÉ avant d'entrer dans une expression régulière : une
     * recherche sur « SARL (ex-Dupont) » ne doit pas devenir une expression
     * invalide qui renvoie une erreur 500 à l'écran.
     */
    const echappe = terme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const motif = new RegExp(echappe, 'i');
    const chiffres = terme.replace(/[\s. ]/g, '');
    filtre.$or = [
      { legalName: motif },
      { tradingName: motif },
      ...(/^\d{1,14}$/.test(chiffres)
        ? [{ siren: new RegExp(`^${chiffres}`) }, { siret: new RegExp(`^${chiffres}`) }]
        : []),
    ];
  }

  const fiches = await PanelClientCompany.find(filtre).sort({ legalName: 1 }).lean();
  if (fiches.length === 0) return [];

  const comptes = await PanelProject.aggregate([
    { $match: { clientCompanyId: { $in: fiches.map((f) => f.clientCompanyId) } } },
    { $group: { _id: '$clientCompanyId', total: { $sum: 1 } } },
  ]);
  const parId = new Map(comptes.map((c) => [c._id, c.total]));

  return fiches.map((fiche) => ({
    ...describeClientCompany(fiche),
    projectCount: parId.get(fiche.clientCompanyId) ?? 0,
  }));
}

/**
 * LA VUE RENDUE À UN ÉCRAN DU PANEL.
 *
 * ── CE QU'ELLE AJOUTE ───────────────────────────────────────────────────────
 *
 * `readiness` — parce que « cette fiche permet-elle de facturer ? » est la
 * question que l'écran pose en premier, et qu'elle ne se déduit pas à l'œil
 * d'une liste de champs. La calculer côté client obligerait à recopier la règle
 * dans le frontend, où elle divergerait de la garde du backend.
 *
 * `billingAddressEffective` — l'adresse RÉELLEMENT utilisée. Sans elle, un
 * écran affichant « adresse de facturation : — » ferait croire à une absence
 * là où le siège prend le relais.
 *
 * ── CE QU'ELLE NE RETIRE PAS ────────────────────────────────────────────────
 *
 * `notes` reste : cet écran est interne, réservé aux comptes du Panel, et la
 * note de gestion est précisément ce qu'un opérateur vient y lire. Elle n'est
 * jamais PUBLIÉE — voir `publishedProfile`.
 */
export function describeClientCompany(fiche) {
  if (!fiche) return null;
  return {
    clientCompanyId: fiche.clientCompanyId,
    legalName: fiche.legalName,
    tradingName: fiche.tradingName ?? null,
    legalForm: fiche.legalForm ?? null,
    siren: fiche.siren ?? null,
    siret: fiche.siret ?? null,
    vatNumber: fiche.vatNumber ?? null,
    registrationCity: fiche.registrationCity ?? null,
    // Les trois champs cités par les mentions légales. Exposés à l'écran
    // interne comme les autres : c'est là qu'on les corrige quand le document
    // signale qu'ils manquent.
    shareCapital: fiche.shareCapital ?? null,
    publicationDirector: fiche.publicationDirector ?? null,
    publicEmail: fiche.publicEmail ?? null,
    registeredOffice: fiche.registeredOffice ?? null,
    billingAddress: fiche.billingAddress ?? null,
    billingAddressEffective: effectiveBillingAddress(fiche),
    billingEmail: fiche.billingEmail ?? null,
    phone: fiche.phone ?? null,
    website: fiche.website ?? null,
    administrativeContact: fiche.administrativeContact ?? null,
    contractualSigner: fiche.contractualSigner ?? null,
    status: fiche.status,
    notes: fiche.notes ?? null,
    environment: fiche.environment,
    publishedVersion: fiche.publishedVersion ?? 0,
    publishedAt: fiche.publishedAt ?? null,
    createdAt: fiche.createdAt,
    updatedAt: fiche.updatedAt,
    documents: (fiche.documents ?? []).map((d) => ({
      documentId: d.documentId,
      label: d.label,
      type: d.type ?? null,
      documentDate: d.documentDate ?? null,
      uploadedAt: d.uploadedAt,
      uploadedBy: d.uploadedBy ?? null,
      /**
       * AUCUNE URL. Un document client vit dans le stockage privé, qu'aucun
       * serveur statique ne dessert. Il sort par une route authentifiée portée
       * par SA fiche, et une adresse publiée ici finirait dans un `<a href>`,
       * puis hors de toute session.
       */
    })),
    readiness: describeClientCompanyReadiness(fiche),
  };
}

/** La fiche COMPLÈTE d'un client : identité, projets, état de préparation. */
export async function getClientCompanyDetail(clientCompanyId) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const projets = await projectsOfClientCompany(clientCompanyId);
  return {
    ...describeClientCompany(fiche),
    projects: projets.map((p) => ({
      projectId: p.projectId,
      projectKey: p.projectKey,
      projectName: p.projectName,
      paired: p.pairing?.status === 'PAIRED',
      environment: p.runtime?.environment ?? null,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

function refuserSiInvalide(verdict) {
  if (verdict.valid) return verdict.value;
  throw ApiError.badRequest(
    'PANEL_CLIENT_COMPANY_INVALID',
    `Fiche client invalide : ${verdict.errors.join(' · ')}`,
    /**
     * `errors` reste la phrase ; `issues` dit SOUS QUEL CHAMP la poser.
     * L’écran d’édition en ligne affiche le message au pied du champ
     * concerné — une erreur qu’on doit chercher n’est pas corrigée, elle
     * est contournée.
     */
    { errors: verdict.errors, issues: verdict.issues ?? [] },
  );
}

/**
 * AVERTIT si un SIREN est déjà porté par une autre fiche — sans BLOQUER.
 *
 * ══ POURQUOI CE N'EST PAS UN REFUS ══════════════════════════════════════════
 *
 * Un doublon de SIREN est presque toujours une erreur, mais pas toujours : une
 * reprise de fiche, une fusion en cours, une correction en deux temps le
 * produisent légitimement. Refuser l'enregistrement obligerait alors à
 * supprimer une fiche RÉFÉRENCÉE par des factures pour pouvoir en corriger une
 * autre — un remède pire que le mal.
 *
 * On journalise donc, et l'écran l'affiche. L'opérateur tranche, en connaissant
 * l'existence de l'autre fiche : c'est exactement l'information qui lui manquait.
 */
async function signalerDoublonSiren(siren, clientCompanyId = null) {
  if (!siren) return null;
  const autre = await PanelClientCompany.findOne({
    environment: config.env,
    siren,
    ...(clientCompanyId ? { clientCompanyId: { $ne: clientCompanyId } } : {}),
  }).select('clientCompanyId legalName').lean();
  if (!autre) return null;
  logger.warn(
    `[client-company] SIREN ${siren} déjà porté par « ${autre.legalName} » `
    + `(${autre.clientCompanyId}). Enregistrement accepté — doublon signalé à l'écran.`,
  );
  return { clientCompanyId: autre.clientCompanyId, legalName: autre.legalName };
}

export async function createClientCompany(input, actor = {}) {
  const valeur = refuserSiInvalide(validateClientCompanyInput(input));
  const at = nowIso();
  const clientCompanyId = await opaqueId();
  const duplicateSiren = await signalerDoublonSiren(valeur.siren);

  const fiche = await PanelClientCompany.create({
    ...valeur,
    clientCompanyId,
    /**
     * LE MONDE N'EST PAS UN CHOIX D'UTILISATEUR — c'est celui du Panel qui
     * tourne. Poser la question permettrait de créer une fiche de production
     * depuis une instance de recette, et de la rattacher ensuite à un projet
     * réel. Même règle que pour l'entreprise développeur et les médias.
     */
    environment: config.env,
    status: valeur.status ?? CLIENT_COMPANY_STATUS.ACTIVE,
    /**
     * Elle naît en VERSION 1 et PUBLIÉE : voir l'en-tête. Une fiche cliente n'a
     * pas de brouillon — les projets rattachés n'existent pas encore, la
     * diffusion ne coûte donc rien, et le jour du rattachement l'identité est
     * déjà à jour.
     */
    publishedVersion: 1,
    publishedAt: at,
    createdAt: at,
    updatedAt: at,
    createdBy: actor.userEmail ?? null,
    updatedBy: actor.userEmail ?? null,
  });

  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.CLIENT_COMPANY_CREATED,
    source: 'PANEL',
    summary: `Entreprise cliente « ${fiche.legalName} » créée.`,
    data: { clientCompanyId, legalName: fiche.legalName, siren: fiche.siren ?? null },
  });

  return { clientCompany: await getClientCompanyDetail(clientCompanyId), duplicateSiren };
}

/**
 * MET À JOUR une fiche, et REPUBLIE aussitôt vers ses projets.
 *
 * ══ LE PATCH EST FUSIONNÉ SUR L'EXISTANT AVANT D'ÊTRE VALIDÉ ════════════════
 *
 * Valider le patch seul aurait rendu impossible toute modification partielle :
 * corriger un numéro de téléphone aurait exigé de renvoyer la raison sociale,
 * et les contrôles de cohérence (SIRET ⊃ SIREN, TVA ⊃ SIREN) n'auraient vu
 * qu'un des deux champs — donc n'auraient rien vérifié du tout.
 */
export async function updateClientCompany(clientCompanyId, patch, actor = {}) {
  const existante = await getClientCompanyOrThrow(clientCompanyId);

  const fusion = {
    legalName: patch.legalName ?? existante.legalName,
    tradingName: 'tradingName' in patch ? patch.tradingName : existante.tradingName,
    legalForm: 'legalForm' in patch ? patch.legalForm : existante.legalForm,
    siren: 'siren' in patch ? patch.siren : existante.siren,
    siret: 'siret' in patch ? patch.siret : existante.siret,
    vatNumber: 'vatNumber' in patch ? patch.vatNumber : existante.vatNumber,
    registrationCity: 'registrationCity' in patch ? patch.registrationCity : existante.registrationCity,
    // Les trois champs des mentions légales suivent la même règle que les
    // autres : `in patch` et non `??`, pour qu'un effacement volontaire
    // (`null`) se distingue d'un champ simplement absent du formulaire.
    shareCapital: 'shareCapital' in patch ? patch.shareCapital : existante.shareCapital,
    publicationDirector: 'publicationDirector' in patch
      ? patch.publicationDirector
      : existante.publicationDirector,
    publicEmail: 'publicEmail' in patch ? patch.publicEmail : existante.publicEmail,
    registeredOffice: patch.registeredOffice ?? existante.registeredOffice,
    billingAddress: 'billingAddress' in patch ? patch.billingAddress : existante.billingAddress,
    billingEmail: 'billingEmail' in patch ? patch.billingEmail : existante.billingEmail,
    phone: 'phone' in patch ? patch.phone : existante.phone,
    website: 'website' in patch ? patch.website : existante.website,
    administrativeContact: patch.administrativeContact ?? existante.administrativeContact,
    contractualSigner: 'contractualSigner' in patch ? patch.contractualSigner : existante.contractualSigner,
    notes: 'notes' in patch ? patch.notes : existante.notes,
  };

  const valeur = refuserSiInvalide(validateClientCompanyInput(fusion));
  const duplicateSiren = await signalerDoublonSiren(valeur.siren, clientCompanyId);

  const at = nowIso();
  const version = (existante.publishedVersion ?? 0) + 1;

  await PanelClientCompany.updateOne(
    { clientCompanyId },
    {
      $set: {
        ...valeur,
        publishedVersion: version,
        publishedAt: at,
        updatedAt: at,
        updatedBy: actor.userEmail ?? null,
      },
    },
  );

  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.CLIENT_COMPANY_UPDATED,
    source: 'PANEL',
    summary: `Entreprise cliente « ${valeur.legalName} » mise à jour (version ${version}).`,
    data: { clientCompanyId, legalName: valeur.legalName, version },
  });

  /**
   * LA DIFFUSION SUIT L'ÉCRITURE, JAMAIS L'INVERSE.
   *
   * Publier d'abord ouvrirait une fenêtre où un projet aurait appliqué une
   * identité que le Panel ne détient pas encore — donc introuvable au
   * rattrapage, et impossible à rejouer.
   */
  await broadcastToLinkedProjects(clientCompanyId);

  return { clientCompany: await getClientCompanyDetail(clientCompanyId), duplicateSiren };
}

/**
 * ARCHIVE une entreprise — la relation est terminée, la fiche reste.
 *
 * ══ POURQUOI ARCHIVER PLUTÔT QUE SUPPRIMER ══════════════════════════════════
 *
 * Une entreprise cliente est référencée par des instantanés de factures, des
 * contrats signés et des mouvements financiers. Supprimer la fiche ne les
 * effacerait pas — ils portent leur propre copie — mais rendrait impossible de
 * répondre à « qui était ce client ? » depuis l'écran. Une suppression qui
 * n'efface rien et casse la navigation n'apporte rien à personne.
 *
 * ══ CE QUE L'ARCHIVAGE FAIT VRAIMENT ════════════════════════════════════════
 *
 * Il rend la fiche NON PRÊTE (voir `clientCompanyReadiness`) : plus aucun
 * paiement, plus aucune signature. Les projets restent rattachés, et c'est
 * délibéré — les détacher effacerait l'information « ce site appartenait à ce
 * client », qui est précisément ce qu'on vient chercher dans une archive.
 */
export async function archiveClientCompany(clientCompanyId, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  if (fiche.status === CLIENT_COMPANY_STATUS.ARCHIVED) {
    return { clientCompany: await getClientCompanyDetail(clientCompanyId), alreadyArchived: true };
  }

  const at = nowIso();
  await PanelClientCompany.updateOne(
    { clientCompanyId },
    {
      $set: {
        status: CLIENT_COMPANY_STATUS.ARCHIVED,
        publishedVersion: (fiche.publishedVersion ?? 0) + 1,
        publishedAt: at,
        updatedAt: at,
        updatedBy: actor.userEmail ?? null,
      },
    },
  );

  const projets = await projectsOfClientCompany(clientCompanyId);
  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.CLIENT_COMPANY_ARCHIVED,
    source: 'PANEL',
    severity: 'WARNING',
    summary: `Entreprise cliente « ${fiche.legalName} » archivée — ${projets.length} projet(s) restent rattachés.`,
    data: { clientCompanyId, legalName: fiche.legalName, projectCount: projets.length },
  });

  /**
   * LES PROJETS APPRENNENT L'ARCHIVAGE.
   *
   * Sans cette diffusion, le Manager d'un client archivé continuerait
   * d'afficher son entreprise comme active et de proposer des boutons de
   * paiement que le backend refuserait. Une garde qui refuse est correcte ;
   * une interface qui la contredit est un défaut.
   */
  await broadcastToLinkedProjects(clientCompanyId);
  return { clientCompany: await getClientCompanyDetail(clientCompanyId), alreadyArchived: false };
}

/** RÉACTIVE une fiche archivée. Symétrique, et tracée de la même façon. */
export async function restoreClientCompany(clientCompanyId, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  if (fiche.status === CLIENT_COMPANY_STATUS.ACTIVE) {
    return { clientCompany: await getClientCompanyDetail(clientCompanyId), alreadyActive: true };
  }
  const at = nowIso();
  await PanelClientCompany.updateOne(
    { clientCompanyId },
    {
      $set: {
        status: CLIENT_COMPANY_STATUS.ACTIVE,
        publishedVersion: (fiche.publishedVersion ?? 0) + 1,
        publishedAt: at,
        updatedAt: at,
        updatedBy: actor.userEmail ?? null,
      },
    },
  );
  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.CLIENT_COMPANY_RESTORED,
    source: 'PANEL',
    summary: `Entreprise cliente « ${fiche.legalName} » réactivée.`,
    data: { clientCompanyId, legalName: fiche.legalName },
  });
  await broadcastToLinkedProjects(clientCompanyId);
  return { clientCompany: await getClientCompanyDetail(clientCompanyId), alreadyActive: false };
}

/**
 * SUPPRESSION PHYSIQUE — possible UNIQUEMENT sur une fiche vierge de tout.
 *
 * ══ CE QUE « VIERGE » VEUT DIRE ICI ═════════════════════════════════════════
 *
 * Aucun projet rattaché, aucun document déposé. C'est le cas — et le seul —
 * d'une fiche créée par erreur, doublon d'une autre, saisie dans le mauvais
 * environnement. La supprimer alors n'efface aucune histoire, parce qu'il n'y
 * en a pas.
 *
 * Dès qu'un projet est rattaché, la suppression est REFUSÉE et l'archivage est
 * nommé dans le message : il n'y a aucune cascade destructive dans ce domaine,
 * et il n'y en aura pas. Détacher automatiquement les projets « pour pouvoir
 * supprimer » reviendrait à faire la cascade en la déguisant.
 */
export async function deleteClientCompany(clientCompanyId, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const projets = await projectsOfClientCompany(clientCompanyId);

  if (projets.length > 0) {
    throw ApiError.conflict(
      'PANEL_CLIENT_COMPANY_HAS_PROJECTS',
      `« ${fiche.legalName} » possède ${projets.length} projet(s) rattaché(s) : la fiche ne peut pas `
      + 'être supprimée. Archivez-la — elle cessera d’autoriser paiements et signatures, et son '
      + 'histoire restera lisible.',
      { projectCount: projets.length },
    );
  }
  if ((fiche.documents ?? []).length > 0) {
    throw ApiError.conflict(
      'PANEL_CLIENT_COMPANY_HAS_DOCUMENTS',
      `« ${fiche.legalName} » porte ${fiche.documents.length} document(s) administratif(s) : `
      + 'retirez-les d’abord, ou archivez la fiche.',
      { documentCount: fiche.documents.length },
    );
  }

  await PanelClientCompany.deleteOne({ clientCompanyId });
  logger.warn(
    `[client-company] fiche ${clientCompanyId} « ${fiche.legalName} » supprimée par `
    + `${actor.userEmail ?? 'inconnu'} — aucun projet, aucun document.`,
  );
  return { deleted: true, clientCompanyId };
}

/* -------------------------------------------------------------------------- */
/*  RATTACHEMENT                                                              */
/* -------------------------------------------------------------------------- */

async function projectOrThrow(projectId) {
  const projet = await PanelProject.findOne({ projectId }).lean();
  if (!projet) throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', 'Projet inconnu.');
  return projet;
}

/**
 * RATTACHE un projet à une entreprise cliente — ou le fait CHANGER de client.
 *
 * ══ CE QUE CE GESTE NE FAIT PAS, ET C'EST L'ESSENTIEL ═══════════════════════
 *
 * Il ne réécrit AUCUN document existant. Les factures déjà émises gardent leur
 * instantané, les contrats signés gardent leurs signataires figés, les clients
 * Stripe déjà créés gardent leur rattachement. Un changement d'entreprise vaut
 * pour les opérations À VENIR, et pour elles seules.
 *
 * C'est ce qui rend le geste réversible et peu risqué : on corrige un
 * rattachement erroné sans falsifier l'histoire comptable.
 *
 * ══ CE QU'IL FAUT SAVOIR AVANT DE LE FAIRE ══════════════════════════════════
 *
 * Le client Stripe est lié au CONTRAT, pas au projet (voir
 * `stripeCustomerAuthority`). Un contrat en cours conserve donc son client
 * Stripe et son identité de facturation. Le nouveau client ne s'appliquera
 * qu'au prochain contrat. Le service le DIT dans son retour — `pendingContract`
 * — pour que l'écran puisse en avertir plutôt que de le laisser découvrir.
 */
export async function linkProjectToClientCompany(projectId, clientCompanyId, actor = {}) {
  const projet = await projectOrThrow(projectId);
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const precedent = projet.clientCompanyId ?? null;

  if (precedent === clientCompanyId) {
    return { linked: true, unchanged: true, clientCompanyId, projectId };
  }

  await PanelProject.updateOne(
    { projectId },
    { $set: { clientCompanyId, updatedAt: nowIso() } },
  );

  await recordEvent({
    projectId,
    type: EVENT_TYPES.CLIENT_COMPANY_LINKED,
    source: 'PANEL',
    summary: precedent
      ? `Projet rattaché à « ${fiche.legalName} » (précédemment une autre entreprise cliente).`
      : `Projet rattaché à l’entreprise cliente « ${fiche.legalName} ».`,
    data: { clientCompanyId, previousClientCompanyId: precedent, legalName: fiche.legalName },
  });

  /**
   * LE PROJET REÇOIT SON IDENTITÉ IMMÉDIATEMENT.
   *
   * Sans cette diffusion, sa page « Mon entreprise » resterait vide jusqu'à la
   * prochaine modification de la fiche — et ses boutons de paiement resteraient
   * bloqués alors que le rattachement vient d'être fait.
   */
  await publishToProject(projectId, fiche);

  /**
   * L'ANCIEN CLIENT EST RETIRÉ DU PROJET, EXPLICITEMENT.
   *
   * Un simple remplacement aurait suffi si les deux écritures arrivaient dans
   * l'ordre. Elles peuvent ne pas arriver du tout : un projet éteint pendant le
   * changement rattraperait les deux, dans un ordre décidé par le journal. La
   * suppression NOMMÉE de l'ancienne entité rend la séquence sans ambiguïté —
   * l'entité est identifiée par `clientCompanyId`, deux identifiants distincts
   * ne se recouvrent jamais.
   */
  if (precedent) await tombstoneOnProject(projectId, precedent);

  /**
   * ── LES DOCUMENTS LÉGAUX SONT RECALCULÉS POUR LE NOUVEAU LOCATAIRE ──────
   *
   * C'est le point le plus sensible du chantier multi-tenant, et il est ICI.
   *
   * Un projet rattaché à l'entreprise A détient un document résolu portant le
   * SIREN, l'adresse et le directeur de publication de A. Le rattacher à B sans
   * republier laisserait CE DOCUMENT EN PLACE : le site de B afficherait les
   * mentions légales de A. C'est très exactement le mélange de locataires que
   * l'incident FJ / KleenPro a rendu inacceptable.
   *
   * La republication écrase le document précédent — l'`entityId` est dérivé du
   * couple (projet, type), jamais du client — et le remplacement est donc total.
   *
   * Non bloquant, pour la même raison qu'à la diffusion : le rattachement est ce
   * qui débloque paiements et signatures, et une file durable rattrape le reste.
   */
  await import('../legal/legalDocumentPublisher.js')
    .then((m) => m.publishAllForProject(projectId))
    .catch((err) => {
      logger.warn(`[legal] Documents de ${projectId} non recalculés : ${err.message}`);
    });

  const contrat = await contratCourantDe(projectId);
  return {
    linked: true,
    unchanged: false,
    projectId,
    clientCompanyId,
    previousClientCompanyId: precedent,
    pendingContract: contrat,
  };
}

/**
 * DÉTACHE un projet de son entreprise cliente.
 *
 * Le projet redevient « sans client légal » : plus aucun paiement, plus aucune
 * signature. C'est un geste lourd, et il est tracé comme tel.
 */
export async function unlinkProjectFromClientCompany(projectId, actor = {}) {
  const projet = await projectOrThrow(projectId);
  const precedent = projet.clientCompanyId ?? null;
  if (!precedent) return { unlinked: true, unchanged: true, projectId };

  await PanelProject.updateOne(
    { projectId },
    { $unset: { clientCompanyId: '' }, $set: { updatedAt: nowIso() } },
  );

  const fiche = await PanelClientCompany.findOne({ clientCompanyId: precedent })
    .select('legalName').lean();

  await recordEvent({
    projectId,
    type: EVENT_TYPES.CLIENT_COMPANY_UNLINKED,
    source: 'PANEL',
    severity: 'WARNING',
    summary: `Projet détaché de « ${fiche?.legalName ?? precedent} » — paiements et signatures suspendus.`,
    data: { previousClientCompanyId: precedent },
  });

  await tombstoneOnProject(projectId, precedent);

  /**
   * LES DOCUMENTS LÉGAUX SONT RECALCULÉS — donc VIDÉS de leur locataire.
   *
   * Sans entreprise cliente, les variables `client.*` ne se résolvent plus :
   * la règle de conditionnalité retire les blocs concernés, et un document
   * qui n'a plus aucune section n'est pas publié (le publieur refuse
   * `DOCUMENT_EMPTY`). Le site conserve alors son dernier document valide —
   * ce qui est le bon comportement : détacher une fiche de gestion ne doit pas
   * effacer une page opposable.
   *
   * Ce qui compte ici est l'inverse : que le document ne soit JAMAIS republié
   * avec les données du client détaché sur un projet qui ne lui appartient
   * plus. Le recalcul est ce qui le garantit.
   */
  await import('../legal/legalDocumentPublisher.js')
    .then((m) => m.publishAllForProject(projectId))
    .catch((err) => {
      logger.warn(`[legal] Documents de ${projectId} non recalculés : ${err.message}`);
    });

  return { unlinked: true, unchanged: false, projectId, previousClientCompanyId: precedent };
}

/** Le contrat courant projeté d'un projet — pour AVERTIR, jamais pour bloquer. */
async function contratCourantDe(projectId) {
  const { PanelProjectContract } = await import('../../models/PanelProjectProjection.model.js');
  const projection = await PanelProjectContract.findOne({ projectId })
    .select('sourceContractId reference status hasCurrent').lean();
  if (!projection?.hasCurrent || !projection.sourceContractId) return null;
  return {
    sourceContractId: projection.sourceContractId,
    reference: projection.reference ?? null,
    status: projection.status ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  PUBLICATION VERS LES PROJETS                                              */
/* -------------------------------------------------------------------------- */

/**
 * CE QUI PART VERS UN PROJET — et ce qui n'en part jamais.
 *
 * ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
 *
 * Un projet reçoit ce qu'il doit AFFICHER à son propriétaire et ce dont ses
 * gardes ont besoin. Rien d'autre.
 *
 * SORT :   identité légale, adresses, coordonnées de facturation, signataire.
 * NE SORT JAMAIS :
 *
 *   · `notes` — une appréciation interne sur un client, lue par ce client ;
 *   · `documents[]` — le Kbis d'une entreprise n'a rien à faire dans la base
 *     d'un site vitrine, et sa présence y créerait une seconde copie à
 *     protéger ;
 *   · `createdBy` / `updatedBy` — les adresses e-mail des exploitants du Panel.
 *
 * ══ POURQUOI LE SIGNATAIRE EN FAIT PARTIE ══════════════════════════════════
 *
 * Parce que le projet doit pouvoir DIRE au client qui signera, et refuser tôt
 * quand personne n'est désigné. Il ne peut pas l'écrire — l'autorité est ici —
 * mais l'ignorer l'obligerait à interroger le Panel à chaque affichage, ce que
 * l'autonomie du projet interdit.
 */
export function publishedProfile(fiche) {
  return {
    clientCompanyId: fiche.clientCompanyId,
    version: fiche.publishedVersion ?? 0,
    environment: fiche.environment,
    status: fiche.status,

    legalName: fiche.legalName,
    tradingName: fiche.tradingName ?? null,
    legalForm: fiche.legalForm ?? null,
    siren: fiche.siren ?? null,
    siret: fiche.siret ?? null,
    vatNumber: fiche.vatNumber ?? null,
    registrationCity: fiche.registrationCity ?? null,

    registeredOffice: fiche.registeredOffice ?? null,
    /** L'adresse EFFECTIVE : le projet n'a pas à rejouer la substitution. */
    billingAddress: effectiveBillingAddress(fiche),

    billingEmail: fiche.billingEmail ?? null,
    phone: fiche.phone ?? null,
    website: fiche.website ?? null,

    contractualSigner: fiche.contractualSigner
      ? {
        firstName: fiche.contractualSigner.firstName ?? '',
        lastName: fiche.contractualSigner.lastName ?? '',
        jobTitle: fiche.contractualSigner.jobTitle ?? '',
        email: fiche.contractualSigner.email ?? '',
      }
      : null,

    /**
     * L'ÉTAT DE PRÉPARATION VOYAGE AVEC L'IDENTITÉ.
     *
     * Le projet POURRAIT le recalculer — il a tous les champs. Il ne doit pas :
     * la règle de complétude est une décision de facturation, elle appartient
     * au Panel, et deux implémentations divergeraient au premier changement de
     * mention obligatoire. Le projet reçoit le verdict et l'affiche.
     */
    readiness: describeClientCompanyReadiness(fiche),
  };
}

/**
 * L'IDENTIFIANT D'ENTITÉ DU PONT, DÉRIVÉ DE L'IDENTIFIANT MÉTIER.
 *
 * ══ LE DÉFAUT QUE CETTE FONCTION FERME ═══════════════════════════════════
 *
 * Le contrat impose `entityId: uuid`. `clientCompanyId` n'en est pas un :
 * c'est un identifiant opaque court, choisi pour être lisible dans une URL
 * d'écran. Émis tel quel, il faisait REJETER l'écriture à l'arrivée — et un
 * rejet de lecture est une PERTE DÉFINITIVE : le curseur avance, le Panel ne
 * relivre pas. Le projet restait donc sans client légal, paiements et
 * signatures bloqués, sans que rien côté Panel ne paraisse anormal.
 *
 * ══ POURQUOI DÉRIVER PLUTÔT QUE STOCKER UN SECOND IDENTIFIANT ════════════
 *
 * Un UUID v5 est une FONCTION de l'identifiant métier : même graine, même
 * résultat, pour toujours. L'idempotence du pont — qui repose sur
 * `entityId` — est donc préservée sans ajouter un champ à tenir cohérent, et
 * l'identifiant lisible reste dans la charge utile pour la corrélation.
 */
function identiteDePont(clientCompanyId) {
  return stableBridgeId(`client-company:${clientCompanyId}`);
}

/** Publie l'identité vers UN projet nommé. Jamais vers le parc. */
async function publishToProject(projectId, fiche) {
  await emitChange({
    entityType: CLIENT_COMPANY_ENTITY,
    entityId: identiteDePont(fiche.clientCompanyId),
    payload: publishedProfile(fiche),
    /**
     * ISO, TOUJOURS — et jamais l'objet Date que rend la lecture Mongo.
     *
     * Le contrat exige une chaîne datée. Un objet Date passait jusqu'ici
     * parce que la sérialisation du tirage le convertissait en chemin ; il
     * ne franchit plus le contrôle de conformité posé à l'émission, et c'est
     * tant mieux : deux représentations de la même date sur un même champ
     * finissent toujours par se comparer mal quelque part.
     */
    modifiedAt: fiche.publishedAt ? new Date(fiche.publishedAt).toISOString() : nowIso(),
    /**
     * NOMINATIF, et c'est la différence essentielle avec `DEV_COMPANY`.
     *
     * L'identité de L.Y Solution n'est pas un secret : tout le parc la reçoit.
     * L'identité juridique d'un CLIENT en est un pour tous les autres clients.
     * `audience: projectId` est ce qui empêche un garage de lire le SIREN d'un
     * autre — et l'autorisation est portée par l'ÉCRITURE, jamais par un filtre
     * appliqué à la lecture.
     */
    audience: projectId,
  });
}

/** Annonce au projet que cette entreprise ne le concerne plus. */
async function tombstoneOnProject(projectId, clientCompanyId) {
  await emitChange({
    entityType: CLIENT_COMPANY_ENTITY,
    // MÊME dérivation que la publication : sans quoi le retrait désignerait
    // une entité que le projet n'a jamais reçue, et n'effacerait rien.
    entityId: identiteDePont(clientCompanyId),
    deleted: true,
    payload: null,
    modifiedAt: nowIso(),
    audience: projectId,
  });
}

/**
 * REPUBLIE une fiche vers TOUS ses projets rattachés.
 *
 * Une écriture par projet, et non une diffusion générale : c'est le prix de la
 * confidentialité, et il est dérisoire — une entreprise cliente possède une
 * poignée de projets, pas mille.
 */
export async function broadcastToLinkedProjects(clientCompanyId) {
  const fiche = await PanelClientCompany.findOne({ clientCompanyId }).lean();
  if (!fiche) return { recipients: 0 };
  const projets = await projectsOfClientCompany(clientCompanyId);
  for (const projet of projets) {
    // eslint-disable-next-line no-await-in-loop
    await publishToProject(projet.projectId, fiche);
  }

  /**
   * ── LES DOCUMENTS LÉGAUX SUIVENT L'IDENTITÉ ─────────────────────────────
   *
   * ══ POURQUOI ILS NE PEUVENT PAS S'EN PASSER ═══════════════════════════════
   *
   * Un document légal est un RENDU : le SIREN et l'adresse y sont déjà
   * substitués au moment où le Panel l'émet. Corriger l'adresse d'un client
   * sans republier laisserait donc l'ancienne adresse sur ses mentions
   * légales — indéfiniment, et sans qu'aucun écran ne le signale, puisque le
   * Panel affiche la fiche corrigée et que le projet affiche le document reçu.
   * Les deux côtés paraîtraient cohérents avec eux-mêmes.
   *
   * C'est la contrepartie du choix de résoudre au Panel plutôt qu'au projet
   * (voir la doctrine de `LEGAL_DOCUMENT` au contrat), et elle se paie ici, en
   * un seul endroit.
   *
   * ══ POURQUOI L'IMPORT EST DIFFÉRÉ ════════════════════════════════════════
   *
   * `legalDocumentPublisher` lit l'entreprise cliente pour résoudre ses
   * documents. S'importer mutuellement au chargement créerait un cycle, que
   * Node résout par un module à moitié initialisé — donc par une fonction
   * `undefined` au premier appel, en production, sur le geste qui met une
   * identité juridique à jour.
   *
   * ══ NON BLOQUANT ════════════════════════════════════════════════════════
   *
   * L'identité juridique, elle, EST partie : c'est la donnée qui débloque
   * paiements et signatures. Faire échouer son enregistrement parce qu'un
   * document légal n'a pas pu être recalculé inverserait les priorités. La
   * republication a par ailleurs sa propre file durable et son rattrapage.
   */
  await import('../legal/legalDocumentPublisher.js')
    .then((m) => m.republishForClientCompany(clientCompanyId))
    .catch((err) => {
      logger.warn(
        `[legal] Republication des documents de ${clientCompanyId} incomplète : ${err.message}`,
      );
      return 0;
    });

  return { recipients: projets.length };
}

export default {
  CLIENT_COMPANY_ENTITY,
  getClientCompanyOrThrow,
  getClientCompanyDetail,
  listClientCompanies,
  describeClientCompany,
  projectsOfClientCompany,
  createClientCompany,
  updateClientCompany,
  archiveClientCompany,
  restoreClientCompany,
  deleteClientCompany,
  linkProjectToClientCompany,
  unlinkProjectFromClientCompany,
  publishedProfile,
  broadcastToLinkedProjects,
};
