# 07 — Déploiement : le Panel se déploie comme un projet

> Prérequis : [00_VISION.md](00_VISION.md) §2, [23_PANEL_STANDARD.md](23_PANEL_STANDARD.md),
> [24_ENVIRONMENT_AND_DOMAINS.md](24_ENVIRONMENT_AND_DOMAINS.md).
> Code : `deploy/` (bibliothèque + assistant), `backend/scripts/`.

---

## 1. Les règles

1. **Le Panel se déploie lui-même, et ne déploie personne.** Le moteur de
   chaque projet déploie ce projet ; le Panel, au mieux, observe les
   déploiements remontés par heartbeat.
2. **Rien n'est déployé qui n'ait passé la chaîne de qualité** : lint,
   typecheck, tests, build — en local, avant toute action distante.
3. **Le domaine choisi alimente tout** : Nginx, le `.env` distant, le CORS,
   la configuration système en base. Aucune édition manuelle dispersée.
4. **Aucun secret dans le dépôt.** Les secrets du `.env` distant viennent du
   `.env` local ; ils ne sont ni commités, ni journalisés.
5. **Simulation par défaut.** `deploy.mjs` affiche le plan complet et
   n'exécute rien ; un déploiement réel exige `--execute` et une instruction
   explicite.

## 2. Développement local

| Composant | Commande | Port |
|---|---|---|
| backend | `cd backend && npm run dev` | `PORT` (4100) |
| frontend | `cd frontend && npm run dev` | 5273 (proxy `/api`, `/health` → 4100) |

Le backend exige désormais une MongoDB joignable au démarrage (c'est la
discipline du projet vitrine : la base fait partie du socle, pas des options).
Les tests, eux, n'exigent aucun service : ils démarrent un MongoDB en mémoire.

Variables : voir [24_ENVIRONMENT_AND_DOMAINS.md](24_ENVIRONMENT_AND_DOMAINS.md) §1.
`config/env.js` est le seul lecteur de `process.env`, et toute variable
critique manquante arrête le processus avec un message clair.

## 3. Configuration d'un déploiement

Fichier `deploy/deploy.config.json` — **non commité** (modèle :
`deploy.config.example.json`) :

```json
{
  "host": "panel.exemple.com",
  "environment": "PROD",
  "sshHost": "203.0.113.10",
  "sshUser": "root",
  "backendPort": 4100,
  "remoteRoot": "/var/www",
  "keepReleases": 5
}
```

Chaque valeur est validée avant toute action : `host` doit être un nom d'hôte
pleinement qualifié (ni protocole, ni port, ni chemin), `environment` vaut
`TEST` ou `PROD`, `backendPort` est un entier positif, `keepReleases` ≥ 1.
Les options de ligne de commande (`--host`, `--env`, `--ssh-host`, `--port`)
priment sur le fichier.

**Aucun domaine n'est figé dans le code.** `panel.ly-solution.com` est une
cible probable, pas une constante : c'est la configuration de déploiement qui
la porte.

## 4. Arborescence distante

```text
/var/www/<host>/
├── releases/
│   ├── 20260727-1042-abc1234/    ← release précédente (conservée)
│   └── 20260727-1530-def5678/    ← nouvelle release
├── current -> releases/20260727-1530-def5678
└── shared/
    └── .env                      ← secrets, hors des releases
```

Le `.env` vit dans `shared/` : il survit aux déploiements et n'est jamais
copié dans une release. Chaque release y est reliée par lien symbolique.

## 5. Le plan de déploiement — 15 étapes

| # | Étape | Ce qu'elle garantit |
|---|---|---|
| 1 | `validate.env` | le `.env` distant est complet **avant** toute action ; une variable obligatoire absente arrête tout |
| 2 | `quality.lint` | typage du frontend |
| 3 | `quality.typecheck` | typage strict |
| 4 | `quality.tests` | suite backend complète |
| 5 | `artifact.build` | build de production du frontend |
| 6 | `artifact.upload` | transfert de la release |
| 7 | `release.install` | dossiers, lien vers le `.env` partagé, `npm ci --omit=dev` |
| 8 | `nginx.http` | configuration HTTP seule (le certificat n'existe pas encore) |
| 9 | `https.certificate` | émission ou renouvellement Let's Encrypt (webroot ACME) |
| 10 | `nginx.https` | configuration HTTPS complète, rechargement après `nginx -t` |
| 11 | `service.start` | **bascule atomique** du lien `current`, puis démarrage PM2 |
| 12 | `health.local` | santé du backend en local, **avant** exposition |
| 13 | `runtime.network` | le domaine est écrit dans la configuration système (avec relecture) |
| 14 | `health.public` | santé publique + `/api/version` : l'ENV et le domaine publiés sont ceux attendus |
| 15 | `releases.prune` | conservation des `keepReleases` dernières |

L'ordre porte les garanties : le certificat précède la configuration HTTPS,
la santé locale précède l'exposition publique, le domaine est écrit en base
avant le contrôle public, la purge arrive en dernier.

### Le point de non-retour

Tout ce qui précède `service.start` est réversible sans toucher à la release
active : la nouvelle release est installée **à côté**. La bascule du lien
symbolique est l'unique instant où le trafic change de version.

## 6. Le `.env` distant

Construit à partir du `.env` **local** (les secrets ne transitent jamais par
le dépôt), avec réécriture des valeurs dépendantes de l'hôte :

| Variable | Origine |
|---|---|
| `ENV`, `PORT`, `PUBLIC_URL`, `CORS_ORIGINS` | **imposées par le déploiement** (dérivées du domaine et de la configuration) |
| `MONGODB_URI`, `DB_TEST`, `DB_PROD`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `BRIDGE_ENCRYPTION_KEY` | reprises verbatim du `.env` local |
| `PANEL_SKIP_DOTENV`, `PANEL_DEBUG` | **jamais transportées** (purement locales) |

Après écriture, le fichier est **relu** et vérifié : `ENV`, `PORT`,
`MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `BRIDGE_ENCRYPTION_KEY` et la
base correspondant à l'`ENV` doivent être présents et non vides. Sinon, le
déploiement s'arrête **avant** de démarrer le service.

> ⚠️ Les secrets du serveur cible doivent lui être **propres**. Reprendre le
> `.env` local est un raccourci acceptable pour un premier déploiement de
> recette ; en production, poser un `.env` dédié sur le serveur avec ses
> propres secrets (voir [24](24_ENVIRONMENT_AND_DOMAINS.md) §5 et §7).

## 7. Nginx

Généré en deux temps, déterministe, dérivé du seul domaine :

1. **HTTP seul** — port 80, sert `/.well-known/acme-challenge/` : nécessaire
   car une configuration HTTPS référencerait un certificat inexistant ;
2. **HTTPS complet** — redirection 301 depuis HTTP, `listen 443 ssl`,
   frontend statique en racine, proxy vers le backend pour `/api/`,
   `/bridge/` et `/health`.

Politique de cache : `index.html` en `no-cache` (sans quoi un navigateur
continuerait de charger les assets de la release précédente), `/assets/` en
`immutable` un an (les noms sont versionnés par le build), repli SPA sur
`index.html`.

Chaque fichier généré porte une bannière `# Généré par le moteur de
déploiement du Panel L.Y Solution` — elle permet de refuser d'écraser la
configuration d'un autre site. `nginx -t` valide avant tout rechargement.

## 8. Runtime

PM2, déclaré par `backend/ecosystem.config.cjs` : un processus, redémarrage
automatique, `max_restarts` borné. Le fichier ne fige **ni domaine, ni port,
ni environnement** — ils arrivent par `--update-env`. Les secrets ne sont pas
dupliqués dans la configuration PM2 : `config/env.js` lit le `.env`.

## 9. Contrôles de santé

| Contrôle | Cible | Vérifie |
|---|---|---|
| local | `http://127.0.0.1:<port>/health` | le service répond avant d'être exposé (8 tentatives, 2 s) |
| public | `https://<host>/health` | Nginx, TLS et le proxy fonctionnent (5 tentatives, 3 s) |
| version | `https://<host>/api/version` | l'`ENV` publié et le domaine résolu sont ceux attendus |

`GET /api/version` expose `urls.backendUrl` **et sa source** : après un
déploiement, `backendUrlSource: "SYSTEM_CONFIGURATION"` confirme que le
domaine a bien été propagé en base, et non simplement deviné depuis le `.env`.

## 10. Rollback

```bash
node deploy/deploy.mjs --rollback --to 20260727-1042-abc1234
```

Le plan vérifie d'abord que la release cible **existe**, repointe `current`,
redémarre le service, puis contrôle la santé. Aucune donnée n'est touchée :
les migrations Mongo relèvent de leur propre lot, et un rollback applicatif
ne les défait pas.

Rétention : les `keepReleases` dernières (5 par défaut) restent disponibles
sur le serveur.

## 11. Simulation

```bash
node deploy/deploy.mjs --host panel-recette.exemple.net --env TEST
```

Affiche le plan complet — commandes distantes exactes, fichiers générés,
contrôles de santé — et **n'exécute rien**. Les valeurs sensibles affichées
sont systématiquement remplacées par `«redacted»` : ni `JWT_SECRET`, ni clé
de chiffrement, ni URI Mongo n'apparaissent dans la sortie (vérifié par
`tests/deploy.test.js`).

## 12. État actuel et reste à faire

| Élément | État |
|---|---|
| Validation de configuration, dérivation des URLs | ✅ livré et testé |
| Construction et validation du `.env` distant | ✅ livré et testé |
| Génération Nginx (HTTP puis HTTPS) | ✅ livré et testé |
| Plan complet, ordre, atomicité, rollback, rétention | ✅ livré et testé |
| Chaîne de qualité locale bloquante | ✅ livré |
| Propagation du domaine en base | ✅ livré et testé |
| Masquage des secrets | ✅ livré et testé |
| **Transport SSH (exécution distante réelle)** | ⏳ **à brancher** — le plan est complet, l'exécution exige un serveur cible et une instruction explicite |
| **Recette sur VPS** | ⏳ certificat réel, PM2 réel, DNS, rechargement Nginx, rollback réel |

Rien n'a été déployé : aucune instruction en ce sens n'a été donnée.

## 13. Interdits

1. ❌ Un pipeline propre au Panel qui divergerait du standard vitrine sans
   justification documentée.
2. ❌ Le Panel qui déploie un projet.
3. ❌ Un domaine, un chemin ou un nom de service codé en dur.
4. ❌ Des secrets dans le dépôt — `.env` est local, `.env.example` est le seul
   fichier versionné ; `deploy.config.json` est ignoré, seul l'exemple est
   versionné.
5. ❌ Démarrer le service avant d'avoir vérifié la santé locale.
6. ❌ Écraser la configuration Nginx d'un site qui n'a pas été généré par ce
   moteur.
