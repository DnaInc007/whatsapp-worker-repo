import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

import { createAdminSupabase } from "@/lib/supabase/admin";

type SupabaseClient = ReturnType<typeof createAdminSupabase>;
type PersistOperation = <T>(operation: () => Promise<T>) => Promise<T>;

function serializeBufferJson(value: unknown) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function deserializeBufferJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

export class WhatsAppSessionStore {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly sessionId: string,
    private readonly persistOperation: PersistOperation = (operation) =>
      operation(),
    private readonly onKeysWritten?: (summary: {
      categories: string[];
      deletes: number;
      sessionId: string;
      upserts: number;
    }) => void,
  ) {}

  async loadCreds(): Promise<AuthenticationCreds | null> {
    const { data, error } = await this.supabase
      .from("whatsapp_session_keys")
      .select("value")
      .eq("session_id", this.sessionId)
      .eq("category", "creds")
      .eq("key_id", "default")
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data?.value
      ? deserializeBufferJson<AuthenticationCreds>(data.value)
      : null;
  }

  async saveCreds(creds: AuthenticationCreds) {
    await this.persistOperation(async () => {
      const { error } = await this.supabase
        .from("whatsapp_session_keys")
        .upsert(
          {
            category: "creds",
            key_id: "default",
            session_id: this.sessionId,
            value: serializeBufferJson(creds),
          },
          { onConflict: "session_id,category,key_id" },
        );

      if (error) {
        throw error;
      }
    });
  }

  async removeCreds() {
    await this.persistOperation(async () => {
      const { error } = await this.supabase
        .from("whatsapp_session_keys")
        .delete()
        .eq("session_id", this.sessionId)
        .eq("category", "creds")
        .eq("key_id", "default");

      if (error) {
        throw error;
      }
    });
  }

  async clearAllKeys() {
    await this.persistOperation(async () => {
      const { error } = await this.supabase
        .from("whatsapp_session_keys")
        .delete()
        .eq("session_id", this.sessionId);

      if (error) {
        throw error;
      }
    });
  }

  async readKey<T extends keyof SignalDataTypeMap>(
    category: T,
    ids: string[],
  ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
    if (ids.length === 0) {
      return {};
    }

    const { data, error } = await this.supabase
      .from("whatsapp_session_keys")
      .select("key_id, value")
      .eq("session_id", this.sessionId)
      .eq("category", category)
      .in("key_id", ids);

    if (error) {
      throw error;
    }

    const values = {} as { [id: string]: SignalDataTypeMap[T] };

    for (const row of data ?? []) {
      const parsed = deserializeBufferJson<SignalDataTypeMap[T]>(row.value);

      values[String(row.key_id)] =
        category === "app-state-sync-key"
          ? (proto.Message.AppStateSyncKeyData.fromObject(
              parsed as object,
            ) as unknown as SignalDataTypeMap[T])
          : parsed;
    }

    return values;
  }

  async writeKeys(data: Record<string, Record<string, unknown>>) {
    await this.persistOperation(async () => {
      const inserts: Array<{
        category: string;
        key_id: string;
        session_id: string;
        value: unknown;
      }> = [];
      const removals: Array<{ category: string; key_id: string }> = [];

      for (const [category, values] of Object.entries(data)) {
        for (const [keyId, value] of Object.entries(values ?? {})) {
          if (value) {
            inserts.push({
              category,
              key_id: keyId,
              session_id: this.sessionId,
              value: serializeBufferJson(value),
            });
          } else {
            removals.push({ category, key_id: keyId });
          }
        }
      }

      if (inserts.length > 0) {
        const { error } = await this.supabase
          .from("whatsapp_session_keys")
          .upsert(inserts, { onConflict: "session_id,category,key_id" });

        if (error) {
          throw error;
        }
      }

      for (const removal of removals) {
        const { error } = await this.supabase
          .from("whatsapp_session_keys")
          .delete()
          .eq("session_id", this.sessionId)
          .eq("category", removal.category)
          .eq("key_id", removal.key_id);

        if (error) {
          throw error;
        }
      }

      this.onKeysWritten?.({
        categories: Array.from(new Set(Object.keys(data))),
        deletes: removals.length,
        sessionId: this.sessionId,
        upserts: inserts.length,
      });
    });
  }

  async buildAuthState(): Promise<AuthenticationState> {
    const creds = (await this.loadCreds()) ?? initAuthCreds();

    return {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          category: T,
          ids: string[],
        ) => this.readKey(category, ids),
        set: async (data) => {
          await this.writeKeys(data as Record<string, Record<string, unknown>>);
        },
      },
    };
  }
}
