# 07 — Déploiement : le Panel se déploie comme un projet

> Prérequis : [00_VISION.md](00_VISION.md) §2 (règle « le Panel est un projet
> standard »).

---

## 1. La règle

> **Il n'existe qu'UN moteur de déploiement dans l'écosystème.** Celui des
> projets. Le Panel l'utilise pour se déployer lui-même — il n'a pas de
> pipeline à part, et il ne déploie jamais les autres projets.

Deux conséquences immédiates :

- toute amélioration du moteur (faite pour les projets) profite au Panel, et
  réciproquement ;
- un développeur qui sait déployer un projet sait déployer le Panel — même
  assistant, mêmes rapports, mêmes backups.

## 2. Phase 2B : développement local uniquement

Le squelette se lance en local, sans aucune dépendance d'infrastructure :

| Composant | Commande | Port |
|---|---|---|
| backend | `cd backend && npm run dev` | `PANEL_PORT` (4100) |
| frontend | `cd frontend && npm run dev` | 5273 (proxy `/api`, `/health` → 4100) |

Le backend démarre **toujours** : pas de connexion réseau ou base au boot,
stores en mémoire, compte seed lu depuis `.env`. C'est la même discipline que
les projets (le serveur démarre quoi qu'il arrive ; le reste est best-effort).

### Variables d'environnement (backend/.env)

| Variable | Rôle |
|---|---|
| `PANEL_ENV` | `TEST` \| `PROD` — ENV applicatif du Panel (fail-closed) |
| `PANEL_PORT` | port HTTP (défaut 4100) |
| `PANEL_NAME` | nom d'affichage du Panel (renvoyé au bootstrap) |
| `PANEL_PUBLIC_URL` | URL publique du Panel (info, supervision) |
| `PANEL_JWT_SECRET` | signature des JWT utilisateurs (fail-closed) |
| `PANEL_ENCRYPTION_KEY` | clé AES-256-GCM (hex 64) — chiffrement au repos des bridgeTokens (fail-closed) |
| `PANEL_SEED_DEV_EMAIL` / `PANEL_SEED_DEV_PASSWORD` | compte DEV seed |
| `PANEL_HEARTBEAT_INTERVAL_S` | intervalle attendu des heartbeats (défaut 300) |
| `PANEL_PAIRING_CODE_TTL_S` | durée de vie d'un code d'appairage (défaut 900) |

Comme dans les projets : `config/env.js` est le seul lecteur de
`process.env`, et les variables critiques manquantes arrêtent le processus
avec un message clair (fail-closed) plutôt que de laisser tourner un Panel
mal configuré.

## 3. Cible (phases suivantes)

| Sujet | Cible |
|---|---|
| Domaine | `panel.ly-solution.com` |
| Moteur | le moteur de déploiement standard de l'écosystème, partagé avec les projets (stratégie de partage décidée en Phase 1 côté projet modèle) |
| ENV | deux environnements applicatifs `TEST`/`PROD`, bases Mongo dédiées au Panel |
| Supervision | le Panel s'auto-supervise avec les mêmes briques que celles qu'il offre aux projets (santé, version, rapports) |
| TLS / réseau | HTTPS obligatoire en PROD — les bridgeTokens ne transitent jamais en clair |

Le moteur n'est **pas** embarqué dans ce squelette : l'intégrer est un lot de
Phase 3 ([PHASE_3_PREPARATION.md](PHASE_3_PREPARATION.md)), qui consistera à
brancher le moteur standard, pas à en écrire un.

## 4. Interdits

1. ❌ Un pipeline de déploiement propre au Panel, divergent de celui des
   projets.
2. ❌ Le Panel qui déploie un projet (le moteur de CHAQUE projet déploie ce
   projet — le Panel, au mieux, observera les déploiements remontés par
   heartbeat).
3. ❌ Un démarrage qui dépend d'un service externe (base, réseau, autre
   projet).
4. ❌ Des secrets de production dans le dépôt — `.env` est local,
   `.env.example` est le seul fichier versionné.
