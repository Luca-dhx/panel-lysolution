# 05 — L'appairage, de bout en bout

> Prérequis : [02_PROJECT_REGISTRY.md](02_PROJECT_REGISTRY.md),
> [03_PANEL_BRIDGE.md](03_PANEL_BRIDGE.md).
> Contrat : [../spec/PanelBridge.openapi.yaml](../spec/PanelBridge.openapi.yaml)
> (`POST /bridge/v1/pairings`, `DELETE /bridge/v1/pairings/current`).

L'appairage est le seul moment où le Panel et un projet échangent des
secrets. Il est **réversible, re-jouable, et jamais implicite**.

---

## 1. Le déroulé nominal

```
  NOUS (DEV, frontend Panel)          PANEL                       PROJET (Manager)
────────────────────────────────────────────────────────────────────────────────────
 1. déclarer le projet     ──▶  fiche DECLARED créée
    (projectKey, nom)           code d'appairage généré
                                • usage unique
                                • TTL 15 minutes
                                • affiché UNE fois
                                • stocké en hash
 2. copier le code  ─────────────────────────────────────▶  page « Connexion Panel »
                                                            saisir URL du Panel + code
                                                 ◀──────────  POST /bridge/v1/pairings
                                                              (BootstrapRequest)
 3.                             vérifications (§2)
                                bridgeToken généré (256 bits)
                                fiche → PAIRED
                                            ─────────────▶  201 { projectId,
                                                                  bridgeToken,
                                                                  panel {name, version} }
                                                            le projet stocke le token
                                                            chiffré, passe CONNECTED
```

Après le bootstrap, plus aucun secret ne circule : les heartbeats et la
synchronisation utilisent le bridgeToken.

## 2. Vérifications au bootstrap (dans cet ordre)

| # | Vérification | Refus |
|---|---|---|
| 1 | Version majeure du contrat compatible | `409 BRIDGE_CONTRACT_VERSION_UNSUPPORTED` |
| 2 | DTO `BootstrapRequest` conforme (miroir zod strict) | `400 BRIDGE_INVALID_PAYLOAD` |
| 3 | Le code correspond à une fiche du registre (hash), non expiré, non consommé | `401 BRIDGE_PAIRING_CODE_INVALID` |
| 4 | Le `projectKey` présenté est celui de la fiche liée au code | `401 BRIDGE_PAIRING_CODE_INVALID` (le refus ne précise pas lequel des deux est faux) |
| 5 | La fiche n'est pas déjà PAIRED | `409 BRIDGE_ALREADY_PAIRED` |

Succès : le code est **consommé** (même en cas d'échec ultérieur du projet à
stocker son token — regénérer un code est trivial, réutiliser un code ne
l'est jamais), la fiche enregistre `runtime` (ENV, versions, URL publique
éventuelle) et passe PAIRED.

## 3. Le code d'appairage

- Généré par le Panel à la déclaration du projet (ou regénéré à la demande
  tant que la fiche n'est pas PAIRED).
- **Usage unique, TTL 15 minutes** : un code qui traîne dans un chat ou un
  presse-papier meurt vite et ne sert qu'une fois.
- Format lisible (`PAIR-XXXX-XXXX-XXXX`, alphabet sans ambiguïté) : il est
  fait pour être recopié à la main entre deux écrans.
- Stocké **en hash SHA-256** ; affiché une seule fois, à sa génération.
- Le code n'est PAS un secret durable : il n'authentifie que le bootstrap.
  Le secret durable, c'est le bridgeToken qu'il permet d'obtenir.

## 4. La révocation (désappairage)

Trois chemins, un seul résultat — la fiche passe REVOKED, le hash du token
est effacé, toute requête portant l'ancien token répond `401` :

1. **Le projet se débranche** : `DELETE /bridge/v1/pairings/current` (avec
   son token). Réponse `{unpaired:true}` — idempotent du point de vue du
   projet.
2. **Le Panel révoque** : `DELETE /api/projects/:projectId/pairing`
   (action DEV, frontend). Par courtoisie, le Panel notifie le projet via
   `ProjectBridgeClient.notifyUnpair()` — best-effort : si le projet est
   injoignable, la révocation côté Panel reste acquise, et le projet
   constatera le 401 à son prochain appel puis passera STANDALONE de
   lui-même.
3. **Revente d'un projet** : cas 2 + suppression éventuelle de la fiche
   ([06_PROJECT_LIFECYCLE.md](06_PROJECT_LIFECYCLE.md) §5).

La révocation ferme **les deux sens** d'un coup (un seul secret d'appairage).
Elle n'affecte jamais les données du projet : tout ce qui était synchronisé
existe déjà chez lui.

## 5. Le ré-appairage

REVOKED → DECLARED : regénérer un code (action DEV), puis bootstrap normal.
Le projet reçoit un **nouveau** bridgeToken ; l'ancien reste mort. La fiche,
son historique et son Manifest sont conservés — le ré-appairage n'est pas une
re-création.

## 6. Invariants

1. Un code = un projet = un usage. Jamais de code « générique ».
2. Le Panel ne peut réafficher ni un code (hash seul) ni un token (hash +
   copie chiffrée réservée au `ProjectBridgeClient`) : aucune API ne les
   restitue.
3. Le bootstrap n'est jamais initié par le Panel : c'est toujours le projet
   qui appelle (HTTPS sortant du projet).
4. Un échec d'appairage laisse le projet exactement dans son état antérieur —
   UNCONFIGURED/STANDALONE est un état normal, pas une erreur.
5. La duplication d'un projet ne copie jamais un appairage : chaque projet
   fait son propre bootstrap avec son propre code.
