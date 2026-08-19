// Utilisateurs du Panel (ADMIN, DEV superset) — mots de passe scrypt
// uniquement (jamais en clair), docs/architecture/04_AUTHENTICATION.md.
import mongoose from 'mongoose';

import { PANEL_ROLE_VALUES } from '../services/auth/panelRoles.js';

const panelUserSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true },
    /**
     * LE RÔLE — l'énumération vient de `panelRoles.js`, jamais recopiée.
     *
     * ── POURQUOI L'IMPORT PLUTÔT QU'UN LITTÉRAL ─────────────────────────────
     *
     * Ce champ portait `['ADMIN', 'DEV']` en dur. C'était la deuxième copie de
     * l'énumération, et c'est exactement le genre de duplication qui survit à
     * l'ajout d'un rôle : le service accepte `SUPER_ADMIN`, le schéma le
     * refuse, et l'erreur apparaît à l'écriture — loin de la décision.
     */
    role: { type: String, enum: [...PANEL_ROLE_VALUES], required: true },
    passwordHash: { type: String, required: true },

    /**
     * LE COMPTE EST-IL AUTORISÉ ? — distinct de `tokenVersion` (L12.A).
     *
     * ── POURQUOI DEUX NOTIONS, ET PAS UNE ───────────────────────────────────
     *
     *   `enabled`      le compte a-t-il le droit d'exister comme identité.
     *                  Répond à « cette personne travaille-t-elle encore ici ».
     *   `tokenVersion` les sessions déjà émises sont-elles encore valables.
     *                  Répond à « faut-il déconnecter partout maintenant ».
     *
     * Les confondre coûterait cher dans les deux sens : incrémenter
     * `tokenVersion` pour désactiver un compte le déconnecterait sans lui
     * interdire de se reconnecter ; mettre `enabled: false` sans toucher aux
     * versions laisserait vivre les sessions en cours. On fait donc les deux,
     * et chacune garde son sens.
     *
     * `default: true` : les comptes antérieurs à ce champ sont des comptes en
     * exercice. Un défaut fermé les aurait tous verrouillés au déploiement —
     * un fail-closed qui protège de rien et coupe tout le monde n'est pas une
     * précaution, c'est une panne.
     */
    enabled: { type: Boolean, required: true, default: true },

    /**
     * ACCÈS AUX PROJETS — le contrat explicite exigé avant toute fédération.
     *
     * ── POURQUOI CE CHAMP N'EST PAS UN BOOLÉEN ──────────────────────────────
     *
     * « ce DEV peut-il accéder aux projets » est la mauvaise question : elle
     * n'a que deux réponses, et la bonne dépend du projet. Un prestataire
     * ponctuel doit pouvoir accéder à UN projet sans obtenir le parc entier.
     *
     *   NONE        aucun accès. LE DÉFAUT, y compris pour un DEV.
     *   EXPLICIT    seulement les projets listés dans `projectIds`.
     *   ALL_PAIRED  tous les projets appairés — pour l'exploitant du parc.
     *
     * ── POURQUOI `NONE` PAR DÉFAUT, ICI, ALORS QUE `enabled` EST OUVERT ─────
     *
     * Parce que les deux défauts ne portent pas le même risque. `enabled: true`
     * préserve un accès qui existait déjà ; `projectAccess: ALL_PAIRED` en
     * créerait un qui n'a jamais existé — et l'accorderait à tout DEV, sur tout
     * projet, sans que personne l'ait décidé. C'est exactement ce que le lot
     * interdit : « ne pas coder tous les PanelUser → tous les projets ».
     *
     * Conséquence assumée : la fédération est INERTE tant qu'un accès n'a pas
     * été accordé. C'est le bon sens de la marche.
     */
    projectAccess: {
      type: new mongoose.Schema(
        {
          mode: {
            type: String,
            enum: ['NONE', 'EXPLICIT', 'ALL_PAIRED'],
            required: true,
            default: 'NONE',
          },
          /** Lu UNIQUEMENT en mode EXPLICIT. Ignoré ailleurs, jamais purgé. */
          projectIds: { type: [String], default: [] },
          grantedAt: { type: String, default: null },
          grantedBy: { type: String, default: null },
        },
        { _id: false },
      ),
      default: () => ({ mode: 'NONE', projectIds: [] }),
    },

    tokenVersion: { type: Number, required: true, default: 0 },
    passwordResetRequestId: { type: String, default: null },
    passwordResetTokenHash: { type: String, default: null },
    passwordResetExpiresAt: { type: String, default: null },
    passwordResetRequestedAt: { type: String, default: null },
    passwordChangedAt: { type: String, default: null },
    createdAt: { type: String, required: true },
  },
  { versionKey: false },
);

export default mongoose.model('PanelUser', panelUserSchema);
