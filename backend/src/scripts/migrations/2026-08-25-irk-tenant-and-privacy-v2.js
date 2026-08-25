// MIGRATION — IRK au système légal, et correction du template Privacy.
//
//   npm run migrate:irk-legal
//   npm run migrate:irk-legal -- --dry-run
//
// ══ DEUX GESTES, ET ILS SONT LIÉS ═══════════════════════════════════════════
//
//   1. CRÉE la fiche d'entreprise cliente d'Inter Racing Kart, la rattache au
//      projet, lui assigne les deux templates et publie.
//
//   2. MET À JOUR le template « Politique de confidentialité — Site vitrine
//      standard FR », dont deux affirmations étaient devenues FAUSSES pour
//      TOUTES les vitrines du parc.
//
// Le second geste n'est pas une commodité : sans lui, brancher IRK reviendrait
// à publier sciemment un document inexact de plus.
//
// ══ CE QUI ÉTAIT FAUX, ET POURQUOI ══════════════════════════════════════════
//
// Le texte publié affirmait :
//
//     « Ce site ne dépose […] aucun traceur tiers. »
//     « Nous ne procédons à aucun transfert de vos données en dehors de
//       l'Union européenne. »
//
// Or chaque vitrine du parc charge ses polices depuis `fonts.googleapis.com` /
// `fonts.gstatic.com`, et sa page « Contact » intègre une carte
// `google.com/maps?output=embed`. Ces requêtes partent du NAVIGATEUR DU
// VISITEUR vers Google et transmettent son adresse IP — une donnée
// personnelle, potentiellement hors Union européenne.
//
// Ce n'est la particularité d'aucun client : les trois vitrines actives font
// exactement la même chose. La correction appartient donc au template STANDARD,
// et elle le rend plus juste pour FJ Services et R.L.V Detail en même temps que
// pour IRK — au lieu de leur laisser un texte inexact.
//
// ══ POURQUOI ON NE SUPPRIME PAS LES POLICES ET LA CARTE ═════════════════════
//
// Les héberger localement serait une vraie amélioration, et elle reste
// souhaitable. Mais retirer une fonctionnalité utile POUR RESTER COMPATIBLE
// AVEC UN DOCUMENT est l'inversion exacte que la doctrine « legal compliance by
// change » interdit : le document décrit le produit, pas l'inverse.
//
// ══ IDEMPOTENTE ET NON ÉCRASANTE ════════════════════════════════════════════
//
// La fiche IRK n'est créée que si elle est absente ; un projet déjà rattaché
// n'est jamais redirigé ; une affectation existante n'est jamais remplacée. La
// republication, elle, est toujours rejouée — c'est ce qui rattrape un projet
// resté hors ligne.
import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import PanelProject from '../../models/PanelProject.model.js';
import PanelClientCompany, {
  CLIENT_COMPANY_STATUS,
} from '../../models/PanelClientCompany.model.js';
import PanelLegalTemplate from '../../models/PanelLegalTemplate.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { SEED_TEMPLATE_IDS } from '../../services/legal/legalSeed.js';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * INTER RACING KART — l'identité juridique, telle que les registres la donnent.
 *
 * ══ NE PAS CONFONDRE L'ENSEIGNE ET LA SOCIÉTÉ ══════════════════════════════
 *
 * « Inter Racing Kart » est le NOM COMMERCIAL. La société exploitante est
 * `INTERNATIONAL RACING KARTING`, SARL, SIREN 489240424 — l'Annuaire des
 * Entreprises lui associe explicitement cette enseigne.
 *
 * ══ CE QUI EST VÉRIFIÉ, ET PAR QUOI ════════════════════════════════════════
 *
 *   raison sociale, SIREN,   Annuaire des Entreprises (recherche-entreprises
 *   SIRET du siège, adresse, .api.gouv.fr, adossé à SIRENE/RNE), consulté le
 *   gérante, APE            2026-08-25.
 *
 *   forme juridique (SARL)   VIES, qui rend « SARL INTERNATIONAL RACING
 *   et TVA FR25489240424     KARTING » et déclare le numéro VALIDE. Ce n'est
 *                            pas une clé recalculée : c'est une vérification
 *                            auprès de l'administration fiscale européenne.
 *
 *   RCS Fréjus              greffe identifié par l'entrée Infogreffe de ce
 *                            SIREN (clé 8303 = Fréjus).
 *
 *   directeur de publication les mentions légales que l'éditeur publie
 *                            LUI-MÊME sur interracingkart.com. Ce n'est pas une
 *                            déduction : c'est la déclaration de l'éditeur sur
 *                            le champ dont il est seul juge.
 *
 * ══ CE QUI RESTE VIDE, ET POURQUOI ═════════════════════════════════════════
 *
 * `shareCapital`. Une valeur circule sur les agrégateurs commerciaux, mais
 * aucune source de registre directement lisible ne la confirme, et les deux
 * agrégateurs consultés refusent l'accès automatisé. On ne seede donc rien :
 * le système de complétude du Panel signalera le champ, et un humain le
 * saisira depuis un Kbis. Inventer un capital social sur une page opposable
 * serait exactement ce que ce chantier interdit.
 *
 * ══ SIÈGE ET ÉTABLISSEMENT NE SONT PAS LA MÊME ADRESSE ═════════════════════
 *
 * Le SIÈGE est au Pôle d'Excellence Jean Louis, 14 Via Nova. La PISTE est
 * Chemin de Villeneuve, avenue du 8 Mai 1945 — c'est l'adresse commerciale, et
 * elle vit déjà dans la fiche du projet, d'où la page « Contact » la tire. Les
 * mentions légales citent le siège ; le site cite la piste. Écraser l'une par
 * l'autre ferait afficher une adresse où le client n'accueille personne.
 */
const IRK = {
  projectKey: 'inter-racing-kart',
  clientCompanyId: 'cc-seed-irk-karting',
  fiche: {
    legalName: 'INTERNATIONAL RACING KARTING',
    tradingName: 'Inter Racing Kart',
    legalForm: 'SARL',
    siren: '489240424',
    siret: '48924042400031',
    vatNumber: 'FR25489240424',
    registrationCity: 'Fréjus',
    shareCapital: null,
    publicationDirector: 'Anthony BOYER',
    registeredOffice: {
      line1: "Pôle d'Excellence Jean Louis",
      line2: '14 Via Nova',
      postalCode: '83600',
      city: 'Fréjus',
      country: 'FR',
    },
    phone: '+33 4 94 97 50 97',
    publicEmail: 'interacingkart@orange.fr',
    billingEmail: null,
    website: 'https://www.interracingkart.com',
    notes:
      "Identité vérifiée le 2026-08-25. Société exploitante : INTERNATIONAL RACING "
      + "KARTING (SIREN 489240424, SIRET siège 48924042400031, APE 77.21Z, gérante "
      + "Stéphanie FOURNET), enseigne « Inter Racing Kart ». Forme SARL et TVA "
      + "FR25489240424 CONFIRMÉES par VIES. RCS Fréjus (greffe 8303, Infogreffe). "
      + "Directeur de publication repris des mentions légales publiées par l'éditeur "
      + "sur interracingkart.com. CAPITAL SOCIAL non renseigné : aucune source de "
      + "registre directement vérifiable — à compléter depuis un Kbis. Siège (Via "
      + "Nova) distinct de l'établissement d'accueil (Chemin de Villeneuve), qui "
      + "reste l'adresse commerciale du projet.",
  },
};

/**
 * LES SECTIONS CORRIGÉES DE LA POLITIQUE STANDARD.
 *
 * On remplace par TITRE, et on insère « Services tiers » avant « Transferts ».
 * Remplacer le document entier écraserait les corrections qu'un opérateur
 * aurait pu apporter aux autres sections depuis la publication initiale.
 */
const SECTIONS_TIERS = {
  heading: 'Services tiers et contenus intégrés',
  blocks: [
    {
      type: 'PARAGRAPH',
      text: "Certaines ressources affichées sur ce site sont fournies par des tiers. Votre navigateur les demande directement à ces services, qui reçoivent alors votre adresse IP et les informations techniques que tout navigateur transmet lors d'une requête (type d'appareil, système, langue, page d'origine).",
    },
    {
      type: 'LIST',
      items: [
        "Google Fonts — les polices de caractères du site sont chargées depuis les serveurs de Google à chaque visite. Aucun cookie n'est déposé par ce service.",
        "Google Maps — la carte de localisation n'est chargée QUE sur la page « Contact », et uniquement lorsque vous l'ouvrez. Google est susceptible d'y déposer ses propres cookies et traceurs, sur lesquels nous n'avons aucun contrôle.",
      ],
    },
    {
      type: 'PARAGRAPH',
      text: "Nous n'avons accès à aucune des données collectées par ces services, et nous ne leur transmettons volontairement aucune information vous concernant. Leur utilisation relève de leurs propres politiques de confidentialité.",
    },
    {
      type: 'PARAGRAPH',
      text: "Le site n'intègre aucun autre service tiers : ni mesure d'audience, ni pixel publicitaire, ni chat en ligne, ni captcha externe, ni plateforme de réservation.",
    },
  ],
};

const TRANSFERTS = {
  heading: "Transferts hors de l'Union européenne",
  blocks: [
    {
      type: 'PARAGRAPH',
      text: "Les données que VOUS NOUS TRANSMETTEZ — formulaire de contact, échanges directs — ne quittent pas l'Union européenne : les serveurs utilisés pour ce site sont situés en France, et le prestataire de messagerie est établi dans l'Union européenne.",
    },
    {
      type: 'PARAGRAPH',
      text: "Les services tiers décrits plus haut (polices de caractères et carte de localisation) sont opérés par Google, dont l'entité européenne est Google Ireland Limited. Ces services sont susceptibles de transférer certaines données techniques, dont votre adresse IP, vers des serveurs situés en dehors de l'Union européenne. Ces transferts relèvent des garanties mises en place par Google, notamment les clauses contractuelles types de la Commission européenne, et nous n'en sommes pas responsables.",
    },
    {
      type: 'PARAGRAPH',
      text: "Si vous souhaitez éviter ces requêtes, la plupart des navigateurs et extensions de blocage permettent de s'y opposer ; le site reste consultable, avec des polices de substitution et sans carte intégrée.",
    },
  ],
};

const COOKIES = {
  heading: 'Cookies et traceurs',
  blocks: [
    {
      type: 'PARAGRAPH',
      text: "Ce site ne dépose lui-même AUCUN cookie : ni cookie publicitaire, ni cookie de mesure d'audience, ni traceur. Il n'utilise ni Google Analytics, ni service équivalent, ni pixel de suivi, et ne pratique aucun profilage.",
    },
    {
      type: 'PARAGRAPH',
      text: "La seule exception ne vient pas de nous : la carte de localisation intégrée à la page « Contact » est chargée depuis Google, qui peut y déposer ses propres cookies. Elle n'est chargée que sur cette page. Les autres pages du site n'émettent aucune requête vers un tiers en dehors des polices de caractères, qui ne déposent rien.",
    },
    {
      type: 'PARAGRAPH',
      text: "Le site conserve deux informations dans le stockage local de votre navigateur, pour des raisons strictement techniques : la palette de couleurs du site, afin d'éviter un changement d'apparence à l'ouverture, et le fait qu'un bandeau d'information a été fermé, afin de ne pas le réafficher. Ces informations ne quittent jamais votre appareil, ne nous sont jamais transmises et ne permettent aucun suivi.",
    },
  ],
};

const DESTINATAIRE_GOOGLE =
  "Google Ireland Limited et Google LLC, au titre des polices de caractères et de la carte de localisation intégrées au site — voir la section « Services tiers et contenus intégrés ».";

function corrigerPrivacy(content) {
  const sections = (content.sections ?? []).map((s) => {
    if (s.heading === TRANSFERTS.heading) return TRANSFERTS;
    if (s.heading === COOKIES.heading) return COOKIES;
    if (s.heading === 'Destinataires des données') {
      return {
        ...s,
        blocks: s.blocks.map((b) => {
          if (b.type !== 'LIST') return b;
          if (b.items.some((i) => i.startsWith('Google Ireland'))) return b;
          return { ...b, items: [...b.items, DESTINATAIRE_GOOGLE] };
        }),
      };
    }
    return s;
  });

  // « Services tiers » s'insère AVANT « Transferts » : on décrit le tiers avant
  // d'expliquer où partent ses données.
  if (!sections.some((s) => s.heading === SECTIONS_TIERS.heading)) {
    const i = sections.findIndex((s) => s.heading === TRANSFERTS.heading);
    sections.splice(i < 0 ? sections.length : i, 0, SECTIONS_TIERS);
  }
  return { ...content, sections };
}

/* -------------------------------------------------------------------------- */

export async function migrateIrkLegal({ dryRun = false } = {}) {
  const rapport = { environnement: config.env, details: [], privacy: null, publications: [] };

  const mentions = await PanelLegalTemplate.findOne({
    legalTemplateId: SEED_TEMPLATE_IDS.LEGAL_NOTICE, environment: config.env,
  }).lean();
  const privacy = await PanelLegalTemplate.findOne({
    legalTemplateId: SEED_TEMPLATE_IDS.PRIVACY_POLICY, environment: config.env,
  }).lean();
  if (!mentions || !privacy) {
    throw new Error('Templates légaux amorcés introuvables : démarrez le backend une fois.');
  }

  /* ── 1. LA POLITIQUE STANDARD EST CORRIGÉE ET REPUBLIÉE ───────────────── */
  const source = privacy.publishedContent ?? privacy.content;
  const corrige = corrigerPrivacy(source);
  const dejaCorrige = (source.sections ?? []).some((s) => s.heading === SECTIONS_TIERS.heading);

  if (dejaCorrige) {
    rapport.privacy = 'déjà corrigée';
    rapport.details.push('Politique standard : section « Services tiers » déjà présente — INTACTE.');
  } else {
    rapport.privacy = `v${(privacy.version ?? 0) + 1}`;
    rapport.details.push(
      `Politique standard : ajout de « Services tiers », correction des transferts et `
      + `des cookies → v${(privacy.version ?? 0) + 1}.`,
    );
    if (!dryRun) {
      const { updateTemplate, publishTemplate } = await import(
        '../../services/legal/legalTemplate.service.js'
      );
      const { republishTemplate } = await import('../../services/legal/legalDocumentPublisher.js');
      await updateTemplate(privacy.legalTemplateId, { content: corrige }, { email: 'migration:irk-legal' });
      await publishTemplate(privacy.legalTemplateId, { email: 'migration:irk-legal' }, {
        republish: republishTemplate,
      });
    }
  }

  /* ── 2. IRK ────────────────────────────────────────────────────────────── */
  const projet = await PanelProject.findOne({ projectKey: IRK.projectKey }).lean();
  if (!projet) {
    rapport.details.push(`${IRK.projectKey} : projet absent du registre — ignoré.`);
    return rapport;
  }

  const existante = await PanelClientCompany.findOne({
    clientCompanyId: IRK.clientCompanyId,
  }).lean();

  if (existante) {
    rapport.details.push(`Fiche « ${existante.legalName} » déjà présente — INTACTE.`);
  } else {
    rapport.details.push(`Création de la fiche « ${IRK.fiche.legalName} ».`);
    if (!dryRun) {
      const at = nowIso();
      await PanelClientCompany.create({
        ...IRK.fiche,
        clientCompanyId: IRK.clientCompanyId,
        administrativeContact: {},
        contractualSigner: null,
        billingAddress: null,
        documents: [],
        status: CLIENT_COMPANY_STATUS.ACTIVE,
        environment: config.env,
        publishedVersion: 1,
        publishedAt: at,
        createdAt: at,
        updatedAt: at,
        createdBy: 'migration:irk-legal',
        updatedBy: 'migration:irk-legal',
      });
    }
  }

  if (projet.clientCompanyId === IRK.clientCompanyId) {
    rapport.details.push('Projet déjà rattaché.');
  } else if (projet.clientCompanyId) {
    rapport.details.push(
      `ATTENTION : déjà rattaché à ${projet.clientCompanyId} — laissé tel quel.`,
    );
  } else {
    rapport.details.push(`Rattachement du projet à ${IRK.clientCompanyId}.`);
    if (!dryRun) {
      await PanelProject.updateOne(
        { projectId: projet.projectId },
        { $set: { clientCompanyId: IRK.clientCompanyId, updatedAt: nowIso() } },
      );
    }
  }

  const patch = {};
  if (!projet.legalNoticeTemplateId) patch.legalNoticeTemplateId = mentions.legalTemplateId;
  if (!projet.privacyPolicyTemplateId) patch.privacyPolicyTemplateId = privacy.legalTemplateId;
  if (Object.keys(patch).length === 0) rapport.details.push('Templates déjà assignés — INTACTS.');
  else {
    rapport.details.push(`Affectation de ${Object.keys(patch).join(' et ')}.`);
    if (!dryRun) await PanelProject.updateOne({ projectId: projet.projectId }, { $set: patch });
  }

  if (!dryRun) {
    const { publishAllForProject } = await import(
      '../../services/legal/legalDocumentPublisher.js'
    );
    const r = await publishAllForProject(projet.projectId);
    rapport.publications.push({
      projectKey: IRK.projectKey,
      LEGAL_NOTICE: r.LEGAL_NOTICE?.published ? `v${r.LEGAL_NOTICE.documentVersion}` : (r.LEGAL_NOTICE?.reason ?? 'ÉCHEC'),
      PRIVACY_POLICY: r.PRIVACY_POLICY?.published ? `v${r.PRIVACY_POLICY.documentVersion}` : (r.PRIVACY_POLICY?.reason ?? 'ÉCHEC'),
    });
  }

  return rapport;
}

if (process.argv[1]?.endsWith('2026-08-25-irk-tenant-and-privacy-v2.js')) {
  await connectDatabase();
  const r = await migrateIrkLegal({ dryRun: DRY_RUN });
  logger.info(`\n════ IRK + PRIVACY v2 ${DRY_RUN ? '— SIMULATION' : '— APPLIQUÉE'} ════`);
  logger.info(`Environnement : ${r.environnement}`);
  for (const l of r.details) logger.info(`  · ${l}`);
  for (const p of r.publications) {
    logger.info(`Publication ${p.projectKey} : mentions=${p.LEGAL_NOTICE}, privacy=${p.PRIVACY_POLICY}`);
  }
  await disconnectDatabase();
  process.exit(0);
}

export default { migrateIrkLegal };
