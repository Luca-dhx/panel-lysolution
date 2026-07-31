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
