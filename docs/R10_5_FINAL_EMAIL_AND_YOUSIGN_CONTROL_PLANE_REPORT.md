# R10.5 — Expéditeur e-mail global et signature Yousign sous plan de contrôle

**Portée** : Panel (plan de contrôle) + SB Auto 06 (instance projet).
**Baselines** : Panel `65aec6d` → `feat/generic-deployment-engine`, SB Auto `f4e30f3` → `feat/unified-production-baseline`.

Ce document décrit **ce qui a changé, pourquoi, et ce qui le prouve**. Il est
rédigé pour être relu le jour d'un incident : chaque décision y est accompagnée
du défaut qu'elle empêche, parce que c'est cette information-là qui manque
toujours au moment où on en a besoin.

Aucun secret n'y figure : ni clé d'API, ni secret de webhook, ni en-tête
d'autorisation. Il est collable dans un ticket tel quel.

---

## 1. Ce que le lot ferme

Deux surfaces locales qui n'avaient plus lieu d'être, et une troisième qui
n'aurait jamais dû exister.

| Surface | Avant | Après |
|---|---|---|
| Expéditeur e-mail (`From`, `senderName`) | choisi par chaque projet | **global, tenu par le Panel** ; le projet ne garde que son `Reply-To` |
| Envoi de test Brevo | endpoint local dans le projet | supprimé ; le Panel envoie réellement et rend un rapport collable |
| Signature Yousign | client local, clé locale, webhook local | **cinq capacités du Panel** ; webhook reçu par le Panel, projeté durablement |

L'invariant commun : **un projet ne détient plus de clé d'appel vers un
fournisseur administré par la plateforme.** Ni pour envoyer, ni pour signer, ni
en repli.

---

## 2. L'expéditeur global (R10.4B / R10.5A-B)

### La doctrine, et pourquoi elle a été renversée

Chaque projet posait son propre `From`. C'était souple, et faux : l'adresse
d'expédition engage la **réputation du domaine d'envoi**, qui est mutualisée.
Un projet qui pose une adresse non vérifiée dégrade la délivrabilité de tous
les autres — et le constat arrive des semaines plus tard, sous forme de
messages qui n'arrivent plus, sans qu'aucun écran ne relie l'effet à la cause.

Le `From` est donc **global**, posé une fois côté Panel. Le `Reply-To` reste par
projet : c'est lui qui porte l'identité visible du client, et il n'engage aucune
réputation.

### Ce qui a été supprimé, et dans quel ordre

L'ordre a compté. Retirer le champ avant ses lecteurs aurait produit un blocage
permanent : `brevoOperational` refusait tout envoi quand l'expéditeur local
manquait, et ce refus figurait dans `DELIVERY_BLOCKERS` — un blocage
**impossible à lever**, puisque le champ à remplir n'existait plus.

Séquence appliquée :

1. les lecteurs (`assertBrevoOperational`, garde d'expéditeur, formulaire du
   Manager) ;
2. les écritures (`PUT /email-configuration/sender`, `POST /test-send`) ;
3. le transport local (`brevoEmail.service.js`) ;
4. **puis seulement** le champ, par une purge ciblée et idempotente
   (`purgeLocalSenderIdentity`, `$unset` sur le seul chemin concerné).

### Preuves

- `PANEL_GLOBAL_SENDER_NOT_CONFIGURED` : un envoi sans expéditeur global échoue
  **franchement**, plutôt que de partir avec une adresse devinée.
- L'écriture d'un `fromEmail` par un projet est refusée avec
  `PANEL_PROJECT_FROM_NOT_CONFIGURABLE` — un refus qui **nomme** la règle.
- Compteurs `PROJECT_LOCAL_FROM_*` et `PROJECT_LOCAL_BREVO_*` : **0**.

---

## 3. La signature sous plan de contrôle (R10.5C)

### 3.1 Le chemin aller — cinq capacités

```
projet ──invokeCapability──▶ PANEL ──▶ Yousign
```

| Capacité | Effet | Idempotence |
|---|---|---|
| `signature.request.open` | `LEGAL_WRITE` | `UNKNOWN_ON_TIMEOUT` |
| `signature.request.retrieve` | lecture | `SAFE_RETRY` |
| `signature.signer.retrieve` | lecture | `SAFE_RETRY` |
| `signature.document.download` | lecture | `SAFE_RETRY` |
| `signature.request.cancel` | `LEGAL_WRITE` | `SAFE_RETRY` |

Le projet n'orchestre plus rien : il demandait autrefois cinq appels Yousign
(créer, téléverser, déclarer les signataires, poser les champs, activer) en
gérant lui-même le nettoyage du brouillon en cas d'échec intermédiaire. Il
demande maintenant **un verbe** et reçoit **un fait**.

### 3.2 L'ordre de la passerelle, et pourquoi il est ce qu'il est

```
capacité existe → qui parle → quel monde → octrois → OUVERTURE COMMERCIALE
→ servie ? → schéma d'entrée → COFFRE → exécution
```

La porte commerciale est **avant** le coffre. Ce n'est pas cosmétique :
cela rend vrai **par construction** l'énoncé « un refus d'ouverture commerciale
n'a produit aucun contact fournisseur ». Placer le coffre avant aurait laissé le
Panel déchiffrer une clé pour une opération qu'il refuse — et un secret
déchiffré est un secret exposé, même une milliseconde, même en mémoire.

### 3.3 L'appartenance, avant le coffre

Toute lecture ou écriture sur une demande existante passe d'abord par la table
de liens (`PanelSignatureBinding`). Une ressource qui n'appartient pas au projet
appelant est refusée **avant** tout déchiffrement.

Le refus est volontairement **indistinguable** d'un « ça n'existe pas ».
Répondre « existe, mais pas à vous » confirmerait l'existence du contrat d'un
autre projet — c'est-à-dire transformerait la passerelle en oracle
d'énumération.

### 3.4 Le verrou, et sa sortie

Ouvrir une signature **réserve** le contrat (`pending:<operationId>`) *avant*
d'appeler Yousign. Sur une issue **indéterminée** (délai dépassé, injoignable,
réponse illisible), la réservation **n'est pas libérée**.

C'est délibéré et c'est coûteux. La demande a peut-être été créée : libérer
autoriserait une seconde ouverture, donc **une seconde sollicitation d'une
personne réelle** — un client qui reçoit deux fois le même contrat à signer, et
un dossier dont on ne sait plus lequel fait foi.

La contrepartie est une **sortie tracée** : `GET /api/signature-reservations`
liste les réservations bloquées, et leur libération manuelle exige un motif et
produit un événement d'audit de niveau `WARNING`. Un verrou sans sortie serait
un incident permanent ; une sortie sans trace serait pire.

### 3.5 Deux clics, une seule demande

`operationId` est **dérivé du contrat** (`sig-open-<contractId>`), pas tiré au
hasard. Deux clics produisent donc la même clé, donc le même acte : le registre
d'opérations du Panel les fait **converger**. Une clé aléatoire aurait laissé le
second clic passer pour une intention distincte, et seul l'index partiel « une
demande vivante par contrat » l'aurait rattrapé — plus tard, et moins
clairement.

### 3.6 La doctrine de l'indéterminé

Un délai dépassé, un fournisseur injoignable ou une réponse malformée rendent
`UNKNOWN`, **jamais** `FAILED`.

`FAILED` signifie « rien ne s'est produit » et invite à rejouer. Sur une
ouverture de signature, rejouer ce qui a peut-être réussi **double la
sollicitation d'un signataire réel**. L'indéterminé est inconfortable ; le faux
négatif est nuisible.

### 3.7 La borne de taille

Le PDF transite en base64 sur la passerelle JSON. La limite est **12 Mio**, et
elle est vérifiée **côté projet, avant le pont**, puis **côté Panel**.

Le refus local n'est pas une seconde autorité : c'est une politesse pour
l'appelant. Transporter 20 Mio de base64 pour s'entendre dire non serait
absurde. Le message parle la langue de l'exploitant — des mégaoctets de PDF, pas
des caractères de base64 — et **dit quoi faire** (« Allégez le PDF »).

Le contrôle d'entrée s'exécute **avant** le garde du plan de contrôle : dans
l'ordre inverse, un document trop volumineux aurait été signalé comme « Panel
injoignable », envoyant l'exploitant chercher une panne réseau inexistante.

---

## 4. Le chemin retour — le webhook a déménagé

```
Yousign ──webhook──▶ PANEL ──fait durable via le pont──▶ projet
```

### Pourquoi

Avant, Yousign appelait **le projet**. Un événement reçu pendant que le projet
était éteint était **perdu** : le fournisseur réessaie, mais rien ne garantissait
la convergence, et un contrat pouvait rester éternellement « en cours » alors
qu'il était signé. C'est la leçon de Brevo en L8.4 : après cutover, les webhooks
suivent **le compte**, donc le Panel.

Le destinataire n'est **jamais** lu dans la charge utile — il est résolu par le
lien d'appartenance que le Panel a écrit **avant** d'appeler Yousign. Un
`projectId` lu dans le corps du webhook serait une proposition d'un tiers,
c'est-à-dire le chemin par lequel quelqu'un ferait router ses événements vers le
projet de son choix.

### Deux défauts de forme trouvés et corrigés

Ces deux-là méritent d'être lus en entier : **aucun des deux ne lève**, et tous
deux font disparaître le fait en silence.

**1. `entityId` doit être un UUID.**
Le contrat de pont l'impose (`syncChangeSchema`). La référence de contrat de SB
Auto est un ObjectId de 24 hexadécimaux — l'émettre telle quelle faisait rejeter
**la page entière** en `BRIDGE_INVALID_PAYLOAD`. Aucun événement de signature
n'aurait jamais atteint le projet, et le Panel aurait cru avoir livré. L'identité
est désormais **dérivée** (`toBridgeEntityId`, déterministe) ; la référence
métier voyage dans la charge utile, où l'applicateur la lit.

**2. Les applicateurs reçoivent `({ change })`.**
L'applicateur de signature prenait `change` directement. Sur les deux registres,
il aurait donc lu une charge utile absente et répondu « verbe inconnu » —
**en acquittant**. Le pont aurait été vert, la signature perdue.

### Deux registres, et il faut les deux

`changeAppliers` sert quand le Panel **livre** (poussée immédiate) ;
`applyHandlers` sert quand le projet **tire** (rattrapage). Un type inscrit dans
un seul des deux fonctionne tant que le projet est en ligne, puis disparaît
silencieusement dès qu'il a été absent — c'est-à-dire **exactement le cas que la
bascule du webhook existe pour couvrir**. `SIGNATURE_EVENT` est inscrit dans les
deux, et le test le vérifie.

### La charge utile est minimale

`event`, `contractRef`, `signatureRequestId`, `signerId`, `providerEvent`,
`occurredAt`. Ni nom, ni adresse, ni document : le projet les détient déjà, et
les recopier ferait du journal durable du Panel un **second exemplaire de
données personnelles** à protéger, à purger et à justifier.

`signerId` est le seul fragment d'identité qui traverse — une référence
**opaque**. Sans lui, le projet apprendrait qu'« une » signature a eu lieu sans
savoir laquelle : il ne pourrait plus horodater séparément le développeur et le
client, ni ouvrir le contrat à la contresignature au bon moment. Le parcours
s'arrêterait à mi-chemin, sans erreur, sans trace.

### L'application est idempotente et monotone

Deux règles, et elles suffisent :

- rejouer un fait déjà appliqué ne change rien ;
- un fait ne peut pas faire **reculer** l'état.

La seconde est la plus importante : sans elle, un `signer.done` retardé
rouvrirait un contrat déjà signé, et le client verrait son dossier repasser « en
cours de signature » après avoir été informé du contraire.

La nuance survit au pont : le Panel réduit refus / expiration / annulation à
`SIGNATURE_FAILED` parce que la **conséquence** est la même (contrat récupérable
par relance), mais le libellé d'origine voyage dans `providerEvent` et est
retraduit côté projet — c'est lui qui distingue `EXPIRED` de `DECLINED` dans le
dossier.

---

## 5. Le cutover côté projet

### Supprimé

- `yousign.provider.js`, `yousign.stub.js`, `yousign.errors.js` ;
- la route `POST /api/webhooks/yousign` et son contrôleur ;
- `verifyYousignWebhookAnyMode` et toute vérification HMAC locale ;
- `processYousignEvent` / `handleYousignWebhook` (traitement local devenu mort) ;
- l'adaptateur et le manager de provisionnement de webhook Yousign ;
- l'entrée `YOUSIGN/signature` du registre des webhooks gérés, et la liste
  d'événements souscrits ;
- les champs de credential du catalogue (`fields: []`, `authority: 'PANEL'`) et
  la base URL locale.

Le traitement local a été **retiré** plutôt que laissé en sommeil. Une seconde
implémentation du même parcours, plus branchée sur rien, aurait divergé en
silence de celle qui fait foi — et c'est elle qu'on aurait relue le jour d'un
incident.

### Ajouté

- `yousign.service.js` réécrit en **façade** du plan de contrôle ;
- `signatureEvent.applier.js` — applique le fait, ne redemande jamais rien ;
- `yousignControlPlaneDiagnostic.js` — « la signature est-elle disponible ? »,
  répondu **par la plateforme**.

Ce dernier point mérite une note. Yousign est passé sous autorité Panel dans le
catalogue, mais aucun diagnostic ne lui correspondait : le refus par défaut
s'appliquait, et **chaque lancement de signature échouait en
`CAPABILITY_MISSING`** alors que la plateforme servait parfaitement la capacité.
La sonde est une **lecture** sur une demande qui ne peut appartenir à personne :
si le Panel sait répondre « pas à vous », toute la chaîne — authentification,
monde, octroi, credential, registre — a déjà été franchie. **Le refus est la
preuve.**

### Aucun repli

Sans Panel appairé, la signature échoue franchement. Un repli supposerait une
clé locale, c'est-à-dire exactement ce que le cutover supprime.

---

## 6. Compteurs

Mesurés sur `SB Auto 06/backend/src`, hors fichiers de test (qui portent
volontairement les chaînes recherchées, en tant que garde-fous).

| Compteur | Valeur |
|---|---|
| `YOUSIGN_LOCAL_BUSINESS_CALLS` | **0** |
| `PROVIDER_METHODS` | **0** |
| `FALLBACKS` | **0** |
| `API_ENDPOINT_REFERENCES` | **0** |
| `CALL_SECRET_READS` | **0** |
| `CALL_SECRET_WRITES` | **0** |
| `CREDENTIAL_UI_INPUTS` | **0** |
| `WEBHOOK_ENDPOINTS` | **0** |
| `WEBHOOK_PROVISIONING` | **0** |
| `WEBHOOK_SECRET_READS` | **0** |
| `PROJECT_LOCAL_FROM_*` | **0** |
| `PROJECT_LOCAL_BREVO_*` | **0** |

---

## 7. Vérification

### Suites complètes

| Dépôt | Commande | Résultat |
|---|---|---|
| Panel | `node tests/run-all.js` | **117/117 fichiers OK** |
| SB Auto 06 | `npm test` (backend + manager + vitrine) | **vert** |

### Bout en bout dédié

`backend/src/scripts/yousign-flow.test.js` — **76 vérifications**, chemin réel
de bout en bout (routes HTTP, service, client de capacités, runtime du pont,
applicateur, stockage privé). Seul le **Panel distant** est doublé.

Couverture : absence de credential configurable · endpoint webhook local disparu
· ouverture par capacité · idempotence d'ouverture · attribution par signataire ·
transitions métier · rejeu · désordre après achèvement · rattrapage hors ligne
(chemin du tirage) · appartenance (quatre verbes) · corrélation croisée ·
contrat inconnu · verbe hors vocabulaire · timeline · documents séparés +
empreinte · refus → `FAILED` → relance · expiration distinguée · inscription aux
deux registres · contrôle d'accès 401/403/404.

`backend/src/scripts/yousign.test.js` — **56 vérifications** : géométrie des
zones, traduction des statuts, et le cutover **prouvé par l'absence** (exports
disparus, fichiers supprimés, aucun `fetch`, aucun credential, aucun repli).

`Panel/tests/signature-event-dispatch.test.js` — **35 vérifications** sur la
**forme** du fait projeté : identité d'entité soumise au schéma réel du pont
(pas à une expression régulière recopiée), déterminisme, extraction du
signataire sous ses trois formes, absence explicite plutôt que chaîne vide, et
garde sur ce qui **ne doit pas** traverser.

`Panel/tests/signature-reservations.test.js` — **34 vérifications** sur le
verrou et sa sortie tracée.

### Le décor de signature, mutualisé

Quatre suites (paiements, abonnement, facturation, cycle de vie) avaient besoin
d'un contrat **signé** comme simple décor, et y arrivaient en postant trois
webhooks locaux. Elles passent maintenant par
`scripts/helpers/signatureFixture.helper.js`.

Un helper plutôt que quatre copies, pour une raison précise : le chemin comporte
désormais deux préalables non évidents — un Panel appairé, et l'enveloppe
`({ change })` — et quatre recopies auraient produit quatre variantes, dont
certaines auraient « marché » pour de mauvaises raisons.

Le helper ne pose pas `status: 'DONE'` en base : il fait **passer** le contrat
par le vrai chemin. Un décor écrit à la main masquerait le jour où ce chemin
cesse de fonctionner.

### Builds

| Cible | Résultat |
|---|---|
| Panel `frontend` (`tsc -b && vite build`) | OK |
| SB Auto `vitrine` + `manager` | OK |

---

## 8. Ce que ce lot ne fait pas

- **Le transit du document reste en base64** sur la passerelle JSON, borné à
  12 Mio. Un transfert par flux serait plus économe ; il change la forme du
  contrat de pont et n'entrait pas dans ce lot.
- **La réservation indéterminée reste manuelle.** Une résolution automatique
  supposerait d'interroger Yousign pour savoir si la demande existe — donc de
  faire dépendre la levée du verrou de la disponibilité du fournisseur, au
  moment précis où il vient de ne pas répondre.
- **Brevo conserve sa clé d'API locale** pour les envois du projet. C'est le
  dernier fournisseur dans ce cas, et il sert désormais de **témoin** au test de
  routage par monde : sans lui, la règle « le monde du runtime est la seule
  autorité, jamais `activeMode` » n'aurait plus aucun témoin et pourrait se
  briser sans que rien ne le dise.

---

## 9. Verdict

**R10.5 PASS**
**GO DEPLOYMENT TEST: YES**
