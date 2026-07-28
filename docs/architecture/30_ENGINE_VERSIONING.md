# 30 — Versionnement des moteurs

> **Référence officielle.** Quand incrémenter PATCH, MINOR ou MAJOR, et ce
> que chaque champ du manifeste signifie.
> Établi en Phase 2E.

---

## 1. La règle fondamentale

> **Ne jamais laisser un moteur sans version.**

Un moteur sans version est ingérable : on ne peut ni savoir ce dont il
dispose, ni décider s'il faut le migrer, ni diagnostiquer un projet livré il
y a deux ans. `validateManifest()` refuse tout manifeste incomplet, et un
test le vérifie à chaque exécution de la suite.

## 2. Les champs du manifeste

```json
{
  "engine": "deployment-engine",
  "version": "1.1.0",
  "engineApiVersion": "1",
  "contractVersion": "1.1.0",
  "minimumCompatibleVersion": "1.0.0",
  "layoutVersion": "2",
  "releaseDate": "2026-07-27",
  "supportedProfiles": ["sbauto", "panel"],
  "capabilities": ["preflight", "releases", "rollback", "…"],
  "breakingChanges": []
}
```

| Champ | Ce qu'il dit | Quand il change |
|---|---|---|
| `version` | version du moteur (semver) | à chaque publication |
| `engineApiVersion` | version de l'**API publique** de la façade | uniquement sur rupture d'API |
| `contractVersion` | version du contrat Bridge de l'écosystème | quand le contrat évolue |
| `minimumCompatibleVersion` | la plus ancienne version d'état que ce moteur sait piloter | quand on cesse de supporter une ancienne |
| `layoutVersion` | version de la **structure de dossiers** du moteur | quand l'arborescence change |
| `releaseDate` | date de publication (AAAA-MM-JJ) | à chaque publication |
| `supportedProfiles` | slugs de profils validés | quand un nouveau type de projet est validé |
| `capabilities` | ce que le moteur sait faire | à chaque capacité ajoutée |
| `breakingChanges` | ruptures introduites par cette majeure | sur une MAJOR |
| `history` | journal des versions (type, résumé, rupture) | à chaque publication |

## 3. Quand incrémenter

### PATCH — `1.1.0 → 1.1.1`

**Une correction, sans changement de comportement attendu.**

Incrémenter quand :

- un bug est corrigé sans modifier une signature ni un contrat ;
- un message d'erreur est amélioré ;
- une commande distante est rendue plus robuste (retry, timeout) ;
- un commentaire ou une documentation interne est corrigé.

Ne **jamais** incrémenter PATCH si :

- une fonction publique change de signature ;
- un code d'erreur change de valeur ;
- une nouvelle capacité apparaît.

Compatibilité : **totale**, dans les deux sens. Aucune migration.

### MINOR — `1.1.0 → 1.2.0`

**Une nouvelle capacité, sans rien casser.**

Incrémenter quand :

- une fonction ou une méthode de façade est **ajoutée** ;
- une nouvelle entrée apparaît dans `capabilities` ;
- un nouveau champ **optionnel** est reconnu dans le profil ;
- un nouveau rôle d'application est compris par le générateur Nginx ;
- une migration est ajoutée au catalogue.

Règle absolue : **un projet qui ne change rien continue de fonctionner.**
Tout nouveau champ de profil doit avoir un comportement par défaut — comme
`nginxRole`, déduit de `role` quand il est absent.

Compatibilité : ascendante. Une migration peut être **conseillée**, jamais
imposée.

### MAJOR — `1.x.y → 2.0.0`

**Une rupture. Migration nécessaire.**

Incrémenter quand :

- une fonction publique est **supprimée** ou change de signature ;
- un champ de profil devient **obligatoire** ;
- un code d'erreur change de valeur ou disparaît ;
- la structure de dossiers change de façon incompatible
  (`layoutVersion` change alors aussi) ;
- une valeur par défaut change au point d'altérer un déploiement existant.

Obligations d'une MAJOR :

1. chaque rupture est listée dans `breakingChanges`, avec sa raison ;
2. une **migration** est fournie pour chaque rupture automatisable ;
3. les ruptures non automatisables portent des **étapes manuelles** précises ;
4. `minimumCompatibleVersion` est relevée ;
5. `isEngineCompatible()` refuse les versions de majeure différente — c'est
   volontaire et testé.

Compatibilité : **aucune** entre majeures. Un moteur 2.x refuse de piloter un
état produit par un 1.x, et le dit.

## 4. Tableau de décision

| Changement | PATCH | MINOR | MAJOR |
|---|:--:|:--:|:--:|
| Correction sans effet de bord | ✅ | | |
| Message d'erreur amélioré | ✅ | | |
| Nouvelle fonction de façade | | ✅ | |
| Nouvelle capacité déclarée | | ✅ | |
| Nouveau champ de profil **optionnel** | | ✅ | |
| Nouveau rôle d'application reconnu | | ✅ | |
| Nouvelle migration au catalogue | | ✅ | |
| Signature d'une fonction publique modifiée | | | ✅ |
| Fonction publique supprimée | | | ✅ |
| Champ de profil rendu **obligatoire** | | | ✅ |
| Code d'erreur modifié ou supprimé | | | ✅ |
| Structure de dossiers incompatible | | | ✅ |

## 5. Les deux moteurs avancent ensemble sur la majeure

`deployment-engine` et `duplication-engine` peuvent avoir des MINOR et des
PATCH distincts, mais **partagent leur MAJEURE** : le second dépend du
premier, et une rupture de l'un impose de vérifier l'autre. Un test le
vérifie.

## 6. Compatibilité — la règle appliquée par le code

`isEngineCompatible(versionDeLÉtat)` répond compatible si, et seulement si :

1. **même majeure** que le moteur — sinon `MAJOR_MISMATCH` ;
2. version ≥ `minimumCompatibleVersion` — sinon `TOO_OLD` ;
3. version ≤ version du moteur — sinon `TOO_RECENT` (on ne pilote pas un
   état produit par un moteur plus récent que soi).

## 7. Historique actuel

| Moteur | Version | Date | Type | Contenu |
|---|---|---|---|---|
| `deployment-engine` | **1.1.0** | 2026-07-27 | MINOR | Nginx piloté par le profil ; rollback complet dans la façade avec restauration automatique ; introspection ; migrations |
| `deployment-engine` | 1.0.0 | 2026-07-27 | — | Standardisation initiale : profil de projet, dossiers standards, contrôle de dérive |
| `duplication-engine` | **1.1.0** | 2026-07-27 | MINOR | Manifeste étendu, introspection, alignement de gouvernance |
| `duplication-engine` | 1.0.0 | 2026-07-27 | — | Standardisation initiale : profil de duplication, régénération des secrets |

Aucune rupture n'a été introduite à ce jour : `breakingChanges` est vide dans
les deux moteurs.
