# Contrats officiels des ponts — copie du Panel

Les deux fichiers de ce dossier sont la copie, **verbatim**, des contrats
OpenAPI v1.0.0 de l'écosystème :

- `PanelBridge.openapi.yaml` — sens PROJET → PANEL. **Le Panel implémente le
  côté SERVEUR de ce contrat** (`/bridge/v1/*`).
- `ProjectBridge.openapi.yaml` — sens PANEL → PROJET. **Le Panel implémente le
  côté CLIENT de ce contrat** (`ProjectBridgeClient`).

## Règles

1. Le **maître** de ces fichiers est le dossier `docs/panelXvitrine/spec/` du
   projet modèle (SB Auto 06). Les copies ici doivent rester **identiques
   octet par octet** — c'est vérifié par `tests/bridge-conformity.test.js`
   contre le miroir exécutable `backend/src/bridge/bridgeContract.js`.
2. Toute évolution du contrat est **additive** (version mineure). Une rupture
   exigerait une nouvelle majeure et une période de double-service — à éviter
   par conception.
3. Aucune évolution ne se fait unilatéralement côté Panel : elle est ratifiée
   dans le projet modèle d'abord, puis recopiée ici. Les propositions
   d'extension (ex. transport du Manifest) vivent dans
   [../architecture/PHASE_3_PREPARATION.md](../architecture/PHASE_3_PREPARATION.md)
   tant qu'elles ne sont pas ratifiées.
