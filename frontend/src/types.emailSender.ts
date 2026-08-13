/**
 * EXPÉDITEUR E-MAIL GLOBAL — les formes rendues par le Panel (R10.4).
 *
 * Aucune de ces formes ne porte de secret, et c'est une propriété du CONTRAT,
 * pas une précaution d'affichage : le rapport de test est fait pour être collé
 * dans un ticket, et une clé qui pourrait y figurer y figurerait un jour.
 */

/** L'état d'un test. Fermé — chaque valeur répond à une question distincte. */
export type EmailSenderTestStatus =
  /** Créé, rien n'est encore parti. */
  | 'REQUESTED'
  /** Le fournisseur a pris le message. Il n'est PAS arrivé pour autant. */
  | 'ACCEPTED'
  /** Refus certain : rien n'est parti. */
  | 'REFUSED'
  /** Le fournisseur n'a rien dit : l'envoi a peut-être eu lieu. */
  | 'UNKNOWN'
  /** Un webhook a confirmé la remise. */
  | 'DELIVERED'
  /** Un webhook a dit que le message n'arriverait pas. */
  | 'BOUNCED';

export type EmailSenderWebhookStatus = 'NOT_APPLICABLE' | 'PENDING' | 'RECEIVED';

/** Une étape de la chaîne, telle que le backend l'a constatée. */
export interface EmailSenderJournalEntry {
  state: 'PASS' | 'FAIL' | 'PENDING';
  label: string;
  detail: string | null;
}

export interface EmailSenderTestReport {
  testId: string;
  status: EmailSenderTestStatus;
  environment: string;
  recipient: string;
  sender: { email: string | null; name: string | null };
  templateCode: string;
  operationId: string;
  deliveryId: string;
  provider: string;
  providerMessageId: string | null;
  requestedAt: string;
  acceptedAt: string | null;
  lastWebhookAt: string | null;
  lastWebhookEvent: string | null;
  lastWebhookReason: string | null;
  webhookStatus: EmailSenderWebhookStatus;
  errorCode: string | null;
  errorMessage: string | null;
  journal: EmailSenderJournalEntry[];
  /**
   * Le rapport en texte brut, ASSEMBLÉ PAR LE BACKEND.
   *
   * L'écran ne le recompose pas : deux versions du Panel produiraient alors
   * deux rapports différents pour le même incident, et celui qu'on lit dans un
   * ticket ne serait plus comparable à celui qu'on relit en base.
   */
  plainText: string;
}

export interface EmailSenderConfiguration {
  senderEmail: string | null;
  senderName: string | null;
  configured: boolean;
  code: string;
  problems: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface EmailSenderScreen {
  configuration: EmailSenderConfiguration;
  /** Le monde fournisseur SERVI par ce Panel. Constaté, jamais choisi. */
  environment: string;
  lastTest: EmailSenderTestReport | null;
}
