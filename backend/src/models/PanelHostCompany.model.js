// L'ENTREPRISE HÉBERGEUSE — une DONNÉE, jamais un paragraphe de mentions légales.
//
// ══ POURQUOI CE N'EST PAS UN CHAMP TEXTE ════════════════════════════════════
//
// `PanelCompany.legal.hostingProvider` existait déjà : une chaîne libre, qu'on
// remplissait avec « Hostinger » ou avec un pavé d'adresse selon l'humeur du
// jour. Trois conséquences, et les trois se sont produites ailleurs dans ce
// dépôt à chaque fois qu'une chaîne libre a tenu lieu de structure :
//
//   · rien n'est réutilisable — on ne peut ni afficher l'adresse seule, ni la
//     comparer, ni savoir si elle est à jour ;
//   · rien n'est vérifiable — « Hostinger » ne dit pas QUELLE entité contracte,
//     et le groupe en compte cinq selon le pays du client ;
//   · rien n'est traçable — personne ne sait d'où vient la valeur ni quand elle
//     a été contrôlée pour la dernière fois.
//
// Ce modèle porte donc des CHAMPS, plus `source` et `verifiedAt` : une donnée
// juridique recopiée d'un site tiers doit dire d'où elle vient, sinon personne
// ne saura la revérifier le jour où elle change.
//
// Le champ historique reste en place et sans lecteur : le supprimer effacerait
// une saisie manuelle au premier enregistrement d'une fiche existante.
//
// ══ UNE COLLECTION, PAS UN SINGLETON ════════════════════════════════════════
//
// Le parc est hébergé chez un seul fournisseur aujourd'hui. Il en aura deux le
// jour d'une migration, et les deux devront coexister le temps qu'elle dure —
// c'est précisément le moment où l'on ne veut pas éditer un singleton à la
// main. Le rattachement d'un projet à son hébergeur passe par
// `PanelHostCompany.active`, résolu au moment de la publication : la bascule
// mono → multi sera une question de résolution, pas de migration.
import mongoose from 'mongoose';

/**
 * L'ADRESSE — décomposée, comme partout ailleurs dans ce Panel.
 *
 * Même raison que pour `PanelClientCompany` : recoller puis redécouper une
 * chaîne libre est une heuristique qui échoue sur la première adresse portant
 * un bâtiment, un étage ou un code postal étranger. Celle de Hostinger en
 * porte deux sur trois.
 */
const hostAddressSchema = new mongoose.Schema(
  {
    line1: { type: String, default: null, trim: true },
    line2: { type: String, default: null, trim: true },
    postalCode: { type: String, default: null, trim: true },
    city: { type: String, default: null, trim: true },
    /** Nom du pays en clair — il s'AFFICHE sur des mentions légales. */
    country: { type: String, default: null, trim: true },
    /** Code ISO 3166-1 alpha-2, pour les traitements. Jamais affiché seul. */
    countryCode: { type: String, default: null, trim: true, uppercase: true },
  },
  { _id: false },
);

export const HOST_COMPANY_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
});

export const HOST_COMPANY_STATUS_VALUES = Object.freeze(Object.values(HOST_COMPANY_STATUS));

const hostCompanySchema = new mongoose.Schema(
  {
    /** Identité technique opaque, stable à vie, jamais dérivée du nom. */
    hostCompanyId: { type: String, required: true, unique: true },

    /** La dénomination exacte, telle qu'elle s'écrira sur une page publique. */
    legalName: { type: String, required: true, trim: true },
    /** Le nom d'usage — « Hostinger » pour « HOSTINGER INTERNATIONAL LIMITED ». */
    tradingName: { type: String, default: null, trim: true },
    legalForm: { type: String, default: null, trim: true },
    /**
     * L'IDENTIFIANT AU REGISTRE — volontairement pas « SIREN ».
     *
     * L'hébergeur n'est pas nécessairement français : Hostinger contracte
     * depuis Chypre pour les clients de l'Union. Un champ nommé `siren`
     * aurait forcé, tôt ou tard, à y écrire un numéro chypriote — et la
     * première validation de format l'aurait rejeté.
     */
    registrationNumber: { type: String, default: null, trim: true },

    address: { type: hostAddressSchema, default: () => ({}) },

    email: { type: String, default: null, trim: true, lowercase: true },
    phone: { type: String, default: null, trim: true },
    website: { type: String, default: null, trim: true },

    /**
     * ── LA TRAÇABILITÉ, ET POURQUOI ELLE EST DANS LE MODÈLE ────────────────
     *
     * `source` porte l'ADRESSE de la page qui fait foi ; `verifiedAt` la date
     * du dernier contrôle. Sans eux, une identité juridique recopiée d'un site
     * tiers devient, en six mois, une valeur que plus personne n'ose toucher
     * parce que personne ne sait plus d'où elle vient — et qu'on ne peut donc
     * ni confirmer ni corriger.
     *
     * Ils ne sont JAMAIS publiés à un projet : ce sont des données
     * d'exploitation, pas du contenu.
     */
    source: { type: String, default: null, trim: true },
    verifiedAt: { type: String, default: null },
    notes: { type: String, default: null },

    status: {
      type: String,
      enum: HOST_COMPANY_STATUS_VALUES,
      default: HOST_COMPANY_STATUS.ACTIVE,
    },

    /**
     * TEST ou PROD — même frontière que pour toutes les entités du Panel.
     *
     * Elle peut sembler excessive pour un hébergeur (c'est le même dans les
     * deux mondes). Elle ne l'est pas : une instance de recette qui lirait la
     * fiche de production publierait une donnée de production sur un site
     * d'essai, et l'inverse est pire. La règle est uniforme, donc personne n'a
     * à se demander si celle-ci fait exception.
     */
    environment: { type: String, enum: ['TEST', 'PROD'], required: true },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * LA RÉSOLUTION DE L'HÉBERGEUR COURANT — `{environment, status}`.
 *
 * C'est la seule requête chaude du modèle : elle est exécutée à chaque
 * publication d'un document légal. Sans index, elle balaierait la collection —
 * minuscule aujourd'hui, mais c'est le genre de balayage qu'on n'ajoute jamais
 * après coup parce qu'il ne fait jamais mal assez tôt.
 */
hostCompanySchema.index({ environment: 1, status: 1, legalName: 1 });

export default mongoose.model('PanelHostCompany', hostCompanySchema);
