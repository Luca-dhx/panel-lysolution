import mongoose from 'mongoose';

export const PASSWORD_RESET_REQUEST_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED',
  RATE_LIMITED: 'RATE_LIMITED',
  IGNORED_UNKNOWN_ACCOUNT: 'IGNORED_UNKNOWN_ACCOUNT',
  EMAIL_ACCEPTED: 'EMAIL_ACCEPTED',
  EMAIL_REFUSED: 'EMAIL_REFUSED',
  EMAIL_UNKNOWN: 'EMAIL_UNKNOWN',
  EMAIL_DELIVERED: 'EMAIL_DELIVERED',
  EMAIL_BOUNCED: 'EMAIL_BOUNCED',
  COMPLETED: 'COMPLETED',
});

const panelPasswordResetRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true },
    userId: { type: String, default: null },
    emailHash: { type: String, required: true },
    emailMasked: { type: String, default: null },
    ipHash: { type: String, default: null },

    templateCode: { type: String, default: null },
    provider: { type: String, default: 'BREVO' },
    providerMessageId: { type: String, default: null },

    frontendUrl: { type: String, default: null },
    resetRoute: { type: String, default: null },
    tokenTtlMinutes: { type: Number, default: null },

    status: {
      type: String,
      required: true,
      enum: Object.values(PASSWORD_RESET_REQUEST_STATUS),
      default: PASSWORD_RESET_REQUEST_STATUS.REQUESTED,
    },

    requestedAt: { type: String, required: true },
    completedAt: { type: String, default: null },
    lastWebhookAt: { type: String, default: null },
    lastWebhookEvent: { type: String, default: null },
    lastWebhookReason: { type: String, default: null },

    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

panelPasswordResetRequestSchema.index({ requestedAt: -1 }, { name: 'password_reset_requested_at_desc' });
panelPasswordResetRequestSchema.index({ emailHash: 1, requestedAt: -1 }, { name: 'password_reset_email_hash' });
panelPasswordResetRequestSchema.index({ ipHash: 1, requestedAt: -1 }, { name: 'password_reset_ip_hash' });
panelPasswordResetRequestSchema.index({ providerMessageId: 1 }, { sparse: true, name: 'password_reset_provider_message' });

export const PanelPasswordResetRequest = mongoose.model(
  'PanelPasswordResetRequest',
  panelPasswordResetRequestSchema,
);
export default PanelPasswordResetRequest;
