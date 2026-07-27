// Utilisateurs du Panel (ADMIN, DEV superset) — mots de passe scrypt
// uniquement (jamais en clair), docs/architecture/04_AUTHENTICATION.md.
import mongoose from 'mongoose';

const panelUserSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true },
    role: { type: String, enum: ['ADMIN', 'DEV'], required: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: String, required: true },
  },
  { versionKey: false },
);

export default mongoose.model('PanelUser', panelUserSchema);
