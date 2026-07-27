# 21 — Le système de capacités (Capabilities)

> Prérequis : [20_MANAGER_STANDARD.md](20_MANAGER_STANDARD.md) §3.
> Implémentation : `backend/src/services/manifest/capabilities.catalog.js`
> et `capabilities.service.js`.

---

## 1. Le problème résolu

Le parc sera hétérogène : un garage a des réservations et des contrats, un
autre client n'aura ni l'un ni l'autre ; un projet intègre Stripe, un autre
non. Le Panel doit administrer tout le monde **sans logique par projet** et
sans afficher des écrans vides ou trompeurs.

La réponse : chaque projet **déclare** ce qu'il supporte, sous forme de
booléens nommés — ses capabilities — dans son Manifest. Le Panel **adapte
automatiquement son interface** à cette déclaration.

```
   Manifest du projet                        Interface du Panel pour CE projet
   ┌──────────────────────────┐              ┌────────────────────────────────┐
   │ supportsContracts: true  │   interprète │ ✔ (Phase 3+) onglet Contrats   │
   │ supportsInvoices:  true  │ ────────────▶│ ✔ (Phase 3+) onglet Factures   │
   │ supportsBookings:  false │              │ ✘ jamais d'onglet Réservations │
   │ supportsCRM:       false │              │ ✘ jamais de vue CRM            │
   └──────────────────────────┘              └────────────────────────────────┘
```

## 2. Le catalogue officiel (v1)

Le catalogue est **code-first** : `capabilities.catalog.js` est la référence,
ce tableau en est la lecture.

| Capability | Le projet déclare qu'il possède… | Module(s) Panel concerné(s) (Phase 3+) |
|---|---|---|
| `supportsCompany` | une fiche entreprise cliente (identité, horaires) | supervision d'identité |
| `supportsServices` | des services / prestations / tarifs | — (catégorie 1, jamais administrée ici) |
| `supportsBookings` | des réservations | — (catégorie 1) |
| `supportsGallery` | galerie / avant-après / avis | — (catégorie 1) |
| `supportsContracts` | le moteur de contrats standard (machine à états) | Contrats |
| `supportsInvoices` | des factures rattachées aux contrats | Factures |
| `supportsPayments` | paiements / mensualités | Paiements |
| `supportsStripe` | l'IntegratedAPI Stripe (configs TEST/PROD) | IntegratedAPI, webhooks D1 |
| `supportsBrevo` | l'IntegratedAPI Brevo | IntegratedAPI, templates C3 |
| `supportsYousign` | l'IntegratedAPI Yousign | IntegratedAPI, signatures |
| `supportsCRM` | des données CRM exposables | CRM |

### Évolution du catalogue

- **Additive uniquement** : on ajoute des capabilities, on n'en renomme ni
  n'en supprime jamais (un Manifest ancien reste valide pour toujours).
- Une capability naît ici (catalogue + ce document) AVANT qu'un module du
  Panel ne s'y adosse.
- La granularité est le **domaine fonctionnel**, pas le détail technique :
  `supportsContracts`, pas `supportsContractCancellationMode`.

## 3. Les règles d'interprétation

Implémentées par `interpretCapabilities()` — mêmes règles partout, y compris
dans le frontend :

1. **Booléens uniquement.** Toute autre valeur rend le Manifest invalide.
2. **Absent = `false`.** Un Manifest sans `supportsCRM` = un projet sans CRM.
3. **Manifest absent = toutes capacités à `false`.** Le Panel n'affiche que
   le socle (identité, pont, versions, santé) — jamais un écran métier
   « au cas où ».
4. **Inconnue = tolérée, signalée, ignorée.** Un projet plus récent que le
   Panel peut déclarer `supportsX` que ce Panel ne connaît pas : la
   validation la liste dans `unknownCapabilities` (visible en supervision) et
   l'interprétation l'ignore. Jamais un refus — lecteur tolérant.
5. **Une capability décrit le PROJET, jamais le Panel.** `supportsContracts:
   true` signifie « ce projet a le moteur de contrats », pas « le Panel doit
   avoir un module contrats ». Si le module Panel n'existe pas encore, la
   capability est simplement en attente.
6. **Une capability n'ouvre jamais un droit d'écriture** sur une donnée
   locale (catégorie 1). Elle conditionne l'affichage et, en Phase 3+,
   l'activation des synchronisations et des opérations du catalogue — dans
   les limites fixées par [22_DATA_MODEL.md](22_DATA_MODEL.md).

## 4. Ce que produit l'interprétation

`interpretCapabilities(manifest)` renvoie une structure stable, consommée par
le frontend et par les futurs modules :

```js
{
  known:   { supportsContracts: true, supportsInvoices: true, /* … catalogue complet, résolu */ },
  enabled: ['supportsContracts', 'supportsInvoices'],          // celles à true
  unknown: ['supportsLoyaltyProgram'],                          // déclarées, hors catalogue
  panelModules: ['contracts', 'invoices'],                      // modules Panel activables (Phase 3+)
}
```

En Phase 2B, `panelModules` ne pilote encore aucun écran métier (il n'y en a
pas) — il est calculé, affiché sur la fiche projet, et testé, pour que la
Phase 3 n'ait plus qu'à s'y brancher.

## 5. Interdits

1. ❌ `if (projectKey === '…')` — l'adaptation passe par les capabilities,
   jamais par l'identité.
2. ❌ Déduire une capability d'un comportement observé (« il a répondu à un
   sync CONTRACT, donc il supporte les contrats ») : seule la déclaration
   fait foi.
3. ❌ Une capability à valeur non booléenne (niveau, version, options) — si
   un domaine a besoin de nuance, c'est un champ du Manifest à proposer,
   pas une capability dévoyée.
4. ❌ Refuser un Manifest pour une capability inconnue.
