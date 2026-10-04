// MIGRATION — templates légaux de SERGE MAIL (SaaS, assistant e-mail IA).
//
//   node src/scripts/migrations/2026-10-04-sergemail-legal-templates.js --dry-run
//   node src/scripts/migrations/2026-10-04-sergemail-legal-templates.js
//
// ══ POURQUOI DES TEMPLATES PROPRES, ET PAS CEUX D'UNE VITRINE ═════════════════
//
// Les templates du parc décrivent un SITE VITRINE : un formulaire de contact,
// des polices, éventuellement une carte. Serge Mail est un SERVICE EN LIGNE :
// des comptes clients, des identifiants de messagerie confiés au service, des
// e-mails lus par une intelligence artificielle À LA DEMANDE de l'utilisateur,
// un historique de discussions. Une politique de vitrine posée sur ce service
// passerait sous silence le traitement le plus sensible qu'il réalise — c'est
// exactement le contraire de ce qu'une politique de confidentialité doit faire.
//
// Ce que les textes affirment est VRAI dans le code du projet sergemail :
//   · mots de passe des comptes hachés (bcrypt) ;
//   · identifiants de messagerie chiffrés AES-256-GCM, jamais transmis à l'IA ;
//   · e-mails transmis à Mistral AI uniquement quand l'agent les lit pour
//     répondre à une demande ;
//   · aucune action sur la boîte sans autorisation, sauf réglage contraire ;
//   · suppression d'un connecteur = suppression de ses identifiants ;
//   · mesure d'audience de la vitrine : compteurs agrégés, sans cookie ni
//     identifiant.
//
// Les données de l'ÉDITEUR viennent de la fiche « Client » liée au projet
// (`{{client.*}}`). Tant qu'elle n'existe pas, les blocs qui en dépendent sont
// retirés du document publié — jamais affichés avec un trou.
//
// Idempotente : identifiants stables, template existant laissé INTACT,
// affectation posée seulement si le champ du projet est vide.

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import PanelProject from '../../models/PanelProject.model.js';
import PanelLegalTemplate, {
  LEGAL_DOCUMENT_TYPES,
  LEGAL_TEMPLATE_STATUS,
} from '../../models/PanelLegalTemplate.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_KEY = 'sergemail';

export const SERGEMAIL_TEMPLATE_IDS = Object.freeze({
  LEGAL_NOTICE: 'lt-sergemail-legal-notice',
  PRIVACY_POLICY: 'lt-sergemail-privacy-policy',
});

const p = (text) => ({ type: 'PARAGRAPH', text });
const list = (...items) => ({ type: 'LIST', items });
const fields = (...pairs) => ({ type: 'FIELDS', fields: pairs.map(([label, value]) => ({ label, value })) });

const LEGAL_NOTICE_CONTENT = {
  title: 'Mentions légales',
  sections: [
    {
      heading: 'Éditeur du site et du service',
      blocks: [
        p('Le site et le service Serge Mail sont édités par {{client.legalName}}.'),
        fields(
          ['Nom commercial', '{{client.tradeName}}'],
          ['Forme juridique', '{{client.legalForm}}'],
          ['Siège social', '{{client.address}}'],
          ['SIREN', '{{client.siren}}'],
          ['SIRET', '{{client.siret}}'],
          ['RCS', '{{client.registrationCity}}'],
          ['Capital social', '{{client.shareCapital}}'],
          ['TVA intracommunautaire', '{{client.vatNumber}}'],
          ['Adresse e-mail', '{{client.email}}'],
          ['Téléphone', '{{client.phone}}'],
        ),
      ],
    },
    {
      heading: 'Directeur de la publication',
      blocks: [p('Le directeur de la publication est {{client.publicationDirector}}.')],
    },
    {
      heading: 'Conception et réalisation',
      blocks: [
        p('Le site et le service ont été conçus et développés par {{developer.name}}.'),
        fields(
          ['Raison sociale', '{{developer.legalName}}'],
          ['SIREN', '{{developer.siren}}'],
          ['Adresse', '{{developer.address}}'],
          ['Site web', '{{developer.website}}'],
        ),
      ],
    },
    {
      heading: 'Hébergement',
      blocks: [
        p('Le site et le service sont hébergés par {{host.legalName}}.'),
        fields(
          ['Forme juridique', '{{host.legalForm}}'],
          ["Numéro d'immatriculation", '{{host.registrationNumber}}'],
          ['Adresse', '{{host.address}}'],
          ['Adresse e-mail', '{{host.email}}'],
          ['Site web', '{{host.website}}'],
        ),
      ],
    },
    {
      heading: "Fournisseur d'intelligence artificielle",
      blocks: [
        p("Les réponses de l'assistant sont produites par des modèles de Mistral AI, société par actions simplifiée de droit français, via son interface de programmation (API)."),
      ],
    },
    {
      heading: 'Propriété intellectuelle',
      blocks: [
        p("La marque Serge Mail, son logo, sa mascotte, les textes, éléments graphiques et développements du site et du service sont protégés par le droit de la propriété intellectuelle. Toute reproduction, représentation ou exploitation, totale ou partielle, sans autorisation écrite préalable est interdite."),
        p("Les e-mails, pièces jointes et contenus de votre messagerie restent votre propriété, ou celle de leurs auteurs. Le service ne fait que les consulter à votre demande."),
      ],
    },
    {
      heading: 'Responsabilité',
      blocks: [
        p("L'assistant propose des recherches, des résumés et des brouillons produits par une intelligence artificielle : ils peuvent comporter des erreurs et doivent être relus. Les actions qui agissent sur votre boîte (envoi, déplacement, suppression…) sont soumises à votre autorisation explicite, sauf si vous choisissez de lever cette protection pour une action donnée ; vous demeurez responsable des actions que vous autorisez."),
        p("Nous mettons en œuvre les moyens raisonnables pour assurer la disponibilité du service, sans pouvoir garantir un fonctionnement ininterrompu, ni la disponibilité des messageries et services tiers auxquels il se connecte."),
      ],
    },
    {
      heading: 'Données personnelles',
      blocks: [
        p('Les traitements de données personnelles réalisés par le site et le service sont décrits dans la politique de confidentialité, accessible depuis le pied de page.'),
      ],
    },
  ],
};

const PRIVACY_POLICY_CONTENT = {
  title: 'Politique de confidentialité',
  sections: [
    {
      heading: 'Responsable du traitement',
      blocks: [
        p('{{client.legalName}} est responsable des traitements de données personnelles réalisés par le site et le service Serge Mail.'),
        fields(
          ['Siège social', '{{client.address}}'],
          ['SIREN', '{{client.siren}}'],
          ['Adresse e-mail', '{{client.email}}'],
        ),
      ],
    },
    {
      heading: 'Ce que fait le service, en clair',
      blocks: [
        p("Serge Mail est un assistant qui se connecte à la messagerie que vous lui confiez, pour y chercher, lire, résumer, rédiger et — avec votre accord — envoyer, classer ou supprimer des e-mails. Il ne consulte votre boîte que lorsque vous lui adressez une demande, et dans la seule mesure nécessaire pour y répondre."),
      ],
    },
    {
      heading: 'Données collectées',
      blocks: [
        list(
          "Votre compte : adresse e-mail, prénom et nom si vous les renseignez, date de création et de dernière connexion. Votre mot de passe n'est jamais conservé en clair : seule une empreinte irréversible est stockée.",
          "Vos connexions de messagerie : l'adresse et les paramètres du serveur (IMAP, SMTP ou serveur MCP), ainsi que le mot de passe d'application ou le jeton d'accès que vous fournissez. Ces identifiants sont chiffrés (AES-256) et ne sont jamais transmis au fournisseur d'intelligence artificielle.",
          "Vos discussions avec l'assistant : vos messages, ses réponses, les actions qu'il a proposées, celles que vous avez autorisées ou refusées, et les résultats de ces actions — y compris les extraits d'e-mails que l'assistant a lus pour vous répondre.",
          "Vos réglages : la liste des actions que l'assistant peut exécuter sans demander votre accord.",
          "Le contenu de votre messagerie n'est PAS copié dans nos bases : seuls les extraits nécessaires à une réponse apparaissent dans la discussion concernée.",
          "Journaux techniques du serveur : adresse IP, date et heure, adresse demandée et identifiant du navigateur, enregistrés automatiquement par l'infrastructure d'hébergement.",
          "Mesure de fréquentation du site public : des compteurs agrégés par jour (pages vues, clics sur les boutons), sans cookie, sans adresse IP et sans aucun identifiant de visiteur.",
        ),
      ],
    },
    {
      heading: 'Finalités et bases légales',
      blocks: [
        fields(
          ['Fournir le service : compte, connexion à votre messagerie, assistant', "Exécution du contrat (conditions d'utilisation du service) que vous acceptez en créant votre compte."],
          ['Conserver l’historique de vos discussions', "Exécution du contrat : c'est la mémoire de chaque discussion, que vous pouvez supprimer à tout moment."],
          ['Assurer la sécurité du service et prévenir les abus', "Intérêt légitime à protéger le service et ses utilisateurs."],
          ['Améliorer le site public', "Intérêt légitime, au moyen de compteurs agrégés et anonymes."],
          ['Respecter nos obligations légales', 'Obligation légale.'],
        ),
      ],
    },
    {
      heading: "L'intelligence artificielle : ce qui lui est transmis",
      blocks: [
        p("Les réponses de l'assistant sont produites par les modèles de Mistral AI (France), appelés par notre serveur. Pour chaque demande, lui sont transmis : vos messages de la discussion en cours, les réponses précédentes de l'assistant, et les résultats des actions réalisées pour vous répondre — par exemple la liste ou le contenu des e-mails que l'assistant a lus à cette occasion."),
        p("Ne lui sont JAMAIS transmis : votre mot de passe, vos identifiants de messagerie, ni les discussions autres que celle en cours. Les autorisations d'action sont décidées par notre serveur, pas par l'intelligence artificielle."),
        p("Le traitement de ces données par Mistral AI est régi par ses conditions applicables aux utilisateurs de son API, en qualité de sous-traitant."),
      ],
    },
    {
      heading: 'Destinataires des données',
      blocks: [
        p("Vos données ne sont ni vendues, ni louées, ni cédées à des fins commerciales. Elles ne sont accessibles qu'aux personnes habilitées de l'éditeur, qui voient les informations de votre compte et le volume de votre activité, mais pas le contenu de vos discussions ni de votre messagerie."),
        p('Interviennent également, dans la stricte limite de leur mission :'),
        list(
          '{{host.legalName}}, hébergeur du site et du service.',
          "Mistral AI, fournisseur des modèles d'intelligence artificielle, établi en France.",
          "Un prestataire de messagerie transactionnelle établi dans l'Union européenne, pour les e-mails de service.",
          "Google Ireland Limited et Google LLC, au titre des seules polices de caractères du site (voir « Cookies et services tiers »).",
          "Votre propre fournisseur de messagerie, auquel le service se connecte en votre nom.",
        ),
      ],
    },
    {
      heading: 'Cookies et services tiers',
      blocks: [
        p("Le site et le service ne déposent AUCUN cookie publicitaire ni de mesure d'audience. L'espace client mémorise votre session dans le stockage local de votre navigateur, à seule fin de vous garder connecté ; elle disparaît à la déconnexion."),
        p("Les polices de caractères sont fournies par Google Fonts : votre navigateur les demande directement aux serveurs de Google, qui reçoivent alors votre adresse IP et des informations techniques de navigation. Aucun autre service tiers n'est intégré aux pages."),
      ],
    },
    {
      heading: 'Durées de conservation',
      blocks: [
        fields(
          ['Compte', "Tant que votre compte existe ; supprimé avec l'ensemble de ses données à la clôture du compte."],
          ['Identifiants de messagerie', 'Tant que la messagerie est connectée ; supprimés dès que vous la débranchez.'],
          ['Discussions', "Jusqu'à ce que vous les supprimiez, ou jusqu'à la clôture du compte."],
          ['Journaux techniques', "Durée courte, propre à l'exploitation du serveur, à des fins de sécurité et de diagnostic."],
        ),
      ],
    },
    {
      heading: "Transferts hors de l'Union européenne",
      blocks: [
        p("Les données du service sont traitées dans l'Union européenne : l'hébergement et le fournisseur d'intelligence artificielle y sont établis. Seul le service de polices de caractères de Google est susceptible de transférer des données techniques, dont votre adresse IP, hors de l'Union européenne, dans le cadre des garanties mises en place par Google (clauses contractuelles types de la Commission européenne)."),
      ],
    },
    {
      heading: 'Sécurité',
      blocks: [
        p("Le site et le service sont servis exclusivement en HTTPS. Les mots de passe des comptes sont hachés ; les identifiants de messagerie sont chiffrés au repos. Chaque compte n'accède qu'à ses propres données. Toute action ayant un effet sur votre boîte est, par défaut, présentée en détail et soumise à votre autorisation avant exécution ; l'action exécutée est exactement celle que vous avez autorisée."),
      ],
    },
    {
      heading: 'Vos droits',
      blocks: [
        p("Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation et d'opposition sur vos données, ainsi que d'un droit à la portabilité. Vous pouvez à tout moment débrancher votre messagerie et supprimer vos discussions depuis votre espace client."),
        p('Pour exercer vos droits ou demander la clôture de votre compte, écrivez-nous à {{client.email}}.'),
        p("Si vous estimez que vos droits ne sont pas respectés, vous pouvez adresser une réclamation à la Commission nationale de l'informatique et des libertés (CNIL), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07 — www.cnil.fr."),
      ],
    },
    {
      heading: 'Évolution de cette politique',
      blocks: [
        p('Cette politique peut être mise à jour pour refléter une évolution du service ou de la réglementation. La version en vigueur est celle publiée sur cette page.'),
      ],
    },
  ],
};

const TEMPLATES = [
  {
    legalTemplateId: SERGEMAIL_TEMPLATE_IDS.LEGAL_NOTICE,
    type: LEGAL_DOCUMENT_TYPES.LEGAL_NOTICE,
    name: 'Mentions légales — SaaS assistant e-mail IA (Serge Mail)',
    description: "Mentions légales d'un service en ligne d'assistant e-mail à base d'IA : éditeur, concepteur, hébergeur, fournisseur d'IA, responsabilité sur les actions autorisées.",
    content: LEGAL_NOTICE_CONTENT,
    assignmentField: 'legalNoticeTemplateId',
  },
  {
    legalTemplateId: SERGEMAIL_TEMPLATE_IDS.PRIVACY_POLICY,
    type: LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY,
    name: 'Politique de confidentialité — SaaS assistant e-mail IA (Serge Mail)',
    description: "Comptes clients, identifiants de messagerie chiffrés, e-mails lus à la demande et transmis à Mistral AI, historique des discussions, aucun cookie de suivi.",
    content: PRIVACY_POLICY_CONTENT,
    assignmentField: 'privacyPolicyTemplateId',
  },
];

export async function migrateSergeMailLegal({ dryRun = false } = {}) {
  const rapport = { environnement: config.env, details: [] };
  const { validateContent } = await import('../../services/legal/legalTemplate.validation.js');
  const { publishTemplate } = await import('../../services/legal/legalTemplate.service.js');
  const { republishTemplate } = await import('../../services/legal/legalDocumentPublisher.js');

  for (const modele of TEMPLATES) {
    const existant = await PanelLegalTemplate.findOne({ legalTemplateId: modele.legalTemplateId, environment: config.env }).lean();
    if (existant) {
      rapport.details.push(`Template « ${modele.name} » déjà présent (v${existant.version}) — INTACT.`);
      continue;
    }
    const contenu = validateContent(modele.content);
    rapport.details.push(`Création du template « ${modele.name} » (${modele.type}).`);
    if (dryRun) continue;
    const at = nowIso();
    await PanelLegalTemplate.create({
      legalTemplateId: modele.legalTemplateId,
      name: modele.name,
      type: modele.type,
      description: modele.description,
      content: contenu,
      status: LEGAL_TEMPLATE_STATUS.DRAFT,
      version: 0,
      publishedContent: null,
      environment: config.env,
      createdAt: at,
      updatedAt: at,
      createdBy: 'migration:sergemail-legal',
      updatedBy: 'migration:sergemail-legal',
    });
    await publishTemplate(modele.legalTemplateId, { email: 'migration:sergemail-legal' }, { republish: republishTemplate });
    rapport.details.push('  → publié en v1.');
  }

  const projet = await PanelProject.findOne({ projectKey: PROJECT_KEY }).lean();
  if (!projet) {
    rapport.details.push(`Projet « ${PROJECT_KEY} » absent du registre — affectation reportée.`);
    return rapport;
  }
  const patch = {};
  for (const modele of TEMPLATES) {
    const actuel = projet[modele.assignmentField];
    if (actuel === modele.legalTemplateId) rapport.details.push(`${modele.type} : déjà affecté.`);
    else if (actuel) rapport.details.push(`ATTENTION — ${modele.type} : déjà affecté à « ${actuel} », laissé tel quel.`);
    else {
      patch[modele.assignmentField] = modele.legalTemplateId;
      rapport.details.push(`${modele.type} : affectation au template Serge Mail.`);
    }
  }
  if (!dryRun) {
    if (Object.keys(patch).length) {
      await PanelProject.updateOne({ projectId: projet.projectId }, { $set: { ...patch, updatedAt: nowIso() } });
    }
    const { resyncProjectLegalDocuments } = await import('../../services/legal/legalAssignment.service.js');
    await resyncProjectLegalDocuments(projet.projectId).catch((err) => {
      rapport.details.push(`Republication différée : ${err.message}`);
    });
  }
  return rapport;
}

async function main() {
  await connectDatabase();
  try {
    const rapport = await migrateSergeMailLegal({ dryRun: DRY_RUN });
    logger.info(`\nMIGRATION LÉGALE SERGE MAIL — ${DRY_RUN ? 'SIMULATION' : 'ÉCRITURE'} (${rapport.environnement})`);
    for (const ligne of rapport.details) logger.info(`  · ${ligne}`);
    logger.info(DRY_RUN ? '\nAucune écriture. Relancez sans --dry-run.' : '\nTerminé.');
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && process.argv[1].endsWith('2026-10-04-sergemail-legal-templates.js')) {
  await main();
  setTimeout(() => process.exit(0), 200);
}
