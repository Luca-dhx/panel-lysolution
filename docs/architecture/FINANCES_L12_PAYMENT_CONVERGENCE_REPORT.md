# L12 — Convergence des paiements, archivage des factures, notifications

> Rapport de lot. Écrit après les recettes réelles, sur le parc TEST déployé.
> La procédure d'exploitation qui en découle vit dans
> [PROTOCOL.md § « CONVERGENCE D'UN PAIEMENT »](../PROTOCOL.md).

---

## Verdict

**PASS AVEC RISQUES.**

Tout ce que le lot visait est corrigé, déployé et prouvé sur des paiements
réels. Deux réserves subsistent, toutes deux de configuration et non de code :
l'adresse du compte ADMIN du projet de démonstration n'est pas délivrable, et
l'adresse de support publiée doit être confirmée avant PROD. Elles sont
détaillées en fin de document.

---

## Les symptômes, et ce qu'ils cachaient

Le lot part de trois plaintes. Il en a corrigé **six** défauts, dont trois que
personne n'avait signalés parce qu'ils étaient silencieux.

| # | Défaut | Portée réelle |
|---|---|---|
| 1 | `ReferenceError: provider is not defined` | « Vérifier le paiement » rendait 500, **à tous les coups** |
| 2 | Instantané d'abonnement périmé appliqué | un encaissement défait par un webhook plus vieux que lui |
| 3 | Aucun événement sur un règlement d'abonnement | le client n'était **jamais** confirmé, ni au premier cycle ni aux suivants |
| 4 | Contact public du prestataire non publié | tout message de facturation refusé en `UNKNOWN_RESOLVER` |
| 5 | « Pas joignable » traité comme « pas configuré » | un envoi rejoué pendant un redémarrage partait au rebut |
| 6 | Montant aplati en `"[object Object]"` sur le fil | **aucun** e-mail de facturation client n'avait jamais pu partir |

Les défauts 4, 5 et 6 n'étaient pas dans la commande. Ils sont apparus parce que
la recette est allée jusqu'au bout : sans envoi réel, on aurait livré une chaîne
qui compile, qui teste vert, et dont aucun message n'arrive.

---

## 1 · Le 500 de « Vérifier le paiement »

### La cause exacte

```text
ReferenceError: provider is not defined
    at Module.reconcileAndDescribe (backend/src/services/subscription.service.js:631:52)
```

`reconcileAndDescribe` appelait `reconcileSubscription(contract, { actor }, provider)`.
Ce troisième argument est un résidu d'un refactor : plus aucune liaison nommée
`provider` n'existait dans le module. En ESM — donc en mode strict — lire un
identifiant non déclaré lève. La fonction échouait à sa **première ligne**, avant
toute lecture, pour tous les contrats et toutes les situations.

Le même appel résiduel figurait ligne 396, sur le chemin « la session est déjà
complète » de `createOrReuseSubscriptionCheckout` : le bouton « Reprendre le
paiement » d'un abonnement déjà réglé rendait donc 500 lui aussi.

Classification : **A/J — code mort d'un refactor**, ni legacy, ni capacité, ni
appartenance, ni course.

### Ce qui l'a laissé passer

Rien ne le voyait. Le module se **charge** parfaitement ; il ne casse qu'à
l'exécution de la ligne. Ce dépôt avait déjà payé exactement cette forme —
`erreurFinalisation is not defined`, dont `first-preflight.test.js` garde la
reproduction.

`undefined-identifier.test.js` (les deux dépôts) ferme la famille : `tsc
--checkJs` sur les 551 fichiers du runtime projet et les 352 du Panel, ne
retenant que « Cannot find name ». Vérifié en réintroduisant le défaut — la
garde rougit et nomme le fichier, la ligne, la colonne.

Elle vérifie **aussi que le compilateur a tourné** : sur Windows, passer 551
chemins en arguments dépassait la ligne de commande, le processus ne démarrait
pas, la sortie était vide — et une sortie vide se lit « aucune faute ». Un
contrôle qui passe au vert sans rien mesurer est pire que pas de contrôle.

---

## 2 · L'écran « Paiement à confirmer » sur un contrat payé

### L'ordre réel des livraisons, le 21 août

```text
10:32:03.370  invoice.paid                   → abonnement ACTIF
10:32:03.504  customer.subscription.updated
10:32:03.563  customer.subscription.created  → « incomplete »
```

Le dernier **arrivé** est le plus **ancien** : `customer.subscription.created`
transporte l'abonnement tel qu'il était à sa naissance, avant le règlement de sa
première facture. `projectSubscription` écrivait le statut sans aucune garde de
fraîcheur. `ACTIVE` a été écrasé par `INCOMPLETE`, et aucun webhook ultérieur
n'est venu le défaire.

Classification : **E + H — mapper d'état sans ordonnancement, exposé par une
course de livraison.**

### Deux gardes, parce qu'une seule ne suffit pas

| garde | portée | ce qu'elle départage |
|---|---|---|
| `stripe.subscription.statusObservedAt` | générale | une observation plus ancienne n'écrit ni statut, ni période, ni résiliation |
| « incomplete ne défait pas une facture encaissée » | décisive | les annonces tombées dans la MÊME seconde |

`evt.created` est à la seconde, et les quatre annonces d'un premier règlement y
tombent ensemble : l'horloge ne peut pas les départager. La seconde garde tranche
donc sur une **preuve** — un règlement local `PAID` portant cette facture — et
non sur une horloge.

Les **identités** (`subscriptionId`, `latestInvoiceId`, `customerId`) s'écrivent
dans tous les cas : elles nomment des objets, elles ne décrivent pas un état qui
régresse. Une lecture directe est horodatée « maintenant » et prime sur tout —
c'est ce qui rend la réparation possible.

### La garde s'est exercée en production TEST

Recette du 21 août, 13:08:30, ordre livré :

```text
13:08:30.172  invoice.paid
13:08:30.187  invoice.finalized
13:08:30.324  checkout.session.completed
13:08:30.374  customer.subscription.created   ← l'instantané périmé
13:08:30.468  customer.subscription.updated
```

Même permutation qu'au 21 août. Contrat : **ACTIVE**, étape ACTIVATION. Aucun
écran « Paiement à confirmer ».

---

## 3 · La redirection n'est jamais une preuve

### Ce que le lot verrouille

```text
Checkout / Billing
      ↓  événement SIGNÉ
Panel — webhook
      ↓  appartenance PROUVÉE par le registre de liens
fait fournisseur normalisé
      ↓
transaction au registre financier            ← « PROJETÉ »
      ↓                          ↘
facture archivée (Media)          annonce aux SUPER_ADMIN
      ↓
projection vers le projet → contrat payé / abonnement actif
      ↓
confirmation au client, avec sa facture
```

Aucune flèche ne part d'une URL de retour. Une garde de recette
(`stripe-payment-convergence.test.js` §5) vérifie qu'aucun applicateur de
paiement du projet ne lit `req.query`, `searchParams` ni `session_id` — en
ignorant les commentaires, qui parlent justement de ne pas le faire.

### La recette, sans complaisance

Le navigateur **refuse au niveau réseau** toute navigation vers le domaine du
Manager (`route.abort()`), puis il est fermé. Le serveur du projet ne reçoit
rien. Le compteur de retours bloqués est la preuve NÉGATIVE : à zéro, la recette
n'a rien prouvé et le dit.

**Frais de lancement — CTR-2026-0003**

```text
paiement Stripe          payé 12:33:19
retour suivi             NON — 1 tentative refusée, navigateur fermé
contrat SB Auto          LAUNCH_FEE PAID, sans aucun clic
transaction Panel        cf064f7b-d219-4c2d-914f-2a7fa8656b5a
facture archivée         816856b0… · 355 639 o · sha 4ef367a0…
mail SUPER_ADMIN         SUCCEEDED → Brevo delivered 12:33:31, ouvert, cliqué
mail client              refusé (facture à 3 s), puis SUCCEEDED
clic « Vérifier »        NON REQUIS
```

**Abonnement — CTR-2026-0003**

```text
facture Stripe payée     13:08:30
retour suivi             NON — 1 tentative refusée, navigateur fermé
abonnement               ACTIVE (malgré l'instantané périmé livré après)
transaction Panel        80a29376-4766-4e62-9dd5-5a2367d3cd7e
facture archivée         17604809… · 355 565 o · sha 68a576c1…
mail client              SUCCEEDED du premier coup
mail SUPER_ADMIN         SUCCEEDED
contrat                  étape ACTIVATION — aucun écran bloqué
clic « Vérifier »        NON REQUIS
```

**Redirection normale — CTR-2026-0004**

Retour suivi, écran posé. Lu dans un **contexte navigateur neuf** — un autre
« ordinateur » : « Frais de lancement ✓ terminée », étape 3 « Activez votre
abonnement ». Aucune mention « à confirmer », aucune « erreur serveur ». Le
correctif du cas sans retour n'a pas dégradé le cas normal.

### Le CTA, sur le contrat réellement bloqué

```text
avant : status INCOMPLETE
POST /api/my-contract/subscription/reconcile → HTTP 200
après : status ACTIVE · outcome PAID · changed true · authorityReached true
second clic : changed false — idempotent
```

Le contrat CTR-2026-0002 est passé de l'écran « Paiement à confirmer » à l'étape
ACTIVATION.

### Quand l'autorité ne répond pas

La réconciliation rendait `{ changes: [] }` — indiscernable d'une vérification
réussie. L'écran affichait « État du paiement vérifié », puis réclamait à nouveau
le paiement. `authorityReached` remonte désormais le fait, et le message dit
« nous n'avons pas pu joindre le service de paiement ».

---

## 4 · La facture : une copie détenue, pas une adresse

### L'audit du fournisseur

Les **deux** parcours produisent une vraie facture Stripe : `invoice_creation`
est actif sur le Checkout du paiement unique. Constaté sur quatre règlements
réels (QWSK7ZZY-0003 à 0007), tous porteurs d'un `invoice_pdf` et d'un
`hosted_invoice_url`. Aucun reçu de repli n'a été nécessaire, et aucun PDF n'est
fabriqué.

### Ce qui manquait

Le Panel conservait deux **adresses** et rien d'autre. Une adresse `invoice_pdf`
est signée et périssable ; une facture se conserve des années. Un mouvement
affichait donc un encaissement dont la pièce vivait entièrement chez un tiers.

### Ce qui est fait

Le PDF est téléchargé dès le fait projeté et rangé dans le protocole Media —
**au même endroit** que les justificatifs déposés à la main, servi par la **même**
route contrôlée. Le jour d'un contrôle, on ne veut pas avoir à se souvenir que
les pièces sont rangées à deux endroits selon leur origine.

Conservés sur le fait : `invoiceId`, `number`, `hostedUrl`, `pdfUrl`, `mediaId`,
`sha256`, `mime`, `bytes`, `downloadedAt`, plus le compteur de tentatives et le
motif du dernier échec.

### Le transport vit ailleurs que la décision

Le `fetch` était d'abord dans le service d'archivage. `bridge-conformity` l'a
refusé, et il a eu raison : ce module aurait été à la fois celui qui décide et
celui qui ouvre une socket. `stripeDocumentTransport.js` ne sait rien de la
finance — il reçoit une adresse, rend des octets, refuse ce qui n'est pas une
`https` absolue, et plafonne la taille **avant** de lire le corps.

### Idempotence

Trois verrous se superposent :

```text
le fait sait quelle copie il a produite      → aucun retéléchargement
une pièce déposée à la main n'est JAMAIS écrasée
l'écriture est CONDITIONNELLE (`receipt.mediaId: null` dans le filtre)
→ celui qui perd la course ne remplace rien
```

Éprouvé : trois passages → une copie, une association, une empreinte, **un seul**
appel au fournisseur.

### Rattrapage — et il n'est pas une migration

`convergePendingRevenue()` reprend les encaissements projetés sans pièce à chaque
lecture financière. Trois causes, un seul état, une seule réparation : un Panel
redémarré entre la projection et l'archivage, un PDF pas encore produit, une
transaction d'avant le lot.

Éprouvé sur données réelles, et pas par un script : les deux transactions du
21 août ont été archivées **toutes seules** au redémarrage du Panel qui portait
le nouveau code.

### Preuve HTTP

```text
GET /api/finances/transactions/:id/receipt
  sans authentification : 401
  avec authentification : 200 · application/pdf · signature « %PDF- »
  empreinte servie = empreinte inscrite sur le fait
```

Aucune porte publique ne sert le document : `/uploads/…` rend 404, et les autres
chemins rendent la page de l'application (`text/html`, 403 o) — pas le PDF. Le
contrôle regarde le **contenu**, parce qu'un 200 sur une application d'une seule
page ne veut pas dire « voici le fichier ».

---

## 5 · Les deux messages d'un encaissement

| message | émetteur | portée | destinataire | déclencheur |
|---|---|---|---|---|
| `PAYMENT_CONFIRMED_ADMIN` | le PROJET | PROJECT | ses administrateurs | `launch_fee.paid` · `subscription.paid` |
| `PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN` | le PANEL | PANEL | ses SUPER_ADMIN | fait fournisseur PROJETÉ |

Ils ne se recouvrent pas. Le second n'est **jamais** provisionné chez un projet —
il nomme un client à quelqu'un d'autre — et une garde de recette le vérifie.

`PAYMENT_CONFIRMED_ADMIN` est **générique** : frais de lancement, abonnement,
prestation. `payment.kind` et `payment.period` portent la différence. Il remplace
`CONTRACT_PAYMENT_RECEIVED_ADMIN`, qui reste au registre — marqué `retired` — pour
la lisibilité des envois déjà partis.

Le retrait a demandé que la classification sache dire « retiré » : l'invariant
« toute classification cite ses appelants réels » interdisait qu'un code n'en ait
aucun, et ne laissait que deux mauvaises issues — supprimer la définition, ou
inscrire un appelant imaginaire.

### Les destinataires

`resolvePanelSuperAdmins()` rend **tous** les comptes `SUPER_ADMIN` actifs,
dédupliqués par adresse. Jamais « le premier trouvé » : un `findOne()` aurait
fonctionné tant qu'il n'y a qu'un compte, puis cessé en silence au second. La
recette ajoute un second SUPER_ADMIN et vérifie qu'il entre dans la liste.

### Exactement une fois

Aucune clé d'idempotence ne contient d'horloge. Un `Date.now()` produirait un
acte neuf à chaque passage, et le premier rattrapage réexpédierait tout le parc.

```text
un fait fournisseur       index unique {provider, environment, objectType, objectId}
une transaction par fait  index unique partiel sur provenance.*
un envoi Panel            PanelCapabilityOperation (projectId, capability, operationId)
un envoi projet           idempotencyKey de l'événement + EmailDelivery
une copie de facture      invoiceArchive.mediaId, puis receipt.mediaId, puis l'empreinte
```

Vérifié en vrai : second appel de l'annonce → `ALREADY_SENT` / `REPLAYED`, aucun
second message.

### Le lien de facture est obligatoire, et il se fait attendre

Le fournisseur annonce l'encaissement **avant** d'émettre la facture — 3 secondes
sur le parcours réel des frais de lancement. Un bouton « Voir ma facture » vers
une liste vide est pire que pas de bouton : le client vient d'être débité, on lui
confirme, il clique, il ne trouve rien, il doute.

`payment.invoiceUrl` est donc **obligatoire**, et son résolveur lève un refus
**rejouable** tant que la facture n'est pas là. Cela a demandé que
`EmailVariableResolverError` sache dire « pas encore » et non seulement
« jamais » : le gestionnaire d'envoi écrasait la distinction.

Observé en recette réelle, à la seconde près :

```text
12:33:19  launch_fee.paid émis
12:33:19  exécution → FAILED, rejouable, « la facture n'est pas encore parvenue »
12:33:22  invoice.finalized → la facture arrive
```

Le refus était juste. Mais **aucune reprise ne serait venue** : le dispatcher est
embarqué et l'assume — « sans passage périodique, un FAILED retryable attend le
prochain démarrage ». C'est le défaut n° 5 du tableau, et il est corrigé sans
ajouter de minuterie : ce que le message attendait n'est pas un délai, c'est un
FAIT, et ce fait arrive par un webhook qu'on traite déjà. Le webhook de facture
réveille donc ce qui l'attendait, pour ce contrat, et seulement les exécutions
qui se sont déclarées rejouables.

---

## 6 · Le défaut qui rendait tout le reste inutile

Après correction de la reprise, l'envoi rejoué a été refusé par l'autorité :

```text
CAPABILITY_INPUT_INVALID — Préparation impossible pour « email.send_template »
```

`plainVariables` datait d'un contrat d'entrée qui n'admettait que des scalaires :
tout objet finissait en `String(valeur)`, c'est-à-dire `"[object Object]"`. Le
contrat a ensuite été élargi côté Panel pour accepter `{ amount, currency }` —
parce que le rendu, lui, l'attendait depuis toujours. **Les deux côtés du Panel
ont été mis d'accord ; le côté projet ne l'a jamais été.**

Un montant traversait donc en `"[object Object]"`, passait le schéma sans broncher
— c'est une chaîne valide — et échouait au rendu sur « montant non numérique ».

Ce que cela cassait : **tous** les e-mails de facturation du client — paiement
reçu, impayé, dernier avertissement, régularisation. Aucun n'avait jamais pu
partir.

Aucun test ne le voyait : toutes les suites vérifiaient le rendu **local**, qui
accepte la forme complète. Le nouveau contrôle lit la charge utile **réellement
transmise** dans les appels du plan de contrôle.

---

## 7 · Preuves d'envoi réel

| modèle | portée | destinataire | acte | livraison |
|---|---|---|---|---|
| `PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN` | PANEL | SUPER_ADMIN | `pay-ok-cf064f7b…` | **delivered** 12:33:31, ouvert, cliqué |
| `PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN` | PANEL | SUPER_ADMIN | `pay-ok-80a29376…` | **delivered** 13:08:41 |
| `PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN` | PANEL | SUPER_ADMIN | `pay-ok-d04bde6a…` | SUCCEEDED |
| `PAYMENT_CONFIRMED_ADMIN` | PROJECT v1 | ADMIN_EMAILS | `8efed409…` | SUCCEEDED, puis rebond (voir risques) |
| `PAYMENT_CONFIRMED_ADMIN` | PROJECT v1 | adresse sûre | `panel-template-test-e4a9170f…` | **delivered** 13:11:09 |

Le sujet, le HTML et l'expéditeur viennent tous du Panel : `templateScope
PROJECT`, `templateVersion 1`, `templateSource PANEL`, expéditeur
`support@ly-solution.com`.

---

## 8 · Déclaration du modèle par le projet

Aucun provisionnement manuel. Au démarrage du projet déployé :

```text
codes déclarés : 9  ·  unknown : 0  ·  forbidden : 0
provisionné    : PAYMENT_CONFIRMED_ADMIN
retiré         : CONTRACT_PAYMENT_RECEIVED_ADMIN
```

L'instance retirée et tout son historique restent en base, conformément à la
doctrine. Le Panel déployé connaît les 19 codes avec leurs portées exactes.

L'ordre du protocole a été respecté : Panel d'abord (`3281fa8`), projet ensuite.

---

## 9 · Redémarrage et récupération

Éprouvé sur données réelles, involontairement puis délibérément.

Le Panel de développement tourne sur la base TEST **partagée**. Son redémarrage
avec le nouveau code a archivé les deux factures de CTR-2026-0002 — sur **son**
disque. Le descripteur vivant dans la base partagée, le Panel déployé le lisait,
ne trouvait pas le fichier, et rendait **503**.

Réparé par la convergence produit, pas par un `scp` : les traces d'archivage ont
été retirées, le fait est redevenu « projeté sans pièce », et une simple lecture
de l'écran Finances du Panel déployé a suffi à retélécharger les deux factures et
à les rattacher. `200 application/pdf`, empreintes inscrites identiques aux
empreintes servies.

C'est exactement le scénario « redémarrage entre la projection et l'archivage »,
joué en vrai.

---

## 10 · Ce qui a été ajouté

**Panel**

- `invoiceArchival.service.js` — archivage et rattrapage
- `paymentConfirmationAnnouncements.js` — l'annonce aux SUPER_ADMIN
- `stripeDocumentTransport.js` — le transport, et rien d'autre
- `PAYMENT_CONFIRMED_ADMIN`, `PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN`
- `invoiceArchive` sur le fait fournisseur, avec son index de file
- `settleProjectedFact` — les suites d'un encaissement, hors de la projection
- `retired` sur la classification des modèles
- `tests/stripe-invoice-archival.test.js` — 71 contrôles
- `tests/undefined-identifier.test.js` — garde statique

**Projet**

- `stripe.subscription.statusObservedAt` + les deux gardes de fraîcheur
- `subscription.paid` — événement, action, résolveur générique
- `pendingActionWakeup.js` — le réveil sur arrivée de la donnée attendue
- `retryable` sur les refus de précondition et de résolution
- forme monétaire préservée sur le fil
- `authorityReached` jusqu'à l'écran
- `stripe-payment-convergence.test.js` — 26 contrôles
- `undefined-identifier.test.js` — garde statique

---

## 11 · Portes de qualité

```text
Panel     npm test   144/144 fichiers, 0 échec
Projet    npm test   108 suites, 0 échec
tsc --noEmit   manager · vitrine · frontend Panel   0 erreur
```

Un seul échec est apparu en cours de lot, et il était fondé :
`bridge-conformity` a refusé le `fetch` posé dans le service d'archivage. Le
transport a été extrait.

---

## 12 · Déploiements et disponibilité

```text
Panel TEST     https://panel.ly-solution.com          3281fa8
Projet TEST    https://api.demo-sbauto06.ly-solution.com   211d566
```

Quatre déploiements du projet (un par correctif), un du Panel. Chemins officiels
uniquement : `tools/deployPanel.js` et `tools/deployDirect.js`.

Disponibilité surveillée à chaque étape. Le site de démonstration, son Manager,
l'API du projet et le Panel ont répondu **200 en continu**, y compris pendant les
bascules.

---

## 13 · Nettoyage

Deux contrats de recette créés, deux supprimés. Suppression par identifiant,
dépendances d'abord, avec garde-fou d'abandon : un contrat ne portant pas la
marque du lot arrête tout, jamais « le reste ».

```text
PROJET   3 livraisons · 3 exécutions · 3 événements · 3 factures
         5 paiements · 13 audits · 14 webhooks · 2 contrats
PANEL    3 descripteurs · 3 mouvements · 3 faits · 6 actes
         6 liens Stripe · 1 projection · 3 fichiers
```

Inventaire après : seuls CTR-2026-0001 (DRAFT) et CTR-2026-0002 subsistent, avec
leurs 2 paiements, leurs 2 mouvements Panel et **leurs factures archivées**.
Zéro résidu de recette.

L'abonnement Stripe de la recette a été **résilié** par la capacité du plan de
contrôle avant suppression — sans quoi il aurait facturé tous les mois une
fixture disparue.

Une instance de portée PANEL de `PAYMENT_CONFIRMED_ADMIN`, posée pendant un état
intermédiaire de développement, a été retirée après vérification qu'elle ne
portait aucun contenu rédigé.

**Conservé** : les modèles et leurs déclarations, le contact public du
prestataire, l'état réparé de CTR-2026-0002 et ses factures archivées.

**Objets Stripe TEST non supprimables, documentés** :

```text
factures     in_1U6rdKGlI6vEcGH1t2bGAXVr  (QWSK7ZZY-0005)
             in_1U6sBKGlI6vEcGH12v0PKnmj  (QWSK7ZZY-0006)
             in_1U6sHpGlI6vEcGH1W4DDKrso  (QWSK7ZZY-0007)
abonnement   sub_1U6sBKGlI6vEcGH1nkpwrBpA  — RÉSILIÉ
clients      cus_V76N64gt8xNlkU · cus_V76UDJ2WNRb3tG
```

---

## 14 · Risques résiduels

**1. L'adresse ADMIN du projet de démonstration n'est pas délivrable.**
`admin@mail.com` est un libellé, pas une boîte. Le message de confirmation
client part correctement — accepté par Brevo, identifiant de message rendu — puis
**rebondit**. La chaîne est prouvée ; sa destination ne l'est pas. Aucun client
réel ne recevra rien tant que ce compte porte cette adresse.

**2. L'adresse de support publiée est un choix à confirmer.**
`luca.duhoux@lycarz.com` a été inscrite comme contact public du prestataire —
elle apparaît en pied de chaque e-mail client. Elle a été choisie parce qu'elle
est déjà l'identité professionnelle de L.Y Solution dans cet écosystème. À
valider avant PROD.

**3. Fichiers orphelins sur le serveur de recette.**
Les trois PDF archivés des contrats supprimés restent sur le disque du Panel
déployé, sans descripteur. Invisibles, servis par aucune route. Un ramassage de
médias les reprendra.

**4. Le Panel de développement écrit sur la base TEST partagée.**
C'est la configuration du poste, et elle a produit l'incident du §9. Elle reste
en place : la signaler suffit, la changer serait une décision d'exploitation.

**5. Libellé d'acteur dans la chronologie.**
« Frais de lancement payés — Plateforme de signature ». Un acteur `WEBHOOK` est
présenté comme une plateforme de signature. Cosmétique, antérieur au lot, hors
périmètre.

---

## 15 · Gardes posées

```text
1  aucune redirection ne marque un paiement payé          garde d'architecture, projet
2  un fait payé finit par converger vers le projet        recette réelle, deux parcours
3  « Vérifier » ne crée jamais de paiement                idempotent, vérifié deux fois
4  une transaction Stripe → un mouvement Panel            index unique canonique
5  une facture → une copie                                trois passages, un fichier
6  un encaissement → un message par destinataire          ALREADY_SENT au rejeu
7  pas de lien de facture, pas de message                 variable obligatoire + refus rejouable
8  un modèle PROJECT est déclaré par son consommateur     déclaration dérivée, unknown = 0
9  un modèle PANEL n'est jamais posé chez un projet       provisionForProjects false, vérifié
10 fermer la page n'empêche pas la convergence            retour refusé au réseau, deux fois
11 aucun identifiant non déclaré dans le runtime          garde statique, deux dépôts
12 ce qui traverse le pont est ce qu'on croit             charge utile lue, pas son aperçu
```
