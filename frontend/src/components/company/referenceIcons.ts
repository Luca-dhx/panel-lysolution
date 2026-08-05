/**
 * CATALOGUE D'ICÔNES DES RÉFÉRENCES — Bootstrap Icons, jeu officiel.
 *
 * ── POURQUOI UNE LISTE CHOISIE, ET NON LES 2078 ────────────────────────────
 * Le jeu complet comporte plus de deux mille glyphes, dont l'écrasante majorité
 * n'a aucun sens pour une référence d'entreprise : flèches de navigation,
 * chiffres encadrés, contrôles d'interface. Les proposer tous transformerait le
 * choix en fouille, et le nom exact d'une icône n'est pas quelque chose qu'on
 * devine.
 *
 * Ces 118 icônes couvrent ce qu'une agence publie réellement : moyens de
 * contact, réseaux, adresses, documents, paiement, service. Le champ reste
 * ouvert à n'importe quel nom `bi-*` valide — la liste guide, elle n'enferme
 * pas.
 *
 * ── LES MOTS-CLÉS ───────────────────────────────────────────────────────────
 * Les noms officiels sont anglais (`telephone`, `house`, `shop`). Chercher
 * « téléphone » ne trouverait rien. Chaque entrée porte donc ses termes
 * français : la recherche interroge le nom ET ces mots.
 *
 * ── FORMAT DES VALEURS ──────────────────────────────────────────────────────
 * Stockées AVEC le préfixe (`bi-telephone`), comme les projets les écrivent
 * déjà en base et comme la classe CSS les attend. Aucune conversion nulle part.
 */

export interface CategorieIcones {
  titre: string;
  /** Noms COMPLETS, préfixe compris. */
  icones: { nom: string; mots: string }[];
}

export const CATALOGUE_ICONES: CategorieIcones[] = [
  {
    titre: 'Contact',
    icones: [
      { nom: 'bi-telephone', mots: 'téléphone tel appel numéro' },
      { nom: 'bi-telephone-fill', mots: 'téléphone plein appel' },
      { nom: 'bi-telephone-outbound', mots: 'téléphone sortant appel direct ligne' },
      { nom: 'bi-phone', mots: 'mobile portable smartphone' },
      { nom: 'bi-whatsapp', mots: 'whatsapp messagerie' },
      { nom: 'bi-chat-dots', mots: 'chat message discussion' },
      { nom: 'bi-chat-left-text', mots: 'message texte discussion' },
      { nom: 'bi-envelope', mots: 'email mail courriel adresse' },
      { nom: 'bi-envelope-fill', mots: 'email mail plein courriel' },
      { nom: 'bi-envelope-at', mots: 'email arobase adresse mail' },
      { nom: 'bi-mailbox', mots: 'boîte aux lettres courrier' },
      { nom: 'bi-send', mots: 'envoyer message' },
      { nom: 'bi-at', mots: 'arobase mention identifiant' },
    ],
  },
  {
    titre: 'Adresse',
    icones: [
      { nom: 'bi-geo-alt', mots: 'adresse lieu localisation position' },
      { nom: 'bi-geo-alt-fill', mots: 'adresse plein lieu localisation' },
      { nom: 'bi-map', mots: 'carte plan itinéraire' },
      { nom: 'bi-pin-map', mots: 'épingle carte lieu' },
      { nom: 'bi-signpost', mots: 'panneau direction' },
      { nom: 'bi-compass', mots: 'boussole direction' },
      { nom: 'bi-house', mots: 'maison siège domicile' },
      { nom: 'bi-house-door', mots: 'maison porte accueil' },
      { nom: 'bi-building', mots: 'immeuble bureau entreprise locaux' },
      { nom: 'bi-buildings', mots: 'immeubles bureaux entreprise' },
      { nom: 'bi-shop', mots: 'boutique magasin commerce' },
      { nom: 'bi-briefcase', mots: 'mallette travail professionnel' },
      { nom: 'bi-door-open', mots: 'porte ouverte accueil visite' },
    ],
  },
  {
    titre: 'Web',
    icones: [
      { nom: 'bi-globe', mots: 'site web internet monde' },
      { nom: 'bi-globe2', mots: 'site web internet monde globe' },
      { nom: 'bi-link-45deg', mots: 'lien url adresse' },
      { nom: 'bi-browser-chrome', mots: 'navigateur site web' },
      { nom: 'bi-window', mots: 'fenêtre navigateur site' },
      { nom: 'bi-cloud', mots: 'nuage hébergement en ligne' },
    ],
  },
  {
    titre: 'Réseaux sociaux',
    icones: [
      { nom: 'bi-linkedin', mots: 'linkedin professionnel réseau' },
      { nom: 'bi-github', mots: 'github code dépôt' },
      { nom: 'bi-gitlab', mots: 'gitlab code dépôt' },
      { nom: 'bi-instagram', mots: 'instagram photo réseau' },
      { nom: 'bi-facebook', mots: 'facebook réseau' },
      { nom: 'bi-messenger', mots: 'messenger message facebook' },
      { nom: 'bi-twitter', mots: 'twitter réseau' },
      { nom: 'bi-twitter-x', mots: 'x twitter réseau' },
      { nom: 'bi-youtube', mots: 'youtube vidéo chaîne' },
      { nom: 'bi-tiktok', mots: 'tiktok vidéo réseau' },
      { nom: 'bi-discord', mots: 'discord communauté chat' },
      { nom: 'bi-slack', mots: 'slack équipe chat' },
      { nom: 'bi-skype', mots: 'skype appel visio' },
      { nom: 'bi-telegram', mots: 'telegram messagerie' },
      { nom: 'bi-pinterest', mots: 'pinterest images' },
      { nom: 'bi-behance', mots: 'behance portfolio création' },
      { nom: 'bi-dribbble', mots: 'dribbble portfolio design' },
      { nom: 'bi-medium', mots: 'medium blog article' },
      { nom: 'bi-reddit', mots: 'reddit forum' },
      { nom: 'bi-twitch', mots: 'twitch direct vidéo' },
      { nom: 'bi-vimeo', mots: 'vimeo vidéo' },
      { nom: 'bi-spotify', mots: 'spotify musique podcast' },
      { nom: 'bi-snapchat', mots: 'snapchat réseau' },
      { nom: 'bi-threads', mots: 'threads réseau' },
      { nom: 'bi-mastodon', mots: 'mastodon réseau' },
    ],
  },
  {
    titre: 'Disponibilité',
    icones: [
      { nom: 'bi-calendar-event', mots: 'agenda rendez-vous date calendrier' },
      { nom: 'bi-calendar-check', mots: 'agenda confirmé rendez-vous' },
      { nom: 'bi-clock', mots: 'horaires heure ouverture' },
      { nom: 'bi-clock-history', mots: 'historique horaires délai' },
      { nom: 'bi-alarm', mots: 'alerte réveil urgence délai' },
    ],
  },
  {
    titre: 'Personnes et assistance',
    icones: [
      { nom: 'bi-person', mots: 'personne contact interlocuteur' },
      { nom: 'bi-person-badge', mots: 'badge fonction identité' },
      { nom: 'bi-person-circle', mots: 'avatar personne profil' },
      { nom: 'bi-people', mots: 'équipe groupe personnes' },
      { nom: 'bi-person-vcard', mots: 'carte de visite contact' },
      { nom: 'bi-headset', mots: 'support assistance hotline casque' },
      { nom: 'bi-life-preserver', mots: 'aide support secours' },
      { nom: 'bi-question-circle', mots: 'aide question faq' },
      { nom: 'bi-info-circle', mots: 'information info' },
      { nom: 'bi-patch-question', mots: 'aide question support' },
    ],
  },
  {
    titre: 'Documents',
    icones: [
      { nom: 'bi-file-earmark-text', mots: 'document fichier texte' },
      { nom: 'bi-file-earmark-pdf', mots: 'pdf document fichier' },
      { nom: 'bi-folder', mots: 'dossier fichiers' },
      { nom: 'bi-journal-text', mots: 'carnet journal documentation' },
      { nom: 'bi-clipboard-check', mots: 'checklist validé presse-papier' },
      { nom: 'bi-book', mots: 'livre documentation guide' },
      { nom: 'bi-bookmark', mots: 'signet favori' },
      { nom: 'bi-tag', mots: 'étiquette catégorie' },
      { nom: 'bi-paperclip', mots: 'pièce jointe trombone' },
      { nom: 'bi-printer', mots: 'imprimante impression' },
    ],
  },
  {
    titre: 'Confiance',
    icones: [
      { nom: 'bi-star', mots: 'étoile avis note favori' },
      { nom: 'bi-star-fill', mots: 'étoile pleine avis note' },
      { nom: 'bi-heart', mots: 'coeur favori' },
      { nom: 'bi-award', mots: 'récompense certification prix' },
      { nom: 'bi-trophy', mots: 'trophée récompense' },
      { nom: 'bi-shield-check', mots: 'sécurité garantie assurance' },
      { nom: 'bi-patch-check', mots: 'certifié vérifié label' },
      { nom: 'bi-check-circle', mots: 'validé confirmé' },
    ],
  },
  {
    titre: 'Paiement',
    icones: [
      { nom: 'bi-credit-card', mots: 'carte bancaire paiement' },
      { nom: 'bi-cash-coin', mots: 'espèces argent paiement' },
      { nom: 'bi-receipt', mots: 'facture reçu ticket' },
      { nom: 'bi-wallet2', mots: 'portefeuille paiement' },
      { nom: 'bi-bank', mots: 'banque virement iban' },
      { nom: 'bi-percent', mots: 'pourcentage remise tva' },
      { nom: 'bi-ticket-perforated', mots: 'ticket bon coupon' },
    ],
  },
  {
    titre: 'Service',
    icones: [
      { nom: 'bi-truck', mots: 'livraison transport déplacement' },
      { nom: 'bi-tools', mots: 'outils intervention réparation' },
      { nom: 'bi-wrench', mots: 'clé outil maintenance' },
      { nom: 'bi-gear', mots: 'réglages engrenage technique' },
      { nom: 'bi-lightning-charge', mots: 'rapide urgence électricité' },
      { nom: 'bi-megaphone', mots: 'annonce communication' },
      { nom: 'bi-bell', mots: 'notification alerte cloche' },
      { nom: 'bi-key', mots: 'clé accès' },
      { nom: 'bi-box-seam', mots: 'colis paquet livraison' },
      { nom: 'bi-bag', mots: 'sac achat commande' },
      { nom: 'bi-cart', mots: 'panier commande achat' },
    ],
  },
  {
    titre: 'Divers',
    icones: [
      { nom: 'bi-graph-up', mots: 'croissance statistiques performance' },
      { nom: 'bi-bar-chart', mots: 'graphique statistiques' },
      { nom: 'bi-pie-chart', mots: 'camembert statistiques répartition' },
      { nom: 'bi-speedometer2', mots: 'performance vitesse tableau de bord' },
      { nom: 'bi-camera', mots: 'photo appareil' },
      { nom: 'bi-mic', mots: 'micro podcast audio' },
      { nom: 'bi-cup-hot', mots: 'café pause rencontre' },
      { nom: 'bi-emoji-smile', mots: 'sourire satisfaction' },
      { nom: 'bi-hand-thumbs-up', mots: 'pouce validation satisfaction' },
      { nom: 'bi-three-dots', mots: 'autre divers points' },
    ],
  },
];

/** L'icône par défaut d'une nouvelle référence. */
export const ICONE_PAR_DEFAUT = 'bi-star';

/** Toutes les icônes du catalogue, à plat — pour la recherche. */
export const TOUTES_LES_ICONES = CATALOGUE_ICONES.flatMap((c) =>
  c.icones.map((i) => ({ ...i, categorie: c.titre })),
);

/**
 * Filtre le catalogue sur une recherche libre.
 *
 * La casse et les accents sont ignorés : quelqu'un qui tape « telephone » sans
 * accent cherche la même chose que « téléphone ». Une requête vide rend tout,
 * groupé par catégorie — c'est la vue de parcours, pas un état d'erreur.
 */
export function chercherIcones(requete: string): CategorieIcones[] {
  const q = normaliser(requete);
  if (!q) return CATALOGUE_ICONES;
  return CATALOGUE_ICONES
    .map((c) => ({
      titre: c.titre,
      icones: c.icones.filter((i) => normaliser(`${i.nom} ${i.mots}`).includes(q)),
    }))
    .filter((c) => c.icones.length > 0);
}

function normaliser(v: string): string {
  // Plage des diacritiques combinants, en échappé : les caractères eux-mêmes
  // seraient invisibles dans le source, donc impossibles à relire.
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
