# 04 — Authentification : les trois plans

> Prérequis : [00_VISION.md](00_VISION.md).
> Le Panel manipule trois familles d'identités qui ne se croisent jamais.

---

## 1. Vue d'ensemble

```
 PLAN 1 · utilisateurs du Panel        PLAN 2 · projets appairés
 (nos collaborateurs)                  (machines)
 ┌──────────────────────────┐          ┌──────────────────────────┐
 │ email + mot de passe     │          │ bridgeToken              │
 │ → JWT du Panel           │          │ (un par projet)          │
 │ → surface /api           │          │ → surface /bridge/v1     │
 └──────────────────────────┘          └──────────────────────────┘

 PLAN 3 · accès Manager émis par le Panel  (Phase 3 — lot C5)
 ┌───────────────────────────────────────────────────────────────┐
 │ le Panel calcule { admin: bool, dev: bool } pour              │
 │ (utilisateur, projet) — le Manager n'apprend JAMAIS un rôle   │
 └───────────────────────────────────────────────────────────────┘
```

Un JWT utilisateur n'ouvre rien sur `/bridge/v1` ; un bridgeToken n'ouvre
rien sur `/api`. Les deux middlewares sont distincts et ne partagent aucun
secret.

## 2. Plan 1 — Les utilisateurs du Panel (v1)

Volontairement minimal — le RBAC complet reste en Phase 4+ :

- **Deux rôles internes** : `ADMIN` et `DEV`. `DEV` est un superset (même
  principe que dans les Managers). Les gardes : `requirePanelUser` puis
  `requirePanelDev` pour les actions sensibles (déclarer un projet, générer
  un code, révoquer, éditer un Manifest).
- **Compte seed** : au démarrage, un compte `DEV` est créé depuis
  `SEED_DEV_EMAIL` / `SEED_DEV_PASSWORD`, **uniquement si la base ne contient
  aucun utilisateur** (un compte réel n'est jamais écrasé). Sans ces
  variables, le serveur démarre mais l'API d'auth refuse toute connexion.
  En **PROD**, des identifiants par défaut connus ou un mot de passe de moins
  de 12 caractères **empêchent le démarrage** — aucune combinaison de
  développement ne peut devenir une valeur de production
  ([24_ENVIRONMENT_AND_DOMAINS.md](24_ENVIRONMENT_AND_DOMAINS.md) §6).
- **Mots de passe** : scrypt (crypto natif Node), jamais en clair, jamais
  journalisés ; la projection publique d'un utilisateur ne contient pas le
  hash.
- **Jetons** : JWT HS256 signé `JWT_SECRET`, durée `JWT_EXPIRES_IN`, porté en
  `Authorization: Bearer` par le frontend. `POST /api/auth/login`,
  `GET /api/auth/me`. Le secret est validé au démarrage (placeholder ou
  secret de moins de 32 caractères refusés) ; le changer invalide toutes les
  sessions en cours.
- **Persistance MongoDB** (collection `panelusers`) : les comptes survivent
  au redémarrage et le seed est idempotent. La gestion des collaborateurs
  (invitation, désactivation) reste un lot de Phase 3.

### Le futur : RBAC

Le RBAC complet (rôles multiples, permissions par projet et par module) est un
chantier de Phase 4+. Il évoluera **librement** côté Panel : c'est tout
l'intérêt du plan 3 — quelle que soit sa sophistication, il se réduira
toujours à deux booléens par (utilisateur, projet). Rien dans le squelette ne
préjuge de sa forme ; les rôles v1 `ADMIN`/`DEV` sont une valeur de départ,
pas une contrainte.

## 3. Plan 2 — Les projets (bridgeToken)

- Délivré au **bootstrap** ([05_PAIRING.md](05_PAIRING.md)) : 256 bits
  aléatoires, montrés une seule fois, au projet uniquement.
- Côté Panel, deux formes au repos, aucune en clair : le **hash SHA-256**
  (vérification en temps constant des requêtes entrantes du projet) et une
  **copie chiffrée AES-256-GCM** (`BRIDGE_ENCRYPTION_KEY`), déchiffrée
  uniquement par `ProjectBridgeClient` pour s'authentifier auprès du
  ProjectBridge — le même secret sert les deux sens, comme côté projet.
  Aucune API du Panel ne peut réafficher un token — c'est une propriété, pas
  une limitation.
- **Un token par projet**, révocable individuellement : un projet compromis ne
  compromet ni le Panel ni les autres projets.
- Le même token authentifie les deux sens (le projet vers `/bridge/v1`, le
  Panel vers le ProjectBridge du projet). Une révocation ferme tout.
- Jamais dans les logs, jamais dans une réponse d'API interne, jamais dans un
  rapport.

## 4. Plan 3 — L'accès Manager `{admin, dev}` (Phase 3, contrat figé ici)

Le Panel ajoutera un chemin d'accès aux Managers pour nos collaborateurs : le
Panel authentifie l'utilisateur, calcule **deux booléens** pour (utilisateur,
projet), et le projet honore cette autorisation en la vérifiant avec le
secret d'appairage qu'il détient déjà. Ce qui est figé dès maintenant, et ne
changera jamais :

1. Le Manager reçoit `{ admin: bool, dev: bool }` — **jamais** un rôle, une
   liste de permissions ou un « profil Panel ».
2. Le jeton est vérifiable avec le **bridgeToken existant** : aucun canal
   supplémentaire, aucune clé du Panel à distribuer ; révoquer l'appairage
   invalide immédiatement tous les jetons émis.
3. Les comptes locaux des projets (ADMIN client, DEV de secours) subsistent
   intégralement — le Panel ajoute un chemin, il n'en retire aucun.

Le squelette ne l'implémente pas (lot C5) ; il garantit seulement de ne rien
construire qui l'empêche.

## 5. Interdits

1. ❌ Transmettre un rôle du Panel à quiconque hors du Panel.
2. ❌ Un secret partagé entre plusieurs projets.
3. ❌ Stocker un secret en clair : mots de passe et codes en hash seulement ;
   bridgeToken en hash + copie chiffrée (jamais réversible hors du
   `ProjectBridgeClient`).
4. ❌ Mélanger les gardes : une route `/api` protégée par bridgeToken, ou une
   route `/bridge/v1` protégée par JWT.
5. ❌ Faire dépendre la connexion au Panel d'un service externe — l'auth v1
   est locale et le reste.
