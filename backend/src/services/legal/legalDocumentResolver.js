// LA RÉSOLUTION D'UN DOCUMENT LÉGAL — trois autorités, jamais mélangées.
//
// ══ CE MODULE EST LA FRONTIÈRE MULTI-TENANT DU CHANTIER ═════════════════════
//
// C'est ici, et nulle part ailleurs, qu'un texte devient le document d'UN
// projet. Tout ce qui suit est donc écrit pour rendre le mélange de locataires
// INEXPRIMABLE, et non pour le détecter après coup :
//
//   · la résolution part du PROJET et de lui seul. Il n'existe aucune entrée
//     prenant une entreprise cliente en paramètre : impossible d'en passer une
//     qui ne soit pas la sienne ;
//   · le contexte est construit en TROIS BLOCS de trois requêtes distinctes —
//     `client`, `developer`, `host` — et chacun ne peut être peuplé que depuis
//     son autorité. Un champ client ne peut pas « retomber » sur l'entreprise
//     développeur, parce qu'aucun code ne lit les deux au même endroit ;
//   · la résolution d'une variable est un ACCÈS PAR CLÉ dans une table plate
//     construite au préalable. Il n'y a pas de parcours d'objet, donc pas de
//     chemin arbitraire, donc pas de fuite par chemin.
//
// L'incident FJ / KleenPro a montré ce que coûte l'inverse. La suite
// `legal-tenant-isolation.test.js` injecte volontairement les fixtures de
// l'autre locataire et vérifie qu'aucune n'apparaît.
//
// ══ LA RÈGLE DE CONDITIONNALITÉ, EN UNE PHRASE ══════════════════════════════
//
//   Un bloc dont UNE variable manque est RETIRÉ. Une section dont tous les
//   blocs sont retirés est retirée.
//
// Elle est automatique, sans syntaxe et sans réglage, et c'est ce qui la rend
// sûre : personne ne peut oublier de la déclarer. Elle produit exactement le
// comportement qu'on veut sur un entrepreneur individuel — la ligne « Capital
// social » disparaît au lieu d'afficher « N/A » — et elle rend structurellement
// impossibles les deux sorties interdites :
//
//     SIRET :            (un libellé sans valeur)
//     undefined          (une valeur qui n'existe pas)
//
// La granularité est le BLOC, et pour `FIELDS` la LIGNE. C'est le bon grain :
// retirer la section entière ferait disparaître l'éditeur du site pour un
// numéro de TVA manquant ; ne rien retirer laisserait le trou.
import config from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import PanelProject from '../../models/PanelProject.model.js';
import PanelClientCompany from '../../models/PanelClientCompany.model.js';
import PanelCompany from '../../models/PanelCompany.model.js';
import PanelHostCompany, { HOST_COMPANY_STATUS } from '../../models/PanelHostCompany.model.js';
import PanelLegalTemplate, {
  LEGAL_BLOCK_TYPES,
  LEGAL_DOCUMENT_TYPES,
  LEGAL_TEMPLATE_STATUS,
} from '../../models/PanelLegalTemplate.model.js';
import {
  LEGAL_VARIABLES,
  VARIABLE_SOURCES,
  getVariable,
  isKnownVariable,
  referencedKeys,
} from './legalVariableRegistry.js';

/** Le champ du projet qui porte l'affectation, par type de document. */
export const ASSIGNMENT_FIELD = Object.freeze({
  [LEGAL_DOCUMENT_TYPES.LEGAL_NOTICE]: 'legalNoticeTemplateId',
  [LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY]: 'privacyPolicyTemplateId',
});

/* -------------------------------------------------------------------------- */
/*  LES VALEURS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * UNE VALEUR EST UNE CHAÎNE NON VIDE, OU ELLE N'EXISTE PAS.
 *
 * `null`, `undefined`, `''`, `'   '` et la chaîne `'null'` — qui arrive plus
 * souvent qu'on ne croit d'un import — sont tous traités comme MANQUANTS. Il
 * n'y a pas de demi-valeur : une donnée juridique est là ou elle ne l'est pas.
 */
function value(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined') return null;
  return text;
}

/**
 * LE PAYS D'UNE ADRESSE — un NOM, jamais un code, et jamais « FR ».
 *
 * ══ DEUX DÉFAUTS QUE CETTE FONCTION FERME ══════════════════════════════════
 *
 * `PanelClientCompany.registeredOffice.country` porte un code ISO alpha-2 —
 * c'est ce que Stripe exige et ce qu'une facture électronique attendra. Publié
 * tel quel, il produisait, sur une page de mentions légales française :
 *
 *     Siège social : 15 Les Bastides de Chantemerle, 04200 Sisteron, FR
 *
 * « FR » n'est pas une adresse : c'est un code technique qui a fui jusqu'à
 * l'écran. Et même traduit, « France » n'a rien à faire là : des mentions
 * légales françaises, sur un site français, pour une entreprise française, ne
 * précisent pas le pays — pas plus qu'une enveloppe postée à Nice pour Lyon.
 *
 * Le pays est donc OMIS quand il est la France, et NOMMÉ autrement. Un code
 * inconnu de la table est rendu tel quel : mieux vaut un code visible — que
 * quelqu'un corrigera — qu'un pays silencieusement effacé.
 *
 * `PanelHostCompany.address.country` porte, lui, un nom en clair (« Chypre ») :
 * il traverse cette fonction sans être touché, ce qui est correct — l'hébergeur
 * n'est PAS français, et son pays doit figurer.
 */
const PAYS_PAR_CODE = Object.freeze({
  BE: 'Belgique', CH: 'Suisse', CY: 'Chypre', DE: 'Allemagne', ES: 'Espagne',
  GB: 'Royaume-Uni', IE: 'Irlande', IT: 'Italie', LU: 'Luxembourg', LT: 'Lituanie',
  MC: 'Monaco', NL: 'Pays-Bas', PT: 'Portugal', US: 'États-Unis',
});

function displayCountry(raw) {
  const brut = value(raw);
  if (!brut) return null;
  // Un NOM en clair (plus de deux caractères) est déjà ce qu'on veut afficher.
  if (brut.length > 2) return brut === 'France' ? null : brut;
  const code = brut.toUpperCase();
  if (code === 'FR') return null;
  return PAYS_PAR_CODE[code] ?? code;
}

/**
 * UNE ADRESSE SUR UNE LIGNE — les parties absentes ne laissent pas de virgule.
 *
 * Recomposer « 15 rue X, , 06000 » est le défaut classique d'un `join(', ')`
 * appliqué à des champs facultatifs. On filtre AVANT de joindre.
 */
function joinAddress(address) {
  if (!address) return null;
  const parts = [
    value(address.line1),
    value(address.line2),
    [value(address.postalCode), value(address.city)].filter(Boolean).join(' ') || null,
    displayCountry(address.country),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/* -------------------------------------------------------------------------- */
/*  LES TROIS AUTORITÉS                                                       */
/* -------------------------------------------------------------------------- */

/**
 * L'ENTREPRISE CLIENTE — lue depuis le PROJET, jamais autrement.
 *
 * Le rattachement est porté par `PanelProject.clientCompanyId`. Le lire ici,
 * plutôt que d'accepter une entreprise en paramètre, est ce qui rend le
 * mélange de locataires inexprimable : l'appelant ne CHOISIT pas l'entreprise,
 * il nomme un projet.
 */
function clientValues(fiche) {
  if (!fiche) return {};
  return {
    'client.tradeName': value(fiche.tradingName) ?? value(fiche.legalName),
    'client.legalName': value(fiche.legalName),
    'client.legalForm': value(fiche.legalForm),
    'client.siren': value(fiche.siren),
    'client.siret': value(fiche.siret),
    'client.vatNumber': value(fiche.vatNumber),
    'client.registrationCity': value(fiche.registrationCity),
    /**
     * LE CAPITAL SOCIAL VIENT DE LA FICHE, ET IL EST SOUVENT ABSENT.
     *
     * Ce n'est pas un oubli de saisie : un entrepreneur individuel n'a pas de
     * capital social. La règle de conditionnalité retire alors la ligne, ce
     * qui est exactement le comportement voulu.
     */
    'client.shareCapital': value(fiche.shareCapital),
    'client.address': joinAddress(fiche.registeredOffice),
    'client.email': value(fiche.publicEmail) ?? value(fiche.billingEmail),
    'client.phone': value(fiche.phone),
    /**
     * LE DIRECTEUR DE LA PUBLICATION — saisi, ou à défaut le signataire.
     *
     * Le repli n'est pas une supposition : le signataire contractuel est, par
     * définition, la personne physique qui ENGAGE l'entreprise. C'est
     * l'information la plus proche, elle vient de la MÊME fiche, et elle est
     * saisie par un humain. On ne retombe en revanche JAMAIS sur un compte
     * utilisateur ni sur le nom du projet.
     */
    'client.publicationDirector':
      value(fiche.publicationDirector)
      ?? value(
        [value(fiche.contractualSigner?.firstName), value(fiche.contractualSigner?.lastName)]
          .filter(Boolean)
          .join(' '),
      ),
    /**
     * L'ADRESSE DU SITE — celle de la FICHE, jamais une adresse devinée.
     *
     * Le Panel connaît les adresses réellement servies par un projet
     * (`heartbeat.runtime.network`), et il aurait été tentant d'y retomber.
     * Ce serait une erreur : ces adresses changent au gré des déploiements et
     * incluent des noms techniques. Une mention légale ne cite pas un nom
     * d'hôte de recette.
     */
    'client.websiteUrl': value(fiche.website),
  };
}

/** L'ENTREPRISE DÉVELOPPEUR — `PanelCompany`, le tenant. Jamais le client. */
function developerValues(company) {
  if (!company) return {};
  return {
    'developer.name': value(company.identity?.name),
    'developer.legalName': value(company.identity?.legalName),
    'developer.legalForm': value(company.legal?.legalForm),
    'developer.siren': value(company.legal?.siren),
    'developer.siret': value(company.legal?.siret),
    'developer.vatNumber': value(company.legal?.vatNumber),
    'developer.address': joinAddress(company.contacts?.address),
    /**
     * LE CONTACT PUBLIC, et rien d'autre.
     *
     * `contacts.email` est l'adresse ADMINISTRATIVE et `supportEmail` celle des
     * certificats Let's Encrypt. Les publier sur les mentions légales d'un
     * client afficherait une boîte technique comme contact du concepteur. Le
     * protocole du Panel l'interdit explicitement ; le repli suit donc l'ordre
     * qu'il définit, et s'arrête au contact public.
     */
    'developer.email': value(company.contacts?.publicContactEmail),
    'developer.website': value(company.domains?.websiteUrl),
  };
}

/** L'HÉBERGEUR — `PanelHostCompany`. Ni nous, ni le client. */
function hostValues(host) {
  if (!host) return {};
  return {
    'host.legalName': value(host.legalName),
    'host.legalForm': value(host.legalForm),
    'host.registrationNumber': value(host.registrationNumber),
    'host.address': joinAddress(host.address),
    'host.country': value(host.address?.country),
    'host.email': value(host.email),
    'host.phone': value(host.phone),
    'host.website': value(host.website),
  };
}

/* -------------------------------------------------------------------------- */
/*  LE CONTEXTE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Construit la table plate des valeurs d'un projet.
 *
 * ══ POURQUOI UNE TABLE PLATE ET NON L'OBJET MÉTIER ═════════════════════════
 *
 * Parce qu'un objet imbriqué invite à un parcours de chemin
 * (`get(obj, 'client.notes')`), et qu'un parcours de chemin donne accès à TOUT
 * ce que l'objet contient — notes internes de gestion, documents, identifiants
 * fournisseurs. Une table plate dont les clés sont exactement celles du
 * registre ne peut rendre que ce que le registre déclare.
 */
export async function resolveLegalContext(projectId) {
  const project = await PanelProject.findOne({ projectId }).lean();
  if (!project) {
    throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', 'Projet inconnu.');
  }

  /**
   * LES TROIS LECTURES SONT INDÉPENDANTES, ET C'EST LE POINT.
   *
   * Chacune interroge SA collection avec SON critère. Aucune ne peut servir de
   * repli à une autre : il n'y a pas de code où deux autorités se rencontrent.
   *
   * L'entreprise cliente est cherchée par l'identifiant PORTÉ PAR LE PROJET,
   * et le monde doit concorder — une fiche de production n'a rien à faire dans
   * un document de recette, ni l'inverse.
   */
  const client = project.clientCompanyId
    ? await PanelClientCompany.findOne({
      clientCompanyId: project.clientCompanyId,
      environment: config.env,
    }).lean()
    : null;

  const developer = await PanelCompany.findOne({ active: true, environment: config.env }).lean();

  const host = await PanelHostCompany.findOne({
    environment: config.env,
    status: HOST_COMPANY_STATUS.ACTIVE,
  })
    .sort({ createdAt: 1 })
    .lean();

  const values = {
    ...clientValues(client),
    ...developerValues(developer),
    ...hostValues(host),
  };

  /**
   * TOUTES LES CLÉS DU REGISTRE EXISTENT DANS LA TABLE, ne serait-ce qu'à
   * `null`. Sans cela, « clé absente » et « valeur manquante » seraient deux
   * états différents pour le même fait, et le décompte de complétude
   * dépendrait de la présence d'une autorité plutôt que d'une donnée.
   */
  for (const variable of LEGAL_VARIABLES) {
    if (!(variable.key in values)) values[variable.key] = null;
  }

  return {
    projectId: project.projectId,
    projectKey: project.projectKey,
    projectName: project.projectName ?? project.projectKey,
    clientCompanyId: project.clientCompanyId ?? null,
    authorities: {
      client: client ? { id: client.clientCompanyId, label: client.legalName } : null,
      developer: developer ? { id: developer.companyId, label: developer.identity?.name ?? null } : null,
      host: host ? { id: host.hostCompanyId, label: host.legalName } : null,
    },
    values,
  };
}

/**
 * L'ÉTAT DE COMPLÉTUDE — « 8 / 9 champs disponibles ».
 *
 * Calculé sur les clés RÉELLEMENT UTILISÉES par un document, jamais sur le
 * registre entier : annoncer « 12 / 31 » à quelqu'un dont le template n'en
 * utilise que douze serait une alarme permanente, donc une alarme ignorée.
 */
export function describeCompleteness(usedKeys, values) {
  const fields = usedKeys
    .filter(isKnownVariable)
    .map((key) => {
      const variable = getVariable(key);
      return {
        key,
        label: variable.label,
        source: variable.source,
        required: variable.required,
        available: Boolean(values[key]),
      };
    });

  const missing = fields.filter((f) => !f.available);
  return {
    total: fields.length,
    available: fields.length - missing.length,
    missing,
    /** Bloquant au sens « à corriger », jamais au sens « publication refusée ». */
    missingRequired: missing.filter((f) => f.required),
    fields,
  };
}

/* -------------------------------------------------------------------------- */
/*  LE RENDU                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Substitue les variables d'un texte.
 *
 * Rend `null` dès qu'UNE variable manque — c'est le signal qui fait retirer le
 * bloc. Rendre un texte partiel serait le pire des deux mondes : ni la phrase
 * complète, ni son absence, mais une phrase amputée que personne n'a relue.
 */
function substitute(text, values) {
  const source = String(text ?? '');
  const keys = referencedKeys(source);
  for (const key of keys) {
    if (!values[key]) return null;
  }
  let out = source;
  for (const key of keys) {
    // Remplacement global de la forme exacte ET de la forme espacée : le
    // validateur accepte `{{ cle }}`, le rendu doit donc l'accepter aussi.
    out = out.replace(
      new RegExp(`\\{\\{\\s*${key.replace('.', '\\.')}\\s*\\}\\}`, 'g'),
      values[key],
    );
  }
  return out;
}

/** Un bloc résolu, ou `null` s'il doit disparaître. */
function renderBlock(block, values) {
  if (block.type === LEGAL_BLOCK_TYPES.PARAGRAPH) {
    const text = substitute(block.text, values);
    return text ? { type: 'PARAGRAPH', text } : null;
  }

  if (block.type === LEGAL_BLOCK_TYPES.LIST) {
    const items = (block.items ?? [])
      .map((item) => substitute(item, values))
      .filter((item) => Boolean(item));
    return items.length ? { type: 'LIST', items } : null;
  }

  /**
   * `FIELDS` — LA LIGNE est l'unité de disparition, pas le bloc.
   *
   * C'est ce qui permet à un bloc « Identification légale » d'afficher SIREN et
   * SIRET tout en omettant TVA et capital social pour un entrepreneur
   * individuel. Retirer le bloc entier au premier champ manquant supprimerait
   * l'identification légale complète d'un EI, ce qui est précisément ce qu'une
   * mention légale doit porter.
   */
  const items = (block.fields ?? [])
    .map((field) => {
      const label = substitute(field.label, values);
      const fieldValue = substitute(field.value, values);
      if (!label || !fieldValue) return null;
      return { label, value: fieldValue };
    })
    .filter(Boolean);
  return items.length ? { type: 'FIELDS', items } : null;
}

/** Le document résolu — sections vides retirées. */
export function renderContent(content, values) {
  const sections = (content?.sections ?? [])
    .map((section) => {
      const blocks = (section.blocks ?? [])
        .map((block) => renderBlock(block, values))
        .filter(Boolean);
      if (!blocks.length) return null;
      /**
       * Le TITRE d'une section peut lui aussi porter une variable. S'il ne se
       * résout pas, la section garde ses blocs et perd son titre : supprimer
       * du contenu valide parce qu'un intitulé manque serait disproportionné.
       */
      const heading = substitute(section.heading, values);
      return { heading: heading ?? '', blocks };
    })
    .filter(Boolean);

  return {
    title: substitute(content?.title, values) ?? String(content?.title ?? '').trim(),
    sections,
  };
}

/* -------------------------------------------------------------------------- */
/*  LE DOCUMENT COMPLET                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Le contenu à servir pour un template donné.
 *
 * ══ PUBLIÉ D'ABORD, BROUILLON JAMAIS ═══════════════════════════════════════
 *
 * Un template ACTIF sert `publishedContent`. Un template qui n'a jamais été
 * publié n'a rien à servir — et c'est bien ainsi : un brouillon ne doit pas
 * atteindre un site parce que quelqu'un l'a assigné par erreur.
 *
 * `preview: true` sert le BROUILLON : c'est tout l'objet de l'aperçu, voir ce
 * qu'on s'apprête à publier. Il ne sort jamais du Panel.
 */
function servedContent(template, { preview = false } = {}) {
  if (preview) return template.content ?? { title: '', sections: [] };
  return template.publishedContent ?? null;
}

/**
 * RÉSOUT UN DOCUMENT pour un projet et un template.
 *
 * Rend `{ document, completeness, context }` — ou lève si le template n'est pas
 * servable. C'est l'unique fabrique du read-model public : l'aperçu du Panel et
 * la publication vers un projet passent tous deux par elle, ce qui garantit que
 * ce qu'on relit à l'écran est EXACTEMENT ce qui partira.
 */
export async function resolveDocument({ projectId, template, preview = false, context = null }) {
  const ctx = context ?? (await resolveLegalContext(projectId));
  const content = servedContent(template, { preview });

  if (!content) {
    throw ApiError.conflict(
      'LEGAL_TEMPLATE_NOT_PUBLISHED',
      `Le template « ${template.name} » n'a jamais été publié : il n'y a rien à servir.`,
      { legalTemplateId: template.legalTemplateId },
    );
  }

  const document = renderContent(content, ctx.values);
  const usedKeys = [];
  const collect = (text) => {
    for (const key of referencedKeys(text)) {
      if (isKnownVariable(key) && !usedKeys.includes(key)) usedKeys.push(key);
    }
  };
  collect(content.title);
  for (const section of content.sections ?? []) {
    collect(section.heading);
    for (const block of section.blocks ?? []) {
      collect(block.text);
      for (const item of block.items ?? []) collect(item);
      for (const field of block.fields ?? []) {
        collect(field.label);
        collect(field.value);
      }
    }
  }

  return {
    context: ctx,
    completeness: describeCompleteness(usedKeys, ctx.values),
    document: {
      type: template.type,
      templateId: template.legalTemplateId,
      templateName: template.name,
      templateVersion: preview ? null : (template.version ?? 0),
      title: document.title,
      sections: document.sections,
      updatedAt: template.publishedAt ?? template.updatedAt ?? null,
    },
  };
}

/**
 * Le template ASSIGNÉ à un projet pour un type, ou `null`.
 *
 * Aucun repli sur « le premier template actif » : un document juridique servi
 * par défaut serait un document que personne n'a choisi pour ce client. Sans
 * affectation, la vitrine n'affichera pas la page — c'est un état, pas une
 * panne.
 */
export async function assignedTemplate(project, type) {
  const field = ASSIGNMENT_FIELD[type];
  if (!field) return null;
  const id = project?.[field];
  if (!id) return null;
  const template = await PanelLegalTemplate.findOne({
    legalTemplateId: id,
    environment: config.env,
  }).lean();
  if (!template) return null;
  /**
   * UN BROUILLON ASSIGNÉ N'EST PAS SERVI.
   *
   * Il peut le devenir : l'assignation d'un template qui serait ensuite
   * dépublié (retour en brouillon) laisserait un site sans page. On préfère
   * cela à servir un texte que personne n'a validé — et l'écran du Panel le
   * signale, ce qui est la seule façon de le corriger.
   *
   * ARCHIVED, en revanche, EST servi : archiver retire du catalogue, jamais des
   * sites déjà servis. Retirer sous les pieds d'un site en production un
   * document juridique serait pire que de le laisser vieillir.
   */
  if (template.status === LEGAL_TEMPLATE_STATUS.DRAFT) return null;
  return template;
}

export { VARIABLE_SOURCES };

export default {
  resolveLegalContext,
  resolveDocument,
  renderContent,
  describeCompleteness,
  assignedTemplate,
  ASSIGNMENT_FIELD,
};
