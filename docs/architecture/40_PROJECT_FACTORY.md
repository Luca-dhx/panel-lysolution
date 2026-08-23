# Fabriquer un nouveau projet — la chaîne, et son ordre

> Certifié le 2026-08-23 en produisant réellement un projet neuf,
> « Factory Certification 001 », de la duplication jusqu'au site en ligne, sur le
> VPS qui porte déjà le Panel et la démo.

## 1. L'ordre compte, et voici pourquoi

```
1. DUPLIQUER          le moteur de duplication, jamais une copie de dossier
2. CONFIGURER         .env de la copie : identité, bases, PANEL_URL + code d'appairage
3. DÉCLARER           au Panel : le projet et SON DOMAINE
4. DÉMARRER           le projet s'appaire TOUT SEUL au premier boot
5. DÉPLOYER           DNS, TLS, Nginx, PM2 — tout automatique
6. RATTACHER          l'entreprise cliente, depuis le Panel
7. EXPLOITER          personnalisation, catalogue, validation commerciale
```

**L'étape 3 avant l'étape 5, et ce n'est pas un détail.** Le DNS automatique passe
par la capacité `dns.*` du Panel, et le Panel n'écrit un enregistrement que pour
un nom **qui appartient au projet**. L'appartenance se lit sur la **destination
active**, créée quand on déclare le projet avec son URL. Déployer avant de
déclarer, c'est se retrouver à créer les enregistrements DNS à la main.

**L'étape 4 avant l'étape 5**, pour la même raison : le jeton de pont obtenu à
l'appairage est ce qui autorise à demander la capacité DNS.

## 2. L'appairage ne demande aucune intervention

Le compte **DEV** est le seul habilité à appairer, et il naît **sans mot de
passe** : son titulaire l'active par un lien envoyé par courriel. Or le courriel
passe par le Panel — auquel on n'est pas encore relié. Un projet neuf ne peut
donc pas être appairé par un humain.

Il n'a pas à l'être. Deux variables dans le `.env` de la copie suffisent :

```
PANEL_URL=https://api.panel.ly-solution.com
PANEL_PAIRING_CODE=PAIR-XXXX-XXXX-XXXX
PUBLIC_BACKEND_URL=https://api.<domaine-du-projet>
```

Au premier démarrage, le projet s'appaire, et **dans la foulée** reçoit :
l'identité de l'entreprise développeuse, le contrat de variables e-mail, le
secret de vérification de son endpoint Stripe, et la déclaration que
SIGNATURE / BREVO / HOSTINGER sont administrés par la plateforme.

Le code est **à usage unique** : une fois consommé, il peut — et devrait —
disparaître du `.env`.

## 3. Ce qu'une copie n'hérite jamais

Voir `SB Auto 06/docs/DUPLICATION.md` pour le détail. En résumé : secrets
régénérés, bases propres, dépôt propre, administrateur propre, **identité
technique dérivée du nom** (`PROJECT_SLUG` / `PROJECT_ID`), et `uploads` recréé
**vide** — les médias appartiennent au client de la source.

## 4. Aucun secret fournisseur ne descend jusqu'au projet

Un projet ne reçoit **jamais** de clé Stripe, Brevo ou OpenSign. Il consomme des
**capacités** : il demande, le Panel exécute avec sa propre clé, et rend un
résultat. Le `.env` d'un projet ne contient que ce qui lui est propre — bases,
`JWT_SECRET`, clé de chiffrement local — et rien d'un fournisseur.

Le seul secret qui descend est le **secret de vérification d'un webhook**, qui
n'ouvre aucun accès : il sert à vérifier une signature entrante, et il est propre
à l'endpoint de ce projet.

Les secrets d'infrastructure (mot de passe SSH du VPS) restent dans le plan de
contrôle, en RAM le temps d'une session, jamais persistés.

## 5. L'environnement du fournisseur vient du PROJET

```
providerEnvironment = resolveFrom(PROJECT.environment, PROVIDER.runtimeModel)
```

Jamais `PANEL.environment`, jamais un champ de la requête. Un projet TEST parle à
Stripe TEST même si le Panel tourne ailleurs — vérifié sur le projet neuf : sa
liaison Stripe est née en `TEST`, et aucune liaison PROD n'existe pour lui.

## 6. Ce qui a été trouvé en fabriquant le premier projet

Aucun de ces défauts n'était visible sur un parc d'un seul projet.

| défaut | ce qu'il aurait produit au 2ᵉ projet |
|---|---|
| l'identité technique n'était pas réécrite | dix clients annonçant tous `sbauto06`, et leurs sauvegardes mélangées dans `/var/backups/sbauto` |
| `uploads` était copié | les photos d'un garage livrées chez un autre |
| le registre de ports d'un projet neuf est vide | le 2ᵉ projet du serveur prend le port du Panel et ne démarre jamais |
| le pilote CLI n'avait pas de client de capacités | DNS manuel à chaque déploiement en ligne de commande |
| `localhost` acceptée comme adresse publique | tout développeur lançant un projet en local détruit la connaissance du domaine de production |
| deux runtimes indiscernables | la fiche affiche, en alternance et sans le dire, l'état de deux logiciels |

## 7. Ce qui reste manuel — et c'est voulu

- **Saisir l'identité du projet** : nom, domaine, bases, adresse du premier
  administrateur. C'est de la donnée métier, pas de la plomberie.
- **Coller le code d'appairage** dans le `.env` de la copie. Un code à usage
  unique ne se devine pas ; le transmettre est un acte d'autorisation.
- **Créer et rattacher l'entreprise cliente**, avec ses données légales.
- **Personnaliser** le contenu, le catalogue, le thème.

Aucun accès à la base, aucun SSH, aucune configuration de serveur web, aucun
enregistrement DNS, aucun certificat, aucun port à choisir.
