# 06 — La vie d'un projet, vue du Panel

> Prérequis : [02_PROJECT_REGISTRY.md](02_PROJECT_REGISTRY.md),
> [05_PAIRING.md](05_PAIRING.md).

Ce document suit un projet de sa naissance (hors du Panel) à sa sortie du
parc (revente), et fixe ce que le Panel fait — et surtout ne fait pas — à
chaque étape.

---

## 1. Naissance : le Panel est spectateur

Un projet naît par **duplication locale** d'un projet existant, depuis le
Manager du projet source. Le Panel n'y participe pas : il ne duplique pas, ne
déploie pas, ne provisionne pas. Il apprend l'existence du nouveau projet en
deux temps :

1. **Déclaration** (nous, dans le frontend du Panel) : création de la fiche
   DECLARED + code d'appairage.
2. **Bootstrap** (le projet, depuis sa page « Connexion Panel ») : la fiche
   passe PAIRED, le registre peut noter la filiation si le projet la déclare.

Un projet peut vivre indéfiniment sans jamais être déclaré : STANDALONE est
l'état de référence de l'écosystème, pas une anomalie.

## 2. L'axe d'appairage (état contractuel)

```
                 code émis                bootstrap
   (fiche créée) ────────▶  DECLARED  ─────────────▶  PAIRED
                               ▲                        │
                               │ nouveau code           │ révocation
                               │ (ré-appairage)         ▼ (projet, Panel, ou vente)
                               └───────────────────  REVOKED
```

- **DECLARED** — la fiche existe, le projet ne s'est jamais présenté (ou un
  code a été regénéré après révocation). Aucune communication possible.
- **PAIRED** — bridgeToken actif ; les deux sens du pont sont ouverts.
- **REVOKED** — appairage fermé. La fiche, l'historique et le Manifest sont
  conservés : révoquer n'est pas oublier.

## 3. L'axe de vivacité (état observé, dérivé — jamais stocké)

Pour une fiche PAIRED, le Panel dérive la joignabilité des heartbeats reçus
(intervalle attendu : `HEARTBEAT_INTERVAL_S`, 300 s par défaut) :

| État | Condition | Lecture |
|---|---|---|
| **NEVER_SEEN** | appairé, aucun heartbeat encore reçu | vient d'être appairé, ou son backend n'a jamais redémarré depuis |
| **ONLINE** | dernier heartbeat < 2 × intervalle | vivant |
| **STALE** | entre 2 × et 6 × intervalle | probablement en train de redémarrer, réseau hésitant |
| **OFFLINE** | > 6 × intervalle | éteint ou coupé du Panel |

Trois rappels d'interprétation :

1. Un projet OFFLINE n'est **pas** un projet en panne : c'est un projet que
   le Panel ne voit plus. Son site, son Manager et son métier tournent
   peut-être parfaitement (mode DEGRADED/STANDALONE côté projet).
2. Le Panel ne déclenche **rien** automatiquement sur un passage OFFLINE : la
   supervision constate, l'humain décide.
3. Ces états sont calculés à la lecture (fonction pure du dernier heartbeat
   et de l'horloge) — jamais écrits en base, donc jamais périmés.

## 4. La matrice complète

| Appairage \ Vivacité | — | NEVER_SEEN | ONLINE | STALE | OFFLINE |
|---|---|---|---|---|---|
| **DECLARED** | en attente du bootstrap | | | | |
| **PAIRED** | | vient d'arriver | nominal | à surveiller | débranché de fait |
| **REVOKED** | standalone assumé (ou revendu) | | | | |

Le frontend (pages « Bridges » et « Pairings ») affiche ces deux axes
séparément — les confondre produirait des diagnostics faux (« REVOKED » n'est
pas « OFFLINE »).

## 5. Sortie du parc : la revente

Checklist côté Panel (le reste appartient au vendeur et au repreneur) :

1. Révoquer l'appairage (`DELETE /api/projects/:id/pairing`) — le projet
   passe STANDALONE, complet et fonctionnel.
2. Supprimer la fiche du registre (`DELETE /api/projects/:id`) si le projet
   quitte définitivement le parc. Le Panel oublie le projet ; le projet, lui,
   ne perd rien (toutes ses données sont chez lui — c'est la promesse de la
   catégorie 2).
3. Rien d'autre. Le Panel ne « migre » rien, ne « transfère » rien : il
   n'avait rien en propre à transférer.

Le repreneur peut implémenter son propre système central en parlant les deux
contrats — le projet peut alors se ré-appairer à SA solution, avec un
bootstrap identique.

## 6. Interdits du cycle de vie

1. ❌ Créer, dupliquer, déployer ou éteindre un projet depuis le Panel.
2. ❌ Une transition d'appairage implicite (seuls le bootstrap et les
   révocations explicites changent l'axe d'appairage).
3. ❌ Stocker un état de vivacité (toujours dérivé).
4. ❌ Réagir automatiquement à OFFLINE (alerte oui — Phase 3 ; action non).
5. ❌ Supprimer une fiche encore PAIRED : on révoque d'abord, on supprime
   ensuite — l'ordre est significatif et testé.
