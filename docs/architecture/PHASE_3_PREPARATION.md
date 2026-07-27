# Préparation de la Phase 3 — état après la Phase 2C

> Rédigé à la clôture de la **Phase 2C — audit de convergence et
> normalisation** (2026-07-27), qui a suivi la Phase 2B (squelette).
> Ce document dit : ce qui est livré, ce qui est volontairement absent, dans
> quel ordre l'aborder, et ce qui ne devra jamais bouger.

---

## 1. Ce qui est LIVRÉ

### Phase 2B — le squelette

| Livrable | Où |
|---|---|
| **Documentation du Panel** (vision, architecture, registre, ponts, auth, appairage, cycle de vie, déploiement, Manager Standard, capacités, modèle de données) | `docs/architecture/` |
| **Serveur PanelBridge** : ping, bootstrap, unpair, heartbeat, sync push/pull | `backend/src/routes/bridge.routes.js` + contrôleur + `syncCore.service.js` |
| **Client ProjectBridge** (driver sortant unique, timeouts, erreurs mappées) | `backend/src/bridge/ProjectBridgeClient.js` |
| **Registre des projets**, **appairage**, **auth Panel v1** (ADMIN/DEV, JWT, scrypt) | `backend/src/services/` |
| **Frontend** : connexion, dashboard, projets, états bridges/versions/pairings | `frontend/src/` |

### Phase 2C — la normalisation

| Livrable | Où |
|---|---|
| **Contrats alignés en v1.1.0** : copies verbatim des specs maîtresses, miroir exécutable à jour, `ProjectManifest` officiel, `GET /manifest` côté client, `manifest` optionnel au bootstrap | `docs/spec/`, `backend/src/bridge/` |
| **Gouvernance des contrats** : contrôle de conformité (specs ↔ code) et contrôle de dérive (copies ↔ specs maîtresses, avec retrait propre hors workspace) | `tests/bridge-conformity.test.js`, `tests/spec-drift.check.mjs` |
| **Environnement au standard vitrine** : `ENV=TEST/PROD`, `MONGODB_URI` commune + `DB_TEST`/`DB_PROD`, validation fail-closed complète | `backend/src/config/env.js` |
| **Secrets durcis** : `JWT_SECRET` (placeholder et secret court refusés), `JWT_EXPIRES_IN` validé, `BRIDGE_ENCRYPTION_KEY` dédiée, seed PROD verrouillé | `backend/src/config/env.js`, `backend/.env.example` |
| **Persistance MongoDB** : registre, utilisateurs, appairages, manifestes, heartbeats, idempotence, état LWW, journal de synchronisation | `backend/src/models/`, stores et services |
| **Configuration système des domaines** : singleton en base, résolveur canonique à priorité explicite, CORS dérivé, API DEV | `backend/src/services/network/`, `backend/src/middlewares/cors.middleware.js` |
| **Socle de déploiement** : configuration validée, `.env` distant construit et relu, Nginx généré en deux temps, releases + lien `current`, health local puis public, rollback, rétention, simulation | `deploy/` |
| **Documentation de normalisation** : Manager Standard réécrit, Panel Standard, Environnement & domaines | `docs/architecture/20`, `23`, `24` |
| **Tests** : 12 suites, 403 checks (configuration, domaines, persistance, architecture, déploiement, pont, conformité) | `tests/` |

## 2. Ce qui est VOLONTAIREMENT ABSENT — l'ordre conseillé

Par dépendance (chaque lot inclut ses tests et sa documentation) :

1. **Transport SSH du déploiement + recette VPS** : le plan est complet et
   testé, l'exécution distante reste à brancher. Premier lot, parce qu'il
   conditionne toute mise en ligne.
2. **Supervision lecture seule** : historique de heartbeats, écran de parc
   enrichi, dérive de versions du parc (`describeDrift` est prêt), alertes
   visuelles OFFLINE.
3. **Relecture périodique du Manifest** : le Panel sait lire
   `GET /manifest` ; reste à décider quand (au heartbeat ? à la demande ?) et
   à traiter le cas d'un Manifest qui change en cours de vie.
4. **Gestion des utilisateurs du Panel** (collaborateurs, invitation,
   désactivation) — toujours ADMIN/DEV ; le RBAC complet reste en Phase 4+.
5. **Premier domaine synchronisé — C1 (société développeur + équipe)** :
   schéma de payload `DEV_COMPANY`/`TEAM_MEMBER` dans les deux miroirs de
   contrat, module Panel d'édition, activation du journal d'émission,
   scénario de recette « débrancher puis tout utiliser » côté projet.
   Puis C2 (Brevo), C3 (templates), C4 (IntegratedAPI), C5 (accès Manager
   `{admin, dev}`), dans l'ordre de la roadmap écosystème.
6. **Durcissement de la surface** : rate limiting sur `/bridge/v1` (le code
   `BRIDGE_RATE_LIMITED` est déjà au contrat), rotation de bridgeToken avec
   fenêtre de transition (le projet modèle sait déjà la vivre côté projet),
   HTTPS obligatoire en PROD.

Et plus loin (Phase 4+, inchangé) : webhooks centralisés (D1),
contrats/factures (D2), événements/réunions (D3), RBAC (D4), statistiques
(D5).

## 3. Décisions qui engagent la suite

Prises en Phase 2B, toujours valables :

1. **Capabilities : catalogue additif, absent = rien, inconnu = toléré.**
   Ces règles sont testées ; les remettre en cause casserait la promesse de
   compatibilité des Manifests anciens.
2. **Jamais un secret en clair au repos.** Codes et mots de passe : hash
   seulement. bridgeToken : hash (vérification entrante) + copie AES-256-GCM
   (appel sortant), déchiffrée exclusivement par `ProjectBridgeClient`.
3. **La vivacité et les capacités interprétées ne sont jamais stockées**
   (fonctions pures) — la persistance ne les matérialise pas.
4. **Le champ `PanelUser.role` (ADMIN/DEV) est un point d'extension** : le
   RBAC futur le remplacera derrière les mêmes gardes, sans toucher ni au
   frontend v1 ni au contrat `{admin, dev}` des Managers.

Prises en Phase 2C :

5. **Le Manifest reçu par le pont fait foi.** La saisie manuelle est un
   canal de secours pour les projets en contrat `1.0.x` ; dès qu'un Manifest
   arrive par le pont, elle est refusée. Elle disparaîtra quand le parc
   entier sera en 1.1+.
6. **Une seule source de vérité par URL**, avec une règle de priorité
   explicite et observable (`GET /api/version` expose la source retenue).
   Ajouter une seconde variable pour la même information est un défaut.
7. **La clé de chiffrement du pont est distincte du secret de session**, et
   propre à chaque déploiement. Sa rotation impose un ré-appairage du parc :
   c'est documenté, assumé, et réservé aux compromissions.
8. **Le Panel se durcit au-delà du projet modèle sur les secrets** (refus de
   démarrer plutôt qu'avertissement) : il détient les credentials de tout le
   parc, son compromis serait systémique.
9. **Le déploiement propage le domaine, personne d'autre.** Un seul point
   d'écriture (`set-network-configuration.mjs`), avec relecture.

## 4. Ce qui ne devra JAMAIS être modifié

Verrouillé par `tests/bridge-conformity.test.js`,
`tests/architecture.test.js` et `tests/spec-drift.check.mjs` :

1. Les contrats n'évoluent que par ajouts (mineures), **ratifiés dans le
   projet modèle puis recopiés** — jamais l'inverse, jamais une édition
   locale des copies.
2. Les 5 règles de synchronisation, et rien au-delà.
3. `ProjectBridgeClient` est le seul point de contact sortant vers les
   projets ; la surface `/bridge/v1` le seul point d'entrée des projets.
4. `config/env.js` est le seul lecteur de `process.env`.
5. Le Panel ne connaît jamais le Mongo d'un projet, ne duplique pas, ne
   déploie pas, n'écrit pas une donnée locale.
6. Les Managers ne reçoivent que `{admin, dev}` : le RBAC du Panel ne descend
   pas dans les Managers.
7. Aucune logique spécifique à un projet nommé dans ce dépôt ; aucun domaine
   codé en dur ; aucune dépendance runtime vers le dépôt d'un projet.
8. UNCONFIGURED/STANDALONE est un état normal de première classe, des deux
   côtés de la frontière.
