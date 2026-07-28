# 37 — Modèle de santé d'un projet

> **Référence officielle.** Phase 3A.
> Code : `services/supervision/health.service.js`.

---

## 1. Le principe : agréger, jamais deviner

Le Panel ne sonde rien. Sa santé d'un projet est une **agrégation** de ce que
le projet publie, plus quelques constats qu'il peut faire depuis les faits
qu'il détient (silence, versions).

> **Ce qu'un projet ne publie pas vaut `UNKNOWN`.**
> Jamais `OK` — un silence n'est pas une bonne nouvelle.
> Jamais `ERROR` — un silence n'est pas une panne.

C'est la règle qui sépare un tableau de bord honnête d'un tableau de bord
rassurant. Un parc plein d'`UNKNOWN` est un parc mal instrumenté : c'est une
information utile, et il faut la voir.

## 2. Les quatre états

| État | Signification |
|---|---|
| `OK` | fonctionne, constaté ou déclaré |
| `WARNING` | fonctionne, mais quelque chose mérite attention |
| `ERROR` | ne fonctionne pas, ou incompatibilité avérée |
| `UNKNOWN` | personne ne sait |

### Statut global = le pire des composants

Ordre de gravité croissant : `OK` < `UNKNOWN` < `WARNING` < `ERROR`.

`UNKNOWN` est **plus grave que `OK`** : un projet dont on ne sait rien ne
doit pas paraître aussi sain qu'un projet qui va bien. Il est **moins grave
que `WARNING`** : ne pas savoir n'est pas constater un problème.

## 3. Les composants supervisés

| Composant | Statut déterminé par | Source |
|---|---|---|
| `bridge` | appairage + compatibilité de contrat avec le Panel | PANEL |
| `heartbeat` | vivacité (ONLINE → OK, STALE → WARNING, OFFLINE → ERROR) | PANEL |
| `backend` | `health.status` du heartbeat (`OK`/`DEGRADED`) | PROJECT |
| `frontend` | `runtime.components.frontend` | PROJECT |
| `mongo` | `runtime.components.mongo` | PROJECT |
| `ssl` | `runtime.components.ssl` | PROJECT |
| `dns` | `runtime.components.dns` | PROJECT |
| `deploymentEngine` | comparaison de version avec le standard | PANEL |
| `duplicationEngine` | idem | PANEL |
| *(autres)* | tout composant publié par le projet est repris tel quel | PROJECT |

### La `source` — pourquoi elle est affichée

Chaque composant porte l'origine de son verdict :

| Source | Sens |
|---|---|
| `PROJECT` | le projet l'a déclaré |
| `PANEL` | le Panel l'a constaté depuis des faits qu'il détient |
| `UNAVAILABLE` | personne ne le sait |

Sans cette distinction, on confondrait « le projet dit que sa base va bien »
et « le Panel suppose que sa base va bien ». La seconde phrase n'existe pas
dans ce système.

## 4. Règles de comparaison de versions

### Contrat de pont

| Situation | Statut |
|---|---|
| même version que le Panel | `OK` |
| même majeure, version différente | `WARNING` — « contrat en retard » |
| majeure différente | `ERROR` — incompatibilité avérée |
| non publiée | `UNKNOWN` |

### Moteurs standards

Référence : la version que **le Panel lui-même embarque**. Le Panel ne
l'impose à personne — il constate un écart.

| Situation | Statut |
|---|---|
| version identique | `OK` |
| même majeure, en retard | `WARNING` |
| majeure divergente | `ERROR` |
| non publiée (contrat < 1.2.0) | `UNKNOWN` |

## 5. Alertes du parc

`buildAlerts()` transforme les santés individuelles en une liste triée
(erreurs d'abord). Chaque alerte porte un `code` stable :

| Code | Sévérité | Déclencheur |
|---|---|---|
| `HEARTBEAT_MISSING` | ERROR | vivacité `OFFLINE` |
| `HEARTBEAT_LATE` | WARNING | vivacité `STALE` |
| `BRIDGE_INCOMPATIBLE` | ERROR | majeure de contrat divergente |
| `BRIDGE_OUTDATED` | WARNING | contrat en retard |
| `ENGINE_DRIFT` | ERROR | majeure de moteur divergente |
| `ENGINE_OUTDATED` | WARNING | moteur en retard |
| `CERTIFICATE_EXPIRED` | ERROR | date d'expiration dépassée |
| `CERTIFICATE_EXPIRING` | WARNING | expiration dans ≤ `CERTIFICATE_WARNING_DAYS` (défaut 21) |
| `SOFTWARE_OUTDATED` | INFO | version applicative en retard sur la dernière connue |

### Le certificat : un relais, pas une inspection

Le Panel **n'inspecte aucun certificat** — ce serait une sonde réseau, donc
une violation de la règle de la phase. Il relaie uniquement une date
d'expiration publiée par le projet. Sans publication, aucune alerte : c'est
assumé et documenté.

### Une alerte est un constat

Aucune alerte ne propose d'action (« redéployez », « relancez »). C'est
vérifié par un test : le message ne doit contenir aucun impératif d'action.
La Phase 3A décrit ce qui est ; elle ne dit pas quoi faire.

## 6. Interdits

1. ❌ Marquer `OK` un composant qui n'a rien publié.
2. ❌ Sonder un projet pour établir sa santé.
3. ❌ Stocker le statut calculé — il se recalcule à chaque lecture.
4. ❌ Masquer les `UNKNOWN` pour « faire propre » : ils sont le signal d'un
   parc mal instrumenté.
5. ❌ Proposer une action corrective dans une alerte.
