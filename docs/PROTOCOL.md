# Protocole d'exploitation — Panel L.Y Solution

Ce document est le **runbook** du Panel : ce qu'on fait, dans quel ordre, et ce
qu'on vérifie. Il décrit le runtime **actuel**, pas une intention.

Son pendant côté projet est `SB Auto 06/docs/PROTOCOL.md`. Quand une procédure
traverse les deux systèmes — appairage, nouveau modèle d'e-mail, déploiement —
elle est écrite **ici**, et le projet y renvoie : deux copies d'une procédure
divergent, et c'est toujours celle qu'on ne lit pas qui reste juste.

---

## Autorités — qui décide de quoi

| Domaine | Autorité | Le reste du monde |
|---|---|---|
| Existence d'un `templateCode`, ses variables, ses portées | **Panel** (code-first) | un code absent du registre n'existe pas |
| Contenu d'un modèle (sujet, HTML, versions) | **Panel** (base, par portée) | le projet ne stocke plus de contenu |
| **Usage** : quels modèles un projet consomme | **le PROJET** (déclaré) | le Panel s'y conforme, il ne devine pas |
| Credentials fournisseur (Stripe, Brevo, Yousign, Hostinger) | **Panel** | le projet invoque des capacités, jamais une clé |
| Identité et contrat d'un projet | **le projet** | le Panel en détient une projection |
| Accessibilité d'un site | **le projet** | le Panel pousse des *causes*, jamais un ordre |
| Politique de grâce d'un impayé | **Panel** | le projet affiche |
| **Adresse de contact public** du prestataire | **Panel** (`PanelCompany.contacts.publicContactEmail`) | le projet la reçoit publiée, il ne la devine plus |
| Expéditeur `From` du parc | **Panel** (`SystemConfiguration`) | c'est une adresse TECHNIQUE, jamais un contact |

La phrase à retenir, et elle vaut pour tout le lot e-mail :

> **Le Panel connaît ce qu'un projet utilise parce que le projet le déclare, pas
> parce que le Panel le devine.**


### Trois adresses e-mail, trois métiers — ne jamais les confondre

Elles se ressemblent, elles se remplacent facilement dans une tête, et aucune
des trois ne peut jouer le rôle d'une autre.

| Adresse | Où elle vit | À quoi elle sert | Écran |
|---|---|---|---|
| **Expéditeur** (`From`) | `SystemConfiguration` | l'en-tête sous lequel TOUT le parc écrit. Peut être une boîte technique que personne ne relève. | « Expéditeur e-mail » |
| **Contact public** | `PanelCompany.contacts.publicContactEmail` | l'adresse que le pied de chaque e-mail client invite à écrire. Doit aboutir à un humain. | « Expéditeur e-mail » (même écran, carte dédiée) |
| **Certificats** | `PanelCompany.contacts.supportEmail` | transmise à Let's Encrypt pour les alertes d'expiration. De l'exploitation, jamais du client. | « Mon entreprise » |

**Le contact public était DÉDUIT.** Jusqu'à ce lot, les projets balayaient
`references[]` — la liste de liens de l'agence — et retenaient la première
valeur qui ressemblait à une adresse. Le contact de tous les clients dépendait
donc de l'ORDRE d'une liste que l'opérateur réorganise pour des raisons
d'affichage. Une donnée que personne ne peut ni voir ni choisir n'est pas une
configuration : c'est un effet de bord.

**Répliques interdites.** Aucune de ces adresses ne doit jamais servir de repli
au contact public : l'expéditeur du parc, `contacts.email` (administratif),
`contacts.supportEmail` (Let's Encrypt), l'adresse d'un compte SUPER_ADMIN, une
variable d'environnement d'un projet, un réglage local d'un Manager. Absente,
elle vaut `null` et le projet REFUSE d'envoyer plutôt que d'inventer.

**Propagation.** La valeur voyage dans le bloc `contacts` déjà publié par
`DEV_COMPANY` : aucun `templateCode` nouveau, aucun provisionnement par projet.
Enregistrer publie une version ; les projets appairés l'appliquent dans la
foulée, sans redéploiement ni réappairage. Un projet fraîchement appairé la
reçoit du premier coup.

**Migration.** `npm run migrate:public-contact-email` (`-- --dry-run` pour
simuler) reprend la première adresse des références — celle qui servait déjà à
cet usage. Sans référence e-mail, le champ reste VIDE : remplir à la place de
l'opérateur publierait au nom de son entreprise une adresse que personne n'a
choisie.

---

## Environnements

Le Panel sert **un seul monde à la fois**, choisi par `ENV` :

```env
ENV=TEST            # TEST ou PROD
MONGODB_URI=...     # un cluster, deux bases
DB_TEST=panel_test
DB_PROD=panel_prod
```

Le monde décide de la **clé** fournisseur et de l'**expéditeur**. Il ne décide
jamais du **contenu** d'un modèle : un texte qui diffère entre TEST et PROD
signifie qu'on ne relit jamais ce qu'on expédie.

---

## Démarrage

`npm start` (ou PM2). L'ordre compte, et il est le suivant :

```text
1. port ouvert                      les routes métier répondent 503 SERVICE_STARTING
2. MongoDB
3. coffre IntegratedAPI             amorçage des jeux d'identifiants
4. modèles d'e-mail                 backfill de portée → amorçage PANEL → filet PROJET
5. URL publique                     résolue depuis SystemConfiguration
6. migrations d'agenda              héritées, idempotentes
7. ordonnanceurs                    échéances, coûts récurrents
8. PRÊT
```

**Le point 4 en détail** — les trois passages ne sont pas interchangeables :

| # | Passage | Rôle |
|---|---|---|
| 1 | `backfillScopeTypes()` | pose `scopeType` sur les documents antérieurs à L11.1 |
| 2 | `seedPanelTemplates()` | complète le contenu de portée `PANEL` |
| 3 | `reconcileProjectTemplates()` | **filet** : relit les déclarations reçues et repose ce qui manque |

Sans (1), (2) ne retrouve pas les documents hérités, tente de les recréer, et
heurte l'index unique. Le (3) ne parcourt **pas** le parc : il ne lit que les
déclarations, donc son coût est proportionnel à l'usage réel.

Aucun des trois n'est bloquant : un Panel dont les modèles ne sont pas amorcés
démarre quand même, et le refus qui en découle est explicite.

---

## Readiness

`GET /health` — sans authentification.

```json
{"status":"ok","service":"panel-backend","env":"TEST","database":"connected"}
```

`degraded` avec `database: disconnected` signifie que le processus vit mais que
rien de métier ne répondra. Ce n'est pas un incident de code : c'est la base.

---

## Extinction

`SIGTERM` → drainage. Les écritures en cours finissent, les ordonnanceurs
s'arrêtent, la base se ferme en dernier. Une projection interrompue n'est pas
perdue : elle est reconstruite au démarrage suivant.

---

## Appairer un projet

Procédure complète, dans l'ordre :

```text
1. DÉCLARER      le projet au registre           POST /api/projects (ou declareProject)
                 → rend un pairingCode à durée limitée
2. IDENTITÉ      le projet connaît son URL publique et sa clé
3. APPAIRER      le projet appelle POST /bridge/v1/pairings avec le code
                 → le Panel rend un bridgeToken, stocké chiffré des deux côtés
4. CONTRAT       les deux annoncent leur CONTRACT_VERSION (en-tête x-bridge-contract-version)
5. PROJECTIONS   le projet pousse sa photographie complète (reconcileAll) :
                    PROJECT_PRESENTATION · CONTRACT · PROJECT_SITE_STATUS
                    PROJECT_EMAIL_TEMPLATE_USAGE   ← la déclaration d'usage
6. RÉCONCILIATION  le Panel provisionne les instances de modèles déclarées,
                 dans le traitement même de la réception
7. HEARTBEAT     toutes les 60 s ; la fiche projet porte l'état runtime
8. VÉRIFIER      /api/projects → pairing PAIRED, runtime.lastHeartbeatAt récent,
                 écran « Modèles d'e-mail » → portée du projet → N modèles utilisés
```

**Le point 5 est ce qui rend l'appairage suffisant.** Aucune étape manuelle
n'existe entre « le projet est appairé » et « ses e-mails fonctionnent » : la
déclaration voyage avec le reste de son état.

---

## Dupliquer un projet

> **La duplication ne provisionne aucun modèle d'e-mail.** Elle n'en connaît
> même pas l'existence, et une garde de test le vérifie.

```text
1. cloner        identité, configuration, apparence, contenu
2. renommer      le projet est un AUTRE projet — nouvelle identité
3. appairer      procédure ci-dessus
4. démarrer      le runtime déclare l'usage de son code
5. réconcilier   le Panel pose les instances — automatique
```

Le clone consomme le même code que son modèle d'origine : il déclare donc la
même liste, et obtient les mêmes modèles. Sans qu'aucun code de duplication
n'ait à savoir qu'il existe des e-mails.

---

## NOUVEAU MODÈLE D'E-MAIL — protocole

> **Un nouveau `templateCode` exige un redéploiement du Panel.** C'est le seul
> cas, et il n'y en a pas d'autre.

Pourquoi : le registre est code-first et **plateforme**. Un Panel déployé qui ne
connaît pas un code ne peut ni le valider, ni le rendre, ni décider de sa portée.
Un projet qui le déclare recevra `unknown` — proprement, sans casser le reste.

```text
 1. CHOISIR   un templateCode STABLE (il voyage dans les journaux pour toujours)
 2. PORTÉE    PANEL (communication de L.Y Solution) ou PROJECT (celle du client) ?
              La question est « QUI PARLE À QUI », jamais « d'où viennent les
              variables ». Un incident technique déclenché par un projet reste
              PANEL : son destinataire est un développeur.
 3. PANEL     déclarer la définition   panelEmailTemplateDefinitions.js
              déclarer le contrat      panelEmailTemplateRegistry.js (variables + HTML)
 4. PROJET    si PROJECT : déclarer le même contrat côté projet (parité gardée)
              brancher le consommateur — action d'événement, ou appel direct
              recensé dans projectEmailTemplateUsage.js
 5. TESTS     npm run test:template-declaration      (Panel)
              npm run test:template-usage            (projet — parité des portées)
              la liste nominative de brevo-send-template-foundation
 6. DÉPLOYER  le PANEL D'ABORD                       ← l'ordre n'est pas négociable
 7. VÉRIFIER  le registre du Panel déployé connaît le code
 8. DÉPLOYER  le projet
 9. VÉRIFIER  la déclaration reçue porte le nouveau code, et unknown = 0
10. RECETTE   envoi réel TEST, destinataires sûrs
11. CLEANUP   artefacts d'envoi de recette
12. PROD      selon le protocole de déploiement
```

**Si l'ordre est inversé** (projet avant Panel), rien ne casse : le code est
rapporté `unknown` sur la déclaration, les autres modèles fonctionnent, et le
déploiement du Panel résout la situation sans intervention.

---

## UTILISER UN MODÈLE EXISTANT dans un projet

> **Aucun redéploiement du Panel.**

```text
1. brancher le consommateur dans le projet (action d'événement ou appel direct)
2. le registre d'usage le détecte — il est DÉRIVÉ, rien à écrire à la main
3. déployer le PROJET seulement
4. au démarrage, le projet déclare ; le Panel provisionne dans la foulée
5. vérifier : écran Modèles d'e-mail → portée du projet → le modèle est actif
```

---

## RETIRER un modèle d'un projet

```text
1. supprimer le consommateur (ou désactiver l'action)
2. la déclaration change au prochain démarrage du projet
3. le Panel retire le code de la vue ACTIVE du projet
4. l'instance et TOUT son historique RESTENT en base
5. l'envoi de ce code est désormais refusé : EMAIL_TEMPLATE_NOT_DECLARED_BY_PROJECT
```

**Aucune suppression Mongo manuelle, jamais.** Si le projet réutilise ce modèle
plus tard, il retrouve **son** contenu et **sa** version — c'est la raison
d'être de la conservation.

### Compter les modèles d'un projet — `declared`, jamais `enabled`

Conséquence directe de la conservation : **le nombre d'instances stockées est
supérieur ou égal au nombre de modèles actifs**, et l'écart est exactement
l'historique. Compter les lignes de `PanelEmailTemplate` annonce donc une dérive
à chaque contenu conservé.

Deux drapeaux coexistent sur une instance, et ils ne répondent pas à la même
question :

| champ | question | décide de |
|---|---|---|
| `enabled` | « cet e-mail part-il ? » | l'**interrupteur d'envoi** |
| `declared` | « le projet le demande-t-il ? » | l'**appartenance à la vue active** |

Ils sont **orthogonaux**. Un modèle déclaré dont l'envoi est coupé reste actif ;
un modèle retiré de la déclaration sort de l'actif sans que son interrupteur
bouge. Les confondre donne un compte juste par accident — tant que personne n'a
coupé un envoi ni retiré un code.

```text
modèles ACTIFS      = items de la vue avec declared === true
modèles HISTORIQUES = declared === false  &&  configured === true
instances stockées  = ACTIFS + HISTORIQUES
```

`declared: null` signifie « aucune déclaration reçue » — aucune opinion, donc
catalogue complet. Ce n'est pas « zéro déclaré ».

**Une instance conservée n'est pas un usage.** Un code dont la seule action est
`enabled: false` a une définition au Panel, souvent une instance chez le projet,
et n'est légitimement **pas** déclaré.

---

## Règle de redéploiement du Panel

```text
templateCode CONNU + nouvel usage par un projet   →  AUCUN redéploiement Panel
nouveau templateCode / nouveau contrat de variables →  REDÉPLOIEMENT PANEL REQUIS
```

Fonctionnent **immédiatement**, sans toucher au Panel : nouveau projet,
duplication, appairage, ré-appairage, adoption d'un modèle existant, retrait,
réactivation, édition de contenu depuis l'éditeur.

---

## Incident — « aucun modèle n'est configuré pour cette portée »

`CAPABILITY_NOT_AVAILABLE`, raison `EMAIL_TEMPLATE_NOT_CONFIGURED`.

```text
1. le projet a-t-il déclaré ?     écran Modèles → sélecteur de portée
                                  « jamais déclaré » ≠ « zéro modèle »
2. si non   → le projet n'a pas démarré depuis le lot, ou son pont est coupé
3. si oui   → npm run migrate:email-template-provisioning -- --dry-run
              puis sans --dry-run
4. redémarrer le Panel suffit aussi : le filet repose ce qui manque
```

## Incident — « le projet ne déclare pas utiliser ce modèle »

`EMAIL_TEMPLATE_NOT_DECLARED_BY_PROJECT`. **La correction est dans le projet**,
pas dans le Panel : un chemin métier appelle un modèle que le projet a cessé de
déclarer. Soit on rebranche le consommateur, soit on retire l'appel.

## Incident — un code déclaré est `unknown`

Le projet a été déployé avant le Panel. Déployer le Panel ; rien d'autre à faire.

---

## Migrations

Elles vivent dans `backend/src/scripts/migrations/`, portent leur date, et sont
**idempotentes**. Toutes acceptent `--dry-run`, qui n'écrit rien et rapporte.

```bash
npm run migrate:email-template-provisioning -- --dry-run
npm run migrate:email-template-provisioning
```

Une migration qui existe aussi au démarrage (c'est le cas de celle-ci) sert à
réparer **sans redémarrer** : Panel en service, base restaurée, ou simplement
pour lire le rapport avant d'écrire.

---

## Déploiement

Le moteur de déploiement du Panel est le même que celui des projets. On ne
remplace jamais une procédure officielle par un script SSH improvisé.

Ordre lorsqu'un lot touche le contrat du pont :

```text
1. PANEL         d'abord — il porte le contrat et le registre
2. readiness     /health → ok, database connected
3. vérifier      migrations et réconciliation dans le journal de démarrage
4. PROJETS       ensuite
5. readiness     /health de chaque projet
6. vérifier      appairage, heartbeat, déclaration reçue
```

---

## Recettes TEST et cleanup

Toute recette qui écrit dans `panel_test` doit :

```text
· marquer ses objets    (un identifiant de run dans les libellés)
· relever un inventaire AVANT
· nettoyer APRÈS        artefacts d'envoi, opérations de capacité, événements
· CONSERVER             corrections produit : déclarations, instances, migrations
· prouver               inventaire APRÈS = AVANT + différences produit voulues
```

⚠️ `panel_test` est la base du Panel **réellement utilisé**. Une recette y écrit
comme en exploitation : discipline d'intervention, pas de bac à sable.

---

## TEST DATABASE ISOLATION / LIVE RECIPE POLICY

### L'incident fondateur

Sept projets ont vécu quatre jours dans `panel_test` sans que personne les
remarque : `Garage UI`, `Jamais appairé`, `projet-a`, `projet-b`,
`projet-declare`, `projet-revoque`, `Garage Fédéré`. Ils venaient de trois
suites automatisées, apparus en une trentaine de secondes le 15 août.

Dans l'écran des projets, **rien ne les distinguait d'un vrai client**. Ils
comptaient dans le registre, apparaissaient dans les portées de modèles
d'e-mail, et le premier tri par date les mêlait aux projets réels.

La cause n'était pas un nettoyage oublié. C'était une **adresse autorisée** :

```text
tests/helpers/harness.js
  process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017'
  process.env.DB_TEST     = 'panel_test'
                             ▲
                             └── le nom de la base PARTAGÉE, écrit en dur
```

`PANEL_SKIP_DOTENV=1` empêche de lire le **fichier** `.env`. Il ne fait rien
contre une `MONGODB_URI` déjà exportée par le shell ou héritée d'un processus
parent qui, lui, avait chargé ce fichier. Il suffisait de cette fuite.

Un cleanup seul n'aurait rien réglé : il aurait fallu le refaire au run suivant.

### La règle

> **Une suite automatisée ne joint qu'une base de BOUCLE LOCALE.**

Elle est **géographique, pas nominative**. On n'interdit pas *un* cluster : on
interdit *tout ce qui n'est pas local*. Nommer le cluster d'aujourd'hui
laisserait passer celui de demain ; la règle géographique couvre les clusters
qui n'existent pas encore.

```text
processus de test  +  hôte de boucle locale     → AUTORISÉ   (BASE_ISOLEE)
processus de test  +  hôte distant              → REFUS      (SHARED_DATABASE_FORBIDDEN_IN_TESTS)
processus de test  +  distant + opt-in explicite→ AUTORISÉ   (RECETTE_LIVE_EXPLICITE)
n'importe qui      +  opt-in + ENV=PROD         → REFUS      (LIVE_RECIPE_FORBIDDEN_IN_PROD)
runtime réel       +  n'importe quel hôte       → AUTORISÉ   (RUNTIME)
```

Le verrou vit dans `backend/src/config/testDatabaseGuard.js` et se pose dans
`connectDatabase()`, **avant** `mongoose.connect()` — refuser après avoir ouvert
ne refuse rien. Il est là et non dans le harnais parce qu'une suite peut se
connecter sans passer par le harnais : c'est précisément ce qui s'est produit.

Un serveur en mémoire écoute sur un port éphémère de `127.0.0.1` : il est couvert
sans qu'on ait à le reconnaître spécifiquement.

### Reconnaître un processus de test

C'est le **suffixe du fichier** qui tranche, jamais son dossier :

```text
*.test.js  *.check.mjs  *.spec.js        → suite
un chemin traversant  tests/             → suite
PANEL_TEST_PROCESS=1                     → suite (marque héritée par les enfants)
NODE_ENV=test                            → suite

src/scripts/migrations/*.js              → PAS une suite
src/scripts/panel-accounts-bootstrap.js  → PAS une suite
src/server.js                            → PAS une suite
```

`src/scripts/` n'est pas un critère : on y trouve aussi bien des suites que des
migrations et des amorçages, qui ont **légitimement** besoin de la vraie base.

Le harnais pose `PANEL_TEST_PROCESS=1` pour que les serveurs qu'une recette
démarre en enfant héritent de l'interdit — sans quoi un simple `spawn` le
contournerait.

### La recette live

Une recette qui doit **vraiment** écrire dans l'environnement partagé reste
possible. Son autorisation est une phrase qu'on ne tape pas par distraction :

```bash
PANEL_LIVE_RECIPE=ECRITURE-ASSUMEE-SUR-BASE-PARTAGEE node ma-recette.js
```

Exacte, casse comprise. Une valeur approchante — `1`, `true`, `oui`, la même
en minuscules — **ne vaut pas autorisation**.

Elle reste soumise à la discipline de la section précédente : marquer, relever
avant, nettoyer après, prouver.

### PROD n'est jamais une cible

Aucune combinaison de variables n'autorise une recette automatisée sur `panel_prod`.
Le contrôle précède tous les autres dans le garde, y compris la sortie
« runtime » : il ne peut être court-circuité par aucune branche.

`ENV=PROD` suffit à refuser, même si le drapeau `isProd` a été mal calculé — les
deux sont vérifiés, parce qu'un seul des deux pourrait mentir.

### Cleanup partiel — que faire

Le nettoyage supprime **les dépendances d'abord, la racine en dernier**. Si
l'opération s'interrompt, ce qui reste est un projet dont les satellites ont
disparu : visible dans le registre, et le rejouer termine le travail. L'ordre
inverse laisserait des orphelins que plus rien ne désigne.

L'opération est **idempotente** : un second passage trouve 0 élément et réussit.

### Procédure de récupération

Si des fixtures sont à nouveau retrouvées dans `panel_test` :

```text
1. NE PAS supprimer sur un motif       ni par date, ni par « contient test »
2. Relever les identifiants exacts     projectId, _id, clé, URL, nom
3. Prouver la provenance               remonter à la suite et à la fabrique
   PROVEN_TEST_FIXTURE                 correspondance nom + URL + statut + date
   LEGITIMATE                          ne pas toucher
   UNKNOWN                             NE PAS SUPPRIMER — rapporter
4. Clôture transitive                  balayer TOUTES les collections, et
                                       recommencer avec les identifiants des
                                       documents trouvés jusqu'à point fixe
5. Écarter les jetons PARTAGÉS         un `templateCode` appartient au parc, pas
                                       à la fixture : l'inclure aspirerait les
                                       définitions globales
6. Dry run obligatoire                 identifiants exacts, comptes par collection
7. Garde-fou d'abandon                 si le plan touche un projet protégé →
                                       ABANDON TOTAL, jamais « le reste »
8. Supprimer par _id                   jamais par requête
9. Prouver l'absence résiduelle        rechercher chaque identité dans toutes
                                       les collections
10. Prouver la non-régression          sur le runtime, pas seulement en base
```

**Une instance de projet n'est pas une définition globale.** Un modèle
`scopeType=PROJECT` porte un `projectId` et meurt avec son projet ; un modèle
`scopeType=PANEL` a `projectId` à `null` et **survit à tous les projets**.
Supprimer le second parce qu'une fixture le référençait priverait le parc entier
d'un modèle.

⚠️ Le champ est stocké à `null`, pas absent : `{ projectId: { $exists: false } }`
n'en trouve **aucun**. Compter les définitions globales avec cette requête donne
zéro et laisse croire qu'on n'en conserve pas.

---

## Gardes PROD

```text
· ENV=PROD                    aucune recette destructive
· aucune clé fournisseur      dans un dépôt, un journal ou un payload
· aucun contenu de modèle     poussé par un projet (le pont refuse le champ)
· portée jamais dans un corps de requête   (assertNoScopeInBody)
· suppression en masse        réservée aux comptes DEV, confirmation retapée
```

---

## Familles de tests

```bash
npm test                          # la chaîne complète

npm run test:template-declaration # déclaration vivante : le cœur du lot e-mail
npm run test:template-provisioning# primitive de pose, backfill, portées
npm run test:capabilities         # passerelle de capacités
npm run test:bridge-conformity    # le miroir de contrat ↔ les specs OpenAPI
npm run test:architecture         # aucune logique spécifique à un client
npm run test:finance              # registre financier
```

Une suite qui **pose elle-même** son décor ne prouve pas que le décor se pose
tout seul. C'est la leçon du lot précédent : onze documents sans portée et zéro
instance de projet, avec toutes les suites au vert.

Et une suite qui pose son décor **au mauvais endroit** ne se contente pas d'être
fausse : elle abîme le parc. `tests/test-database-isolation.test.js` ouvre la
chaîne — placée avant tout le reste, parce que si l'adressage est faux, ce qui
suit ne prouve rien de fiable. Voir *TEST DATABASE ISOLATION / LIVE RECIPE
POLICY* plus haut.

Le fichier `tests/run-all.js` énumère les suites **explicitement**. Une suite
présente sur le disque mais absente de cette liste est verte par omission : elle
ne s'exécute jamais et personne ne s'en aperçoit. Ajouter un fichier de test
n'est pas terminé tant qu'il n'y figure pas.

---

## PROJECT RUNTIME URL SYNCHRONIZATION

*(contrat de pont **1.9.0** — additif, rétrocompatible)*

### La source de vérité

L'adresse publique d'un projet appartient **au projet**, et à une seule de ses
tables :

```
SystemConfiguration.network.{backendUrl, websiteUrl, managerUrl}
```

C'est la configuration que son déploiement écrit et que son runtime applique.
Le Panel ne la calcule jamais, ne la devine jamais, ne la recompose jamais.

Ce qui n'est **jamais** une source : `APP_URL`, une variable d'ambiance, la
boucle locale, un domaine historique, ou une concaténation « base + chemin »
faite côté Panel. Un audit antérieur a retiré ces dépendances ; les
réintroduire en filet ferait renaître le défaut sous un autre nom.

### L'invariant : appairage ≠ état courant

```
APPAIRAGE      une relation d'IDENTITÉ et de CONFIANCE
URL PUBLIQUE   un ÉTAT COURANT du projet
```

Les deux n'ont pas le même cycle de vie. **Une adresse n'est jamais immuable
parce qu'elle existait au moment de l'appairage**, et un lien de confiance n'a
pas à être refait parce qu'une adresse a changé.

C'est précisément ce que le comportement antérieur supposait :
`PanelProject.runtime.publicBackendUrl` était écrite au bootstrap et **plus
jamais relue**. Constaté sur le Panel TEST : la fiche annonçait encore
`https://api.demo-sbauto.lycarz.com` — figée à l'appairage du 2026-08-04 —
alors que le projet servait `https://api.demo-sbauto06.ly-solution.com` et le
déclarait correctement. La seule correction possible était un **réappairage**,
c'est-à-dire détruire une relation de confiance pour rafraîchir une donnée
d'exploitation.

### Deux adresses, et il ne faut jamais les confondre

C'est le point sur lequel ce lot s'est d'abord trompé, et la leçon mérite d'être
écrite avant tout le reste :

```
runtime.publicBackendUrl        OPÉRATIONNELLE  « je réponds ICI, maintenant »
PROJECT_PRESENTATION.network    DÉCLARATIVE     « je vise CE domaine »
```

En production les deux coïncident — ce qui rend la confusion facile et son effet
**invisible**. Elles divergent dès que le réel s'en mêle : une instance servie
sur un port éphémère, une recette locale, un déploiement dont le DNS n'a pas
encore basculé. La projection annonce alors un domaine parfaitement exact **où
personne n'écoute encore**.

Faire écrire `publicBackendUrl` par la projection paraissait pourtant évident :
elle porte l'adresse du backend, elle arrive à chaque changement, et elle
profiterait même aux projets restés en 1.8. Le raccourci a été écrit — et le
parcours fédéré de bout en bout l'a arrêté net : le Panel s'est mis à rappeler
le domaine déclaré au lieu du port réel, et a conclu que le projet était tombé.
`pairing.service.js` documentait déjà exactement ce piège.

**La règle qui en découle :** seules des sources **opérationnelles** écrivent
`runtime.publicBackendUrl`. La projection, elle, alimente la **destination** —
le seul endroit où une adresse *visée* a un sens.

### Le canal ajouté, et pourquoi le battement

```
Heartbeat.runtime.network      « voici où je réponds »   RÉPÉTÉ à chaque beat
```

Le battement est le seul canal qui parle en permanence, et c'est ce qui manquait.
Une projection ne part qu'au **changement** : un réseau stable n'émet plus rien,
et une projection perdue, refusée par un Panel antérieur, ou émise avant que le
Panel ne sache la lire, **n'est jamais rejouée**. L'état déclaré et l'état réel
divergent alors en silence.

Le battement, lui, répète. C'est ce qu'on attend d'une donnée de *liveness* :
elle ne prouve pas ce qui a changé, elle prouve ce qui est vrai maintenant.

Et parce qu'il affirme « je réponds ici », il est **opérationnel par nature** —
au même titre que le bootstrap, qui est la même affirmation faite une seule fois.

### Ce que le Panel en fait

`applyDeclaredNetwork()` (`services/registry/projectNetworkDeclaration.js`) est
la **règle unique**, partagée par les deux canaux opérationnels — écrite une
fois pour qu'ils ne divergent pas :

```
BOOTSTRAP   « rappelez-moi ICI ». Opérationnel par construction : c'est
            l'adresse par laquelle le projet vient de nous joindre. Mais
            ponctuel — il pose la valeur initiale et ne revient jamais sur
            une déclaration vivante plus récente.
HEARTBEAT   >= 1.9.0. La même affirmation, RÉPÉTÉE. C'est elle qui rend
            l'adresse vivante au lieu de figée.
```

Elle n'invente aucune adresse (une valeur illisible est ignorée, l'ancienne
reste), n'efface rien sur une déclaration vide, et ne fait jamais remonter de
valeur du Panel vers le projet.

La fiche porte désormais :

```
runtime.publicBackendUrl            l'adresse courante
runtime.publicBackendUrlUpdatedAt   quand le Panel l'a APPRISE
runtime.publicBackendUrlSource      par quel canal
```

L'horodatage est celui de la **réception**, jamais le `declaredAt` du projet :
une horloge de projet en dérive — fréquent juste après un redéploiement — ne
doit pas pouvoir figer une adresse.

### Compatibilité, dans les deux sens

Les schémas des deux côtés sont `.strict()` et la compatibilité n'est vérifiée
que sur la **majeure**. Un champ additif n'est donc pas gratuit :

- **projet 1.8 → Panel 1.9** : le projet n'envoie rien, tout est optionnel, et
  rien ne casse. Son adresse reste celle de l'appairage — mais **sourcée et
  datée**, donc reconnaissable comme telle au lieu d'être présentée comme
  courante. Il converge en montant de version, pas autrement : c'est le prix
  assumé de ne pas confondre déclaratif et opérationnel.
- **projet 1.9 → Panel 1.8** : le projet **n'émet pas** le champ. Il lit la
  version que le Panel annonce dans `x-bridge-contract-version` sur chaque
  réponse et ne déclare son réseau qu'à un Panel ≥ 1.9.0. *Fail closed* : tant
  qu'aucune réponse n'a été reçue, rien n'est déclaré. Sans cette garde, le
  battement aurait été refusé **en bloc** pour un champ inconnu, et une
  instance parfaitement saine aurait basculé hors ligne.

C'est aussi ce qui impose l'ordre de déploiement : **Panel d'abord**, projets
ensuite.

### Diagnostiquer une URL périmée

1. lire `runtime.publicBackendUrlSource` et `…UpdatedAt` sur la fiche ;
   `BOOTSTRAP` avec une date ancienne = le projet n'a jamais rien redéclaré ;
2. comparer à `descriptor.presentation.network.backend` (la projection) et à
   la destination `ACTIVE` ;
3. vérifier la version de contrat du projet (`runtime.contractVersion`) : un
   projet < 1.9.0 ne déclare **jamais** son adresse opérationnelle — sa fiche
   reste sur celle de l'appairage, et c'est attendu ;
4. ne **jamais** corriger en réappairant, ni en éditant la fiche à la main :
   c'est le projet qui déclare, le Panel reflète.

---

## STRIPE REVENUE OWNERSHIP

*(L10.7 — la résolution d'appartenance d'un fait de revenu)*

### Le défaut

Un paiement TEST **réellement encaissé** produisait un
`PanelProviderRevenueFact` en :

```
projectionStatus = UNOWNED
projectionReason = NO_OWNERSHIP_RESOURCE
```

donc **aucune transaction au registre financier** — alors que le Panel
possédait la session de paiement qui avait produit cet euro, et l'avait écrite
de sa propre main.

Cause : la résolution n'interrogeait le registre de liens que sur **une seule**
ressource, celle que le normalisateur avait retenue sur la charge utile — un
abonnement, ou `invoice.payment_intent`. Or :

- une prestation ponctuelle (`mode: payment` + `invoice_creation`) n'a **par
  nature** aucun abonnement ;
- Stripe a **retiré** `invoice.payment_intent` à plat (≥ `2025-04-30.basil`) ;
  les règlements vivent désormais sous `payments.data[].payment.payment_intent`.

Les deux seules filiations tombaient donc **en même temps**, et de l'argent
encaissé disparaissait du livret sans qu'aucune erreur ne soit levée.

### La doctrine

> Quand le Panel a **déjà appris** qu'une ressource Stripe appartient à un
> projet, tout événement ultérieur doit résoudre l'appartenance depuis ce
> **graphe interne** avant de conclure `UNOWNED`.

Le fournisseur annonce des faits ; il n'est pas l'annuaire de nos clients. Un
champ qu'il déplace ne doit pas pouvoir effacer une appartenance que nous avons
établie nous-mêmes, transactionnellement, à la création.

### Le graphe d'appartenance

| relation | créée quand | autoritaire | idempotente |
|---|---|---|---|
| `CheckoutSession → Project` | à la création par le Panel (L6.2B) | **oui** — preuve par construction | oui (index unique) |
| `CheckoutSession → PaymentIntent → Project` | `checkout.session.completed`, session possédée | oui — filiation désignée par Stripe | oui |
| `CheckoutSession → Invoice → Project` | `checkout.session.completed`, session possédée | oui — **ouvert par L10.7** | oui |
| `Subscription → Project` | adoption L6.2F | oui | oui |
| `Invoice → Subscription` | lu sur la facture (3 emplacements d'API) | oui | — |
| `Invoice → PaymentIntent` | lu sur la facture (2 emplacements d'API) | oui | — |

Le chaînon **`CheckoutSession → Invoice`** est celui qui manquait : une session
`mode: payment` désigne sa facture au moment où elle est payée, et c'est la
**seule** occasion où les deux identités se rencontrent — la facture, elle, ne
parlera jamais de la session.

### L'ordre de résolution — déterministe

`resolveStripeRevenueOwnership()`
(`services/finance/providerRevenue/stripeRevenueOwnership.js`) va du plus
**spécifique** au plus **général**. Deux exécutions sur le même fait rendent le
même propriétaire, même si le graphe s'est enrichi entre-temps — un rejeu de
projection financière doit être reproductible.

```
1. la ressource retenue par le normalisateur   (filiation désignée par Stripe)
2. l'objet canonique LUI-MÊME                  (facture ou session possédée)
3. l'ABONNEMENT                                (les factures d'UN contrat)
4. l'INTENTION DE PAIEMENT                     (un règlement, et un seul)
5. la SESSION                                  (créée et liée par le Panel)
```

Seul un **lien** (`PanelStripeResourceBinding`) fait preuve.

### Ce qui n'est jamais une preuve

- `metadata.panelProjectId` — éditable depuis le tableau de bord Stripe. Elle
  est lue pour **corroborer** ; un désaccord se journalise (`claimMismatch`),
  il ne décide pas ;
- l'e-mail, le nom, la description, le montant ;
- **le client (`cus_…`)**, et c'est le refus le plus important. Il porte
  pourtant un lien unique, donc il serait *techniquement* résolvable. Il est
  exclu par **nature** : une session, une intention, une facture, un abonnement
  sont des objets de **paiement** — chacun désigne une transaction, et son
  propriétaire est celui de cette transaction. Un client est un objet de
  **relation** : il vit au-dessus des paiements, il leur survit, et rien ne
  garantit que le prochain euro qu'il verse concerne le même projet que le
  précédent. Résoudre par lui, ce serait répondre « le projet qui a utilisé ce
  client la dernière fois ».

**Un revenu attribué au mauvais projet est bien plus coûteux qu'un revenu non
attribué** : il est silencieux, et il fausse deux bilans à la fois. En
l'absence de preuve, `UNOWNED` reste la bonne réponse.

### Attente, impasse, réconciliation

```
PENDING / NO_BINDING              une ressource APPARENTÉE est désignée :
                                  quelqu'un peut encore la faire adopter
UNOWNED / NO_OWNERSHIP_RESOURCE   le fait ne désigne que lui-même :
                                  rien à attendre — mais rien de définitif
```

`UNOWNED` **n'est plus un état terminal**. Le balayage
`convergePendingRevenue()` réexamine les deux statuts : un fait y entrait par un
accident d'ordonnancement et n'en sortait plus, ce qui n'imposait qu'un seul
recours — l'intervention manuelle, exactement ce que la projection automatique
existe pour éviter.

`convergePendingFactsFor()` retrouve désormais un fait par sa **corroboration**
autant que par sa ressource désignée : le fait qui a le plus besoin d'être
repris est précisément celui qui n'a pas pu remplir la colonne `ownershipResource*`.

---

## CONVERGENCE D'UN PAIEMENT — la redirection n'est jamais une preuve

### La doctrine, en une ligne

> **Un paiement est acquis quand le fournisseur l'a annoncé par un événement
> signé, jamais quand un navigateur est revenu.**

Le retour du navigateur sert à trois choses, et à trois seulement : afficher
immédiatement un résultat, accélérer une relecture, guider l'utilisateur. Fermer
l'onglet du prestataire de paiement avant la redirection ne change **rien** à ce
qui suit.

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

Aucune flèche de ce schéma ne part d'une URL de retour. Une garde de recette
vérifie qu'aucun applicateur de paiement du projet ne lit `req.query`,
`searchParams` ni `session_id`.

### L'ordre des livraisons n'est pas garanti — et il ment

Le fournisseur ne garantit aucun ordre, et chaque événement transporte un
**instantané** de l'objet, pris au moment où l'événement a été produit. Constaté
sur la recette TEST du 21 août 2026 :

```text
10:32:03.370  invoice.paid                   → abonnement ACTIF
10:32:03.504  customer.subscription.updated
10:32:03.563  customer.subscription.created  → « incomplete »
```

Le dernier ARRIVÉ est le plus ANCIEN : `customer.subscription.created` décrit
l'abonnement à sa naissance, avant le règlement de sa première facture. Il
écrasait `ACTIVE`, et le parcours client se bloquait sur « Paiement à
confirmer » — sans qu'aucun webhook ultérieur ne vienne le défaire.

Deux gardes se superposent côté projet :

| garde | portée | ce qu'elle départage |
|---|---|---|
| `statusObservedAt` | générale | une observation plus ancienne n'écrit ni statut, ni période, ni résiliation |
| « incomplete ne défait pas une facture encaissée » | décisive | les annonces tombées dans la MÊME seconde, que l'horloge ne peut pas trancher |

Les **identités** (`subscriptionId`, `latestInvoiceId`, `customerId`) sont
écrites dans tous les cas : elles nomment des objets, elles ne décrivent pas un
état qui régresse. Une lecture DIRECTE de l'abonnement — la réconciliation — est
horodatée « maintenant » et prime donc toujours : c'est ce qui rend la
réparation possible.

### « Vérifier le paiement » — ce que ce bouton est, et n'est pas

```text
IL FAIT           relire l'autorité, appliquer l'état déjà prouvé, rendre l'état
IL NE FAIT PAS    repayer · recréer une session · créer une transaction
                  croire un paramètre d'URL
```

Idempotent, appelable après F5, après fermeture de l'onglet, dix minutes plus
tard. Depuis la convergence automatique, il n'est plus **nécessaire** — il reste
comme relecture manuelle et comme filet de récupération.

Quand l'autorité ne répond pas, il rend `authorityReached: false`. L'écran dit
alors « nous n'avons pas pu joindre le service de paiement », jamais « état
vérifié » : annoncer une vérification qui n'a pas eu lieu, puis réclamer à
nouveau un paiement déjà fait, est le plus sûr moyen de faire croire à un échec.

### La facture : une copie détenue, pas une adresse

Une adresse `invoice_pdf` est **signée et périssable**. Une facture est une
pièce comptable qui se conserve des années. Le Panel télécharge donc le PDF dès
que le fait est projeté et le range dans son protocole Media — **au même endroit
que les justificatifs déposés à la main**, servi par la même route contrôlée :

```text
GET /api/finances/transactions/:id/receipt     401 sans authentification
                                               200 application/pdf avec
```

Conservés sur le fait : `providerInvoiceId`, `number`, `hostedUrl`, `pdfUrl`,
`mediaId`, `sha256`, `mime`, `bytes`, `downloadedAt`.

```text
un rejeu de webhook       → la copie existe, rien n'est retéléchargé
une pièce déposée à la main → JAMAIS écrasée ; l'archivage se retire
aucune facture chez le fournisseur → un ÉTAT nommé, jamais un faux PDF fabriqué
un téléchargement en échec → le revenu reste écrit, le rattrapage reprendra
```

**Le rattrapage n'est pas une migration.** `convergePendingRevenue()` reprend à
chaque lecture financière les encaissements projetés sans pièce — qu'ils datent
d'avant le lot, d'un Panel redémarré entre la projection et l'archivage, ou d'un
PDF que le fournisseur n'avait pas encore produit. Les trois laissent le même
état, et se réparent au même endroit.

### Les deux messages d'un encaissement

| message | émetteur | portée | destinataire | déclencheur |
|---|---|---|---|---|
| `PAYMENT_CONFIRMED_ADMIN` | le PROJET | PROJECT | ses administrateurs | `launch_fee.paid` · `subscription.paid` |
| `PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN` | le PANEL | PANEL | ses SUPER_ADMIN | fait fournisseur PROJETÉ |

Ils ne se recouvrent pas : l'un dit à un client que son règlement est encaissé,
l'autre apprend à L.Y Solution qu'un client du parc a payé. Le second n'est
**jamais** provisionné chez un projet — il nomme un client à quelqu'un d'autre,
et une garde de recette le vérifie.

`PAYMENT_CONFIRMED_ADMIN` est **générique** : frais de lancement, abonnement,
prestation. Ce qui les distingue tient dans deux variables (`payment.kind`,
`payment.period`). Il remplace `CONTRACT_PAYMENT_RECEIVED_ADMIN`, qui reste au
registre — marqué `retired: true` — pour la lisibilité des envois déjà partis.

### Le lien de facture est OBLIGATOIRE, et il se fait attendre

Le fournisseur annonce l'encaissement **avant** d'avoir fini d'émettre la
facture : environ quatre secondes sur le parcours réel. Un bouton « Voir ma
facture » qui mène à une liste vide est pire que pas de bouton — le client
vient d'être débité, on lui confirme, il clique, il ne trouve rien, il doute.

`payment.invoiceUrl` est donc une variable **obligatoire**, et son résolveur
lève un refus **rejouable** tant que la facture n'est pas parvenue. L'exécution
repasse à 30 s, 2 min, 10 min ; au-delà elle part en `DEAD_LETTER`, visible et
rejouable à la main. **Un trou qu'on voit vaut mieux qu'un lien mort.**

### Exactement une fois

```text
un fait fournisseur       index unique {provider, environment, objectType, objectId}
une transaction par fait  index unique partiel sur provenance.*
un envoi Panel            PanelCapabilityOperation (projectId, capability, operationId)
un envoi projet           idempotencyKey de l'événement + EmailDelivery
une copie de facture      invoiceArchive.mediaId, puis receipt.mediaId, puis l'empreinte
```

Aucune de ces clés ne contient d'horloge. Un `Date.now()` produirait un acte
neuf à chaque passage, et le premier rattrapage réexpédierait tout le parc.

### Incident — « Paiement à confirmer » sur un contrat qui a payé

```text
1. le Panel a-t-il la transaction ?      écran Finances → le mouvement existe ?
2. si OUI  → le projet n'a pas convergé  → « Vérifier le paiement » (idempotent)
                                          ou attendre la convergence serveur
3. si NON  → le fait est-il retenu ?     /api/finances/provider-revenue/unprojected
4. l'ordre des webhooks                  panelproviderwebhookevents, par receivedAt
```

Ne JAMAIS marquer un paiement payé à la main : c'est précisément ce que toute
cette chaîne existe pour rendre inutile.

### Incident — un mouvement sans facture

```text
1. le fournisseur en a-t-il émis une ?   fait → invoiceDocument.pdfUrl
2. si NON  → normal pour un paiement unique sans `invoice_creation`
3. si OUI  → fait → invoiceArchive.attempts / lastError
4. réparer → une lecture de l'écran Finances suffit (convergence)
```
