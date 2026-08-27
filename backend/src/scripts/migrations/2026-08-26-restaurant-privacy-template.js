// MIGRATION — le template de POLITIQUE DE CONFIDENTIALITÉ des restaurants.
//
//   npm run migrate:restaurant-privacy
//   npm run migrate:restaurant-privacy -- --dry-run
//   npm run migrate:restaurant-privacy -- --project <clé de projet>
//
// ══ POURQUOI UN TEMPLATE DÉDIÉ, ET PAS « SITE VITRINE STANDARD FR » ═════════
//
// La question s'est posée dans cet ordre : le standard convient-il au site
// d'un restaurant ? Non — et pas pour une nuance de rédaction. Il TAIT deux
// traitements qu'un restaurant réalise réellement, et l'un des deux porte sur
// des données de santé.
//
//   1. LA RÉSERVATION PAR WHATSAPP. La fiche d'identité du premier restaurant
//      du parc ne donne qu'UN lien de réservation, et c'est un lien `wa.me`
//      avec un message pré-rempli. Le bouton « Réserver une table » quitte donc
//      le site pour une messagerie exploitée par Meta, et la conversation —
//      nom, numéro, date, nombre de couverts — se déroule chez un tiers.
//      Le standard ne mentionne Meta nulle part : il décrit un site dont le
//      seul canal écrit est le formulaire de contact.
//
//   2. LES ALLERGIES ALIMENTAIRES. C'est la raison DÉCISIVE. Un client qui
//      réserve écrit « attention, allergie aux fruits à coque » — c'est une
//      donnée concernant la SANTÉ, catégorie particulière au sens de
//      l'article 9 du RGPD. Son traitement n'est licite que par consentement
//      explicite, et une politique de confidentialité qui ne la nomme pas
//      décrit un traitement qui n'est pas celui qui a lieu.
//
//      Aucun autre métier du parc ne rencontre ce cas : un garage, un circuit
//      de karting et une entreprise de nettoyage ne collectent jamais de
//      donnée de santé par un formulaire de réservation. C'est exactement
//      l'usage prévu par le référentiel — « le jour où un projet activera un
//      traitement différent, ce n'est PAS ce texte qu'il faudra tordre : c'est
//      un second template qu'il faudra créer » (`legalSeed.js`).
//
// Le reste du standard est JUSTE pour un restaurant, et il est repris tel
// quel : formulaire de contact, journaux serveur, absence de cookie, absence
// de mesure d'audience, polices Google, carte Google Maps sur la page contact,
// durées de conservation, droits et voies de recours.
//
// ══ CE QUI EST VÉRIFIÉ, ET COMMENT ══════════════════════════════════════════
//
// Chaque affirmation ci-dessous a été relue dans le code du projet
// `l-aile-ou-la-cuisse` à la date de cette migration :
//
//   FORMULAIRE   `ContactSubmission` : nom, e-mail, téléphone facultatif,
//                motif, message, page d'envoi, page d'origine, FAMILLE de
//                navigateur et langue. Aucune IP, aucun cookie, aucun jeton,
//                aucune empreinte de navigateur.
//   ANTI-ABUS    honeypot et délai de saisie. Aucun captcha tiers.
//   WHATSAPP     lien `wa.me` porté par la fiche entreprise (canal `whatsapp`
//                du `MEDIA_CATALOG`), rendu par le bouton d'appel à l'action.
//   COOKIES      AUCUN déposé par le site. Stockage local : la palette de
//                couleurs, et l'état d'une bannière promotionnelle refermée.
//   ANALYTICS    AUCUN.
//   POLICES      `fonts.googleapis.com` et `fonts.gstatic.com`.
//   CARTE        Google Maps, sur la page « Contact » uniquement.
//   ALLERGÈNES   `Plat.allergens` publie la liste PAR PLAT, en sortie. C'est
//                une donnée du restaurant, pas du visiteur — elle ne collecte
//                rien. Ce que le template décrit, c'est l'ENTRANT : ce qu'un
//                client nous dit de lui en réservant.
//
// ══ IDEMPOTENTE ET NON ÉCRASANTE ════════════════════════════════════════════
//
// Le template n'est créé que s'il est absent ; un template existant n'est
// jamais réécrit — son contenu est celui qu'un opérateur a pu amender dans
// l'éditeur. L'affectation au projet n'est posée que si le champ est VIDE.
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
const argOf = (nom) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i === -1 ? null : process.argv[i + 1];
};

/**
 * LA CLÉ DU PROJET DANS LE REGISTRE DU PANEL.
 *
 * Elle vaut `PROJECT_NAME` du `.env` de la copie, normalisée — pas le slug
 * technique. Les deux se ressemblent et ne sont pas la même chose : le slug
 * (`aile-ou-la-cuisse`) préfixe les processus PM2 et les sauvegardes, la clé
 * de registre (`l-aile-ou-la-cuisse`) vient du nom d'enseigne.
 *
 * Le template, lui, n'appartient à aucun projet : il est écrit pour le MÉTIER,
 * et le prochain restaurant du parc l'affectera sans rien réécrire. D'où
 * `--project`, qui permet de le poser sur une autre fiche.
 */
const PROJECT_KEY_DEFAUT = 'l-aile-ou-la-cuisse';

/** Identifiant STABLE : c'est lui qui rend la migration idempotente. */
export const RESTAURANT_TEMPLATE_ID = 'lt-restaurant-privacy-policy-fr';

const p = (text) => ({ type: 'PARAGRAPH', text });
const list = (...items) => ({ type: 'LIST', items });
const fields = (...pairs) => ({
  type: 'FIELDS',
  fields: pairs.map(([label, value]) => ({ label, value })),
});

/* -------------------------------------------------------------------------- */
/*  POLITIQUE DE CONFIDENTIALITÉ — RESTAURANT                                 */
/* -------------------------------------------------------------------------- */

const PRIVACY_POLICY_CONTENT = {
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
      ],
    },
    {
      heading: 'Données collectées',
      blocks: [
        p('Nous ne collectons que les données nécessaires au traitement de votre demande et à la préparation de votre venue. Concrètement :'),
        list(
          'Formulaire de contact : votre nom, votre adresse e-mail, votre numéro de téléphone si vous le renseignez, le motif de votre demande et le contenu de votre message.',
          'Réservation de table : lorsque vous nous écrivez sur WhatsApp ou que vous nous appelez, les informations que vous nous transmettez à cette occasion — nom, numéro de téléphone, date et heure souhaitées, nombre de convives, et toute précision que vous jugez utile.',
          'Contexte de la demande : la page depuis laquelle le formulaire a été envoyé, la page qui vous a amené sur le site, la famille de votre navigateur (par exemple « Chrome ») et la langue configurée sur votre appareil.',
          'Journaux techniques du serveur : adresse IP, date et heure, adresse demandée et identifiant du navigateur, enregistrés automatiquement par l’infrastructure d’hébergement.',
        ),
        p('Nous n’enregistrons ni votre adresse IP ni aucun identifiant de suivi au moment de l’envoi du formulaire, et la chaîne d’identification complète de votre navigateur n’est jamais conservée. La lutte contre les envois automatisés repose sur des contrôles techniques du formulaire lui-même, sans service tiers et sans profilage.'),
      ],
    },
    {
      /**
       * ══ LA SECTION QUI JUSTIFIE CE TEMPLATE ═════════════════════════════
       *
       * Une allergie alimentaire est une donnée concernant la SANTÉ, au sens
       * de l'article 9 du RGPD. La taire dans une politique de
       * confidentialité de restaurant reviendrait à décrire un traitement qui
       * n'est pas celui qui a lieu — et à priver la personne concernée de
       * l'information qui lui permet d'en décider.
       *
       * La base légale est le CONSENTEMENT EXPLICITE, et il ne se présume
       * pas : c'est le client qui choisit de nous le dire, pour être servi en
       * sécurité. La section dit donc aussi ce que nous n'en faisons PAS.
       */
      heading: 'Allergies et régimes alimentaires',
      blocks: [
        p('Si vous nous signalez une allergie, une intolérance ou un régime alimentaire particulier — en réservant, ou en salle au moment de la commande — cette information concerne votre santé. Le règlement européen la range parmi les catégories particulières de données, et lui applique une protection renforcée.'),
        p('Nous la traitons sur la base de votre consentement explicite, c’est-à-dire du fait que vous choisissez de nous la communiquer pour être servi en sécurité. Vous n’y êtes jamais obligé, et un refus ne vous prive d’aucun service — il nous prive seulement du moyen d’adapter votre plat.'),
        list(
          'Elle n’est transmise qu’aux personnes qui préparent et servent votre repas.',
          'Elle n’est ni conservée après votre venue, ni rattachée à un historique de client, ni utilisée à des fins commerciales.',
          'Elle n’est jamais partagée avec un tiers, ni exploitée pour établir un profil.',
        ),
        p('La liste des allergènes présents dans nos préparations est par ailleurs tenue à votre disposition à l’accueil du restaurant, et certaines fiches de la carte de ce site les indiquent. Cette information-là vient de nous, et ne collecte rien.'),
      ],
    },
    {
      heading: 'Finalités et bases légales',
      blocks: [
        fields(
          ['Répondre à vos demandes et enregistrer une réservation', 'Exécution de mesures précontractuelles prises à votre demande, ou intérêt légitime à répondre à une sollicitation.'],
          ['Adapter un plat à une allergie ou à un régime signalé', 'Consentement explicite, au sens de l’article 9.2.a du RGPD.'],
          ['Assurer le service et le suivi de votre venue', 'Exécution du contrat lorsqu’une prestation est engagée.'],
          ['Garantir la sécurité et le bon fonctionnement du site', 'Intérêt légitime à protéger le service contre les abus et les défaillances.'],
          ['Respecter nos obligations légales', 'Obligation légale, notamment en matière comptable, fiscale et d’hygiène alimentaire.'],
        ),
      ],
    },
    {
      heading: 'Destinataires des données',
      blocks: [
        p('Vos données sont destinées aux seules personnes chargées de traiter votre demande et de vous accueillir. Elles ne sont ni vendues, ni louées, ni cédées à des tiers à des fins commerciales.'),
        p('Interviennent également, dans la stricte limite de leur mission :'),
        list(
          '{{host.legalName}}, hébergeur du site, dont les serveurs utilisés pour ce site sont situés en France.',
          'Un prestataire de messagerie transactionnelle établi dans l’Union européenne, chargé de l’acheminement des e-mails de notification.',
          '{{developer.name}}, qui assure la conception et la maintenance technique du site et peut, à ce titre, accéder aux données lors d’une intervention.',
          'WhatsApp Ireland Limited et Meta Platforms, lorsque VOUS choisissez de nous écrire sur WhatsApp — voir la section « Réservation par WhatsApp ».',
          'Google Ireland Limited et Google LLC, au titre des polices de caractères et de la carte de localisation intégrées au site — voir la section « Services tiers et contenus intégrés ».',
        ),
      ],
    },
    {
      /**
       * ══ LE SECOND TRAITEMENT QUE LE STANDARD NE DÉCRIT PAS ══════════════
       *
       * Le bouton « Réserver une table » n'ouvre pas un formulaire : il ouvre
       * WhatsApp, avec un message pré-rempli. Trois conséquences que le
       * visiteur a le droit de connaître avant de cliquer — la conversation
       * quitte le site, elle est régie par la politique de Meta, et le
       * restaurant y voit son numéro.
       */
      heading: 'Réservation par WhatsApp',
      blocks: [
        p('Le bouton de réservation de ce site ouvre une conversation WhatsApp avec le restaurant, avec un message d’introduction pré-rempli. Ce n’est pas un formulaire : la conversation a lieu dans l’application WhatsApp, et non sur ce site.'),
        list(
          'En cliquant, vous quittez ce site : nous ne collectons rien à cet instant, et nous ne savons pas que vous avez cliqué.',
          'La conversation, votre numéro de téléphone et votre profil WhatsApp sont traités par WhatsApp Ireland Limited (groupe Meta), selon SA politique de confidentialité, sur laquelle nous n’avons aucune prise.',
          'De notre côté, nous voyons votre numéro et le contenu de vos messages, comme pour un appel ou un SMS. Nous les conservons le temps de préparer votre venue, puis le fil est effacé.',
        ),
        p('Vous n’êtes jamais obligé de passer par WhatsApp : le téléphone et le formulaire de contact de ce site permettent exactement la même demande, sans qu’aucune donnée ne transite par un service tiers.'),
      ],
    },
    {
      heading: 'Durées de conservation',
      blocks: [
        fields(
          ['Demandes de contact sans suite', 'Trois ans à compter du dernier échange.'],
          ['Conversations de réservation', 'Le temps de préparer et d’honorer votre venue, puis effacées.'],
          ['Allergies et régimes signalés', 'Le temps du service. Rien n’est conservé après votre repas.'],
          ['Obligations comptables et fiscales', 'Durées légales de conservation applicables aux pièces concernées.'],
          ['Journaux techniques du serveur', 'Durée courte, propre à l’exploitation du serveur, à des fins de sécurité et de diagnostic.'],
        ),
      ],
    },
    {
      heading: 'Services tiers et contenus intégrés',
      blocks: [
        p('Certaines ressources affichées sur ce site sont fournies par des tiers. Votre navigateur les demande directement à ces tiers, qui reçoivent alors votre adresse IP.'),
        list(
          'Google Fonts — les polices de caractères du site sont chargées depuis les serveurs de Google à chaque visite.',
          'Google Maps — la carte de localisation n’est chargée QUE sur la page « Contact », et uniquement lorsque vous l’ouvrez.',
          'WhatsApp — aucun contenu n’est chargé depuis WhatsApp. Le bouton de réservation est un simple lien : rien n’est demandé à Meta tant que vous ne cliquez pas.',
        ),
        p('Nous n’avons accès à aucune des données collectées par ces services, et nous ne leur transmettons volontairement aucune information vous concernant.'),
        p('Le site n’intègre aucun autre service tiers : ni mesure d’audience, ni pixel publicitaire, ni chat en ligne, ni bouton de partage social.'),
      ],
    },
    {
      heading: 'Transferts hors de l’Union européenne',
      blocks: [
        p('Les données que VOUS NOUS TRANSMETTEZ par le formulaire de contact ou par téléphone ne quittent pas l’Union européenne : les serveurs utilisés pour ce site sont situés en France, et le prestataire de messagerie est établi dans l’Union européenne.'),
        p('Les services tiers décrits plus haut — polices de caractères, carte de localisation — sont opérés par Google, dont l’entité européenne est Google Ireland Limited. WhatsApp est opéré par WhatsApp Ireland Limited, du groupe Meta. Ces sociétés sont susceptibles de transférer certaines données techniques, dont votre adresse IP, vers des serveurs situés en dehors de l’Union européenne. Ces transferts relèvent des garanties qu’elles ont mises en place, notamment les clauses contractuelles types de la Commission européenne, et nous n’en sommes pas responsables.'),
        p('Si vous souhaitez éviter ces requêtes, la plupart des navigateurs et extensions de blocage permettent de s’y opposer, et le téléphone reste disponible pour toute réservation ; le site demeure consultable, avec des polices de substitution.'),
      ],
    },
    {
      heading: 'Cookies et traceurs',
      blocks: [
        p('Ce site ne dépose lui-même AUCUN cookie : ni cookie publicitaire, ni cookie de mesure d’audience, ni traceur. Aucun bandeau de consentement n’est donc nécessaire.'),
        p('La seule exception ne vient pas de nous : la carte de localisation intégrée à la page « Contact » est chargée depuis Google, qui peut y déposer ses propres cookies. Elle ne se charge que si vous ouvrez cette page.'),
        p('Le site conserve deux informations dans le stockage local de votre navigateur, pour des raisons strictement techniques : la palette de couleurs du site, afin d’éviter un clignotement au chargement, et le fait qu’une bannière d’information ait été refermée, afin de ne pas vous la remontrer. Ces informations ne quittent jamais votre appareil et ne permettent de vous identifier d’aucune manière.'),
      ],
    },
    {
      heading: 'Vos droits',
      blocks: [
        p('Conformément au Règlement général sur la protection des données et à la loi « Informatique et Libertés », vous disposez des droits suivants :'),
        list(
          'Droit d’accès : obtenir la confirmation que vos données sont traitées et en recevoir une copie.',
          'Droit de rectification : faire corriger une donnée inexacte ou incomplète.',
          'Droit à l’effacement : demander la suppression de vos données, dans les limites de nos obligations légales de conservation.',
          'Droit à la limitation du traitement : demander le gel d’un traitement contesté.',
          'Droit d’opposition : vous opposer à un traitement fondé sur notre intérêt légitime.',
          'Droit de retirer votre consentement à tout moment, notamment pour une allergie signalée — sans que cela remette en cause ce qui a été fait avant.',
          'Droit à la portabilité : recevoir vos données dans un format structuré et lisible par machine.',
        ),
      ],
    },
    {
      heading: 'Exercer vos droits',
      blocks: [
        p('Vous pouvez exercer ces droits en nous contactant par l’un des moyens indiqués ci-dessous, ou depuis la page « Contact » du site.'),
        fields(
          ['Téléphone', '{{client.phone}}'],
          ['Adresse e-mail', '{{client.email}}'],
          ['Adresse postale', '{{client.address}}'],
        ),
        p('Si vous estimez, après nous avoir contactés, que vos droits ne sont pas respectés, vous pouvez introduire une réclamation auprès de la Commission nationale de l’informatique et des libertés (CNIL), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07 — www.cnil.fr.'),
      ],
    },
    {
      heading: 'Sécurité',
      blocks: [
        p('Les échanges avec ce site sont chiffrés par le protocole HTTPS. L’accès aux demandes reçues est réservé aux personnes qui en ont l’usage, et protégé par authentification.'),
      ],
    },
    {
      heading: 'Mise à jour de la présente politique',
      blocks: [
        p('Cette politique peut être modifiée pour tenir compte d’une évolution du site, des traitements réalisés ou de la réglementation. La version en vigueur est celle publiée sur cette page.'),
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */

const MODELE = {
  legalTemplateId: RESTAURANT_TEMPLATE_ID,
  type: LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY,
  name: 'Politique de confidentialité — Restaurant FR',
  description:
    'Le standard FR, complété pour un restaurant : réservation par WhatsApp (Meta) et '
    + 'ALLERGIES ALIMENTAIRES — une donnée de santé au sens de l’article 9 du RGPD, qu’aucun '
    + 'autre métier du parc ne collecte.',
  content: PRIVACY_POLICY_CONTENT,
  assignmentField: 'privacyPolicyTemplateId',
};

export async function migrateRestaurantPrivacy({ dryRun = false, projectKey = PROJECT_KEY_DEFAUT } = {}) {
  const rapport = { environnement: config.env, details: [], crees: [], affectes: [] };

  const { validateContent } = await import('../../services/legal/legalTemplate.validation.js');
  const { publishTemplate } = await import('../../services/legal/legalTemplate.service.js');
  const { republishTemplate } = await import('../../services/legal/legalDocumentPublisher.js');

  /* ── 1. LE TEMPLATE ────────────────────────────────────────────────────── */
  const existant = await PanelLegalTemplate.findOne({
    legalTemplateId: MODELE.legalTemplateId,
    environment: config.env,
  }).lean();

  if (existant) {
    rapport.details.push(`Template « ${MODELE.name} » déjà présent (v${existant.version}) — INTACT.`);
  } else {
    /**
     * LE CONTENU EST VALIDÉ AVANT D'ÊTRE ÉCRIT, pas après.
     *
     * `validateContent` est la même fonction que celle de l'éditeur : une
     * variable inconnue, un bloc hors vocabulaire ou une section trop longue
     * fait échouer la migration ici, sur un message précis — au lieu de
     * produire un document qui affiche `{{client.siret` sur une page publique.
     */
    const contenu = validateContent(MODELE.content);
    rapport.details.push(`Création du template « ${MODELE.name} » (${MODELE.type}).`);
    rapport.crees.push(MODELE.legalTemplateId);

    if (!dryRun) {
      const at = nowIso();
      await PanelLegalTemplate.create({
        legalTemplateId: MODELE.legalTemplateId,
        name: MODELE.name,
        type: MODELE.type,
        description: MODELE.description,
        content: contenu,
        status: LEGAL_TEMPLATE_STATUS.DRAFT,
        version: 0,
        publishedContent: null,
        environment: config.env,
        createdAt: at,
        updatedAt: at,
        createdBy: 'migration:restaurant-privacy',
        updatedBy: 'migration:restaurant-privacy',
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
      await publishTemplate(MODELE.legalTemplateId, { email: 'migration:restaurant-privacy' }, {
        republish: republishTemplate,
      });
      rapport.details.push('  → publié en v1.');
    }
  }

  /* ── 2. L'AFFECTATION AU PROJET ────────────────────────────────────────── */
  const projet = await PanelProject.findOne({ projectKey }).lean();
  if (!projet) {
    /**
     * LE PROJET PEUT NE PAS ENCORE EXISTER — et ce n'est PAS une erreur.
     *
     * L'ordre de fabrication déclare le projet au Panel avant de l'appairer.
     * Cette migration peut parfaitement tourner avant : le template est alors
     * créé et publié, prêt à être affecté. On la rejoue après la déclaration,
     * et l'affectation se pose.
     */
    rapport.details.push(
      `Projet « ${projectKey} » absent du registre — template prêt, affectation reportée. `
      + 'Déclarez le projet, puis rejouez cette migration.',
    );
    return rapport;
  }

  const actuel = projet[MODELE.assignmentField];
  if (actuel === MODELE.legalTemplateId) {
    rapport.details.push(`${MODELE.type} : déjà affecté au template restaurant.`);
  } else if (actuel) {
    rapport.details.push(
      `ATTENTION — ${MODELE.type} : déjà affecté à « ${actuel} », laissé tel quel. `
      + 'Changez-le depuis la fiche projet si c’est voulu.',
    );
  } else if (!dryRun) {
    await PanelProject.updateOne(
      { projectId: projet.projectId },
      { $set: { [MODELE.assignmentField]: MODELE.legalTemplateId, updatedAt: nowIso() } },
    );
    rapport.affectes.push(MODELE.type);
    rapport.details.push(`${MODELE.type} : affecté au template restaurant.`);

    const { resyncProjectLegalDocuments } = await import(
      '../../services/legal/legalAssignment.service.js'
    );
    /**
     * LA REPUBLICATION EST TOUJOURS REJOUÉE : c'est elle qui rattrape un
     * projet resté hors ligne au moment de l'affectation. Une affectation
     * posée en base et jamais poussée donne un pied de page sans liens
     * légaux, sans que rien ne le signale.
     *
     * Elle ÉCHOUE tant que le projet n'a pas d'entreprise cliente renseignée,
     * et c'est correct : le document cite une raison sociale, un SIREN et une
     * adresse. Publier un document légal à trous serait pire que ne rien
     * publier — on le DIT, on ne le contourne pas.
     */
    await resyncProjectLegalDocuments(projet.projectId).catch((err) => {
      rapport.details.push(`Republication différée : ${err.message}`);
    });
  } else {
    rapport.details.push(`${MODELE.type} : affectation au template restaurant (simulation).`);
  }

  return rapport;
}

/* -------------------------------------------------------------------------- */

async function main() {
  await connectDatabase();
  try {
    const rapport = await migrateRestaurantPrivacy({
      dryRun: DRY_RUN,
      projectKey: argOf('project') || PROJECT_KEY_DEFAUT,
    });
    logger.info(`\nMIGRATION LÉGALE RESTAURANT — ${DRY_RUN ? 'SIMULATION' : 'ÉCRITURE'} (${rapport.environnement})`);
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
if (process.argv[1] && process.argv[1].endsWith('2026-08-26-restaurant-privacy-template.js')) {
  await main();
}
