// IndexedDB schema (plan §3.6 + §4.9). Tablas en singular (convención cross-stack).
//
// Políticas:
//   * TTL: 72h desde `last_accessed_at_ms`. Ignora sessions con `pinned=true`.
//   * LRU: al superar 85% de quota, eliminamos primero TTL-expired; si sigue >80%,
//     borramos sessions menos recientes hasta caer a 60%.
//   * Chunks cascade: al borrar una session, sus chunks caen con ella (transacción atómica).
//   * Concurrencia multi-tab: `navigator.locks.request("dovi_write", ...)` serializa writes
//     globales (plan §4.9). Evita quota races y transacciones solapadas.
//
// Eviction se dispara:
//   - Periódicamente por `chrome.alarms` (cada `eviction_check_interval_seconds`).
//   - Bajo demanda antes de un upsert grande (caller invoca `evict_if_needed()`).

import Dexie, { type Table } from "dexie";
import { config } from "@/shared/config";
import type { source_level } from "@/shared/types";

// ---------- schema ----------

export interface session_row {
  session_id: string;
  video_id: string;
  platform: string;
  total_bytes: number;
  created_at_ms: number;
  last_accessed_at_ms: number;
  pinned: boolean; // si true, ignora eviction.
}

export interface chunk_row {
  chunk_id: string;
  session_id: string;
  t_start_ms: number;
  t_end_ms: number;
  speaker: string | null;
  text: string;
  source_level: source_level;
  embedding: Float32Array | null; // null cuando RAG vive en backend.
  embedding_model: string;
  schema_version: number;
  last_accessed_at_ms: number;
}

export class dovi_db extends Dexie {
  session!: Table<session_row, string>;
  chunk!: Table<chunk_row, string>;

  constructor() {
    super("dovi");
    this.version(1).stores({
      session: "session_id, last_accessed_at_ms, total_bytes, pinned",
      chunk:
        "chunk_id, session_id, [session_id+t_start_ms], last_accessed_at_ms, embedding_model",
    });
  }
}

export const db = new dovi_db();

// ---------- helpers de quota ----------

interface quota_snapshot {
  usage: number;
  quota: number;
  ratio: number;
}

async function read_quota(): Promise<quota_snapshot> {
  if (!("storage" in navigator) || !navigator.storage.estimate) {
    // Sin StorageManager API no podemos decidir eviction con precisión. Retornamos
    // valores neutros → las rutas de TTL siguen funcionando; la rama LRU se salta.
    return { usage: 0, quota: Number.POSITIVE_INFINITY, ratio: 0 };
  }
  const est = await navigator.storage.estimate();
  const usage = est.usage ?? 0;
  const quota = est.quota ?? Number.POSITIVE_INFINITY;
  const ratio = quota > 0 ? usage / quota : 0;
  return { usage, quota, ratio };
}

// ---------- touch / upsert ----------

export async function touch_session(session_id: string): Promise<void> {
  await db.session.update(session_id, { last_accessed_at_ms: Date.now() });
}

export async function touch_chunks(chunk_ids: string[]): Promise<void> {
  if (chunk_ids.length === 0) return;
  const now = Date.now();
  await db.transaction("rw", db.chunk, async () => {
    for (const id of chunk_ids) {
      await db.chunk.update(id, { last_accessed_at_ms: now });
    }
  });
}

export async function upsert_session(row: session_row): Promise<void> {
  await db.session.put(row);
}

export async function upsert_chunks(rows: chunk_row[]): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction("rw", db.chunk, async () => {
    await db.chunk.bulkPut(rows);
  });
}

// ---------- eviction policy ----------

async function delete_session_cascade(session_id: string): Promise<void> {
  await db.transaction("rw", db.session, db.chunk, async () => {
    await db.chunk.where("session_id").equals(session_id).delete();
    await db.session.delete(session_id);
  });
}

async function evict_ttl_expired(): Promise<number> {
  const cutoff = Date.now() - config.eviction_ttl_hours * 3600 * 1000;
  const expired = await db.session
    .where("last_accessed_at_ms")
    .below(cutoff)
    .and((s) => !s.pinned)
    .toArray();
  for (const s of expired) {
    await delete_session_cascade(s.session_id);
  }
  return expired.length;
}

async function evict_lru_until(target_ratio: number, snap: quota_snapshot): Promise<number> {
  if (!Number.isFinite(snap.quota) || snap.quota <= 0) return 0;
  let evicted = 0;
  // Iteramos del menos reciente al más reciente, saltándonos pinned.
  const candidates = await db.session
    .orderBy("last_accessed_at_ms")
    .filter((s) => !s.pinned)
    .toArray();

  for (const s of candidates) {
    const fresh = await read_quota();
    if (fresh.ratio <= target_ratio) break;
    await delete_session_cascade(s.session_id);
    evicted++;
  }
  return evicted;
}

export async function apply_eviction_policy(): Promise<{
  ttl_evicted: number;
  lru_evicted: number;
  quota_ratio_after: number;
}> {
  // Serialización cross-tab (plan §4.9).
  const run = async (): Promise<{
    ttl_evicted: number;
    lru_evicted: number;
    quota_ratio_after: number;
  }> => {
    const pre = await read_quota();
    const should_check_quota = pre.ratio > config.eviction_quota_trigger;

    // TTL: siempre corremos la pasada, aún bajo presión de cuota baja.
    const ttl_evicted = await evict_ttl_expired();

    let lru_evicted = 0;
    if (should_check_quota) {
      const mid = await read_quota();
      if (mid.ratio > config.eviction_quota_trigger - 0.05) {
        // Ej. trigger=0.85 → seguimos eviction si >0.80.
        lru_evicted = await evict_lru_until(config.eviction_quota_target, mid);
      }
    }

    const post = await read_quota();
    return { ttl_evicted, lru_evicted, quota_ratio_after: post.ratio };
  };

  if ("locks" in navigator && navigator.locks) {
    return (await navigator.locks.request("dovi_write", run)) as {
      ttl_evicted: number;
      lru_evicted: number;
      quota_ratio_after: number;
    };
  }
  return run();
}

// Entry point para `chrome.alarms` handler en el SW.
export async function evict_if_needed(): Promise<void> {
  try {
    const result = await apply_eviction_policy();
    console.info("[DOVI] eviction run", result);
  } catch (err) {
    console.error("[DOVI] eviction failed", err);
  }
}

// ---------- API utilitaria para debug / UI ----------

export async function list_sessions(): Promise<session_row[]> {
  return db.session.orderBy("last_accessed_at_ms").reverse().toArray();
}

export async function pin_session(session_id: string, pinned: boolean): Promise<void> {
  await db.session.update(session_id, { pinned });
}

export async function clear_all(): Promise<void> {
  await db.transaction("rw", db.session, db.chunk, async () => {
    await db.chunk.clear();
    await db.session.clear();
  });
}
