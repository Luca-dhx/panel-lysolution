# 56 — Créer un nouveau projet vitrine

> **Guide opératoire.** Phase 4.
> La question à laquelle ce document répond : *le processus éprouvé sur
> SB Auto 06 vaut-il pour un projet suivant ?*

---

## 1. Réponse courte

**Oui.** Rien de ce qui a été fait en Phase 4 n'est spécifique à SB Auto 06.
Le Panel ne connaît de lui que ce que son Manifest déclare ; le projet ne
connaît du Panel que le contrat de pont. Les deux sont interchangeables.

Ce qui le garantit, concrètement :

| Élément | Spécifique à SB Auto 06 ? |
|---|---|
| Contrat de pont | non — c'est une spec, identique dans les deux dépôts |
| Moteurs (déploiement, duplication) | non — cœur identique, divergence par `config/` |
| Manifest | déclaratif : chaque projet publie le sien |
| Configuration d'entreprise | diffusée à **tout** le parc |
| API intégrées | accordées **par projet**, jamais globales |
| Supervision, diagnostic, pilotage | pilotés par le Manifest, pas par le nom |

## 2. Le chemin complet

```text
1. DUPLIQUER   le projet de référence     (duplication-engine)
2. CONFIGURER  le .env de la copie
3. DÉMARRER    et vérifier qu'il sert son site
4. DÉCLARER    le projet dans le Panel    → code d'appairage
5. SONDER      son URL depuis le Panel
6. APPAIRER    depuis le projet
7. ACCORDER    les API intégrées dont il a besoin
8. DÉCOUVRIR   depuis le Panel            → convergence constatée
```

Les étapes 4 à 8 sont exactement celles du `55_PAIRING_GUIDE.md`. Aucune
n'est adaptée au premier projet.

## 3. Étape 1 — dupliquer

Le moteur de duplication (`28_DUPLICATION_ENGINE_STANDARD.md`) copie le
projet de référence, crée les bases, **régénère les secrets** et réécrit le
`.env`.

Le point qui compte pour la sécurité : `JWT_SECRET` et
`INTEGRATED_API_ENCRYPTION_KEY` sont **régénérés**, jamais hérités. Un défaut
inverse avait été trouvé et corrigé en Phase 2D — une copie qui hérite des
secrets de sa source n'est pas un nouveau projet, c'est un clone qui peut
lire ses données.

## 4. Étape 2 — configurer

Ce qui doit **impérativement** différer de tout autre projet :

| Variable | Pourquoi |
|---|---|
| `PROJECT_NAME` | détermine le `projectKey` — il doit être unique au parc |
| `DB_TEST` / `DB_PROD` | deux projets sur une même base se corrompent |
| `JWT_SECRET` | sessions cloisonnées |
| `INTEGRATED_API_ENCRYPTION_KEY` | secrets cloisonnés |
| `PUBLIC_BACKEND_URL` | l'adresse par laquelle le Panel le joindra |

Ce qui doit être **identique** : `PANEL_URL`. Tous les projets d'une même
entreprise pointent vers le même Panel.

## 5. Étape 3 — vérifier l'autonomie AVANT d'appairer

Un projet doit servir son site **sans** Panel. Vérifiez-le avant d'appairer :
c'est la garantie qui vous protégera le jour où le Panel tombera.

```bash
curl http://localhost:4000/api/health
curl -H "x-bridge-contract-version: 1.3.0" \
     http://localhost:4000/api/project-bridge/v1/ping
```

Le second doit répondre `paired: false` — état normal, pas une erreur.

## 6. Étapes 4 à 6 — déclarer, sonder, appairer

Voir `55_PAIRING_GUIDE.md`. Rien de particulier au deuxième projet.

Au terme de l'appairage, le nouveau projet reçoit **automatiquement**
l'entreprise et sa marque : il affiche le même logo, les mêmes mentions
légales, les mêmes coordonnées que le premier. C'est l'intérêt principal du
modèle — l'identité est saisie une fois.

## 7. Étape 7 — accorder les API intégrées

Un nouveau projet ne reçoit **aucune** API par défaut. C'est délibéré : les
accès se donnent, ils ne s'héritent pas.

Panel → **Entreprise** → **API intégrées** → pour chaque API nécessaire :
« Accorder l'accès », en choisissant le projet et, s'il y a lieu, les clés.

Deux réglages à comprendre :

- **restriction par clé** — un projet vitrine a besoin de la clé *publique*
  d'un fournisseur de paiement, pas de la clé secrète. Cocher les clés
  accordées permet exactement cela ;
- **le mode suit le projet** — un projet en TEST reçoit les identifiants
  TEST, quel que soit le mode affiché côté Panel. Le projet le vérifie une
  seconde fois à réception et **refuse** une charge utile qui ne correspond
  pas à son environnement.

## 8. Étape 8 — découvrir

Panel → fiche projet → **Piloter ce projet** → « Découvrir le projet ».

L'action lit identité, Manifest, santé, opérations, et relève ce que le
projet a **réellement appliqué**. La fiche affiche alors :

> Le projet applique la version 2, celle qui est publiée.

Tant que cette phrase ne s'affiche pas, la configuration n'est pas arrivée —
et le Panel le dit plutôt que de le supposer.

## 9. Ce qu'un nouveau projet hérite, et ce qu'il ne peut pas hériter

| Hérité automatiquement | Doit être fait explicitement |
|---|---|
| identité de l'entreprise | l'appairage |
| marque, couleurs, logos | les accès aux API intégrées |
| mentions légales, contacts | le domaine et son certificat |
| paramètres (langue, devise) | le déploiement |

## 10. Limite honnête

Ce processus a été éprouvé de bout en bout **sur un projet**, en local, par
le test d'écosystème. Il n'a pas encore été exécuté sur un **second** projet
réel, ni sur un serveur.

Rien dans le code ne suppose l'unicité — le registre, le journal de
synchronisation et les autorisations sont tous multi-projets par
construction, et le journal porte un destinataire précisément pour cela.
Mais « rien ne s'y oppose » n'est pas « cela a été vérifié ». Le premier
duplicata réel reste à faire.
