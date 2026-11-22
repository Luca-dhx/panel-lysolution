// MIGRATION — Politique de confidentialité de MELI NAILS, version 4 (22/11/2026).
//
//   node src/scripts/migrations/2026-11-22-meli-nails-privacy-v4.js            (simulation)
//   node src/scripts/migrations/2026-11-22-meli-nails-privacy-v4.js --apply    (écriture)
//   node src/scripts/migrations/2026-11-22-meli-nails-privacy-v4.js --apply --resync
//        (republie la politique vers melinails seulement, sans rien recréer)
//
// ══ POURQUOI UN TEMPLATE PROPRE À MELI NAILS ════════════════════════════════
//
// Jusqu'ici, melinails partageait le template « BeautySavage — Politique de
// confidentialité » (lte2ff7817c1974c7aba5b) avec beautysavage ET
// beautysavage-prod. Modifier ce template aurait republié le texte de MELI NAILS
// sur le site de production d'un AUTRE client. On crée donc un template dédié,
// on le publie, puis on bascule l'affectation du SEUL projet melinails. Le
// template BeautySavage, son historique et les deux autres projets restent
// strictement intacts.
//
// ══ CE QUE LE TEXTE AFFIRME, ET D'OÙ ÇA VIENT ═══════════════════════════════
//
// Structure, style et identité reprises de la v3 publiée (03/10/2026) :
// l'identité du responsable vient de la fiche Client du projet (`{{client.*}}`),
// jamais saisie ici. Faits vérifiés dans le code de meli_nails le 2026-11-22 :
// comptes, réservations, commandes, factures (10 ans), cartes cadeaux (codes
// hachés + chiffrés), formations, contact, avis modérés, demandes d'avis et
// rappels, offre de bienvenue, comptage des absences, e-mails commerciaux sur
// case non cochée, reprise Amelia (nov. 2026), purges automatiques ; Stripe,
// Brevo, Streamable, Google Maps sur consentement « Contenus externes »,
// Instagram sans traceur, polices et photos servies par le site.
// Région du cluster MongoDB Atlas du projet : AWS EU_WEST_3 (Paris), lue le
// 2026-11-22 dans les étiquettes `hello` du jeu de réplicas.
//
// ══ IDEMPOTENTE ═════════════════════════════════════════════════════════════
//
// Identifiant stable ; template existant laissé INTACT ; affectation basculée
// seulement si melinails pointe encore sur le template BeautySavage attendu —
// toute autre valeur est signalée et laissée telle quelle.

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import PanelProject from '../../models/PanelProject.model.js';
import PanelLegalTemplate, {
  LEGAL_DOCUMENT_TYPES,
  LEGAL_TEMPLATE_STATUS,
} from '../../models/PanelLegalTemplate.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';

const APPLY = process.argv.includes('--apply');
const RESYNC = process.argv.includes('--resync');
const ACTOR = { email: 'migration:meli-nails-privacy-v4' };

const PROJECT_KEY = 'melinails';
const PREVIOUS_TEMPLATE_ID = 'lte2ff7817c1974c7aba5b';
export const MELINAILS_PRIVACY_TEMPLATE_ID = 'lt-melinails-privacy-policy';

const p = (text) => ({ type: 'PARAGRAPH', text });
const list = (...items) => ({ type: 'LIST', items });
const fields = (...pairs) => ({ type: 'FIELDS', fields: pairs.map(([label, value]) => ({ label, value })) });

export const PRIVACY_V4_CONTENT = {
  title: 'Politique de confidentialité',
  sections: [
    {
      heading: 'Responsable du traitement',
      blocks: [
        p('{{client.tradeName}} est responsable des traitements de données personnelles réalisés depuis ce site.'),
        fields(
          ['Raison sociale', '{{client.legalName}}'],
          ['Siège social', '{{client.address}}'],
          ['SIREN', '{{client.siren}}'],
          ['Téléphone', '{{client.phone}}'],
          ['Adresse e-mail', '{{client.email}}'],
        ),
        p("Aucun délégué à la protection des données (DPO) n'a été désigné. Pour toute question relative à vos données, écrivez à {{client.email}}."),
      ],
    },
    {
      heading: 'Données collectées',
      blocks: [
        p('Nous ne collectons que les données nécessaires aux services que vous utilisez :'),
        list(
          "Compte client : adresse e-mail, nom et prénom, téléphone, mot de passe (conservé sous forme hachée, jamais lisible) et la confirmation de votre adresse e-mail.",
          "Réservations et rendez-vous : prestation choisie, date et heure, options, acompte et solde restant à régler sur place, annulations, remboursements, et rendez-vous non honorés.",
          "Commandes et factures : articles achetés, montants, factures.",
          "Cartes cadeaux : identité de l'acheteur, nom et adresse e-mail du bénéficiaire, montant et message. Les codes des cartes sont conservés sous forme hachée et chiffrée.",
          "Formations en ligne et en présentiel : formations suivies, progression dans les modules, diplôme ou attestation délivrés, sessions réservées.",
          "Participants et bénéficiaires désignés par un acheteur : lorsqu'une personne achète une formation de groupe ou une carte cadeau pour quelqu'un d'autre, elle nous communique le nom et l'adresse e-mail des participants ou du bénéficiaire.",
          "Avis : note, commentaire et nom d'affichage que vous choisissez.",
          "Formulaire de contact : nom, adresse e-mail, téléphone et contenu de votre message.",
          "Préférence commerciale : votre accord ou refus de recevoir nos e-mails commerciaux, et la date de cet accord.",
          "Paiement : le paiement est réalisé chez Stripe. Nous recevons uniquement le résultat du paiement et une référence ; vos données de carte ne transitent jamais par ce site.",
          "Journaux techniques du serveur : adresse IP, date et heure, page demandée, nécessaires à la sécurité et au bon fonctionnement du site.",
        ),
      ],
    },
    {
      heading: 'Finalités et bases légales',
      blocks: [
        list(
          "Gérer votre compte, vos réservations, vos commandes, vos cartes cadeaux et vos formations (progression, diplôme) — exécution du contrat.",
          "Établir les factures et conserver les pièces comptables pendant 10 ans (article L123-22 du Code de commerce) — obligation légale.",
          "Vous envoyer les e-mails liés à vos démarches : code de vérification, confirmation de commande et de rendez-vous, rappel de rendez-vous, annulation, carte cadeau, réinitialisation de mot de passe — exécution du contrat.",
          "Vous inviter par e-mail à donner votre avis après une prestation — intérêt légitime.",
          "Publier les avis que vous déposez, après modération par l'institut — votre consentement, que vous exprimez en déposant l'avis.",
          "Répondre à vos demandes de contact et à vos demandes de renseignements avant une réservation ou un achat — intérêt légitime et mesures précontractuelles.",
          "Vérifier votre éligibilité à l'offre de bienvenue, en comptant vos commandes et rendez-vous passés — intérêt légitime.",
          "Comptabiliser les rendez-vous non honorés et, après des absences répétées, bloquer la réservation en ligne — intérêt légitime (protéger le planning de l'institut). Vous pouvez contester cette mesure auprès de l'institut, qui peut la lever.",
          "Vous envoyer des e-mails commerciaux (nouveautés, offres), uniquement si vous avez coché la case prévue à cet effet, qui n'est jamais cochée par défaut — votre consentement, retirable à tout moment depuis votre espace client.",
          "Reprendre les fiches des clientes de l'ancien site de réservation de l'institut (Amelia, sur WordPress), importées en novembre 2026 : coordonnées (nom, prénom, adresse e-mail, téléphone) — intérêt légitime (assurer la continuité du service). Les personnes concernées peuvent s'y opposer et demander la suppression de leur fiche à tout moment.",
          "Traiter les données des participants à une formation de groupe et des bénéficiaires d'une carte cadeau, fournies par l'acheteur — exécution du contrat conclu avec l'acheteur.",
          "Assurer la sécurité du site et prévenir la fraude — intérêt légitime.",
        ),
      ],
    },
    {
      heading: 'Destinataires des données',
      blocks: [
        p("Vos données sont destinées à l'institut. Elles sont transmises, pour la stricte exécution de leurs missions, aux prestataires suivants :"),
        list(
          "{{host.legalName}} : hébergement du site sur un serveur situé dans l'Union européenne.",
          "MongoDB Inc. (MongoDB Atlas) : hébergement de la base de données, dans l'Union européenne (région de Paris).",
          "Stripe : traitement des paiements, remboursements et factures de paiement. Vos données de carte sont saisies directement chez Stripe.",
          "Brevo : envoi des e-mails liés à votre compte, à vos rendez-vous et à vos commandes. Brevo peut mesurer l'ouverture des e-mails et les clics sur leurs liens, afin d'assurer leur bonne délivrance.",
          "Streamable : hébergement des vidéos des formations en ligne et des bandes-annonces.",
          "{{developer.name}} : conception, maintenance technique et hébergement applicatif du site.",
        ),
        p("Aucune donnée n'est vendue ni cédée à des fins commerciales."),
      ],
    },
    {
      heading: 'Services tiers et contenus intégrés',
      blocks: [
        p("Certains contenus ne sont chargés depuis un service tiers qu'à votre demande. Votre navigateur s'adresse alors directement à ce service, qui reçoit votre adresse IP et les informations techniques que tout navigateur transmet."),
        list(
          "Vidéos (Streamable) : une vidéo de formation ou une bande-annonce n'est chargée que lorsque vous appuyez sur lecture.",
          "Carte (Google Maps) : la carte affichée en pied de page n'est chargée qu'après votre accord pour la catégorie « Contenus externes », ou lorsque vous cliquez pour l'afficher. Google peut alors déposer ses propres cookies.",
          "Instagram : le site propose un simple lien vers le compte de l'institut et affiche des publications de l'institut recopiées sur le site. Aucun traceur de Meta n'est chargé.",
        ),
        p("Les polices de caractères et les photos du site sont servies par le site lui-même : aucune requête n'est adressée à Google Fonts ni à une banque d'images."),
      ],
    },
    {
      heading: "Transferts hors de l'Union européenne",
      blocks: [
        p("Le site et sa base de données sont hébergés dans l'Union européenne. Certains prestataires — notamment Stripe, MongoDB Inc., Streamable et Google — sont des sociétés établies ou ayant des filiales hors de l'Union européenne et peuvent y traiter certaines données. Ces transferts sont encadrés par des garanties appropriées, en particulier les clauses contractuelles types de la Commission européenne."),
      ],
    },
    {
      heading: 'Durées de conservation',
      blocks: [
        list(
          "Compte client : conservé tant que le compte existe. Vous pouvez le supprimer à tout moment depuis votre espace client ; la suppression anonymise vos données, les factures étant conservées. Les données utilisées pour la prospection commerciale (e-mails commerciaux) sont conservées 3 ans après le dernier contact (achat, rendez-vous, message).",
          "Demandes de contact : supprimées automatiquement 3 ans après le dernier échange.",
          "Paniers non finalisés : supprimés après 6 mois sans activité.",
          "Journaux d'envoi des e-mails : supprimés après 13 mois.",
          "Factures et ventes : 10 ans.",
          "Choix relatif aux cookies : 6 mois.",
        ),
      ],
    },
    {
      heading: 'Cookies et traceurs',
      blocks: [
        p("Ce site n'utilise ni outil de mesure d'audience ni cookie publicitaire."),
        p("Il conserve dans votre navigateur, sans consentement car strictement nécessaires à son fonctionnement :"),
        list(
          "votre session de connexion à l'espace client (stockage local, 14 jours) ;",
          "votre panier, votre préférence d'affichage et une copie du catalogue public, pour accélérer l'affichage (stockage local) ;",
          "votre choix relatif aux cookies (6 mois) ;",
          "le fait que vous avez fermé le bandeau de bienvenue (stockage de session, effacé à la fermeture de l'onglet).",
        ),
        p("Une seule catégorie est soumise à votre consentement : « Contenus externes » (carte Google Maps). Elle est refusée par défaut. Le bandeau vous propose « Tout refuser » aussi visiblement que « Tout accepter », et vous pouvez modifier votre choix à tout moment avec le lien « Gérer les cookies » en pied de page."),
      ],
    },
    {
      heading: 'Vos droits',
      blocks: [
        p("Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité de vos données, du droit de retirer votre consentement à tout moment, ainsi que du droit de définir des directives sur leur sort après votre décès."),
        p('Depuis votre espace client, vous pouvez directement :'),
        list(
          'télécharger vos données (fichier JSON) ;',
          'accepter ou refuser les e-mails commerciaux ;',
          'supprimer votre compte (vos données sont anonymisées ; les factures sont conservées pour respecter nos obligations légales).',
        ),
        p('Vous pouvez aussi introduire une réclamation auprès de la CNIL (www.cnil.fr).'),
      ],
    },
    {
      heading: 'Exercer vos droits',
      blocks: [
        p('Pour exercer vos droits, écrivez-nous :'),
        fields(
          ['Adresse e-mail', '{{client.email}}'],
          ['Adresse postale', '{{client.address}}'],
        ),
        p("Une réponse vous est apportée dans un délai d'un mois."),
      ],
    },
    {
      heading: 'Sécurité',
      blocks: [
        p("Les échanges avec le site sont chiffrés (HTTPS), les mots de passe sont conservés sous forme hachée, les codes des cartes cadeaux sous forme hachée et chiffrée, et l'accès aux données est réservé aux personnes qui en ont besoin."),
      ],
    },
    {
      heading: 'Mise à jour de la présente politique',
      blocks: [
        p('Cette politique peut évoluer pour refléter les services proposés. La version en vigueur est celle publiée sur cette page.'),
        p('Version 4 du 22 novembre 2026.'),
      ],
    },
  ],
};

const TEMPLATE = {
  legalTemplateId: MELINAILS_PRIVACY_TEMPLATE_ID,
  type: LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY,
  name: 'MELI NAILS — Politique de confidentialité',
  description: "Institut de beauté MELI NAILS (melinails) : comptes, réservations, cartes cadeaux, formations, avis, absences, e-mails commerciaux sur consentement, reprise Amelia ; Stripe, Brevo, Streamable, Google Maps sur consentement.",
};

export async function migrateMeliNailsPrivacyV4({ apply = false, resync = false } = {}) {
  const rapport = { environnement: config.env, details: [], ids: {} };
  const { validateContent } = await import('../../services/legal/legalTemplate.validation.js');
  const contenu = validateContent(PRIVACY_V4_CONTENT);
  rapport.details.push(`Contenu validé : ${contenu.sections.length} sections.`);

  const projet = await PanelProject.findOne({ projectKey: PROJECT_KEY }).lean();
  if (!projet) throw new Error(`Projet « ${PROJECT_KEY} » absent du registre (${config.env}).`);
  rapport.ids.projectId = projet.projectId;
  rapport.details.push(`Projet ${PROJECT_KEY} (${projet.projectId}) : privacy actuelle = ${projet.privacyPolicyTemplateId}.`);

  /* ── 1. LE TEMPLATE DÉDIÉ ─────────────────────────────────────────────── */
  const existant = await PanelLegalTemplate.findOne({ legalTemplateId: TEMPLATE.legalTemplateId }).lean();
  if (existant) {
    if (existant.environment !== config.env) {
      throw new Error(`Template ${TEMPLATE.legalTemplateId} présent dans un autre monde (${existant.environment}).`);
    }
    rapport.details.push(`Template « ${existant.name} » déjà présent (v${existant.version}, ${existant.status}) — INTACT.`);
  } else {
    rapport.details.push(`Création + publication du template « ${TEMPLATE.name} » (${TEMPLATE.legalTemplateId}).`);
    if (apply) {
      const { publishTemplate } = await import('../../services/legal/legalTemplate.service.js');
      const { republishTemplate } = await import('../../services/legal/legalDocumentPublisher.js');
      const at = nowIso();
      await PanelLegalTemplate.create({
        ...TEMPLATE,
        content: contenu,
        status: LEGAL_TEMPLATE_STATUS.DRAFT,
        version: 0,
        publishedContent: null,
        environment: config.env,
        createdAt: at,
        updatedAt: at,
        createdBy: ACTOR.email,
        updatedBy: ACTOR.email,
      });
      // Aucun projet n'utilise encore ce template : la republication ne touche personne.
      const r = await publishTemplate(TEMPLATE.legalTemplateId, ACTOR, { republish: republishTemplate });
      rapport.details.push(`  → publié en v${r.version} (${r.recipients} projet(s) republié(s)).`);
    }
  }
  rapport.ids.legalTemplateId = TEMPLATE.legalTemplateId;

  /* ── 2. L'AFFECTATION DE MELINAILS, ET D'ELLE SEULE ───────────────────── */
  if (projet.privacyPolicyTemplateId === TEMPLATE.legalTemplateId) {
    rapport.details.push('melinails pointe déjà sur le template dédié.');
    if (resync) {
      rapport.details.push('Republication de PRIVACY_POLICY vers melinails (--resync).');
      if (apply) {
        const { publishDocument } = await import('../../services/legal/legalDocumentPublisher.js');
        const r = await publishDocument(projet.projectId, LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY);
        rapport.publication = r;
      }
    }
  } else if (projet.privacyPolicyTemplateId === PREVIOUS_TEMPLATE_ID) {
    rapport.details.push(`Bascule de melinails : ${PREVIOUS_TEMPLATE_ID} → ${TEMPLATE.legalTemplateId} (beautysavage et beautysavage-prod non touchés).`);
    if (apply) {
      const { assignProjectLegalDocuments } = await import('../../services/legal/legalAssignment.service.js');
      const r = await assignProjectLegalDocuments(
        projet.projectId,
        { privacyPolicyTemplateId: TEMPLATE.legalTemplateId },
        ACTOR,
      );
      rapport.publication = r.published?.PRIVACY_POLICY ?? null;
    }
  } else {
    rapport.details.push(`ATTENTION — affectation inattendue « ${projet.privacyPolicyTemplateId} » : laissée telle quelle.`);
  }
  return rapport;
}

async function main() {
  await connectDatabase();
  try {
    const r = await migrateMeliNailsPrivacyV4({ apply: APPLY, resync: RESYNC });
    logger.info(`\nMELI NAILS — PRIVACY v4 — ${APPLY ? 'ÉCRITURE' : 'SIMULATION'} (${r.environnement})`);
    for (const ligne of r.details) logger.info(`  · ${ligne}`);
    if (r.publication) logger.info(`Publication : ${JSON.stringify(r.publication)}`);
    logger.info(`Identifiants : ${JSON.stringify(r.ids)}`);
    logger.info(APPLY ? '\nTerminé.' : '\nAucune écriture. Relancez avec --apply.');
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && process.argv[1].endsWith('2026-11-22-meli-nails-privacy-v4.js')) {
  await main();
  setTimeout(() => process.exit(0), 200);
}
