# 20 — Le Manager Standard : squelette officiel d'un projet compatible

> Prérequis : [00_VISION.md](00_VISION.md) §3, [21_PROJECT_CAPABILITIES.md](21_PROJECT_CAPABILITIES.md),
> [22_DATA_MODEL.md](22_DATA_MODEL.md).
> **Document de référence, autoporteur.** Le Panel ne devine JAMAIS la
> structure d'un projet : il se repose sur ce standard. Tout projet qui s'y
> conforme est administrable par le Panel — SB Auto 06 est le premier, pas le
> dernier.

---

## 1. Définition

Un **projet compatible Manager Standard** est un logiciel complet (backend +
Manager + vitrine + sa base Mongo) qui :

1. expose les **surfaces obligatoires** (§2) ;
2. décrit ce qu'il sait faire dans un **Manifest** officiel (§3) ;
3. organise son métier en **domaines standard** (§5), chacun rangé dans une
   catégorie de données connue ([22](22_DATA_MODEL.md)) ;
4. respecte les invariants de conformité (§8).

Le Panel s'engage en retour : il n'exige d'un projet **que** ce qui est écrit
ici. Aucun module du Panel ne suppose l'existence d'une route, d'un modèle ou
d'un écran non couvert par ce document.

## 2. Les surfaces obligatoires

| Surface | Rôle | Auth |
|---|---|---|
| `GET /health` | vivacité du backend | aucune |
| `GET /api/version` | version logicielle déployée | aucune |
| `/api/project-bridge/v1/*` | **le ProjectBridge** — l'unique porte d'entrée du Panel : ping, identité, santé, **manifeste**, sync push/pull, catalogue d'opérations, unpair ([../spec/ProjectBridge.openapi.yaml](../spec/ProjectBridge.openapi.yaml)) | bridgeToken |
| PanelBridge (composant interne) | l'unique porte de sortie vers le Panel : bootstrap, heartbeat, push/pull ([../spec/PanelBridge.openapi.yaml](../spec/PanelBridge.openapi.yaml)) | bridgeToken |

C'est **tout**. Le Panel ne connaît d'un projet que ces quatre points — il
n'appelle jamais une route métier, ne lit jamais une collection, n'importe
jamais un modèle.

Ordre des gardes sur le ProjectBridge (contractuel) : version de contrat sur
tout le routeur (ping compris) → routes publiques → appairage requis (503
`BRIDGE_NOT_PAIRED`) → bridgeToken (401). Exception : `POST /unpair` répond
200 ou 401, **jamais 503** — un projet doit toujours pouvoir se débrancher.

## 3. Le Manifest — carte d'identité officielle

Le Manifest est le document JSON par lequel un projet se présente
**complètement**. Depuis le contrat **1.1.0**, le Panel ne le ressaisit plus :
il le reçoit.

```json
{
  "manifestVersion": "1.0.0",
  "project": {
    "key": "un-projet",
    "name": "Un Projet",
    "environment": "PROD",
    "softwareVersion": "abc1234"
  },
  "bridge": {
    "contractVersion": "1.1.0",
    "projectBridgeBasePath": "/api/project-bridge/v1"
  },
  "contracts": { "panelBridge": "1.1.0", "projectBridge": "1.1.0" },
  "sync": {
    "supportedEntityTypes": ["DIAGNOSTIC"],
    "operations": []
  },
  "modules": [
    { "id": "vitrine", "title": "Vitrine", "status": "ACTIVE" },
    { "id": "yousign-signature", "title": "Signature", "status": "OPTIONAL" }
  ],
  "features": [
    { "id": "sync.diagnostic", "status": "AVAILABLE" },
    { "id": "sync.contracts", "status": "RESERVED" }
  ]
}
```

**Les sept champs racine sont TOUS requis** — il n'y a pas de champ racine
optionnel.

| Champ | Règles |
|---|---|
| `manifestVersion` | semver du **format** de Manifest (pas du projet). Majeure inconnue → Manifest refusé proprement ; mineure supérieure acceptée |
| `project` | `key` (3–120), `name`, `environment` (`TEST`/`PROD`), `softwareVersion` (SHA court du build, pas un semver) |
| `bridge` | `contractVersion` parlée par ce projet + `projectBridgeBasePath` |
| `contracts` | versions des deux contrats parlés (`panelBridge`, `projectBridge`) |
| `sync` | **DÉRIVÉ DU CODE**, jamais du registre déclaratif : les `entityTypes` réellement appliqués et les opérations réellement invocables |
| `modules` | modules installés — `status` ∈ `ACTIVE` \| `OPTIONAL` |
| `features` | fonctionnalités — `status` ∈ `AVAILABLE` \| `RESERVED` |

La distinction **déclaré / dérivé** est essentielle : `modules` et `features`
expriment une intention (registre code-first du projet), tandis que `sync`
est calculé depuis le code, donc incapable de mentir sur ce que le projet
accepte réellement.

Validation côté Panel : `backend/src/services/manifest/manifest.schema.js`,
adossé au miroir exécutable `backend/src/bridge/bridgeContract.js`.
**Lecteur tolérant** : les propriétés additionnelles d'un format mineur plus
récent sont acceptées, les `features` hors catalogue sont acceptées et
signalées — jamais un crash sur un Manifest plus récent que le Panel.

## 4. Comment le Manifest atteint le Panel

| Canal | Quand | Autorité |
|---|---|---|
| `BootstrapRequest.manifest` (champ optionnel, contrat ≥ 1.1.0) | à l'appairage | **fait foi** — source `BRIDGE` |
| `GET /api/project-bridge/v1/manifest` | à tout moment, à l'initiative du Panel | **fait foi** — source `BRIDGE` |
| `PUT /api/projects/:id/manifest` (surface interne du Panel) | secours | source `MANUAL` |

Règles de gouvernance appliquées par le Panel :

1. le Manifest reçu par le pont **remplace** toute saisie manuelle ;
2. dès qu'un Manifest a été reçu par le pont, la saisie manuelle est
   **refusée** (`PANEL_MANIFEST_BRIDGE_AUTHORITATIVE`) — une saisie ne peut
   donc jamais contredire ce que le projet déclare ;
3. un Manifest dont `project.key` ne correspond pas à la fiche est refusé,
   dans les deux canaux ;
4. au bootstrap, le Manifest est validé **avant** la consommation du code
   d'appairage : un Manifest non conforme ne grille pas le code.

Le canal manuel ne subsiste que pour un projet parlant encore un contrat
`1.0.x` (sans transport de Manifest). Il disparaîtra quand le parc entier
sera en 1.1+.

## 5. Les domaines standard

Grille de lecture officielle d'un projet compatible : catégorie de données
(1 = locale, 2 = synchronisée à terme, 3 = Panel), feature qui déclare le
domaine, et ce que le Panel a le droit d'en savoir.

| Domaine | Cat. | Feature déclarante | Ce que le Panel en sait |
|---|---|---|---|
| **Entreprise cliente** (identité, coordonnées, horaires) | 1 | (socle produit) | rien — jamais lu, jamais écrit |
| **Services / prestations / tarifs** | 1 | (module) | rien |
| **Réservations** | 1 | (module) | rien |
| **Galerie / avant-après / avis** | 1 | (module) | rien |
| **Contrats** | 2 | `sync.contracts` | rien tant que la feature est `RESERVED` |
| **Factures** | 2 | `sync.invoicing` | idem |
| **Paiements / mensualités** | 2 | `sync.invoicing` | idem |
| **IntegratedAPI** (Stripe, Brevo, Yousign : configs TEST/PROD + mode actif) | 2 | `sync.integrated-api-config` | idem |
| **Société développeur / équipe** | 2 | `sync.dev-company` | idem |
| **Templates e-mails** | 2 | `sync.email-templates` | idem |
| **Événements / réunions** | 2 | `sync.events-meetings` | idem |
| **Opérations invocables** | socle | `operations.catalog` | le catalogue déclaré, rien de plus |
| **Accès Manager délégué** | 2 | `manager-access-grant` | rien tant que `RESERVED` |
| **Utilisateurs locaux** (`ADMIN` client, `DEV` superset) | 1 | (socle) | leur existence comme principe — jamais les comptes |
| **Bridge** (PanelBridge + ProjectBridge + écran « Connexion Panel ») | socle | (socle) | l'état du pont, via heartbeat et ProjectBridge |
| **Version / Health / Manifest** | socle | (socle) | oui — c'est la matière de la supervision |

Notes :

- **(socle)** = obligatoire dans tout projet compatible, pas besoin de le
  déclarer. Les `features` ne déclarent que ce qui est optionnel ou à venir.
- `RESERVED` décrit la **cible** : le projet annonce qu'il saura le faire,
  mais ne le fait pas encore. Le Panel l'affiche en grisé et n'appelle rien.
- Un projet peut avoir des domaines HORS standard (spécifiques à un client).
  Le Panel les ignore intégralement — ils n'existent pas pour lui.

## 6. Utilisateurs locaux et autonomie

Un Manager possède ses **propres** comptes, indépendants du Panel :

| Rôle | Portée |
|---|---|
| `ADMIN` | le client final : administre son produit |
| `DEV` | superset d'`ADMIN` : accès technique, déploiement, configuration système |

Règles :

1. l'authentification du Manager et celle du Panel sont **disjointes** :
   aucun JWT du Panel n'ouvre quoi que ce soit dans un Manager, et
   réciproquement ;
2. les Managers ne reçoivent jamais que le contrat de rôles `{admin, dev}` ;
   **le futur RBAC du Panel ne descend pas dans les Managers** ;
3. un Manager fonctionne à 100 % **sans** le Panel.

Deux états de première classe, tous deux normaux :

| État | Signification | Comportement |
|---|---|---|
| **STANDALONE** (ou UNCONFIGURED) | aucun appairage, ou appairage révoqué | le produit fonctionne intégralement ; le ProjectBridge répond 503 `BRIDGE_NOT_PAIRED` hors `/ping` et `/unpair` |
| **CONNECTED** | appairé au Panel | en plus : heartbeats, synchronisation, opérations invocables |

Perdre le Panel n'est jamais une panne du projet. Un projet vendu à un autre
développeur se révoque et continue de tourner.

## 7. Classification des données

Pour chaque domaine, trois natures possibles :

| Nature | Définition | Exemples |
|---|---|---|
| **Locale** (cat. 1) | vit dans le projet, n'en sort jamais | entreprise cliente, services, réservations, galerie, comptes locaux |
| **Synchronisée** (cat. 2) | même donnée des deux côtés, réconciliée par le pont | contrats, factures, paiements, société développeur, templates, configs IntegratedAPI |
| **Exclusivement Panel** (cat. 3) | n'existe que dans le Panel, ne transite jamais vers un projet | registre des projets, appairages, bridgeTokens, supervision du parc, comptes du Panel |

Règle de synchronisation : cinq règles minimales et rien au-delà —
idempotence par `writeId`, dernier écrit gagne, tombstones, anti-écho,
identités UUID.

## 8. Conformité : la checklist

Un projet est conforme Manager Standard si :

1. ✅ `GET /health` et `GET /api/version` répondent sans authentification ;
2. ✅ le ProjectBridge est monté sous `/api/project-bridge/v1` et honore le
   contrat v1 (ping public, 503 `BRIDGE_NOT_PAIRED` hors appairage, 401 sur
   token invalide, idempotence par `writeId`, `/unpair` jamais 503) ;
3. ✅ `GET /manifest` sert un Manifest valide (§3), et son PanelBridge joint
   ce Manifest au bootstrap (contrat ≥ 1.1.0) ;
4. ✅ l'identité du Manifest et celle du bootstrap coïncident (`project.key`
   ↔ `projectKey`) ;
5. ✅ `sync.supportedEntityTypes` reflète le code, pas une intention ;
6. ✅ le bridgeToken est stocké chiffré au repos, vérifié en temps constant,
   et l'appairage survit à un redémarrage ;
7. ✅ il fonctionne à 100 % sans le Panel (STANDALONE — la conformité ne
   s'achète pas au prix de l'autonomie).

Cette checklist est exécutable côté Panel : `tests/registry.test.js` déclare,
appaire et supervise un projet fictif conforme ; `tests/manifest.test.js`
verrouille la validation ; `tests/bridge-conformity.test.js` verrouille
l'accord specs ↔ code.

## 9. Compatibilité de projets variés

Le Panel affiche **uniquement ce qui existe**. Aucune inférence, aucun moteur
de permissions : la lecture déclarative du Manifest suffit.

| Cas | Ce que le projet déclare | Ce que le Panel fait |
|---|---|---|
| Projet **avec réservations** | module `bookings` ACTIVE | affiche le module dans l'inventaire ; n'administre rien (donnée locale) |
| Projet **sans réservation** | module absent | rien n'apparaît — état normal, pas une anomalie |
| Projet **avec Stripe** | module `stripe-billing` ACTIVE, `sync.integrated-api-config` AVAILABLE | activera le module IntegratedAPI du Panel |
| Projet **sans Stripe** | module et feature absents | aucun écran de paiement côté Panel |
| Projet **connecté** | appairé, heartbeats réguliers | supervision complète, vivacité ONLINE |
| Projet **autonome** | jamais appairé, ou révoqué | fiche `DECLARED`/`REVOKED`, vivacité `NOT_PAIRED` — aucun appel sortant |
| Projet **vendu à un autre développeur** | appairage révoqué de part et d'autre | le Panel efface les credentials ; le projet continue en STANDALONE |
| Projet **plus récent que le Panel** | features inconnues, champs additifs | acceptés, signalés (`unknownFeatures`), ignorés par l'interprétation |
| Projet **plus ancien** (contrat 1.0.x) | pas de Manifest au bootstrap | canal manuel de secours, tout le reste fonctionne |

Une feature `RESERVED` est visible mais inerte : le Panel ne l'appelle jamais.
Une feature absente vaut « n'existe pas ».

## 10. Contrat d'intégration — ce que le Panel ne doit JAMAIS supposer

Le Panel ne dépend **jamais** :

1. ❌ d'un nom de collection Mongo d'un projet ;
2. ❌ de la structure interne d'un modèle métier local ;
3. ❌ d'une route privée non documentée ;
4. ❌ d'une hypothèse propre à un projet nommé (SB Auto 06 compris) ;
5. ❌ d'un port, d'un domaine ou d'un chemin de déploiement particulier.

Il dépend **uniquement** :

1. ✅ du Manifest ;
2. ✅ des `features` et `modules` déclarés ;
3. ✅ des routes du ProjectBridge ;
4. ✅ des DTO des deux specs OpenAPI ;
5. ✅ du catalogue d'opérations exposé ;
6. ✅ des versions contractuelles annoncées.

Ces interdits sont vérifiés mécaniquement par `tests/architecture.test.js`
(aucune référence à un projet nommé dans la logique du Panel, transport
réseau exclusif au `ProjectBridgeClient`).

## 11. Interdits

1. ❌ Le Panel qui infère une structure non déclarée (« ce projet a sûrement
   des contrats ») : pas de feature → la fonction n'existe pas.
2. ❌ Un module du Panel qui exige un domaine hors socle : tout module métier
   futur s'active par feature, et son absence est un état normal.
3. ❌ Un Manifest qui prétend des capacités fausses : la conformité engage le
   projet — le Panel s'y fie sans contre-vérifier le métier.
4. ❌ Traiter SB Auto 06 autrement que comme « un projet conforme parmi N ».
5. ❌ Faire descendre le RBAC du Panel dans les Managers.
