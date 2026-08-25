// L'AMORÇAGE DU SOCLE LÉGAL — hébergeur et deux templates initiaux.
//
// ══ SEED = CRÉER SI ABSENT. JAMAIS ÉCRASER. ═════════════════════════════════
//
// C'est la règle la plus importante de ce fichier, et la plus facile à
// enfreindre par distraction. Une fois qu'un opérateur a corrigé une fiche
// d'hébergeur ou réécrit un paragraphe de mentions légales, un redémarrage du
// backend NE DOIT PAS reposer les valeurs d'origine. Un seed qui écrase à
// chaque démarrage n'est pas un seed : c'est une réinitialisation périodique du
// travail des humains, et elle est d'autant plus vicieuse qu'elle ne laisse
// aucune trace — le contenu réapparaît « tout seul ».
//
// Chaque bloc ci-dessous commence donc par une existence, et sort si elle est
// vraie. Rejouer ce module dix fois ne produit rien de plus qu'une fois.
//
// ══ POURQUOI LES CONTENUS SONT ÉCRITS ICI, ET NON EN BASE ═══════════════════
//
// Parce qu'un parc neuf — un nouveau Panel, une base de recette, une reprise
// après incident — doit repartir avec des documents utilisables sans que
// personne ait à les retaper. Le contenu vit dans le code comme le registre des
// modèles d'e-mail : il est relu en revue, versionné avec le dépôt, et il ne
// peut pas disparaître d'une base.
//
// Une fois amorcé, l'AUTORITÉ passe à la base : ce fichier n'a plus rien à dire
// sur ce que l'opérateur en fait.
//
// ══ CE QUI N'EST PAS AMORCÉ, ET POURQUOI ════════════════════════════════════
//
// L'entreprise DÉVELOPPEUR (`PanelCompany`) n'est pas touchée. Son identité
// juridique — SIREN, forme, adresse — est une donnée réelle que personne ici ne
// peut connaître. L'inventer la ferait s'afficher sur les mentions légales de
// TOUT le parc, ce qui est le contraire de ce que ce chantier construit. Elle
// se saisit dans « Mon entreprise », et tant qu'elle est vide les blocs
// concernés disparaissent des documents — proprement, sans « undefined ».
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import PanelHostCompany, { HOST_COMPANY_STATUS } from '../../models/PanelHostCompany.model.js';
import PanelLegalTemplate, {
  LEGAL_DOCUMENT_TYPES,
  LEGAL_TEMPLATE_STATUS,
} from '../../models/PanelLegalTemplate.model.js';
import PanelLegalTemplateVersion from '../../models/PanelLegalTemplateVersion.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { validateContent } from './legalTemplate.validation.js';

/* -------------------------------------------------------------------------- */
/*  HÉBERGEUR                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * HOSTINGER — l'entité qui CONTRACTE le service d'hébergement pour l'UE.
 *
 * ══ POURQUOI CELLE-CI, ET PAS UNE AUTRE ════════════════════════════════════
 *
 * Le groupe Hostinger en compte plusieurs, et elles ne jouent pas le même rôle.
 * Les mentions légales doivent nommer l'HÉBERGEUR — celui qui fournit le
 * service — c'est-à-dire l'entité contractante :
 *
 *   HOSTINGER INTERNATIONAL LIMITED   Larnaca, Chypre. Partie contractante
 *                                     pour tout pays non listé nommément dans
 *                                     les conditions générales — l'Union
 *                                     européenne, donc la France, en fait
 *                                     partie. C'est CELLE-CI.
 *
 *   HOSTINGER, UAB                    Vilnius, Lituanie, n° 302710386.
 *                                     Responsable de traitement au sens de la
 *                                     politique de confidentialité. C'est un
 *                                     rôle RGPD, pas un rôle d'hébergement.
 *
 *   HOSTINGER operations, UAB         Vilnius, n° 306308157. Présentée par
 *                                     Hostinger comme l'entité registrar.
 *
 *   Hostinger UK Ltd / PTE / Global   Royaume-Uni, Singapour, Luxembourg :
 *                                     autres zones contractuelles.
 *
 * Les confondre ferait désigner, comme hébergeur, une société qui ne l'est pas.
 *
 * ══ LE NUMÉRO D'IMMATRICULATION ════════════════════════════════════════════
 *
 * `HE 301365`, registre des sociétés de Chypre. Il ne figure PAS sur les pages
 * légales de Hostinger : il vient du registre chypriote, recoupé par la fiche
 * membre RIPE de l'entité. La `source` de la fiche porte l'adresse des pages
 * Hostinger qui font foi pour le reste, et `verifiedAt` la date de contrôle —
 * c'est précisément l'usage de ces deux champs.
 */
const HOSTINGER = Object.freeze({
  legalName: 'HOSTINGER INTERNATIONAL LIMITED',
  tradingName: 'Hostinger',
  legalForm: 'Private limited company (Chypre)',
  registrationNumber: 'HE 301365',
  address: {
    line1: '61 Lordou Vironos str.',
    line2: null,
    postalCode: '6023',
    city: 'Larnaca',
    country: 'Chypre',
    countryCode: 'CY',
  },
  /** Adresse publiée par Hostinger pour les signalements et la conformité. */
  email: 'compliance@hostinger.com',
  phone: null,
  website: 'https://www.hostinger.com',
  source:
    'https://www.hostinger.com/legal/universal-terms-of-service-agreement · '
    + 'https://www.hostinger.com/legal/abuse-policy · registre des sociétés de Chypre (HE 301365)',
  notes:
    "Entité CONTRACTANTE du service d'hébergement pour les pays non listés nommément "
    + "dans les conditions générales, dont la France. À ne pas confondre avec "
    + "HOSTINGER, UAB (responsable de traitement, Vilnius) ni avec HOSTINGER operations, "
    + "UAB (registrar). Serveur du parc vérifié à Paris (FR), AS47583 Hostinger.",
});

async function seedHostCompany() {
  /**
   * L'EXISTENCE EST TESTÉE SUR LE MONDE, PAS SUR LE NOM.
   *
   * Une instance qui compte déjà un hébergeur — quel qu'il soit — n'a pas
   * besoin de celui-ci. Tester le nom aurait recréé une fiche Hostinger à côté
   * d'une fiche « OVH » saisie à la main après une migration, et les mentions
   * légales du parc auraient basculé sans que personne ne l'ait demandé.
   */
  const existant = await PanelHostCompany.countDocuments({ environment: config.env });
  if (existant > 0) return { created: 0 };

  const at = nowIso();
  await PanelHostCompany.create({
    ...HOSTINGER,
    hostCompanyId: `hc-hostinger-${config.env.toLowerCase()}`,
    verifiedAt: at.slice(0, 10),
    status: HOST_COMPANY_STATUS.ACTIVE,
    environment: config.env,
    createdAt: at,
    updatedAt: at,
    createdBy: 'seed',
    updatedBy: 'seed',
  });
  return { created: 1 };
}

/* -------------------------------------------------------------------------- */
/*  CONTENUS INITIAUX                                                         */
/* -------------------------------------------------------------------------- */

const p = (text) => ({ type: 'PARAGRAPH', text });
const list = (...items) => ({ type: 'LIST', items });
const fields = (...pairs) => ({
  type: 'FIELDS',
  fields: pairs.map(([label, value]) => ({ label, value })),
});

/**
 * MENTIONS LÉGALES — SITE VITRINE STANDARD FR.
 *
 * ══ CE QUE CE TEXTE EST, ET CE QU'IL N'EST PAS ═════════════════════════════
 *
 * C'est un contenu de départ, sobre et factuel, couvrant les rubriques usuelles
 * d'un site vitrine français : éditeur, identification légale, directeur de la
 * publication, coordonnées, conception, hébergement, propriété intellectuelle,
 * responsabilité, renvoi vers la politique de confidentialité.
 *
 * Ce N'EST PAS un avis juridique, et rien ici ne prétend l'être. L'objet du
 * chantier est une ARCHITECTURE capable de gérer proprement ces textes ; ce
 * contenu la rend utilisable dès le premier jour, et il est fait pour être relu
 * et amendé dans l'éditeur.
 *
 * ══ POURQUOI L'IDENTIFICATION EST UN BLOC `FIELDS` ═════════════════════════
 *
 * Parce que c'est la partie qui varie le plus d'un client à l'autre, et que
 * chaque LIGNE disparaît seule quand sa donnée manque. Écrite en paragraphe,
 * il aurait fallu choisir entre « Capital social : N/A » sur un entrepreneur
 * individuel et la disparition de toute l'identification. Ici, un EI affiche
 * son SIREN et son SIRET, et les lignes qui ne le concernent pas n'existent
 * simplement pas.
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
        p("Pour toute question relative au site ou aux prestations proposées, vous pouvez nous joindre par les moyens suivants, ou depuis la page « Contact »."),
        fields(
          ['Téléphone', '{{client.phone}}'],
          ['Adresse e-mail', '{{client.email}}'],
        ),
      ],
    },
    {
      heading: 'Conception et réalisation',
      blocks: [
        p('Ce site a été conçu et réalisé par {{developer.name}}.'),
        fields(
          ['Raison sociale', '{{developer.legalName}}'],
          ['Forme juridique', '{{developer.legalForm}}'],
          ['SIREN', '{{developer.siren}}'],
          ['SIRET', '{{developer.siret}}'],
          ['Adresse', '{{developer.address}}'],
          ['Adresse e-mail', '{{developer.email}}'],
          ['Site web', '{{developer.website}}'],
        ),
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
        p("L'ensemble des éléments composant ce site — textes, photographies, illustrations, logos, marques et éléments graphiques — est protégé par le droit de la propriété intellectuelle. Toute reproduction, représentation, adaptation ou exploitation, totale ou partielle, sur quelque support que ce soit, est interdite sans autorisation écrite préalable."),
        p("Les photographies de réalisations présentées sur ce site illustrent des prestations réellement effectuées. Elles ne constituent pas un engagement sur un résultat identique, chaque intervention dépendant de l'état initial du support traité."),
      ],
    },
    {
      heading: 'Responsabilité',
      blocks: [
        p("Les informations publiées sur ce site sont fournies à titre indicatif et sont susceptibles d'évoluer. Les prix, délais et prestations décrits ne constituent pas une offre contractuelle : seul un devis accepté engage les parties."),
        p("Le site peut comporter des liens vers des sites tiers. Ces sites ne sont pas sous notre contrôle, et leur contenu n'engage que leurs éditeurs respectifs."),
        p("Nous mettons en œuvre les moyens raisonnables pour assurer l'accessibilité du site, sans pouvoir garantir une disponibilité ininterrompue. Une interruption pour maintenance, mise à jour ou cause indépendante de notre volonté ne saurait engager notre responsabilité."),
      ],
    },
    {
      heading: 'Données personnelles',
      blocks: [
        p("Les traitements de données personnelles réalisés depuis ce site — notamment via le formulaire de contact — sont décrits dans la politique de confidentialité, accessible depuis le pied de page. Vous y trouverez la nature des données collectées, leurs finalités, leurs durées de conservation et les modalités d'exercice de vos droits."),
      ],
    },
  ],
};

/**
 * POLITIQUE DE CONFIDENTIALITÉ — SITE VITRINE STANDARD FR.
 *
 * ══ ELLE DÉCRIT LES TRAITEMENTS RÉELS, PAS DES TRAITEMENTS TYPIQUES ════════
 *
 * Une politique générique aurait été plus courte à écrire et fausse. Chaque
 * affirmation ci-dessous a été vérifiée dans le code des projets concernés :
 *
 *   FORMULAIRE      `ContactSubmission` : nom, e-mail, téléphone facultatif,
 *                   motif, message, page d'envoi, page d'origine, FAMILLE de
 *                   navigateur et langue. Le modèle documente explicitement
 *                   qu'aucune IP, aucun cookie, aucun jeton et aucune empreinte
 *                   de navigateur ne sont enregistrés — et que la chaîne
 *                   User-Agent complète n'est jamais stockée.
 *
 *   ANTI-ABUS       honeypot et délai de saisie. Aucun captcha tiers : aucune
 *                   requête ne part vers Google ou Cloudflare. Le prétendre
 *                   aurait annoncé un transfert qui n'existe pas.
 *
 *   COOKIES         AUCUN. Le site utilise le stockage local du navigateur pour
 *                   deux usages strictement techniques — mémoriser la palette
 *                   de couleurs et le fait qu'un bandeau promotionnel a été
 *                   fermé. Ces données ne quittent jamais l'appareil et ne
 *                   servent à aucun suivi. C'est pour cela qu'aucun bandeau de
 *                   consentement ne s'affiche : il n'y a rien à consentir.
 *
 *   ANALYTICS       AUCUN. Ni Google Analytics, ni Matomo, ni pixel.
 *
 *   JOURNAUX        l'infrastructure d'hébergement journalise les accès
 *                   (adresse IP, horodatage, adresse demandée, identifiant de
 *                   navigateur). C'est le fonctionnement standard du serveur
 *                   web ; le taire aurait été le seul mensonge de ce texte.
 *
 *   E-MAILS         les notifications partent par un prestataire de messagerie
 *                   transactionnelle établi dans l'Union européenne.
 *
 *   HÉBERGEMENT     serveur vérifié en France (Paris), opéré par Hostinger.
 *
 * Le jour où un projet activera un traitement différent — un captcha, une
 * mesure d'audience —, ce n'est PAS ce texte qu'il faudra tordre : c'est un
 * second template qu'il faudra créer et lui assigner. C'est exactement ce que
 * le référentiel rend possible.
 */
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
          "Formulaire de contact : votre nom, votre adresse e-mail, votre numéro de téléphone si vous le renseignez, le motif de votre demande et le contenu de votre message.",
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
          ['Répondre à vos demandes et établir un devis', "Exécution de mesures précontractuelles prises à votre demande, ou intérêt légitime à répondre à une sollicitation."],
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
          "{{developer.name}}, qui assure la conception et la maintenance technique du site et peut, à ce titre, accéder aux données lors d'une intervention.",
          "Google Ireland Limited et Google LLC, au titre des polices de caractères et de la carte de localisation intégrées au site — voir la section « Services tiers et contenus intégrés ».",
        ),
      ],
    },
    {
      /**
       * ══ LA SECTION QUI MANQUAIT, ET QUI RENDAIT LE DOCUMENT FAUX ═════════
       *
       * ── CE QUE LE TEXTE AFFIRMAIT ───────────────────────────────────────
       *
       *   « Ce site ne dépose […] aucun traceur tiers. »
       *   « Nous ne procédons à aucun transfert de vos données en dehors de
       *     l'Union européenne. »
       *
       * ── CE QUE LE CODE FAIT RÉELLEMENT ──────────────────────────────────
       *
       * Chaque vitrine du parc charge ses polices depuis `fonts.googleapis.com`
       * et `fonts.gstatic.com` (`index.html` + `lib/theme.ts`), et la page
       * « Contact » intègre une carte `google.com/maps?output=embed`.
       *
       * Ces deux requêtes partent du NAVIGATEUR DU VISITEUR vers Google. Elles
       * transmettent donc son adresse IP — une donnée personnelle — à un tiers,
       * et potentiellement hors de l'Union européenne. Les deux affirmations
       * ci-dessus étaient, à la lettre, inexactes.
       *
       * ── POURQUOI ON CORRIGE LE TEXTE PLUTÔT QUE LE SITE ─────────────────
       *
       * Héberger les polices localement et remplacer la carte par un lien
       * seraient de vraies améliorations, et elles restent souhaitables. Mais
       * supprimer une fonctionnalité utile POUR RESTER COMPATIBLE AVEC UN
       * DOCUMENT est exactement l'inversion que la doctrine « legal compliance
       * by change » interdit : le document décrit le produit, pas l'inverse.
       *
       * ── POURQUOI CETTE SECTION EST DANS LE TEMPLATE STANDARD ────────────
       *
       * Parce que ce n'est la particularité d'aucun client : les trois vitrines
       * du parc chargent les mêmes polices et la même carte. En faire un
       * template dédié aurait laissé le standard faux pour tout le monde.
       */
      heading: 'Services tiers et contenus intégrés',
      blocks: [
        p("Certaines ressources affichées sur ce site sont fournies par des tiers. Votre navigateur les demande directement à ces services, qui reçoivent alors votre adresse IP et les informations techniques que tout navigateur transmet lors d'une requête (type d'appareil, système, langue, page d'origine)."),
        list(
          "Google Fonts — les polices de caractères du site sont chargées depuis les serveurs de Google à chaque visite. Aucun cookie n'est déposé par ce service.",
          "Google Maps — la carte de localisation n'est chargée QUE sur la page « Contact », et uniquement lorsque vous l'ouvrez. Google est susceptible d'y déposer ses propres cookies et traceurs, sur lesquels nous n'avons aucun contrôle.",
        ),
        p("Nous n'avons accès à aucune des données collectées par ces services, et nous ne leur transmettons volontairement aucune information vous concernant. Leur utilisation relève de leurs propres politiques de confidentialité."),
        p("Le site n'intègre aucun autre service tiers : ni mesure d'audience, ni pixel publicitaire, ni chat en ligne, ni captcha externe, ni plateforme de réservation."),
      ],
    },
    {
      heading: 'Durées de conservation',
      blocks: [
        fields(
          ['Demandes de contact sans suite', "Trois ans à compter du dernier échange."],
          ['Dossiers clients', "Durée de la relation commerciale, puis conservation au titre des obligations légales applicables."],
          ['Journaux techniques du serveur', "Durée courte, propre à l'exploitation du serveur, à des fins de sécurité et de diagnostic."],
        ),
      ],
    },
    {
      heading: "Transferts hors de l'Union européenne",
      blocks: [
        p("Les données que VOUS NOUS TRANSMETTEZ — formulaire de contact, échanges directs — ne quittent pas l'Union européenne : les serveurs utilisés pour ce site sont situés en France, et le prestataire de messagerie est établi dans l'Union européenne."),
        p("Les services tiers décrits plus haut (polices de caractères et carte de localisation) sont opérés par Google, dont l'entité européenne est Google Ireland Limited. Ces services sont susceptibles de transférer certaines données techniques, dont votre adresse IP, vers des serveurs situés en dehors de l'Union européenne. Ces transferts relèvent des garanties mises en place par Google, notamment les clauses contractuelles types de la Commission européenne, et nous n'en sommes pas responsables."),
        p("Si vous souhaitez éviter ces requêtes, la plupart des navigateurs et extensions de blocage permettent de s'y opposer ; le site reste consultable, avec des polices de substitution et sans carte intégrée."),
      ],
    },
    {
      heading: 'Cookies et traceurs',
      blocks: [
        p("Ce site ne dépose lui-même AUCUN cookie : ni cookie publicitaire, ni cookie de mesure d'audience, ni traceur. Il n'utilise ni Google Analytics, ni service équivalent, ni pixel de suivi, et ne pratique aucun profilage."),
        p("La seule exception ne vient pas de nous : la carte de localisation intégrée à la page « Contact » est chargée depuis Google, qui peut y déposer ses propres cookies. Elle n'est chargée que sur cette page. Les autres pages du site n'émettent aucune requête vers un tiers en dehors des polices de caractères, qui ne déposent rien."),
        p("Le site conserve deux informations dans le stockage local de votre navigateur, pour des raisons strictement techniques : la palette de couleurs du site, afin d'éviter un changement d'apparence à l'ouverture, et le fait qu'un bandeau d'information a été fermé, afin de ne pas le réafficher. Ces informations ne quittent jamais votre appareil, ne nous sont jamais transmises et ne permettent aucun suivi."),
      ],
    },
    {
      heading: 'Vos droits',
      blocks: [
        p("Conformément au Règlement général sur la protection des données et à la loi « Informatique et Libertés », vous disposez des droits suivants sur vos données :"),
        list(
          "Droit d'accès : obtenir la confirmation que vos données sont traitées et en recevoir une copie.",
          "Droit de rectification : faire corriger une donnée inexacte ou incomplète.",
          "Droit à l'effacement : demander la suppression de vos données, dans les limites de nos obligations légales de conservation.",
          "Droit à la limitation du traitement : demander le gel d'un traitement contesté.",
          "Droit d'opposition : vous opposer à un traitement fondé sur notre intérêt légitime.",
          "Droit à la portabilité : recevoir vos données dans un format structuré et lisible par machine.",
        ),
      ],
    },
    {
      heading: 'Exercer vos droits',
      blocks: [
        p("Vous pouvez exercer ces droits en nous contactant par l'un des moyens indiqués ci-dessous, ou depuis la page « Contact » du site. Nous vous répondons dans un délai d'un mois. Une pièce justificative d'identité peut vous être demandée en cas de doute raisonnable sur l'identité du demandeur."),
        fields(
          ['Téléphone', '{{client.phone}}'],
          ['Adresse e-mail', '{{client.email}}'],
          ['Adresse postale', '{{client.address}}'],
        ),
        p("Si vous estimez, après nous avoir contactés, que vos droits ne sont pas respectés, vous pouvez introduire une réclamation auprès de la Commission nationale de l'informatique et des libertés (CNIL), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07, ou depuis son site www.cnil.fr."),
      ],
    },
    {
      heading: 'Sécurité',
      blocks: [
        p("Les échanges avec ce site sont chiffrés par le protocole HTTPS. L'accès aux demandes reçues est réservé aux personnes autorisées et protégé par authentification. Les données sont conservées sur une infrastructure située dans l'Union européenne, faisant l'objet de sauvegardes régulières."),
      ],
    },
    {
      heading: 'Mise à jour de la présente politique',
      blocks: [
        p("Cette politique peut être modifiée pour tenir compte d'une évolution du site, des traitements réalisés ou de la réglementation applicable. La version en vigueur est celle publiée sur cette page ; la date de dernière mise à jour figure en tête du document."),
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/*  AMORÇAGE DES TEMPLATES                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Les templates amorcés portent un identifiant STABLE et LISIBLE.
 *
 * Contrairement aux templates créés par un opérateur — dont l'identifiant est
 * opaque —, ceux-ci doivent être retrouvables par un seed rejoué et par les
 * migrations d'affectation. Un identifiant tiré au hasard obligerait à chercher
 * par NOM, c'est-à-dire par une donnée que l'opérateur a le droit de changer.
 */
const SEEDS = [
  {
    legalTemplateId: 'lt-seed-legal-notice-fr',
    name: 'Mentions légales — Site vitrine standard FR',
    type: LEGAL_DOCUMENT_TYPES.LEGAL_NOTICE,
    description:
      "Structure standard d'un site vitrine français : éditeur, identification légale, "
      + 'directeur de la publication, conception, hébergement, propriété intellectuelle.',
    content: LEGAL_NOTICE_CONTENT,
  },
  {
    legalTemplateId: 'lt-seed-privacy-policy-fr',
    name: 'Politique de confidentialité — Site vitrine standard FR',
    type: LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY,
    description:
      'Décrit les traitements réellement effectués par une vitrine de ce parc : formulaire '
      + "de contact, journaux serveur, aucun cookie et aucune mesure d'audience.",
    content: PRIVACY_POLICY_CONTENT,
  },
];

async function seedTemplate(definition) {
  const existing = await PanelLegalTemplate.findOne({
    legalTemplateId: definition.legalTemplateId,
    environment: config.env,
  }).lean();

  /**
   * DÉJÀ PRÉSENT — ON NE TOUCHE À RIEN, PAS MÊME AU NOM.
   *
   * Le nom paraît anodin ; il ne l'est pas. Un opérateur qui renomme
   * « Mentions légales — Site vitrine standard FR » en « Mentions légales —
   * vitrine 2027 » l'a fait pour une raison, et le voir revenir à chaque
   * redémarrage lui apprendrait surtout que cet écran ne mémorise rien.
   */
  if (existing) return { created: false };

  const content = validateContent(definition.content);
  const at = nowIso();

  await PanelLegalTemplate.create({
    legalTemplateId: definition.legalTemplateId,
    name: definition.name,
    type: definition.type,
    description: definition.description,
    content,
    /**
     * AMORCÉ DIRECTEMENT EN ACTIF ET PUBLIÉ EN VERSION 1.
     *
     * C'est la seule exception à la règle « un template naît en brouillon », et
     * elle est justifiée : ce contenu est relu en revue de code, il n'est le
     * brouillon de personne, et l'amorcer en brouillon obligerait à le publier
     * à la main sur chaque instance avant de pouvoir l'assigner. La création
     * PAR UN OPÉRATEUR, elle, reste en brouillon.
     */
    status: LEGAL_TEMPLATE_STATUS.ACTIVE,
    version: 1,
    publishedContent: content,
    publishedAt: at,
    environment: config.env,
    createdAt: at,
    updatedAt: at,
    createdBy: 'seed',
    updatedBy: 'seed',
  });

  await PanelLegalTemplateVersion.create({
    legalTemplateId: definition.legalTemplateId,
    version: 1,
    name: definition.name,
    type: definition.type,
    description: definition.description,
    content,
    changedByLabel: 'Amorçage',
    origin: 'SEED',
    createdAt: at,
  });

  return { created: true };
}

/**
 * AMORCE LE SOCLE LÉGAL. Idempotent, non bloquant pour le démarrage.
 *
 * Un Panel dont le socle légal n'est pas amorcé démarre quand même : les
 * projets qui ont déjà reçu leurs documents continuent de les servir — ils en
 * détiennent une réplique locale — et l'écran « Documents légaux » sera
 * simplement vide. Refuser de démarrer laisserait tout le parc sans supervision
 * pour un contenu qui peut attendre une minute.
 */
export async function seedLegalFoundations() {
  const host = await seedHostCompany();

  let created = 0;
  for (const definition of SEEDS) {
    // eslint-disable-next-line no-await-in-loop
    const result = await seedTemplate(definition);
    if (result.created) created += 1;
  }

  if (host.created || created) {
    logger.info(
      `Socle légal : ${host.created} hébergeur(s) et ${created} template(s) amorcé(s).`,
    );
  }
  return { hostCreated: host.created, templatesCreated: created };
}

export const SEED_TEMPLATE_IDS = Object.freeze({
  LEGAL_NOTICE: 'lt-seed-legal-notice-fr',
  PRIVACY_POLICY: 'lt-seed-privacy-policy-fr',
});

export default { seedLegalFoundations, SEED_TEMPLATE_IDS };
