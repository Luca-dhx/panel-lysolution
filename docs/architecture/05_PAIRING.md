# 05 — L'appairage, de bout en bout

> Prérequis : [02_PROJECT_REGISTRY.md](02_PROJECT_REGISTRY.md),
> [03_PANEL_BRIDGE.md](03_PANEL_BRIDGE.md).
> Contrat : [../spec/PanelBridge.openapi.yaml](../spec/PanelBridge.openapi.yaml)
> (`POST /bridge/v1/pairings`, `DELETE /bridge/v1/pairings/current`).

L'appairage est le seul moment où le Panel et un projet échangent des
secrets. Il est **réversible, re-jouable, et jamais implicite**.

---

## 1. Le déroulé nominal

```
  NOUS (DEV, frontend Panel)          PANEL                       PROJET (Manager)
────────────────────────────────────────────────────────────────────────────────────
 1. déclarer le projet     ──▶  fiche DECLARED créée
    (projectKey, nom)           code d'appairage généré
                                • usage unique
                                • TTL 15 minutes
                                • affiché UNE fois
                                • stocké en hash
 2. copier le code  ─────────────────────────────────────▶  page « Connexion Panel »
                                                            saisir URL du Panel + code
                                                 ◀──────────  POST /bridge/v1/pairings
                                                              (BootstrapRequest)
 3.                             vérifications (§2)
                                bridgeToken généré (256 bits)
                                fiche → PAIRED
                                            ─────────────▶  201 { projectId,
                                                                  bridgeToken,
                                                                  panel {name, version} }
                                                            le projet stocke le token
                                                            chiffré, passe CONNECTED
```

Après le bootstrap, plus aucun secret ne circule : les heartbeats et la
synchronisation utilisent le bridgeToken.

## 2. Vérifications au bootstrap (dans cet ordre)

| # | Vérification | Refus |
|---|---|---|
| 1 | Version majeure du contrat compatible | `409 BRIDGE_CONTRACT_VERSION_UNSUPPORTED` |
| 2 | DTO `BootstrapRequest` conforme (miroir zod strict) | `400 BRIDGE_INVALID_PAYLOAD` |
| 3 | Le code correspond à une fiche du registre (hash), non expiré, non consommé | `401 BRIDGE_PAIRING_CODE_INVALID` |
| 4 | Le `projectKey` présenté est celui de la fiche liée au code | `401 BRIDGE_PAIRING_CODE_INVALID` (le refus ne précise pas lequel des deux est faux) |
| 5 | La fiche n'est pas déjà PAIRED | `409 BRIDGE_ALREADY_PAIRED` |
| 6 | Si un `manifest` est joint (contrat ≥ 1.1.0) : format valide **et** `project.key` = `projectKey` de la fiche | `400 BRIDGE_INVALID_PAYLOAD` |

L'étape 6 est délibérément placée **avant** la consommation du code : un
Manifest non conforme refuse le bootstrap sans griller le code d'appairage,
et le projet peut corriger puis réessayer.

Succès : le code est **consommé** (même en cas d'échec ultérieur du projet à
stocker son token — regénérer un code est trivial, réutiliser un code ne
l'est jamais), la fiche enregistre `runtime` (ENV, versions, URL publique
éventuelle), enregistre le Manifest reçu avec la source `BRIDGE`, et passe
PAIRED.

### 2.1 Le Manifest joint au bootstrap

Depuis le contrat **1.1.0**, le projet se présente complètement dès
l'appairage : le Panel n'a plus rien à déduire ni à ressaisir.

| Source du Manifest | Autorité | Conséquence |
|---|---|---|
| `BRIDGE` (bootstrap, ou `GET /manifest`) | **fait foi** | la saisie manuelle est ensuite **refusée** (`PANEL_MANIFEST_BRIDGE_AUTHORITATIVE`) |
| `MANUAL` (`PUT /api/projects/:id/manifest`) | secours | remplacée dès qu'un Manifest arrive par le pont |

Le champ `manifest` reste **optionnel** : un projet parlant encore un contrat
`1.0.x` s'appaire exactement comme avant, et son Manifest passe par le canal
manuel. Voir [20_MANAGER_STANDARD.md](20_MANAGER_STANDARD.md) §4.

## 3. Le code d'appairage

- Généré par le Panel à la déclaration du projet (ou regénéré à la demande
  tant que la fiche n'est pas PAIRED).
- **Usage unique, TTL 15 minutes** : un code qui traîne dans un chat ou un
  presse-papier meurt vite et ne sert qu'une fois.
- Format lisible (`PAIR-XXXX-XXXX-XXXX`, alphabet sans ambiguïté) : il est
  fait pour être recopié à la main entre deux écrans.
- Stocké **en hash SHA-256** ; affiché une seule fois, à sa génération.
- Le code n'est PAS un secret durable : il n'authentifie que le bootstrap.
  Le secret durable, c'est le bridgeToken qu'il permet d'obtenir.

## 4. La révocation (désappairage)

Trois chemins, un seul résultat — la fiche passe REVOKED, le hash du token
est effacé, toute requête portant l'ancien token répond `401` :

1. **Le projet se débranche** : `DELETE /bridge/v1/pairings/current` (avec
   son token). Réponse `{unpaired:true}` — idempotent du point de vue du
   projet.
2. **Le Panel révoque** : `DELETE /api/projects/:projectId/pairing`
   (action DEV, frontend). Par courtoisie, le Panel notifie le projet via
   `ProjectBridgeClient.notifyUnpair()` — best-effort : si le projet est
   injoignable, la révocation côté Panel reste acquise, et le projet
   constatera le 401 à son prochain appel puis passera STANDALONE de
   lui-même.
3. **Revente d'un projet** : cas 2 + suppression éventuelle de la fiche
   ([06_PROJECT_LIFECYCLE.md](06_PROJECT_LIFECYCLE.md) §5).

La révocation ferme **les deux sens** d'un coup (un seul secret d'appairage).
Elle n'affecte jamais les données du projet : tout ce qui était synchronisé
existe déjà chez lui.

## 5. Le ré-appairage

REVOKED → DECLARED : regénérer un code (action DEV), puis bootstrap normal.
Le projet reçoit un **nouveau** bridgeToken ; l'ancien reste mort. La fiche,
son historique et son Manifest sont conservés — le ré-appairage n'est pas une
re-création.

## 6. Stockage des secrets d'appairage

Deux représentations, deux usages, jamais de valeur en clair au repos :

| Représentation | Usage | Algorithme |
|---|---|---|
| **Hash** (`bridgeTokenHash`, `pairingCodeHash`) | vérification des requêtes **entrantes** | SHA-256, comparaison en **temps constant** |
| **Copie chiffrée** (`bridgeTokenEncrypted`) | appels **sortants** vers le projet | AES-256-GCM (`iv.tag.données`), clé maître `BRIDGE_ENCRYPTION_KEY` |

Règles vérifiées par `tests/persistence.test.js` et
`tests/architecture.test.js` :

1. le document Mongo ne contient **jamais** le token ni le code en clair ;
2. aucune API ne restitue un hash ni une valeur chiffrée — la projection
   publique d'un projet est nettoyée ;
3. le déchiffrement a **un seul point d'entrée nommé**
   (`getOutboundBridgeToken`), réservé au `ProjectBridgeClient` ;
4. la clé maître vient **exclusivement de l'environnement** — elle n'est
   jamais stockée en base, et le démarrage échoue si elle est absente,
   malformée, ou égale à `JWT_SECRET` ;
5. la révocation efface hash **et** copie chiffrée, de façon persistante.

Une rotation de `BRIDGE_ENCRYPTION_KEY` rend les copies chiffrées illisibles
et impose un ré-appairage du parc : procédure dans
[24_ENVIRONMENT_AND_DOMAINS.md](24_ENVIRONMENT_AND_DOMAINS.md) §8. La
rotation du bridgeToken lui-même (avec fenêtre de transition, comme le
`pairingStore` du projet modèle) reste un lot de Phase 3 ; la structure de
stockage actuelle ne s'y oppose pas.

## 7. Persistance

L'appairage est intégralement persisté en MongoDB (collection
`panelprojects`) : un code émis avant un redémarrage reste utilisable, un
bridgeToken continue d'authentifier, une révocation et une suppression
survivent. Le Panel ne repart jamais avec un parc vide après un
redémarrage — c'est vérifié par un test de redémarrage simulé.

## 8. Invariants

1. Un code = un projet = un usage. Jamais de code « générique ».
2. Le Panel ne peut réafficher ni un code (hash seul) ni un token (hash +
   copie chiffrée réservée au `ProjectBridgeClient`) : aucune API ne les
   restitue.
3. Le bootstrap n'est jamais initié par le Panel : c'est toujours le projet
   qui appelle (HTTPS sortant du projet).
4. Un échec d'appairage laisse le projet exactement dans son état antérieur —
   UNCONFIGURED/STANDALONE est un état normal, pas une erreur.
5. La duplication d'un projet ne copie jamais un appairage : chaque projet
   fait son propre bootstrap avec son propre code.
6. **L'environnement du projet doit concorder avec celui de sa FICHE** — pas
   avec celui de l'instance de Panel, qui peut différer. Voir §9.
7. **Un appairage = une fiche = une instance.** Voir §10.

## 10. Un appairage, une fiche, une instance

C'est la cardinalité que tout le reste du Panel suppose, et elle se lit mal
parce que le Manager et le Panel ne comptent pas la même chose.

```
MANAGER / SB AUTO                    PANEL (une FICHE = un environnement)

Projet SB Auto                       ┌── PanelProject — projectId · TEST
├── destination TEST  ───────────────┘   1 appairage · 1 destination
├── destination PROD                     1 état métier
└── … d'autres
                                     La production est une SECONDE fiche,
UN projet, N destinations.           avec son propre code et son propre jeton —
                                     sur ce Panel-ci ou sur un autre (§9).
```

```
1 fiche Panel = 1 appairage = 1 projet distant observé
              = 1 environnement = 1 destination = 1 état métier
```

Il n'y a **pas**, dans une fiche : deux destinations, un sélecteur TEST/PROD,
deux connexions, deux appairages, une « sœur » à sélectionner, ni une
destination à ajouter.

### Ce que l'appairage établit, et ce qu'il ne touche pas

L'appairage produit le `projectId` — **l'autorité absolue du périmètre
métier**. Toute projection reçue ensuite est indexée par lui, et par lui seul.

Il **réconcilie** aussi la clé technique de la fiche (`projectKey`) sur la
valeur que le projet annonce (`bridgeIdentity.projectKey`), sauf si une autre
fiche la détient déjà — l'index est unique. C'est de l'**anti-collision**, et
rien d'autre : cette clé ne détermine aucun périmètre métier, aucun
environnement, aucune destination, aucun écran.

**`logicalProjectKey` n'est plus écrit.** L'appairage le posait, pour
regrouper à l'écran la recette et la production d'un même client. Cette
écriture était sans emploi réel TANT QUE le contrôle de concordance
d'environnement interdisait à un Panel de recette d'appairer une instance de
production : deux « sœurs » ne pouvaient jamais coexister appairées dans le même
Panel. Depuis §9, elles le peuvent — mais le regroupement se lit désormais sur
l'environnement ÉPINGLÉ de chaque fiche, pas sur une clé logique dupliquée. Le
champ reste en base sur les fiches historiques ; plus rien ne l'écrit ni ne le
lit.

Aucun repli inter-fiche n'existe : quand une instance n'a pas de destination
active, on écrit « aucune destination active » — on n'emprunte jamais celle
d'une autre.

### Avant appairage, le Panel ne sait rien du projet

Une fiche déclarée mais non appairée rend `environment: null`,
`primaryDomain: null`, `urls: null` et `networkSource: 'NON_APPAIRE'`.
L'environnement saisi à la déclaration (`declaredEnvironment`) survit en base
pour départager deux clés techniques identiques — il ne s'affiche nulle part.

L'ordre des refus le reflète : la **concordance d'environnement est vérifiée
en premier**, avant même de discuter d'identifiants. Une production présentée
au Panel de recette annonce la même clé que la recette déjà enregistrée ;
buter d'abord sur « clé déjà prise » aurait nommé un détail d'index à la place
de la seule cause actionnable — une adresse de Panel recopiée d'un
environnement à l'autre.

### Ce que le manifeste d'appairage est, et n'est plus

Le manifeste est capturé **au bootstrap** et relu seulement sur action d'un
opérateur (`REFRESH_MANIFEST`, `DISCOVER_PROJECT`). C'est un **bootstrap**, un
**repli** et une **compatibilité** — jamais une source live.

`PROJECTION > MANIFEST > REGISTRY` pour tout champ disposant d'une projection
(nom, présentation, description, contacts, réseau). Un manifeste relu ne doit
jamais écraser une projection reçue.

→ `docs/ARCHITECTURE_CONTEXT.md` §1, §4bis, §4ter
→ `tests/project-company-live-e2e.test.js` · `tests/project-live-business-sync.test.js`

---

## 9. `PANEL_ENV` n'est pas `PROJECT_ENV`

> **UN PROJET EN PRODUCTION PEUT ÊTRE PILOTÉ PAR UN PANEL DE RECETTE.**
>
> Cela ne signifie **pas** « des fournisseurs de recette ». Pour une capacité
> exercée **pour un projet**, c'est le monde du **PROJET** qui décide.

Deux dimensions, indépendantes :

```
PANEL_ENV     le monde où tourne le PLAN DE CONTRÔLE   (config.env)
PROJECT_ENV   le monde où tourne le PROJET administré  (épinglé sur la fiche)
```

Elles étaient soudées par une égalité imposée au bootstrap. Administrer n'est
pas agir au nom de : la règle interdisait au plan de contrôle son métier —
piloter une production — pour se protéger d'un accident qui se traite
autrement.

### 9.1 Où l'environnement d'un projet est ancré

Sur la **fiche**, que le Panel écrit et que le projet ne touche jamais :

1. l'opérateur le **déclare** en créant le projet dans le Panel ;
2. à défaut, il est **épinglé au bootstrap** — le seul instant où le projet
   prouve son identité, par un code à usage unique émis pour cette fiche ;
3. ensuite **il ne bouge plus**. Aucun battement ne le déplace.

Le bootstrap compare donc l'environnement annoncé à celui de la **FICHE** :

| Projet annonce | Fiche enregistrée | Panel | Résultat |
|---|---|---|---|
| TEST | TEST | TEST | ✅ appairé |
| PROD | PROD | **TEST** | ✅ appairé — c'est la nouveauté |
| TEST | TEST | PROD | ✅ appairé |
| PROD | PROD | PROD | ✅ appairé |
| PROD | **TEST** | indifférent | ❌ `BRIDGE_ENVIRONMENT_MISMATCH` |
| TEST | **PROD** | indifférent | ❌ `BRIDGE_ENVIRONMENT_MISMATCH` |

Le refus d'origine **survit entièrement** : une production qui se présente avec
le code d'une fiche enregistrée en recette est toujours rejetée, et l'`.env`
recopié toujours attrapé. Seule la référence a changé.

Règles inchangées :

- **fail closed, dans les deux sens.** Aucune correction automatique :
  rapprocher TEST de PROD « pour que ça marche » produirait exactement
  l'accident qu'on empêche ;
- **le code n'est pas consommé** par ce refus. L'opérateur corrige son `.env`
  et rejoue le même code ;
- **on ne devine jamais depuis un nom de domaine.**
  `hostname.includes('test')` classerait la production de « Garage Test SARL »
  en recette. Les deux côtés le déclarent, et on compare ce qui est dit.

### 9.2 Pourquoi l'épingle, et pas l'annonce du battement

`runtime.environment` porte ce que le projet a annoncé à son **dernier
battement**. C'est une **observation** : elle vient du projet, sur un chemin que
le projet contrôle.

Tant que le bootstrap exigeait l'égalité avec `config.env`, s'y fier était sans
conséquence — un projet ne pouvait de toute façon vivre que dans le monde de son
Panel. **Cette contrainte levée, la même lecture devient un chemin
d'élévation** : un projet enregistré en recette annoncerait `PROD` au battement
suivant et repartirait avec les identifiants Stripe, Brevo et OpenSign du monde
réel. Un champ à changer.

D'où la séparation stricte, dans `services/registry/projectEnvironment.js` :

| Fonction | Rend | Fait autorité |
|---|---|---|
| `authoritativeEnvironmentOf(fiche)` | l'épingle | ✅ **oui** — c'est elle qui entre dans la résolution fournisseur |
| `observedEnvironmentOf(fiche)` | l'annonce du battement | ❌ constat, affichage, diagnostic |
| `environmentContradicted(fiche)` | les deux divergent | rend la contradiction visible plutôt que muette |

Une contradiction n'est pas ignorée en silence : elle est journalisée et remonte
à l'écran par `observedEnvironmentConflict`.

### 9.3 Ce que cela change pour les fournisseurs — rien

`resolveIntegratedApiEnvironment` rend `projectEnvironment ?? runtime` :

| Panel | Projet | Stripe / Brevo / OpenSign |
|---|---|---|
| TEST | TEST | **TEST** |
| TEST | PROD | **PROD** |
| PROD | TEST | **TEST** |
| PROD | PROD | **PROD** |

`PANEL_ENV` ne remplace **jamais** `PROJECT_ENV` pour une capacité de projet. Il
ne décide que pour les capacités que le Panel exerce **pour lui-même**, où son
monde est effectivement le sujet.

Un fournisseur à **compte unique** (`PANEL_GLOBAL`, ex. Hostinger) n'a pas de
monde : la réponse est `null`, dans les quatre cases. On ne lui invente pas un
TEST/PROD pour faire tenir un tableau.

### 9.4 La frontière qui subsiste — les données métier du Panel

Un Panel de recette **pilote** une production : battement, supervision, URLs,
génération, curseur, déploiement, capacités fournisseur. Tout fonctionne.

Il ne lui **livre pas** ses propres enregistrements métier — entreprise cliente,
mentions légales, contrat, équipe. Ceux-ci sont partitionnés par le monde du
Panel (`PanelClientCompany.environment = config.env`), et les livrer poserait
les mentions légales d'une entreprise de recette sur un site en production.

La livraison est donc refusée avec `DELIVERY_OUTCOME.ENVIRONMENT_MISMATCH`,
désormais de classe `SCOPE` et non plus `SECURITY` : ce n'est plus un incident,
c'est une frontière. Pour synchroniser aussi le métier, la fiche doit vivre sur
le Panel du même monde.

### 9.5 La doctrine mono-instance tombe

Une instance de Panel pouvait ne tenir que des fiches de son propre monde : deux
« sœurs » — la recette et la production d'un même client — ne pouvaient jamais
coexister appairées. Elles le peuvent, en deux fiches, chacune avec son jeton,
son monde épinglé et sa résolution fournisseur.

Vérifié par `tests/panel-instance-environment.test.js`.
