# 24 — Environnement, secrets et domaines

> Le mode d'emploi opérationnel du Panel : quelles variables, lesquelles sont
> obligatoires, comment `ENV` choisit la base, comment les domaines sont
> résolus, et comment faire tourner un secret sans casser le parc.
> Référence de code : `backend/src/config/env.js` (seul lecteur de
> `process.env`) et `backend/src/services/network/networkConfig.service.js`
> (seul résolveur d'URL).

---

## 1. Toutes les variables

Modèle versionné : `backend/.env.example`. Le fichier réel `backend/.env`
n'est **jamais** commité (ignoré par `backend/.gitignore`).

| Variable | Obligatoire | Secrète | Rôle | Défaut |
|---|---|---|---|---|
| `ENV` | ✅ **fail-closed** | non | `TEST` ou `PROD` — unique interrupteur d'environnement | — |
| `PORT` | non | non | port HTTP du backend | `4100` |
| `MONGODB_URI` | ✅ **fail-closed** | 🔒 **oui** | URI commune aux deux environnements | — |
| `DB_TEST` | ✅ si `ENV=TEST` | non | nom de la base de test | — |
| `DB_PROD` | ✅ si `ENV=PROD` | non | nom de la base de production | — |
| `JWT_SECRET` | ✅ **fail-closed** | 🔒 **oui** | signature des sessions du Panel | — |
| `JWT_EXPIRES_IN` | ✅ **fail-closed** | non | durée de vie des JWT (`12h`, `7d`, `900`…) | — |
| `BRIDGE_ENCRYPTION_KEY` | ✅ **fail-closed** | 🔒 **oui** | AES-256-GCM (64 hex) — chiffrement au repos des bridgeTokens | — |
| `PANEL_NAME` | non | non | nom d'affichage, renvoyé aux projets au bootstrap | `Panel L.Y Solution` |
| `PUBLIC_URL` | non | non | URL publique du backend — **repli** de la configuration système | — |
| `CORS_ORIGINS` | non | non | origines statiques supplémentaires, séparées par des virgules | vide |
| `SEED_DEV_EMAIL` | non | non | compte DEV initial | — |
| `SEED_DEV_PASSWORD` | non | 🔒 **oui** | mot de passe du compte DEV initial | — |
| `HEARTBEAT_INTERVAL_S` | non | non | intervalle attendu des heartbeats | `300` |
| `PAIRING_CODE_TTL_S` | non | non | durée de vie d'un code d'appairage | `900` |
| `PANEL_DEBUG` | non | non | `1` active les logs de débogage | — |

**fail-closed** = le processus s'arrête au démarrage, avec un message clair,
si la variable est absente ou invalide. Jamais de valeur par défaut
silencieuse sur une variable critique.

## 2. Comment `ENV` sélectionne la base

C'est la philosophie du projet vitrine, vérifiée dans son code puis reprise :

```text
ENV=TEST  →  mongoose.connect(MONGODB_URI, { dbName: DB_TEST })
ENV=PROD  →  mongoose.connect(MONGODB_URI, { dbName: DB_PROD })
```

Conséquences directes :

- **basculer TEST → PROD ne demande PAS de modifier `MONGODB_URI`** : une
  seule URI (un seul cluster), deux noms de bases ;
- le nom final de la base est déterminé **explicitement** par la
  configuration validée, jamais déduit ni concaténé dans l'URI ;
- `DB_PROD` peut rester absente en `TEST` (base non sélectionnée) et
  réciproquement — seule la base **active** est exigée.

Le démarrage échoue proprement si : `ENV` est absent ou hors `TEST`/`PROD` ;
`MONGODB_URI` manque ; `DB_TEST` manque en TEST ; `DB_PROD` manque en PROD.

### Éviter qu'un environnement TEST utilise une base PROD

Quatre garde-fous cumulés :

1. `ENV` ne sélectionne **que** la variable correspondante — il n'existe
   aucun chemin de code où `ENV=TEST` lise `DB_PROD` ;
2. `DB_TEST` et `DB_PROD` doivent porter des noms distincts (une même valeur
   dans les deux serait une erreur de saisie visible dans `.env`) ;
3. le déploiement **impose** `ENV` sur le serveur cible : la valeur du poste
   de développement n'est jamais transportée ;
4. `GET /health` et `GET /api/version` publient l'`ENV` actif ; le
   déploiement vérifie que l'environnement publié correspond à celui attendu
   avant de conclure.

Au démarrage, les journaux affichent `ENV` et le **nom de la base** — jamais
l'URI, qui peut contenir des credentials.

## 3. Domaines et URLs — la règle de priorité

Une seule information, une seule règle. Le résolveur canonique est
`services/network/networkConfig.service.js` ; **aucun autre fichier ne
résout d'URL**.

| Priorité | Source | Où | Quand elle gagne |
|---|---|---|---|
| 1 | **Configuration système** | MongoDB, document singleton `systemconfigurations` | dès qu'une URL y est enregistrée |
| 2 | **Environnement** | `PUBLIC_URL` dans `.env` | si la base ne dit rien (amorçage) |
| 3 | **Défaut local** | code du résolveur | en développement uniquement |

En **PROD**, une candidate qui n'est pas publiquement joignable (HTTP,
`localhost`, `127.*`, `.local`) est **écartée** : le Panel préfère annoncer
« URL indisponible » plutôt que diffuser une adresse locale à un projet
distant. La source retenue est exposée par `GET /api/version`
(`backendUrlSource`), ce qui rend la règle observable et non devinée.

### Deux URLs, pas davantage

| URL | Signification |
|---|---|
| `backendUrl` | adresse publique de l'API et du pont — **c'est ce que les projets appellent** |
| `frontendUrl` | adresse publique de l'interface — origine CORS de référence |

Il n'existe volontairement pas de troisième variable désignant la même chose.
Un champ non renseigné vaut `null` : « non configuré » reste distinguable de
« configuré sur une valeur locale ».

### Ce qui relève de quoi

| Information | Où elle vit | Pourquoi |
|---|---|---|
| Secrets (`JWT_SECRET`, `BRIDGE_ENCRYPTION_KEY`, `MONGODB_URI`) | `.env` **uniquement** | ne doivent jamais entrer en base ni dans le dépôt |
| `ENV`, `PORT`, noms de bases | `.env` **uniquement** | déterminent la connexion, donc antérieurs à toute lecture en base |
| URLs publiques (`backendUrl`, `frontendUrl`) | **configuration système en base**, repli `PUBLIC_URL` | modifiables sans redéployer ; posées par le déploiement |
| Domaine cible, port, hôte SSH, rétention | **configuration de déploiement** (`deploy/deploy.config.json`, non commitée) | propre à une infrastructure, pas à l'application |
| Version logicielle | `package.json` + build | dérivée, jamais saisie |

### CORS

Origines autorisées = `frontendUrl` + `backendUrl` résolues + les origines
statiques de `CORS_ORIGINS`, dédupliquées. Le cache est rafraîchi au
démarrage et après chaque écriture de la configuration réseau — changer de
domaine met le CORS à jour sans redémarrage. Une requête sans en-tête
`Origin` (appel serveur à serveur, cas des projets sur `/bridge/v1`) n'est
jamais concernée.

## 4. Comment le déploiement remplit tout cela

Un seul domaine est saisi ; tout en découle (`deploy/lib/config.mjs`) :

```text
host = panel.exemple.com
  ├─ URLs        https://panel.exemple.com (backend et frontend)
  ├─ Nginx       server_name, chemins de certificat, proxy vers PORT
  ├─ .env distant  ENV, PORT, PUBLIC_URL, CORS_ORIGINS réécrits
  └─ base         configuration système écrite par
                  backend/scripts/set-network-configuration.mjs
```

Le `.env` distant est construit à partir du `.env` **local** (les secrets ne
transitent jamais par le dépôt), puis **relu** : une variable obligatoire
absente ou vide arrête le déploiement avant le démarrage du service. Les
valeurs dépendantes de l'hôte sont réécrites par le déploiement — la
configuration du poste de développement ne fait jamais autorité.

Aucune édition manuelle dispersée : `set-network-configuration.mjs` est le
point unique de propagation du domaine vers la base, et il relit ce qu'il
vient d'écrire.

## 5. Générer `JWT_SECRET`

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Et la clé de chiffrement du pont (32 octets = 64 caractères hexadécimaux) :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Règles, appliquées au démarrage :

1. **jamais réutiliser le secret d'un autre projet ni d'un autre
   déploiement** — TEST et PROD ont chacun le leur. Un secret partagé
   transforme la compromission d'un environnement en compromission de tous ;
2. un placeholder connu (`GENERATE_A_SECURE_RANDOM_SECRET`,
   `change-me-…`) est **refusé** ;
3. moins de 32 caractères : **refusé** ;
4. `BRIDGE_ENCRYPTION_KEY` égale à `JWT_SECRET` : **refusé** (une clé par
   usage) ;
5. **changer `JWT_SECRET` invalide toutes les sessions en cours** : les
   utilisateurs devront se reconnecter. C'est le comportement attendu d'une
   rotation, pas un effet de bord.

Le secret n'apparaît jamais dans un message d'erreur, un log, un test ou un
rapport de déploiement — c'est vérifié par `tests/config.test.js` et
`tests/deploy.test.js`.

## 6. Le compte seed

Le compte DEV initial n'est créé **que** si la base ne contient aucun
utilisateur : un compte réel n'est jamais écrasé.

| Environnement | Règle |
|---|---|
| `TEST` | identifiants libres ; sans variables seed, le serveur démarre mais aucune connexion n'est possible |
| `PROD` | identifiants par défaut connus **refusés** ; mot de passe < 12 caractères **refusé** ; sans variables seed, le serveur démarre normalement (aucun compte par défaut n'est créé) |

Aucune combinaison connue de développement ne peut donc devenir une valeur de
production. Après le premier déploiement, changer le mot de passe du compte
seed depuis l'interface et retirer `SEED_DEV_PASSWORD` du `.env` distant.

## 7. Passer de TEST à PROD

1. sur le serveur cible, poser un `.env` **dédié** : `ENV=PROD`, `DB_PROD`
   renseignée, et des **secrets propres à cet environnement** (jamais ceux de
   TEST) ;
2. lancer le déploiement avec `--env PROD` et le domaine de production ;
3. le déploiement impose `ENV`, `PORT`, `PUBLIC_URL` et `CORS_ORIGINS` dans
   le `.env` distant, puis relit le fichier ;
4. il écrit le domaine dans la configuration système, puis relit ;
5. il vérifie `GET /health` en local, puis publiquement, et compare l'`ENV`
   publié à celui attendu ;
6. vérifier `GET /api/version` : `environment: "PROD"`, `urls.backendUrl` au
   domaine attendu, `backendUrlSource: "SYSTEM_CONFIGURATION"`.

## 8. Rotation des secrets

| Secret | Procédure | Effet |
|---|---|---|
| `JWT_SECRET` | générer, remplacer dans le `.env` de l'environnement concerné, redémarrer | toutes les sessions sont invalidées : reconnexion requise. Aucune donnée perdue |
| `BRIDGE_ENCRYPTION_KEY` | ⚠️ générer, remplacer, redémarrer | les copies chiffrées existantes deviennent illisibles : **tous les projets doivent être ré-appairés**. À ne faire qu'en cas de compromission avérée, ou avec une révocation planifiée du parc |
| `SEED_DEV_PASSWORD` | changer le mot de passe depuis l'interface, puis retirer la variable | aucun effet sur les sessions |
| `MONGODB_URI` | remplacer, redémarrer | coupure le temps du redémarrage |

Après toute rotation : vérifier `GET /health` puis `GET /api/version`, et —
pour la clé de chiffrement — reconstituer les appairages projet par projet.

Un secret compromis ne se « range » pas : il se remplace. Un secret qui a
été journalisé, copié dans un ticket ou partagé est compromis.
