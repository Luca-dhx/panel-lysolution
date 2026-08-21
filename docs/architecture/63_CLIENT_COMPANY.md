# 63. L'ENTREPRISE CLIENTE — l'identité juridique à qui l'on facture

## 1. Le manque que ce domaine comble

Le Panel connaissait des **sites**, pas des **sociétés**.

Il manipulait cinq notions voisines, et aucune ne répondait à la question
« à quelle personne morale adresse-t-on cette facture ? » :

| Notion | Ce qu'elle est |
|---|---|
| `PanelCompany` | L.Y Solution elle-même — le tenant, le **vendeur** |
| `PanelProject` | une **instance technique** appairée. Un produit |
| `PanelProjectContract` | la projection d'un **engagement commercial** |
| `PanelUser` | un compte qui se connecte au Panel |
| Stripe Customer | une **projection fournisseur** de l'entreprise cliente |

Faute de réponse, le code en fabriquait une par défaut :

```js
// stripeCustomerAuthority.js, avant ce chantier
const name = input.customer?.name || projection.reference || contractId;
```

`projection.reference`, c'est la **référence de contrat**. D'où, sur une facture
réellement émise :

```text
Facture QWSK7ZZY-0004 · 21 août 2026
Facturer à : CTR-2026-0002
              luca.duhoux@icloud.com
Montant 95,99 €  ·  Sous-total 95,99 €  ·  Total 95,99 €
```

Ni raison sociale, ni adresse, ni SIREN, ni ventilation de TVA. Une pièce
qu'aucun comptable ne peut inscrire dans un livre.

## 2. Le modèle

`PanelClientCompany` — une collection, pas un bloc sur le projet.

**Pourquoi une collection.** Une entreprise cliente possède PLUSIEURS projets,
et c'est le cas nominal :

```text
SARL DUPONT AUTOMOBILES
  ├── Demo SB Auto   (recette)
  └── sbauto06.fr    (production)
```

La porter sur le projet obligerait à recopier la même identité légale autant de
fois qu'il y a de sites, et un changement d'adresse deviendrait une opération de
masse dont on ne saurait jamais dire si elle a été complète.

```text
ClientCompany  1 ──── N  PanelProject
```

Le lien vit du côté « plusieurs » (`PanelProject.clientCompanyId`) : une liste
des deux côtés se désynchronise, et rien ne dirait laquelle fait foi.

### Ce qu'elle porte

```text
IDENTITÉ      legalName (obligatoire) · tradingName · legalForm
              siren · siret · vatNumber · registrationCity
ADRESSES      registeredOffice (siège) · billingAddress (null = « idem siège »)
COORDONNÉES   billingEmail · phone · website · administrativeContact
SIGNATURE     contractualSigner  (prénom, nom, fonction, e-mail)
DOCUMENTS     documents[]  → média PRIVÉ, jamais les octets ici
EXPLOITATION  status (ACTIVE | ARCHIVED) · notes (INTERNES) · environment
PUBLICATION   publishedVersion · publishedAt
```

`siren` est stocké **séparément** du `siret`, et n'en est jamais dérivé : le
SIRET identifie un ÉTABLISSEMENT et change au déménagement ; le SIREN identifie
la personne morale et ne change pas. On connaît toujours le second, rarement le
premier.

`billingAddress: null` se lit **« la même que le siège »**, jamais « inconnue ».
C'est le cas de l'immense majorité des TPE, et leur imposer une double saisie
garantirait que les deux finissent par diverger. La substitution est faite une
fois, dans `effectiveBillingAddress()`, et personne ne la refait.

## 3. Saisir EST publier

Contrairement à `PanelCompany`, il n'y a **pas de brouillon**.

| | Entreprise développeur | Entreprise cliente |
|---|---|---|
| diffusion | tout le parc (`audience: null`) | ses projets SEULEMENT (`audience: <projectId>`) |
| brouillon | oui — publier est un acte | non — enregistrer EST publier |
| pourquoi | ne pas répandre un état incohérent | ce qu'elle porte est BLOQUANT |

Tant qu'une adresse manque, le client ne peut ni payer ni signer. Laisser une
correction en brouillon, c'est laisser un client bloqué par un champ que
quelqu'un a déjà rempli.

`publishedVersion` s'incrémente à chaque écriture. Le numéro ne sert pas à
choisir quoi diffuser : il sert à l'applicateur du projet, qui écarte une
écriture plus ancienne que celle qu'il applique déjà — le cas normal après un
rattrapage désordonné.

## 4. La readiness — deux verdicts, jamais fondus

`resolveClientCompanyReadiness()` — un seul résolveur, deux réponses.

```text
BILLING   ce qu'une FACTURE doit porter :
          raison sociale · SIREN · e-mail de facturation
          adresse (voie, code postal, ville, pays)

SIGNING   ce qu'une SIGNATURE exige :
          prénom · nom · e-mail du signataire contractuel
```

Les deux sont **indépendants**. Une entreprise parfaitement identifiable peut
n'avoir désigné personne pour signer ; un signataire complet ne remplace aucune
adresse de facturation. Les fondre bloquerait un paiement parfaitement légal
parce qu'aucun contrat n'est prévu.

| État | Sens |
|---|---|
| `READY` | tout est là |
| `MISSING_COMPANY` | aucune entreprise rattachée, **ou** entreprise archivée |
| `MISSING_BILLING_IDENTITY` | il manque de quoi facturer |
| `MISSING_SIGNER` | il manque de quoi signer |

`state` est une **synthèse d'affichage**. Les gardes lisent `billing.ready` ou
`signing.ready` — jamais `state`.

**Le SIREN fait partie de la facturation.** Pas par zèle : il devient une
mention obligatoire de la facture électronique française au 1er septembre 2026,
et il est de toute façon la seule donnée qui identifie durablement la personne
morale facturée.

## 5. NO CLIENT COMPANY → NO PAYMENT, NO SIGNATURE

La règle est **backend et autoritative**, à trois endroits :

| Point d'usage | Fichier | Ce qu'il refuse |
|---|---|---|
| ouverture de paiement | `stripeCheckoutAuthority.resolveCheckoutIntent` | frais de lancement, abonnement, prestation |
| garantie du client Stripe | `stripeCustomerAuthority.resolveCustomerIntent` | la création même du client |
| ouverture de signature | `openSignAdapters.signatureRequestOpen` | avant toute réservation, avant tout crédit consommé |

Chacun refuse **avant tout contact fournisseur** : un refus ne laisse aucune
trace chez Stripe ni chez OpenSign.

Le code rendu est `CLIENT_COMPANY_NOT_READY`, et il est **nommé** — contrairement
à la doctrine d'indistinction des refus de L6.2A. La raison : cette doctrine
protège d'un ORACLE (un projet apprendrait le parc en comparant des refus). Ici
le projet interroge SA propre situation, la réponse ne parle que de lui, et
c'est la seule réponse actionnable du lot. « Refusé » sans motif enverrait
chercher une panne Stripe.

Les gardes du Manager (côté projet) existent pour **expliquer avant de faire
cliquer**, jamais pour protéger seules.

## 6. L'instantané légal — l'histoire ne se réécrit pas

Une SARL déménage six mois après avoir été facturée. Si la facture lisait
l'entreprise EN DIRECT, elle afficherait la nouvelle adresse — et prétendrait
qu'un document émis en mars portait une adresse qui n'existait qu'en septembre.

`clientLegalSnapshot.js` fige ce qui a été UTILISÉ :

```text
buildClientLegalSnapshot()   identité · adresses (déjà résolues) · SIREN · TVA
buildClientSignerSnapshot()  la personne physique + la raison sociale
```

Ce module ne crée aucune collection : il étend une discipline déjà éprouvée deux
fois — `Contract.signersSnapshot` côté projet, `projectNameSnapshot` sur les
mouvements financiers.

**Ce qu'il ne faut jamais faire** : stocker `clientCompanyId` seul dans une
facture et « aller chercher le reste au moment d'afficher ». C'est exactement la
dépendance dynamique que ce module empêche — et elle est d'autant plus dangereuse
qu'elle paraît propre.

L'identifiant est conservé **à côté** de l'instantané, jamais à sa place : il
répond à « de quelle fiche cela vient-il ? », ce qu'un instantané ne sait pas
dire.

## 7. Rattachement, changement, détachement

| Geste | Effet | Ce qu'il ne fait PAS |
|---|---|---|
| rattacher | le projet reçoit l'identité immédiatement | rien d'existant n'est réécrit |
| changer | les opérations À VENIR portent la nouvelle | les factures, contrats et clients Stripe déjà émis gardent la leur |
| détacher | paiements et signatures suspendus | la fiche cliente n'est pas touchée |

Le client Stripe est lié au **contrat**, pas au projet (doctrine L6.2D). Un
contrat en cours conserve donc son client et son identité de facturation : le
nouveau rattachement ne vaut que pour le prochain contrat. Le service le DIT
dans son retour (`pendingContract`), pour que l'écran en avertisse plutôt que de
le laisser découvrir sur la facture suivante.

Un changement émet **deux écritures** — la nouvelle identité, puis le retrait de
l'ancienne. L'applicateur du projet vérifie que le tombstone désigne bien
l'entreprise COURANTE : sans cela, il effacerait celle qu'on vient d'appliquer.

## 8. Archiver, jamais supprimer naïvement

Une entreprise cliente est référencée par des instantanés de factures, des
contrats signés et des mouvements financiers.

```text
supprimer une fiche AVEC projets ou documents   → REFUSÉ (409)
archiver                                        → toujours possible
```

L'archivage rend la fiche **non prête** : plus aucun paiement, plus aucune
signature. Les projets **restent rattachés**, et c'est délibéré — les détacher
effacerait l'information « ce site appartenait à ce client », qui est
précisément ce qu'on vient chercher dans une archive.

Il n'y a **aucune cascade destructive** dans ce domaine, et il n'y en aura pas.
Détacher automatiquement les projets « pour pouvoir supprimer » reviendrait à
faire la cascade en la déguisant.

## 9. Les documents administratifs

Kbis, attestation de vigilance, mandat, RIB, statuts…

Ils empruntent le **protocole Media PRIVÉ** déjà en service pour les
justificatifs de coût (`privateMedia.service.js`), sous la portée
`CLIENT_COMPANY_DOCUMENT`. Aucune seconde pile de fichiers.

```text
octets        storage/media/     — aucun express.static, aucun bloc Nginx
descripteur   PanelMedia         — visibility: PRIVATE, publicationState: LOCAL_ONLY
rattachement  ClientCompany.documents[]  — le lien, jamais une URL
sortie        /api/client-companies/:id/documents/:documentId  (authentifiée)
```

**Le chemin porte le contexte.** On aurait pu exposer
`/api/media/private/:mediaId` : cette surface ne peut être autorisée que par une
table d'ACL parallèle, puisqu'un média seul ne sait pas à qui il appartient. En
passant par la fiche, l'autorisation devient une conséquence de l'objet métier —
et un identifiant récupéré ailleurs ne mène nulle part (404, jamais 403).

**Une seule autorité média, et elle est déployée.** Le dépôt et la lecture
RELAIENT vers l'autorité quand l'instance n'en est pas une, exactement comme les
images. Sans ce relais, le descripteur — écrit dans la base PARTAGÉE —
annoncerait un fichier que l'autre instance ne trouverait jamais.

`type` est une catégorie **libre** : la liste des pièces n'est pas connue
d'avance et change selon le client. Une énumération fermée aurait obligé à
livrer du code pour accepter un document, et la première urgence l'aurait
contournée en déposant le fichier sous une mauvaise étiquette.

## 10. Ce qui part au projet, et ce qui n'en part jamais

Entité de synchronisation `CLIENT_COMPANY`, **nominative**.

| Sort | Ne sort JAMAIS |
|---|---|
| identité légale, adresses | `notes` — une appréciation interne, lue par le client |
| coordonnées de facturation | `documents[]` — un Kbis n'a rien à faire dans la base d'un site vitrine |
| signataire contractuel | `createdBy` / `updatedBy` — les adresses des exploitants |
| le VERDICT de readiness | |

Le verdict voyage plutôt que d'être recalculé côté projet : la complétude est une
décision de FACTURATION, elle appartient à l'émetteur des factures, et deux
implémentations divergeraient au premier changement de mention obligatoire.

`audience: <projectId>` est ce qui empêche un garage de lire le SIREN d'un autre.
L'autorisation est portée par l'**écriture**, jamais par un filtre appliqué à la
lecture.

## 10 bis. L'identité de l'écriture n'est pas l'identité de la fiche

| | Valeur | Où |
|---|---|---|
| identifiant **métier** | `cc217bdccb550b4514ae7b` | la fiche, les URL d'écran, la charge utile |
| identifiant **d'entité** | UUID v5 dérivé | l'écriture du pont (`entityId`) |

Le contrat impose `entityId: uuid`. L'identifiant métier n'en est pas un :
il est court et opaque, choisi pour être lisible dans une URL. Émis tel quel,
il faisait **écarter** l'écriture à l'arrivée — et un rejet de lecture est une
perte définitive : le curseur avance, le Panel ne relivre pas.

La dérivation est un UUID v5 : `stableBridgeId('client-company:<id>')`. Même
graine, même identifiant, pour toujours — l'idempotence du pont, qui repose
sur `entityId`, tient d'un redémarrage à l'autre.

**Le retrait emprunte la MÊME dérivation.** Un tombstone n'a pas de charge
utile : il ne désigne l'entreprise que par son `entityId`. Deux dérivations
différentes produiraient un retrait qui ne désigne rien, et le projet
garderait une entreprise que le Panel croit détachée.

Côté projet, l'identifiant d'écriture est **mémorisé** à l'application du
profil, jamais rederivé : rederiver dupliquerait un algorithme du Panel, qui
finirait par diverger.

## 11. Permissions

```text
LECTURE    tout compte authentifié du Panel
ÉCRITURE   comptes DEV et SUPER_ADMIN uniquement
PROJETS    aucune écriture, jamais — sens PANEL → PROJET exclusivement
```

La lecture est ouverte parce que savoir à qui l'on facture fait partie du travail
de gestion : la réserver aux comptes DEV ferait du développeur le seul à
connaître les clients de l'agence.

L'écriture est réservée non par hiérarchie, mais parce que ce qui est saisi
décide de l'identité portée par des FACTURES et des CONTRATS SIGNÉS.

## 12. Ne jamais confondre

```text
Project          une instance technique / un produit
ClientCompany    une entité juridique cliente
Contract         une relation contractuelle
Stripe Customer  une projection fournisseur de ClientCompany
PanelCompany     L.Y Solution
DEV_COMPANY      l'identité plateforme publiée au parc
CLIENT_COMPANY   l'identité juridique cliente publiée à UN projet
```

Ces notions se ressemblent et ne se remplacent jamais. Chaque fois qu'elles ont
été confondues, le résultat a été visible sur une pièce comptable.
