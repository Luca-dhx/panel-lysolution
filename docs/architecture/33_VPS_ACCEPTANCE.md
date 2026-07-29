# 33 — Recette VPS : checklist de première mise en ligne

> **Recette à exécuter sur une cible réelle.** Elle n'a **pas** été exécutée :
> aucune cible n'a été fournie. Rien de ce document n'est un résultat — tout
> y est une vérification à faire.
> Établi en Phase 2E (LOT 7). Statut réexaminé en Phase 4 (LOT 7).

---

## 1. Statut

| | Phase 2E | Phase 4 |
|---|---|---|
| Cible fournie | ❌ aucune | ❌ aucune |
| Recette exécutée | ❌ non | ❌ non |
| Environnement autorisé | **TEST uniquement** | **TEST uniquement** |

Le moteur est prêt et testé hors ligne (transports simulés, MongoDB en
mémoire, duplication réelle). Ce qui reste non prouvé, c'est le
comportement face à un **vrai serveur** : SSH, certbot, PM2, DNS, pare-feu.

Ces éléments dépendent d'une infrastructure, pas du code. Ils ne peuvent pas
être « validés par anticipation », et ce document ne le prétend pas.

### 1.1 Ce que la Phase 4 a changé — et ce qu'elle n'a pas changé

La Phase 4 a établi que le **protocole** fonctionne réellement : deux
backends distincts, deux bases, appairage, découverte, synchronisation
bidirectionnelle, convergence et reconnexion après coupure, le tout par HTTP
réel (`58_END_TO_END_TESTS.md`).

Cela **ne déplace pas** le statut de cette recette. Le test d'écosystème
tourne sur `127.0.0.1` : il n'établit rien sur le DNS, les certificats,
nginx, PM2 ou un pare-feu. Un protocole prouvé et un hébergement prouvé sont
deux choses différentes, et confondre les deux serait exactement l'erreur que
ce document existe pour empêcher.

**La recette reste donc ouverte.** Elle le restera tant qu'une cible réelle
n'aura pas été fournie.

## 2. Prérequis à fournir

Avant toute recette, ces informations doivent être communiquées explicitement :

| Élément | Exemple | Obligatoire |
|---|---|---|
| Domaine de recette | `panel-test.exemple.com` | ✅ |
| Adresse du serveur | IPv4 ou nom | ✅ |
| Utilisateur SSH | `root` ou utilisateur sudo | ✅ |
| Port SSH | 22 par défaut | — |
| Mot de passe SSH | via `DEPLOY_SSH_PASSWORD`, jamais en argument | ✅ |
| Port backend local | ex. 4100 | ✅ |
| URI MongoDB accessible depuis le serveur | — | ✅ |
| Environnement | **`TEST`** | ✅ |

## 3. Checklist serveur

### 3.1 DNS

- [ ] l'enregistrement A du domaine pointe vers l'IP du serveur ;
- [ ] l'enregistrement A de `api.<domaine>` pointe vers la même IP ;
- [ ] la propagation est effective (`dig +short <domaine>`) ;
- [ ] si le domaine est sous une base wildcard gérée, le certificat wildcard
      existe déjà — sinon un certificat dédié sera émis.

### 3.2 SSH et utilisateur

- [ ] la connexion SSH aboutit avec les identifiants fournis ;
- [ ] l'utilisateur peut exécuter `sudo` sans mot de passe interactif
      (le moteur exécute `sudo nginx -t`, `sudo systemctl reload nginx`) ;
- [ ] le répertoire racine des déploiements (`/var/www` par défaut) est
      accessible en écriture ;
- [ ] au moins 500 Mo d'espace disque libre.

### 3.3 Logiciels

- [ ] `node` ≥ 20 installé ;
- [ ] `npm` installé ;
- [ ] `nginx` installé et actif ;
- [ ] `pm2` installé globalement ;
- [ ] `certbot` installé ;
- [ ] `/var/www/certbot` existe (webroot du challenge ACME).

Le préflight du moteur contrôle tout cela et **refuse** le déploiement si un
élément requis manque.

### 3.4 MongoDB

- [ ] l'URI est joignable **depuis le serveur** (pas seulement depuis le
      poste de développement) ;
- [ ] l'utilisateur de base a les droits d'écriture ;
- [ ] la base `DB_TEST` est renseignée dans le `.env` ;
- [ ] si Mongo est hébergé ailleurs, l'IP du serveur est autorisée.

### 3.5 Pare-feu

- [ ] port **80** ouvert (challenge ACME, redirection) ;
- [ ] port **443** ouvert (HTTPS) ;
- [ ] port **22** ouvert depuis le poste qui déploie ;
- [ ] le port backend local (ex. 4100) **fermé** de l'extérieur : il n'est
      atteint que par le proxy Nginx local.

### 3.6 Secrets

- [ ] le `.env` de la cible porte des secrets **propres à cet
      environnement** — jamais ceux du poste de développement
      ([24](24_ENVIRONMENT_AND_DOMAINS.md) §5) ;
- [ ] `JWT_SECRET` et `BRIDGE_ENCRYPTION_KEY` générés pour cette cible ;
- [ ] aucun secret dans un argument de commande ni dans un journal.

## 4. Déroulé de la recette

### Étape 1 — Simulation (obligatoire, sans risque)

```bash
node deploy/deploy.mjs --host <domaine> --env TEST \
  --ssh-host <serveur> --port <port>
```

- [ ] le plan s'affiche intégralement ;
- [ ] les URLs dérivées sont celles attendues ;
- [ ] `validate.env` passe (toutes les variables vitales présentes) ;
- [ ] aucun secret n'apparaît dans la sortie.

### Étape 2 — Préflight seul

- [ ] tous les contrôles requis passent ;
- [ ] les avertissements sont compris et acceptés.

### Étape 3 — Déploiement réel

```bash
DEPLOY_SSH_PASSWORD=… node deploy/deploy.mjs --execute \
  --host <domaine> --env TEST --ssh-host <serveur> --port <port>
```

- [ ] la chaîne de qualité locale passe (lint, typecheck, tests, build) ;
- [ ] l'artefact est transféré ;
- [ ] les dépendances s'installent sur le serveur ;
- [ ] le `.env` distant est écrit **puis relu** sans variable manquante ;
- [ ] Nginx HTTP est appliqué, `nginx -t` passe ;
- [ ] le certificat est émis ;
- [ ] Nginx HTTPS est appliqué, `nginx -t` passe ;
- [ ] le lien `current` est basculé ;
- [ ] PM2 démarre le service et `pm2 save` persiste la liste ;
- [ ] la santé **locale** répond avant toute exposition ;
- [ ] le domaine est écrit dans la configuration système, avec relecture ;
- [ ] la santé **publique** répond.

### Étape 4 — Vérifications applicatives

- [ ] `https://<domaine>/health` → `status: ok`, `env: TEST`,
      `database: connected` ;
- [ ] `https://<domaine>/api/version` → version attendue,
      `urls.backendUrlSource: "SYSTEM_CONFIGURATION"` ;
- [ ] `https://api.<domaine>/health` répond (proxy dédié) ;
- [ ] l'interface se charge et la connexion fonctionne ;
- [ ] le certificat est valide dans un navigateur ;
- [ ] HTTP redirige bien vers HTTPS.

### Étape 5 — Recette du rollback

Le rollback exige **deux** releases : déployer une seconde fois avant de le
tester.

```bash
node deploy/deploy.mjs --rollback --ssh-host <serveur> --host <domaine> \
  --env TEST --port <port>        # simulation
DEPLOY_SSH_PASSWORD=… node deploy/deploy.mjs --execute --rollback …
```

- [ ] les releases disponibles sont listées, l'active identifiée ;
- [ ] l'intégrité de la cible est vérifiée avant bascule ;
- [ ] `current` est repointé ;
- [ ] le service redémarre ;
- [ ] la santé est confirmée ;
- [ ] la version servie est bien l'ancienne.

### Étape 6 — Recette de la rétention

- [ ] après plusieurs déploiements, seules les N dernières releases restent.

## 5. Ce qui ne doit PAS être fait en recette

1. ❌ déployer en `PROD` ;
2. ❌ pointer la recette sur une base de production ;
3. ❌ réutiliser les secrets d'un autre environnement ;
4. ❌ passer un mot de passe en argument de ligne de commande ;
5. ❌ ignorer un échec de préflight avec un contournement.

## 6. En cas d'échec

Le moteur refuse les demi-déploiements : à la première étape critique en
échec, il s'arrête et laisse l'état précédent en place.

| Symptôme | Piste |
|---|---|
| `PREFLIGHT_FAILED` | un prérequis serveur manque — voir §3 |
| `NGINX_CONFIG_INVALID` | le lien `sites-enabled` a été retiré automatiquement ; la configuration fautive reste dans `sites-available` pour diagnostic |
| `ENV_WRITE_INCOMPLETE` | une variable vitale manque dans le `.env` local |
| `HEALTH_LOCAL_FAILED` | le service ne démarre pas — consulter les journaux PM2 |
| `WILDCARD_CERT_MISSING` | la cible est un sous-domaine d'une base wildcard dont le certificat n'existe pas |
| `ROLLBACK_RELEASE_CORRUPT` | la release visée est incomplète — le moteur n'a rien touché |

## 7. À l'issue de la recette

Compléter ce document avec :

- la date, la cible et l'environnement ;
- les cases réellement cochées ;
- les écarts constatés et leur traitement ;
- la durée du déploiement.

Tant que cette section n'est pas remplie, le moteur reste **« validé hors
ligne, non éprouvé en production »**.
