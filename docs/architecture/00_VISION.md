# 00 — Vision : ce que le Panel est, et ce qu'il n'est pas

> Document fondateur du dépôt Panel. La documentation de l'écosystème
> (`SB Auto 06/docs/panelXvitrine/`) fixe les règles communes ; ce document
> les regarde **du point de vue du Panel** et fixe ce que ce dépôt s'autorise.

---

## 1. Raison d'être

Demain, des dizaines de projets quasi identiques — un par client — vivront en
parallèle. Chacun est un logiciel complet (backend + Manager + vitrine + sa
base Mongo) qui fonctionne seul. Administrer N projets un par un ne passe pas
à l'échelle : le Panel existe pour offrir **une seule interface** face au parc.

```
                    ┌───────────────────────────┐
                    │   PANEL L.Y SOLUTION      │
                    │   panel.ly-solution.com   │
                    │                           │
                    │   registre des projets    │
                    │   appairage · supervision │
                    │   (puis : contrats,       │
                    │    factures, événements,  │
                    │    templates, APIs…)      │
                    └────────────┬──────────────┘
                                 │ deux contrats versionnés, rien d'autre
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌───────────┐      ┌───────────┐      ┌───────────┐
        │ Projet A  │      │ Projet B  │      │ Projet N  │
        └───────────┘      └───────────┘      └───────────┘
```

Le Panel est un **second point d'administration** : tout ce qui est
synchronisé reste administrable depuis le Manager de chaque projet. Le Panel
apporte la centralisation (une saisie pour N projets), la supervision et les
outils internes. Il n'apporte jamais une dépendance.

## 2. Les trois phrases qui gouvernent ce dépôt

1. **Un projet doit toujours pouvoir fonctionner sans le Panel.** Le Panel
   n'est propriétaire de rien dans un projet ; le débrancher est une opération
   propre et documentée, pas une amputation.
2. **Le Panel ne connaît d'un projet que deux contrats.** Le contrat qu'il
   expose ([PanelBridge](../spec/PanelBridge.openapi.yaml)) et le contrat
   qu'il consomme ([ProjectBridge](../spec/ProjectBridge.openapi.yaml)).
   Jamais Mongo, jamais les modèles, jamais les routes internes d'un projet.
3. **Le Panel est lui-même un projet standard.** Un backend, une interface,
   les mêmes conventions, le même pipeline de déploiement que les projets
   ([07_DEPLOYMENT.md](07_DEPLOYMENT.md)). Une seule architecture à maintenir.

## 3. Le Panel ne devine jamais

Avec un parc hétérogène (des projets de versions différentes, des projets qui
n'offrent pas tous les mêmes modules), le Panel a besoin de savoir **à qui il
parle** sans inspecter l'intérieur des projets. Deux mécanismes, propres à ce
dépôt, répondent à ce besoin :

- le **Manager Standard** ([20_MANAGER_STANDARD.md](20_MANAGER_STANDARD.md)) :
  le squelette officiel qu'un projet compatible expose — surfaces, domaines,
  comptes, bridge. Le Panel se repose sur ce standard, jamais sur une
  connaissance implicite d'un projet particulier ;
- les **capacités** ([21_PROJECT_CAPABILITIES.md](21_PROJECT_CAPABILITIES.md)) :
  chaque projet déclare ce qu'il sait faire (`features` et `modules`
  du **Manifest** officiel) ; le Panel adapte son interface à cette
  déclaration, automatiquement.

> Règle : si le Panel a besoin d'une information sur un projet, elle vient du
> Manifest, du contrat de pont, ou du registre — jamais d'un `if (projet ===
> 'sb-auto-06')`. **Aucune logique spécifique à un projet n'entre dans ce
> dépôt.** SB Auto 06 est le premier projet compatible, pas un cas spécial.

## 4. Classification des données, vue du Panel

Toute donnée manipulée ici appartient à exactement une catégorie (la
classification est fixée par l'écosystème ; rappel du point de vue Panel) :

| Catégorie | Vue du Panel | Exemples |
|---|---|---|
| **1 — locale au projet** | invisible et intouchable ; au mieux observée via la supervision | services, réservations, thème, comptes locaux, moteurs |
| **2 — synchronisée** | existera dans le Panel ET dans chaque projet, éditable des deux côtés, synchronisation automatique (Phase 3+) | contrats, factures, société développeur, templates, config IntegratedAPI, événements |
| **3 — exclusivement Panel** | n'existe qu'ici, ne transite jamais vers un projet | **le registre des projets**, les codes d'appairage, les utilisateurs du Panel, la supervision, les vues multi-projets |

La Phase 2B ne construit **que de la catégorie 3** (plus le transport neutre
`DIAGNOSTIC` du contrat de synchronisation). C'est voulu : aucun domaine n'est
mis sous synchronisation avant la Phase 3.

## 5. Ce que ce dépôt s'interdit

1. ❌ Ouvrir une connexion vers la base Mongo d'un projet.
2. ❌ Appeler un projet ailleurs que par `ProjectBridgeClient` (un seul
   fichier parle réseau aux projets).
3. ❌ Écrire une donnée locale (catégorie 1) d'un projet, ou « télécommander »
   son métier hors du catalogue fermé d'opérations.
4. ❌ Dupliquer ou déployer un projet. Le Panel apprend l'existence d'un
   projet à l'appairage ; il ne le crée pas.
5. ❌ Envoyer à un Manager autre chose que les deux booléens `{admin, dev}`
   (jamais un rôle, jamais une permission — [04_AUTHENTICATION.md](04_AUTHENTICATION.md)).
6. ❌ Toute logique spécifique à un projet nommé (SB Auto 06 compris).
7. ❌ Faire évoluer les contrats de pont unilatéralement
   ([../spec/README.md](../spec/README.md)).
8. ❌ De la gouvernance de synchronisation au-delà des cinq règles minimales
   (dernier écrit gagne, UUID, tombstones, anti-écho, idempotence).

## 6. Périmètre exact de la Phase 2B

| Inclus | Exclu (Phase 3+) |
|---|---|
| Registre des projets + appairage complet | Persistance Mongo (stores en RAM derrière des interfaces stables) |
| Serveur PanelBridge v1.1.0 (ping, pairing, heartbeat, sync DIAGNOSTIC) | Synchronisation des domaines métier (lots C1–C5) |
| Client ProjectBridge (driver unique) | Supervision riche, statistiques |
| Manifest + Capabilities (validation, interprétation) | Transport du Manifest par le contrat de pont (ratification 1.1) |
| Auth Panel v1 (ADMIN/DEV, JWT, seed) | RBAC complet, émission `{admin, dev}` vers les Managers |
| Frontend : connexion, dashboard, projets, états bridges/versions/pairings | Webhooks centralisés, contrats/factures, CRM, réunions |

Le détail de ce qui attend la Phase 3 :
[PHASE_3_PREPARATION.md](PHASE_3_PREPARATION.md).
