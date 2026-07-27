# 27 — Le `deployment-engine` : moteur de déploiement standard

> **Référence officielle de l'écosystème L.Y Solution.** Ce document décrit
> un composant présent, à l'identique, dans TOUS les projets de l'écosystème.
> Code : `backend/src/deployment-engine/`.
> Établi en Phase 2D (standardisation des moteurs).

---

## 1. La règle

> **Tout projet L.Y Solution embarque son propre moteur de déploiement.**
> Il n'est ni externalisé, ni appelé depuis un dépôt commun, ni installé
> comme dépendance : il vit dans le projet et se duplique avec lui.

Quatre raisons, non négociables :

| Raison | Conséquence |
|---|---|
| **Autonomie** | un projet se déploie sans réseau vers un dépôt tiers |
| **Revente** | un projet vendu part avec son moteur ; l'acheteur est autonome |
| **Maintenance indépendante** | un projet livré en 2026 continue de se déployer même si le standard évolue en 2028 |
| **STANDALONE** | aucune dépendance runtime entre projets, jamais |

### Le corollaire : un cœur strictement identique

Puisque le moteur est dupliqué, il ne doit **jamais** être forké. Ce qui
distingue un projet d'un autre passe par quatre portes, et par elles seules :

```text
deployment-engine/
├── engine.manifest.json     ← version et identité du moteur
├── config/                  ← CE QUI CHANGE d'un projet à l'autre
│   └── project.profile.js       le seul fichier spécifique au projet
├── transport/               ← ADAPTERS : SSH réel, transports de test
├── dns/                     ← ADAPTERS : fournisseurs DNS
├── report/                  ← rapports de run (enregistrement, rendu, masquage)
└── *.js                     ← LE CŒUR — identique dans tous les projets
```

Toute différence de cœur entre deux projets est une **dérive**, détectée par
`tests/engine-drift.check.mjs`.

## 2. Responsabilités

Le moteur fait — et ne fait que — ceci :

| Domaine | Ce qu'il garantit |
|---|---|
| **Préflight** | SSH, Nginx, Node, PM2, certbot, permissions, espace disque, occupation du site, certificat wildcard, DNS. Un contrôle requis en échec **refuse** le déploiement |
| **Build** | artefact construit dans un staging **isolé**, hors du dépôt de travail ; refus si la source est sale en PROD ; manifeste de version et empreintes d'artefacts |
| **Publication** | envoi de l'artefact, releases, activation |
| **Nginx** | configuration générée en deux temps (HTTP pour ACME, puis HTTPS), validée par `nginx -t` avant tout rechargement |
| **HTTPS** | Let's Encrypt (webroot), réutilisation d'un certificat wildcard quand la cible est un sous-domaine d'une base gérée |
| **Runtime** | PM2, nom de service déterministe, persistance de la liste |
| **Santé** | contrôle local **avant** exposition, puis contrôle public ; comparaison de l'ENV et de l'artefact réellement servis |
| **Configuration** | écriture du `.env` distant **puis relecture** ; propagation du domaine dans la configuration système |
| **Rollback** | retour à une release précédente |
| **Sauvegarde** | archive horodatée (base, médias, configuration) et restauration |
| **Rapports** | enregistrement de chaque étape, rendu Markdown, **masquage systématique des secrets** |

Il ne fait **pas** : gérer le métier, connaître la base d'un autre projet,
déployer un autre projet que le sien.

## 3. Le profil de projet — la seule porte de personnalisation

`config/project.profile.js` répond à cinq questions, et rien de plus :

| Clé | Rôle | Panel | Projet vitrine |
|---|---|---|---|
| `PROJECT_SLUG` | préfixe des ressources serveur (PM2, backups, staging) | `panel` | `sbauto` |
| `PROJECT_ID` | identité inscrite au manifeste de build | `panel-lysolution` | `sbauto06` |
| `APPS` | applications à construire et publier, avec leurs rôles | `frontend` (web) + `backend` (server) | `vitrine` (web) + `manager` (web-sub) + `backend` (server) |
| `API_SUBDOMAIN` | sous-domaine dédié à l'API | `api` | `api` |
| `DEFAULT_WILDCARD_BASES` | bases couvertes par un certificat wildcard | — | — |
| `REQUIRED_REMOTE_ENV` | variables vitales du `.env` distant | + `BRIDGE_ENCRYPTION_KEY`, `JWT_EXPIRES_IN` | + `INTEGRATED_API_ENCRYPTION_KEY` |

### Les rôles d'application

| Rôle | Signification | Conséquence |
|---|---|---|
| `web` | front servi en statique sur l'hôte principal | construit, publié à la racine |
| `web-sub` | front servi sur un sous-domaine dérivé | construit, publié sur `<subdomain>.<host>` |
| `server` | backend Node | jamais construit, jamais servi en statique |

C'est **toute** la différence de topologie entre le Panel (2 applications) et
un projet vitrine (3 applications). Le cœur ne contient aucune liste
d'applications : il itère sur le profil.

Les codes d'erreur de build (`ARTIFACT_BUILD_*`) sont déclarés dans le profil,
et non dérivés d'un identifiant : ils font partie du **contrat public** du
moteur et ne doivent pas changer parce qu'une application est renommée.

## 4. Un domaine, une seule entrée

Le domaine fourni au déploiement est la **seule** information saisie. Tout
le reste en découle :

```text
host = panel.exemple.com
  ├─ hôtes dérivés   api.panel.exemple.com (+ un hôte par application web-sub)
  ├─ URLs            https://panel.exemple.com
  ├─ Nginx           server_name, chemins de certificat, proxy vers le port
  ├─ .env distant    ENV, PORT, PUBLIC_URL, CORS_ORIGINS réécrits
  └─ base            configuration système écrite puis relue
```

Aucun domaine n'est codé en dur dans le cœur du moteur. Aucune édition
manuelle dispersée n'est nécessaire.

## 5. Cycle de vie d'un déploiement

```text
préflight ──▶ build local ──▶ publication ──▶ Nginx HTTP ──▶ certificat
                                                                  │
   purge ◀── santé publique ◀── domaine en base ◀── santé locale ◀─┴─ Nginx HTTPS
                                                        ▲
                                              activation de la release
                                              (point de non-retour)
```

Deux garanties d'ordre :

1. **la santé locale précède l'exposition publique** — on ne publie jamais un
   service qui ne répond pas déjà ;
2. **tout ce qui précède l'activation est réversible** : la nouvelle release
   est installée à côté de l'ancienne ; l'activation est l'unique instant où
   le trafic change de version.

## 6. Sécurité

| Règle | Mise en œuvre |
|---|---|
| Aucun secret dans le dépôt | les secrets du `.env` distant viennent du `.env` local, jamais du dépôt |
| Aucun secret dans un journal | masquage systématique dans les rapports ; sortie du CLI expurgée |
| Aucun secret en argument de commande | le mot de passe SSH vient de l'environnement (`DEPLOY_SSH_PASSWORD`) — jamais de l'historique du shell |
| Le mot de passe VPS n'existe qu'en RAM | coffre-fort mémoire, session opaque, durée de vie bornée |
| Défense en profondeur anti-injection | toute valeur interpolée dans une commande distante est revalidée au point d'usage |
| Refus plutôt qu'exécution douteuse | une valeur non sûre arrête le déploiement |

## 7. Versionnement

`engine.manifest.json` — le moteur connaît sa propre version :

```json
{
  "engine": "deployment-engine",
  "version": "1.0.0",
  "compatibleProjects": ["panel"],
  "contractVersion": "1.1.0",
  "lastStandardization": "2026-07-27",
  "description": "…"
}
```

Règles d'évolution :

1. **corriger le cœur = corriger partout.** Un correctif est porté dans tous
   les projets maintenus, et la version du moteur est incrémentée.
2. **évolution additive = mineure** ; changement de contrat du profil =
   majeure.
3. `compatibleProjects` documente les topologies validées.
4. `lastStandardization` date le dernier alignement — c'est ce qui permet de
   savoir, des années plus tard, à quelle génération de moteur un projet
   vendu correspond.

## 8. Contrôle de dérive

`tests/engine-drift.check.mjs` compare les moteurs de ce projet à ceux du
projet de référence quand les deux sont présents dans le même workspace.

Il vérifie quatre choses :

1. **même inventaire de fichiers** — un fichier en trop est une dérive
   structurelle ;
2. **cœur identique** (comparaison octet, fins de ligne normalisées) ;
3. **fichiers de personnalisation présents ET différents** — un profil
   identique à la référence signifierait que le projet n'a pas été adapté ;
4. **versions de moteur alignées**.

C'est un **outil d'atelier** : il se retire proprement (SKIP) si le projet de
référence n'est pas là. Il ne crée aucune dépendance runtime — vérifié par
`tests/architecture.test.js`.

## 9. Utilisation

```bash
# Simulation — affiche le plan, n'exécute rien, ne se connecte à rien
node deploy/deploy.mjs --host panel.exemple.com --env PROD \
  --ssh-host 203.0.113.10 --port 4100

# Exécution réelle — exige --execute ET les identifiants SSH
DEPLOY_SSH_PASSWORD=… node deploy/deploy.mjs --execute \
  --host panel.exemple.com --env PROD --ssh-host 203.0.113.10 --port 4100

# Rollback
node deploy/deploy.mjs --rollback --to 20260727-1042-abc1234
```

La simulation est le mode **par défaut** : un déploiement réel ne peut pas
arriver par accident.

## 10. Limites connues

| Limite | État |
|---|---|
| Recette VPS complète du Panel (certificat réel, PM2 réel, DNS, rollback réel) | ⏳ jamais exécutée — aucune instruction de déploiement n'a été donnée |
| Rollback piloté par le moteur | ⏳ le plan et les commandes existent ; la méthode `rollback()` de la façade reste à écrire — le CLI affiche les commandes exactes en repli |
| Rétention des sauvegardes | ⏳ aucune politique automatique |
| Reprise après échec partiel | le moteur refuse les demi-déploiements ; il ne reprend pas au milieu — on relance |

## 11. Interdits

1. ❌ Forker le cœur du moteur pour un projet.
2. ❌ Coder en dur un domaine, un slug, un port, un chemin ou un nom de
   service ailleurs que dans le profil.
3. ❌ Externaliser le moteur dans un dépôt commun ou un paquet npm partagé.
4. ❌ Faire dépendre le moteur d'un service du projet hôte (il doit rester
   duplicable tel quel).
5. ❌ Déployer un autre projet que le sien.
6. ❌ Exécuter réellement sans `--execute`.
