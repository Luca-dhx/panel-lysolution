# 23 — Le Panel Standard : un projet de l'écosystème comme les autres

> Établi en Phase 2C, à l'issue de l'audit de convergence avec le projet
> vitrine de référence.

---

## 1. La règle

> **Le Panel est une application spécialisée de l'écosystème, construite avec
> la même stack et les mêmes grandes conventions que les projets vitrines.**

La différence entre le Panel et un Manager vitrine porte sur leurs **modules
métier**, pas sur leur stack ni sur leurs standards techniques. Un
développeur qui sait travailler sur un projet vitrine sait travailler sur le
Panel : mêmes fichiers de configuration, mêmes enveloppes d'API, même
discipline de secrets, même façon de déployer.

Toute divergence est soit un **écart justifié** (§8), soit un défaut à
corriger.

## 2. Stack

| Couche | Choix | Identique au projet vitrine |
|---|---|---|
| Runtime | Node.js ≥ 20 | ✅ |
| Serveur HTTP | Express 4 | ✅ |
| Modules | ESM (`"type": "module"`) | ✅ |
| Base de données | MongoDB | ✅ |
| ODM | Mongoose 8 | ✅ |
| Validation | Zod | ✅ |
| Auth | JWT HS256 (`jsonwebtoken`) | ✅ |
| Mots de passe | scrypt natif (`node:crypto`) | ⚠️ écart justifié (§8) |
| Frontend | React 18 + TypeScript strict + Vite 5 | ✅ |
| Routage front | react-router-dom 6 | ✅ |
| Tests | runners `node` autonomes, sans framework | ✅ |
| Mongo de test | `mongodb-memory-server` | ✅ |

Interdits : une seconde stack backend, un autre ORM, un autre système de base
de données, un framework frontend différent, une abstraction inutile.

## 3. Structure

```text
Panel/
├── backend/
│   ├── ecosystem.config.cjs      PM2 (aucun domaine ni port figé)
│   ├── scripts/                  utilitaires d'exploitation
│   └── src/
│       ├── config/               env.js (SEUL lecteur de process.env), db.js
│       ├── models/               schémas Mongoose
│       ├── services/             logique métier, par domaine
│       ├── controllers/          fins : validation + enveloppe
│       ├── routes/               montage et gardes
│       ├── middlewares/          auth, CORS, erreurs, version de contrat
│       ├── bridge/               miroir de contrat + ProjectBridgeClient
│       └── utils/                ApiError, apiResponse, logger, crypto, URLs
├── frontend/                     React + TS + Vite
├── deploy/                       moteur de déploiement (lib/ + deploy.mjs)
├── docs/
│   ├── architecture/             cette documentation
│   └── spec/                     copies des contrats OpenAPI (v1.1.0)
└── tests/                        suite unique, chaînée par run-all.js
```

Deux surfaces HTTP strictement séparées :

| Surface | Public | Authentification | Catalogue d'erreurs |
|---|---|---|---|
| `/bridge/v1/*` | les projets appairés | `bridgeToken` (Bearer) | `BRIDGE_*` |
| `/api/*` | le frontend du Panel | JWT utilisateur (Bearer) | `PANEL_*` |
| `/health` | public | aucune | — |

Un JWT utilisateur n'ouvre rien sur `/bridge/v1` ; un bridgeToken n'ouvre rien
sur `/api`. C'est testé dans les deux sens.

## 4. TEST / PROD

Identique au projet vitrine :

- `ENV` vaut `TEST` ou `PROD` — **aucune autre valeur**, jamais `NODE_ENV` ;
- une seule `MONGODB_URI` ; **seul le nom de la base change** :
  `ENV=TEST → DB_TEST`, `ENV=PROD → DB_PROD` ;
- la configuration est chargée et validée **au démarrage**, dans
  `config/env.js`, seul fichier autorisé à lire `process.env` (vérifié par
  `tests/architecture.test.js`) ;
- toute variable critique absente ou invalide **arrête le processus** avec un
  message clair — jamais un Panel mal configuré qui tourne quand même.

Détail complet : [24_ENVIRONMENT_AND_DOMAINS.md](24_ENVIRONMENT_AND_DOMAINS.md).

## 5. MongoDB

- connexion par `mongoose.connect(uri, { dbName })` — le nom de base est une
  **option**, jamais concaténé dans l'URI ;
- `strictQuery`, `serverSelectionTimeoutMS: 10 000` ;
- **l'URI n'est jamais journalisée** (elle peut porter des credentials) : les
  logs n'affichent que `ENV` et le nom de la base ;
- arrêt propre sur `SIGINT`/`SIGTERM` (fermeture du serveur puis de la
  connexion, sortie forcée après 10 s).

Collections du Panel : `panelprojects`, `panelusers`, `systemconfigurations`,
`panelsyncreceipts`, `panelsyncentitystates`, `panelsyncjournalentries`,
`panelcounters`, `paneldiagnostics`.

## 6. JWT et secrets

| Secret | Variable | Usage |
|---|---|---|
| Signature des sessions | `JWT_SECRET` | JWT HS256 des utilisateurs du Panel |
| Chiffrement au repos | `BRIDGE_ENCRYPTION_KEY` | AES-256-GCM sur la copie sortante des bridgeTokens |

Règles appliquées au démarrage (fail-closed) :

1. `JWT_SECRET` absent → refus ; placeholder connu → refus ; moins de 32
   caractères → **refus** (le projet vitrine se contente d'un avertissement :
   c'est un durcissement assumé, §8) ;
2. `JWT_EXPIRES_IN` absent ou invalide → refus ;
3. `BRIDGE_ENCRYPTION_KEY` ≠ 64 caractères hexadécimaux → refus ;
4. `BRIDGE_ENCRYPTION_KEY` égale à `JWT_SECRET` → refus (une clé par usage) ;
5. en PROD, des identifiants seed par défaut ou faibles → refus.

Discipline des secrets, sans exception :

- jamais en clair au repos : les codes d'appairage et les bridgeTokens sont
  stockés en **hash SHA-256** ; la copie sortante du bridgeToken est
  **chiffrée AES-256-GCM** ;
- jamais renvoyés par une API : la projection publique d'un projet ne contient
  ni hash, ni valeur chiffrée (vérifié par test) ;
- comparaisons en **temps constant** (`timingSafeEqual`) ;
- jamais dans un log, un test ou un rapport ;
- un seul point de déchiffrement nommé (`getOutboundBridgeToken`), réservé au
  `ProjectBridgeClient`.

## 7. Domaines, URLs, déploiement, santé

- **Domaines** : une source de vérité unique (configuration système en base),
  un résolveur canonique, une règle de priorité documentée. Aucun domaine
  codé en dur nulle part — vérifié par `tests/domains.test.js`.
- **CORS** : dérivé des URLs configurées + origines statiques du `.env`.
- **Déploiement** : releases versionnées, lien `current` atomique, chaîne de
  qualité bloquante avant toute action distante, `.env` distant relu après
  écriture, health local avant public, rollback par repointage du lien.
  Voir [07_DEPLOYMENT.md](07_DEPLOYMENT.md).
- **Santé / version** : `GET /health` (statut, ENV, état de la base) et
  `GET /api/version` (version logicielle, version de contrat, ENV, **URLs
  résolues et leur source**). C'est la page qui permet de vérifier, après un
  déploiement, que le domaine a bien été propagé.

## 8. Différences justifiées avec un Manager vitrine

Chaque écart conservé, et pourquoi.

| Sujet | Manager vitrine | Panel | Justification |
|---|---|---|---|
| **Rôle produit** | administre UN produit et son métier | administre UN PARC de projets | c'est la raison d'être du Panel |
| **Sens du pont** | sert `ProjectBridge`, consomme `PanelBridge` | sert `PanelBridge`, consomme `ProjectBridge` | symétrie contractuelle : les deux moitiés du même contrat |
| **Mots de passe** | bcrypt | scrypt natif (`node:crypto`) | aucune dépendance native à compiler ; scrypt est un KDF recommandé, paramétré (N=16384, r=8, p=1). Écart interne sans effet contractuel |
| **Clé de chiffrement** | `INTEGRATED_API_ENCRYPTION_KEY` (partagée avec l'IntegratedAPI) | `BRIDGE_ENCRYPTION_KEY` (dédiée) | le Panel n'a pas d'IntegratedAPI ; une clé par usage, et jamais partagée entre deux déploiements |
| **Robustesse du JWT** | avertissement si < 32 caractères | **refus de démarrer** | le Panel détient les credentials de TOUT le parc : son compromis serait systémique |
| **Seed PROD** | mot de passe aléatoire généré et journalisé | **refus de démarrer** avec des identifiants par défaut | même raison ; un secret journalisé reste un secret exposé |
| **URLs configurées** | `backendUrl`, `managerUrl`, `websiteUrl` | `backendUrl`, `frontendUrl` | le Panel n'a ni vitrine publique ni Manager séparé : deux URLs suffisent, et deux variables pour une même information seraient une source de contradiction |
| **Base de contrôle** | base `_control` dédiée au plan de contrôle du déploiement | absente | le Panel ne déploie pas les autres projets ; il n'a pas de plan de contrôle à isoler |
| **Moteur de déploiement** | pilote des déploiements distants depuis le Manager (SSH, DNS, duplication) | se déploie lui-même, sans piloter personne | le Panel n'est pas un outil de déploiement ; il observe les déploiements remontés par heartbeat |
| **Rate limiting** | présent sur les surfaces publiques | absent (code `BRIDGE_RATE_LIMITED` déjà au contrat) | lot de durcissement de Phase 3 ; le contrat le prévoit déjà, l'implémentation suivra |
| **CORS** | via `cors` (npm) | middleware interne (~30 lignes) | même comportement, une dépendance en moins ; les origines viennent de la même mécanique de configuration système |

Toute autre divergence constatée est un défaut, pas une décision.

## 9. Interdits

1. ❌ Une stack, un ORM ou un framework parallèle.
2. ❌ Une variable d'environnement lue ailleurs que dans `config/env.js`.
3. ❌ Un appel réseau vers un projet ailleurs que dans `ProjectBridgeClient`.
4. ❌ Un domaine, un port ou un chemin de déploiement codé en dur.
5. ❌ Un secret dans le dépôt, dans un log, dans un test ou dans un rapport.
6. ❌ Une dépendance du Panel envers le dépôt d'un projet (chemin local,
   import, hypothèse de structure).
7. ❌ Une logique spécifique à un projet nommé dans le code générique.
