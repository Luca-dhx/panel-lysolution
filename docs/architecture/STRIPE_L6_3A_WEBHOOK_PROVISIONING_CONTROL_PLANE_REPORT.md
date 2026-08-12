# L6.3A — LE PROVISIONNEMENT WEBHOOK PASSE AU PLAN DE CONTRÔLE

> **Ce que L6.3 avait bloqué.** SB Auto enregistrait lui-même son endpoint chez
> Stripe (`POST /v1/webhook_endpoints`), au démarrage et à chaque changement de
> tunnel, avec **sa** clé secrète. C'était le dernier geste qui rendait cette clé
> indispensable — donc le dernier verrou empêchant de la retirer.

> **Ce que ce lot fait.** Le Panel provisionne désormais cet endpoint avec **sa**
> clé. L'endpoint continue de pointer vers le projet, et c'est toujours le projet
> qui vérifie les signatures — le Panel ne relaie pas les événements Stripe
> métier, et prétendre le contraire l'aurait rendu sourd.

> **Le point délicat.** Stripe ne rend le secret de signature **qu'à la
> création**. Il doit donc descendre jusqu'au projet, alors que la frontière L4
> interdit à tout identifiant fournisseur de franchir le pont. La réponse n'est
> pas une exception : c'est une **porte étroite** qui n'accepte qu'une seule
> forme, à côté d'un mur resté intact.

---

## 1. Qui provisionnait l'endpoint avant ?

**Le projet lui-même**, par une chaîne à quatre étages :

```
bootstrap.js:557          ensureAllWebhooks(mode)          à chaque démarrage
  └─ webhookOrchestrator  itère les drivers
      └─ integrationWebhookProviders  driver STRIPE, requiredCredential 'secretKey'
          └─ remoteWebhookSyncEngine  convergence : list → dédoublonne → crée/corrige
              └─ remoteWebhookAdapters.stripeWebhookAdapter
                    GET/POST/DELETE /v1/webhook_endpoints   ← clé du PROJET
```

Plus une **veille ngrok** toutes les 60 s en TEST, qui rejouait toute la chaîne
dès que l'URL publique changeait.

Le secret était capturé à la création par le moteur et rangé chiffré dans
`IntegratedApi.modes[mode].credentials.webhookSecret`. Si le secret local
manquait alors que l'endpoint distant existait, le moteur **supprimait puis
recréait** l'endpoint — la seule réparation honnête, puisque Stripe ne relivre
jamais un secret.

## 2. Qui le provisionne après ?

**Le Panel**, par la capacité `webhook.endpoint.ensure`, et avec la même
mécanique que pour ses propres endpoints — pas une seconde.

`webhookReconciler.js` a été **généralisé**, non dupliqué. Il reçoit désormais
une *portée* qui répond à trois questions qu'il déduisait auparavant :

| Question | Endpoint du Panel | Endpoint d'un projet |
|---|---|---|
| à qui appartient le lien ? | `destination: PANEL`, `projectId: null` | `destination: PROJECT`, `projectId` |
| quelle adresse enregistrer ? | `resolveWebhookCallback()` | fournie et **validée** |
| où ranger le secret capturé ? | coffre du Panel | coffre **du projet** |

Tout le reste est partagé et le reste : reconnaissance par jeton
d'appartenance, calcul de dérive, préflight du plafond Stripe, et la stratégie
« secret rendu à la création seulement » — créer d'abord, retirer ensuite, pour
ne jamais laisser de fenêtre sans écoute.

Côté projet, `createPanelBackedStripeWebhookManager` expose **exactement la même
surface** que le moteur générique. L'orchestrateur, le bootstrap, la veille
ngrok et l'écran de diagnostic l'appellent sans savoir que la main au bout a
changé.

## 3. Le projet appelle-t-il encore `/v1/webhook_endpoints` ?

**Non. Zéro occurrence dans tout le runtime**, vérifié par une garde statique
qui cherche l'**adresse** de la ressource et non un nom de fonction — un futur
helper qui la rappellerait autrement serait attrapé quand même.

`stripeWebhookAdapter` a été **physiquement supprimé** de
`remoteWebhookAdapters.js` (celui de Yousign reste, légitimement). Supprimé, pas
désactivé : il n'aurait fallu qu'une ligne dans la table des drivers pour le
rebrancher.

## 4. Le projet utilise-t-il encore sa secret key pour le provisionnement ?

**Non.** Le driver Stripe déclare `requiredCredentialName() === null` — et ce
n'est pas cosmétique : c'est cette déclaration que lit l'orchestrateur pour
décider s'il peut agir. La laisser à `'secretKey'` aurait fait sauter le
provisionnement le jour où la clé disparaîtra, sans que rien n'explique
pourquoi.

**Les lecteurs de la clé secrète passent de 3 à 2 :**

```
AVANT (L6.3)                                APRÈS (L6.3A)
services/stripe/stripe.provider.js          services/stripe/stripe.provider.js
services/webhooks/remoteWebhookAdapters.js  ← SUPPRIMÉ
services/providerConnectionTest.service.js  services/providerConnectionTest.service.js
```

La garde statique gèle cette liste : en ajouter un troisième fait rougir la
suite.

## 5. Où vit le signing secret ?

**Dans deux coffres distincts, et c'est délibéré.**

Côté Panel : `PanelProjectWebhookSecret`, un modèle **dédié**, chiffré, avec un
index unique `(projectId, provider, environment)`.

Pourquoi pas le coffre existant ? Parce qu'il range par `(fournisseur, monde)`
et n'a **aucune dimension projet**. Le secret d'un projet y aurait eu la même
clé que celui du Panel : l'un aurait écrasé l'autre, et le Panel aurait cessé de
vérifier ses propres événements — un incident qu'on aurait attribué à Stripe.

Côté projet : inchangé — `IntegratedApi.modes[mode].credentials.webhookSecret`,
chiffré, exactement là où il était. C'est lui qui vérifie les signatures ; seule
son **origine** change.

## 6. Comment est-il transmis ?

Par **une route dédiée**, et non dans le résultat de la capacité :

```
GET /bridge/v1/webhooks/{provider}/verification-secret   →   { webhookSecret }
```

La tentation était de le rendre dans la réponse de `webhook.endpoint.ensure` :
un champ de plus, aucune route à écrire. Elle a été écartée pour une raison
précise — le résultat d'une capacité traverse `assertNoProviderSecrets`. Y
glisser un `whsec_` aurait exigé de désactiver la garde pour ce cas,
c'est-à-dire d'ajouter un drapeau qui se serait propagé à la capacité suivante.
**Une garde qu'on peut désactiver n'est plus une garde.**

La capacité ne rend donc qu'un constat : `endpointId`, `url`, `events`,
`created`, `updated`, `secretAvailable`, `secretRenewed`. Le projet apprend
**qu'il y a** un secret à relire, jamais lequel.

Aucun `projectId` dans l'URL : celui qui fait autorité vient du **jeton de
pont**. Un projet ne peut demander que le sien.

## 7. Pourquoi cette transmission ne viole-t-elle pas la frontière L4 ?

Parce qu'elle **renverse la règle au lieu de l'assouplir**.

`assertNoProviderSecrets` interdit une **liste** de choses, et n'a pas bougé
d'un caractère : elle refuse toujours tout identifiant fournisseur, par son nom
comme par sa forme, sur le journal de synchronisation, les résultats de
capacité et l'appairage. Aucun `allowSecrets`, aucune exception « sauf Stripe ».

La nouvelle garde, `assertVerificationSecretOnly`, n'autorise qu'**une seule**
chose, et refuse tout le reste :

- exactement **un** champ — un de plus est refusé ;
- dont le nom est un rôle déclaré `verificationOnly` **au registre** — pas une
  liste codée en dur, donc le cinquième fournisseur en héritera ;
- dont la valeur a la **forme** d'un secret de signature — c'est ce contrôle qui
  attrape une clé `sk_…` rangée sous le nom `webhookSecret`.

Le nom autorise, la forme confirme : l'un sans l'autre se contourne.

Le registre porte cette distinction parce qu'elle est **réelle**, pas
commode :

```
sk_…      permet d'APPELER Stripe — créer, supprimer, déplacer de l'argent
whsec_…   permet UNIQUEMENT de constater qu'un message reçu vient de Stripe
```

Détenir le second n'autorise rien ; cela permet seulement de ne pas être trompé.

Et l'E2E le vérifie dans les deux sens : le même secret **passe** par le canal
étroit et **reste refusé** par le canal ordinaire.

## 8. Peut-il être utilisé pour appeler Stripe ?

**Non**, et c'est vérifié structurellement de trois façons :

1. **Le transport ne le lit pas.** `stripe.provider.js` ne contient pas une
   occurrence de `webhookSecret` — garde statique.
2. **Le diagnostic non plus.** `providerConnectionTest.service.js` ne le lit pas.
3. **Le coffre le refuserait de toute façon.** `storeProjectVerificationSecret`
   valide la forme **à l'écriture** : une clé d'appel glissée là — par erreur,
   par copier-coller, par un futur appelant distrait — est rejetée avant
   d'atteindre la base, donc avant de pouvoir être livrée.

## 9. Que se passe-t-il lors d'un changement ngrok ?

Le scénario D de l'E2E l'exécute réellement :

```
nouvelle URL détectée
  → le projet demande ENSURE avec sa nouvelle adresse
  → le Panel constate la dérive d'URL
  → il CORRIGE l'endpoint existant (POST sur l'id), il n'en crée pas un second
  → un seul endpoint subsiste, pointant vers la nouvelle adresse
  → le lien retient la nouvelle adresse publique
```

**Aucune création superflue** : le compteur du faux Stripe le prouve. Et le
secret n'est pas renouvelé — corriger une URL n'oblige à rien changer, donc le
projet continue de vérifier avec ce qu'il a.

## 10. Que se passe-t-il si le secret est perdu ?

C'est le cas que Stripe rend inévitable : il ne relivre **jamais** un secret.

La stratégie n'a pas été inventée pour ce lot — elle existait déjà dans le
réconciliateur du Panel, sous `SECRET_DELIVERY.AT_CREATION_ONLY`, et elle
s'applique désormais aux endpoints de projet :

```
endpoint présent, secret absent
  → CRÉER un endpoint neuf (même URL)          ← d'abord
  → capturer son secret, le ranger
  → RETIRER l'ancien                            ← ensuite
```

L'ordre est l'invariant : créer avant de retirer, pour qu'il n'existe **aucune
fenêtre sans écoute**. Pendant le recouvrement, les deux endpoints pointent vers
la même adresse ; le projet reçoit donc les événements des deux, et il en vérifie
au moins une partie — jamais zéro.

Côté projet, **pas de fenêtre de rotation** : il ne détient qu'un secret à la
fois. Lui en confier deux l'obligerait à essayer les deux, donc à accepter plus
longtemps un secret retiré.

## 11. Comment évite-t-on deux endpoints concurrents ?

**Trois filets, dont deux structurels.**

1. **Sérialisation par projet** — les demandes du même projet s'attendent : la
   première crée, les suivantes constatent.
2. **Index unique** `(provider, environment, destination, projectId)` sur le
   binding. Deux processus du Panel ne peuvent pas produire deux liens, donc pas
   deux endpoints.
3. **Reconnaissance par jeton d'appartenance** — un endpoint orphelin laissé par
   un processus tué est reconnu comme le nôtre au passage suivant, au lieu d'être
   pris pour celui d'un tiers et doublé à côté.

Scénario C de l'E2E : **huit demandes simultanées, zéro création
supplémentaire, un seul lien en base.** Et sur l'ensemble du fichier —
quatorze demandes servies — le fournisseur ne compte que **deux** créations,
une par projet.

L'index préserve d'ailleurs la règle d'origine : pour un endpoint du Panel,
`destination = 'PANEL'` et `projectId = null`, donc la clé retombe exactement
sur l'ancienne, et « un seul endpoint Panel par fournisseur et par monde » tient
telle quelle.

## 12. TEST/PROD sont-ils isolés ?

**Oui**, et à quatre niveaux :

- `assertCallbackEnvironment(environment)` — **fail closed avant toute
  écriture** : une callback PROD ne s'enregistre jamais depuis une instance TEST,
  quel que soit le destinataire ;
- le binding porte l'environnement dans sa clé unique ;
- le secret est rangé par `(projectId, provider, environment)` ;
- l'environnement de la livraison vient du **runtime du Panel**, jamais de la
  demande : un projet TEST ne peut pas réclamer le secret PROD.

Scénario H : après tout le fichier, **aucun lien PROD, aucun secret PROD**, et
la clé PROD du coffre n'a émis **aucun appel**.

En PROD, l'adresse doit de surcroît être en **HTTPS** — un endpoint en clair
exposerait des événements de paiement sur le réseau. En TEST, un tunnel local en
HTTP reste accepté : c'est le monde où l'on éprouve.

## 13. Un webhook métier atteint-il toujours le projet ?

**Oui**, et c'est la section la plus importante du lot (scénario J).

« L'endpoint est créé » ne prouve rien. Ce qui compte est qu'un événement signé
**du secret réellement livré** traverse encore la vérification du projet et
atteigne sa logique métier. L'E2E monte donc le **vrai routeur webhook** du
projet, avant `express.json()` comme en production — une signature Stripe se
vérifie sur le corps brut — et poste un `checkout.session.completed` signé.

```
✓ le projet ACCEPTE un événement signé du secret livré
✓ …et REFUSE une signature qui ne vient pas de Stripe
```

Le second contrôle rend le premier significatif : une route qui accepte tout
accepterait aussi une signature valide.

## 14. Quels appels Stripe locaux restent après le lot ?

**`LOCAL_RUNTIME_STRIPE_API_CALLS` : 6 → 5.**

```
createBillingPortalSession   WRITE   portail client            → L6.3B
retrievePaymentIntent        READ    réconciliation des frais  → L6.3B
retrieveInvoice              READ    ×2                        → L6.3B
listInvoices                 READ    ×2                        → L6.3B
GET /v1/account              READ    diagnostic de connexion   → L6.3 FINAL
/v1/webhook_endpoints        WRITE   ─────────── SUPPRIMÉ (L6.3A)
```

Les quatre appels métier et le diagnostic appartiennent à L6.3B / L6.3 FINAL et
**n'ont pas été touchés**, conformément à la phase 13.

## 15. Quels SECRET_READS restent ?

**`LOCAL_RUNTIME_STRIPE_SECRET_READS` : 3 → 2.**

```
services/stripe/stripe.provider.js            les 4 appels métier restants
services/providerConnectionTest.service.js    le diagnostic
```

Aucun service métier ne lit la clé — vérifié explicitement.

## 16. Quels SECRET_WRITES restent ?

**`PROJECT_STRIPE_SECRET_WRITES ≠ 0` — inchangé, et volontairement.**

`PUT /api/integrated-apis/STRIPE/modes/:mode` accepte toujours `secretKey`, et
le Manager affiche toujours le champ. La phase 13 l'interdit explicitement pour
ce lot : tant que les quatre appels métier existent, verrouiller l'écriture
casserait un parcours réel. Ce sera le geste de **L6.3 FINAL**.

**`LOCAL_STRIPE_FALLBACKS = 0` — inchangé.** Le nouveau chemin n'en introduit
aucun : un Panel injoignable fait **échouer** le provisionnement, il ne
rouvre rien. Un projet non appairé **saute** proprement, avec le motif
`PANEL_NOT_PAIRED` — il remplace exactement l'ancien `API_KEY_MISSING` : hier on
sautait faute de clé locale, aujourd'hui faute de Panel. Le geste sauté est le
même ; ce qui l'autorisait a changé de main.

## 17. Quels fichiers ont été supprimés ?

**Aucun fichier entier** — des fragments, parce que chaque fichier touché
contient encore du code légitime :

```
services/webhooks/remoteWebhookAdapters.js   −stripeWebhookAdapter, stripeAuth,
                                              stripeCall, stripeForm (~90 lignes)
                                              Yousign reste intact
```

**Créés** — Panel : `PanelProjectWebhookSecret.model.js`,
`projectWebhookSecrets.js`, `webhookVerification.controller.js`,
`stripe-webhook-provisioning-e2e.test.js`. SB Auto :
`panelWebhookProvisioning.js`.

## 18. Quels travaux parallèles ont été préservés ?

**L10.5 est arrivé en cours de lot** et a modifié **les mêmes fichiers que moi**.
C'est la collision que la phase 0 anticipait, et elle a été traitée par hunk.

**Trois fichiers réellement partagés :**

| Fichier | Mes hunks | Hunks L10.5 | Mixtes |
|---|---|---|---|
| `bridge/bridgeContract.js` | 1 (la route) | 1 (`PAYMENT_REQUEST`) | **0** |
| `stripe/stripeCapabilities.js` | 3 | 2 (`paymentRequestId`) | **0** |
| `stripe/stripeAdapters.js` | 3 | 2 | **0** |

Aucun hunk mixte : la séparation est nette. Ils ont été stagés **hunk par hunk**,
en reconstruisant le contenu « HEAD + mes hunks seulement » et en l'écrivant
dans l'index — jamais en stageant le fichier entier. Vérification après coup :
**zéro occurrence** de `L10.5`, `paymentRequest`, `PAYMENT_REQUEST` ou
`prestation` dans le diff indexé ; six occurrences de `L6.3A`. Les trois fichiers
restent `MM` : mes hunks dans l'index, les leurs intacts dans l'arbre.

**Neuf fichiers exclusivement L10.5**, ni lus pour décision, ni modifiés, ni
restaurés, ni reformatés, ni stagés :
`finances.controller.js`, `finances.routes.js`, `PanelProviderRevenueFact.model.js`,
`PanelSupervision.model.js`, `panelEmailTemplateRegistry.js`,
`revenueProjection.service.js`, `stripeRevenueNormalizer.js`,
`recurringCostScheduler.js`, `stripeCheckoutAuthority.js`, plus
`PanelPaymentRequest.model.js` et `finance/paymentRequests/`.

**Un point d'attention traité et vérifié** : j'ai recopié la spec maîtresse de
SB Auto vers la copie du Panel (`docs/spec/PanelBridge.openapi.yaml`). Le diff
montre **71 insertions et zéro suppression** — la copie était identique avant, et
rien d'étranger n'a été écrasé.

`git add -A`, `git add .`, stash, reset et checkout globaux n'ont jamais été
employés.

## 19. Tests exacts

| Suite | Résultat |
|---|---|
| **`stripe-webhook-provisioning-e2e`** (nouvelle, Panel) | **61 / 0** |
| `stripe-local-surface` (SB Auto, étendue) | **67 / 0** |
| SB Auto — `npm test` (78 fichiers chaînés) | **exit 0, zéro échec** |
| Panel — `webhook-control-plane` | 235 / 0 |
| Panel — `bridge-conformity` | 57 / 3 — **les 3 sont L10.5** (voir ci-dessous) |
| Panel — `capability-gateway` · `stripe-control-plane` | 120 / 0 · 128 / 0 |
| Panel — `bridge-provider-secret-boundary` | 54 / 0 |
| Panel — `tests/run-all.js` | **103 / 107** |
| Panel frontend · manager · vitrine — `tsc` + build | OK · OK · OK |

**L'E2E couvre les huit scénarios exigés**, plus la non-régression métier :

| # | Scénario | Section |
|---|---|---|
| A | projet sans endpoint → création → secret → webhook signé accepté | A + J |
| B | redémarrage → aucun second endpoint | B |
| C | 8 ENSURE concurrents → un seul endpoint logique | C |
| D | l'URL TEST/ngrok change → convergence | D |
| E | la clé sentinelle du projet n'atteint jamais Stripe | E |
| F | fournisseur muet → échec franc, aucun repli | F |
| G | le secret de A est inaccessible à B | G |
| H | TEST et PROD, isolation complète | H |
| — | la porte étroite : ce qu'elle accepte et tout ce qu'elle refuse | I |
| — | **un événement signé atteint toujours le métier** | J |

**Les 4 fichiers rouges du Panel sont ceux de L10.5**, et la causalité est
établie plutôt qu'affirmée :

- `bridge-conformity` (×3) — `SYNC_ENTITY_TYPES` en compte 16 au lieu de 15 ;
  le seizième est `PAYMENT_REQUEST`, absent de mon index, présent dans le hunk
  non stagé de L10.5, et absent des deux specs qu'ils devront mettre à jour.
- `brevo-send-template-foundation` (×5) et `architecture` (×1) — les deux
  nomment `panelEmailTemplateRegistry.js`, modifié uniquement par L10.5 et
  absent de mon commit.

Aucun n'a été « réparé » : ce n'est pas mon lot. Les trois autres reds que
j'avais causés en touchant le contrat de pont — décompte de chemins, dérive de
spec — ont été corrigés, eux, parce qu'ils étaient miens.

**Un incident de méthode, à noter honnêtement.** J'ai lancé la suite complète du
Panel en arrière-plan pendant que j'éditais le même dépôt : sept fichiers ont
« échoué » sur un état intermédiaire de mes propres fichiers
(`WEBHOOK_DESTINATION_VALUES` référencé avant d'être défini). Cette mesure était
sans valeur et a été jetée ; toutes les suites rapportées ici ont été exécutées
séquentiellement, arbre stable.

## 20. Commits Panel / SB Auto

Voir la section « Livraison » ci-dessous.

---

## Compteurs — L6.3 → L6.3A

```
LOCAL_RUNTIME_STRIPE_API_CALLS       6  →  5      ↓  (−/v1/webhook_endpoints)
LOCAL_RUNTIME_STRIPE_SECRET_READS    3  →  2      ↓  (−remoteWebhookAdapters)
LOCAL_STRIPE_FALLBACKS               0  →  0      =  ✔
PROJECT_STRIPE_SECRET_WRITES        ≠0  → ≠0      =  (L6.3 FINAL, phase 13)

SURFACE DU PILOTE STRIPE             4  →  4      =  (hors périmètre)
LECTEURS DE LA CLÉ, SERVICES MÉTIER  0  →  0      =  ✔
```

Aucun compteur n'a augmenté.

## Réserves

1. **Le plafond Stripe redevient une contrainte de croissance.** L5 avait
   ramené le parc à un endpoint par monde ; un endpoint par projet y ajoute
   autant de lignes que de projets, contre un plafond de 16 par compte. Le
   préflight du réconciliateur le détecte **avant** de créer et le dit
   franchement, mais c'est une limite réelle. La seule sortie serait que le
   Panel relaie les événements Stripe métier vers les projets — un lot à part
   entière, qui rendrait aussi le secret de vérification inutile.

2. **Un secret traverse désormais le pont.** La porte est étroite et gardée dans
   les deux sens, mais elle existe. Le jour où un cinquième fournisseur déclare
   un rôle `verificationOnly`, il l'empruntera automatiquement — c'est voulu
   (le registre fait autorité), mais cela mérite d'être relu à ce moment-là.

3. **Le diagnostic de connexion reste trompeur.** `testWebhooks` ne va plus
   interroger Stripe — il ne le peut plus — et rend ce qu'il sait : adresse
   attendue, présence d'un secret, joignabilité de sa propre route. C'est plus
   honnête qu'avant, mais un opérateur habitué à « le test vérifie chez
   Stripe » verra un diagnostic plus pauvre.

4. **Huit sections de `webhook-providers-uniformity` ont été retirées.** Elles
   éprouvaient la convergence locale — création, dédoublonnage, secret perdu,
   isolation TEST/PROD. Ces comportements n'ont pas disparu : ils ont déménagé
   chez le Panel et sont éprouvés par le nouvel E2E. Les rejouer côté projet
   aurait exigé de simuler Stripe pour un code qui ne lui parle plus.

5. **Le rapport L6.3 disait « le réconciliateur suppose que l'endpoint pointe
   vers le Panel ».** C'était exact, et c'est ce qui a été levé. Mais la
   généralisation touche un fichier partagé par Brevo, Yousign et Hostinger :
   leurs chemins passent désormais par une portée par défaut (`PANEL_SCOPE`).
   Les suites correspondantes sont vertes, et l'invariant « un endpoint Panel
   par fournisseur et par monde » est explicitement re-vérifié — mais c'est le
   changement le plus large du lot.

---

STRIPE WEBHOOK PROVISIONING CONTROL PLANE: PASS

GO L6.3B: YES
