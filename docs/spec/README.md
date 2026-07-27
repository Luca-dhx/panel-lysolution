# Contrats officiels des ponts — copie du Panel

Les deux fichiers de ce dossier sont la copie, **verbatim**, des contrats
OpenAPI **v1.1.0** de l'écosystème :

- `PanelBridge.openapi.yaml` — sens PROJET → PANEL. **Le Panel implémente le
  côté SERVEUR de ce contrat** (`/bridge/v1/*`).
- `ProjectBridge.openapi.yaml` — sens PANEL → PROJET. **Le Panel implémente le
  côté CLIENT de ce contrat** (`ProjectBridgeClient`).

Apports de la v1.1.0 (additifs, compatibles 1.0.x) :

- `BootstrapRequest.manifest` (optionnel) — le projet joint son **Manifest
  officiel** dès l'appairage ;
- `GET /api/project-bridge/v1/manifest` — le Panel peut relire le Manifest à
  tout moment ;
- schéma `ProjectManifest`, **identique dans les deux fichiers**.

## Gouvernance

1. Le **maître** de ces fichiers est le dossier `docs/panelXvitrine/spec/` du
   projet modèle (SB Auto 06). Les copies ici doivent rester **identiques**
   (à la normalisation des fins de ligne près).
2. Toute évolution du contrat est **additive** (version mineure), ratifiée
   dans le projet modèle d'abord, puis recopiée ici verbatim. Jamais
   l'inverse ; jamais une édition locale des copies.
3. Une rupture exigerait une nouvelle majeure et une période de
   double-service — à éviter par conception.

## Contrôles automatiques

| Contrôle | Fichier | Quand |
|---|---|---|
| Accord copies ↔ miroir exécutable (`backend/src/bridge/bridgeContract.js`) : version, chemins, codes d'erreur, entityTypes, schémas | `tests/bridge-conformity.test.js` | à chaque `npm test` |
| Dérive copies ↔ specs maîtresses du projet modèle (comparaison octet + diagnostic sémantique) | `tests/spec-drift.check.mjs` | à chaque `npm test` ; **SKIP propre** si le dépôt voisin n'est pas présent (aucune dépendance runtime — outil d'atelier du workspace d'audit ; `SPEC_REFERENCE_DIR` pour pointer ailleurs) |

## Compatibilité

Règle commune aux deux sens : même **majeure** exigée de part et d'autre ;
une mineure supérieure côté serveur est acceptable (évolutions additives
uniquement) ; majeure inconnue → `409 BRIDGE_CONTRACT_VERSION_UNSUPPORTED`.
