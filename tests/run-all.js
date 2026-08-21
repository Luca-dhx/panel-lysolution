// Enchaîne toute la suite (équivalent du `npm test` chaîné du projet modèle).
// Chaque test est un processus séparé : isolation totale des stores en RAM.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

const TESTS = [
  'config.test.js',
  // ISOLATION DES BASES — placée avant tout, parce qu'une suite qui écrit au
  // mauvais endroit ne se contente pas d'être fausse : elle abîme le parc.
  //
  // Sept projets de recette ont vécu quatre jours dans la base Atlas partagée,
  // indiscernables de vrais clients dans le registre du Panel. La cause n'était
  // pas un nettoyage manqué mais une ADRESSE autorisée : le harnais conservait
  // une `MONGODB_URI` héritée de l'environnement, et le nom de base était écrit
  // en dur — celui de la base partagée.
  'test-database-isolation.test.js',
  // HYGIÈNE DES SECRETS — aussi haut que l'isolation des bases, et pour la même
  // raison : ce qui fuit d'un dépôt ne se rattrape pas en aval.
  //
  // GitHub Secret Scanning a déclenché une alerte « Stripe Webhook Signing
  // Secret » sur une SENTINELLE de test. Aucun secret réel — et pourtant
  // l'alerte était fondée : un scanner reconnaît un MOTIF, pas une intention.
  // Le bruit d'une fausse alerte se paie sur l'attention accordée à la
  // suivante.
  'secret-hygiene.test.js',
  // DISPONIBILITÉ DU SERVICE — « vivant » n'est pas « prêt ». Le port s'ouvre
  // avant l'amorçage ; les sondes répondent tout de suite ; les routes métier
  // refusent en 503 + code stable tant que les dépendances manquent. Placée
  // tôt : si le socle de disponibilité est faux, tout le reste ment.
  'readiness.test.js',
  'auth.test.js',
  // RÉSILIENCE DE SESSION — qui a le droit de déconnecter, et qui ne l'a pas.
  // Éprouve l'invariant du lot : seule une invalidité PROUVÉE efface un jeton.
  // Un 500, un 502, un 503, une panne réseau ou un redémarrage backend ne le
  // peuvent pas. Elle charge le VRAI client HTTP du frontend, pas une copie.
  'auth-resilience.test.js',
  'password-reset.test.js',
  // L12.A — LE SOCLE DE CONFIANCE DE LA FÉDÉRATION D'IDENTITÉ. Le Panel sait
  // affirmer, à UN projet précis et pour quelques minutes, qu'un porteur est
  // un développeur autorisé — sans qu'aucun mot de passe ne quitte le Panel.
  //
  // Cette suite est majoritairement une suite d'ÉCHECS ATTENDUS : chaque
  // contrôle vert est une falsification qui n'aboutit pas. Mauvaise audience,
  // claim modifié, `alg: none`, HMAC signé avec la clé publique, assertion
  // périmée, compte désactivé, rôle non autorisé, projet non appairé, clé
  // inconnue. Elle éprouve aussi la rotation avec recouvrement — la seule qui
  // ne coupe pas — et vérifie qu'aucune clé privée n'entre au dépôt.
  'federation-assertion.test.js',
  // L12.B-F — LE PARCOURS FÉDÉRÉ DE BOUT EN BOUT, sur DEUX serveurs réels :
  // un Panel sur son port, une instance projet dans son processus, un vrai
  // appairage, de vraies clés RSA et un vrai JWKS lu par HTTP.
  //
  // Elle prouve le critère majeur du lot : l'accès aux projets s'accorde par
  // l'API DE L'ÉCRAN, jamais par un appel de service. Et elle éprouve ce qu'un
  // navigateur ne saurait pas montrer — révocation d'une session ouverte,
  // projet dépairé, Panel éteint, homonyme local jamais fusionné.
  'federation-e2e.test.js',
  // LOT 2B HOTFIX — L'AUTORISATION FÉDÉRÉE EST VIVANTE, DANS LES DEUX SENS.
  //
  // L'incident : un accès accordé n'était pas pris en compte tant qu'on
  // n'avait pas rechargé — le SERVEUR répondait juste, l'ÉCRAN conservait le
  // refus d'avant. Cette suite garde les deux moitiés de l'invariant :
  //   · le Panel relit le compte à CHAQUE émission, sur une session Panel
  //     jamais renouvelée, et `ALL_PAIRED` reste une question posée au parc
  //     plutôt qu'une liste figée à l'octroi ;
  //   · le hook de la page d'autorisation, EXÉCUTÉ et non relu, n'affiche
  //     jamais un verdict rendu pour une tentative précédente.
  'federation-live-refresh.test.js',
  // LOT SUPER_ADMIN — LE RÔLE SOUVERAIN DU PANEL.
  //
  // Un troisième rôle ne s'ajoute pas à une énumération : il change la nature
  // de chaque comparaison de rôle déjà écrite. Deux suites, parce qu'elles ne
  // prouvent pas la même chose :
  //   · le SERVEUR — l'échelle `SUPER_ADMIN ≥ DEV`, la souveraineté sans
  //     exception de cible (autre souverain, soi-même, le dernier), la
  //     création sans mot de passe, et la PROJECTION vers les projets, qui
  //     n'envoie jamais autre chose que `DEV` ;
  //   · l'ÉCRAN — l'accord entre ce qu'il montre et ce que l'API autorise, et
  //     le balayage qui interdit toute comparaison de rôle hors de l'échelle.
  'panel-super-admin.test.js',
  'panel-super-admin-ui.test.js',
  // LES COMPTES D'UN PROJET, LUS EN DIRECT. Le Panel affichait sa propre
  // projection — une copie qui vieillissait, qui ne montrait que les comptes
  // locaux, et qui décrivait les mêmes personnes autrement que le Manager.
  // La suite éprouve la lecture vivante par le pont, la parité de
  // représentation champ par champ, la projection du rôle (un SUPER_ADMIN du
  // Panel entre en DEV), et le refus d'afficher un instantané périmé quand le
  // projet ne répond plus.
  'project-accounts-live.test.js',
  'version-compatibility.test.js',
  'manifest.test.js',
  'capabilities.test.js',
  'registry.test.js',
  'project-identity.test.js',
  'project-destination.test.js',
  'project-creation.test.js',
  'domains.test.js',
  'persistence.test.js',
  'bridge-http.test.js',
  'bridge-conformity.test.js',
  /**
   * BRIDGE 1.9.0 — L'ADRESSE PUBLIQUE EST UN ÉTAT, PAS UN SOUVENIR.
   *
   * `runtime.publicBackendUrl` était posée au bootstrap et jamais revue : le
   * Panel TEST annonçait encore `api.demo-sbauto.lycarz.com` des semaines après
   * la migration, et seule la destruction de l'appairage pouvait la corriger.
   * Cette suite verrouille l'invariant qui remplace ce comportement — appairage
   * = identité, URL = état courant — ainsi que la convergence d'un client 1.8,
   * qui ne doit dépendre d'aucune montée de version chez lui.
   */
  'bridge-runtime-url-sync.test.js',
  'contract-actions.test.js',
  // LA RÉCURRENCE CONTRACTUELLE — « tous les N mois », « tous les N ans ».
  // Le Panel crée le tarif Stripe à partir de cette phrase : la suite garde
  // que l'intervalle entre dans la CLÉ du Price (sans quoi un trimestriel
  // réutiliserait le tarif mensuel de même montant), qu'il part réellement
  // chez le fournisseur, et qu'une projection sans périodicité fait REFUSER
  // plutôt que supposer une fréquence de prélèvement.
  'contract-recurrence.test.js',
  'events.test.js',
  // L10.1 — LA FONDATION FINANCIÈRE, indépendante de tout fournisseur.
  // Deux suites, parce qu'elles ne prouvent pas la même chose :
  //   · le NOYAU — centimes entiers, bornes de période dans un fuseau nommé,
  //     agrégats exacts, suppression logique, portées étanches, et le
  //     garde-fou qui interdit à Stripe d'entrer dans le code financier ;
  //   · l'INTERFACE — les cinq états dégénérés du graphique (réellement
  //     exécutés, pas relus), le signe des montants, et la confirmation forte
  //     de « tout supprimer ».
  'finance-core.test.js',
  // L10.2 — LES COÛTS RÉCURRENTS ET LEURS JUSTIFICATIFS. Deux suites de plus,
  // parce qu'elles gardent deux invariants sans rapport :
  //   · le CALENDRIER et l'IDEMPOTENCE — le 31 janvier revient au 31 mars, un
  //     Panel arrêté quatre mois produit quatre lignes, et huit matérialiseurs
  //     simultanés n'en produisent jamais une de trop ;
  //   · le DOCUMENT PRIVÉ — aucune adresse publique, aucun transfert vers
  //     shared/uploads au déploiement, et la pièce survit aux révisions
  //     rétroactives comme à l'annulation du cycle courant.
  'finance-recurring.test.js',
  'finance-receipts.test.js',
  // L10.3 — LES REVENUS STRIPE ENTRENT DANS LE LEDGER GÉNÉRIQUE. Ce que cette
  // suite garde tient en une phrase : un paiement, une transaction. Quatre
  // annonces Stripe du même euro — session, facture, intention, débit — n'en
  // produisent qu'une, parce que l'objet CANONIQUE est choisi sur la charge
  // utile et que l'index unique de la provenance tranche. Elle éprouve aussi
  // le désordre de livraison (facture avant adoption), la suppression suivie
  // d'un rejeu, et le parcours réel depuis un webhook signé.
  'finance-stripe-revenue.test.js',
  /**
   * L10.7 — L'APPARTENANCE D'UN REVENU SE RÉSOUT SUR LE GRAPHE INTERNE.
   *
   * Un paiement TEST réellement encaissé restait `UNOWNED / NO_OWNERSHIP_RESOURCE`
   * — donc absent du registre financier — parce que la résolution ne consultait
   * qu'UNE ressource désignée sur la charge utile, et que Stripe a retiré
   * `invoice.payment_intent` à plat. Cette suite prouve les quatre ordres
   * d'arrivée, la réconciliation d'un `UNOWNED` tardif, et surtout le refus
   * inverse : l'absence de preuve ne devient jamais une appartenance.
   */
  'stripe-revenue-ownership-graph.test.js',
  // L10.4 — LE SEUL CHEMIN DU PARC QUI REND DE L'ARGENT. Ce que cette suite
  // garde tient en une phrase : un clic, un remboursement, quoi qu'il arrive.
  // Elle éprouve le double clic, la réponse perdue, le webhook qui double la
  // réponse, et le rejeu APRÈS expiration de la fenêtre d'idempotence de
  // Stripe — le seul cas où une clé ne protège plus rien et où seule la
  // métadonnée apposée sur le remboursement empêche d'en créer un second.
  // Elle vérifie aussi que rendre 100 € n'ajoute pas 100 € de charges.
  'finance-refunds.test.js',
  // L10.5 — DE L'ARGENT RÉCLAMÉ, QUI N'EST PAS ENCORE DE L'ARGENT GAGNÉ. Cette
  // suite garde la frontière : envoyer une prestation n'inscrit RIEN au ledger,
  // et le revenu naît uniquement du fait Stripe, par L10.3. Elle éprouve aussi
  // le snapshot fiscal — changer le taux du contrat ne réécrit aucune facture
  // déjà émise — et l'autorité du montant, qui n'est pas une validation mais
  // une absence : il n'y a aucun montant dans la requête à falsifier.
  'finance-payment-requests.test.js',
  // L10.6A + L10.6B-1 — L'IMPAYÉ, ET CE QU'IL AUTORISE À FERMER. Instantané des
  // trois causes et boucle de confirmation (on ne conclut jamais d'après la
  // seule cause dominante), puis la politique de grâce : elle vient du CONTRAT,
  // est FIGÉE à l'ouverture de l'incident, et son absence n'autorise AUCUNE
  // fermeture automatique. La suite garde aussi la frontière avec Stripe, qui
  // reste seul ordonnanceur des tentatives de collecte.
  'finance-payment-default-confirmation.test.js',
  // L10.6B-2 — CE QU'ON ANNONCE, ET QUAND ON A LE DROIT DE L'ANNONCER. Les
  // notifications et l'activité sont des CONSÉQUENCES de la confirmation
  // réelle, jamais des conditions : une panne d'envoi ne défait aucune
  // suspension, et huit livraisons du même instantané n'écrivent qu'une fois.
  'finance-payment-default-notifications.test.js',
  // L10.6B-3 — L'INCIDENT VOYAGE AVANT LA SANCTION. Deux suites de plus, parce
  // qu'elles gardent deux choses distinctes :
  //   · la PRÉSENTATION — un module PUR qui met un incident en mots sur quatre
  //     dimensions qu'on ne fusionne jamais. C'est la partie la plus facile à
  //     rendre fausse et la plus difficile à voir : une échéance reconstruite,
  //     un `null` lu comme un zéro, une demande affichée comme un fait ne font
  //     planter personne — ils produisent un écran qui ment ;
  'finance-payment-default-presentation.test.js',
  //   · la PROJECTION — l'incident part vers le projet dès le PREMIER échec, et
  //     non plus seulement quand la cause de suspension devient pertinente. La
  //     suite verrouille surtout la frontière : `PAYMENT_DEFAULT_CAUSE.active`
  //     garde EXACTEMENT sa sémantique de cause appliquée au moteur, et
  //     l'incident ne l'emprunte jamais — sans quoi les sites fermeraient
  //     pendant leur délai de grâce.
  'finance-payment-default-projection.test.js',
  'finance-ui.test.js',
  // L12.B-F — L'ÉCRAN QUI ACCORDE UN DROIT CHEZ UN CLIENT. Le serveur refuse
  // ce qu'un écran pourrait envoyer (mode inconnu, projet inconnu ou non
  // appairé, champ en trop), on ne s'accorde rien à soi-même, et « compte
  // actif » ne se confond jamais avec « accès aux projets ».
  'panel-users-ui.test.js',
  'panel-ui.test.js',
  'password-reset-ui.test.js',
  'template-editor.test.js',
  'template-editor-ui.test.js',
  'panel-meetings-ui.test.js',
  'panel-timeline-ui.test.js',
  'generation-change.test.js',
  'project-connections.test.js',
  'panel-instance-environment.test.js',
  // L1 — plan de contrôle IntegratedAPI. Le registre décide de ce qui existe,
  // le runtime décide de l'environnement, et aucune clé ne sort du coffre.
  'integrated-api-provider-registry.test.js',
  'integrated-api-environment-routing.test.js',
  'integrated-api-encryption.test.js',
  'integrated-api-control-plane.test.js',
  'integrated-api-http-security.test.js',
  // OPENSIGN — fondation du second fournisseur de signature (migration Yousign
  // → OpenSign, lot 0). Elle prouve que le Panel sait parler à OpenSign, et
  // surtout que YOUSIGN RESTE L'AUTORITÉ : un fournisseur ajouté ne prend rien
  // à celui qui sert. Aucun appel ne sort sur le réseau.
  'integrated-api-opensign-foundation.test.js',
  // LOT 2 — les cinq capacités de signature, servies par OpenSign, et
  // l'aiguillage qui garde les demandes historiques chez leur détenteur.
  'opensign-capability-adapter.test.js',
  'signature-provider-retirement.test.js',
  // LOT 3 — le chemin retour : signature du corps brut, idempotence sans
  // identifiant d'événement, appartenance, et la poignée de signataire qui
  // traverse à la place d'une adresse.
  'opensign-webhook-lifecycle.test.js',
  // L4 — la frontière : aucun identifiant fournisseur ne franchit le pont.
  // L'invariant est dérivé du registre, donc il survit au provider suivant.
  'bridge-provider-secret-boundary.test.js',
  // ── QUATRE SUITES ONT ÉTÉ SUPPRIMÉES AVEC LES MÉCANISMES QU'ELLES GARDAIENT
  //
  //   commercial-readiness.test.js           la politique de pré-ouverture
  //   commercial-readiness-runtime.test.js   ouvrir, refermer, et la passerelle
  //   commercial-opening-concurrency.test.js le double clic sur « ouvrir »
  //   capability-preopening.test.js          le refus des écritures réelles
  //
  // Elles éprouvaient l'ouverture commerciale et les octrois de capacités. Ce
  // que ces suites protégeaient réellement — l'isolation entre projets — est
  // désormais éprouvé par `capability-multi-project-isolation.test.js`, qui
  // vise l'appartenance des ressources plutôt qu'une case cochée.
  // R10.5C — le verrou de signature : ce qu’il protège (double ouverture d’un
  // même contrat, ressource étrangère, identifiant inventé, isolation
  // TEST/PROD) et la sortie tracée quand une issue reste indéterminée.
  'signature-reservations.test.js',
  // R10.5C — la FORME du fait de signature qui traverse le pont. Deux détails
  // y décident si l'événement arrive ou disparaît, et aucun des deux ne lève :
  // un `entityId` qui n'est pas un UUID fait rejeter la page entière, et un
  // signataire absent laisse le parcours s'arrêter à mi-chemin, en silence.
  'signature-event-dispatch.test.js',
  // L8 — la connaissance Brevo : deux vocabulaires d'événements pour un seul
  // sens, quatre champs de date pour deux unités, et cinq objets qu'on
  // confondait. Enregistré ici en L5.1 — il était livré mais jamais exécuté.
  'brevo-control-plane.test.js',
  // L5 — la fondation webhook : le Panel possède ses endpoints, sait ce que
  // le fournisseur expose vraiment, et ne supprime que ce qu'il prouve avoir
  // créé. Le secret ne sort du coffre par aucune porte.
  'webhook-control-plane.test.js',
  // L8.2 — la MIGRATION Brevo, par l'écran réel : le bouton du Manager passe
  // par le pont, la passerelle et le coffre du Panel. La clé locale du projet
  // n'est plus jamais lue, et rien ne retombe dessus.
  'brevo-verify-migration-e2e.test.js',
  // L8.3 — les trois briques que L8.2 avait nommées comme bloquantes :
  // l'autorité de contenu du Panel, les identités expéditrices par projet, et
  // l'idempotence que Brevo n'offre pas.
  'brevo-send-template-foundation.test.js',
  // R10.4 — l'expéditeur GLOBAL : une seule source pour tout le parc et pour le
  // Panel lui-même, aucun projet ne configure le From, et l'e-mail de test
  // emprunte la chaîne réelle jusqu'au webhook de livraison.
  'global-email-sender.test.js',
  // L11.1 — LE PLAN DE CONTRÔLE MULTI-PROJETS DU CONTENU. C'est la suite qui
  // retourne la doctrine : la portée du contenu était modélisée mais n'avait
  // aucun écrivain, donc tout le parc partageait un document unique et éditer
  // un modèle réécrivait l'e-mail de tous les clients à la fois.
  //
  // Elle prouve, sur le corps réellement posté au fournisseur, que trois
  // portées portent trois contenus ; que l'absence d'un contenu projet est un
  // REFUS et jamais un emprunt au Panel ; qu'aucune surface — corps de requête,
  // pont d'un autre projet, restauration — ne franchit la frontière ; et que
  // l'expéditeur, lui, reste global. Elle porte aussi la garde de PARITÉ des
  // deux registres de variables, que l'audit réclamait immédiatement.
  'email-template-multi-project.test.js',
  // Le CYCLE DE VIE des instances : qui les pose, et quand. La suite
  // ci-dessus prouve que la mécanique marche quand on l'actionne ;
  // celle-ci prouve qu'on l'actionne.
  'email-template-provisioning-lifecycle.test.js',
  // La DECLARATION VIVANTE : le projet dit ce qu'il utilise, le Panel
  // s'y conforme. C'est la suite qui garde la doctrine de ce lot.
  'email-template-declaration-lifecycle.test.js',
  // L8.4C — la BOUCLE COMPLÈTE, de bout en bout : un projet demande un envoi,
  // le Panel le fait partir sous SON compte, le webhook du fournisseur revient
  // au Panel, et le verbe de livraison redescend jusqu'au projet — y compris
  // s'il était hors ligne au moment où l'événement est arrivé. C'est la seule
  // suite qui prouve que l'émission et le retour se referment sur la même
  // livraison, avec un vrai projet dans un vrai processus voisin.
  'brevo-send-delivery-convergence-e2e.test.js',
  // L3 — la passerelle de capacités : le projet demande un VERBE, le Panel
  // résout le fournisseur, le monde et la clé. Deux suites, parce qu'elles ne
  // peuvent pas vivre dans le même processus :
  //   · la mécanique, refus par refus, en TEST ;
  //   · le bout en bout, par le pont réel, avec un fournisseur qui parle HTTP.
  'capability-gateway.test.js',
  'capability-gateway-e2e.test.js',
  // La garde ANTI-CAPACITÉ FANTÔME : toute action déclarée possède un
  // exécutant, et réciproquement. C'est elle qui empêche le retour de l'état
  // « déclarée, mais pas encore servie ».
  'capability-registry-coherence.test.js',
  // L'ISOLATION ENTRE PROJETS, sans octrois : un projet ne peut pas atteindre
  // le contrat, la signature ni le domaine d'un autre, même en nommant
  // directement un identifiant fournisseur valide.
  'capability-multi-project-isolation.test.js',
  // L6.1/L6.2A — Stripe : la fondation financière, puis l'autorité
  // d'appartenance qui la débloque. Aucune capacité n'est encore servie ; ces
  // deux suites gardent les contrats et l'index qui rend le vol impossible.
  'stripe-control-plane.test.js',
  'stripe-resource-ownership.test.js',
  // L6.2B — LE CUTOVER : un vrai projet demande un paiement, le Panel ouvre la
  // session avec SA clé, et la lie. Les sections qui comptent sont les
  // dégradées : réponse perdue, crash avant le lien, huit clics simultanés.
  'stripe-checkout-cutover-e2e.test.js',
  // L6.2C — posséder un identifiant n'est pas être autorisé. La lecture vérifie
  // l'appartenance AVANT de parler au fournisseur, et le webhook trouve son
  // destinataire dans le registre de liens — jamais dans les metadata.
  'stripe-checkout-read-webhook-e2e.test.js',
  // L6.2D — le client d'un CONTRAT, et non du projet. L'identité de l'acte est
  // dérivée du contrat : le projet ne peut pas en obtenir deux.
  'stripe-customer-ownership-e2e.test.js',
  // L6.2E — le TARIF, puis l'abonnement. La clé d'un Price porte ses TERMES et
  // non la version du contrat : cette version compte les sauvegardes de zones
  // de signature, pas les engagements commerciaux.
  'stripe-subscription-cutover-e2e.test.js',
  // L6.2F — la PREMIÈRE adoption : Stripe crée l'abonnement au paiement, et le
  // Panel ne peut le posséder que par filiation — la session qui l'a produit.
  'stripe-subscription-ownership-e2e.test.js',
  // L6.2G — les deux RÉSILIATIONS, et la convergence par l'ÉTAT : contrairement
  // à un paiement, une coupure laisse une trace non ambiguë, donc relire répond
  // à « l'acte a-t-il eu lieu ? ». Les sections qui comptent sont le rejeu (que
  // Stripe REFUSE de servir deux fois), la réponse perdue, et l'état illisible —
  // qui ne devient jamais une seconde mutation.
  'stripe-subscription-cancellation-e2e.test.js',
  // L6.3A — LE PROVISIONNEMENT CHANGE DE MAIN. Le Panel enregistre l'endpoint
  // du PROJET chez Stripe avec SA clé, puis lui livre le seul secret de
  // VÉRIFICATION — par un canal qui n'accepte qu'une forme, à côté d'une
  // frontière L4 restée intacte. La section qui compte est la dernière : un
  // événement signé traverse encore la vérification du projet et atteint son
  // métier. « L'endpoint est créé » n'aurait rien prouvé.
  'stripe-webhook-provisioning-e2e.test.js',
  // L6.3B — LES DERNIÈRES LECTURES, ET LE PORTAIL. Aucune ne déplace d'argent,
  // et c'est pour cela qu'elles avaient survécu à sept lots. Le verbe qui compte
  // est le PORTAIL : il ouvre au client ses moyens de paiement et ses factures,
  // et le projet y passait le customerId de sa fiche locale. Se tromper n'aurait
  // coûté aucun euro — seulement le dossier de quelqu'un d'autre, sans que rien
  // ne le signale.
  'stripe-local-surface-e2e.test.js',
  'stripe-ownership-invariants.test.js',
  // L9 — Hostinger : un compte global, et le contrôle qui empêche un jeton
  // global de devenir une autorisation globale.
  //
  // ⚠️ CETTE SUITE ÉTAIT LIVRÉE ET JAMAIS EXÉCUTÉE. Elle a été écrite au lot
  // L9 sans être inscrite ici : la suite complète annonçait « tout vert » sans
  // l'avoir jouée. Même incident qu'au lot L8, et même correction.
  'hostinger-control-plane.test.js',
  // L9.1 — la bascule, par le chemin réel : le déploiement d'un projet demande
  // ses verbes DNS au Panel, qui écrit avec SA clé. Aucun repli local.
  'hostinger-dns-cutover-e2e.test.js',
  'panel-branding.test.js',
  // LOT F — l'identité visuelle du Panel, avant toute session.
  'panel-public-branding.test.js',
  'developer-branding-propagation.test.js',
  'developer-branding-instance-ack-e2e.test.js',
  // Cross-dépôt : un vrai SB Auto, dans son processus, tire et applique.
  'real-panel-sbauto-branding-ack-e2e.test.js',
  // L4 — LA PREUVE : quatre sentinelles dans le coffre du Panel, et zéro
  // occurrence dans la base, l'identité et les écrans d'un projet réel.
  'provider-secret-sentinel-e2e.test.js',
  // Un enregistrement, et la page « Aide » du projet suit — sans second geste.
  'panel-company-save-to-help-e2e.test.js',
  // L4 — le Panel LIVRE au lieu d'attendre que le projet tire ; le journal
  // durable reste la source de vérité, et le tirage la réparation.
  'panel-to-project-event-driven-e2e.test.js',
  // LOT A — le dernier maillon : backend projet → Manager ouvert, sans reload.
  'manager-live-ui-e2e.test.js',
  // L8 — l'état du site devient une projection vivante ; plus aucune lecture
  // métier directe depuis un écran du Panel.
  'project-site-status-live-e2e.test.js',
  // L1/L2 — le contrat de présentation avec médias, et le sort d'un refus.
  'project-presentation-media-contract-e2e.test.js',
  'payload-drift.check.mjs',
  // LA RECETTE CANONIQUE — les deux sens, l'offline, le refus, le flux perdu et
  // les latences, dans un seul fichier. Les autres prouvent chacun leur moitié.
  'event-driven-system-e2e.test.js',
  // L0 — latences de référence et non-régression de la poussée immédiate.
  'event-driven-sync-baseline.test.js',
  'instance-generation-freshness.test.js',
  // L'état métier d'un projet est vivant, pas figé à l'appairage.
  'project-live-business-sync.test.js',
  // Du vrai Company.save() jusqu'à la fiche du Panel, deux backends réels.
  'project-company-live-e2e.test.js',
  'contract-current-history.test.js',
  'architecture.test.js',
  'panel-ux.test.js',
  'live-refresh.test.js',
  // LOTS C+D — l'interrupteur de protection et la séparation
  // « connexion projet » / « vitrine ».
  'protection-switch-ux.test.js',
  'vitrine-vs-connexion.test.js',
  // LE PREMIER APPEL APRÈS UN REDÉMARRAGE, sur un VRAI processus : le port
  // répond avant la fin de l'amorçage, les routes métier refusent en 503 +
  // code stable (jamais 401), le service bascule seul, et le PREMIER appel
  // métier aboutit — sans échauffement ni seconde tentative.
  'first-deployment-after-restart.test.js',
  'deploy.test.js',
  'deployment-build.test.js',
  'deployment-remote-env.test.js',
  'deployment-local-prerequisites.test.js',
  'deployment-report-truth.test.js',
  'deployment-silence.test.js',
  'deployment-stream.test.js',
  // LA BARRIÈRE DE PUBLICATION — la suite qui met le journal durable en panne
  // sur le chemin RÉEL (createRun → runDeploymentJob → deployWithReport →
  // finalizeRun), avec Mongo en mémoire et le transport pour seul double.
  //
  // Ce qu'elle verrouille, et que rien d'autre ne verrouille : une perte de
  // journal AVANT la bascule REFUSE la publication (la commande n'est jamais
  // émise, et la preuve est un ORDRE de faits, pas un horodatage) ; APRÈS, elle
  // ne dépublie rien, ne remplace jamais l'erreur métier primaire, et laisse un
  // run que le démarrage suivant sait reprendre sans inventer.
  'deployment-durable-recorder.test.js',
  'engine-genericity.test.js',
  'engine-genericity-e2e.test.js',
  'supervision.test.js',
  'diagnostic.test.js',
  'execution.test.js',
  'spec-drift.check.mjs',
  'deployment-rollback.test.js',
  'deployment-deprovision.test.js',
  'deployment-ports.test.js',
  // LOT B — politique d'import des médias, limites alignées, refus typés.
  'media-upload-limits.test.js',
  'media-upload-validation.test.js',
  'media-descriptor.test.js',
  'media-cache-versioning.test.js',
  'media-canonical-save.test.js',
  'media-first-deployment.test.js',
  'deployment-ui.test.js',
  'deployment-forensics.test.js',
  'deployment-ssh-restart.test.js',
  'engine-governance.test.js',
  'duplication-e2e.test.js',
  'engine-drift.check.mjs',
  // Écosystème complet — SAUTÉ proprement si SB Auto 06 n'est pas à côté.
  'ecosystem-e2e.test.js',
];

let failed = 0;
for (const file of TESTS) {
  console.log(`\n━━━ ${file} ━━━`);
  const result = spawnSync(process.execPath, [path.join(testsDir, file)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed += 1;
}

console.log(`\n════ Suite : ${TESTS.length - failed}/${TESTS.length} fichiers OK ════`);
process.exit(failed === 0 ? 0 : 1);
