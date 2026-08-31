# 26 — L'import JSON d'un prospect

> La structure du fichier que l'équipe de qualification produit, et ce que le
> Panel en fait. **Ce document est la référence : il est fait pour être envoyé
> tel quel à qui remplit les fichiers.**

---

## 0. Le problème que ce lot supprime

Aujourd'hui, un rapport de qualification arrive sous forme de texte : lien de la
fiche Google, lien Instagram, nom de l'entreprise, coordonnées, sites des
concurrents, gabarits d'e-mail déjà remplis. Puis quelqu'un ouvre le Panel et
**resaisit tout à la main** — la fiche, les informations, l'accroche et la
relance dans l'onglet « communication », les tâches de rappel.

C'est le travail que l'import supprime. Le rapport reste utile pour être lu ;
le fichier JSON, lui, est fait pour être **avalé d'un clic**.

```text
 ÉQUIPE DE QUALIFICATION            PANEL
 ───────────────────────            ─────
 rapport (lecture humaine)   ──►    lu par vous
 fichier .json               ──►    Prospect ▸ Nouveau/Modifier ▸ « Importer un JSON »
                                    ▸ aperçu section par section
                                    ▸ validation
                                    ▸ fiche + messages + tâches + rendez-vous
```

Un seul fichier pose **quatre choses à la fois** :

| Ce que le fichier porte | Où ça atterrit dans le Panel |
|---|---|
| coordonnées, liens, informations, notes | la **fiche** du prospect |
| messages (accroche, relances) | l'onglet **Communication**, en « envoyé » ou « à envoyer » |
| tâches planifiées | l'**échéancier**, rattachées au prospect |
| rendez-vous | l'**agenda**, comme rendez-vous de prospect |

---

## 1. Les deux formes de fichier

### Une seule entreprise

```json
{
  "version": 1,
  "name": "Garage Leblanc",
  "email": "contact@garage-leblanc.fr"
}
```

### Une tournée entière — plusieurs entreprises

```json
{
  "version": 1,
  "prospects": [
    { "name": "Garage Leblanc", "email": "…" },
    { "name": "Boulangerie Martin", "email": "…" }
  ]
}
```

Un tableau nu (`[ { … }, { … } ]`) est accepté aussi.

> **L'import ne traite qu'UNE fiche à la fois.** Quand le fichier en contient
> plusieurs, l'écran fait choisir laquelle. C'est délibéré : la fenêtre
> d'import est ouverte depuis la fiche d'un prospect, et créer trente-neuf
> autres entreprises sans les avoir vues serait un import de masse déguisé en
> correction de fiche.

### La forme emboîtée

Les deux écritures suivantes sont équivalentes. Utilisez celle qui vous arrange.

```json
{ "name": "Garage Leblanc", "messages": [ … ], "tasks": [ … ] }
```

```json
{ "prospect": { "name": "Garage Leblanc" }, "messages": [ … ], "tasks": [ … ] }
```

---

## 2. Le squelette complet

Tout est **facultatif sauf `name`** — et `name` lui-même devient facultatif
quand on importe dans une fiche qui existe déjà.

```json
{
  "version": 1,

  "name": "Garage Leblanc",
  "email": "contact@garage-leblanc.fr",
  "phone": "04 91 00 00 00",
  "status": "en cours",
  "type": "refonte",
  "folderPath": "Garages / Marseille",
  "notes": "Vu depuis la route. Devanture refaite en 2025, site à l'abandon.",

  "websiteUrl": "garage-leblanc.fr",
  "googleUrl": "https://g.page/garage-leblanc",
  "instagram": "instagram.com/garageleblanc",

  "links": [
    { "label": "Dossier partagé", "url": "https://drive.exemple/…" }
  ],

  "competitors": [
    { "name": "Auto Sud", "url": "autosud.fr", "note": "Site refait en 2024, propre." }
  ],

  "infoFields": {
    "Budget annoncé": "3 000 €",
    "Qui décide": "M. Leblanc, gérant",
    "Hébergeur actuel": "OVH"
  },

  "messages": [
    {
      "channel": "E-mail",
      "title": "Accroche",
      "body": "Bonjour M. Leblanc,\n\nJ'ai vu votre garage…",
      "sentAt": "2026-08-20T09:00:00+02:00"
    },
    {
      "channel": "E-mail",
      "title": "Relance 1",
      "body": "Je reviens vers vous concernant…",
      "sent": false
    }
  ],

  "tasks": [
    {
      "name": "Rappeler le gérant",
      "description": "Il est joignable le matin.",
      "dueInDays": 3,
      "subtasks": [{ "name": "Préparer une estimation" }]
    }
  ],

  "meetings": [
    {
      "title": "Visite du garage",
      "scheduledAt": "2026-09-12T10:00:00+02:00",
      "durationMinutes": 45,
      "mode": "onsite",
      "address": "1 rue du Port, 13002 Marseille"
    }
  ]
}
```

---

## 3. La fiche — champ par champ

| Champ | Type | Effet |
|---|---|---|
| `name` | texte | Le nom de l'entreprise. **Obligatoire à la création.** |
| `email` | texte | Adresse de contact. Non vérifiée : on note ce qu'on a. |
| `phone` | texte | Téléphone, dans la forme qu'on veut. |
| `notes` | texte | Notes **internes**. Elles ne sortent jamais du Panel. |
| `status` | liste fermée | Où en est l'affaire — voir §3.1. |
| `type` | liste fermée | Conception ou refonte — voir §3.1. |
| `folderPath` | texte | Le rangement, `"Parent / Enfant"`. Créé s'il manque. |
| `folderId` | texte | L'identifiant du dossier, si vous l'avez. Prioritaire sur `folderPath`. |
| `links` | liste | Voir §3.2. |
| `competitors` | liste | Voir §3.3. |
| `infoFields` | liste **ou** dictionnaire | Voir §3.4. |
| `images` | liste | Voir §3.5 — restreint. |

> **Une clef absente ne touche à rien. Une clef présente et vide efface.**
> C'est la seule façon de retirer par import un téléphone erroné.

### 3.1 Statut et nature — écrivez en français

Le Panel stocke des constantes, mais le fichier peut employer les mots de
l'équipe. Casse, accents et espaces sont sans importance.

| Ce que vous écrivez | Ce que le Panel enregistre |
|---|---|
| `WAITING`, `à contacter`, `en attente`, `à faire`, `nouveau` | `WAITING` |
| `IN_PROGRESS`, `en cours`, `contacté`, `relancé` | `IN_PROGRESS` |
| `PLANNED`, `planifié`, `RDV`, `rendez-vous` | `PLANNED` |
| `LOST`, `perdu`, `refusé`, `sans suite` | `LOST` |
| `SIGNED`, `signé`, `gagné`, `client` | `SIGNED` |

| Ce que vous écrivez | Ce que le Panel enregistre |
|---|---|
| `CREATION`, `conception`, `nouveau site`, `sans site` | `CREATION` |
| `REDESIGN`, `refonte`, `site existant`, `avec site` | `REDESIGN` |

Une valeur hors liste **n'est pas ramenée au défaut** : elle est écartée et
signalée. Retomber silencieusement sur « conception » ferait passer une refonte
pour un site à créer — ce n'est ni le même devis, ni les mêmes questions au
premier rendez-vous.

### 3.2 Les liens — trois écritures acceptées

**Une colonne par réseau** — la plus simple depuis un tableur :

```json
{ "websiteUrl": "garage-leblanc.fr", "googleUrl": "https://g.page/x", "instagram": "instagram.com/x" }
```

Clefs reconnues (la casse, les tirets et les tirets bas sont ignorés) :

```text
website · site · siteWeb · siteUrl · websiteUrl · siteActuel
google · googleUrl · ficheGoogle · googleBusiness · googleBusinessUrl
googleMaps · maps · mapsUrl
instagram · facebook · linkedin · tiktok · youtube · x · twitter
tripadvisor · theFork · uberEats · deliveroo · pagesJaunes
```

**Un dictionnaire** — pour nommer librement :

```json
{ "links": { "Site officiel": "garage-leblanc.fr", "Dossier partagé": "https://…" } }
```

**Une liste** — la forme que le Panel exporte :

```json
{ "links": [{ "label": "Site officiel", "url": "https://garage-leblanc.fr/" }] }
```

Le préfixe `https://` est ajouté quand il manque : `garage-leblanc.fr` suffit.
Un lien `javascript:` ou `data:` est **refusé** — c'est la seule chose que
cette lecture protège vraiment.

### 3.3 Les concurrents

```json
{ "competitors": [{ "name": "Auto Sud", "url": "autosud.fr", "note": "Refait en 2024." }] }
```

Un concurrent devient **un lien** étiqueté `Concurrent — Auto Sud`, et sa note
devient **une information** du même nom. Le lien s'ouvre, la note se lit — et
il n'y a pas une troisième liste dont personne ne saurait qu'elle existe.

### 3.4 Les informations libres

C'est là qu'on note ce qui décide d'une affaire, et rien n'y est figé.

```json
{ "infoFields": { "Budget annoncé": "3 000 €", "Qui décide": "M. Leblanc" } }
```

ou

```json
{ "infoFields": [{ "label": "Budget annoncé", "value": "3 000 €" }] }
```

Une information **sans nom** est écartée : une valeur sans étiquette est
illisible pour quiconque relit la fiche. Cent informations au maximum.

### 3.5 Les images — la restriction à connaître

```json
{ "images": [{ "url": "/uploads/prospect/abc123.webp", "caption": "Devanture" }] }
```

**Seules les images déjà importées dans le Panel** (`/uploads/…`) peuvent être
citées. Une adresse externe est écartée, et le Panel n'ira pas la télécharger :
rapatrier un fichier depuis une adresse fournie par un tiers, c'est ouvrir une
porte vers le réseau interne. **Les photos s'importent par le formulaire**, qui
les réencode.

---

## 4. La communication — accroches et relances

```json
{
  "messages": [
    {
      "channel": "E-mail",
      "title": "Accroche",
      "body": "Bonjour M. Leblanc,\n\n…",
      "sentAt": "2026-08-20T09:00:00+02:00"
    },
    { "channel": "LinkedIn", "title": "Relance 1", "body": "…", "sent": false }
  ]
}
```

| Champ | Effet |
|---|---|
| `channel` | Texte **libre** : `E-mail`, `LinkedIn`, `SMS`, `au téléphone`, `via son associé`. Vaut `E-mail` si absent. |
| `title` | **Interne, jamais envoyé** : « Accroche », « Relance 1 », « après le rendez-vous ». C'est ce qui permet de retrouver le message. |
| `body` | Le texte qui part vraiment. Les retours à la ligne sont conservés tels quels. |
| `sentAt` | Date ISO 8601 → le message est **envoyé**. Absent → **à envoyer**. |
| `sent` | `true` / `false`, si vous n'avez pas la date. |
| `status` | `sent` / `envoyé` / `to_send` / `à envoyer`, même rôle que `sent`. |

**`sentAt` porte l'état à lui seul.** Un message avec une date est envoyé, un
message sans date est à envoyer, et l'onglet Communication les range dans ses
deux sous-onglets sur cette seule base.

Cas particuliers, tous signalés dans l'aperçu :

- `sent: true` **sans date** → la date de l'import est retenue ;
- date illisible → le message est noté « à envoyer », il n'est **pas** perdu ;
- une date **et** `sent: false` → la date gagne.

> **Rien n'est envoyé par le Panel.** L'onglet Communication est un carnet : on
> y écrit ce qu'on a dit et ce qu'on prévoit de dire. Aucun serveur de mail
> n'est appelé, ici pas plus qu'ailleurs.

Deux cents messages au maximum, vingt mille caractères chacun.

---

## 5. Les tâches planifiées

```json
{
  "tasks": [
    {
      "name": "Rappeler le gérant",
      "description": "Joignable le matin.",
      "dueInDays": 3,
      "subtasks": [{ "name": "Préparer une estimation" }]
    },
    { "name": "Envoyer la proposition", "dueAt": "2026-09-15T09:00:00+02:00" }
  ]
}
```

| Champ | Effet |
|---|---|
| `name` | **Obligatoire.** Une tâche sans intitulé est écartée. |
| `description` | Facultative. |
| `dueAt` | Échéance **absolue**, ISO 8601. |
| `dueInDays` | Échéance **relative** : nombre de jours à compter de l'import. |
| `subtasks` | Liste d'objets `{ "name": …, "done": false }`. |
| `status` / `done` | `done` / `fait` / `terminée` crée la tâche déjà faite. |

`dueInDays` est ce qui rend un **gabarit** réutilisable : « relancer sous trois
jours » ne s'écrit pas en date absolue quand on ne sait pas quel jour le fichier
sera importé. Sans échéance du tout, la tâche existe quand même — c'est un état
de plein droit, pas un oubli.

Les tâches importées sont **rattachées au prospect** : elles apparaissent dans
sa fiche et dans l'échéancier général.

---

## 6. Les rendez-vous

```json
{
  "meetings": [
    {
      "title": "Visite du garage",
      "scheduledAt": "2026-09-12T10:00:00+02:00",
      "durationMinutes": 45,
      "mode": "onsite",
      "address": "1 rue du Port, 13002 Marseille",
      "participants": [{ "name": "M. Leblanc", "type": "external", "phone": "04 91 …" }]
    }
  ]
}
```

| `mode` | Ce qui devient obligatoire |
|---|---|
| `onsite` (défaut) | `address` |
| `remote` + `remoteKind: "call"` | `phone` |
| `remote` + `remoteKind: "video"` | `meetingUrl` (https, ou `msteams:` / `zoommtg:` / `webex:`) |

Ces exigences ne sont pas propres à l'import : l'agenda du Panel les applique à
toute réunion. Un rendez-vous dont on ne sait ni où ni comment il se tient n'en
est pas un. Une entrée incomplète est **écartée et signalée**, elle n'emporte
pas le reste du fichier.

---

## 7. Les deux modes, et ce qu'un import ne détruit jamais

L'écran propose deux façons d'appliquer, quand on importe dans une fiche qui
existe déjà.

| Mode | Ce qu'il fait |
|---|---|
| **Compléter** (défaut) | Ajoute et corrige. Ce que le document ne mentionne pas **reste**. |
| **Remplacer** | Chaque section **citée** par le document devient exactement ce qu'il dit ; ce qu'elle contenait et qu'il ne reprend pas est retiré. |

Deux règles gouvernent les deux modes :

> **Une section absente du document n'est jamais touchée**, même en mode
> Remplacer. Sans cela, un fichier qui ne parle que des messages viderait les
> liens. Pour vider une liste, il faut l'écrire explicitement vide : `"links": []`.

> **Aucune tâche ni aucun rendez-vous n'est jamais supprimé**, quel que soit le
> mode. Ils appartiennent à l'agenda de l'équipe, pas à la fiche : un fichier
> réimporté sans sa colonne `tasks` aurait effacé la relance que quelqu'un avait
> notée à la main la veille — sans erreur, sans trace, et sans que personne ne
> s'en aperçoive avant l'échéance manquée.

### Les notes, seule exception

En mode **Compléter**, `notes` **s'ajoute** en fin de notes existantes, sous une
ligne `— Import du AAAA-MM-JJ —`, plutôt que d'écraser. Un rapport de
qualification apporte ce qu'il a appris ; il ne connaît pas ce que l'équipe
avait déjà noté. Un texte déjà présent n'est pas recopié une seconde fois.

En mode **Remplacer**, `notes` écrase — et l'aperçu montre l'ancien texte.

---

## 8. Réimporter le même fichier ne duplique rien

Un rapport corrigé est réimporté ; c'est le cas normal, pas l'accident. Le Panel
**rapproche** ce qu'il reçoit de ce que la fiche porte déjà :

| Section | Ce qui fait qu'un élément est « le même » |
|---|---|
| liens | l'adresse |
| informations | le nom du champ |
| images | le chemin |
| messages | le titre + le canal (à défaut : le début du contenu) |
| tâches | l'intitulé |
| rendez-vous | l'intitulé + la date |
| dossiers | le chemin |

Accents, casse et espaces multiples sont ignorés dans cette comparaison. Un
élément rapproché **garde son identifiant** : la ligne qu'on était en train de
modifier à l'écran ne saute pas.

Vous pouvez aussi porter un `id` explicite sur un lien, une information, une
image ou un message : il est alors prioritaire. C'est ce que fait le Panel
lui-même quand il exporte.

---

## 9. Ce qui est refusé, et ce qui est seulement écarté

**Deux refus seulement** — dans les deux cas, il n'y a rien à importer :

| Code | Quand |
|---|---|
| `PANEL_PROSPECT_IMPORT_INVALID` | le fichier ne contient pas un objet JSON |
| `PANEL_PROSPECT_IMPORT_NAME_REQUIRED` | aucun nom, et aucune fiche à compléter |

**Tout le reste est écarté élément par élément, et listé dans l'aperçu** sous
« non repris », avec son chemin et sa raison. Une colonne mal nommée, une date
illisible, un lien vide, une tâche sans intitulé : rien de tout cela ne fait
échouer les trente-neuf autres entreprises du fichier.

**Une clef inconnue n'est jamais devinée.** Elle n'est pas convertie en
information libre « au cas où » — le carnet se remplirait de `rowId`, `_source`
et `scrapedAt`, qu'il faudrait retirer un par un. Elle est signalée, pour que
**la source** soit corrigée : c'est la seule correction qui tienne quand le
fichier suivant arrive avec quarante entreprises.

### Bornes

| Quoi | Limite |
|---|---|
| taille du fichier | 1 Mo par requête |
| informations | 100 |
| messages | 200, 20 000 caractères chacun |
| profondeur d'un `folderPath` | 8 niveaux |
| liens, tâches, rendez-vous | non bornés, mais lus dans l'ordre du fichier |

---

## 10. Ce que fait l'écran

1. **Prospection ▸ Nouveau prospect** (ou **Modifier** sur une fiche), puis
   **« Importer un JSON »**, tout en haut du formulaire.
2. Choisir le fichier. S'il contient plusieurs entreprises, choisir laquelle.
3. Sur une fiche existante, choisir **Compléter** ou **Remplacer**.
4. Lire l'**aperçu** : section par section, ce qui est **ajouté** (vert), ce qui
   **change** avec sa valeur d'avant (orange), ce qui est **retiré** (rouge), et
   ce qui n'est pas repris.
5. Valider.

L'aperçu est calculé par le serveur contre l'état **réel** de la fiche, et
**rien n'est écrit avant la validation** — pas même un dossier manquant.

> **L'import écrit directement.** Il ne pré-remplit pas le formulaire : les
> tâches vivent dans une autre collection, les rendez-vous dans l'agenda, et les
> messages ne sont pas dans ce formulaire du tout. Une fiche ouverte en
> correction, modifiée **sans enregistrer**, puis importée, perd les
> modifications non enregistrées. Enregistrez d'abord, importez ensuite.

---

## 11. Les deux adresses de l'API

| Méthode | Adresse | Effet |
|---|---|---|
| `POST` | `/api/prospects/import/preview` | calcule le plan. **N'écrit rien.** |
| `POST` | `/api/prospects/import` | applique. |

```json
{ "document": { … }, "prospectId": "…ou null", "mode": "MERGE" }
```

Deux adresses plutôt qu'un drapeau `dryRun` : une faute de frappe dans le corps,
un client qui oublie le drapeau, et l'aperçu écrirait. Deux adresses rendent la
distinction visible dans le journal d'accès et infranchissable par accident.

**Le plan renvoyé par l'aperçu n'est jamais renvoyé au serveur** : l'écriture le
recalcule. Une confirmation autorise une écriture, elle ne la transporte pas —
et entre l'aperçu et le clic, un autre poste a pu toucher la fiche.

Lecture et écriture sont ouvertes à **tout compte du Panel**, ADMIN comme DEV.
C'est la même règle que le reste de la prospection : un prospect n'engage rien,
il ne facture pas, il ne signe pas. Réserver cette surface aux comptes
développeurs aurait fait du développeur le seul à pouvoir importer un rapport.

---

## 12. Où vit le code

| Fichier | Rôle |
|---|---|
| `backend/src/services/prospection/prospectImport.contract.js` | la **lecture pure** du document : synonymes, normalisation, ce qui est écarté. Aucune base de données. |
| `backend/src/services/prospection/prospectImport.service.js` | le **plan** et l'**écriture** : rapprochement, dossiers, trois collections. |
| `backend/src/routes/prospects.routes.js` | les deux adresses. |
| `frontend/src/components/prospection/ProspectImportDialog.tsx` | le dialogue et l'aperçu. |
| `tests/prospect-import.test.js` | la recette — notamment l'idempotence et ce qui n'est jamais détruit. |

Un exemple complet et commenté vit dans
[`exemples/prospect-import.exemple.json`](exemples/prospect-import.exemple.json) :
c'est le fichier à donner comme gabarit à l'équipe de qualification.
