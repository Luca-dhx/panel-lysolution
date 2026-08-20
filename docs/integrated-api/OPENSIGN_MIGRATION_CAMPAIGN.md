# CAMPAGNE OPENSIGN — JOURNAL DE MIGRATION

> **Rapport courant.** Il est tenu au fil des lots ; le rapport final est produit à la fin.
> Le lot 0 (audit d'API + fondation IntegratedAPI) a son propre document :
> [`OPENSIGN_API_AUDIT_AND_FOUNDATION.md`](./OPENSIGN_API_AUDIT_AND_FOUNDATION.md).

---

## Décision produit actée

> **La signature électronique d'OpenSign Cloud, accompagnée de son certificat
> d'audit, suffit aux cas d'usage contractuels actuels de L.Y Solution. Les
> niveaux avancé et qualifié de Yousign ne sont pas une exigence de cette
> migration.**

C'est une décision de produit propre à ce système, prise et assumée par
l'exploitant. Ce n'est pas un avis juridique général, et elle ne dit rien des
besoins d'un autre système. Elle est consignée ici parce qu'elle FERME une
question que l'audit du lot 0 avait laissée ouverte, et parce qu'un lecteur qui
la retrouverait ouverte plus tard rouvrirait le débat pour rien.

Conséquence directe : **aucune raison de conserver Yousign ne subsiste au titre
du niveau de signature.** Les seules raisons qui restent sont techniques
(compatibilité des contrats historiques), et elles sont traitées aux lots 8 et 9.

---

## LOT 1 — CARACTÉRISATION DU BAC À SABLE RÉEL

Toutes les valeurs de cette section sont **mesurées**, sur le compte de bac à
sable réel, avec les identifiants du Panel. Aucune ne vient de la documentation.

Outillage : [`tools/opensign/`](../../tools/opensign/) — hors de `backend/src`,
pour ne pas avoir à affaiblir les gardes d'architecture du Panel (voir §1.9).
Artefacts bruts : `.campaign/` (ignoré par git — matière première datée, pas une
vérité versionnable).

### 1.1 Authentification — `REAL_SANDBOX_AUTH = PASS`

| Cas | Réponse observée | Classement du driver |
|---|---|---|
| jeton valide | `200` + `{objectId,name,email,phone,jobTitle,company,createdAt,updatedAt}` | `OK` |
| jeton invalide | **`405 {"error":"Invalid API Token!"}`** | `UNAUTHORIZED` |
| jeton absent | *(aucun appel)* | `MISSING_CREDENTIALS`, refusé avant le réseau |
| jeton de bac à sable → hôte de PRODUCTION | **`405 {"error":"Invalid API Token!"}`** | `UNAUTHORIZED` |

**Le 405 est confirmé** : c'est bien la réponse d'un jeton refusé, et non d'une
méthode interdite. Le classement posé au lot 0 sur la foi de la documentation
tient.

**Et la quatrième ligne justifie à elle seule la contrainte d'hôte du registre.**
Un jeton parfaitement valide, envoyé au mauvais monde, produit exactement la
même réponse qu'un jeton mort. Sans contrainte, un opérateur passerait sa
matinée à régénérer une clé qui n'a rien. Le refus est donc prononcé **avant le
réseau**, ce qui n'expose pas non plus le jeton à un hôte qui n'est pas le sien.

### 1.2 Compte et crédits

Compte reconnu : `L.Y Solution`. Crédits au démarrage de la campagne : **100 000**.

**Un crédit par document créé, et rien d'autre n'en coûte.** Mesuré : six
documents créés → six crédits consommés. `GET /document`, `GET /signinglinks`,
`POST /document/{id}` (révocation) et `DELETE /document/{id}` sont **gratuits**.

Conséquence retenue : une tentative d'ouverture qui échoue APRÈS la création
coûte un crédit, et la suppression ne le rend pas. C'est une raison de plus pour
que l'ouverture reste **un seul appel** (§1.5).

### 1.3 Plan de contrôle du webhook — `WEBHOOK_API = PASS`

| Appel | Observé |
|---|---|
| `GET /webhook` | `{ webhook: "<url>" }` — **un seul champ** |
| `POST /webhook` (même URL) | **`401 {"error":"Webhook url already exists!"}`** |
| `GET /webhook` (compte sans URL) | `404 {"error":"User not found!"}` |

**`WEBHOOK_SECRET = OUT_OF_BAND` est confirmé par l'observation** : la réponse ne
contient AUCUN champ qui puisse servir à vérifier quoi que ce soit. La clé de
sécurité vient de la console, et de nulle part ailleurs.

**La pose n'est pas idempotente** : reposer la même URL est un CONFLIT. Le
réconciliateur doit le lire comme « l'état voulu est atteint », faute de quoi
chaque passage laisserait le binding en erreur alors que tout va bien.

#### L'appartenance, sur une ressource sans description

OpenSign n'a pas de champ de description : le jeton d'appartenance que le Panel
écrit chez Stripe, Brevo et Yousign n'a nulle part où vivre. Sans règle propre,
**aucun** endpoint OpenSign ne serait jamais reconnu comme nôtre — et le plafond
d'un endpoint par compte refuserait ensuite toute création. Le plan de contrôle
ne convergerait jamais.

La règle retenue est étroite et ne s'applique qu'aux fournisseurs incapables de
porter un jeton : **un endpoint qui affiche exactement la callback de CE Panel
est le nôtre**. L'adresse comparée n'est pas quelconque — c'est notre hôte,
notre segment de fournisseur, notre destinataire. Un autre Panel a une autre
adresse ; s'il avait la même, il serait nous.

Vérifié en conditions réelles : preuve d'appartenance persistée effacée →
réconciliation → **adoption sans recréation ni suppression**, `drift: []`,
statut `READY`.

> ⚠️ **Contrainte d'exploitation à acter.** Un compte OpenSign = une URL de
> webhook. Deux Panels **ne peuvent pas** partager un compte : le second
> écraserait le webhook du premier, en silence. La séparation TEST/PROD par
> jeton et par hôte n'est donc pas seulement imposée par le fournisseur — elle
> est ce qui rend la cohabitation possible.

### 1.4 Signataire externe — `EXTERNAL_SIGNER = PASS`

Deux signataires sur `example.com` (domaine réservé par la RFC 2606, où aucune
boîte ne peut exister), envoi d'e-mails ACTIVÉ : **document créé, deux liens de
signature rendus.**

**La limitation qui rendait le bac à sable Yousign inutilisable n'existe pas
ici.** Yousign n'y acceptait comme destinataire qu'une adresse de l'organisation
du compte, refusait un payload parfaitement valide, et ne nommait aucun champ —
au point qu'un motif dédié (`SIGNER_EMAIL_NOT_IN_ORGANISATION`) avait dû être
ajouté au Panel pour rendre le refus lisible. Le parcours DEV → CLIENT est donc
**testable de bout en bout en recette**, ce qu'il n'était pas.

### 1.5 Création d'un document — `CREATEDOCUMENT = PROVEN`

`POST /createdocument` rend `{ objectId, signurl: [{ email, url }], message }`.

**Un seul appel** crée le document, les signataires, les zones ET rend les liens
de signature. Le parcours Yousign en demandait onze (création, document,
*n* signataires, *n* champs, activation). Ce n'est pas qu'une économie d'appels :
chacune des étapes disparues était un point où une préparation pouvait s'arrêter
à mi-chemin, donc un état à rattraper et un brouillon à nettoyer.

Forme des liens : `https://sandbox.opensignlabs.com/login/<base64url>`, où le
segment encode `docId/email/contactBookId/sendmail`.

### 1.6 Coordonnées des widgets — `WIDGET_COORDINATES = PROVEN`

**C'était la porte dure du lot, et elle est franchie par quatre chemins
concordants.**

1. **Le code du fournisseur.** `getWidgetPosition` applique
   `pageRatio = pageWidth / vpWidth`, avec `vpWidth ← pageWidth` quand le champ
   est absent, puis `y_pdf = hauteurPage − (y × pageRatio + hauteur)`.
2. **L'enregistrement brut.** Le placeholder créé par l'API ne porte **pas** de
   `vpWidth`, et `scale: 1`, `isMobile: false` :
   `{"role":"DEVELOPER","pageNumber":1,"type":"signature","Width":120,"Height":40,"xPosition":40,"yPosition":40}`.
   Donc `pageRatio = 1`.
3. **Le rendu, dans le client du fournisseur.** Trois widgets d'une mire, envoyés
   à `(45,90)`, `(380,400)` et `(45,700)` sur une page de 595 × 842 pt, sont
   rendus à `translate(57.479, 114.958)`, `(485.378, 510.924)` et
   `(57.479, 894.118)`, tailles `191.597 × 57.479`. Facteur observé sur **x, y,
   largeur et hauteur** : `1.27731`. Largeur de rendu : 760 px pour 595 pt →
   `760/595 = 1.27731`. Coïncidence exacte, sur quatre grandeurs et trois cibles.
4. **Le PDF réellement signé.** Après une signature menée dans un vrai
   navigateur, le flux de contenu porte `1 0 0 1 45 707 cm` puis
   `150 0 0 45 0 0 cm`. Attendu pour `y_haut = 90`, `h = 45`, page de 842 :
   `842 − 90 − 45 = 707`. **Écart nul sur les trois cibles**, en x comme en y.

> **Verdict : POINTS PDF, origine coin SUPÉRIEUR GAUCHE, pages 1-indexées,
> largeur et hauteur en points.**
>
> C'est-à-dire **exactement le modèle que l'éditeur de SB Auto stocke déjà**
> (`xRatio`/`yRatio` depuis le haut, `page` 1-indexée). La conversion se réduit à
> `coordonnée = ratio × dimension de la page en points`, sans constante d'échelle
> et sans inversion d'axe.

Note de méthode : « le fournisseur a accepté la charge utile » ne prouve rien —
`GET /document` renvoie nos propres x/y inchangés, c'est un ÉCHO. Et le serveur
d'OpenSign ne calcule aucune position : sa fonction `signPdf` reçoit un
`pdfFile` **déjà aplati par le navigateur**. Seul le client du fournisseur
décide du placement ; c'est pourquoi la preuve exige un navigateur, et pourquoi
Playwright est entré en dépendance de développement.

### 1.7 Ordre de signature et redirection

**Ordre strict : tenu par le serveur.** Avec `sendInOrder` **et**
`send_in_order_strict`, le second signataire **voit** le document avant son tour
— ce qui est souhaitable — mais son acte est **refusé**. Piste d'audit mesurée :
développeur signé à `15:14:52`, client à `15:15:23`, jamais l'inverse, et aucune
signature du client lors d'une tentative anticipée.

> Mesurer l'AFFICHAGE aurait conclu « ordre non respecté » sur un comportement
> parfaitement correct, et envoyé chercher un réglage qui n'existe pas. La preuve
> est dans la piste d'audit, pas à l'écran.

**Redirection : respectée à la lettre, sans aucun paramètre ajouté.**

| Fait mesuré | Conséquence |
|---|---|
| `redirect_url` est suivi exactement | on peut y mettre ce qu'on veut |
| **aucun** paramètre n'est ajouté (`[]`) | la page de retour ne peut PAS identifier le contrat depuis l'URL |
| **un seul** `redirect_url`, pour tout le document | DEV et CLIENT atterrissent au même endroit |

Yousign acceptait trois URL **par signataire** (succès, erreur, refus). OpenSign
en accepte **une**, documentaire. Le parcours de retour de SB Auto devra donc
porter lui-même l'identité du contrat dans l'URL qu'il fournit, et déduire
l'issue de l'ÉTAT du contrat — jamais d'un paramètre que le signataire contrôle.

> Piège de méthode rencontré : le premier essai visait une route de
> l'application React. OpenSign y a bien redirigé, mais l'application, ne
> connaissant pas la route, a réécrit l'URL vers son écran de connexion — on
> mesurait le SPA, pas le fournisseur. Une route d'API inexistante ne réécrit
> rien.

### 1.8 Cycle de vie, limites et nettoyage

| Sujet | Mesure |
|---|---|
| statut d'un document en cours | `in-progress` |
| après révocation (`POST /document/{id}`) | **`declined`** |
| après signature de tous | `completed` |
| certificat | **disponible** sur un document `completed` |
| piste d'audit | `[{email, viewed, signed}]`, horodatée ISO 8601 |
| taille — 4 Mo | accepté |
| taille — 9,4 Mo | accepté |
| taille — 12 Mo | **`400 "File too large. Max allowed file size is 10 MB"`** |
| suppression | `DELETE /document/{id}` — a fonctionné sur **tous** les documents de recette |

**La limite porte sur le fichier DÉCODÉ, à 10 Mo, et le message est explicite.**
Les bornes actuelles du parc valent **12 Mio des deux côtés** (Panel et SB
Auto) : elles sont donc **trop hautes**, et laisseraient passer un document que
le fournisseur refuse. Correction portée au lot 2.

**Nettoyage** : tous les documents créés pendant le lot 1 ont été supprimés à la
fin de chaque exécution, y compris après échec — la phase de nettoyage tourne
dans un `finally`.

### 1.9 Ce que le lot 1 a corrigé dans le Panel lui-même

**L'outillage de campagne a quitté `backend/src`.** Trois gardes d'architecture
le refusaient, et elles avaient raison : un script de mesure viole
nécessairement les invariants du runtime — il écrit un hôte de production (c'est
l'objet de la mesure), il sort sur le réseau hors des clients déclarés, et il
lit l'environnement. Assouplir les gardes aurait ouvert ces trois portes pour de
bon, au profit d'un outillage temporaire. Le déménagement vers `tools/opensign/`
leur rend leur portée d'origine.

**Un diagnostic de représentation HMAC a été ajouté.** La page d'aide d'OpenSign
dit « utilisez le corps brut » et l'exemple publié juste en dessous signe une
**re-sérialisation**. Un désaccord se présenterait comme un simple `MISMATCH` —
le même mot que pour une mauvaise clé ou un appel falsifié, trois causes
appelant trois gestes opposés. Le diagnostic **nomme**, dans le journal
seulement, la représentation qui aurait correspondu. Le vérificateur, lui, ne
bouge pas : une signature portant sur la re-sérialisation reste **refusée**, et
un test le verrouille.

### 1.10 Reste à prouver

`WEBHOOK_HMAC` et les charges utiles réelles des cinq événements exigent une
livraison entrante, donc un Panel déployé qui connaisse le segment `opensign`.
C'est l'objet du déploiement TEST qui suit.

---

## LOT 2 — L'ADAPTATEUR ET LES CAPACITÉS GÉNÉRIQUES

### 2.1 Ce qui n'a pas changé, et c'est le point

Les cinq codes `signature.request.open`, `.retrieve`, `.cancel`,
`signature.signer.retrieve` et `signature.document.download` sont **identiques**.
Aucun `opensign.*` n'existe, et aucun projet n'apprend qui exécute.

### 2.2 Ce qui a changé : quatre appels au lieu de onze

| Acte | Yousign | OpenSign |
|---|---|---|
| ouvrir | 5 appels + nettoyage de brouillon | **1** (`createdocument`) |
| lire | `GET /signature_requests/{id}` | `GET /document/{id}` |
| lien d'un signataire | `GET …/signers/{id}` | `GET /signinglinks/{id}` |
| télécharger | `GET …/download` (octets) | `GET /document` → URL pré-signée → `GET` |
| annuler | `POST …/cancel` (énumération) | `POST /document/{id}` (texte libre) |

Le nettoyage tout-ou-rien du brouillon **n'a pas été recopié** : il n'a plus
d'objet. Soit l'appel unique aboutit et le document est complet, soit il échoue
et rien n'a été créé. Ajouter un `DELETE` « par symétrie » viserait une
ressource dont on vient d'établir qu'elle n'existe pas.

### 2.3 L'aiguillage entre deux fournisseurs

Deux populations de demandes coexistent, et durablement : un contrat signé doit
rester relisible aussi longtemps qu'il a une valeur juridique.

```
signature.request.open        → toujours le fournisseur ACTIF (OPENSIGN)
signature.request.retrieve    ┐
signature.signer.retrieve     ├→ CELUI QUI DÉTIENT LA DEMANDE, lu sur son lien
signature.document.download   │
signature.request.cancel      ┘
```

> **« Essayer OpenSign, puis Yousign » est interdit**, et ce n'est pas une
> question de style. Sur un identifiant inconnu du premier, on interrogerait le
> second avec les identifiants d'un compte qui ne le connaît pas davantage :
> deux refus, aucune information, latence doublée. Le premier appel PART — sur
> une annulation, « essayer » signifie tenter d'annuler chez un fournisseur qui
> n'a rien à annuler. Et le repli masquerait toute panne du premier.

Le crochet vit dans la **passerelle**, avant l'ouverture du coffre : c'est le
fournisseur qui décide quels identifiants ouvrir. Le résoudre dans l'adaptateur
aurait obligé celui-ci à rouvrir le coffre lui-même — une seconde porte, que le
résolveur d'identifiants existe précisément pour empêcher.

### 2.4 Le vocabulaire cesse d'être celui d'un fournisseur

Le Panel rendait `ongoing`, `done`, `canceled` — les mots de Yousign — et c'est
le PROJET qui traduisait. Avec un second fournisseur, ce projet lit « inconnu »
sur chaque état d'OpenSign : **sans erreur, sans journal**, le contrat resterait
« en cours » pour toujours.

Les sorties portent désormais `state` (neutre : `DRAFT`, `ONGOING`, `DONE`,
`DECLINED`, `EXPIRED`, `CANCELED`, `UNKNOWN`), `provider`, et conservent
`status` brut pour le forensic. `UNKNOWN` est un état de première classe : un
état non listé n'est jamais rabattu sur « le mot le plus proche ».

### 2.5 L'identité d'un signataire

OpenSign n'a **pas d'identifiant de signataire** : il désigne les gens par leur
adresse. Le contrat de capacité, lui, promet un `signerId` que le projet
conserve et compare.

La poignée est **dérivée** — `sha256("opensign:" + documentId + ":" + email)`,
tronquée à 32 hexadécimaux — et jamais persistée : elle se **recalcule** à
partir des signataires du document. Aucune table à maintenir, à migrer, ni à
faire diverger.

- Une adresse ne traverse jamais le pont.
- Le document entre dans le calcul : une poignée apprise sur un contrat ne
  désigne personne sur un autre.
- Casse et espaces sont normalisés — sans quoi la poignée de l'ouverture ne
  correspondrait pas à celle de la lecture.

### 2.6 Un défaut de la passerelle, antérieur à la migration

Sur un acte **déjà réussi**, le rejeu rendait une forme générique
`{status: 'ALREADY_SENT', providerMessageId, operationId}` — **sans passer par
le schéma de sortie**. C'est le contrat des envois d'e-mail, et de lui seul.

Pour une ouverture de signature, cette forme est un mensonge : l'appelant reçoit
un objet auquel il manque `signatureRequestId`, `documentId` et les liens des
signataires. SB Auto y lirait `signatureRequestId: undefined` et **perdrait la
demande qu'il vient d'ouvrir** — sans erreur, avec un contrat bloqué et une
demande orpheline chez le fournisseur.

Le défaut ne s'était jamais vu parce que le projet se garde lui-même avant
d'appeler. **Une garantie de la passerelle qui repose sur la prudence de son
appelant n'en est pas une.**

Le registre déclare désormais, capacité par capacité, si son rejeu se
reconstitue par réexécution. L'ouverture de signature le peut : elle interroge
d'abord le lien d'appartenance et rend la demande existante sans contacter le
fournisseur.

### 2.7 Recette réelle — toutes les capacités, sur le bac à sable

| # | Étape | Résultat |
|---|---|---|
| 1 | `signature.request.open` | `OPENED`, deux poignées de 32 caractères, deux liens |
| 2 | double invocation | **`ALREADY_OPEN`**, même demande, aucune seconde création |
| 3 | `signature.request.retrieve` | `state: ONGOING`, signataires `PENDING` |
| 4 | `signature.signer.retrieve` | lien rendu |
| 5 | signataire inconnu | refusé (`CAPABILITY_NOT_AVAILABLE`) |
| 6 | **isolation** : projet B → retrieve / download / cancel de A | **3× `CAPABILITY_RESOURCE_NOT_OWNED`** |
| 7 | demande inventée | refusée, sans contact fournisseur |
| 8 | `signature.document.download` | PDF réel, empreinte cohérente |
| 9 | `signature.request.cancel` | `state: CANCELED`, lien fermé |
| 10 | après annulation | contrat de nouveau ouvrable |

Documents supprimés, liens d'appartenance de recette retirés.

---

## LOT 3 — NORMALISATION DES WEBHOOKS

### 3.1 La table de traduction

| OpenSign | Fait métier | Pourquoi |
|---|---|---|
| `created` | *(non projeté)* | le projet vient de le demander |
| `viewed` | *(non projeté)* | consultation — chaque fait inutile est une donnée personnelle de plus |
| `signed` | `SIGNATURE_SIGNER_SIGNED` | |
| `completed` | `SIGNATURE_COMPLETED` | |
| `declined` | `SIGNATURE_FAILED` | |
| `revoked` | `SIGNATURE_FAILED` | non documenté, traité par précaution assumée |
| `expired` | `SIGNATURE_FAILED` | idem |

Un événement absent de la table est **acquitté sans agir**. Refuser ferait
rejouer le fournisseur en boucle pour un événement dont on ne veut rien faire.

La table est **par fournisseur** : `completed` ne veut rien dire chez Yousign,
`signature_request.done` ne veut rien dire chez OpenSign. Traduire sans savoir
qui parle reviendrait à leur prêter un vocabulaire commun qu'ils n'ont pas.

### 3.2 L'idempotence, sans identifiant d'événement

OpenSign n'en fournit aucun. La clé composite est
`opensign:{ENV}:{event}:{objectId}:{sha256(acteur)}:{horodatage brut}`.

L'**acteur** y entre parce que, sans lui, deux signataires qui signent dans la
même seconde produisent la même clé : le second serait perdu **en silence**, et
le contrat resterait à moitié signé. Il y entre **haché** : la clé ne doit pas
devenir un annuaire.

### 3.3 Trois refus qui n'existaient pas

- **Signature portant sur un corps modifié** → refusée. Le cas qui compte : un
  intermédiaire qui réécrit l'événement ferait changer d'état un contrat sur la
  foi d'un tiers.
- **Événement d'un fournisseur sur la demande d'un autre** → refusé
  (`PROVIDER_MISMATCH`). Sans ce contrôle, la conséquence ne serait pas une
  erreur : ce serait un contrat marqué signé par un événement qui ne le
  concerne pas, avec une date de signature fausse sur un objet juridique.
- **Demande inconnue** → acquittée, jamais acheminée, mais **consignée**.

### 3.4 Un fait retardé reste acheminé — et c'est voulu

Un `signed` qui arrive après le `completed` n'est **pas jeté**. Le Panel n'est
pas juge de la pertinence d'un événement authentique : il l'a vérifié, daté et
attribué ; le taire priverait le projet d'une information qu'il est seul à
savoir interpréter.

La convergence est garantie ailleurs, et **à deux endroits** — ce qui est plus
robuste qu'un filtre unique : l'état du contrat porte la mémoire (un rang
inférieur n'écrase rien), et si le contrat a été relancé, sa demande courante
n'est plus celle-là.

---

## LOT 4 — LE CONTRAT SB AUTO BASCULE

### 4.1 La persistance cesse de nommer son fournisseur

`contract.yousign` devient `contract.signature`. Le bloc historique est
**conservé et toujours lu** (`signatureRecord.js` : `signatureOf`,
`signatureTarget`, `setSignatureField`) — un contrat signé en 2025 se relit
sans être réécrit, et la migration (`migrate-signature-block.js`) reste
facultative pour fonctionner.

Le bloc neutre porte un champ que l'ancien n'avait pas : **`provider`**. Il
n'est pas déductible après coup. Les deux fournisseurs coexisteront en base
pendant des années, et c'est ce champ qui dira où chercher une demande de 2025.

### 4.2 Deux défauts réels, trouvés par la bascule

Ni l'un ni l'autre n'était un effet du changement de fournisseur — les deux
étaient déjà là, masqués par des tests qui lisaient la base au lieu du parcours.

| Où | Ce qui était écrit | Ce que ça produisait |
|---|---|---|
| `contractStateMachine.deriveSignatureState` | `y.signatureRequestId`, `y.adminSignedAt` sur le résultat de `signatureOf` (qui rend `requestId`, `clientSignedAt`) | l'état retombait à `NONE` pour **toute** demande — l'écran n'a jamais affiché « signature en cours » |
| `signatureEvent.applier` | `downloadSignedDocument(y.signatureRequestId)` | `undefined` — le **PDF signé n'était jamais récupéré** à l'achèvement |

Les deux sont couverts par `signature-flow.test.js`, qui lit désormais la
**vue HTTP** là où il lisait la base : c'est ce changement qui les a révélés.

### 4.3 Une seule adresse de retour

Le fournisseur n'en accepte qu'une, pour tout le document, **sans paramètre
ajouté** (mesuré, lot 1). Les trois adresses par signataire disparaissent.

`SignatureReturnPage` lit la **session** pour renvoyer chacun chez soi. Le
parcours n'y perd rien : il n'a jamais cru un `?status=success` — un paramètre
d'URL est contrôlé par celui qui revient, l'état du contrat non.

### 4.4 La limite locale passe de 12 à 10 Mio

Le document voyage en base64 dans un corps JSON. Garder 12 Mio aurait laissé
passer un document de 11 Mo : accepté localement, transporté, **crédit débité**,
puis refusé par un message parlant du fournisseur pour un problème qui est
celui du PDF.

### 4.5 Le catalogue nomme un DOMAINE

L'entrée `YOUSIGN` devient `SIGNATURE`. Ce n'est pas cosmétique : sans elle,
`isPanelAuthority('SIGNATURE')` répondait faux et **toute ouverture échouait en
`CAPABILITY_MISSING`** alors que la plateforme servait parfaitement la capacité.

Disparaissent avec elle : `testYousign` (un testeur sans appelant, qui invitait
à coller une clé que ce projet ne doit plus détenir) et `yousign-sandbox.js`
(il importait un module supprimé au cutover — il ne démarrait plus).

### 4.6 Recette réelle — `tools/opensign/projectContractRecipe.js`

Elle importe `buildSignatureOpenPayload` **depuis SB Auto** et pousse le
résultat dans la vraie passerelle, jusqu'au vrai bac à sable. C'est le seul
contrôle qui éprouve les **deux dépôts ensemble**, là où ils se touchent.

| Étape | Mesure |
|---|---|
| 0 · zones valides pour le projet | 2 zones, 0 erreur |
| 1 · charge utile construite | 8 clés, aucun retour par signataire |
| 2 · schéma d'entrée du Panel | acceptée, fournisseur `OPENSIGN` |
| 3 · conversion des zones | **écart maximal 0 point** — origine coin haut-gauche |
| 4 · ouverture réelle | `OPENED`, poignées de 32 caractères, liens rendus |
| 5 · relecture | `ONGOING` → statut contractuel `ONGOING` |
| 6 · téléchargement | PDF authentique, `certificateAvailable: false` |
| 7 · deux clics « Signer » | `ALREADY_OPEN`, 1 demande vivante, 1 crédit |
| 8 · annuler puis relancer | 0 vivante après annulation, relance `OPENED` |

L'étape 8 envoie **exactement** ce que le projet envoie — la même clé
`sig-open-<contrat>`, stable exprès. Lui en donner une autre aurait éprouvé un
parcours que personne ne suit, et laissé passer le cas où la réservation
d'opération rendrait une demande révoquée : le contrat serait bloqué pour
toujours, sans erreur, avec un lien mort. `replayByReexecution` évite cela.

**Nettoyage** : 2 documents supprimés chez le fournisseur, 2 liens
d'appartenance de recette retirés. Aucun résidu.

### 4.7 Chaînes de qualité

- SB Auto backend (`npm test`, ~100 suites) : **vert**.
- Manager : `tsc -b --noEmit` **vert**, toutes les suites vertes **sauf**
  `subscriptionPricing.test.mjs` (7 contrôles) — **rouge avant ce lot**, sur la
  carte de coût d'abonnement, sans aucun rapport avec la signature. Vérifié en
  rejouant les assertions contre le contenu de `HEAD`.

---

## LOT 5 — DE L'ÉDITEUR DE ZONES À L'ENCRE SUR LE PAPIER

### 5.1 Ce qui restait à prouver

Trois preuves existaient déjà, chacune sur son maillon :

| Preuve | Ce qu'elle établit | Où elle s'arrête |
|---|---|---|
| lot 1 — `signInBrowser.js` | le fournisseur pose l'encre exactement où l'API la demande | coordonnées envoyées à la main |
| lot 1 — `measureCoordinates.js` | l'unité est le point PDF, origine coin supérieur gauche | widgets `prefill`, pas de signature |
| lot 4 — `projectContractRecipe.js` | la conversion ratio → point de SB Auto tombe juste (0 pt) | s'arrête à l'ouverture |

Entre « l'éditeur enregistre 0,11834 » et « l'encre est sur la ligne », il y a
une conversion, un schéma, une passerelle, un adaptateur, un fournisseur et un
navigateur. Chacun est juste. Rien ne vérifiait leur **composition**.

### 5.2 Le protocole — `tools/opensign/editorWidgetRecipe.js`

Il part de **ratios d'éditeur**, passe par la capacité générique, fait signer
dans un vrai navigateur, et mesure le PDF signé en recalculant l'attendu
**depuis les ratios** — jamais depuis les points intermédiaires. Partir des
points ferait propager une erreur de conversion des deux côtés de la
comparaison : la mesure se donnerait raison toute seule.

Deux pages, et des ratios non ronds. Une seule page ne distingue pas une
indexation à 1 d'une indexation à 0 — le décalage se lirait « toutes les
signatures sont sur la première page », et ne se verrait que sur un vrai
contrat. Des ratios ronds donnent des points ronds, et masqueraient un arrondi.

### 5.3 Mesures

| Étape | Mesure |
|---|---|
| 0 · zones d'éditeur valides | 2 zones, pages 1 et 2, 0 erreur |
| 1 · ouverture par la capacité | `OPENED` — DEV page 1 (70, 600), CLIENT page 2 (330, 155) |
| 2 · lien du signataire | `https://sandbox.opensignlabs.com/login/<jeton>` |
| 3 · rendu dans le DOM du fournisseur | ratio posé **0,11834** → ratio observé **0,11765** (écart 0,00069) ; largeur de rendu 760 px pour 595 pt, facteur **1,27731** |
| 5 · encre dans le PDF signé | attendu (70,41 ; 187) — mesuré (70 ; 187) — **écart maximal 0,41 pt** |
| 6 · indice de page | DEV=1, CLIENT=2 — conservé ; états `SIGNED` / `PENDING` |

L'écart de 0,41 pt est l'arrondi à l'entier que fait la conversion : 0,11834 ×
595 = 70,41 pt, envoyé à 70. Soit **0,14 mm** — sous le trait d'une ligne de
signature. Le contrôle échoue au-delà de 2 pt.

L'état rendu après la signature du développeur (`SIGNED` / `PENDING`) confirme
au passage l'**ordre séquentiel** : le client n'a pas été sollicité.

### 5.4 Un défaut de l'outillage, corrigé en chemin

La première version de cette recette importait `imagesPositionnees` depuis
`signInBrowser.js`. Or celui-ci est un **script** : il ouvre une base, crée un
document, signe dans un navigateur et supprime. L'importer l'**exécutait** —
une signature réelle de plus et un crédit consommé avant que la recette du lot
5 ne commence, sans que rien ne le signale.

La fonction vit désormais dans `tools/opensign/pdfImages.js`, module pur. Les
deux scripts l'importent.

**Nettoyage** : 1 document supprimé chez le fournisseur, 1 lien d'appartenance
retiré. Captures conservées dans `.campaign/lot5-*.png`.

---

*(Sections suivantes ajoutées au fil des lots.)*
