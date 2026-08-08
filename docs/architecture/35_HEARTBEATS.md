# 35 — Heartbeats : le signal passif

> **Référence officielle.** Phase 3A.
> Code : `services/supervision/heartbeat.service.js`,
> `services/supervision/liveness.service.js`.

---

## 1. Passif par conception

Le Panel **n'interroge jamais** un projet pour savoir s'il est vivant. Le
projet publie, à sa cadence, sur `POST /bridge/v1/heartbeats`.

Ce choix a trois conséquences qui tiennent à l'échelle :

1. **coût constant** — superviser 300 projets ne coûte pas 300 requêtes ;
2. **pas de faux négatif réseau** — le Panel ne conclut jamais « mort » parce
   que *lui* n'a pas pu joindre ;
3. **le silence est une information** — et c'est une information fiable.

## 2. Ce que publie un heartbeat

| Champ | Contrat | Obligatoire |
|---|---|---|
| `sentAt` | 1.0.0 | ✅ |
| `softwareVersion` | 1.0.0 | ✅ |
| `environment` | 1.0.0 | ✅ |
| `health.status` (`OK` / `DEGRADED`), `health.details` | 1.0.0 | ✅ / — |
| `bridgeStats.outboxSize`, `.lastSyncAt` | 1.0.0 | — |
| `runtime.uptimeSeconds`, `.startedAt` | **1.2.0** | — |
| `runtime.load.cpuPercent`, `.memoryUsedMb`, `.memoryTotalMb` | **1.2.0** | — |
| `runtime.components` (`{ id: OK\|WARNING\|ERROR\|UNKNOWN }`) | **1.2.0** | — |
| `engines.deployment`, `.duplication` | **1.2.0** | — |

Les champs 1.2.0 sont **tous optionnels**. Un projet qui ne les publie pas
reste pleinement conforme ; il apparaît simplement avec des `UNKNOWN`.

## 3. Vivacité : ONLINE / STALE / OFFLINE

Fonction **pure**, jamais stockée. La matérialiser produirait des fiches
« ONLINE » figées en base après l'arrêt du Panel.

```text
non appairé                            → NOT_PAIRED
appairé, aucun signal reçu             → NEVER_SEEN
dernier signal <  staleAfterS          → ONLINE
dernier signal <  offlineAfterS        → STALE
au-delà                                → OFFLINE
```

`NEVER_SEEN` n'est **pas** `OFFLINE` : on n'a jamais eu de signal, ce n'est
pas une perte. Confondre les deux ferait paraître en panne un projet
fraîchement appairé.

### Seuils — configurables

Exprimés en **multiples de l'intervalle de heartbeat attendu**, parce que
c'est le projet qui décide de sa cadence.

| Variable | Défaut | Effet |
|---|---|---|
| `HEARTBEAT_INTERVAL_S` | `300` | cadence attendue |
| `LIVENESS_STALE_FACTOR` | `2` | `STALE` après 2 × intervalle (600 s) |
| `LIVENESS_OFFLINE_FACTOR` | `6` | `OFFLINE` après 6 × intervalle (1800 s) |

Un parc distant ou volontairement lent règle ces facteurs sans toucher au
code. Les seuils effectifs sont exposés par `GET /api/supervision/dashboard`
(`panel.thresholds`) : l'opérateur voit la règle appliquée.

## 4. Historique

Chaque heartbeat est **archivé** (collection `panelheartbeats`), pas
seulement résumé sur la fiche. On veut lire une **tendance** :

- le projet redémarre-t-il en boucle ? (`uptimeSeconds` qui repart à zéro)
- sa mémoire dérive-t-elle ? (`load.memoryUsedMb` croissant)
- son signal est-il **régulier** ? (un projet qui envoie un heartbeat sur
  deux est `ONLINE` mais mérite un regard)

Rétention bornée par `HEARTBEAT_HISTORY_SIZE` (défaut 200, par projet) :
l'historique ne croît jamais sans fin.

### Statistiques

`heartbeatStats()` calcule le nombre de signaux, la fenêtre couverte, la
**cadence moyenne réelle**, la cadence attendue, et un verdict de régularité
(tolérance de 50 % au-dessus de l'attendu).

## 5. Ordre d'exécution — un détail qui compte

À la réception d'un heartbeat :

```text
1. archiveHeartbeat(record, dto)   ← compare au PRÉCÉDENT état
2. recordHeartbeat(record, dto)    ← met à jour la fiche
```

L'archivage doit précéder la mise à jour, sinon la comparaison se ferait
contre l'état déjà écrasé et **aucun changement ne serait jamais détecté**.
Ce commentaire est dans le code, à l'endroit exact où l'ordre compte.

## 6. Ce qu'un heartbeat ne fait jamais

1. ❌ déclencher une action côté Panel ;
2. ❌ modifier le projet émetteur ;
3. ❌ écraser une donnée connue avec un champ absent — un projet peut publier
   `runtime` par intermittence sans perdre ce qui était déjà su ;
4. ❌ faire échouer la requête si un champ optionnel manque ;
5. ❌ **avancer la fraîcheur métier de la fiche.**

Le cinquième point mérite son paragraphe. Un battement prouve qu'une instance
**répond** ; il ne transporte aucune donnée métier. `lastHeartbeatAt` et
`runtime.lastBusinessSyncAt` sont donc deux faits distincts, et un projet dont
l'entreprise ne change pas bat pendant des jours sans rien projeter : sa fiche
est vivante **et** n'a jamais rien reçu. Le badge « Connecté » se calcule
depuis la seule vivacité — jamais comme un `ET` entre les deux.

La date que le projet transporte dans `bridgeStats.lastSyncAt` est **sa
parole**, pas un constat du Panel : elle s'affiche sous « synchronisation
déclarée », à côté et jamais à la place.

→ `docs/ARCHITECTURE_CONTEXT.md` §4ter · `61_BUSINESS_PROJECTION.md` §4
→ `tests/project-live-business-sync.test.js` — `HEARTBEAT_DOES_NOT_ADVANCE_BUSINESS_FRESHNESS`
