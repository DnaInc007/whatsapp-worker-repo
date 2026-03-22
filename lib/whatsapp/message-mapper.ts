import type {
  WhatsAppMessagePayload,
  WhatsAppStoredMedia,
  WhatsAppWebhookEvent,
} from "@/lib/whatsapp/types";

import { BufferJSON, type WAMessage } from "@whiskeysockets/baileys";

function toPlainJson<T>(value: T) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as T;
}

function extractRemotePhone(jid: string | null | undefined) {
  if (!jid) {
    return null;
  }

  return jid.split("@")[0] ?? null;
}

function readTextMessage(message: Record<string, unknown>) {
  if (typeof message.conversation === "string") {
    return {
      body: message.conversation,
      type: "text" as const,
    };
  }

  const extended = message.extendedTextMessage as
    | { text?: unknown; contextInfo?: unknown }
    | undefined;

  if (extended && typeof extended.text === "string") {
    return {
      body: extended.text,
      meta:
        typeof extended.contextInfo === "object" &&
        extended.contextInfo !== null
          ? { contextInfo: toPlainJson(extended.contextInfo) }
          : undefined,
      type: "text" as const,
    };
  }

  return null;
}

function readMediaMessage(
  type: "audio" | "document" | "image" | "sticker" | "video",
  value: unknown,
) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const media = value as {
    caption?: unknown;
    fileName?: unknown;
    mimetype?: unknown;
  };

  return {
    caption: typeof media.caption === "string" ? media.caption : undefined,
    fileName: typeof media.fileName === "string" ? media.fileName : undefined,
    media: {
      fileName: typeof media.fileName === "string" ? media.fileName : undefined,
      mimeType: typeof media.mimetype === "string" ? media.mimetype : undefined,
    },
    type,
  } satisfies WhatsAppMessagePayload;
}

function readContactsMessage(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const contactsValue = value as { contacts?: unknown[] };

  if (Array.isArray(contactsValue.contacts)) {
    return {
      contacts: contactsValue.contacts.map((entry) =>
        typeof entry === "object" && entry !== null
          ? (toPlainJson(entry) as Record<string, unknown>)
          : {},
      ),
      type: "contacts" as const,
    };
  }

  return {
    contacts: [toPlainJson(value) as Record<string, unknown>],
    type: "contact" as const,
  };
}

function readLocationMessage(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const location = value as {
    address?: unknown;
    degreesLatitude?: unknown;
    degreesLongitude?: unknown;
    name?: unknown;
  };

  if (
    typeof location.degreesLatitude !== "number" ||
    typeof location.degreesLongitude !== "number"
  ) {
    return null;
  }

  return {
    location: {
      address:
        typeof location.address === "string" ? location.address : undefined,
      degreesLatitude: location.degreesLatitude,
      degreesLongitude: location.degreesLongitude,
      name: typeof location.name === "string" ? location.name : undefined,
    },
    type: "location" as const,
  };
}

function readPollMessage(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const poll = value as {
    name?: unknown;
    options?: Array<{ optionName?: unknown }>;
    selectableOptionsCount?: unknown;
  };

  if (typeof poll.name !== "string") {
    return null;
  }

  return {
    poll: {
      name: poll.name,
      options: Array.isArray(poll.options)
        ? poll.options
            .map((option) =>
              typeof option?.optionName === "string" ? option.optionName : null,
            )
            .filter((option): option is string => Boolean(option))
        : [],
      selectableCount:
        typeof poll.selectableOptionsCount === "number"
          ? poll.selectableOptionsCount
          : undefined,
    },
    type: "poll" as const,
  };
}

function readReactionMessage(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const reaction = value as {
    key?: { id?: unknown };
    text?: unknown;
  };

  if (
    typeof reaction.text !== "string" ||
    typeof reaction.key?.id !== "string"
  ) {
    return null;
  }

  return {
    reaction: {
      emoji: reaction.text,
      targetExternalMessageId: reaction.key.id,
    },
    type: "reaction" as const,
  };
}

export function normalizeIncomingMessage(input: {
  rawMessage: WAMessage;
  receivedAt?: string;
  storedMedia?: WhatsAppStoredMedia[];
}):
  | Extract<WhatsAppWebhookEvent, { type: "message.upsert" }>["payload"]
  | null {
  const raw = toPlainJson(input.rawMessage) as unknown as {
    key?: {
      fromMe?: boolean;
      id?: string;
      participant?: string;
      remoteJid?: string;
    };
    message?: Record<string, unknown>;
    messageTimestamp?: number | string | null;
    pushName?: string;
  };

  const key = raw.key;
  const remoteJid = key?.remoteJid ?? null;
  const externalMessageId = key?.id ?? null;

  if (!remoteJid || !externalMessageId) {
    return null;
  }

  if (remoteJid === "status@broadcast") {
    return null;
  }

  const message = raw.message ?? {};
  const payload =
    readTextMessage(message) ??
    readMediaMessage("image", message.imageMessage) ??
    readMediaMessage("video", message.videoMessage) ??
    readMediaMessage("audio", message.audioMessage) ??
    readMediaMessage("document", message.documentMessage) ??
    readMediaMessage("sticker", message.stickerMessage) ??
    readLocationMessage(message.locationMessage) ??
    readContactsMessage(
      message.contactMessage ?? message.contactsArrayMessage,
    ) ??
    readPollMessage(message.pollCreationMessage) ??
    readReactionMessage(message.reactionMessage) ??
    ({ type: "unknown" } satisfies WhatsAppMessagePayload);
  const payloadMeta = "meta" in payload ? payload.meta : undefined;

  const timestampSource =
    input.receivedAt ??
    (typeof raw.messageTimestamp === "number"
      ? new Date(raw.messageTimestamp * 1000).toISOString()
      : typeof raw.messageTimestamp === "string"
        ? new Date(Number(raw.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString());

  return {
    direction: key?.fromMe ? "OUTBOUND" : "INBOUND",
    externalMessageId,
    externalThreadKey: remoteJid,
    message: {
      ...payload,
      meta: {
        ...(payloadMeta ?? {}),
        pushName: raw.pushName ?? null,
        rawMessageKey: key ? toPlainJson(key) : null,
      },
    },
    providerResponse: {
      rawMessageKey: key ? toPlainJson(key) : null,
    },
    raw: toPlainJson(input.rawMessage) as unknown as Record<string, unknown>,
    receivedAt: timestampSource,
    recipientPhone: key?.fromMe ? extractRemotePhone(remoteJid) : null,
    replyToExternalMessageId:
      typeof (
        message.extendedTextMessage as { contextInfo?: { stanzaId?: unknown } }
      )?.contextInfo?.stanzaId === "string"
        ? ((
            message.extendedTextMessage as {
              contextInfo?: { stanzaId?: string };
            }
          ).contextInfo?.stanzaId ?? null)
        : typeof (message.reactionMessage as { key?: { id?: unknown } })?.key
              ?.id === "string"
          ? ((message.reactionMessage as { key?: { id?: string } }).key?.id ??
            null)
          : null,
    senderPhone: !key?.fromMe
      ? extractRemotePhone(key?.participant ?? remoteJid)
      : null,
    status: key?.fromMe ? "SENT" : "DELIVERED",
    storedMedia: input.storedMedia ?? [],
  };
}

export async function toBaileysMessageContent(input: {
  message: WhatsAppMessagePayload;
}) {
  const { message } = input;

  switch (message.type) {
    case "text":
      return {
        text: message.body ?? "",
      };
    case "image":
      return {
        caption: message.caption,
        image: await resolveMediaSource(message),
      };
    case "video":
      return {
        caption: message.caption,
        video: await resolveMediaSource(message),
      };
    case "audio":
      return {
        audio: await resolveMediaSource(message),
        mimetype: message.media?.mimeType ?? "audio/ogg",
        ptt: false,
      };
    case "document":
      return {
        document: await resolveMediaSource(message),
        fileName: message.fileName ?? message.media?.fileName ?? "document",
        mimetype: message.document?.mimeType ?? message.media?.mimeType,
      };
    case "sticker":
      return {
        sticker: await resolveMediaSource(message),
      };
    case "location":
      return {
        degreesLatitude: message.location?.degreesLatitude ?? 0,
        degreesLongitude: message.location?.degreesLongitude ?? 0,
        name: message.location?.name,
        address: message.location?.address,
      };
    case "contact":
    case "contacts":
      return {
        contacts: {
          contacts: (message.contacts ?? []).map((contact) =>
            toPlainJson(contact),
          ),
        },
      };
    case "poll":
      return {
        poll: {
          name: message.poll?.name ?? "Poll",
          selectableCount: message.poll?.selectableCount ?? 1,
          values: message.poll?.options ?? [],
        },
      };
    case "reaction":
      return {
        react: {
          key: {
            id: message.reaction?.targetExternalMessageId ?? "",
          },
          text: message.reaction?.emoji ?? "",
        },
      };
    default:
      return {
        text: message.body ?? message.caption ?? "",
      };
  }
}

async function resolveMediaSource(message: WhatsAppMessagePayload) {
  if (message.media?.url) {
    return {
      url: message.media.url,
    };
  }

  if (message.document?.url) {
    return {
      url: message.document.url,
    };
  }

  if (message.media?.data) {
    return Buffer.from(message.media.data, "base64");
  }

  return Buffer.alloc(0);
}
