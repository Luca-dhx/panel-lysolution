/**
 * CE QUE LE PORTAIL CLIENT A LE DROIT DE FAIRE — et ce qu'il ne l'aura jamais.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * Le Panel ouvrait des sessions de portail SANS désigner de configuration.
 * Stripe applique alors celle qui est PAR DÉFAUT SUR LE COMPTE — celle qu'un
 * exploitant a réglée un jour dans le tableau de bord, que personne ne relit,
 * et qui change sans qu'aucun code ne bouge.
 *
 * Mesure faite sur le compte de recette avant ce lot :
 *
 *     customer_update : ACTIVÉ  ·  name, email, address, phone
 *
 * Autrement dit : le client pouvait, depuis le portail Stripe, réécrire sa
 * raison sociale, son adresse et son e-mail de facturation. Ces quatre champs
 * appartiennent à `PanelClientCompany`, qui est l'autorité de l'identité
 * juridique et la source dont le client Stripe est la PROJECTION. Le portail
 * devenait donc une SECONDE autorité, en écriture, sur des données légales —
 * et la divergence n'aurait été découverte que sur une facture.
 *
 * ══ LE SENS DE LA FLÈCHE, ET IL NE S'INVERSE JAMAIS ═════════════════════════
 *
 *     PanelClientCompany  ──▶  Stripe Customer
 *
 * Jamais l'inverse. Ce module n'écrit aucune synchronisation retour : il RETIRE
 * au portail le pouvoir d'écrire. C'est la seule correction qui ne crée pas une
 * troisième vérité — refléter les modifications du portail vers la fiche
 * légale aurait fait du client l'éditeur de son propre SIREN.
 *
 * ══ CE QUE LE PORTAIL GARDE ═════════════════════════════════════════════════
 *
 * Un self-service FINANCIER, et il est légitime :
 *
 *   · changer sa carte — le moyen de paiement est une donnée TECHNIQUE dont
 *     Stripe est l'autorité, et que le Panel ne détient pas ;
 *   · consulter et payer ses factures — le pipeline d'encaissement existant
 *     les traite exactement comme les autres ;
 *   · résilier — un droit contractuel, et le refuser au portail obligerait le
 *     client à écrire un courrier pour exercer un droit qu'il a.
 *
 * ══ CE QUE LE PORTAIL PERD ══════════════════════════════════════════════════
 *
 * Tout ce qui ferait DIVERGER un contrat signé :
 *
 *   · l'identité juridique et fiscale — elle appartient à la fiche client ;
 *   · le tarif, le plan, la quantité, la périodicité, les codes promo. Le
 *     contrat porte déjà HT, TVA, TTC, récurrence et conditions ; laisser le
 *     client changer de Price depuis un portail créerait un avenant que
 *     personne n'a signé, et le Panel facturerait un montant qui ne figure
 *     dans aucun document.
 *
 * ══ POURQUOI UNE RÉSILIATION EN FIN DE PÉRIODE ══════════════════════════════
 *
 * La période est PAYÉE. L'interrompre immédiatement retirerait un service déjà
 * réglé, et poserait la question du remboursement du prorata — une décision
 * commerciale qu'aucun clic de portail ne doit prendre. `at_period_end` sert
 * jusqu'au terme, puis s'arrête : c'est ce que le client a acheté.
 *
 * Module PUR : aucune E/S. Il décrit une cible et sait dire ce qui s'en écarte.
 */

/**
 * LA MARQUE QUI DIT « CETTE CONFIGURATION EST LA NÔTRE ».
 *
 * ══ POURQUOI ELLE EST INDISPENSABLE ═════════════════════════════════════════
 *
 * Un compte Stripe peut porter plusieurs configurations de portail — une par
 * marque, une héritée d'un essai, une créée à la main. Modifier « celle qui est
 * par défaut » reviendrait à choisir au hasard, et à écraser un réglage qui ne
 * nous appartient peut-être pas.
 *
 * Le Panel reconnaît donc la SIENNE par ses métadonnées, la crée si elle
 * n'existe pas, et ne touche à aucune autre. Le même geste que l'endpoint
 * webhook (L6.3A) : on garantit ce dont on a besoin, on ne s'approprie rien.
 */
export const PORTAL_MANAGED_BY = 'PANEL_CONTROL_PLANE';
export const PORTAL_ROLE = 'PROJECT_BILLING_SELF_SERVICE';

/** Les métadonnées apposées sur NOTRE configuration, et par lesquelles on la retrouve. */
export const PORTAL_METADATA = Object.freeze({
  managedBy: PORTAL_MANAGED_BY,
  role: PORTAL_ROLE,
});

/**
 * LA CIBLE — ce que la configuration DOIT dire, champ par champ.
 *
 * Écrite en toutes lettres plutôt qu'en fragments dispersés : c'est ce tableau
 * qu'on relira le jour où quelqu'un demandera « le client peut-il changer son
 * adresse ? », et la réponse doit tenir sur une ligne.
 */
export const PORTAL_TARGET = Object.freeze({
  /** L'IDENTITÉ LÉGALE APPARTIENT À LA FICHE CLIENT. Le portail ne l'écrit pas. */
  customerUpdate: false,
  /** Le moyen de paiement est une donnée technique — Stripe en est l'autorité. */
  paymentMethodUpdate: true,
  /** Consulter et télécharger ses factures : un droit, sans effet de bord. */
  invoiceHistory: true,
  /** Résilier : un droit contractuel. */
  subscriptionCancel: true,
  /** …mais à l'ÉCHÉANCE : la période en cours est payée. */
  subscriptionCancelMode: 'at_period_end',
  /** Aucun prorata décidé par un clic. */
  subscriptionCancelProration: 'none',
  /** CHANGER D'OFFRE FERAIT DIVERGER UN CONTRAT SIGNÉ. */
  subscriptionUpdate: false,
});

/**
 * LES PARAMÈTRES ENVOYÉS À STRIPE — la cible, traduite dans son vocabulaire.
 *
 * ══ POURQUOI CHAQUE DRAPEAU EST ÉCRIT, MÊME QUAND IL VAUT `false` ═══════════
 *
 * Un champ omis n'est pas un champ désactivé : sur une MISE À JOUR, Stripe
 * conserve la valeur précédente. Omettre `customer_update` sur une
 * configuration qui l'autorisait déjà la laisserait telle quelle — et la
 * correction n'aurait rien corrigé, en silence.
 *
 * On énonce donc l'état COMPLET à chaque fois. C'est aussi ce qui rend la
 * convergence vraie : deux appels successifs produisent le même objet.
 *
 * @param {{ businessProfileUrl?: string|null, privacyUrl?: string|null,
 *   termsUrl?: string|null, headline?: string|null }} [marque]
 */
export function portalConfigurationParams(marque = {}) {
  const params = {
    /**
     * `customer_update.enabled: false` EXIGE `allowed_updates: []`.
     *
     * Stripe refuse une désactivation qui laisserait des champs autorisés
     * derrière elle — et il a raison : l'objet dirait deux choses à la fois.
     */
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: PORTAL_TARGET.subscriptionCancelMode,
        proration_behavior: PORTAL_TARGET.subscriptionCancelProration,
        /**
         * AUCUNE ENQUÊTE DE DÉPART.
         *
         * Le portail n'est pas un formulaire marketing, et une question posée
         * au moment d'une résiliation se lit comme un obstacle.
         *
         * ══ POURQUOI `options` EST QUAND MÊME ÉNUMÉRÉ ═════════════════════
         *
         * Stripe l'exige, même désactivé — mesuré : `Missing required param:
         * features[subscription_cancel][cancellation_reason][options]`. Le
         * champ décrit la FORME du questionnaire ; `enabled: false` décide
         * qu'il ne s'affiche pas. On fournit donc la liste minimale que
         * l'API accepte, et personne ne la voit.
         */
        cancellation_reason: {
          enabled: false,
          options: ['too_expensive', 'missing_features', 'unused', 'other'],
        },
      },
      subscription_update: { enabled: false },
    },
    metadata: PORTAL_METADATA,
  };

  /**
   * LE PROFIL D'ENTREPRISE — facultatif, et jamais inventé.
   *
   * Stripe exige au moins une adresse (conditions ou confidentialité) pour
   * ACTIVER une configuration en production. En recette il l'accepte sans.
   * On ne publie donc que ce que l'appelant nous donne : fabriquer une URL de
   * conditions générales serait afficher au client un lien qui ne mène nulle
   * part, sur l'écran où il résilie.
   */
  const profil = {};
  if (marque.headline) profil.headline = String(marque.headline).slice(0, 60);
  if (marque.privacyUrl) profil.privacy_policy_url = marque.privacyUrl;
  if (marque.termsUrl) profil.terms_of_service_url = marque.termsUrl;
  if (Object.keys(profil).length > 0) params.business_profile = profil;

  return params;
}

/** Cette configuration porte-t-elle NOTRE marque ? */
export function isPanelPortalConfiguration(configuration) {
  const meta = configuration?.metadata ?? {};
  return meta.managedBy === PORTAL_MANAGED_BY && meta.role === PORTAL_ROLE;
}

/**
 * CE QUI S'ÉCARTE DE LA CIBLE — nommé, jamais réduit à un booléen.
 *
 * ══ POURQUOI UNE LISTE DE MOTIFS ════════════════════════════════════════════
 *
 * « La configuration est incorrecte » n'aide personne. « `customer_update`
 * autorise name, address » désigne le champ, la valeur, et le risque. C'est
 * cette phrase-là qu'un exploitant lira dans un journal, et c'est elle qui doit
 * suffire à comprendre ce que le client pouvait faire.
 *
 * ══ SEUL `enabled` FAIT FOI, ET C'EST UNE MESURE ════════════════════════════
 *
 * Dérive provoquée à la main sur le compte de recette, puis réalignée par le
 * chemin normal :
 *
 *   avant   customer_update  enabled=false  allowed_updates=[]
 *   dérive  customer_update  enabled=true   allowed_updates=[name,address,tax_id]
 *   après   customer_update  enabled=false  allowed_updates=[name,address,tax_id]
 *
 * Stripe CONSERVE la liste des champs quand la fonctionnalité est désactivée,
 * bien que le réalignement envoie `allowed_updates: []`. La liste résiduelle
 * n'accorde rien — le portail n'affiche pas la section — mais elle ne doit pas
 * compter comme un écart : la signaler déclencherait un réalignement à chaque
 * ouverture, que Stripe n'appliquerait jamais. On ne juge donc que `enabled`,
 * et une réactivation depuis le tableau de bord reste attrapée à coup sûr.
 *
 * @returns {string[]} vide si la configuration est conforme.
 */
export function portalConfigurationDrift(configuration) {
  const f = configuration?.features ?? {};
  const ecarts = [];

  const cu = f.customer_update ?? {};
  if (cu.enabled === true) {
    const champs = Array.isArray(cu.allowed_updates) ? cu.allowed_updates : [];
    ecarts.push(
      `customer_update ACTIVÉ (${champs.join(', ') || 'aucun champ listé'}) — `
      + 'l’identité légale appartient à la fiche client, jamais au portail.',
    );
  }

  if (f.payment_method_update?.enabled !== true) {
    ecarts.push('payment_method_update désactivé — le client ne pourrait plus changer sa carte.');
  }
  if (f.invoice_history?.enabled !== true) {
    ecarts.push('invoice_history désactivé — le client ne pourrait plus consulter ses factures.');
  }

  const sc = f.subscription_cancel ?? {};
  if (sc.enabled !== true) {
    ecarts.push('subscription_cancel désactivé — la résiliation est un droit contractuel.');
  } else if (sc.mode !== PORTAL_TARGET.subscriptionCancelMode) {
    ecarts.push(
      `subscription_cancel.mode = « ${sc.mode} » — la période en cours est payée, `
      + 'elle doit être servie jusqu’à son terme.',
    );
  }

  if (f.subscription_update?.enabled === true) {
    const updates = Array.isArray(f.subscription_update.default_allowed_updates)
      ? f.subscription_update.default_allowed_updates : [];
    ecarts.push(
      `subscription_update ACTIVÉ (${updates.join(', ') || 'sans liste'}) — `
      + 'changer d’offre créerait un avenant que personne n’a signé.',
    );
  }

  return ecarts;
}

/**
 * VUE NORMALISÉE — ce qu'un écran ou un journal a besoin de savoir.
 *
 * Aucun objet Stripe brut ne traverse : la forme de leur réponse est la leur, et
 * la recopier ferait entrer leur vocabulaire dans nos écrans.
 */
export function describePortalConfiguration(configuration) {
  const f = configuration?.features ?? {};
  return {
    configurationId: configuration?.id ?? null,
    isDefault: configuration?.is_default === true,
    active: configuration?.active === true,
    managed: isPanelPortalConfiguration(configuration),
    features: {
      customerUpdate: f.customer_update?.enabled === true,
      customerUpdateFields: Array.isArray(f.customer_update?.allowed_updates)
        ? [...f.customer_update.allowed_updates] : [],
      paymentMethodUpdate: f.payment_method_update?.enabled === true,
      invoiceHistory: f.invoice_history?.enabled === true,
      subscriptionCancel: f.subscription_cancel?.enabled === true,
      subscriptionCancelMode: f.subscription_cancel?.mode ?? null,
      subscriptionUpdate: f.subscription_update?.enabled === true,
    },
    drift: portalConfigurationDrift(configuration),
  };
}

export default {
  PORTAL_MANAGED_BY,
  PORTAL_ROLE,
  PORTAL_METADATA,
  PORTAL_TARGET,
  portalConfigurationParams,
  isPanelPortalConfiguration,
  portalConfigurationDrift,
  describePortalConfiguration,
};
