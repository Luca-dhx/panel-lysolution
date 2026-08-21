// L'ENTREPRISE CLIENTE — l'entité JURIDIQUE à qui L.Y Solution facture.
//
// ══ CE QU'ELLE N'EST PAS, ET IL FAUT COMMENCER PAR LÀ ═══════════════════════
//
// Le Panel manipulait déjà cinq notions voisines, et les confondre a un coût
// immédiat sur une facture :
//
//   PanelCompany            L.Y SOLUTION elle-même — le tenant, le VENDEUR.
//   PanelProject            une INSTANCE technique appairée. Un produit.
//   PanelProjectContract    la projection d'un ENGAGEMENT commercial.
//   PanelUser               un compte qui se connecte au Panel.
//   Stripe Customer         une PROJECTION fournisseur de l'entreprise cliente.
//
// Aucune des cinq ne répond à « à quelle personne morale adresse-t-on cette
// facture ? ». Le code y répondait donc par défaut, et le défaut était
// `projection.reference` — la RÉFÉRENCE DE CONTRAT. La facture QWSK7ZZY-0004
// portait ainsi « Facturer à : CTR-2026-0002 », ce qui n'est ni une raison
// sociale, ni une adresse, ni quoi que ce soit qu'un comptable puisse écrire
// dans un livre.
//
// ══ POURQUOI UNE COLLECTION, ET NON UN BLOC SUR LE PROJET ═══════════════════
//
// Parce qu'une entreprise cliente possède PLUSIEURS projets — c'est le cas
// nominal, pas l'exception. Le porter sur le projet obligerait à recopier la
// même identité légale autant de fois qu'il y a de sites, et un changement
// d'adresse deviendrait une opération de masse dont on ne saurait jamais dire
// si elle a été complète.
//
//     ClientCompany  1 ──── N  PanelProject
//
// ══ CE MODÈLE EST L'AUTORITÉ, IL N'EST PAS L'HISTOIRE ═══════════════════════
//
// Il porte l'identité COURANTE. Les documents déjà émis — factures, contrats,
// demandes de signature — n'en dépendent jamais : ils portent un INSTANTANÉ
// figé au moment de l'acte (`clientLegalSnapshot.js`). Une entreprise qui
// déménage ne réécrit pas ses factures de l'an dernier.
//
// ══ FACTURATION ÉLECTRONIQUE — CE QUI EST PRÉPARÉ ICI ═══════════════════════
//
// À compter du 1er septembre 2026, le SIREN du client compte parmi les
// mentions obligatoires de la facture électronique française. Les données
// STRUCTURÉES qu'exigera ce chantier sont donc présentes dès maintenant —
// SIREN séparé du SIRET, adresse décomposée, numéro de TVA intracommunautaire,
// pays en code ISO. Ce lot ne construit AUCUNE plateforme de dématérialisation
// et n'en préjuge pas : il s'assure seulement qu'aucune donnée ne manquera.
import mongoose from 'mongoose';

/**
 * UNE ADRESSE POSTALE — décomposée, jamais une chaîne libre.
 *
 * ── POURQUOI PAS UN CHAMP TEXTE ─────────────────────────────────────────────
 *
 * Parce que Stripe attend `address[line1]`, `address[postal_code]`,
 * `address[city]`, `address[country]` — et qu'une facture électronique exigera
 * la même décomposition. Recoller puis redécouper une chaîne libre est une
 * heuristique : elle marche sur « 12 rue des Lilas, 06000 Nice » et échoue sur
 * la première adresse qui porte un lieu-dit, un bâtiment ou un CEDEX.
 *
 * `country` est un code ISO 3166-1 alpha-2 en majuscules — c'est ce que le
 * fournisseur exige, et ce qu'une facture doit porter.
 */
const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, default: null, trim: true },
    line2: { type: String, default: null, trim: true },
    postalCode: { type: String, default: null, trim: true },
    city: { type: String, default: null, trim: true },
    country: { type: String, default: 'FR', trim: true, uppercase: true },
  },
  { _id: false },
);

/**
 * LE SIGNATAIRE CONTRACTUEL DU CLIENT — la personne physique qui l'engage.
 *
 * ══ POURQUOI IL VIT ICI, ET PLUS DANS LE PROJET ═════════════════════════════
 *
 * Il était configuré dans le Manager de chaque projet (`Company.signer`, côté
 * SB Auto). Deux conséquences, et les deux se sont produites :
 *
 *   · un même client possédant deux sites pouvait déclarer deux signataires
 *     différents pour la même personne morale — et personne n'aurait su lequel
 *     engageait réellement l'entreprise ;
 *   · le CLIENT décidait de l'identité qui signe le contrat que L.Y Solution
 *     lui présente. Un signataire n'est pas une préférence d'affichage.
 *
 * L'autorité est donc le Panel, et le projet le REÇOIT. C'est exactement la
 * même bascule que celle du signataire développeur (`PanelCompany.signer`),
 * pour la même raison.
 *
 * Reste vide tant qu'il n'est pas renseigné : une signature sera alors REFUSÉE,
 * ce qui vaut infiniment mieux qu'un signataire deviné depuis un compte
 * utilisateur — un compte sert à se connecter, pas à engager une société.
 */
const contractualSignerSchema = new mongoose.Schema(
  {
    firstName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    /** La fonction telle qu'elle figurera au contrat. Courtoisie, jamais requise. */
    jobTitle: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    /**
     * Le téléphone n'est demandé que si un fournisseur de signature l'exige
     * réellement (relance SMS, authentification forte). Aucun des parcours
     * actuels ne l'utilise : il reste donc facultatif, et vide par défaut.
     */
    phone: { type: String, default: '', trim: true },
  },
  { _id: false },
);

/**
 * UN DOCUMENT ADMINISTRATIF DE L'ENTREPRISE — le LIEN, jamais les octets.
 *
 * Les octets vivent dans le protocole Media PRIVÉ du Panel (`PanelMedia`,
 * `visibility: PRIVATE`), exactement comme les justificatifs de coût. Ce
 * sous-document ne porte que le rattachement et ce qu'un écran doit afficher
 * sans ouvrir le fichier.
 *
 * ── POURQUOI `type` EST LIBRE ET NON UNE ÉNUMÉRATION FERMÉE ─────────────────
 *
 * Kbis, attestation de vigilance, mandat SEPA, RIB, statuts, pouvoir de
 * signature, attestation d'assurance… La liste n'est pas connue d'avance et
 * change selon le client. Une énumération fermée aurait obligé à livrer du code
 * pour accepter un document, et la première urgence l'aurait contournée en
 * déposant le fichier sous une mauvaise étiquette. Le champ est donc une
 * catégorie LIBRE et FACULTATIVE, bornée en longueur.
 */
const documentSchema = new mongoose.Schema(
  {
    documentId: { type: String, required: true },
    /** Le média privé qui porte les octets. Jamais une URL : il n'en a pas. */
    mediaId: { type: String, required: true },
    /** Le nom donné par l'opérateur — distinct du nom de fichier déposé. */
    label: { type: String, required: true, trim: true },
    /** Catégorie libre : `KBIS`, `RIB`, `MANDAT`… ou rien. */
    type: { type: String, default: null, trim: true },
    /** La date du DOCUMENT (émission du Kbis…), pas celle du dépôt. */
    documentDate: { type: String, default: null },
    uploadedAt: { type: String, required: true },
    uploadedBy: { type: String, default: null },
  },
  { _id: false },
);

/**
 * LES ÉTATS D'UNE ENTREPRISE CLIENTE.
 *
 *   ACTIVE    relation en cours — tout est permis.
 *   ARCHIVED  relation terminée. La fiche reste entièrement lisible, ses
 *             projets et ses factures aussi ; aucune opération NOUVELLE ne
 *             s'appuie plus sur elle.
 *
 * Il n'y a délibérément pas de troisième état. « Prospect », « suspendu »,
 * « en litige » sont des qualifications commerciales qui n'ont, à ce jour,
 * aucune conséquence technique : les inventer ici obligerait chaque garde à
 * décider ce qu'elle en fait, sans qu'aucune règle ne l'ait tranché.
 */
export const CLIENT_COMPANY_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
});

export const CLIENT_COMPANY_STATUS_VALUES = Object.freeze(
  Object.values(CLIENT_COMPANY_STATUS),
);

const clientCompanySchema = new mongoose.Schema(
  {
    /** Identité technique OPAQUE, stable à vie, jamais dérivée du nom. */
    clientCompanyId: { type: String, required: true, unique: true },

    /* ── IDENTITÉ LÉGALE ─────────────────────────────────────────────── */

    /**
     * LA RAISON SOCIALE — ce qui s'écrit sur une facture, au registre du
     * commerce et sur un contrat. C'est le SEUL champ d'identité obligatoire :
     * sans lui il n'y a pas de personne morale à facturer.
     */
    legalName: { type: String, required: true, trim: true },
    /**
     * LE NOM COMMERCIAL — celui que les clients du client connaissent.
     *
     * « SB Auto 06 » peut être l'enseigne d'une « SARL DUPONT AUTOMOBILES ».
     * L'écran affiche l'enseigne quand elle existe ; la FACTURE affiche
     * toujours la raison sociale. Confondre les deux produirait une facture
     * adressée à une entité qui n'existe pas juridiquement.
     */
    tradingName: { type: String, default: null, trim: true },
    /** SAS, SARL, EURL, SASU, EI… Texte libre : la liste française est longue. */
    legalForm: { type: String, default: null, trim: true },

    /**
     * SIREN — 9 chiffres, l'identifiant de la PERSONNE MORALE.
     *
     * ── POURQUOI IL EST STOCKÉ SÉPARÉMENT DU SIRET ──────────────────────
     *
     * Le SIRET identifie un ÉTABLISSEMENT (SIREN + 5 chiffres de NIC). Une
     * entreprise en possède autant qu'elle a de sites, et il change quand elle
     * déménage. C'est le SIREN qui l'identifie durablement, et c'est lui que
     * la facture électronique exigera à compter du 1er septembre 2026.
     *
     * Le déduire du SIRET (`siret.slice(0, 9)`) aurait été tentant. Ce serait
     * rendre le SIRET obligatoire pour obtenir le SIREN, alors que c'est
     * l'inverse qui est vrai : on connaît toujours le SIREN, rarement le SIRET.
     */
    siren: { type: String, default: null, trim: true },
    /** SIRET — 14 chiffres, l'établissement. Facultatif. */
    siret: { type: String, default: null, trim: true },
    /** Numéro de TVA intracommunautaire (`FR` + clé + SIREN). Facultatif. */
    vatNumber: { type: String, default: null, trim: true },
    /** Ville du greffe d'immatriculation — mention légale usuelle. */
    registrationCity: { type: String, default: null, trim: true },

    /* ── ADRESSES ────────────────────────────────────────────────────── */

    /** Le SIÈGE SOCIAL — l'adresse juridique. Toujours celle du registre. */
    registeredOffice: { type: addressSchema, default: () => ({}) },
    /**
     * L'ADRESSE DE FACTURATION, quand elle diffère du siège.
     *
     * `null` ne signifie PAS « inconnue » : il signifie « la même que le
     * siège ». C'est le cas de l'immense majorité des TPE, et leur imposer une
     * double saisie aurait garanti que les deux finissent par diverger.
     */
    billingAddress: { type: addressSchema, default: null },

    /* ── COORDONNÉES ─────────────────────────────────────────────────── */

    /**
     * L'ADRESSE DE FACTURATION ÉLECTRONIQUE — celle qui reçoit les factures.
     *
     * Distincte du contact administratif : une facture part souvent vers une
     * boîte comptable que personne ne consulte pour autre chose.
     */
    billingEmail: { type: String, default: null, trim: true, lowercase: true },
    phone: { type: String, default: null, trim: true },
    website: { type: String, default: null, trim: true },
    /** Le contact administratif — un humain, quand il n'est pas le signataire. */
    administrativeContact: {
      name: { type: String, default: null, trim: true },
      email: { type: String, default: null, trim: true, lowercase: true },
      phone: { type: String, default: null, trim: true },
    },

    /* ── SIGNATURE ───────────────────────────────────────────────────── */

    contractualSigner: { type: contractualSignerSchema, default: null },

    /* ── DOCUMENTS ───────────────────────────────────────────────────── */

    documents: { type: [documentSchema], default: [] },

    /* ── EXPLOITATION ────────────────────────────────────────────────── */

    status: {
      type: String,
      enum: CLIENT_COMPANY_STATUS_VALUES,
      default: CLIENT_COMPANY_STATUS.ACTIVE,
      index: true,
    },
    /** Note interne de gestion. JAMAIS publiée à un projet, jamais facturée. */
    notes: { type: String, default: null },

    /**
     * TEST ou PROD — une entreprise cliente ne franchit jamais la frontière.
     *
     * Même règle que pour `PanelCompany` et `PanelMedia` : les deux mondes ont
     * leur base et leurs comptes fournisseurs. Une fiche de recette rattachée à
     * un projet de production ferait facturer un vrai client au nom d'une
     * société d'essai.
     */
    environment: { type: String, enum: ['TEST', 'PROD'], required: true, index: true },

    /**
     * LA VERSION PUBLIÉE — celle que les projets rattachés ont reçue.
     *
     * Elle sert exactement à ce que sert `PanelCompany.publishedVersion` :
     * permettre à l'applicateur du projet d'écarter une écriture plus ancienne
     * que celle qu'il applique déjà, après un rattrapage désordonné. Elle
     * s'incrémente à CHAQUE enregistrement — l'entreprise cliente n'a pas de
     * brouillon : la corriger, c'est la publier.
     */
    publishedVersion: { type: Number, default: 0 },
    publishedAt: { type: String, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * RECHERCHE PAR NOM ET PAR SIREN — les deux entrées de l'écran « Clients ».
 *
 * L'index sur `siren` n'est PAS unique, et c'est délibéré : deux fiches d'un
 * même SIREN sont une anomalie de saisie, pas une impossibilité. Un index
 * unique aurait fait échouer l'enregistrement avec une erreur de base
 * illisible ; le service, lui, avertit en nommant la fiche existante.
 */
clientCompanySchema.index({ environment: 1, status: 1, legalName: 1 });
clientCompanySchema.index({ environment: 1, siren: 1 });

export default mongoose.model('PanelClientCompany', clientCompanySchema);
