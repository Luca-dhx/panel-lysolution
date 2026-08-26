// MIGRATION — les deux templates légaux du SITE L.Y SOLUTION.
//
//   npm run migrate:ly-legal
//   npm run migrate:ly-legal -- --dry-run
//
// ══ POURQUOI UN TEMPLATE DÉDIÉ, ET PAS LE STANDARD ══════════════════════════
//
// La question s'est posée dans cet ordre : le template « Site vitrine standard
// FR » convient-il au site de L.Y Solution ? Non — et pas pour une nuance de
// rédaction. Trois de ses affirmations sont FAUSSES sur ce site précis :
//
//   1. « Google Maps — la carte de localisation n'est chargée QUE sur la page
//      Contact. » Le site L.Y N'INTÈGRE AUCUNE CARTE : la page « Présenter un
//      projet » ne charge rien de Google au-delà des polices. Annoncer un
//      traitement qui n'existe pas est aussi inexact que d'en taire un.
//
//   2. « Google Ireland Limited et Google LLC, au titre des polices ET de la
//      carte » — même défaut, dans la liste des destinataires.
//
//   3. Mentions légales : « Les photographies de réalisations présentées sur ce
//      site illustrent des prestations réellement effectuées. » Le plan de site
//      de L.Y REFUSE explicitement toute section « nos réalisations » : il n'y a
//      aucune photographie de chantier à qualifier.
//
// S'y ajoute un traitement que le standard ne décrit pas, parce qu'aucune autre
// vitrine ne l'a : le formulaire de ce site collecte le NOM DE L'ENTREPRISE et
// son ACTIVITÉ, deux champs propres à une demande de conception. Une politique
// qui énumère les données collectées doit les nommer.
//
// Le standard reste juste pour les autres projets du parc : on ne le touche
// pas. C'est exactement l'usage prévu par le référentiel — « le jour où un
// projet activera un traitement différent, ce n'est PAS ce texte qu'il faudra
// tordre : c'est un second template qu'il faudra créer » (`legalSeed.js`).
//
// ══ CE QUI EST VÉRIFIÉ, ET COMMENT ══════════════════════════════════════════
//
// Chaque affirmation ci-dessous a été relue dans le code du projet `ly-solution`
// à la date de cette migration :
//
//   FORMULAIRE   `ContactSubmission` : nom, entreprise, activité (facultative),
//                e-mail, téléphone facultatif, nature du projet, description du
//                projet, page d'envoi, page d'origine, FAMILLE de navigateur et
//                langue. Le modèle documente qu'aucune IP, aucun cookie, aucun
//                jeton et aucune empreinte de navigateur ne sont enregistrés.
//   ANTI-ABUS    honeypot et délai de saisie. Aucun captcha tiers.
//   COOKIES      AUCUN. Le stockage local ne sert qu'à mémoriser la palette de
//                couleurs (`vitrine.theme.cache`). Ce site n'a pas de bandeau
//                promotionnel — le second usage du standard n'existe pas ici.
//   ANALYTICS    AUCUN.
//   POLICES      `fonts.googleapis.com` et `fonts.gstatic.com` (Manrope, Inter),
//                chargées par `index.html` et par `lib/theme.ts`.
//   CARTE        AUCUNE. Vérifié par `vitrine-responsive.test.js`, qui refuse
//                toute `<iframe>` et toute URL `google.com/maps` sur la page.
//   JOURNAUX     journalisation d'accès standard de l'infrastructure.
//   E-MAILS      prestataire de messagerie transactionnelle établi dans l'UE.
//   HÉBERGEMENT  serveur vérifié en France (Paris), opéré par Hostinger.
//
// ══ IDEMPOTENTE ET NON ÉCRASANTE ════════════════════════════════════════════
//
// Les templates ne sont créés que s'ils sont absents ; un template existant
// n'est jamais réécrit — son contenu est celui qu'un opérateur a pu amender
// dans l'éditeur. L'affectation au projet n'est posée que si le champ est VIDE.
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

/**
 * LA CLÉ DU PROJET DANS LE REGISTRE DU PANEL.
 *
 * Elle vaut `PROJECT_NAME` du `.env` de la copie, normalisée — pas le slug
 * technique. Les deux se ressemblent et ne sont pas la même chose : le slug
 * (`ly-solution`) préfixe les processus PM2 et les sauvegardes, la clé de
 * projet identifie la fiche côté Panel. Confondre les deux fait échouer
 * l'affectation en silence, sur un projet parfaitement déclaré.
 */
const PROJECT_KEY = 'ly-solution';

/** Identifiants STABLES : c'est eux qui rendent la migration idempotente. */
export const LY_TEMPLATE_IDS = Object.freeze({
  LEGAL_NOTICE: 'lt-ly-solution-legal-notice',
  PRIVACY_POLICY: 'lt-ly-solution-privacy-policy',
});

const p = (text) => ({ type: 'PARAGRAPH', text });
const list = (...items) => ({ type: 'LIST', items });
const fields = (...pairs) => ({
  type: 'FIELDS',
  fields: pairs.map(([label, value]) => ({ label, value })),
});

/* -------------------------------------------------------------------------- */
/*  MENTIONS LÉGALES                                                          */
/* -------------------------------------------------------------------------- */

/**
 * ══ L'ÉDITEUR ET LE CONCEPTEUR SONT LA MÊME ENTREPRISE ══════════════════════
 *
 * Sur tout autre projet du parc, « Éditeur du site » et « Conception et
 * réalisation » nomment deux sociétés différentes, et les deux blocs
 * d'identification se justifient. Ici, ils nommeraient DEUX FOIS la même —
 * mêmes SIREN, même adresse, même e-mail, à quelques lignes d'intervalle.
 *
 * Le second bloc est donc remplacé par une PHRASE, qui dit le fait au lieu de
 * le répéter en tableau. Les variables `{{developer.*}}` restent disponibles
 * pour qui voudra les rétablir ; elles ne sont simplement pas utilisées.
 */
const LEGAL_NOTICE_CONTENT = {
  title: 'Mentions légales',
  sections: [
    {
      heading: 'Éditeur du site',
      blocks: [
        p('Le présent site est édité par {{client.tradeName}}.'),
        fields(
          ['Raison sociale', '{{client.legalName}}'],
          ['Forme juridique', '{{client.legalForm}}'],
          ['Siège social', '{{client.address}}'],
          ['SIREN', '{{client.siren}}'],
          ['SIRET', '{{client.siret}}'],
          ['RCS', '{{client.registrationCity}}'],
          ['Capital social', '{{client.shareCapital}}'],
          ['TVA intracommunautaire', '{{client.vatNumber}}'],
        ),
      ],
    },
    {
      heading: 'Directeur de la publication',
      blocks: [p('Le directeur de la publication est {{client.publicationDirector}}.')],
    },
    {
      heading: 'Nous contacter',
      blocks: [
        p("Pour toute question relative à ce site, vous pouvez nous joindre par les moyens suivants, ou depuis la page « Présenter un projet »."),
        fields(
          ['Téléphone', '{{client.phone}}'],
          ['Adresse e-mail', '{{client.email}}'],
        ),
      ],
    },
    {
      heading: 'Conception et réalisation',
      blocks: [
        p("Ce site a été conçu, développé et est maintenu par l'entreprise qui l'édite. L'éditeur et le concepteur sont donc une seule et même société, identifiée ci-dessus."),
      ],
    },
    {
      heading: 'Hébergement',
      blocks: [
        p('Le site est hébergé par {{host.legalName}}.'),
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
      heading: 'Propriété intellectuelle',
      blocks: [
        p("L'ensemble des éléments composant ce site — textes, illustrations, logos, marques, éléments graphiques, mises en page et développements — est protégé par le droit de la propriété intellectuelle. Toute reproduction, représentation, adaptation ou exploitation, totale ou partielle, sur quelque support que ce soit, est interdite sans autorisation écrite préalable."),
        /**
         * LA PHRASE SUR LES PHOTOGRAPHIES DE RÉALISATIONS A DISPARU.
         *
         * Le template standard qualifie « les photographies de réalisations
         * présentées sur ce site ». Ce site n'en publie aucune, et n'en
         * publiera pas : le plan de site refuse explicitement toute section de
         * ce type. Une clause qui encadre un contenu inexistant n'est pas
         * inoffensive — elle laisse croire que le contenu existe.
         *
         * Ce qui la remplace décrit ce que ce site montre RÉELLEMENT : sa
         * propre conception.
         */
        p("Les créations présentées sur ce site relèvent de notre travail de conception. Les projets réalisés pour nos clients restent leur propriété, dans les conditions prévues au contrat qui nous lie à eux ; ils ne sont pas publiés ici."),
      ],
    },
    {
      heading: 'Responsabilité',
      blocks: [
        p("Les informations publiées sur ce site sont fournies à titre indicatif et sont susceptibles d'évoluer. Les prestations et les méthodes décrites ne constituent pas une offre contractuelle : seule une proposition acceptée engage les parties."),
        p("Le site peut comporter des liens vers des sites tiers. Ces sites ne sont pas sous notre contrôle, et leur contenu n'engage que leurs éditeurs respectifs."),
        p("Nous mettons en œuvre les moyens raisonnables pour assurer l'accessibilité du site, sans pouvoir garantir une disponibilité ininterrompue. Une interruption pour maintenance, mise à jour ou cause indépendante de notre volonté ne saurait engager notre responsabilité."),
      ],
    },
    {
      heading: 'Données personnelles',
      blocks: [
        p("Les traitements de données personnelles réalisés depuis ce site — notamment via le formulaire « Présenter un projet » — sont décrits dans la politique de confidentialité, accessible depuis le pied de page. Vous y trouverez la nature des données collectées, leurs finalités, leurs durées de conservation et les modalités d'exercice de vos droits."),
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/*  POLITIQUE DE CONFIDENTIALITÉ                                              */
/* -------------------------------------------------------------------------- */

const PRIVACY_POLICY_CONTENT = {
  title: 'Politique de confidentialité',
  sections: [
    {
      heading: 'Responsable du traitement',
      blocks: [
        p("{{client.tradeName}} est responsable des traitements de données personnelles réalisés depuis ce site."),
        fields(
          ['Raison sociale', '{{client.legalName}}'],
          ['Siège social', '{{client.address}}'],
          ['SIREN', '{{client.siren}}'],
          ['Téléphone', '{{client.phone}}'],
          ['Adresse e-mail', '{{client.email}}'],
        ),
      ],
    },
    {
      heading: 'Données collectées',
      blocks: [
        p("Nous ne collectons que les données nécessaires au traitement de votre demande. Concrètement :"),
        list(
          "Formulaire « Présenter un projet » : votre nom, le nom de votre entreprise, son activité si vous la renseignez, votre adresse e-mail, votre numéro de téléphone si vous le renseignez, la nature de votre projet et sa description.",
          "Contexte de la demande : la page depuis laquelle le formulaire a été envoyé, la page qui vous a amené sur le site, la famille de votre navigateur (par exemple « Chrome ») et la langue configurée sur votre appareil.",
          "Journaux techniques du serveur : adresse IP, date et heure, adresse demandée et identifiant du navigateur, enregistrés automatiquement par l'infrastructure d'hébergement.",
          "Échanges directs : lorsque vous nous appelez ou nous écrivez, les coordonnées et informations que vous nous transmettez à cette occasion.",
        ),
        p("Nous n'enregistrons ni votre adresse IP ni aucun identifiant de suivi au moment de l'envoi du formulaire, et la chaîne d'identification complète de votre navigateur n'est jamais conservée. La lutte contre les envois automatisés repose sur des contrôles techniques du formulaire lui-même, sans service tiers et sans profilage."),
      ],
    },
    {
      heading: 'Finalités et bases légales',
      blocks: [
        fields(
          ['Répondre à votre demande et étudier votre projet', "Exécution de mesures précontractuelles prises à votre demande, ou intérêt légitime à répondre à une sollicitation."],
          ['Assurer le suivi de la relation commerciale', "Exécution du contrat lorsqu'une prestation est engagée."],
          ['Garantir la sécurité et le bon fonctionnement du site', "Intérêt légitime à protéger le service contre les abus et les défaillances."],
          ['Respecter nos obligations légales', "Obligation légale, notamment en matière comptable et fiscale."],
        ),
      ],
    },
    {
      heading: 'Destinataires des données',
      blocks: [
        p("Vos données sont destinées aux seules personnes chargées de traiter votre demande. Elles ne sont ni vendues, ni louées, ni cédées à des tiers à des fins commerciales."),
        p("Interviennent également, dans la stricte limite de leur mission :"),
        list(
          "{{host.legalName}}, hébergeur du site, dont les serveurs utilisés pour ce site sont situés en France.",
          "Un prestataire de messagerie transactionnelle établi dans l'Union européenne, chargé de l'acheminement des e-mails de notification.",
          "Google Ireland Limited et Google LLC, au titre des seules polices de caractères du site — voir la section « Services tiers et contenus intégrés ».",
        ),
      ],
    },
    {
      /**
       * ══ CE QUE CETTE SECTION DIT, ET CE QU'ELLE NE DIT PLUS ══════════════
       *
       * Le template standard du parc décrit DEUX services Google : les polices
       * et la carte de la page « Contact ». Sur ce site, il n'y a pas de carte
       * — la page « Présenter un projet » n'intègre aucune `<iframe>`, et un
       * contrôle automatisé (`vitrine-responsive.test.js`) refuse qu'on en
       * ajoute une sans revenir ici.
       *
       * Conserver la mention aurait été une inexactitude de plus, dans l'autre
       * sens : annoncer un traitement qui n'a pas lieu apprend au lecteur que
       * le document est générique, donc qu'il ne dit rien de précis.
       *
       * Les polices, elles, sont bien chargées : `index.html` les précharge et
       * `lib/theme.ts` les demande à l'exécution. C'est le SEUL tiers.
       */
      heading: 'Services tiers et contenus intégrés',
      blocks: [
        p("Les polices de caractères de ce site — Manrope et Inter — sont fournies par Google Fonts. Votre navigateur les demande directement aux serveurs de Google, qui reçoivent alors votre adresse IP et les informations techniques que tout navigateur transmet lors d'une requête (type d'appareil, système, langue, page d'origine). Aucun cookie n'est déposé par ce service."),
        p("Le site n'intègre AUCUN autre service tiers : ni carte de localisation, ni mesure d'audience, ni pixel publicitaire, ni chat en ligne, ni captcha externe, ni plateforme de réservation."),
        p("Nous n'avons accès à aucune des données collectées par Google, et nous ne lui transmettons volontairement aucune information vous concernant. Son utilisation relève de sa propre politique de confidentialité."),
      ],
    },
    {
      heading: 'Cookies et stockage local',
      blocks: [
        p("Ce site ne dépose AUCUN cookie, et n'affiche donc aucun bandeau de consentement : il n'y a rien à consentir."),
        p("Il utilise le stockage local de votre navigateur pour un seul usage, strictement technique : mémoriser la palette de couleurs du site, afin que la page s'affiche aux bonnes couleurs dès le premier pixel de votre prochaine visite. Cette donnée ne quitte jamais votre appareil, ne sert à aucun suivi, et son effacement n'a d'autre effet qu'un très bref décalage de couleur au chargement suivant."),
      ],
    },
    {
      heading: 'Durées de conservation',
      blocks: [
        fields(
          ['Demandes sans suite', "Trois ans à compter du dernier échange."],
          ['Dossiers clients', "Durée de la relation commerciale, puis conservation au titre des obligations légales applicables."],
          ['Journaux techniques du serveur', "Durée courte, propre à l'exploitation du serveur, à des fins de sécurité et de diagnostic."],
        ),
      ],
    },
    {
      heading: "Transferts hors de l'Union européenne",
      blocks: [
        p("Les données que VOUS NOUS TRANSMETTEZ — formulaire, échanges directs — ne quittent pas l'Union européenne : les serveurs utilisés pour ce site sont situés en France, et le prestataire de messagerie est établi dans l'Union européenne."),
        p("Le service de polices de caractères décrit plus haut est opéré par Google, dont l'entité européenne est Google Ireland Limited. Il est susceptible de transférer certaines données techniques, dont votre adresse IP, vers des serveurs situés en dehors de l'Union européenne. Ces transferts relèvent des garanties mises en place par Google, notamment les clauses contractuelles types de la Commission européenne, et nous n'en sommes pas responsables."),
        p("Si vous souhaitez éviter ces requêtes, la plupart des navigateurs et extensions de blocage permettent de s'y opposer ; le site reste consultable, avec des polices de substitution."),
      ],
    },
    {
      heading: 'Sécurité',
      blocks: [
        p("Le site est servi exclusivement en HTTPS. Les demandes reçues sont stockées sur une infrastructure dont l'accès est restreint aux personnes qui en ont l'usage, et protégé par authentification."),
      ],
    },
    {
      heading: 'Vos droits',
      blocks: [
        p("Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation et d'opposition sur vos données, ainsi que d'un droit à la portabilité. Vous pouvez également définir des directives relatives à leur sort après votre décès."),
        p("Pour les exercer, écrivez-nous à {{client.email}}, en précisant votre demande. Nous pouvons être amenés à vous demander un justificatif d'identité si un doute subsiste sur la personne à l'origine de la demande."),
        p("Si vous estimez, après nous avoir contactés, que vos droits ne sont pas respectés, vous pouvez adresser une réclamation à la Commission nationale de l'informatique et des libertés (CNIL), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07 — www.cnil.fr."),
      ],
    },
    {
      heading: 'Évolution de cette politique',
      blocks: [
        p("Cette politique peut être mise à jour pour refléter une évolution du site ou de la réglementation. La version en vigueur est celle publiée sur cette page."),
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */

const TEMPLATES = [
  {
    legalTemplateId: LY_TEMPLATE_IDS.LEGAL_NOTICE,
    type: LEGAL_DOCUMENT_TYPES.LEGAL_NOTICE,
    name: 'Mentions légales — L.Y Solution',
    description:
      "Mentions légales du site L.Y Solution. Éditeur et concepteur confondus ; aucune clause "
      + 'sur des photographies de réalisations, ce site n’en publie pas.',
    content: LEGAL_NOTICE_CONTENT,
    assignmentField: 'legalNoticeTemplateId',
  },
  {
    legalTemplateId: LY_TEMPLATE_IDS.PRIVACY_POLICY,
    type: LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY,
    name: 'Politique de confidentialité — L.Y Solution',
    description:
      'Politique de confidentialité du site L.Y Solution. Décrit les champs entreprise et '
      + 'activité du formulaire, et ne mentionne AUCUNE carte : ce site n’en charge pas.',
    content: PRIVACY_POLICY_CONTENT,
    assignmentField: 'privacyPolicyTemplateId',
  },
];

export async function migrateLySolutionLegal({ dryRun = false } = {}) {
  const rapport = { environnement: config.env, details: [], crees: [], affectes: [] };

  const { validateContent } = await import('../../services/legal/legalTemplate.validation.js');
  const { publishTemplate } = await import('../../services/legal/legalTemplate.service.js');
  const { republishTemplate } = await import('../../services/legal/legalDocumentPublisher.js');

  /* ── 1. LES TEMPLATES ──────────────────────────────────────────────────── */
  for (const modele of TEMPLATES) {
    const existant = await PanelLegalTemplate.findOne({
      legalTemplateId: modele.legalTemplateId,
      environment: config.env,
    }).lean();

    if (existant) {
      rapport.details.push(`Template « ${modele.name} » déjà présent (v${existant.version}) — INTACT.`);
      continue;
    }

    /**
     * LE CONTENU EST VALIDÉ AVANT D'ÊTRE ÉCRIT, pas après.
     *
     * `validateContent` est la même fonction que celle de l'éditeur : une
     * variable inconnue, un bloc hors vocabulaire ou une section trop longue
     * fait échouer la migration ici, sur un message précis — au lieu de
     * produire un document qui affiche `{{client.siret` sur une page publique.
     */
    const contenu = validateContent(modele.content);

    rapport.details.push(`Création du template « ${modele.name} » (${modele.type}).`);
    rapport.crees.push(modele.legalTemplateId);
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
      createdBy: 'migration:ly-legal',
      updatedBy: 'migration:ly-legal',
    });

    /**
     * PUBLIÉ DANS LA FOULÉE — et c'est la seule exception à la règle du
     * brouillon.
     *
     * `createTemplate` laisse volontairement un template en brouillon : un
     * formulaire à moitié rempli ne doit pas devenir assignable d'un clic.
     * Ici, le contenu n'est pas à moitié rempli — il est écrit, relu et
     * versionné avec le dépôt. Le laisser en brouillon obligerait à un clic
     * manuel dont l'oubli se verrait sur le site, en 404 au pied de page.
     */
    await publishTemplate(modele.legalTemplateId, { email: 'migration:ly-legal' }, {
      republish: republishTemplate,
    });
    rapport.details.push(`  → publié en v1.`);
  }

  /* ── 2. L'AFFECTATION AU PROJET ────────────────────────────────────────── */
  const projet = await PanelProject.findOne({ projectKey: PROJECT_KEY }).lean();
  if (!projet) {
    /**
     * LE PROJET PEUT NE PAS ENCORE EXISTER — et ce n'est PAS une erreur.
     *
     * L'ordre de fabrication déclare le projet au Panel avant de l'appairer.
     * Cette migration peut parfaitement tourner avant : les templates sont
     * alors créés et publiés, prêts à être affectés. On la rejoue après la
     * déclaration, et l'affectation se pose.
     */
    rapport.details.push(
      `Projet « ${PROJECT_KEY} » absent du registre — templates prêts, affectation reportée. `
      + 'Déclarez le projet, puis rejouez cette migration.',
    );
    return rapport;
  }

  const patch = {};
  for (const modele of TEMPLATES) {
    const actuel = projet[modele.assignmentField];
    if (actuel === modele.legalTemplateId) {
      rapport.details.push(`${modele.type} : déjà affecté au template L.Y.`);
    } else if (actuel) {
      rapport.details.push(
        `ATTENTION — ${modele.type} : déjà affecté à « ${actuel} », laissé tel quel. `
        + 'Changez-le depuis la fiche projet si c’est voulu.',
      );
    } else {
      patch[modele.assignmentField] = modele.legalTemplateId;
      rapport.affectes.push(modele.type);
      rapport.details.push(`${modele.type} : affectation au template L.Y.`);
    }
  }

  if (Object.keys(patch).length > 0 && !dryRun) {
    await PanelProject.updateOne(
      { projectId: projet.projectId },
      { $set: { ...patch, updatedAt: nowIso() } },
    );
    const { resyncProjectLegalDocuments } = await import(
      '../../services/legal/legalAssignment.service.js'
    );
    /**
     * LA REPUBLICATION EST TOUJOURS REJOUÉE, même si rien n'a changé ici :
     * c'est elle qui rattrape un projet resté hors ligne au moment de
     * l'affectation. Une affectation posée en base et jamais poussée donne un
     * pied de page sans liens légaux, sans que rien ne le signale.
     */
    await resyncProjectLegalDocuments(projet.projectId).catch((err) => {
      rapport.details.push(`Republication différée : ${err.message}`);
    });
  }

  return rapport;
}

/* -------------------------------------------------------------------------- */

async function main() {
  await connectDatabase();
  try {
    const rapport = await migrateLySolutionLegal({ dryRun: DRY_RUN });
    logger.info(`\nMIGRATION LÉGALE L.Y SOLUTION — ${DRY_RUN ? 'SIMULATION' : 'ÉCRITURE'} (${rapport.environnement})`);
    for (const ligne of rapport.details) logger.info(`  · ${ligne}`);
    logger.info(DRY_RUN ? '\nAucune écriture. Relancez sans --dry-run.' : '\nTerminé.');
  } finally {
    await disconnectDatabase();
  }
}

/**
 * Exécuté seulement en ligne de commande — le module reste importable par un
 * test sans déclencher de connexion à la base.
 */
if (process.argv[1] && process.argv[1].endsWith('2026-08-26-ly-solution-legal-templates.js')) {
  await main();
}
