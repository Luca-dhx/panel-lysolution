// MIGRATION — les IDENTITÉS LÉGALES des trois vitrines, et leurs affectations.
//
//   npm run migrate:legal-tenants
//   npm run migrate:legal-tenants -- --dry-run
//
// ══ CE QU'ELLE FAIT ═════════════════════════════════════════════════════════
//
//   1. CRÉE la fiche d'entreprise cliente de KleenPro, FJ Services 06 et
//      R.L.V Detail, à partir de données de REGISTRE vérifiées ;
//   2. RATTACHE chaque projet à sa fiche ;
//   3. ASSIGNE à chacun les deux templates légaux amorcés ;
//   4. PUBLIE les documents résolus vers les projets.
//
// ══ CRÉER SI ABSENT. JAMAIS ÉCRASER. ═══════════════════════════════════════
//
// C'est la règle qui gouverne tout ce fichier. Une fiche déjà présente n'est
// PAS réécrite, pas même partiellement : une fois qu'un opérateur a corrigé une
// adresse ou saisi un directeur de publication, un second passage ne doit pas
// reposer les valeurs d'origine. Même chose pour les affectations : un projet
// qui pointe déjà vers un template — quel qu'il soit — est laissé tel quel.
//
// Idem pour le RATTACHEMENT : un projet déjà rattaché à une entreprise n'est
// jamais redirigé. Le rediriger changerait le locataire d'un site en
// production, et ferait basculer ses mentions légales sur une autre société.
//
// ══ D'OÙ VIENNENT CES DONNÉES ═══════════════════════════════════════════════
//
// De l'ANNUAIRE DES ENTREPRISES (API `recherche-entreprises.api.gouv.fr`,
// DINUM — la source publique adossée à SIRENE et au RNE), interrogée par SIRET
// le 25 août 2026. Aucune donnée n'est déduite, aucune n'est complétée « pour
// faire propre » :
//
//   · le NOM CIVIL de l'entrepreneur individuel est la RAISON SOCIALE — c'est
//     ainsi qu'un EI s'identifie, et c'est ce que doit porter la mention
//     « éditeur du site ». `tradingName` porte l'enseigne ;
//   · le SIÈGE est l'adresse du REGISTRE. Elle n'est PAS l'adresse commerciale
//     du projet, qui reste dans sa fiche `Company` locale et alimente la page
//     « Contact ». Les confondre remplacerait l'une par l'autre à l'affichage ;
//   · le TÉLÉPHONE et l'E-MAIL repris sont ceux que le client PUBLIE DÉJÀ sur
//     son propre site. Ce ne sont pas des données de registre : ce sont ses
//     coordonnées d'affichage, et les mentions légales doivent citer un contact
//     joignable ;
//   · le CAPITAL SOCIAL et le RCS restent VIDES sur les trois : ce sont des
//     entrepreneurs individuels, ils n'en ont pas. Le résolveur retire alors
//     les lignes au lieu d'écrire « Capital social : N/A » ;
//   · le DIRECTEUR DE LA PUBLICATION est l'entrepreneur lui-même — pour un EI,
//     la personne physique et l'entreprise sont la même personne juridique.
//     Ce n'est pas une supposition, c'est la définition.
//
// Ce qui n'est PAS connu reste vide, et l'écran de complétude du Panel le dit.
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

const SOURCE_REGISTRE = 'Annuaire des Entreprises (recherche-entreprises.api.gouv.fr) — 2026-08-25';

/**
 * LES TROIS LOCATAIRES.
 *
 * `projectKey` est la clé de rattachement : elle est STABLE et lisible, là où
 * `projectId` est un UUID qui diffère d'une base à l'autre. Une migration qui
 * viserait un UUID ne fonctionnerait que sur la base où elle a été écrite.
 */
const TENANTS = [
  {
    projectKey: 'kleenpro',
    clientCompanyId: 'cc-seed-kleenpro',
    /**
     * KLEEN PRO — SIRET 99336598000016, SIREN 993365980.
     *
     * Entrepreneur individuel : KAMEL AMAR BOUZIT. La raison sociale d'un EI
     * EST le nom de l'entrepreneur ; « Kleen Pro » est l'enseigne.
     *
     * TVA : FR29993365980. La clé (29) est cohérente avec le SIREN —
     * `(12 + 3 × (SIREN mod 97)) mod 97` — et le numéro figure sur les sources
     * publiques de l'entreprise. Il est repris tel quel, jamais recalculé pour
     * combler un vide : un numéro calculé sur une entreprise en franchise en
     * base annoncerait un assujettissement qui n'existe pas.
     *
     * ADRESSE : celle du REGISTRE (Sisteron). Le site publie, lui, un rayon
     * d'intervention et un téléphone — ce sont deux informations différentes,
     * et la mention légale exige la première.
     */
    fiche: {
      legalName: 'Kamel Amar BOUZIT',
      tradingName: 'Kleen Pro',
      legalForm: 'Entrepreneur individuel',
      siren: '993365980',
      siret: '99336598000016',
      vatNumber: 'FR29993365980',
      registrationCity: null,
      shareCapital: null,
      publicationDirector: 'Kamel Amar BOUZIT',
      registeredOffice: {
        line1: '15 Les Bastides de Chantemerle',
        line2: null,
        postalCode: '04200',
        city: 'Sisteron',
        country: 'FR',
      },
      /** Publié par le client sur son propre site. Pas une donnée de registre. */
      phone: '+33 7 83 53 47 27',
      publicEmail: null,
      billingEmail: null,
      website: null,
      notes:
        "Identité vérifiée le 2026-08-25 auprès de l'Annuaire des Entreprises "
        + '(SIRET 99336598000016, créée le 2025-10-31, APE 45.20A). Entrepreneur '
        + "individuel : ni capital social ni RCS. Adresse du registre — l'adresse "
        + "commerciale et le téléphone d'affichage vivent dans la fiche du projet.",
    },
  },
  {
    projectKey: 'fj-services-06',
    clientCompanyId: 'cc-seed-fjservices06',
    /**
     * FJ SERVICES 06 — SIRET 94118938300016, SIREN 941189383.
     *
     * Entrepreneur individuel : FABRICE DAGORNE.
     *
     * AUCUN NUMÉRO DE TVA n'est renseigné, et c'est délibéré. Aucune source ne
     * l'atteste ; le CALCULER depuis le SIREN aurait été trivial et faux — un
     * numéro déduit annoncerait un assujettissement que rien ne prouve, sur une
     * page opposable. Le bloc disparaît, ce qui est la bonne réponse.
     */
    fiche: {
      legalName: 'Fabrice DAGORNE',
      tradingName: 'FJ Services 06',
      legalForm: 'Entrepreneur individuel',
      siren: '941189383',
      siret: '94118938300016',
      vatNumber: null,
      registrationCity: null,
      shareCapital: null,
      publicationDirector: 'Fabrice DAGORNE',
      registeredOffice: {
        line1: "L'Orangeraie",
        line2: '436 avenue de la Libération',
        postalCode: '06700',
        city: 'Saint-Laurent-du-Var',
        country: 'FR',
      },
      phone: '+33 7 59 52 10 23',
      publicEmail: 'fjservices06700@gmail.com',
      billingEmail: null,
      website: null,
      notes:
        "Identité vérifiée le 2026-08-25 auprès de l'Annuaire des Entreprises "
        + '(SIRET 94118938300016, créée le 2025-02-21, APE 45.20A, diffusion publique). '
        + 'Entrepreneur individuel : ni capital social ni RCS. Aucun numéro de TVA '
        + "attesté — non renseigné plutôt que déduit du SIREN.",
    },
  },
  {
    projectKey: 'rlv-detail',
    clientCompanyId: 'cc-seed-rlv-detail',
    /**
     * R.L.V DETAIL — IDENTITÉ LÉGALE INCOMPLÈTE, ET ASSUMÉE COMME TELLE.
     *
     * ══ POURQUOI CETTE FICHE EST DIFFÉRENTE DES DEUX AUTRES ═══════════════
     *
     * Aucune recherche au registre n'aboutit : ni « RLV », ni « R.L.V DETAIL »,
     * ni une entreprise de nettoyage automobile à cette adresse. Le site du
     * client ne publie ni SIREN, ni SIRET, ni forme juridique, ni nom de
     * dirigeant.
     *
     * On n'invente donc RIEN. La fiche porte le seul nom public — celui sous
     * lequel l'entreprise exerce — et son adresse d'établissement, publiée par
     * le client lui-même. `siren`, `siret`, `legalForm` et
     * `publicationDirector` restent VIDES.
     *
     * ══ CE QUE ÇA PRODUIT, ET POURQUOI C'EST LE BON COMPORTEMENT ══════════
     *
     * Les lignes d'identification légale disparaissent du document : la page
     * affiche l'éditeur, ses coordonnées, le concepteur et l'hébergeur, sans
     * jamais écrire « SIRET : » suivi d'un vide. L'écran du Panel, lui,
     * signale « 4 informations non renseignées » avec le lien pour les saisir.
     *
     * C'est exactement ce que le système doit faire d'une donnée manquante :
     * la rendre visible à l'opérateur, invisible au visiteur.
     */
    fiche: {
      legalName: 'R.L.V Detail',
      tradingName: 'R.L.V Detail',
      legalForm: null,
      siren: null,
      siret: null,
      vatNumber: null,
      registrationCity: null,
      shareCapital: null,
      publicationDirector: null,
      registeredOffice: {
        line1: '61 chemin du Vallon des Vaux',
        line2: 'Hangar 2',
        postalCode: '06800',
        city: 'Cagnes-sur-Mer',
        country: 'FR',
      },
      phone: '+33 6 95 60 91 54',
      publicEmail: null,
      billingEmail: null,
      website: 'https://www.rlv-detail.com',
      notes:
        "IDENTITÉ LÉGALE INCOMPLÈTE — à compléter par l'opérateur. Aucune "
        + "correspondance à l'Annuaire des Entreprises au 2026-08-25 pour « RLV » "
        + "ni « R.L.V Detail », et le site du client ne publie aucun identifiant. "
        + 'Adresse reprise du site public. SIREN, SIRET, forme juridique et '
        + 'directeur de publication VOLONTAIREMENT vides : rien ne doit être deviné '
        + 'sur une page opposable.',
    },
  },
];

/* -------------------------------------------------------------------------- */

export async function migrateLegalTenants({ dryRun = false } = {}) {
  const rapport = {
    environnement: config.env,
    fiches: { creees: 0, existantes: 0 },
    rattachements: { faits: 0, deja: 0, autres: 0, projetsInconnus: [] },
    affectations: { faites: 0, deja: 0 },
    publications: [],
    details: [],
  };

  /**
   * LES TEMPLATES DOIVENT EXISTER — ils viennent du seed de démarrage.
   *
   * S'ils manquent, on ne les crée pas ici : ce serait une seconde source du
   * même contenu, et les deux divergeraient. On s'arrête, et le message dit
   * quoi faire.
   */
  const mentions = await PanelLegalTemplate.findOne({
    legalTemplateId: SEED_TEMPLATE_IDS.LEGAL_NOTICE,
    environment: config.env,
  }).lean();
  const privacy = await PanelLegalTemplate.findOne({
    legalTemplateId: SEED_TEMPLATE_IDS.PRIVACY_POLICY,
    environment: config.env,
  }).lean();

  if (!mentions || !privacy) {
    throw new Error(
      'Templates légaux amorcés introuvables : démarrez le backend une fois '
      + '(le seed tourne au démarrage) avant de rejouer cette migration.',
    );
  }

  for (const tenant of TENANTS) {
    const projet = await PanelProject.findOne({ projectKey: tenant.projectKey }).lean();
    if (!projet) {
      rapport.rattachements.projetsInconnus.push(tenant.projectKey);
      rapport.details.push(`${tenant.projectKey} : projet absent du registre — ignoré.`);
      continue;
    }

    /* ── 1. LA FICHE ────────────────────────────────────────────────────── */
    const existante = await PanelClientCompany.findOne({
      clientCompanyId: tenant.clientCompanyId,
    }).lean();

    if (existante) {
      rapport.fiches.existantes += 1;
      rapport.details.push(`${tenant.projectKey} : fiche « ${existante.legalName} » déjà présente — INTACTE.`);
    } else {
      rapport.fiches.creees += 1;
      rapport.details.push(`${tenant.projectKey} : création de la fiche « ${tenant.fiche.legalName} ».`);
      if (!dryRun) {
        const at = nowIso();
        await PanelClientCompany.create({
          ...tenant.fiche,
          clientCompanyId: tenant.clientCompanyId,
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
          createdBy: 'migration:legal-tenants',
          updatedBy: 'migration:legal-tenants',
        });
      }
    }

    /* ── 2. LE RATTACHEMENT ─────────────────────────────────────────────── */
    if (projet.clientCompanyId === tenant.clientCompanyId) {
      rapport.rattachements.deja += 1;
    } else if (projet.clientCompanyId) {
      /**
       * DÉJÀ RATTACHÉ À UNE AUTRE ENTREPRISE — ON NE TOUCHE À RIEN.
       *
       * Rediriger changerait le LOCATAIRE d'un site en production : ses
       * mentions légales basculeraient sur une autre société, et sa
       * facturation avec. C'est précisément le genre d'écriture qu'une
       * migration ne doit jamais prendre l'initiative de faire.
       */
      rapport.rattachements.autres += 1;
      rapport.details.push(
        `${tenant.projectKey} : DÉJÀ rattaché à ${projet.clientCompanyId} — laissé tel quel.`,
      );
    } else {
      rapport.rattachements.faits += 1;
      rapport.details.push(`${tenant.projectKey} : rattaché à ${tenant.clientCompanyId}.`);
      if (!dryRun) {
        await PanelProject.updateOne(
          { projectId: projet.projectId },
          { $set: { clientCompanyId: tenant.clientCompanyId, updatedAt: nowIso() } },
        );
      }
    }

    /* ── 3. LES AFFECTATIONS ────────────────────────────────────────────── */
    const patch = {};
    if (!projet.legalNoticeTemplateId) patch.legalNoticeTemplateId = mentions.legalTemplateId;
    if (!projet.privacyPolicyTemplateId) patch.privacyPolicyTemplateId = privacy.legalTemplateId;

    if (Object.keys(patch).length === 0) {
      rapport.affectations.deja += 1;
      rapport.details.push(`${tenant.projectKey} : templates déjà assignés — INTACTS.`);
    } else {
      rapport.affectations.faites += 1;
      rapport.details.push(
        `${tenant.projectKey} : affectation de ${Object.keys(patch).join(' et ')}.`,
      );
      if (!dryRun) {
        await PanelProject.updateOne({ projectId: projet.projectId }, { $set: patch });
      }
    }

    /* ── 4. LA PUBLICATION ──────────────────────────────────────────────── */
    /**
     * ELLE EST TOUJOURS REJOUÉE, même quand rien n'a changé ici.
     *
     * Publier est IDEMPOTENT du point de vue du projet — la garde de version
     * écarte une écriture déjà appliquée — et c'est le seul geste qui rattrape
     * un projet resté hors ligne au-delà de la fenêtre de rattrapage. Le sauter
     * « parce que rien n'a changé au Panel » laisserait précisément les projets
     * en retard dans leur retard.
     */
    if (!dryRun) {
      const { publishAllForProject } = await import(
        '../../services/legal/legalDocumentPublisher.js'
      );
      const resultats = await publishAllForProject(projet.projectId);
      rapport.publications.push({
        projectKey: tenant.projectKey,
        LEGAL_NOTICE: resultats.LEGAL_NOTICE?.published
          ? `v${resultats.LEGAL_NOTICE.documentVersion}`
          : (resultats.LEGAL_NOTICE?.reason ?? 'ÉCHEC'),
        PRIVACY_POLICY: resultats.PRIVACY_POLICY?.published
          ? `v${resultats.PRIVACY_POLICY.documentVersion}`
          : (resultats.PRIVACY_POLICY?.reason ?? 'ÉCHEC'),
      });
    }
  }

  return rapport;
}

/* Exécution directe seulement — l'import reste possible pour la recette. */
if (process.argv[1]?.endsWith('2026-08-25-legal-tenants-and-assignments.js')) {
  await connectDatabase();
  const rapport = await migrateLegalTenants({ dryRun: DRY_RUN });

  logger.info(`\n════ LOCATAIRES LÉGAUX ${DRY_RUN ? '— SIMULATION' : '— APPLIQUÉE'} ════`);
  logger.info(`Environnement : ${rapport.environnement}`);
  for (const ligne of rapport.details) logger.info(`  · ${ligne}`);
  logger.info(
    `Fiches : ${rapport.fiches.creees} créée(s), ${rapport.fiches.existantes} intacte(s).`,
  );
  logger.info(
    `Rattachements : ${rapport.rattachements.faits} fait(s), ${rapport.rattachements.deja} déjà, `
    + `${rapport.rattachements.autres} autre(s) entreprise(s) — non touchés.`,
  );
  logger.info(
    `Affectations : ${rapport.affectations.faites} faite(s), ${rapport.affectations.deja} déjà.`,
  );
  for (const p of rapport.publications) {
    logger.info(
      `Publication ${p.projectKey} : mentions=${p.LEGAL_NOTICE}, privacy=${p.PRIVACY_POLICY}`,
    );
  }
  if (rapport.rattachements.projetsInconnus.length) {
    logger.warn(`Projets absents du registre : ${rapport.rattachements.projetsInconnus.join(', ')}`);
  }

  await disconnectDatabase();
  process.exit(0);
}

export default { migrateLegalTenants };
