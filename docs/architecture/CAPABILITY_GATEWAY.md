# Passerelle de capacités

> **Lot L3.** Une seule porte : un projet demande une **intention métier**, le
> Panel résout le fournisseur, le monde, le droit et la clé, puis exécute.
>
> **État : une capacité réellement servie** — `email.sender.verify`. Les dix
> autres sont déclarées, auditées, et attendent leur lot. Aucun credential
> projet n'a été supprimé.

---

## 0. L'invariant

```
LES PROJETS INVOQUENT DES CAPACITÉS.
ILS NE CONSOMMENT PAS D'IDENTIFIANTS DE FOURNISSEUR.
```

La chaîne complète, et l'ordre n'est pas négociable :

```
projet authentifié          ← bridgeToken, jamais la charge utile
      │
      ▼
capacité                    ← un VERBE métier, pas un fournisseur
      │
      ▼
octrois                     ← ce projet a-t-il le droit de le demander ?
      │
      ▼
environnement               ← le runtime de l'instance (L2), jamais un choix
      │
      ▼
politique commerciale       ← l'action réelle est-elle autorisée ? (L1.75)
      │
      ▼
coffre du Panel             ← identifiants chiffrés, déchiffrés au dernier moment
      │
      ▼
adaptateur                  ← le seul code qui connaît le fournisseur
```

Cinq objets sont régulièrement confondus. Ils sont distincts :

| | Répond à | Vit dans |
|---|---|---|
| **capacité** | « quelle intention métier ? » | `capabilityRegistry.js` (code-first) |
| **fournisseur** | « par quel moyen ? » | `providerRegistry.js` (L1) |
| **credential** | « avec quel compte ? » | `PanelIntegratedApiCredentialSet` (chiffré) |
| **webhook** | « qu'en dit le fournisseur, plus tard ? » | `services/webhooks/` (L5) |
| **projection métier** | « qu'est-ce que le projet en garde ? » | le projet, jamais le Panel |

---

## 1. Le registre

`backend/src/services/capabilities/capabilityRegistry.js` — **code-first**.
Rien en base ne peut ajouter, retirer ni modifier une capacité.

Quinze capacités, dix servies — et le catalogue se lit comme une carte de
l'avancement :

| Code | Fournisseur | Effet (L1.75) | Idempotence | Servie |
|---|---|---|---|---|
| `email.sender.verify` | BREVO | CONFIGURATION | `SAFE_RETRY` | **oui** |
| `email.send_template` | BREVO | COMMUNICATION_WRITE | `UNKNOWN_ON_TIMEOUT` | **oui** |
| `billing.invoice.list` | STRIPE | READ_ONLY | `SAFE_RETRY` | non · **appartenance** |
| `billing.checkout.retrieve` | STRIPE | READ_ONLY | `SAFE_RETRY` | **oui** · **appartenance** |
| `billing.subscription.reconcile` | STRIPE | READ_ONLY | `SAFE_RETRY` | non |
| `billing.customer.ensure` | STRIPE | REVERSIBLE_EXTERNAL_WRITE | `PROVIDER_IDEMPOTENT` | **oui** · **acte dérivé** |
| `billing.price.ensure` | STRIPE | REVERSIBLE_EXTERNAL_WRITE | `PROVIDER_IDEMPOTENT` | **oui** · **acte dérivé** |
| `billing.checkout.create` | STRIPE | FINANCIAL_WRITE | `PROVIDER_IDEMPOTENT` | **oui** |
| `billing.subscription.cancel_at_period_end` | STRIPE | FINANCIAL_WRITE | `PROVIDER_IDEMPOTENT` | **oui** · **appartenance** · **acte dérivé** |
| `billing.subscription.cancel_now` | STRIPE | FINANCIAL_WRITE | `PROVIDER_IDEMPOTENT` | **oui** · **appartenance** · **acte dérivé** |
| `billing.refund` | STRIPE | FINANCIAL_WRITE | `PROVIDER_IDEMPOTENT` | non |
| `signature.document.download` | YOUSIGN | READ_ONLY | `SAFE_RETRY` | non |
| `signature.request.create` | YOUSIGN | LEGAL_WRITE | `UNKNOWN_ON_TIMEOUT` | non |
| `dns.zone.resolve` | HOSTINGER | READ_ONLY | `SAFE_RETRY` | **oui** |
| `dns.records.read` | HOSTINGER | READ_ONLY | `SAFE_RETRY` | **oui** |
| `dns.record.ensure` | HOSTINGER | INFRASTRUCTURE_WRITE | `UNKNOWN_ON_TIMEOUT` | **oui** |

### Deux façons d'ancrer une ressource (L6.2F)

La colonne « appartenance » suppose qu'une ressource ait un propriétaire prouvable.
Jusqu'ici, la preuve venait d'une seule source : **le Panel l'a créée**.

L'abonnement a forcé une seconde voie. Stripe le fabrique lui-même au moment du
paiement — il n'existe aucune création à contrôler. Il est pourtant possédable,
par **filiation** :

```
     Session possédée  →  session.subscription  →  Subscription adoptée
```

Ce n'est pas un assouplissement : c'est le fournisseur lui-même qui, sur un
objet dont nous possédons déjà le lien, désigne la ressource comme issue de cet
objet. Une adoption reste donc une preuve — et pour qu'elle le demeure, la
fonction d'adoption **n'accepte aucun identifiant de ressource** : elle reçoit
l'objet d'origine et extrait la filiation elle-même.

Les metadata (`panelProjectId`, `contractId`) et la cohérence du client
corroborent, et sont enregistrées dans la preuve du lien. Aucune ne décide.

### Convergence par l'ÉTAT, et non par la seule clé (L6.2G)

L'idempotence de L6.2B repose sur une clé dérivée : rejouer un acte avec la même
clé rend la même réponse, tant que la fenêtre de Stripe la retient. C'est la
seule protection possible pour un **paiement**, dont l'état ne tranche pas :
une session absente peut signifier « jamais créée » comme « créée puis perdue ».

Une **résiliation** est différente, et cette différence est un fait vérifiable,
pas une commodité :

```
cancel_at_period_end   vaut true, ou il ne le vaut pas
status                 vaut 'canceled', ou il ne le vaut pas
```

Il n'existe aucun état intermédiaire. Relire l'abonnement répond donc exactement
à « l'acte a-t-il eu lieu ? ». La séquence est donc, dans cet ordre :

```
  appartenance prouvée  →  relecture d'état  →  mutation SI ET SEULEMENT SI absente
```

Trois conséquences, toutes éprouvées :

- un **rejeu** ne mute rien : il CONSTATE, et rend `outcome: 'ALREADY_CANCELLED'`,
  qui est un succès ;
- une **réponse perdue** laisse l'opération en `UNKNOWN` ; la reprise la conclut
  en relisant, sans jamais émettre une seconde coupure ;
- un **état illisible** ne devient pas une mutation : la capacité refuse en
  `PROVIDER_UNAVAILABLE` / `SUBSCRIPTION_STATE_UNREADABLE`, et rien ne part.

Ce dernier point est la règle générale du plan de contrôle : **on ne transforme
jamais l'incertitude en nouvelle mutation.**

Les deux verbes n'ont d'ailleurs pas la même nature. Le drapeau de fin de période
est convergent par construction — le poser deux fois donne le même état. La
coupure immédiate est **terminale**, et Stripe REFUSE de la rejouer : résilier un
abonnement déjà `canceled` rend une erreur. Sans la relecture, un rejeu légitime
ressemblerait à un échec — ce que produisait le chemin local.

### Une capacité peut en COMPOSER d'autres (L6.2E)

`billing.checkout.create` en mode abonnement enchaîne `customer.ensure` puis
`price.ensure` avant d'ouvrir la session : Stripe refuse une session qui
référencerait un objet inexistant, et cet échec surviendrait devant un client
qui paie.

Composer n'est pas fusionner. Chaque acte garde **sa** définition, donc **sa**
clé d'idempotence — un client déjà garanti n'est pas recréé parce qu'un tarif
manquait. Le piège est précis : passer la définition de l'appelant à l'acte
composé ferait dériver une clé différente de celle d'un appel direct, et
produirait un second client pour le même contrat. Invisible en test nominal.

### L'octroi ne suffit pas : certaines capacités exigent une APPARTENANCE (L6.2C)

La colonne « appartenance » marque les capacités qui manipulent une ressource
**préexistante** chez le fournisseur. Pour elles, l'octroi répond à « ce projet
a-t-il le droit de demander ce verbe ? » — et cela ne suffit pas. Il reste à
répondre à « cette ressource-là est-elle la sienne ? ».

Les deux questions sont distinctes, et la seconde est celle qu'on oublie :

```
     octroi      →  ce projet peut demander billing.checkout.retrieve
     appartenance →  … mais SEULEMENT sur les sessions que le Panel lui a liées
```

**L'ordre est la garantie.** L'appartenance est vérifiée AVANT tout contact
fournisseur. Interroger Stripe puis vérifier les metadata aurait trois défauts,
du plus visible au plus grave : on paierait un aller-retour pour une demande
illégitime ; la durée de réponse trahirait l'existence de la ressource ; et
l'autorisation reposerait sur des metadata **éditables depuis le tableau de bord
du fournisseur**, c'est-à-dire sur une donnée que le demandeur peut influencer.

Le refus est **indistinguable** : ressource inconnue, ressource d'un autre
projet et lien révoqué rendent le même code (`CAPABILITY_RESOURCE_NOT_OWNED`),
le même message et le même statut. Les distinguer donnerait un oracle
d'existence. Le motif réel part au journal du Panel, où il sert au diagnostic
sans servir de sonde.

Une capacité marquée « appartenance » mais non servie l'est pour une raison
précise : sa famille de ressources n'a **encore aucun lien** parce que le Panel
n'en a jamais créé. La colonne se lit donc comme une dette, et elle se résorbe
famille par famille.

### L'identité de l'acte : fournie, ou DÉRIVÉE (L6.2D)

Presque toutes les capacités reçoivent leur `operationId` du projet — lui seul
sait que deux clics sont la même intention, et le Panel ne peut que le constater
trop tard.

Un verbe `ensure` est différent par nature. « Garantir que ce contrat a un
client » n'a **qu'une réponse correcte**, déterminée par le contrat. Accepter une
identité fournie permettrait d'appeler deux fois sous deux noms et d'obtenir deux
clients : exactement ce que le verbe promet d'empêcher.

Le registre déclare alors `deriveOperationId`, une fonction **pure** de
`(context, input)` que la passerelle évalue avant de réserver l'opération. Pure,
parce qu'une dérivation qui interrogerait la base serait faite deux fois — à la
réservation et dans l'adaptateur — et les deux pourraient diverger sans que rien
ne le signale.

Le contrat d'entrée d'une telle capacité **refuse** `operationId` : un champ
décoratif qui ressemble à une autorité finit par en devenir une.

**Déclarée ≠ servie.** Une capacité non migrée est *connue* : sa politique, son
effet et son fournisseur sont établis, et l'écran l'annonce. Elle n'est
simplement branchée sur aucun adaptateur, et son invocation répond
`CAPABILITY_NOT_AVAILABLE`. Les taire produirait un `CAPABILITY_UNKNOWN`
mensonger.

### 1.1 Le registre n'invente rien

Il **agrège** trois autorités déjà écrites, sans jamais les recopier :

- `providerRegistry.js` → le fournisseur et sa portée (L1) ;
- `commercialReadiness.CAPABILITY_EFFECTS` → l'effet réel (L1.75) ;
- `brevo/brevoCapabilities.js` → le contrat métier Brevo (L8).

`assertRegistryAlignment()` échoue si l'une diverge — une capacité sans effet
déclaré échapperait à la politique commerciale, et une écriture financière
passerait en pré-ouverture.

---

## 2. L'ordre des refus

Neuf étapes. Trois choix méritent une justification, parce qu'ils ne sont pas
interchangeables.

| # | Contrôle | Refus |
|---|---|---|
| 1 | La capacité existe-t-elle ? | `CAPABILITY_UNKNOWN` (404) |
| 1 bis | Est-elle offerte au PONT ? (L13) | `CAPABILITY_UNKNOWN` (404) — voir ci-dessous |
| 2 | Qui parle ? | `CAPABILITY_PROJECT_SCOPE_MISMATCH` (403) |
| 3 | Quel monde ? | `CAPABILITY_ENVIRONMENT_MISMATCH` (409) |
| 4 | A-t-il le droit ? | `CAPABILITY_NOT_GRANTED` (403) |
| 5 | Le commerce est-il ouvert ? | `CAPABILITY_BLOCKED_PREOPENING` (409) |
| 6 | La capacité est-elle servie ? | `CAPABILITY_NOT_AVAILABLE` (409) |
| 7 | L'entrée est-elle conforme ? | `CAPABILITY_INPUT_INVALID` (400) |
| 8 | A-t-on des identifiants ? | `CAPABILITY_CREDENTIALS_MISSING` (409) |
| 9 | Exécuter | `CAPABILITY_PROVIDER_UNAVAILABLE` (502) · `CAPABILITY_TIMEOUT` (504) |

**La politique commerciale passe avant la disponibilité et avant le coffre.**
C'est ce qui garantit qu'une écriture financière refusée en pré-ouverture ne
touche *rien* — pas même le coffre. Si l'on testait d'abord « est-ce migré ? »,
la preuve « zéro appel fournisseur » reposerait sur l'absence d'adaptateur,
c'est-à-dire sur un accident de calendrier, et non sur la politique.

**Une capacité `panelOnly` est refusée avant tout contexte, et comme un code
INCONNU.** C'est la première fermeture du registre (L13,
`billing.settlement.retrieve`), et elle existe parce que ce verbe ne lit pas une
ressource de PROJET : il lit le registre de solde de L.Y Solution — ce que le
fournisseur de paiement a prélevé. Une telle écriture n'appartient à aucun
projet, et lui inventer un propriétaire aurait produit une garde décorative.

Le refus est *indistinct* d'un code inconnu, et il n'est pas journalisé.
Répondre « existe mais interdit » ferait du pont un oracle : on apprendrait, un
code à la fois, la surface interne du Panel. C'est la même doctrine que le refus
de filiation sur une facture étrangère (L6.3B), appliquée un cran plus haut.

La fermeture est une **exception**, jamais une commodité : toutes les autres
capacités prouvent l'appartenance de la ressource qu'on leur désigne, et sont
donc sûres à offrir. Un contrôle de recette vérifie qu'il n'y en a qu'une.

**L'entrée est validée avant les identifiants.** Un corps malformé ne doit pas
faire déchiffrer une clé : le coffre ne s'ouvre que pour un appel qui va partir.

**L'ouverture commerciale ne modifie jamais l'environnement.** Une instance en
pré-ouverture est en PROD : on lui refuse d'agir, on ne la bascule pas en TEST.
Confondre les deux recréerait `activeMode` sous un autre nom — exactement ce que
L2 a supprimé.

---

## 3. Le contexte d'invocation

```
TOUT CE QUI FAIT AUTORITÉ VIENT DU JETON DE PONT ET DU RUNTIME.
RIEN NE VIENT DE LA CHARGE UTILE.
```

| Champ | Source |
|---|---|
| `projectId` | `requireBridgeAuth` → hash du bridgeToken |
| `environment` | `config.env` du Panel (L2), confronté à la fiche |
| `commercialState` | `PanelProject.commercialState`, défaut fermé |
| `requestId` | en-tête `x-request-id` du projet, ou généré |

Trois champs de charge utile sont inspectés — `projectId`, `project_id`,
`projectKey` — parce que trois conventions existent dans le parc. Une valeur
**divergente** est refusée en 403 ; les ignorer serait accepter qu'un jour l'un
d'eux soit branché.

Un `projectId` **identique** passe la garde de portée… puis est refusé par le
schéma strict, comme n'importe quelle clé inconnue : il n'a rien à faire dans le
corps, puisque le jeton le porte. Deux refus, deux codes, deux gravités — et
c'est voulu.

---

## 4. Les octrois

```
AVANT   projet  →  accès à des CLÉS de fournisseur   (PanelIntegratedApi.grants[])
APRÈS   projet  →  droit d'invoquer une CAPACITÉ      (PanelProject.capabilityGrants[])
```

La différence n'est pas de vocabulaire. Un octroi de clé donne un pouvoir
illimité : qui détient la clé Stripe peut rembourser, facturer, lire tous les
clients. Un octroi de capacité donne un verbe. C'est la seule granularité qui
permette d'accorder « lister les factures » sans accorder « rembourser ».

**Un seul système.** `PanelIntegratedApi.grants[]` n'est **pas** lu, pas même en
repli : deux autorisations dont l'une est plus permissive finissent, un jour,
interrogées dans le mauvais ordre — et c'est toujours la permissive qui gagne.
L'ancien tableau reste en base (l'effacer détruirait une saisie manuelle pour un
gain nul), mais il ne gouverne plus rien.

**Fermé par défaut.** Un projet fraîchement appairé n'a aucun octroi.

Surfaces : `GET /api/projects/:projectId/capability-grants` (tout compte du
Panel — c'est un diagnostic) et `PUT` (DEV uniquement — accorder ouvre un chemin
vers un fournisseur réel).

---

## 5. Les identifiants

`resolveCredentialsForCapability(context, capability)` est la seule porte.

L'environnement est **dérivé deux fois** et les deux doivent concorder : la
portée du fournisseur (L1) et le contexte (L2). Un fournisseur `PANEL_GLOBAL`
rend `null` — lui inventer deux mondes dédoublerait un compte unique.

**Doctrine de disponibilité : `VALID` et empreinte à jour.** Pas seulement
« rempli ». Trois raisons, par gravité croissante :

- une clé jamais testée peut être une faute de frappe, et l'erreur sortirait
  alors chez le fournisseur au lieu d'être visible dans l'écran qui l'a saisie ;
- une clé remplacée après un test réussi n'est plus celle qui a été prouvée ;
- un jeu `ERROR` signifie « on n'a pas pu savoir » — le cas où il ne faut
  surtout pas tenter une écriture réelle en aveugle.

Les valeurs déchiffrées sont obtenues et consommées dans la même expression.
Elles ne sont jamais liées à une variable de portée large, jamais journalisées,
jamais attachées à une erreur.

---

## 6. Les adaptateurs

Une **table**, pas un `switch`. Une capacité pointe une fonction ; le jour où
Stripe arrive, on ajoute une ligne et un fichier.

```
reçoit  →  { definition, context, credentials, input }
rend    →  la SORTIE MÉTIER, validée par son schéma
lève    →  CapabilityError, jamais une erreur de fournisseur brute
```

Le transport Brevo n'est **pas** réécrit : L8 a livré
`integratedApi/brevo/brevoTransport.js` (délais bornés, erreurs typées, aucun
secret journalisé). L'adaptateur ne fait que traduire ses refus.

---

## 7. Entrée et sortie

Les deux schémas sont **`strict()`**.

Zod ignore les clés inconnues par défaut : un projet pourrait envoyer
`{ recipient, environment: 'PROD', apiKey: '…' }` sans que rien ne proteste. Les
champs seraient inertes — mais leur présence tolérée ferait croire, à qui relit
le code du projet, qu'ils agissent ; et un jour quelqu'un les brancherait « pour
faire marcher ce qui était déjà envoyé ». Un refus explicite tue l'idée à la
racine.

La **sortie** est validée aussi. Ce n'est pas une défiance envers l'adaptateur :
c'est une garantie sur ce qui sort. Un champ ajouté par inadvertance — un objet
de réponse fournisseur laissé au passage, un identifiant de compte — fait échouer
l'appel au lieu de traverser le pont.

Le diagnostic d'entrée **nomme les chemins fautifs, jamais leurs valeurs** : une
entrée refusée peut contenir une adresse, et un message d'erreur voyage.

---

## 8. Idempotence

Quatre stratégies, **par capacité**. Une stratégie unique serait fausse dans les
deux sens : appliquée partout, elle interdirait de relire un compte après un
hoquet réseau ; assouplie partout, elle enverrait deux fois le même e-mail.

| Stratégie | Signification |
|---|---|
| `NONE` | l'appel ne change rien |
| `SAFE_RETRY` | rejouer est sûr, même après un doute |
| `UNKNOWN_ON_TIMEOUT` | le fournisseur n'offre aucune clé : le silence laisse l'action indécidable |
| `PROVIDER_IDEMPOTENT` | le fournisseur déduplique (en-tête d'idempotence) |

`operationId` est fourni par le **projet** : lui seul sait que deux clics sont la
même intention. Le Panel le lui rend, pour qu'il rapproche son journal du nôtre.

---

## 9. Modèle d'échec

Quatre issues, et la troisième est la raison d'être du modèle :

```
SUCCEEDED   l'action a eu lieu, on en a la preuve
FAILED      l'action n'a PAS eu lieu, on en a la preuve
UNKNOWN     on ne sait pas — l'action a PEUT-ÊTRE eu lieu
BLOCKED     on a refusé d'essayer (droit, ouverture commerciale)
```

> **Un délai dépassé n'est pas un échec constaté.** La requête a pu aboutir chez
> le fournisseur et seule la réponse se perdre. Le ranger dans `FAILED`
> conduirait un appelant à rejouer, donc à doubler une action réelle. D'où
> `CAPABILITY_TIMEOUT` en **504** et non 502 : le projet doit pouvoir distinguer
> « il a dit non » de « il n'a rien dit ».

Aucun message de fournisseur n'est relayé. Son statut HTTP l'est — un nombre ne
fuit rien.

---

## 10. Observabilité

Journal et chronologie portent : capacité, fournisseur, projet, environnement,
`requestId`, `operationId`, durée, issue, code d'erreur.

Jamais : une entrée métier, une adresse, une sortie, un identifiant de
credential, une clé. Ce journal doit pouvoir être lu par n'importe quel opérateur
du Panel sans précaution.

Trois types d'événement, et la séparation compte : `CAPABILITY_GRANTS_UPDATED`
(décision d'opérateur), `CAPABILITY_INVOKED` (fait d'exploitation),
`CAPABILITY_REFUSED` (ce qu'on relit quand quelque chose ne marche pas).

L'écriture est **best-effort** : une invocation réussie dont la trace échoue
reste une invocation réussie, et lever ici ferait croire au projet qu'elle n'a
pas eu lieu — c'est-à-dire l'inciterait à la rejouer.

---

## 11. La surface de pont

```
POST /bridge/v1/capabilities/{code}/invoke      contrat 1.5.0
```

Montée **après** `requireBridgeAuth` : le `projectId` qui fait autorité vient du
jeton. Un montage au-dessus de la garde rendrait la capacité anonyme, donc
adressable par n'importe qui.

Le contrat passe de 1.4.0 à **1.5.0** — additif : un projet qui ignore cet
endpoint reste pleinement conforme, un Panel qui ne le sert pas aussi. La
compatibilité se joue sur la majeure.

Les refus voyagent avec leur code `CAPABILITY_*`, catalogue **distinct** de
`BRIDGE_*`. Un webhook de pont et un refus de passerelle ne décrivent pas la
même chose ; les fondre obligerait un client à deviner lequel il lit. Le client
du projet préserve ces codes plutôt que de les aplatir en `BRIDGE_INTERNAL`.

---

## 12. Ce qui n'a pas été fait, et pourquoi

**Le Manager de SB Auto n'est pas branché.** L'écran « Tester la connexion » lit
les identifiants **du projet** : son objet est de valider ce que le projet
détient. Le router vers le Panel changerait ce qu'il *signifie* — il testerait la
clé du Panel pendant que le projet continue d'utiliser la sienne à l'exécution.
L'écran mentirait. Le branchement honnête vient **après** la migration du runtime
Brevo, pas avant. La capacité est prouvée par l'E2E à la place.

**Aucun credential projet n'a été supprimé.** C'est délibéré : nouvelle capacité
éprouvée *et* ancien chemin disponible, jusqu'au lot de migration.

---

## 13. Tests

| Suite | Ce qu'elle prouve | Assertions |
|---|---|---|
| `capability-gateway` | la mécanique, refus par refus, en TEST | 104 |
| `capability-preopening` | pré-ouverture sur une instance réellement en **PROD** | 27 |
| `capability-gateway-e2e` | le bout en bout, par le pont réel | 58 |

L'**E2E** n'appelle jamais un service interne du Panel. Il entre par où entre le
projet : `PanelBridge.invokeCapability` → `HttpPanelClient` → réseau →
`/bridge/v1`. Le fournisseur est un vrai serveur HTTP local qui note **quelle clé
arrive** — la seule façon de constater ce qui sort réellement du coffre.

Ce qui est prouvé :

- un projet TEST atteint la clé TEST ; la clé PROD n'est **jamais** partie ;
- `environment`, `mode`, `provider`, `baseUrl`, `apiKey` dans la charge utile →
  refusés ;
- un `projectId` étranger → 403, un `projectId` redondant → 400 ;
- sans octroi, **zéro** appel fournisseur ;
- les sentinelles n'apparaissent ni dans la réponse, ni dans la chronologie du
  Panel, ni dans **aucune collection** de la base du projet ;
- en PROD × PREOPENING, les quatre écritures financières et juridiques sont
  bloquées, **l'environnement reste PROD**, et zéro appel part.

---

## 13 bis. Une régression rencontrée, et ce qu'elle apprend

Ajouter `invokeCapability` à `PANEL_CLIENT_METHODS` a cassé
`panel-push-liveness.test.js` : ce test construit un faux client à la main, et
`isPanelClient()` exige désormais l'interface **complète**.

La tentation était d'assouplir la garde — rendre la méthode optionnelle. C'eût
été la mauvaise correction. Un double partiel accepté aujourd'hui devient, à la
prochaine évolution du contrat, un test vert devant un client incapable ; et le
`PanelBridge` aurait levé un `TypeError` en production au lieu d'un refus propre.

Le double a donc été complété. La garde structurelle a fait exactement ce pour
quoi elle existe : signaler, à la compilation d'un test, qu'un contrat venait de
grandir.

---

## 14. Réserves

1. **Douze capacités sur dix-sept sont servies** (mise à jour L6.2G). Brevo et
   Hostinger sont migrés ; Stripe l'est pour l'ouverture et la lecture d'une
   session de paiement, le client d'un contrat, son tarif, la lecture d'un
   abonnement et ses **deux résiliations** — donc le cycle de vie complet d'un
   abonnement, de l'ouverture à la coupure. Restent sur le chemin local : la
   liste de factures (elle demanderait une liste plus large que son dû, et son
   appartenance ne se prouve pas objet par objet), le portail client, le
   remboursement — non contractualisé faute d'usage réel — et Yousign (L7).
2. **`PROD project → PROD credentials` n'est prouvé qu'en processus séparé.** Un
   Panel ne sert qu'un monde par processus ; l'E2E complet en PROD exigerait deux
   instances de Panel. `capability-preopening` couvre le versant PROD, l'E2E le
   versant TEST, et l'isolation croisée est prouvée dans les deux sens.
3. **`commercialState` n'est écrit par aucun geste produit.** Le champ existe et
   la passerelle le lit ; l'écran qui le bascule appartient au lot qui ouvrira la
   première instance réelle. Défaut fermé en attendant.
4. **Les octrois ne sont pas projetés vers le projet.** Un projet ne sait pas ce
   qu'il a le droit de demander avant de le demander. Une capacité
   `integrations.describe` le lui dirait — elle n'est pas dans ce lot.
