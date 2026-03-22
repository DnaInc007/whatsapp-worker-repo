export const WHATSAPP_PROVIDER = "baileys_whatsapp";
export const WHATSAPP_MEDIA_BUCKET = "communication-media";
export const WHATSAPP_INTERNAL_SECRET_HEADER = "x-whatsapp-signature";

export type WhatsAppSessionStatus =
  | "CONNECTED"
  | "CONNECTING"
  | "DISCONNECTED"
  | "ERROR"
  | "LOGGED_OUT"
  | "LOGGING_OUT"
  | "QR_READY"
  | "RECONNECTING";

export type WhatsAppCommandType =
  | "LOGOUT_SESSION"
  | "REFRESH_QR"
  | "SEND_MESSAGE"
  | "START_SESSION";

export type WhatsAppCommandStatus =
  | "CANCELED"
  | "COMPLETED"
  | "FAILED"
  | "PENDING"
  | "PROCESSING";

export type WhatsAppMessageType =
  | "audio"
  | "contact"
  | "contacts"
  | "document"
  | "image"
  | "location"
  | "poll"
  | "reaction"
  | "sticker"
  | "text"
  | "unknown"
  | "video";

export type WhatsAppSessionSummary = {
  createdAt: string;
  deviceJid: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
  phoneNumber: string | null;
  pushName: string | null;
  qrCode: string | null;
  qrExpiresAt: string | null;
  sessionId: string;
  status: WhatsAppSessionStatus;
  updatedAt: string;
};

export type WhatsAppStoredMedia = {
  contentType: string | null;
  documentId: string;
  fileName: string;
  fileSize: number | null;
  mimeType: string | null;
  storageBucket: string;
  storagePath: string;
};

export type WhatsAppMessagePayload = {
  body?: string;
  caption?: string;
  contacts?: Array<Record<string, unknown>>;
  document?: {
    fileName?: string;
    mimeType?: string;
    url?: string;
  };
  fileName?: string;
  location?: {
    address?: string;
    degreesLatitude: number;
    degreesLongitude: number;
    name?: string;
  };
  media?: {
    data?: string;
    fileName?: string;
    mimeType?: string;
    url?: string;
  };
  mentions?: string[];
  meta?: Record<string, unknown>;
  poll?: {
    name: string;
    options: string[];
    selectableCount?: number;
  };
  quotedExternalMessageId?: string | null;
  reaction?: {
    emoji: string;
    targetExternalMessageId: string;
  };
  type: WhatsAppMessageType;
};

export type WhatsAppSendRequest = {
  communicationId: string;
  message: WhatsAppMessagePayload;
  recipientPhone: string;
};

export type WhatsAppReceiptPayload = {
  deliveredAt?: string | null;
  externalMessageId: string;
  raw?: Record<string, unknown>;
  readAt?: string | null;
  status: "DELIVERED" | "FAILED" | "READ" | "SENT";
};

export type WhatsAppWebhookEvent =
  | {
      agencyId: string;
      payload: WhatsAppSessionSummary & {
        metadata?: Record<string, unknown>;
      };
      type: "session.updated";
    }
  | {
      agencyId: string;
      payload: {
        direction: "INBOUND" | "OUTBOUND";
        externalMessageId: string;
        externalThreadKey: string;
        message: WhatsAppMessagePayload;
        providerResponse?: Record<string, unknown>;
        raw: Record<string, unknown>;
        receivedAt: string;
        recipientPhone?: string | null;
        replyToExternalMessageId?: string | null;
        senderPhone?: string | null;
        status: "DELIVERED" | "FAILED" | "QUEUED" | "SENT";
        storedMedia?: WhatsAppStoredMedia[];
      };
      type: "message.upsert";
    }
  | {
      agencyId: string;
      payload: WhatsAppReceiptPayload;
      type: "message.receipt";
    };
