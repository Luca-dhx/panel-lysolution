# 60 — Déployer le Panel depuis le Panel

> **Référence officielle.** Phase 4.
> Code : `backend/src/services/deployment/`, `controllers/deployment.controller.js`,
> `frontend/src/pages/Deployment*.tsx`.

---

## 1. Le manque que cette surface comble

Le Panel embarquait le moteur de déploiement standard depuis la Phase 2D, et
un profil de projet complet. Il n'avait **aucune interface pour s'en servir**.

SB Auto 06 se déploie depuis son Manager. Le Panel, lui, n'avait qu'un
runbook manuel : lignes de commande, nginx écrit à la main, PM2 lancé à la
main. Deux applications de la même famille, deux façons de faire — ce que la
standardisation des moteurs cherchait justement à éviter.

## 2. Ce qui n'est PAS dupliqué

Aucune logique de déploiement n'a été réécrite. Ni commande SSH, ni
génération nginx, ni gestion de release, ni contrôle de santé, ni rollback.
Tout cela vit dans `deployment-engine/`, dont le cœur est **identique** dans
les deux dépôts.

La couche ajoutée est un **adaptateur** : elle traduit une destination du
Panel en arguments du moteur, et les événements du moteur en étapes de run.
Un test le verrouille — l'exécuteur ne doit contenir ni commande SSH ni
configuration nginx.

## 2 bis. Le frontend décrit une intention, le backend construit la configuration

C'est la règle qui structure toute cette surface, et elle a fait l'objet
d'une correction : la première version demandait dix champs, dont le port
PM2, la racine des déploiements et le port SSH. C'était une régression par
rapport à SB Auto 06, et une faute d'ergonomie — faire porter à l'opérateur
une décision qui appartient au moteur, et lui donner l'occasion de se
tromper sur un détail dont il ne peut pas juger.

### Ce qui est demandé

| Champ | Pourquoi lui, et pas le backend |
|---|---|
| **Nom** | un choix humain, sans effet technique |
| **Adresse complète** | l'intention même : où ce Panel doit répondre |
| **Environnement** | TEST ou PROD — un choix de gouvernance, pas de technique |
| **Adresse du serveur** | le Panel ne peut pas deviner votre hébergeur |

Sous « Options avancées », repliées :

| Champ | Pourquoi il reste modifiable |
|---|---|
| Utilisateur du serveur | pré-rempli à `root` ; certains hébergeurs ne l'ouvrent pas |
| Nom de la base | le Panel ne peut pas deviner qu'une base existante doit être réutilisée |

### Ce qui est déduit

| Valeur | Origine |
|---|---|
| hôte, type, domaine enregistrable, sous-domaine | `parseTargetUrl()` — le moteur fait autorité |
| base wildcard / certificat dédié | bases wildcard du profil |
| **port local du backend** | attribué : plus haut port utilisé + 1, à partir de 5100 |
| nom du service PM2 | `serviceName(host)` du profil → `panel-<hôte>` |
| chemin sur le serveur | `<remoteRoot>/<hôte>` |
| racine des déploiements | `DEFAULT_REMOTE_ROOT` du profil |
| port SSH | 22, standard du transport |
| contact Let's Encrypt | **contacts de l'entreprise** — le Panel les détient déjà |
| base de données | `DB_TEST` / `DB_PROD` selon l'environnement |
| variables du `.env` distant | construites par le moteur depuis le `.env` local |

Ces valeurs **ne peuvent pas être imposées par le frontend** : un client qui
enverrait `backendPort: 9999` le verrait ignoré. Un test le vérifie.

### La déduction est montrée, pas cachée

La fiche d'une destination affiche « Configuration déterminée
automatiquement » : chaque valeur, et **l'origine** de chaque valeur. Sans
cela, la déduction ressemblerait à de la magie, et le jour où quelque chose
cloche l'opérateur n'aurait aucune prise.

### Le port n'est attribué qu'une fois

Modifier une destination ne réattribue pas son port : le changer casserait
le service PM2 et la configuration nginx déjà en place. Un port libéré n'est
pas non plus réutilisé — un ancien service oublié capterait le trafic d'une
nouvelle destination.

### Authentification : mot de passe seulement

Le transport SSH du moteur (`SshTransport`) exige `host`, `username` et
`password`. **Il ne sait pas utiliser de clé privée.** L'interface n'offre
donc pas ce choix : un menu déroulant dont une option échoue à l'exécution
serait pire que pas de menu.

Ajouter le support des clés est une évolution du **cœur du moteur**, qui doit
rester identique dans tous les projets (`29_ENGINE_GOVERNANCE.md`) : elle
devrait donc être portée dans les deux dépôts, avec sa version de moteur.
Ce n'est pas fait.

## 2 ter. Une intention, pas un parcours technique

Seconde correction d'ergonomie, du même ordre que la précédente. La première
version exposait quatre boutons numérotés : *Tester la connexion*,
*Vérifier les prérequis*, *Simuler*, *Déployer*.

C'était une erreur de nature. La connexion et les prérequis ne sont pas des
**décisions** que prend l'opérateur : ce sont des **étapes** du déploiement.
Les lui faire déclencher revenait à lui faire piloter le moteur à la main, et
à transformer l'écran en panneau d'administration SSH.

### Ce que fait le bouton unique

`POST /api/deployment/targets/:id/deploy` répond **202 ACCEPTED** avec un
`executionId`, puis le moteur enchaîne ses 20 étapes canoniques :

```text
Préparation du déploiement · Détection du domaine · Connexion au gestionnaire
de domaine · Lecture de la configuration · Connexion sécurisée au serveur ·
Vérification des prérequis du serveur · Vérification de sécurité de la
destination · Préparation des adresses · Vérification de disponibilité ·
Préparation de la nouvelle version · Transfert du projet · Installation &
configuration · Configuration du routage web · Activation HTTPS · Démarrage
des services · Vérification des services · Synchronisation réseau ·
Vérification publique finale · Finalisation
```

**202 et non 201** : rien n'est créé au sens REST — une exécution est
*acceptée* et se poursuivra ailleurs. Le client reçoit de quoi la suivre, pas
son résultat.

### L'orchestration est celle du MOTEUR

Le Panel appelle `engine.deployWithReport()`, qui possède déjà tout :
préflight, sécurité de la destination, build, transfert, nginx, TLS, PM2,
contrôle de santé, vérification publique — en émettant des étapes canoniques
et en produisant un rapport structuré.

Composer ces appels nous-mêmes aurait réécrit l'orchestration du moteur dans
le Panel, où elle aurait divergé de SB Auto 06 à la première correction.
L'exécuteur du Panel ne fait que **déclencher** et **transcrire**.

### La checklist est posée avant le départ

Les 20 étapes sont inscrites en `pending` **à la création du run**, avant que
le worker ne démarre. L'écran affiche donc la liste complète immédiatement.
Une page vide qui se remplit peu à peu laisse croire que rien ne commence.

À la conclusion, les étapes restées `pending` deviennent `skipped` : un
déploiement qui échoue à nginx n'a pas « en attente » ses étapes suivantes —
elles n'auront jamais lieu.

### Les outils de diagnostic subsistent, hors parcours

*Tester la connexion*, *Vérifier les prérequis* et *Simuler* restent
accessibles, repliés sous « Outils de diagnostic », annoncés comme
facultatifs. Ils gardent une utilité propre — examiner un serveur **avant**
de préparer un déploiement, sans rien engager — mais ne sont plus des
préalables.

### Le rapport

Produit par le moteur (`report/RunRecorder` + `report/markdown`), persisté
avec le run, copiable d'un bouton. Le Panel n'a aucune raison d'avoir sa
propre idée de ce qu'est un rapport de déploiement.

**Masquage.** Le redacteur du moteur amorce sur `JWT_SECRET`, `MONGODB_URI`
et `INTEGRATED_API_ENCRYPTION_KEY` — les secrets d'un projet vitrine. Le
Panel en a un de plus, `BRIDGE_ENCRYPTION_KEY`, que le moteur ne connaît pas.
Une seconde passe est donc appliquée côté Panel, sur le markdown **et** sur
le rapport structuré. On ne modifie pas le moteur pour autant : son cœur doit
rester identique dans les deux dépôts.

### Divergence assumée : sondage, pas flux

SB Auto 06 diffuse ses étapes en **NDJSON** sur une connexion ouverte
(`POST /deployment/deploy/stream`, `fetch` + `getReader()`). C'est plus
élégant.

Ce serait **faux ici** : le Panel peut se déployer lui-même, et le flux se
couperait au moment précis où son backend redémarre — c'est-à-dire juste
avant le contrôle de santé et la vérification publique, les deux étapes qu'on
attend le plus.

Le Panel sonde donc le run persisté toutes les 2 secondes. Une requête échoue
pendant le redémarrage, la suivante réussit, l'affichage reprend. C'est ce
que le sondage donne gratuitement et qu'un flux ne donne pas.

## 3. Architecture

```text
Interface  ──▶  POST /api/deployment/targets/:id/deploy
                        │
                        ├── crée un RUN en base (status: running)
                        │
                        └── lance un PROCESSUS DÉTACHÉ ──┐
                                                          │
   la requête HTTP rend un runId et se termine            │
                                                          ▼
                                            deploy-worker.js  (détaché)
                                                          │
                                                  DeploymentEngine
                                                          │
                                            écrit étapes + journal EN BASE
                                                          │
Interface  ◀── sonde GET /api/deployment/runs/:runId ◀────┘
```

Trois pièces, trois rôles :

| Fichier | Rôle |
|---|---|
| `deploymentTarget.service.js` | destinations — l'URL fait autorité |
| `deploymentRun.service.js` | runs — écrits par **deux** processus |
| `deploymentExecutor.service.js` | adaptateur vers le moteur |
| `deploymentWorker.service.js` | lance le processus détaché |
| `scripts/deploy-worker.js` | le processus détaché lui-même |

## 4. Le problème de l'auto-déploiement, et sa solution

### 4.1 Le problème

Un déploiement se termine par un `pm2 restart` du backend. Quand la
destination héberge **le Panel qui pilote**, cela veut dire : tuer le
processus qui exécute le déploiement, au moment précis où il approche de la
fin.

Si le déploiement tournait dans le backend :

- la requête HTTP est coupée — l'opérateur voit une erreur réseau alors que
  sa mise en ligne a peut-être réussi ;
- le run reste « en cours » pour toujours ;
- pire : les **dernières étapes** (contrôle de santé, validation) ne sont
  jamais exécutées. On redémarrerait sans jamais vérifier.

### 4.2 La solution : un processus détaché

```js
spawn(process.execPath, [WORKER_PATH], {
  detached: true,      // chef de son propre groupe de processus
  stdio: 'ignore',     // aucun tube vers le parent
  env: { ...          // les paramètres, dont le secret
});
child.unref();         // le backend cesse de l'attendre
```

Chaque option est nécessaire, et pour une raison précise :

| Option | Sans elle |
|---|---|
| `detached: true` | le signal envoyé au backend par `pm2 restart` serait propagé au worker : le déploiement mourrait avec ce qu'il déploie |
| `stdio: 'ignore'` | un tube maintiendrait une référence vivante ; le worker recevrait `EPIPE` à la mort du parent |
| `.unref()` | le backend ne pourrait pas s'arrêter proprement, il attendrait la fin du déploiement |

**Vérifié en conditions réelles** : un worker lancé avec ces options a
survécu à un `SIGKILL` de son parent et a terminé son travail — la moitié de
ses écritures ayant eu lieu après la mort du parent.

### 4.3 Ce qui remplace le temps réel

Un flux HTTP (SSE, NDJSON) serait plus élégant. Il serait aussi **faux
ici** : il se couperait au moment le plus intéressant.

Le worker écrit donc chaque étape et chaque ligne de journal **en base**, et
l'interface **sonde** le document toutes les 2 secondes. Quand le backend
redémarre, une requête échoue, la suivante réussit, et l'affichage reprend.
C'est ce que le sondage donne gratuitement et qu'un flux ne donne pas.

L'écran distingue explicitement « backend absent » d'une vraie erreur, et
explique que c'est attendu pendant un auto-déploiement.

### 4.4 Quand le worker meurt vraiment

Le worker bat la mesure toutes les 5 secondes. Deux mécanismes s'appuient
dessus :

- **à la lecture** — un run dont le battement dépasse 90 s est *présenté*
  comme interrompu, **sans modifier la base**. Une consultation d'écran ne
  doit pas condamner un worker simplement lent ;
- **au démarrage du backend** — `finalizeOrphanRuns()` clôt ces runs pour de
  bon. C'est le cas exact de l'auto-déploiement, où le Panel redémarre
  pendant son propre run.

Le statut est `interrupted` : **ni réussi, ni échoué**. Trancher serait
inventer. Le résumé le dit : *« Son issue est INCONNUE — vérifiez l'état
réel du serveur avant de relancer. »*

## 5. Le mot de passe SSH

**Il n'est jamais stocké.** Le modèle de destination n'a même pas de champ
pour cela — un test vérifie qu'aucune chaîne « password » n'existe au
document.

Son trajet, en entier :

```text
navigateur ──HTTPS──▶ contrôleur ──env du processus──▶ worker ──▶ coffre RAM
                                                                      │
                                                              transport SSH
                                                                      │
                                                          effacé (finally)
```

Trois précautions :

1. **Environnement, jamais `argv`.** Les arguments d'un processus sont
   lisibles par tout utilisateur (`ps aux`) ; son environnement ne l'est pas.
2. **Le worker efface la variable** de son propre environnement dès lecture,
   pour qu'un éventuel sous-processus n'en hérite pas.
3. **Le coffre est vidé dans un `finally`** — quoi qu'il arrive.

Côté navigateur : le champ est vidé dès que l'opération part, et rien n'est
écrit dans `localStorage`. Il est redemandé à chaque opération. C'est le prix
de ne jamais l'avoir en base.

## 6. Le profil de déploiement du Panel

Complet, et différent d'un projet vitrine sur un point de topologie :

| | Projet vitrine | Panel |
|---|---|---|
| Composants | vitrine + Manager + backend | **frontend + backend** |
| Sous-domaine | `manager.<host>` dérivé | **aucun** |
| Front servi | racine + sous-domaine | racine seulement |

```text
PROJECT_SLUG        'panel'
APPS                frontend (web) · backend (server)
REQUIRED_REMOTE_ENV ENV · PORT · MONGODB_URI · DB_TEST|DB_PROD
                    JWT_SECRET · JWT_EXPIRES_IN · BRIDGE_ENCRYPTION_KEY
serviceName(host)   panel-<host>
```

Le moteur embarqué déclare bien `nginx`, `https-certbot`, `pm2`,
`health-check`, `rollback` et `releases` — tous vérifiés par test.

## 7. Les cinq opérations

Toutes passent par le worker, toutes produisent un run consultable.

| Opération | Effet sur le serveur |
|---|---|
| **Test de connexion** | aucun — s'authentifie et lit les releases |
| **Vérification des prérequis** | aucun — préflight du moteur (nginx, node, pm2, certbot, disque, Mongo…) |
| **Simulation** | aucun — préflight réel **puis** plan des étapes |
| **Déploiement** | build, upload, nginx, TLS, PM2, contrôle de santé |
| **Retour arrière** | vérifie l'intégrité, bascule, contrôle la santé, restaure en cas d'échec |

La simulation ne « déploie pas à blanc » : elle ne peut pas appeler
`engine.deploy()`, et un test le vérifie.

## 8. Deux gardes de sûreté

**Une opération à la fois par destination.** Deux déploiements simultanés sur
le même hôte se disputeraient les mêmes chemins, le même service PM2 et la
même configuration nginx. Refus explicite, avec l'identifiant du run qui
occupe la place.

**PROD exige une confirmation.** Une case à cocher distincte, refusée côté
serveur si absente. Un clic de trop coûte moins cher qu'une production
cassée.

## 9. Surface HTTP

`/api/deployment` — **DEV uniquement**, sans exception : ces routes ouvrent
une session SSH et publient du code.

| Méthode | Route | Effet |
|---|---|---|
| GET | `/` | destinations, compteurs, exécutions récentes |
| GET | `/self` | ce que le Panel sait de lui-même |
| GET | `/targets/:id` | fiche, runs, run actif |
| POST | `/targets` | crée une destination |
| PATCH | `/targets/:id` | modifie |
| DELETE | `/targets/:id` | supprime (refusé si déploiement en cours) |
| POST | `/targets/:id/test-connection` | → runId |
| POST | `/targets/:id/preflight` | → runId |
| POST | `/targets/:id/simulate` | → runId |
| POST | `/targets/:id/deploy` | → runId |
| POST | `/targets/:id/rollback` | → runId |
| POST | `/targets/:id/releases` | lecture courte, dans la requête |
| GET | `/runs/:runId` | état complet — c'est ce que sonde l'interface |

Les opérations sont des `POST` parce qu'elles transportent un mot de passe :
jamais dans une URL, qui finirait dans les journaux d'accès de nginx.

## 10. Limites connues

- **Rien n'a été déployé pour de vrai.** Aucune cible n'a été fournie. La
  chaîne complète est testée hors ligne ; le comportement face à un vrai
  serveur reste l'objet de `33_VPS_ACCEPTANCE.md`, toujours ouverte.
- **Pas de sauvegarde/restauration** dans cette surface, contrairement à
  SB Auto 06. Le moteur sait le faire ; l'interface ne l'expose pas encore.
- **Pas de gestion DNS automatique.** SB Auto 06 pilote Hostinger via son
  IntegratedAPI ; le Panel suppose le DNS déjà en place, et son préflight le
  vérifie.
- **Sondage à cadence fixe** (2 s), sans dégressivité sur les opérations
  longues.
- **Un seul historique de 50 entrées** par destination.
