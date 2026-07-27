# Préparation de la Phase 3 — état après la Phase 2B

> Rédigé à la clôture de la **Phase 2B — squelette du Panel** (2026-07-26).
> Ce document dit : ce qui est livré, ce qui est volontairement absent, dans
> quel ordre l'aborder, et ce qui ne devra jamais bouger.

---

## 1. Ce qui est LIVRÉ (Phase 2B)

| Livrable | Où |
|---|---|
| **Documentation du Panel** (vision, architecture, registre, ponts, auth, appairage, cycle de vie, déploiement, Manager Standard, Capabilities, modèle de données) | `docs/architecture/` |
| **Copies des contrats OpenAPI v1.0.0** + règles de gouvernance des copies | `docs/spec/` |
| **Miroir exécutable du contrat** (version, routes, erreurs, entityTypes, schémas zod stricts) | `backend/src/bridge/bridgeContract.js` |
| **Serveur PanelBridge v1.0.0** : ping, bootstrap, unpair, heartbeat, sync push/pull (DIAGNOSTIC appliqué, types réservés rejetés proprement, anti-écho, curseur opaque) | `backend/src/routes/bridge.routes.js` + contrôleur + `syncCore.service.js` |
| **Client ProjectBridge** (driver sortant unique, timeouts, erreurs mappées) | `backend/src/bridge/ProjectBridgeClient.js` |
| **Registre des projets** (fiches, unicité, API interne) | `backend/src/services/registry/` |
| **Appairage** (codes usage unique + TTL, hashes seuls en store, bootstrap, révocation, ré-appairage) | `backend/src/services/pairing/` |
| **Manifest + Capabilities** (schéma, catalogue v1, interprétation, lecteur tolérant) | `backend/src/services/manifest/` |
| **Compatibilité de versions** (semver, même-majeure, dérive du parc) | `backend/src/services/versioning/` |
| **Auth Panel v1** (ADMIN/DEV, JWT, scrypt, seed fail-closed) | `backend/src/services/auth/` |
| **Frontend** : connexion, dashboard, projets, états bridges/versions/pairings | `frontend/src/` |
| **Tests** (registre, manifest, capabilities, versions, surface HTTP du pont, conformité specs↔code) | `tests/` |

Volontairement minimal : stores **en mémoire** (interfaces stables), journal
de sync **vide**, aucun module métier, aucun appel sortant en tâche de fond.

## 2. Ce qui est VOLONTAIREMENT ABSENT — l'ordre conseillé pour la Phase 3

Par dépendance (chaque lot inclut ses tests et sa documentation) :

1. **Persistance Mongo du Panel** : adaptateurs pour `registryStore`,
   utilisateurs, journal de sync et écritures reçues (bases TEST/PROD propres
   au Panel), rétention des tombstones. Aucune API de service ne change.
2. **Supervision lecture seule** (lot B3 de la roadmap écosystème) :
   historique de heartbeats, écran de parc enrichi, dérive de versions
   (`versionCompatibility.driftReport` est prêt), alertes visuelles OFFLINE.
3. **Ratification du transport de Manifest** (contrat 1.1.0, additif) :
   champ optionnel `manifest` dans `BootstrapRequest` et `Heartbeat` — à
   ratifier DANS LE PROJET MODÈLE d'abord (specs maîtresses), puis recopier
   ici, puis implémenter des deux côtés. Jusque-là, canal déclaratif
   `PUT /api/projects/:id/manifest`.
4. **Gestion des utilisateurs du Panel** (collaborateurs, invitation,
   désactivation) — toujours ADMIN/DEV ; le RBAC complet reste en Phase 4+.
5. **Premier domaine synchronisé — C1 (société développeur + équipe)** :
   schéma de payload `DEV_COMPANY`/`TEAM_MEMBER` dans les deux miroirs de
   contrat, module Panel d'édition, activation du journal d'émission,
   scénario de recette « débrancher puis tout utiliser » côté projet.
   Puis C2 (Brevo), C3 (templates), C4 (IntegratedAPI), C5 (accès Manager
   `{admin, dev}`), dans l'ordre de la roadmap écosystème.
6. **Intégration du moteur de déploiement standard** : le Panel se déploie
   sur `panel.ly-solution.com` avec le moteur partagé — on branche, on
   n'écrit pas.
7. **Durcissement de la surface** : rate limiting sur `/bridge/v1` (le code
   `BRIDGE_RATE_LIMITED` est déjà au contrat), rotation de bridgeToken avec
   fenêtre de transition (le projet modèle sait déjà la vivre côté projet),
   HTTPS obligatoire en PROD.

Et plus loin (Phase 4+, inchangé par rapport à la roadmap écosystème) :
webhooks centralisés (D1), contrats/factures (D2), événements/réunions (D3),
RBAC (D4), statistiques (D5).

## 3. Décisions prises en Phase 2B qui engagent la suite

1. **Le Manifest est déclaratif tant que le contrat 1.1 n'est pas ratifié.**
   Le Panel n'invente pas un canal parallèle ; il attend la ratification dans
   le projet modèle. (Interdit : modifier les copies de specs localement.)
2. **Capabilities : catalogue additif, absent = false, inconnu = toléré.**
   Ces règles sont testées ; les remettre en cause casserait la promesse de
   compatibilité des Manifests anciens.
3. **Jamais un secret en clair au repos.** Codes et mots de passe : hash
   seulement. bridgeToken : hash (vérification entrante) + copie AES-256-GCM
   (appel sortant), déchiffrée exclusivement par `ProjectBridgeClient`. La
   persistance Mongo de Phase 3 hérite telle quelle de cette règle.
4. **La vivacité et les capabilities interprétées ne sont jamais stockées**
   (fonctions pures) — la persistance ne doit pas les matérialiser.
5. **Le champ `PanelUser.role` (ADMIN/DEV) est un point d'extension** : le
   RBAC futur le remplacera derrière les mêmes gardes, sans toucher ni au
   frontend v1 ni au contrat `{admin, dev}` des Managers.

## 4. Ce qui ne devra JAMAIS être modifié

Hérité de l'écosystème, verrouillé par `tests/bridge-conformity.test.js` :

1. Les contrats v1 n'évoluent que par ajouts (mineures), ratifiés dans le
   projet modèle puis recopiés — jamais l'inverse.
2. Les 5 règles de synchronisation, et rien au-delà.
3. `ProjectBridgeClient` est le seul point de contact sortant vers les
   projets ; la surface `/bridge/v1` le seul point d'entrée des projets.
4. Le Panel ne connaît jamais le Mongo d'un projet, ne duplique pas, ne
   déploie pas, n'écrit pas une donnée locale.
5. Les Managers ne reçoivent que `{admin, dev}`.
6. Aucune logique spécifique à un projet nommé dans ce dépôt.
7. UNCONFIGURED/STANDALONE est un état normal de première classe, des deux
   côtés de la frontière.
