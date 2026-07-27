# 20 — Le Manager Standard : squelette officiel d'un projet compatible

> Prérequis : [00_VISION.md](00_VISION.md) §3, [21_PROJECT_CAPABILITIES.md](21_PROJECT_CAPABILITIES.md),
> [22_DATA_MODEL.md](22_DATA_MODEL.md).
> **Document de référence.** Le Panel ne devine JAMAIS la structure d'un
> projet : il se repose sur ce standard. Tout projet qui s'y conforme est
> administrable par le Panel — SB Auto 06 est le premier, pas le dernier.

---

## 1. Définition

Un **projet compatible Manager Standard** est un logiciel complet (backend +
Manager + vitrine + sa base Mongo) qui :

1. expose les **surfaces obligatoires** (§2) ;
2. décrit ce qu'il sait faire dans un **Manifest** (§3) portant ses
   **Capabilities** ([21](21_PROJECT_CAPABILITIES.md)) ;
3. organise son métier en **domaines standard** (§4) — chacun rangé dans une
   catégorie de données connue ([22](22_DATA_MODEL.md)) ;
4. respecte les invariants de conformité (§5).

Le Panel s'engage en retour : il n'exige d'un projet **que** ce qui est écrit
ici. Aucun module du Panel ne suppose l'existence d'une route, d'un modèle ou
d'un écran non couvert par ce document.

## 2. Les surfaces obligatoires

| Surface | Rôle | Auth |
|---|---|---|
| `GET /health` | vivacité du backend | aucune |
| `GET /api/version` | version logicielle déployée | aucune |
| `/api/project-bridge/v1/*` | **le ProjectBridge** — l'unique porte d'entrée du Panel : ping, identité, santé, sync push/pull, catalogue d'opérations, unpair ([../spec/ProjectBridge.openapi.yaml](../spec/ProjectBridge.openapi.yaml)) | bridgeToken |
| PanelBridge (composant interne) | l'unique porte de sortie vers le Panel : bootstrap, heartbeat, push/pull ([../spec/PanelBridge.openapi.yaml](../spec/PanelBridge.openapi.yaml)) | bridgeToken |

C'est **tout**. Le Panel ne connaît d'un projet que ces quatre points — il
n'appelle jamais une route métier, ne lit jamais une collection, n'importe
jamais un modèle.

## 3. Le Manifest

Le Manifest est la **carte d'identité structurelle** d'un projet : un
document JSON, stable, versionné, qui dit au Panel qui est le projet et ce
qu'il supporte.

```json
{
  "manifestVersion": "1.0.0",
  "project": {
    "projectKey": "sb-auto-06",
    "projectName": "SB Auto 06",
    "softwareVersion": "1.4.2",
    "contractVersion": "1.0.0",
    "environment": "PROD"
  },
  "capabilities": {
    "supportsCompany": true,
    "supportsServices": true,
    "supportsBookings": true,
    "supportsContracts": true,
    "supportsInvoices": true,
    "supportsPayments": true,
    "supportsStripe": true,
    "supportsBrevo": true,
    "supportsYousign": true,
    "supportsGallery": true,
    "supportsCRM": false
  },
  "modules": [
    { "id": "company",  "label": "Entreprise" },
    { "id": "services", "label": "Services & prestations" },
    { "id": "bookings", "label": "Réservations" }
  ]
}
```

| Champ | Règles |
|---|---|
| `manifestVersion` | semver du **format** de Manifest (pas du projet). Majeure inconnue → Manifest refusé proprement |
| `project` | identité — mêmes champs et mêmes valeurs que ce que le PanelBridge déclare au bootstrap ; une divergence est signalée en supervision |
| `capabilities` | booléens uniquement, catalogue officiel dans [21](21_PROJECT_CAPABILITIES.md) ; **absent = false** |
| `modules` | liste déclarative des domaines actifs du Manager (informatif, pour l'affichage) ; `id` en kebab/camel stable, `label` libre |

Validation : `backend/src/services/manifest/manifest.schema.js` (zod strict
sur la structure ; capacités inconnues tolérées mais signalées — lecteur
tolérant, jamais un crash sur un Manifest plus récent que le Panel).

## 4. Les domaines standard

La grille de lecture officielle d'un projet compatible. Pour chaque domaine :
sa catégorie de données (1 = locale, 2 = synchronisée à terme, 3 = Panel), la
capability qui le déclare, et ce que le Panel a le droit d'en savoir.

| Domaine | Cat. | Capability | Ce que le Panel en sait |
|---|---|---|---|
| **Entreprise** (du client : identité, coordonnées, horaires) | 1 | `supportsCompany` | rien — jamais lu, jamais écrit |
| **Services / prestations / tarifs** | 1 | `supportsServices` | rien |
| **Réservations** | 1 | `supportsBookings` | rien |
| **Galerie / avant-après / avis** | 1 | `supportsGallery` | rien |
| **Contrats** | 2 (lot D2) | `supportsContracts` | rien en Phase 2B ; à terme : donnée synchronisée, mêmes actions des deux côtés |
| **Factures** | 2 (lot D2) | `supportsInvoices` | idem |
| **Paiements / mensualités** | 2 (lot D2) | `supportsPayments` | idem |
| **IntegratedAPI** (Stripe, Brevo, Yousign… : configs TEST/PROD + mode actif) | 2 (lot C4) | `supportsStripe`, `supportsBrevo`, `supportsYousign` | rien en Phase 2B ; à terme : configurations synchronisées, mode actif par projet |
| **Société développeur / équipe** | 2 (lot C1) | (socle) | rien en Phase 2B |
| **Templates e-mails** | 2 (lot C3) | (socle) | rien en Phase 2B |
| **Utilisateurs locaux** (`ADMIN` client, `DEV` superset) | 1 | (socle) | leur existence comme principe — jamais les comptes eux-mêmes |
| **Bridge** (PanelBridge + ProjectBridge + page « Connexion Panel ») | socle | (socle) | l'état du pont, via heartbeat et ProjectBridge |
| **Version / Health / Manifest** | socle | (socle) | oui — c'est la matière de la supervision |
| **CRM** | 2 (futur) | `supportsCRM` | rien en Phase 2B |

Notes :

- **(socle)** = obligatoire dans tout projet compatible, pas besoin de le
  déclarer. Les capabilities ne déclarent que les domaines optionnels.
- « Cat. 2 » décrit la **cible** : en Phase 2B, aucun domaine n'est encore
  synchronisé ; ces données sont traitées comme locales tant que leur lot de
  Phase 3+ n'est pas livré.
- Un projet peut avoir des domaines HORS standard (spécifiques à un client).
  Le Panel les ignore intégralement — ils n'existent pas pour lui.

## 5. Conformité : la checklist

Un projet est conforme Manager Standard si :

1. ✅ `GET /health` et `GET /api/version` répondent sans authentification ;
2. ✅ le ProjectBridge est monté sous `/api/project-bridge/v1` et honore le
   contrat v1 (ping public avec état d'appairage, 503 `BRIDGE_NOT_PAIRED`
   hors appairage, 401 sur token invalide, idempotence par `writeId`) ;
3. ✅ son PanelBridge sait faire un bootstrap conforme (`BootstrapRequest`) ;
4. ✅ son Manifest est valide (§3) et ses capabilities appartiennent au
   catalogue (les inconnues sont tolérées mais signalées) ;
5. ✅ l'identité du Manifest et celle du bootstrap coïncident (`projectKey`,
   `projectName`) ;
6. ✅ il fonctionne à 100 % sans le Panel (Standalone — la conformité ne
   s'achète pas au prix de l'autonomie).

Cette checklist est exécutable : `tests/registry.test.js` déclare et appaire
un projet fictif conforme, et `tests/manifest.test.js` verrouille la
validation du Manifest.

## 6. Comment le Manifest atteint le Panel

| Phase | Canal |
|---|---|
| **2B (actuelle)** | déclaratif : `PUT /api/projects/:id/manifest` (nous, depuis le frontend, à partir du Manifest publié par le projet) — le contrat de pont v1.0.0 ne transporte pas encore de Manifest |
| **3 (cible)** | le projet transmet son Manifest lui-même : champ optionnel `manifest` dans `BootstrapRequest` et dans `Heartbeat` — évolution **additive** (contrat 1.1.0) à ratifier dans le projet modèle d'abord ([PHASE_3_PREPARATION.md](PHASE_3_PREPARATION.md) §3) |

Dans les deux cas, la validation et l'interprétation sont les mêmes — le
canal change, pas le document.

## 7. Interdits

1. ❌ Le Panel qui infère une structure non déclarée (« ce projet a sûrement
   des contrats ») : pas de capability → la fonction n'existe pas.
2. ❌ Un module du Panel qui exige un domaine hors socle : tout module métier
   futur s'active par capability, et son absence est un état normal.
3. ❌ Un Manifest qui prétend des capacités fausses : la conformité engage le
   projet — le Panel s'y fie sans contre-vérifier le métier.
4. ❌ Traiter SB Auto 06 autrement que comme « un projet conforme parmi N ».
