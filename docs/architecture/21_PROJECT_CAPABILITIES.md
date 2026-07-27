# 21 — Le système de capacités (features et modules du Manifest)

> Prérequis : [20_MANAGER_STANDARD.md](20_MANAGER_STANDARD.md) §3.
> Implémentation : `backend/src/services/manifest/capabilities.catalog.js`
> et `capabilities.service.js`.
> **Mis à jour en Phase 2C** : les capacités ne sont plus des booléens
> `supportsX` propres au Panel, mais les `features` et `modules` du
> `ProjectManifest` officiel (contrat 1.1.0), déclarés par le projet.

---

## 1. Le problème résolu

Le parc sera hétérogène : un garage a des réservations et des contrats, un
autre client n'aura ni l'un ni l'autre ; un projet intègre Stripe, un autre
non. Le Panel doit administrer tout le monde **sans logique par projet** et
sans afficher des écrans vides ou trompeurs.

La réponse : chaque projet **déclare** ce qu'il sait faire dans son Manifest.
Le Panel **adapte automatiquement son interface** à cette déclaration.

```
   Manifest du projet                            Interface du Panel pour CE projet
   ┌────────────────────────────────────┐        ┌────────────────────────────────┐
   │ features:                          │        │                                │
   │   sync.contracts    AVAILABLE      │ inter- │ ✔ (Phase 3+) onglet Contrats   │
   │   sync.invoicing    RESERVED       │ prète  │ ◐ visible, grisé, jamais appelé│
   │   (sync.crm absent)                │ ──────▶│ ✘ n'existe pas                 │
   │ modules:                           │        │                                │
   │   vitrine           ACTIVE         │        │ ℹ inventaire du produit        │
   │   yousign-signature OPTIONAL       │        │ ℹ installé mais désactivé      │
   └────────────────────────────────────┘        └────────────────────────────────┘
```

## 2. Trois déclarations distinctes

Le `ProjectManifest` porte trois informations de nature différente — les
confondre serait une erreur d'interprétation.

| Déclaration | Nature | Ce que ça dit | Autorité |
|---|---|---|---|
| `features[]` | **déclarative** | ce que le projet sait (ou saura) faire | registre code-first du projet |
| `modules[]` | **déclarative** | ce qui est installé dans ce produit | registre code-first du projet |
| `sync` | **dérivée du code** | les `entityTypes` réellement appliqués et les opérations réellement invocables | le code lui-même — incapable de mentir |

`sync` est la seule des trois qui ne puisse pas diverger de la réalité : elle
est calculée, pas saisie. C'est sur elle que le Panel s'appuie quand il doit
savoir si un envoi sera accepté.

## 3. Le catalogue officiel des features

Le catalogue est **code-first** : `capabilities.catalog.js` est la référence,
ce tableau en est la lecture. Les identifiants sont ceux du registre du
projet vitrine de référence.

| Feature | Le projet déclare qu'il sait… | Module(s) Panel concerné(s) (Phase 3+) |
|---|---|---|
| `sync.diagnostic` | échanger des écritures de diagnostic | — (socle de recette) |
| `sync.contracts` | synchroniser ses contrats | Contrats |
| `sync.invoicing` | synchroniser sa facturation | Factures |
| `sync.dev-company` | synchroniser la société développeur et son équipe | Société développeur |
| `sync.email-templates` | synchroniser ses templates d'e-mails | Templates |
| `sync.integrated-api-config` | synchroniser ses configurations IntegratedAPI | IntegratedAPI |
| `sync.events-meetings` | synchroniser événements et réunions | Événements |
| `operations.catalog` | exposer des opérations invocables | — (socle) |
| `manager-access-grant` | accepter un accès Manager délégué | — |

### Les deux statuts

| Statut | Signification | Ce que fait le Panel |
|---|---|---|
| `AVAILABLE` | opérationnel **aujourd'hui** | peut activer le module correspondant |
| `RESERVED` | annoncé, pas encore opérationnel | affiche l'information, **n'appelle jamais** |

Un projet honnête déclare `RESERVED` plutôt que d'omettre : le Panel sait
alors que la fonction viendra, sans tenter de s'en servir.

### Les statuts de modules

| Statut | Signification |
|---|---|
| `ACTIVE` | installé et en service dans ce produit |
| `OPTIONAL` | installé, mais désactivé pour ce client |

Les modules sont **informatifs** : ils décrivent l'inventaire du produit. Un
module n'active jamais un écran du Panel — seule une feature le fait.

### Évolution du catalogue

- **Additive uniquement** : on ajoute des features, on n'en renomme ni n'en
  supprime jamais (un Manifest ancien reste valide pour toujours).
- Une feature naît dans le registre du projet modèle, puis est reconnue ici
  AVANT qu'un module du Panel ne s'y adosse.
- La granularité est le **domaine fonctionnel**, pas le détail technique.

## 4. Les règles d'interprétation

Implémentées une seule fois, par `interpretCapabilities()` :

1. **Seul `AVAILABLE` active.** Une feature `RESERVED` est visible mais
   inerte : le Panel ne l'appelle jamais.
2. **Absente = n'existe pas.** Un Manifest sans `sync.contracts` décrit un
   projet sans synchronisation de contrats.
3. **Manifest absent = rien d'activé.** Le Panel n'affiche que le socle
   (identité, pont, versions, santé) — jamais un écran métier « au cas où ».
4. **Inconnue = tolérée, signalée, ignorée.** Un projet plus récent peut
   déclarer une feature que ce Panel ne connaît pas : la validation la liste
   dans `unknownFeatures` (visible en supervision) et l'interprétation
   l'ignore. Jamais un refus — lecteur tolérant.
5. **Une feature décrit le PROJET, jamais le Panel.** `sync.contracts:
   AVAILABLE` signifie « ce projet sait synchroniser ses contrats », pas
   « le Panel doit avoir un module contrats ». Si le module n'existe pas
   encore, la feature est simplement en attente.
6. **Une feature n'ouvre jamais un droit d'écriture** sur une donnée locale
   (catégorie 1). Elle conditionne l'affichage et, en Phase 3+, l'activation
   des synchronisations et des opérations — dans les limites fixées par
   [22_DATA_MODEL.md](22_DATA_MODEL.md).
7. **Fonction pure.** L'interprétation est recalculée à la lecture, jamais
   mise en cache, jamais stockée : la persistance ne doit pas la matérialiser.

## 5. Ce que produit l'interprétation

`interpretCapabilities(manifest)` renvoie une structure stable, consommée par
le frontend et par les futurs modules :

```js
{
  enabled:  ['sync.contracts'],            // features AVAILABLE et connues
  reserved: ['sync.invoicing'],            // annoncées, inertes
  unknown:  ['sync.loyalty-program'],      // déclarées, hors catalogue
  panelModules: ['contracts'],             // modules Panel activables (Phase 3+)
  projectModules: {
    active:   ['vitrine', 'panel-bridge'],
    optional: ['yousign-signature'],
  },
  sync: {
    supportedEntityTypes: ['DIAGNOSTIC'],  // dérivé du code du projet
    operations: [],
  },
}
```

`panelModules` ne pilote encore aucun écran métier (il n'y en a pas) — il est
calculé, exposé sur la fiche projet, et testé, pour que la Phase 3 n'ait plus
qu'à s'y brancher.

## 6. Interdits

1. ❌ `if (projectKey === '…')` — l'adaptation passe par le Manifest, jamais
   par l'identité.
2. ❌ Déduire une capacité d'un comportement observé (« il a répondu à un
   sync CONTRACT, donc il supporte les contrats ») : seule la déclaration
   fait foi.
3. ❌ Traiter `RESERVED` comme `AVAILABLE`.
4. ❌ Confondre un module (inventaire) et une feature (capacité).
5. ❌ Refuser un Manifest pour une feature inconnue.
6. ❌ Stocker l'interprétation : elle se recalcule.
