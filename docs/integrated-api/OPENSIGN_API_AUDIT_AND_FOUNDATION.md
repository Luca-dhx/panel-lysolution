# OPENSIGN API AUDIT + INTEGRATEDAPI FOUNDATION

**Lot 0 de la migration Yousign → OpenSign.**
Date : 2026-08-20. Périmètre : Panel uniquement. Aucune ligne de SB Auto n'est touchée.
**Rien n'a été retiré à Yousign.** Il reste l'autorité de `signature.*`, et un test le vérifie.

---

## 0. Comment cet audit a été fait, et pourquoi c'est important

La documentation publique d'OpenSign v1.2 est un site Docusaurus dont les schémas de
requête sont rendus **côté navigateur**. Une lecture de la page servie ne rend donc que
les titres et les codes de réponse — c'est-à-dire à peu près rien de ce dont un driver a
besoin, et exactement de quoi écrire un adaptateur faux avec l'impression d'avoir lu la
doc.

L'audit a donc porté sur **la spécification OpenAPI elle-même**, extraite des bundles du
site (objet `api` compressé par page), soit **36 opérations complètes** avec paramètres,
schémas de corps, exemples et codes d'erreur. S'y ajoutent les pages d'aide
(`/docs/help/Settings/Webhook`, `/docs/help/Settings/APIToken`, `/docs/help/FAQs/*`), qui
portent tout ce que la référence API ne dit pas : la clé HMAC, les plafonds de fichier, la
politique de crédits, et les limitations du bac à sable.

> Ce qui suit distingue systématiquement **ce que la doc affirme** de ce qui reste une
> **HYPOTHÈSE** à confirmer en bac à sable réel (lot 1). Les hypothèses sont numérotées.

---

## 1. Le fournisseur, en un écran

| | |
|---|---|
| **Auth** | en-tête `x-api-token` (pas de `Bearer`, pas d'OAuth) |
| **Sandbox** | `https://sandbox.opensignlabs.com/api/v1.2` |
| **Production** | `https://app.opensignlabs.com/api/v1.2` |
| **Région UE** | `https://eu-app.opensignlabs.com/api/v1.2` — **un autre tenant, pas un alias** |
| **Jetons** | Live et Sandbox **distincts et non interchangeables** (documenté explicitement) |
| **Jeton Live** | exige un plan payant (Professional ou Teams) |
| **Jeton Sandbox** | disponible sur tous les plans, gratuit compris |
| **Auto-hébergé gratuit** | **aucune API** — la génération de jeton exige un plan self-host payant |
| **Compatibilité** | v1.2 est rétro-compatible v1 / v1.1 sur la même base |

### Le piège qui coûtera le plus cher si on l'oublie

> **`405` signifie « Invalid API token! » chez OpenSign.** Sur les 36 endpoints, sans
> exception. Un classificateur HTTP générique range 405 dans « méthode non autorisée » et
> envoie relire l'URL, alors que la seule chose à corriger est la clé.
> Le transport et le validateur le savent tous les deux, et deux tests le figent.

Second piège, plus discret : **`401` n'est pas toujours un refus de jeton.**
`POST /webhook` répond `401 { "error": "Webhook url already exists!" }` — c'est un
**conflit**, et le jeton vient précisément de servir.

---

## 2. Matrice des endpoints OpenSign v1.2

Colonnes : `PURPOSE` · `REQUEST` · `RESPONSE` · `AUTH` · `SANDBOX/PROD` · `USED BY L.Y ?` ·
`TARGET CAPABILITY`.
**AUTH** est `x-api-token` partout : la colonne ne répète que les particularités.
**SANDBOX/PROD** : `2` = disponible dans les deux mondes avec des jetons distincts.

### 2.1 User (2)

| Endpoint | Purpose | Request | Response | Sbx/Prod | Utilisé ? | Capacité cible |
|---|---|---|---|---|---|---|
| `GET /getuser` | compte du porteur du jeton | — | `objectId, name, email, phone, jobTitle, company, createdAt, updatedAt` | 2 | **OUI** | *(aucune)* — sonde du **test de connexion** IntegratedAPI |
| `GET /getcredits` | crédits API | — | `plan_credits, addon_credits, total_credits, renewal_date` ; `400` si pas d'abonnement | 2 | **OUI** | *(aucune)* — **diagnostic d'exploitation** |

### 2.2 Documents (13)

| Endpoint | Purpose | Request | Response | Sbx/Prod | Utilisé ? | Capacité cible |
|---|---|---|---|---|---|---|
| `POST /createdocument` | **créer + envoyer** en un appel | `file` (base64)*, `title`*, `signers[]`* (avec `widgets[]`), `sendInOrder`, `send_in_order_strict`, `redirect_url`, `enableOTP`, `merge_certificate`, `timeToCompleteDays`, `cc/bcc`, `prefill`, `folderId`, `send_email`, `email_subject/body`, `sender_name/email`, `auto_reminder`, `file_password`… | `objectId`, `signurl[{email,url}]`, `message` | 2 | **OUI** | **`signature.request.open`** |
| `POST /draftdocument` | créer **sans envoyer** | idem + `hide_signer_signing_links` ; `signers` facultatif | `document_id`, `url` (UI d'édition) | 2 | non | — (débite déjà un crédit) |
| `POST /createdocument/{template_id}` | créer depuis un gabarit | `signers[]`*, `title`, valeurs par défaut des widgets | `objectId`, `signurl[]` | 2 | **écarté** | voir §2.3 — un gabarit ne traverse pas TEST/PROD |
| `POST /selfsign` | auto-signature, sans invitation | `file`*, `title`*, widgets facultatifs | URL de signature | 2 | non | — |
| `GET /document/{id}` | état d'un document | — | `status`, `file` (URL signée), `certificate`, `signers[]`, `audit_trail[{email,viewed,signed}]`, `sendInOrder`, `redirect_url`, `template_id`, `cc/bcc`… | 2 | **OUI** | **`signature.request.retrieve`** + **`signature.document.download`** |
| `PUT /document/{id}` | modifier (pas le fichier) | `name, note, description, folderId, enableOTP, redirect_url, auto_reminder, cc/bcc…` | `objectId, updatedAt` | 2 | possible | — (utile pour corriger un `redirect_url`) |
| `POST /document/{id}` | **révoquer** | `reason` | `objectId, revokedAt` | 2 | **OUI** | **`signature.request.cancel`** |
| `DELETE /document/{id}` | supprimer | — | `objectId, deletedAt` | 2 | **OUI (cleanup)** | *(aucune)* — nettoyage de recette |
| `GET /signinglinks/{id}` | liens de signature | — | `objectId, signurl[{email,url}]` | 2 | **OUI** | **`signature.signer.retrieve`** |
| `GET /documentlist/{doctype}` | lister par état (`draft`, `in-progress`, `completed`, `expired`, `declined`) | `limit`, `skip` | `result[]` | 2 | recette | *(aucune)* — inventaire de nettoyage |
| `POST /resendmail` | relancer un signataire | `document_id`*, `email`*, sujet/corps | `result` | 2 | plus tard | — |
| `GET /formdata/{id}` | valeurs saisies par les signataires | — | `form_data[]` | 2 | non | ⚠️ **Teams / Enterprise uniquement** |
| `GET /signerips/{id}` | IP des signataires | — | `signer_ips[{email,ip_address}]` | 2 | non | ⚠️ **Teams / Enterprise uniquement** |

### 2.3 Templates (7)

`POST /createtemplate` · `POST /drafttemplate` · `GET /template/{id}` · `PUT /template/{id}` ·
`DELETE /template/{id}` · `GET /templatelist` · `POST /publictemplate`.

**Aucune n'est nécessaire au parcours contrat**, et une contrainte les disqualifie même
comme raccourci : *« Les gabarits créés en Live ne peuvent pas être utilisés en Sandbox, et
inversement. »* Un gabarit devient donc un objet à provisionner **deux fois, à la main**,
hors de tout code — exactement le genre d'état que le plan de contrôle existe pour
supprimer. Le contrat de SB Auto porte un **PDF différent à chaque fois** (snapshot
contractuel figé) : `createdocument` avec `file` en base64 est le bon verbe.

### 2.4 Contacts (6)

`POST /createcontact` · `GET /contact/{id}` · `PUT /contact/{id}` ·
`PUT /contact-by-email/{email}` · `DELETE /contact/{id}` · `GET /contactlist`.

**Non nécessaires.** `createdocument` accepte des signataires inline (`email`, `name`,
`phone`, `company`, `job_title`) sans exiger de contact préexistant. Créer des contacts
ferait du compte OpenSign un **second annuaire de personnes réelles** à protéger et à
purger, en doublon de l'entreprise et du snapshot contractuel. *(À vérifier en lot 1 —
**HYPOTHÈSE 4** : `createdocument` crée peut-être des contacts implicitement ; si oui, le
nettoyage de recette devra les inclure.)*

### 2.5 Folders (5)

`POST /createfolder` · `GET /folder/{id}` · `PUT /folder/{id}` · `DELETE /folder/{id}` ·
`GET /folderlist`.

**Optionnels.** `createdocument.folderId` permettrait de ranger les contrats par projet
côté OpenSign — confort d'exploitation, aucune valeur fonctionnelle. À reconsidérer après
le lot 4. Note : `DELETE /folder` refuse un dossier non vide (`400`).

### 2.6 Webhook (3)

| Endpoint | Purpose | Request | Response |
|---|---|---|---|
| `GET /webhook` | l'URL du compte | — | `{ webhook: "…" }` ; `404` = aucune posée |
| `POST /webhook` | poser **ou** mettre à jour | `{ url }` | `{ result }` ; `401` = déjà posée |
| `DELETE /webhook` | retirer | — | `{ result }` |

**Une seule URL par compte. Pas d'identifiant d'endpoint. Pas de sélection d'événements.
Pas de secret rendu par l'API.** Voir §6 — c'est la partie la plus atypique du fournisseur.

---

## 3. L'existant Yousign, audité

### 3.1 Le chemin complet, tel qu'il est aujourd'hui

```
SB Auto  contract.service / contract.dev.controller
   │      yousign.service.js  ── buildSignatureOpenPayload()
   │      yousignCoordinates.js ── ratios → pixels
   ▼
capabilityClient.invokeCapability('signature.*')      ← pont projet → Panel
   ▼
Panel  capabilityGateway.service ── permissions, ownership, idempotence, coffre
   │      capabilities/providerAdapters.js  (table capacité → exécutant)
   │      integratedApi/yousign/yousignAdapters.js   (5 actes métier)
   │      integratedApi/yousign/yousignTransport.js  (11 verbes HTTP)
   ▼
Yousign  api-sandbox.yousign.app/v3  |  api.yousign.app/v3

retour :  Yousign ──► POST /api/webhooks/yousign (Panel)
             webhookIngest ── HMAC ── idempotence ── signatureEventDispatch
             ──► emitChange(SIGNATURE_EVENT, audience = projet propriétaire)
             ──► SB Auto  signatureEvent.applier.js  ── état du contrat
```

### 3.2 Les cinq capacités, et ce que chacune suppose

| Capacité | Appels Yousign | Contrat d'entrée | Contrat de sortie |
|---|---|---|---|
| `signature.request.open` | `POST /signature_requests` → `POST …/documents` (multipart) → *n* × `POST …/signers` → *n* × `POST …/fields` → `POST …/activate` | `contractRef`, `name`, `documentBase64`, `documentFilename`, `signers[{role,firstName,lastName,email,redirectUrls}]`, `fields[{signerRole,page,x,y,width,height}]`, `operationId` | `status`, `signatureRequestId`, `documentId`, `contractRef`, `signers[{role,signerId,signatureLink}]` |
| `signature.request.retrieve` | `GET /signature_requests/{id}` | `signatureRequestId` | `status`, `signers[{signerId,status}]` |
| `signature.signer.retrieve` | `GET …/signers/{signerId}` | `signatureRequestId`, `signerId` | `signerId`, `status`, `signatureLink` |
| `signature.document.download` | `GET …/documents/{docId}/download` (binaire) | `signatureRequestId` | `contentBase64`, `byteLength`, `sha256` |
| `signature.request.cancel` | `POST …/cancel` `{reason:'other'}` | `signatureRequestId`, `reason?` | `status: 'CANCELED'` |

### 3.3 Ce qui, dans cet existant, **ne doit pas bouger**

1. **Les noms de capacités.** SB Auto appelle `signature.request.open`. Un
   `opensign.request.open` ferait fuiter le fournisseur dans le contrat métier et rendrait
   la bascule impossible sans toucher au projet.
2. **L'ouverture est UN acte tout-ou-rien**, avec réservation préalable du contrat
   (`claimSignatureRequest`, index partiel « une demande vivante par contrat ») et
   nettoyage du brouillon en cas d'échec certain.
3. **`TIMEOUT` ≠ `PROVIDER_UNAVAILABLE`.** Une issue indéterminée ne libère pas la
   réservation : mieux vaut un contrat verrouillé qu'un signataire sollicité deux fois.
4. **L'appartenance avant le coffre.** Un refus ne doit rien déchiffrer.
5. **Le `documentId` vient du lien d'appartenance, jamais de l'appelant.**
6. **Le webhook arrive au Panel, pas au projet**, et le destinataire vient du binding —
   jamais d'un `projectId` lu dans la charge utile.

---

## 4. Matrice de migration

| Opération Yousign actuelle | Équivalent OpenSign | Verdict | Stratégie |
|---|---|---|---|
| `POST /signature_requests` (brouillon) | *(néant)* | **EXACT par disparition** | OpenSign n'a pas d'étape brouillon obligatoire : `POST /createdocument` fait tout. **La fenêtre d'incohérence disparaît**, et avec elle le nettoyage best-effort du brouillon. C'est un gain net. |
| `POST …/documents` (multipart binaire) | `createdocument.file` (base64) | **EXACT, plus simple** | Le contrat d'entrée porte déjà `documentBase64` : plus de multipart, plus de `toSafePdfFilename`, plus de piège `signable_document`. |
| `POST …/signers` × n | `createdocument.signers[]` | **EXACT** | `role` d'OpenSign est un **libellé libre** : `DEVELOPER` / `CLIENT` s'y logent tels quels. `signer_role` reste `signer`. |
| `POST …/fields` × n | `signers[].widgets[]` | **ADAPTABLE** | Les zones sont **imbriquées dans le signataire** au lieu d'être posées après coup et liées par `signer_id`. Le regroupement par rôle se fait dans le driver. Voir §5. |
| `POST …/activate` | *(néant)* | **EXACT par disparition** | `createdocument` envoie directement (`send_email`). |
| `ordered_signers: true` | `sendInOrder: true` | **EXACT** | `send_in_order_strict: true` va **plus loin** que Yousign : il bloque l'accès, pas seulement l'e-mail. À retenir pour le parcours DEV → CLIENT. |
| `signature_authentication_mode: 'no_otp'` | `enableOTP: false` | **EXACT** | |
| `signature_level: 'electronic_signature'` | *(néant)* | **GAP — juridique, à trancher** | OpenSign Cloud ne propose **pas de niveau** : signature électronique simple + certificat d'audit. Yousign expose des niveaux avancés/qualifiés. Si le contrat L.Y n'exige que le simple (c'est le cas du niveau actuellement configuré), il n'y a pas d'écart réel — **mais c'est une décision à acter explicitement, pas à hériter d'une migration technique.** |
| `redirect_urls: {success, error, decline}` **par signataire** | `redirect_url` **unique, par document** | **GAP** | Un seul retour, partagé, sans distinction d'issue. Stratégie : une URL de retour unique **du projet**, qui identifie le contrat et lit son état plutôt que de croire l'URL. L'issue ne doit de toute façon jamais venir d'un paramètre d'URL contrôlable par le signataire. |
| `activate()` → `signers[].signature_link` | `createdocument` → `signurl[{email,url}]` | **EXACT** | Rendu **directement** par la création : un appel de moins. |
| `GET /signature_requests/{id}` | `GET /document/{id}` | **EXACT** | Rend en plus `audit_trail[{email,viewed,signed}]` — une information que Yousign n'expose pas aussi simplement. |
| `GET …/signers/{signerId}` | `GET /signinglinks/{id}` | **ADAPTABLE — voir ci-dessous** | OpenSign **n'a pas d'identifiant de signataire** : ses signataires sont désignés par leur **e-mail**. |
| `GET …/documents/{id}/download` (octets) | `GET /document/{id}` → champ `file` (URL S3 pré-signée) | **ADAPTABLE, avec précaution** | Le PDF signé n'est pas servi par l'API mais par une **URL pré-signée expirante** (~900 s). Le Panel doit la récupérer **côté serveur** et continuer de rendre `contentBase64 + sha256`. ⚠️ **Cette URL ne doit jamais être transmise au projet** : c'est un droit d'accès porteur. Le champ `certificate` (piste d'audit) est disponible par le même mécanisme. |
| `POST …/cancel {reason:'other'}` | `POST /document/{id} {reason}` | **EXACT, et plus sain** | `reason` est un **texte libre**, pas une énumération non documentée : l'incident Yousign (`'cancelled'` refusé sans nommer le champ) ne peut pas se reproduire. |
| `DELETE /signature_requests/{id}` (brouillon orphelin) | `DELETE /document/{id}` | **EXACT** | Sert au nettoyage de recette. ⚠️ Le crédit est **déjà débité** à la création : supprimer ne le rend pas. |
| Idempotence fournisseur | *(néant, comme Yousign)* | **EXACT** | Aucune clé d'idempotence des deux côtés. Le registre d'opérations du Panel + l'index partiel restent **la** garantie. |
| Webhooks `signer.done` / `signature_request.*` | `created / viewed / signed / completed / declined` | **ADAPTABLE** | Voir §6.3. |
| HMAC `x-yousign-signature` | HMAC `x-webhook-signature` | **EXACT** | Même schéma : HMAC-SHA256 hexadécimal du **corps brut**. Le moteur générique du Panel le vérifie sans modification. |
| Secret de webhook rendu à la création | **jamais rendu — console uniquement** | **GAP structurel** | Voir §6.2. |

### 4.1 Le GAP `signerId` — et la manière de ne pas le payer en fuite de données

Le contrat de `signature.signer.retrieve` exige `signerId` (8 à 64 caractères), et
`signature.request.open` rend `signers[{role, signerId, signatureLink}]`. Chez OpenSign, la
seule désignation d'un signataire est **son adresse e-mail**.

Deux mauvaises réponses, et pourquoi elles sont mauvaises :

- **`signerId = e-mail`** : cela transformerait un identifiant opaque en donnée
  personnelle circulant dans le journal durable du pont, les projections de projet, et les
  traces. Le lot Yousign avait explicitement choisi de ne faire traverser qu'une
  **référence opaque du fournisseur**. Une adresse courte (`a@b.co`) échouerait en plus le
  `min(8)` du schéma.
- **Élargir le contrat** (`signerId` facultatif) : cela affaiblirait la capacité **pour
  tous les fournisseurs** au profit d'un seul.

**Stratégie retenue (lot 2)** : le Panel **frappe une poignée opaque et stable** à
l'ouverture — `sha256(documentId + ':' + email)` tronqué — et la persiste dans le lien
d'appartenance à côté du contrat. Le projet ne voit qu'elle ; le driver la retraduit en
e-mail au moment d'appeler OpenSign. Le contrat de capacité ne bouge pas, aucune adresse ne
traverse, et l'invariant « le Panel connaît la correspondance, pas le projet » est préservé.

---

## 5. Widgets et zones de signature

### 5.1 Ce qu'OpenSign documente

Chaque widget porte `type`, `page`, `x`, `y`, `w`, `h`, plus un `options{}` selon le type.
`x, y` = **coin supérieur gauche** — c'est **documenté**, alors que Yousign ne le dit nulle
part (le module `yousignCoordinates.js` porte encore un avertissement à ce sujet). Types
supportés : `signature`, `stamp`, `initials`, `email`, `name`, `job title`, `company`,
`date`, `textbox`, `checkbox`, `dropdown`, `radio button`, `image`, `number`, `cells`,
`attachments`.

Le liage au signataire se fait par **imbrication** (`signers[i].widgets[]`), pas par un
`signer_id` posé après coup. `prefill.widgets[]` permet en plus d'incruster des valeurs
avant envoi — sans signataire.

### 5.2 Comparaison avec l'éditeur SB Auto

| SB Auto (`Contract.model.js`) | OpenSign | Écart |
|---|---|---|
| `page` (1-indexé) | `page` | **aucun** — 1-indexé des deux côtés *(HYPOTHÈSE 2)* |
| `xRatio`, `yRatio` (0..1, depuis le **haut-gauche**) | `x`, `y` (px, **haut-gauche**) | conversion identique à l'actuelle, **et l'origine cesse d'être une hypothèse** |
| `widthRatio`, `heightRatio` | `w`, `h` | idem |
| `signerRole` (`DEVELOPER` / `CLIENT`) | imbrication dans `signers[i]` | **regroupement** au lieu d'un lien par identifiant |
| `type: 'SIGNATURE'` | `type: 'signature'` | casse |
| bornes Yousign (min 85 × 37 px) | **non documentées** | *(HYPOTHÈSE 3)* |

### 5.3 Les deux hypothèses qui doivent être mesurées, pas devinées

> **HYPOTHÈSE 1 — l'unité des coordonnées.** OpenSign renvoie systématiquement à son
> « Debug UI » (`app.opensignlabs.com/debugpdf`) pour obtenir x/y/w/h, et ne documente
> **nulle part** la base : points PDF (72 dpi) ? pixels du rendu de son éditeur (largeur
> fixe) ? Les exemples (`x: 327, y: 628, w: 114, h: 21` en page 1) sont compatibles avec un
> A4 en points **et** avec plusieurs échelles de rendu.
> **Mesure prescrite (lot 1)** : un PDF d'une page aux dimensions connues (A4 = 595 × 842
> pt) portant quatre repères visuels aux coins et au centre ; un document créé avec des
> widgets à des coordonnées calculées en points ; relecture du PDF signé et mesure de
> l'écart. Tant que ce résultat n'existe pas, **aucune constante d'échelle n'est écrite
> dans le code.**
>
> **HYPOTHÈSE 2 — la base d'indexation des pages.** Les exemples montrent `page: 1` pour la
> première page. Cohérent avec SB Auto, mais à confirmer sur un PDF multi-pages : une
> erreur d'un rang place la signature sur la mauvaise page **sans aucune erreur**.
>
> **HYPOTHÈSE 3 — les bornes de taille.** Non documentées. À sonder par dichotomie en bac à
> sable, ou à ne pas contraindre du tout si aucun refus n'apparaît.

### 5.4 Conséquence sur l'éditeur SB Auto (lot 4)

**Le modèle de données de l'éditeur n'a pas besoin de changer.** Ratios + page + rôle
restent le bon niveau d'abstraction : ils sont indépendants du fournisseur, et c'est
précisément ce qui rend cette migration possible sans toucher à l'écran. Seule la fonction
de conversion change de destination — et elle est déjà isolée dans un module unique et
testé.

---

## 6. Webhooks

### 6.1 Ce qu'OpenSign envoie

Cinq événements, **tous ou aucun** : `created`, `viewed`, `signed`, `completed`,
`declined`. Charge utile commune : `event`, `type` (`request-sign`), `objectId`, `file`
(URL pré-signée), `name`, `note`, `description`, plus des champs propres à l'événement —
`viewedBy/viewedAt`, `signer{}/signedAt`, `completedAt` + `certificate`,
`declinedBy/declinedReason/declinedAt`.

**Aucun identifiant d'événement.** Aucun. C'est ce qui impose une clé d'idempotence
composite (§6.4).

### 6.2 La signature, et la différence structurelle qu'elle impose

`x-webhook-signature` = **HMAC-SHA256 hexadécimal** du **corps brut**, avec la « Webhook
Security Key ». C'est **exactement** le schéma `HMAC_SHA256_BODY` que le Panel implémente
déjà pour Yousign : aucune ligne de vérification à écrire, et un test compose une vraie
signature pour le prouver.

Mais la clé **n'est rendue par aucune route**. Elle se génère dans la console
(*Settings → Webhook → Enable Authentication → Generate*) et se recopie à la main.

C'est une **quatrième modalité** de livraison de secret, et la ranger dans l'une des trois
existantes aurait des conséquences concrètes :

| Rangement | Conséquence |
|---|---|
| `AT_CREATION_ONLY` (Stripe, Yousign) | le réconciliateur **recrée l'endpoint** pour capturer un secret qui n'arrive jamais → boucle, **sur une ressource unique par compte** : chaque passage écrase l'URL en place |
| `CALLER_SUPPLIED` (Brevo) | tentative de rotation par une route inexistante |
| `NONE` | l'écran annonce « aucune vérification possible » alors qu'OpenSign signe réellement |

D'où `SECRET_DELIVERY.OUT_OF_BAND`, ajouté à `webhookRegistry.js` : la vérification
**existe**, le secret est **absent tant qu'un humain ne l'a pas saisi**, et **aucune
réparation automatique n'est possible**. Le binding reste alors en `WARNING` avec le motif
exact — un état stable, lisible, et corrigeable en une minute.

> ⚠️ **Le propre exemple de vérification de la doc OpenSign calcule le HMAC sur
> `JSON.stringify(req.body)`**, c'est-à-dire sur une **re-sérialisation**, pas sur les
> octets reçus. Si l'émetteur signe autre chose que ce qu'il met sur le fil, une
> vérification sur le corps brut — la seule correcte — échouerait.
> **HYPOTHÈSE 5**, à lever au premier webhook réel du lot 1. Le Panel ne changera pas de
> méthode : il capturera le corps brut ET la signature reçue pour trancher.

### 6.3 Mapping vers les événements génériques du Panel

Le Panel projette **trois** faits métier (`signatureEventDispatch.js`), volontairement peu
nombreux : chaque événement inutile est une donnée personnelle de plus à justifier.

| OpenSign | Fait Panel | Justification |
|---|---|---|
| `created` | *(non projeté)* | le projet vient de le demander : le lui réapprendre n'ajoute rien |
| `viewed` | *(non projeté)* | consultation — même raison que les notifications d'ouverture Yousign |
| `signed` | `SIGNATURE_SIGNER_SIGNED` | ↔ `signer.done` |
| `completed` | `SIGNATURE_COMPLETED` | ↔ `signature_request.done` ; porte en plus `certificate` |
| `declined` | `SIGNATURE_FAILED` | ↔ `signature_request.declined` |
| `revoked` *(si émis)* | `SIGNATURE_FAILED` | ↔ `signature_request.canceled` — voir ci-dessous |
| *(expiration)* | `SIGNATURE_FAILED` | ⚠️ **aucun événement documenté.** `timeToCompleteDays` existe et `documentlist/expired` aussi, mais **rien ne dit qu'un webhook part**. **HYPOTHÈSE 6** — si aucun n'arrive, une réconciliation périodique par `GET /document/{id}` devient nécessaire, sans quoi un contrat expiré resterait « en cours » pour toujours. |

**Sur `revoked`** : la page d'aide annonce « Document Revoked or Declined » dans sa liste
d'événements, mais ne publie **aucun exemple** de charge utile, et la référence API n'en
documente que cinq, `declined` compris. Deux lectures tiennent — la révocation émet
`declined`, ou elle émet un `revoked` non documenté. **On ne l'a pas inventé dans le
registre** ; le mapping métier, lui, traitera les deux libellés. **HYPOTHÈSE 7.**

**Le signataire concerné** (`extractSignerId`) : chez OpenSign, c'est `signer.email` /
`viewedBy` / `declinedBy`. Il devra être **traduit en poignée opaque** (§4.1) avant
d'entrer dans le journal durable — le lot Yousign ne faisait traverser qu'une référence
opaque, et cette règle ne s'assouplit pas parce que le fournisseur change.

### 6.4 Idempotence

Sans identifiant d'événement, le repli générique serait l'empreinte du corps brut — fragile
(une re-sérialisation par le fournisseur ferait passer un rejeu pour une nouveauté).
D'où une **clé composite**, `openSignEventIdentity()` :

```
opensign:{ENV}:{event}:{objectId}:{sha256(acteur)[0..16]}:{horodatage brut}
```

Trois décisions, chacune corrigeant un défaut précis :

- **L'acteur entre dans la clé.** Sans lui, deux signataires qui signent dans la même
  seconde produisent la même clé : le second est perdu **en silence**, et le contrat reste
  éternellement à moitié signé.
- **Il y entre haché.** La clé ne doit pas devenir un annuaire.
- **L'horodatage n'est pas parsé.** OpenSign date en RFC 1123 avec un fuseau **en toutes
  lettres** (`IST`, `GMT+9:30`) ; `Date.parse` rend `NaN` sur la plupart de ces
  abréviations, selon le moteur. Une clé bâtie sur un horodatage parsé serait tantôt
  correcte, tantôt `NaN` — et deux événements distincts partageraient alors une identité.

### 6.5 La contrainte d'exploitation qu'il faut acter maintenant

> **Un compte OpenSign = une URL de webhook.**
> Deux Panels (recette et production) **ne peuvent pas partager un compte**. Le second
> écraserait le webhook du premier, silencieusement.

La séparation TEST/PROD par jeton **et** par hôte n'est donc pas seulement imposée par le
fournisseur : elle est **la seule chose qui rende la cohabitation possible**.
`remoteEndpointLimit: 1` fait dire cela au préflight du réconciliateur plutôt qu'à un
incident.

Corollaire : un Panel qui découvre une URL déjà posée **ne peut pas prouver qu'elle est la
sienne** — OpenSign n'a pas de champ description, donc pas de jeton d'appartenance. Il
refuse d'y toucher (`WEBHOOK_REMOTE_LIMIT_REACHED`). C'est le bon arbitrage : écraser l'URL
d'un autre Panel couperait sa réception de signatures sans que rien ne l'en avertisse. La
réparation est humaine et prend dix secondes (retirer l'URL dans la console, ou
`DELETE /webhook`).

---

## 7. Limites, quotas et restrictions

| Sujet | Fait | Conséquence pour nous |
|---|---|---|
| **Taille de fichier — Cloud** | 10 Mo (+10 Mo de marge de signature) ; extensible à 90 Mo pour l'entreprise sur demande ; **plafond serveur dur : 100 Mo** | La borne des deux côtés est aujourd'hui **12 Mio** (`signatureDocumentLimits.js` au Panel, `MAX_DOCUMENT_BYTES` dans SB Auto), soit **au-dessus** de la limite Cloud OpenSign. **À abaisser en lot 2**, sans quoi un contrat de 11 Mo serait accepté par le Panel puis refusé par le fournisseur — avec un message qui parlerait du fournisseur au lieu de parler du PDF. |
| **Taille — Sandbox** | *« Évitez les documents de plus de 5 Mo »* | Les PDF de recette doivent rester **< 5 Mo**. À vérifier sur le PDF de contrat réel : s'il dépasse, la recette du lot 1 doit utiliser une version allégée. |
| **Crédits API** | débités à la **création** : `selfsign`, `draftdocument`, `createdocument`, `drafttemplate`, `createdocument/{template_id}`, envoi en masse, gabarit public | ⚠️ **Chaque tentative ratée après création coûte un crédit**, et la suppression ne le rend pas. Le validateur sonde donc `getcredits` et **avertit à 0** : sans cela, l'épuisement se découvrirait pendant une signature. |
| **Crédits — visibilité** | `plan_credits` (remis à zéro par cycle) + `addon_credits` (sans expiration, consommés en second) | Le diagnostic les rend séparément. |
| **Crédits — alertes** | e-mails du fournisseur à 50, 10 et 0 crédits restants | Ne remplacent pas la sonde : ils partent au propriétaire du compte, pas au Panel. |
| **Plan requis (Live)** | jeton Live = Professional ou Teams ; webhook Live = idem | **Le lot 1 est intégralement faisable en gratuit** (bac à sable). Le passage en production est une décision commerciale, à prendre avant le lot 5. |
| **Bac à sable** | jeton distinct, hôte distinct, **gabarits non partagés**, webhook distinct, accès **uniquement** par le bouton « Login to Sandbox » | Un mot de passe saisi à la main sur l'hôte sandbox **ne fonctionne pas** — piège d'exploitation à connaître avant de chercher pourquoi la connexion échoue. |
| **Fonctions Teams/Enterprise** | `getformdata`, `getsignerips`, `hide_text_with_asterisks` | Aucune n'est sur le chemin critique. Ne pas en dépendre. |
| **Auto-hébergement gratuit** | **aucun jeton API** | Un repli « self-host » n'est pas une porte de sortie gratuite. |
| **Piste d'audit** | `certificate` (URL) sur `GET /document/{id}` et sur l'événement `completed` ; `merge_certificate: true` l'incorpore au PDF | **Meilleur que l'existant** : le parcours actuel ne récupère pas de certificat séparé. À exploiter en lot 4. |
| **Limites signataires / widgets** | **non documentées** | Le contrat de capacité borne déjà à 4 signataires et 40 zones. Conservé — une borne locale connue vaut mieux qu'une borne distante inconnue. |
| **Rate limiting** | **non documenté** | Le transport traite `429` comme `RATE_LIMITED` sans réessayer. |

---

## 8. OpenSign dans IntegratedAPI — le modèle d'exécution retenu

### 8.1 `runtimeModel` : **dual environment, deux comptes**

| Question | Réponse | Preuve |
|---|---|---|
| `single_environment` ? | **non** | jetons Live/Sandbox explicitement non interchangeables |
| `dual_environment` ? | **oui** | deux hôtes, deux jetons, deux webhooks, gabarits non partagés |
| jetons séparés ? | **oui** | *« Les jetons Live ne fonctionnent pas dans le bac à sable. »* |
| endpoint UE séparé ? | **oui, mais c'est un autre compte** | voir §8.3 |

D'où, au registre :

```
scope          SCOPES.ENVIRONMENT      (jamais PANEL_GLOBAL : deux comptes qui ne se voient pas)
tokenStrategy  STATIC_KEY              (x-api-token, rien à rafraîchir)
authority      PANEL                   (comme les quatre autres — aucun projet ne détient de jeton)
```

### 8.2 Rôles de credentials

| Rôle | Secret | Requis | Auto-géré | Pourquoi ce nom / cet état |
|---|---|---|---|---|
| `apiToken` | oui | **oui** | non | le nom du fournisseur (`x-api-token`). `apiKey` aurait imposé une traduction mentale au moment précis où l'on cherche pourquoi un appel part sans en-tête |
| `webhookSecret` | oui | non | **non** | l'API ne le rend jamais. Le marquer auto-géré afficherait « arrive tout seul » sous un champ que personne ne remplirait — et le webhook resterait sourd en silence |
| `webhookSecretPrevious` | oui | non | oui, **interne** | la rotation est manuelle, mais les événements en vol ne le savent pas. Invisible dans tout formulaire |
| `baseUrl` | non | non | non | défaut **par environnement**, et **contrainte d'hôte** par environnement |

Le rôle `webhookSecret` est marqué `verificationOnly` : il **vérifie**, il n'**appelle**
pas. C'est ce qui l'autoriserait, plus tard, à franchir le pont vers un projet par le canal
dédié sans ouvrir de brèche générique.

### 8.3 TEST / PROD : la décision d'hôte, et pourquoi elle est écrite

```
TEST → https://sandbox.opensignlabs.com/api/v1.2     (contrainte d'hôte : sandbox.opensignlabs.com)
PROD → https://app.opensignlabs.com/api/v1.2         (contrainte d'hôte : app.opensignlabs.com)
```

**Pourquoi `app` et non `eu-app`.** Les trois bases ne sont pas trois chemins vers un même
compte : `eu-app` est un **tenant distinct**, avec ses propres comptes et ses propres
jetons. Un jeton émis sur `app` y reçoit un refus d'authentification, pas une redirection.
Le choix n'est donc pas une préférence d'URL, **c'est le choix du compte**. Deux faits
tranchent aujourd'hui :

1. le bac à sable documenté est `sandbox.opensignlabs.com`, et on y accède depuis le compte
   par « Login to Sandbox » — **le parcours officiel part du compte global** ;
2. **aucune exigence de résidence des données n'a été arrêtée pour L.Y Solution.** Choisir
   l'UE « au cas où » supposerait de rouvrir un compte, de réémettre les jetons, de recréer
   les gabarits (ils ne traversent pas) — pour une contrainte qui n'est pas formulée.

Le jour où la résidence UE devient une exigence, **la bascule est une ligne dans
`providerRegistry.js`**, revue et datée. Un test verrouille la valeur actuelle : la bascule
sera un acte vu, jamais une valeur découverte après coup dans une base.

**La contrainte d'hôte n'est pas un défaut.** Un défaut est une valeur proposée, qu'une
saisie remplace. La contrainte, elle, **refuse** un jeu TEST pointant vers l'hôte de
production — et le refus tombe **avant le réseau**, donc sans exposer le jeton à un monde
qui n'est pas le sien. C'est l'incident Yousign de juillet, transposé avant qu'il ne se
reproduise : une clé de bac à sable envoyée à l'hôte de production reçoit un refus
indiscernable d'une clé morte, sur toutes les routes.

### 8.4 Capacités déclarées

OpenSign déclare **exactement les mêmes cinq codes** que Yousign :
`signature.request.open`, `.retrieve`, `.cancel`, `signature.signer.retrieve`,
`signature.document.download`.

`capabilitiesForProvider('OPENSIGN')` rend **`[]`** : le registre des capacités désigne
encore `YOUSIGN` comme exécutant. **Cet écart est l'état de la migration**, et il est
lisible plutôt que subi. Deux tests l'encadrent — l'un vérifie que chaque code déclaré
existe au registre, l'autre que Yousign reste l'autorité. Le jour du basculement, l'exception
nommée dans `capability-registry-coherence.test.js` devra disparaître : c'est ce qui
obligera à s'en souvenir.

---

## 9. Ce qui a été écrit

### 9.1 Fichiers créés

| Fichier | Rôle |
|---|---|
| `backend/src/services/integratedApi/opensign/openSignTransport.js` | **le driver.** En-tête `x-api-token`, hôte **du coffre uniquement**, erreurs typées, délai borné, issue indéterminée sur timeout, **aucun réessai**, aucun secret dans une erreur. Verbes du **plan de contrôle seulement** : `getUser`, `getCredits`, `getWebhook`, `saveWebhook`, `deleteWebhook` |
| `tests/integrated-api-opensign-foundation.test.js` | **135 contrôles**, aucun appel réseau |
| `docs/integrated-api/OPENSIGN_API_AUDIT_AND_FOUNDATION.md` | ce document |

### 9.2 Fichiers modifiés (tous additifs)

| Fichier | Modification |
|---|---|
| `integratedApi/providerRegistry.js` | définition `OPENSIGN` (4 rôles, hôtes par environnement + contraintes, 5 capacités déclarées) |
| `integratedApi/providerValidation.js` | `validateOpenSign` en **trois niveaux** + deux sondes de capacité |
| `webhooks/webhookRegistry.js` | `SECRET_DELIVERY.OUT_OF_BAND`, `supportsDescription`, descripteur `OPENSIGN`, `OPENSIGN_EVENTS`, `openSignEventIdentity` |
| `webhooks/providerWebhookAdapters.js` | pilote distant `openSignWebhookAdapter` (ressource singleton) |
| `webhooks/webhookReconciler.js` | `computeDrift` ne compare la description **que chez les fournisseurs qui en ont une** |
| `capabilities/capabilityRegistry.js` | la boucle de cohérence parcourt **tous** les fournisseurs, au lieu d'une liste retapée |
| `tests/helpers/secretShapes.js` | formes de fixtures `openSignApiToken`, `openSignWebhookKey` |
| 6 suites existantes | `integrated-api-provider-registry`, `integrated-api-control-plane`, `integrated-api-http-security`, `webhook-control-plane`, `capability-registry-coherence`, `brevo-control-plane` — comptes 4 → 5 fournisseurs, 7 → 9 jeux amorcés, invariants OpenSign, exception de migration nommée (voir §10.1) |

### 9.3 Une correction de fond, trouvée en chemin

`capabilityRegistry.assertRegistryAlignment()` vérifiait que les capacités annoncées par un
fournisseur existent bien — sur une **liste littérale de quatre codes**. Le contrôle
s'appliquait donc exactement aux fournisseurs qui n'en avaient plus besoin (ceux déjà
écrits), et **jamais au suivant**, qui est le seul cas où il sert. Il parcourt désormais le
registre.

### 9.4 Le bouton de test IntegratedAPI

Il existe déjà et il est **générique** : l'écran d'administration rend les fournisseurs
depuis `describeProviderDefinition()`, et `hasValidator('OPENSIGN')` répond `true`.
**OpenSign apparaît donc avec son formulaire, ses deux environnements et son bouton « Tester
la connexion » sans une ligne de React.** Aucun appel n'a été exécuté : il n'y a pas de
credentials.

Ce que le test fera, une fois le jeton saisi :

1. **niveau 0** — l'hôte correspond-il à l'environnement ? Refus **avant le réseau** sinon ;
2. **niveau 1** — `GET /getuser`. Lecture pure : ne crée rien, n'envoie aucun e-mail, **ne
   débite aucun crédit**. C'est ce qui permet de cliquer autant de fois qu'on veut — et
   c'est une exigence plus dure ici qu'ailleurs, puisque la moitié de l'API OpenSign
   facture un crédit à la création d'un document ;
3. **niveau 2** — `GET /webhook` : le jeton peut-il administrer l'URL ? Le corps n'est
   **jamais conservé** (il porte l'URL d'un autre Panel, le cas échéant) ;
4. **niveau 3** — `GET /getcredits` : le compte peut-il encore créer des documents ?

Les niveaux 2 et 3 **ne dégradent jamais** le verdict du credential. Un jeton qui
s'authentifie sur un compte à zéro crédit est valide, capable d'administrer, et incapable
d'ouvrir une signature : trois faits vrais en même temps, que « clé invalide » écraserait en
un seul mensonge.

---

## 10. Recette

```
integrated-api-opensign-foundation      135 réussis, 0 échoués   (nouveau)
integrated-api-provider-registry         85 réussis, 0 échoués
integrated-api-environment-routing       30 réussis, 0 échoués
integrated-api-encryption                46 réussis, 0 échoués
integrated-api-control-plane             68 réussis, 0 échoués
integrated-api-http-security             39 réussis, 0 échoués
webhook-control-plane                   256 réussis, 0 échoués
capability-registry-coherence           115 réussis, 0 échoués
capability-gateway                      117 réussis, 0 échoués
capabilities                             18 réussis, 0 échoués
bridge-provider-secret-boundary          57 réussis, 0 échoués
secret-hygiene                           47 réussis, 0 échoués
signature-event-dispatch                 35 réussis, 0 échoués
signature-reservations                   34 réussis, 0 échoués
brevo-control-plane                     237 réussis, 0 échoués
stripe-control-plane                    143 réussis, 0 échoués
hostinger-control-plane                 118 réussis, 0 échoués
provider-secret-sentinel-e2e             25 réussis, 0 échoués
architecture                             31 réussis, 0 échoués
diagnostic                              179 réussis, 0 échoués
────────────────────────────────────────────────────────────
TOTAL                                  1815 réussis, 0 échoués

payload-drift / spec-drift / engine-drift                     verts
panel-ui / registry / config / readiness                      verts
```

Périmètre choisi : les suites que ce lot touche ou dont il dérive. Les suites de
déploiement, de finance et de fédération ne lisent ni le registre des fournisseurs ni le
registre webhook.

### 10.1 Deux comptages figés ont dû être rouverts, et l'un était une faute

`brevo-control-plane.test.js` vérifiait « toujours 4 fournisseurs » sous un commentaire
disant *« On vérifie que les rôles CONNUS sont intacts, PAS qu'il n'y en a que trois : un
test qui refuserait cet ajout transformerait une exigence en obstacle. »* Le test appliquait
donc aux **fournisseurs** exactement la faute qu'il refusait pour les **rôles**. Il vérifie
désormais que les quatre fournisseurs de L1 sont **tous encore là** — ce que la section
prétend prouver (« L8 n'a rien pris à personne ») — sans interdire au parc de grandir.

Les autres comptes (`5` fournisseurs, `9` jeux amorcés) sont de vrais invariants et ont été
mis à jour à leur nouvelle valeur.

---

## 11. Ce qui n'a **pas** été fait, volontairement

- **Aucun verbe de document dans le driver.** Créer un document OpenSign consomme un crédit
  et peut envoyer un e-mail à une personne réelle. Un verbe qui existe finit par être
  appelé — d'abord dans un test, puis par accident. Ils arriveront avec l'adaptateur qui
  sait quand les employer.
- **Aucun adaptateur de capacité.** `capabilitiesForProvider('OPENSIGN')` rend `[]`.
- **Aucun sélecteur de fournisseur.** Yousign exécute encore les cinq capacités.
- **Aucun appel réseau.** Il n'y a pas de credentials, et aucun test ne sort.
- **Rien de retiré à Yousign.** Ni fichier, ni rôle, ni capacité, ni webhook, ni test.
- **`BUSINESS_CRITICAL` inchangé** dans `webhookDiagnostics.js` : OpenSign n'est pas encore
  l'autorité, et le marquer critique dès maintenant ferait remonter un avertissement de
  gravité maximale pour un fournisseur non configuré. **À basculer en lot 3**, en même temps
  que l'autorité.

---

## 12. Les sept hypothèses à lever au lot 1

| # | Hypothèse | Comment la lever | Coût si elle est fausse |
|---|---|---|---|
| 1 | Les coordonnées des widgets sont en **points PDF** (72 dpi) | PDF A4 à repères connus, widgets calculés, mesure de l'écart sur le PDF signé | signatures décalées ou hors page, **sans aucune erreur** |
| 2 | Les pages sont **1-indexées** | document multi-pages, widget en page 2 | signature sur la mauvaise page, silencieusement |
| 3 | Pas de **bornes de taille** de widget | dichotomie sur `w`/`h` | refus incompréhensibles à l'ouverture |
| 4 | `createdocument` **ne crée pas de contacts** implicites | `GET /contactlist` avant / après | fuite d'annuaire, nettoyage de recette incomplet |
| 5 | Le HMAC porte sur les **octets reçus** (pas une re-sérialisation) | capturer corps brut + signature d'un vrai webhook | **tous** les webhooks refusés en 401 |
| 6 | Une **expiration** émet un webhook | `timeToCompleteDays: 1`, attente | contrat expiré éternellement « en cours » |
| 7 | Une **révocation** émet `declined` ou `revoked` | révoquer un document et observer | contrat révoqué éternellement « en cours » |

À quoi s'ajoutent les vérifications que le lot 1 impose déjà, et dont une compte
particulièrement :

> **Le bac à sable OpenSign accepte-t-il un signataire externe ?**
> Le bac à sable **Yousign** n'accepte comme destinataire qu'une adresse de l'organisation
> du compte — un bridage qui produit un refus au payload parfaitement valide, et qui a coûté
> une session entière de recherche du côté du payload. Rien dans la documentation OpenSign
> n'annonce une limitation équivalente. **C'est à prouver, pas à espérer** : si elle
> existait, tout le parcours DEV → CLIENT serait intestable en recette, et il faudrait le
> savoir avant d'écrire l'adaptateur, pas après.

---

## 13. Gate

**Lot 0 terminé.** Le Panel sait décrire, configurer, valider et joindre OpenSign ; il ne
lui a confié aucun acte métier ; Yousign reste intact et autorité.

**Attendu de votre part** : le jeton **Sandbox** OpenSign, saisi dans le Panel
(*Intégrations → OpenSign → TEST*), avec `baseUrl` laissée à sa valeur par défaut. La clé de
sécurité du webhook peut attendre le lot 1 — c'est là qu'elle servira.

Le bouton « Tester la connexion » est alors le premier geste du lot 1.

---

## Annexe A — les 36 opérations v1.2, sans exception

Récapitulatif complet. `Auth` = `x-api-token` partout. `Sbx/Prod` = disponible dans les
deux mondes, avec des **jetons distincts**, pour les 36.
`Usage` : **●** = sur le chemin du contrat · **○** = recette / diagnostic · **–** = hors périmètre.

| # | Méthode | Chemin | Objet | Usage | Capacité cible |
|---|---|---|---|---|---|
| 1 | `GET` | `/getuser` | compte du porteur | ○ | *sonde de validation* |
| 2 | `GET` | `/getcredits` | crédits API | ○ | *diagnostic* |
| 3 | `POST` | `/createcontact` | créer un contact | – | — |
| 4 | `GET` | `/contact/{id}` | lire un contact | – | — |
| 5 | `PUT` | `/contact/{id}` | modifier un contact | – | — |
| 6 | `PUT` | `/contact-by-email/{email}` | modifier par e-mail | – | — |
| 7 | `DELETE` | `/contact/{id}` | supprimer un contact | ○ | *cleanup si HYPOTHÈSE 4 se confirme* |
| 8 | `GET` | `/contactlist` | lister les contacts | ○ | *cleanup / vérification H4* |
| 9 | `POST` | `/createdocument` | **créer + envoyer** | ● | **`signature.request.open`** |
| 10 | `POST` | `/draftdocument` | créer sans envoyer | – | — |
| 11 | `POST` | `/createdocument/{template_id}` | créer depuis gabarit | – | *écarté : gabarits non partagés TEST/PROD* |
| 12 | `POST` | `/selfsign` | auto-signature | – | — |
| 13 | `GET` | `/document/{id}` | état + `file` + `certificate` + `audit_trail` | ● | **`signature.request.retrieve`**, **`.document.download`** |
| 14 | `PUT` | `/document/{id}` | modifier (hors fichier) | ○ | *correction de `redirect_url`* |
| 15 | `POST` | `/document/{id}` | **révoquer** | ● | **`signature.request.cancel`** |
| 16 | `DELETE` | `/document/{id}` | supprimer | ○ | *cleanup de recette* |
| 17 | `GET` | `/documentlist/{doctype}` | lister par état | ○ | *inventaire de cleanup* |
| 18 | `POST` | `/resendmail` | relancer un signataire | – | *candidat post-lot 4* |
| 19 | `GET` | `/signinglinks/{id}` | liens de signature | ● | **`signature.signer.retrieve`** |
| 20 | `GET` | `/formdata/{id}` | valeurs saisies | – | ⚠️ Teams/Enterprise |
| 21 | `GET` | `/signerips/{id}` | IP des signataires | – | ⚠️ Teams/Enterprise |
| 22 | `POST` | `/createtemplate` | créer un gabarit | – | — |
| 23 | `POST` | `/drafttemplate` | brouillon de gabarit | – | — |
| 24 | `GET` | `/template/{id}` | lire un gabarit | – | — |
| 25 | `PUT` | `/template/{id}` | modifier un gabarit | – | — |
| 26 | `DELETE` | `/template/{id}` | supprimer un gabarit | – | — |
| 27 | `GET` | `/templatelist` | lister les gabarits | – | — |
| 28 | `POST` | `/publictemplate` | gabarit public + URL publique | – | — |
| 29 | `GET` | `/webhook` | l'URL du compte | ○ | *pilote de réconciliation* |
| 30 | `POST` | `/webhook` | poser / mettre à jour | ○ | *pilote de réconciliation* |
| 31 | `DELETE` | `/webhook` | retirer | ○ | *pilote de réconciliation* |
| 32 | `POST` | `/createfolder` | créer un dossier | – | *confort, à reconsidérer post-lot 4* |
| 33 | `GET` | `/folder/{id}` | lire un dossier | – | — |
| 34 | `PUT` | `/folder/{id}` | modifier un dossier | – | — |
| 35 | `DELETE` | `/folder/{id}` | supprimer (refuse si non vide) | – | — |
| 36 | `GET` | `/folderlist` | lister les dossiers | – | — |

**Sur le chemin du contrat : 4 opérations.** Yousign en demandait 11 pour le même résultat.
La réduction n'est pas cosmétique : chacune de ces sept étapes disparues était un point où
une préparation pouvait s'arrêter à mi-chemin, et donc un état à rattraper.

---

## Annexe B — codes d'erreur, et ce qu'ils veulent vraiment dire

| Statut | Corps typique | Sens réel chez OpenSign | Traitement du driver |
|---|---|---|---|
| `400` | `{"error":"Something went wrong, please try again later!"}` | entrée refusée — **le champ fautif n'est jamais nommé** | `INPUT_INVALID` (issue certaine) |
| `400` | `{"error":"Subscription not found!"}` (sur `/getcredits`) | compte sans abonnement, **jeton valide** | non fatal : la sonde de crédits rend `null` |
| `400` | mention de « credit » | crédits épuisés | `QUOTA_EXHAUSTED` — pas `INPUT_INVALID` |
| `401` | `{"error":"Webhook url already exists!"}` | **conflit**, jeton valide | `REJECTED` — pas `UNAUTHORIZED` |
| `401` | autre | jeton refusé | `UNAUTHORIZED` |
| `404` | `{"error":"Document not found!"}` | ressource absente | `NOT_FOUND` |
| `404` | `{"error":"User not found!"}` sur `/webhook` | **aucune URL posée** — pas une panne | liste vide (sinon la première configuration serait impossible) |
| `405` | `{"error":"Invalid API token!"}` | **jeton refusé** | `UNAUTHORIZED` — voir §1 |
| `429` | — | non documenté | `RATE_LIMITED`, **sans réessai** |
| `5xx` | — | panne fournisseur | `PROVIDER_ERROR`, `retryable` **informatif**, jamais automatique |
| *timeout* | — | **issue indéterminée** | `TIMEOUT` + `outcome: UNKNOWN` + `replaySafe: false` |

Le message du fournisseur n'est **jamais** relayé dans le message d'erreur : il voyage dans
`providerError`, où l'appelant décide s'il l'expose. C'est ce qui permet de le reconnaître
(« already exists », « credit ») sans le recopier vers un projet.
