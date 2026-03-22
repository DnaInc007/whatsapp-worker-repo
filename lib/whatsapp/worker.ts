import makeWASocket, {
  Browsers,
  DisconnectReason,
  type AuthenticationState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { WhatsAppSessionStore } from "@/lib/whatsapp/auth-state";
import {
  normalizeIncomingMessage,
  toBaileysMessageContent,
} from "@/lib/whatsapp/message-mapper";
import {
  WHATSAPP_INTERNAL_SECRET_HEADER,
  WHATSAPP_MEDIA_BUCKET,
  type WhatsAppWebhookEvent,
} from "@/lib/whatsapp/types";

type SessionRecord = {
  agency_id: string;
  id: string;
  status: string;
};

type CommandRecord = {
  agency_id: string;
  command_type:
    | "LOGOUT_SESSION"
    | "REFRESH_QR"
    | "SEND_MESSAGE"
    | "START_SESSION";
  id: string;
  payload: Record<string, unknown>;
  session_id: string;
  status: string;
};

type ManagedSession = {
  agencyId: string;
  authState: AuthenticationState;
  pendingPersistence: Promise<void>;
  sessionId: string;
  socket: WASocket;
  store: WhatsAppSessionStore;
};

function toPhoneJid(phone: string) {
  const digits = phone.replaceAll(/[^\d]/g, "");

  return `${digits}@s.whatsapp.net`;
}

function isStatusBroadcastMessage(message: WAMessage) {
  return message.key?.remoteJid === "status@broadcast";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWebhookUrl() {
  const explicit = process.env.WHATSAPP_WEBHOOK_URL;

  if (explicit) {
    return explicit;
  }

  const appUrl =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL;

  if (!appUrl) {
    throw new Error("WHATSAPP_WEBHOOK_URL or APP_URL must be configured");
  }

  return `${appUrl.replace(/\/$/, "")}/api/pituro/webhooks/whatsapp`;
}

function deriveDisconnectStatus(error: unknown) {
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "output" in error &&
    typeof (error as { output?: { statusCode?: unknown } }).output
      ?.statusCode === "number"
      ? (error as { output: { statusCode: number } }).output.statusCode
      : null;

  if (statusCode === DisconnectReason.loggedOut) {
    return "LOGGED_OUT";
  }

  return "RECONNECTING";
}

export class WhatsAppGatewayWorker {
  private readonly logger = pino({ name: "whatsapp-worker" });
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly supabase = createAdminSupabase();
  private running = false;

  async start(pollIntervalMs = 1_000) {
    this.running = true;
    await this.bootstrapSessions();

    while (this.running) {
      try {
        await this.bootstrapSessions();
        await this.processCommands();
      } catch (error) {
        this.logger.error({ err: error }, "worker loop failed");
      }

      await sleep(pollIntervalMs);
    }
  }

  stop() {
    this.running = false;
  }

  private async bootstrapSessions() {
    const { data, error } = await this.supabase
      .from("whatsapp_sessions")
      .select("id, agency_id, status")
      .neq("status", "LOGGED_OUT")
      .neq("status", "LOGGING_OUT");

    if (error) {
      throw error;
    }

    for (const row of (data ?? []) as SessionRecord[]) {
      if (!this.sessions.has(row.id)) {
        await this.ensureSessionSocket({
          agency_id: row.agency_id,
          id: row.id,
          status: row.status,
        });
      }
    }
  }

  private async processCommands() {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("whatsapp_session_commands")
      .select("id, agency_id, session_id, command_type, payload, status")
      .eq("status", "PENDING")
      .lte("available_at", now)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) {
      throw error;
    }

    for (const command of (data ?? []) as CommandRecord[]) {
      const claimed = await this.claimCommand(command.id);

      if (!claimed) {
        continue;
      }

      try {
        await this.executeCommand(command);
      } catch (error) {
        this.logger.error(
          { commandId: command.id, err: error },
          "command failed",
        );
        await this.failCommand(
          command.id,
          error instanceof Error
            ? error.message
            : "Unknown WhatsApp command error",
        );
      }
    }
  }

  private async claimCommand(commandId: string) {
    const { data, error } = await this.supabase
      .from("whatsapp_session_commands")
      .update({
        started_at: new Date().toISOString(),
        status: "PROCESSING",
      })
      .eq("id", commandId)
      .eq("status", "PENDING")
      .select("id")
      .maybeSingle();

    if (error) {
      throw error;
    }

    return Boolean(data?.id);
  }

  private async completeCommand(
    commandId: string,
    result: Record<string, unknown> | null = null,
  ) {
    const { error } = await this.supabase
      .from("whatsapp_session_commands")
      .update({
        error: null,
        finished_at: new Date().toISOString(),
        result,
        status: "COMPLETED",
      })
      .eq("id", commandId);

    if (error) {
      throw error;
    }
  }

  private async failCommand(commandId: string, message: string) {
    const { error } = await this.supabase
      .from("whatsapp_session_commands")
      .update({
        error: message,
        finished_at: new Date().toISOString(),
        status: "FAILED",
      })
      .eq("id", commandId);

    if (error) {
      throw error;
    }
  }

  private async executeCommand(command: CommandRecord) {
    switch (command.command_type) {
      case "START_SESSION":
        await this.ensureSessionSocket({
          agency_id: command.agency_id,
          id: command.session_id,
          status: "CONNECTING",
        });
        await this.completeCommand(command.id, {
          sessionId: command.session_id,
        });

        return;
      case "REFRESH_QR":
        await this.restartSession(command.session_id, true);
        await this.completeCommand(command.id, {
          sessionId: command.session_id,
        });

        return;
      case "LOGOUT_SESSION":
        await this.logoutSession(command.session_id, command.agency_id);
        await this.completeCommand(command.id, {
          sessionId: command.session_id,
        });

        return;
      case "SEND_MESSAGE":
        await this.sendMessageCommand(command);

        return;
      default:
        throw new Error(`Unsupported command type: ${command.command_type}`);
    }
  }

  private async ensureSessionSocket(
    session: SessionRecord,
    resetAuth = false,
  ): Promise<ManagedSession> {
    const existing = this.sessions.get(session.id);

    if (existing && !resetAuth) {
      return existing;
    }

    if (existing && resetAuth) {
      this.closeManagedSession(existing);
    }

    const managed = {
      agencyId: session.agency_id,
      authState: null as unknown as AuthenticationState,
      pendingPersistence: Promise.resolve(),
      sessionId: session.id,
      socket: null as unknown as WASocket,
      store: null as unknown as WhatsAppSessionStore,
    };
    const store = new WhatsAppSessionStore(
      this.supabase,
      session.id,
      async (operation) => this.queuePersistence(managed, operation),
      (summary) => {
        this.logger.info(summary, "persisted whatsapp signal keys");
      },
    );

    if (resetAuth) {
      await store.clearAllKeys();
    }

    const auth = await store.buildAuthState();
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      auth: {
        ...auth,
        keys: makeCacheableSignalKeyStore(auth.keys, this.logger),
      },
      browser: Browsers.macOS("FDispatch"),
      logger: this.logger,
      printQRInTerminal: false,
      version,
    });

    managed.socket = socket;
    managed.authState = auth;
    managed.store = store;

    this.registerSocketEvents(managed);
    this.sessions.set(session.id, managed);

    return managed;
  }

  private queuePersistence(
    managed: ManagedSession,
    operation: () => Promise<void>,
  ): Promise<void>;
  private queuePersistence<T>(
    managed: ManagedSession,
    operation: () => Promise<T>,
  ): Promise<T>;
  private queuePersistence<T>(
    managed: ManagedSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    const nextOperation = managed.pendingPersistence
      .catch(() => undefined)
      .then(operation);

    managed.pendingPersistence = nextOperation.then(() => undefined);

    return nextOperation;
  }

  private async logPersistedAuthState(sessionId: string) {
    const { data, error } = await this.supabase
      .from("whatsapp_session_keys")
      .select("category")
      .eq("session_id", sessionId);

    if (error) {
      this.logger.warn(
        { err: error, sessionId },
        "failed to inspect auth state",
      );

      return;
    }

    const counts = new Map<string, number>();

    for (const row of data ?? []) {
      const category = String(row.category ?? "unknown");

      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    this.logger.info(
      {
        categories: Object.fromEntries(counts),
        sessionId,
        totalRows: data?.length ?? 0,
      },
      "persisted whatsapp auth state",
    );
  }

  private registerSocketEvents(managed: ManagedSession) {
    managed.socket.ev.on("creds.update", async () => {
      await managed.store.saveCreds(managed.authState.creds);
    });

    managed.socket.ev.on("connection.update", async (update) => {
      try {
        if (update.qr) {
          const qrCode = await QRCode.toDataURL(update.qr);

          await this.postWebhook({
            agencyId: managed.agencyId,
            payload: {
              createdAt: new Date().toISOString(),
              deviceJid: null,
              lastConnectedAt: null,
              lastDisconnectedAt: null,
              lastError: null,
              lastEventAt: new Date().toISOString(),
              phoneNumber: null,
              pushName: null,
              qrCode,
              qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              sessionId: managed.sessionId,
              status: "QR_READY",
              updatedAt: new Date().toISOString(),
            },
            type: "session.updated",
          });
        }

        if (update.connection === "open") {
          await this.postWebhook({
            agencyId: managed.agencyId,
            payload: {
              createdAt: new Date().toISOString(),
              deviceJid: managed.socket.user?.id ?? null,
              lastConnectedAt: new Date().toISOString(),
              lastDisconnectedAt: null,
              lastError: null,
              lastEventAt: new Date().toISOString(),
              phoneNumber: managed.socket.user?.id?.split(":")[0] ?? null,
              pushName: managed.socket.user?.name ?? null,
              qrCode: null,
              qrExpiresAt: null,
              sessionId: managed.sessionId,
              status: "CONNECTED",
              updatedAt: new Date().toISOString(),
            },
            type: "session.updated",
          });
        }

        if (update.connection === "close") {
          const status = deriveDisconnectStatus(update.lastDisconnect?.error);

          await managed.pendingPersistence.catch(() => undefined);
          await this.logPersistedAuthState(managed.sessionId);

          if (status === "LOGGED_OUT") {
            await managed.store.clearAllKeys();
          }

          await this.postWebhook({
            agencyId: managed.agencyId,
            payload: {
              createdAt: new Date().toISOString(),
              deviceJid: managed.socket.user?.id ?? null,
              lastConnectedAt: null,
              lastDisconnectedAt: new Date().toISOString(),
              lastError:
                update.lastDisconnect?.error instanceof Error
                  ? update.lastDisconnect.error.message
                  : null,
              lastEventAt: new Date().toISOString(),
              phoneNumber: managed.socket.user?.id?.split(":")[0] ?? null,
              pushName: managed.socket.user?.name ?? null,
              qrCode: null,
              qrExpiresAt: null,
              sessionId: managed.sessionId,
              status,
              updatedAt: new Date().toISOString(),
            },
            type: "session.updated",
          });

          if (status === "RECONNECTING" && this.running) {
            this.sessions.delete(managed.sessionId);
            await sleep(4_000);
            await this.ensureSessionSocket({
              agency_id: managed.agencyId,
              id: managed.sessionId,
              status: "RECONNECTING",
            });
          } else {
            this.sessions.delete(managed.sessionId);
          }
        }
      } catch (error) {
        this.logger.error({ err: error }, "connection update handling failed");
      }
    });

    managed.socket.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages as WAMessage[]) {
        try {
          if (isStatusBroadcastMessage(message)) {
            continue;
          }

          await this.forwardMessageEvent(managed, message);
        } catch (error) {
          this.logger.error({ err: error }, "message upsert handling failed");
        }
      }
    });

    managed.socket.ev.on("messages.update", async (updates) => {
      for (const update of updates as Array<Record<string, unknown>>) {
        try {
          const key = update.key as
            | { id?: unknown; remoteJid?: unknown }
            | undefined;
          const status = (update.update as { status?: unknown } | undefined)
            ?.status;

          if (key?.remoteJid === "status@broadcast") {
            continue;
          }

          if (typeof key?.id !== "string" || typeof status !== "number") {
            continue;
          }

          await this.postWebhook({
            agencyId: managed.agencyId,
            payload: {
              externalMessageId: key.id,
              raw: update,
              status: status >= 4 ? "READ" : "DELIVERED",
            },
            type: "message.receipt",
          });
        } catch (error) {
          this.logger.error({ err: error }, "message update handling failed");
        }
      }
    });
  }

  private async forwardMessageEvent(
    managed: ManagedSession,
    message: WAMessage,
    options?: {
      communicationId?: string | null;
    },
  ) {
    const storedMedia = await this.persistMessageMedia(managed, message);
    const normalized = normalizeIncomingMessage({
      rawMessage: message,
      storedMedia,
    });

    if (!normalized) {
      return;
    }

    if (typeof options?.communicationId === "string") {
      normalized.message = {
        ...normalized.message,
        meta: {
          ...(normalized.message.meta ?? {}),
          communicationId: options.communicationId,
        },
      };
      normalized.providerResponse = {
        ...(normalized.providerResponse ?? {}),
        communicationId: options.communicationId,
      };
      normalized.raw = {
        ...normalized.raw,
        communicationId: options.communicationId,
      };
    }

    await this.postWebhook({
      agencyId: managed.agencyId,
      payload: normalized,
      type: "message.upsert",
    });
  }

  private async persistMessageMedia(
    managed: ManagedSession,
    message: WAMessage,
  ) {
    if (isStatusBroadcastMessage(message)) {
      return [] as never[];
    }

    const raw = message.message ?? {};
    const mediaType = (
      [
        "imageMessage",
        "videoMessage",
        "audioMessage",
        "documentMessage",
        "stickerMessage",
      ] as const
    ).find((type) => Boolean((raw as Record<string, unknown>)[type]));

    if (!mediaType) {
      return [] as never[];
    }

    const mediaBuffer = (await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: this.logger,
        reuploadRequest: managed.socket.updateMediaMessage,
      },
    )) as Buffer | Uint8Array | null;

    if (!mediaBuffer) {
      return [] as never[];
    }

    const mediaValue = (raw as Record<string, unknown>)[mediaType] as {
      fileName?: unknown;
      mimetype?: unknown;
    };
    const fileName =
      typeof mediaValue?.fileName === "string"
        ? mediaValue.fileName
        : `${message.key?.id ?? Date.now().toString()}-${mediaType}`;
    const storagePath = `${managed.agencyId}/${
      message.key?.remoteJid ?? "unknown"
    }/${message.key?.id ?? crypto.randomUUID()}-${fileName}`;
    const contentType =
      typeof mediaValue?.mimetype === "string"
        ? mediaValue.mimetype
        : undefined;

    const uploadBuffer =
      mediaBuffer instanceof Uint8Array
        ? mediaBuffer
        : new Uint8Array(mediaBuffer);
    const { error } = await this.supabase.storage
      .from(WHATSAPP_MEDIA_BUCKET)
      .upload(storagePath, uploadBuffer, {
        contentType,
        upsert: false,
      });

    if (error) {
      throw error;
    }

    return [
      {
        contentType: contentType ?? null,
        documentId: "",
        fileName,
        fileSize: uploadBuffer.byteLength,
        mimeType: contentType ?? null,
        storageBucket: WHATSAPP_MEDIA_BUCKET,
        storagePath,
      },
    ];
  }

  private async sendMessageCommand(command: CommandRecord) {
    const managed =
      this.sessions.get(command.session_id) ??
      (await this.ensureSessionSocket({
        agency_id: command.agency_id,
        id: command.session_id,
        status: "CONNECTING",
      }));

    const recipientPhone = String(command.payload.recipientPhone ?? "").trim();

    if (!recipientPhone) {
      throw new Error("recipientPhone is required");
    }

    const communicationId =
      typeof command.payload.communicationId === "string"
        ? command.payload.communicationId
        : null;

    const content = await toBaileysMessageContent({
      message: command.payload.message as never,
    });
    const result = await managed.socket.sendMessage(
      toPhoneJid(recipientPhone),
      content as never,
    );

    await this.completeCommand(command.id, {
      messageId: result?.key?.id ?? null,
    });

    try {
      await this.forwardMessageEvent(managed, result as WAMessage, {
        communicationId,
      });
    } catch (error) {
      this.logger.warn(
        { commandId: command.id, err: error },
        "message send succeeded but webhook sync failed",
      );
    }
  }

  private async restartSession(sessionId: string, resetAuth: boolean) {
    const existing = this.sessions.get(sessionId);

    if (existing) {
      if (resetAuth) {
        await existing.store.clearAllKeys();
      }

      this.closeManagedSession(existing);
      this.sessions.delete(sessionId);
    }

    const { data, error } = await this.supabase
      .from("whatsapp_sessions")
      .select("id, agency_id, status")
      .eq("id", sessionId)
      .single();

    if (error || !data) {
      throw error ?? new Error("WhatsApp session not found");
    }

    await this.ensureSessionSocket(data as SessionRecord, resetAuth);
  }

  private async logoutSession(sessionId: string, agencyId: string) {
    const existing = this.sessions.get(sessionId);

    if (existing) {
      try {
        await existing.socket.logout();
      } catch (error) {
        this.logger.warn({ err: error }, "socket logout raised");
      }

      await existing.store.clearAllKeys();
      this.closeManagedSession(existing);
      this.sessions.delete(sessionId);
    } else {
      const store = new WhatsAppSessionStore(this.supabase, sessionId);

      await store.clearAllKeys();
    }

    await this.postWebhook({
      agencyId,
      payload: {
        createdAt: new Date().toISOString(),
        deviceJid: null,
        lastConnectedAt: null,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: null,
        lastEventAt: new Date().toISOString(),
        phoneNumber: null,
        pushName: null,
        qrCode: null,
        qrExpiresAt: null,
        sessionId,
        status: "LOGGED_OUT",
        updatedAt: new Date().toISOString(),
      },
      type: "session.updated",
    });
  }

  private closeManagedSession(managed: ManagedSession) {
    const candidate = managed.socket as WASocket & {
      end?: (error?: Error) => void;
      ws?: { close?: () => void };
    };

    if (typeof candidate.end === "function") {
      candidate.end(new Error("FDispatch worker session restart"));

      return;
    }

    candidate.ws?.close?.();
  }

  private async postWebhook(event: WhatsAppWebhookEvent) {
    const secret = process.env.WHATSAPP_INTERNAL_WEBHOOK_SECRET;

    if (!secret) {
      throw new Error("WHATSAPP_INTERNAL_WEBHOOK_SECRET is not configured");
    }

    const response = await fetch(resolveWebhookUrl(), {
      body: JSON.stringify(event),
      headers: {
        "Content-Type": "application/json",
        [WHATSAPP_INTERNAL_SECRET_HEADER]: secret,
      },
      method: "POST",
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new Error(
        `Webhook failed with status ${response.status}${
          body ? `: ${body}` : ""
        }`,
      );
    }
  }
}
