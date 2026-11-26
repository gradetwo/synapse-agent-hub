// ProjectRoom：每项目一个 Durable Object。
// 单线程 ⇒ seq 单调递增、任务认领免锁 CAS、心跳覆盖写。
import { Env, Msg, Task, ClientEvent, IDLE_AFTER_DEFAULT_S, IDLE_DEFAULT_MESSAGE, IDLE_FOLLOWUP_DEFAULT_S, IDLE_ONLINE_MS } from "./types";

const LATEST_KEEP = 2000; // 热窗口：最近 2000 条；更早的查 D1（归档任务）
const DEFAULT_TASK_LEASE_MS = 12 * 60 * 60_000; // 任务 claim 默认租约 12h；心跳会续，LEASE_TTL_S 可调
export const ACTIVE_TASK_LIMIT = 5;              // 普通 agent 自领公共任务/Issue 时，名下已 claim 未完成任务上限
const DEFAULT_SURFACE_PARALLEL = 1;              // window/tmux 一次只能跑一个任务
const DEFAULT_HEADLESS_PARALLEL = 2;             // 无窗口/无 tmux 的循环默认允许两件在途任务
const MAX_PARALLEL_TASKS = 8;
const DEFAULT_TASK_PRIORITY = 2;                // P0..P3，P2 为默认
const MAX_TASK_PRIORITY = 3;
const PRIORITY_AGING_MS = 30 * 60_000;          // 排队 30 分钟提升一级，防止低优先级饿死
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 10;
const RETRY_BASE_MS = 15_000;                    // 15s 起指数退避，封顶 5 分钟
const RETRY_MAX_MS = 5 * 60_000;
const QUEUE_STALE_MS = 2 * 60 * 60_000;          // 排队超过 2h 进入管理告警
const QUEUE_OFFLINE_STALE_MS = 60 * 60_000;      // 目标离线超过 1h 也进入告警

function clampPriority(v: unknown): number {
  if (v === undefined || v === null || String(v).trim() === "") return DEFAULT_TASK_PRIORITY;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TASK_PRIORITY;
  return Math.max(0, Math.min(MAX_TASK_PRIORITY, Math.floor(n)));
}

function parseDeadlineAt(v: unknown): number | null {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? v : null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/** 外部管理端 webhook。配置只存在 DO，secret 不回传管理端。 */
type WebhookConfig = {
  enabled?: boolean;
  url?: string;
  secret?: string;
  topics?: string[];
  updated_at?: number;
};
const WEBHOOK_TOPICS = new Set(["submission", "task", "issue", "ci", "alert", "announce", "admin", "system", "all"]);

function hexBytes(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}


function safeJson(x: any) { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return {}; } }

/** 启动参数快照：客户端自报，管理端只读；服务端再做一次白名单/长度/密钥清洗。 */
const LAUNCH_ARG_LIMIT = 64;
const LAUNCH_ARG_CHARS = 512;
const LAUNCH_VALUE_CHARS = 1200;
const LAUNCH_EFFECTIVE_KEYS = [
  "cmd", "role", "agent_id", "project", "heartbeat_s", "config_dir",
  "exec", "event_cmd", "notify_cmd", "proxy",
  "window_forward", "window_app", "window_conversation",
  "tmux_forward", "tmux_target", "tmux_verify",
  "auto_forward", "debug",
];
const LAUNCH_SOURCE_KEYS = [...LAUNCH_EFFECTIVE_KEYS, "auto_forward", "debug"];
const LAUNCH_SECRET_FLAGS = new Set([
  "--token", "--admin-token", "--api-key", "--secret", "--password", "--proxy",
]);

function launchText(v: any, max = LAUNCH_VALUE_CHARS): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function launchEnum(v: any, allowed: string[]): string | null {
  const s = launchText(v, 24);
  return s && allowed.includes(s) ? s : null;
}

function launchStringList(v: any, limit: number, max = 400): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v.slice(0, limit)) {
    const s = launchText(item, max);
    if (s) out.push(s);
  }
  return out;
}

function normalizeSources(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of LAUNCH_SOURCE_KEYS) {
    if (!(k in raw)) continue;
    const v = launchEnum(raw[k], ["cli", "env", "config", "default", "remote", "opts", "sdk"]);
    if (v) out[k] = v;
  }
  return out;
}

function normalizeControl(raw: any): any | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    rev: launchNumber(raw.rev) ?? 0,
    auto_forward: launchEnum(raw.auto_forward, ["inherit", "on", "off"]) ?? "inherit",
    debug: launchBool(raw.debug) === true,
    heartbeat_s: launchNumber(raw.heartbeat_s),
    applied_at: launchNumber(raw.applied_at),
  };
}

/** 远程控制只允许安全、可回滚的参数；执行命令/代理/凭据永不下发。 */
function normalizeRemoteControl(raw: any): any | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    rev: launchNumber(raw.rev) ?? 0,
    auto_forward: launchEnum(raw.auto_forward, ["inherit", "on", "off"]) ?? "inherit",
    debug: launchBool(raw.debug) === true,
    heartbeat_s: launchNumber(raw.heartbeat_s),
    updated_at: launchNumber(raw.updated_at) ?? 0,
    updated_by: launchText(raw.updated_by, 80) ?? "admin",
  };
}

function normalizeDeliveryHealth(raw: any, now: number): any | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const failures = launchNumber(raw.consecutive_failures) ?? 0;
  const lastOk = launchNumber(raw.last_ok_ms);
  const lastAttempt = launchNumber(raw.last_attempt_ms);
  return {
    last_attempt_ms: lastAttempt,
    last_ok_ms: lastOk,
    last_error: launchText(raw.last_error, 500),
    consecutive_failures: Math.min(9999, failures),
    received_at: now,
    status: failures > 0 ? "failing" : (lastOk ? "ok" : "unknown"),
  };
}

function normalizeDebug(raw: any, now: number): any | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const logs: any[] = [];
  if (Array.isArray(raw.logs)) {
    for (const item of raw.logs.slice(-80)) {
      if (typeof item === "string") {
        const msg = launchText(item, 600);
        if (msg) logs.push({ ts: now, level: "debug", msg });
      } else if (item && typeof item === "object") {
        const msg = launchText(item.msg, 600);
        if (msg) logs.push({
          ts: launchNumber(item.ts) ?? now,
          level: launchEnum(item.level, ["debug", "info", "warn", "error"]) ?? "debug",
          msg,
        });
      }
    }
  }
  return { enabled: launchBool(raw.enabled) === true, logs, received_at: now };
}

function normalizeErrors(raw: any, now: number): any[] {
  if (!Array.isArray(raw)) return [];
  const out: any[] = [];
  for (const item of raw.slice(-30)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = launchText(item.message, 500);
    if (!message) continue;
    out.push({
      id: launchText(item.id, 120) ?? `srv-${now}-${out.length}`,
      ts: launchNumber(item.ts) ?? now,
      kind: launchEnum(item.kind, ["exception", "heartbeat", "delivery", "ws", "control", "panic", "other"]) ?? "other",
      message,
      detail: launchText(item.detail, 1200),
      count: Math.max(1, Math.min(9999, launchNumber(item.count) ?? 1)),
    });
  }
  return out;
}

function mergeClientErrors(prev: any, incoming: any[], now: number): any[] {
  const rows: any[] = Array.isArray(prev) ? prev.slice(-30) : [];
  for (const e of incoming) {
    const i = rows.findIndex((x) => String(x.id) === String(e.id));
    if (i >= 0) {
      rows[i] = { ...rows[i], ...e, count: Math.max(Number(rows[i].count ?? 1), Number(e.count ?? 1)),
                  ts: Math.min(Number(rows[i].ts ?? now), Number(e.ts ?? now)) };
    } else {
      rows.push(e);
    }
  }
  return rows.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0)).slice(0, 30);
}

function launchBool(v: any): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "on") return true;
  if (v === 0 || v === "0" || v === "false" || v === "off") return false;
  return null;
}

function launchNumber(v: any): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function launchArgv(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  let hideNext = false;
  for (const item of raw.slice(0, LAUNCH_ARG_LIMIT)) {
    const s = launchText(item, LAUNCH_ARG_CHARS);
    if (!s) continue;
    if (hideNext) { out.push("***"); hideNext = false; continue; }
    const lower = s.toLowerCase();
    if (LAUNCH_SECRET_FLAGS.has(lower)) {
      out.push(s);
      hideNext = true;
    } else if (lower.startsWith("--token=") || lower.startsWith("--admin-token=")
      || lower.startsWith("--api-key=") || lower.startsWith("--secret=")
      || lower.startsWith("--password=") || lower.startsWith("--proxy=")) {
      out.push(s.split("=")[0] + "=***");
    } else {
      out.push(s);
    }
  }
  return out;
}

/** 让旧客户端或恶意客户端都不能把任意大对象塞进 DO。 */
function normalizeLaunch(raw: any, now: number, fallbackVersion: string): any | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const effective: Record<string, string | number | boolean | null> = {};
  if (raw.effective && typeof raw.effective === "object" && !Array.isArray(raw.effective)) {
    for (const k of LAUNCH_EFFECTIVE_KEYS) {
      if (!(k in raw.effective)) continue;
      const v = raw.effective[k];
      if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) effective[k] = v;
      else effective[k] = launchText(v);
    }
  }
  const deliveryRaw = raw.delivery && typeof raw.delivery === "object" && !Array.isArray(raw.delivery)
    ? raw.delivery : {};
  const windowForward = launchBool(deliveryRaw.window_forward) ?? launchBool(effective.window_forward);
  const tmuxForward = launchBool(deliveryRaw.tmux_forward) ?? launchBool(effective.tmux_forward);
  const auto = launchBool(deliveryRaw.auto) ?? launchBool(raw.auto_delivery)
    ?? (windowForward === true || tmuxForward === true);
  const kindCandidate = launchText(deliveryRaw.kind, 24) ?? launchText(raw.surface?.kind, 24);
  const kindRaw = kindCandidate && kindCandidate !== "none"
    ? kindCandidate
    : (windowForward === true ? "window" : tmuxForward === true ? "tmux" : "none");
  const target = launchText(deliveryRaw.target, 200)
    ?? (windowForward === true ? launchText(effective.window_app, 200)
      : tmuxForward === true ? launchText(effective.tmux_target, 200) : null);
  return {
    schema: launchText(raw.schema, 40) ?? "synapse.launch.v1",
    kind: launchText(raw.kind, 24) ?? "unknown",
    version: launchText(raw.version, 40) ?? fallbackVersion,
    started_at: launchNumber(raw.started_at),
    received_at: now,
    pid: launchNumber(raw.pid),
    cwd: launchText(raw.cwd, 500),
    config_dir: launchText(raw.config_dir, 500),
    platform: launchText(raw.platform, 32),
    arch: launchText(raw.arch, 32),
    argv: launchArgv(raw.argv),
    sources: normalizeSources(raw.sources),
    control: normalizeControl(raw.control),
    effective,
    delivery: {
      auto: auto === true,
      kind: auto === true ? kindRaw : "none",
      target: auto === true ? target : null,
      window_forward: windowForward === true,
      tmux_forward: tmuxForward === true,
      tmux_verify: launchBool(deliveryRaw.tmux_verify) ?? launchBool(effective.tmux_verify ?? true),
    },
  };
}


/** 取 SDK 版本的核心数字段；无法解析时返回 null（按旧客户端处理）。 */
function sdkVersionCore(v: unknown): number[] | null {
  const raw = String(v ?? "").trim().replace(/^v/i, "").split(/[+-]/)[0];
  if (!/^\d+(?:\.\d+)*$/.test(raw)) return null;
  const parts = raw.split(".").map((x) => Number(x));
  while (parts.length < 3) parts.push(0);
  return parts;
}

/** 客户端版本是否落后于服务端 SDK_VERSION。 */
function isSdkOutdated(client: unknown, latest: unknown): boolean {
  const c = sdkVersionCore(client);
  const l = sdkVersionCore(latest);
  if (!l) return false;
  if (!c) return true;
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const a = c[i] ?? 0, b = l[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

const msgKey = (n: number) => `msg:${String(n).padStart(10, "0")}`;

class DoError extends Error {
  constructor(public status: number, public code: string, public detail: any = {}) {
    super(code);
  }
}

/** 错误详情只透传已知数值字段，绝不把异常对象/消息/堆栈带进响应。 */
function publicErrorDetail(detail: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!detail || typeof detail !== "object") return out;
  for (const key of ["size", "cap", "minute_count"]) {
    const value = (detail as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export class ProjectRoom implements DurableObject {
  private st: DurableObjectStorage;
  // DO 单线程不等于请求不会在 await 处交错：同一 agent 的“读在途计数→发下一条”
  // 必须串行，否则两个 createTask 同时看到 0 在途，会把两条任务一起灌进同一个窗口。
  private dispatchGate: Promise<unknown> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Env) {
    this.st = state.storage;
  }

  private serializeDispatch<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.dispatchGate;
    let release!: () => void;
    this.dispatchGate = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(fn).finally(release);
  }

  /** claim 租约：优先读 LEASE_TTL_S（秒），缺省/非法时 12 小时。 */
  private taskLeaseMs(): number {
    const sec = Number(this.env.LEASE_TTL_S);
    // 120 是旧部署未生效的遗留值；别让它把默认 12h 降回 2 分钟。
    if (sec === 120) return DEFAULT_TASK_LEASE_MS;
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : DEFAULT_TASK_LEASE_MS;
  }

  /** 定向任务并发上限：管理端显式配置优先；其次按心跳上报的 surface 类型取默认。
   *  未知类型按 surface=1 处理，宁可排队也不能把多条任务灌进旧窗口客户端。 */
  private async agentMaxParallel(agentId: string): Promise<number> {
    const rec: any = await this.st.get(`agent:${agentId}`).catch(() => null);
    const configured = Number(rec?.max_parallel_tasks ?? 0);
    if (Number.isFinite(configured) && configured >= 1) return Math.min(MAX_PARALLEL_TASKS, Math.floor(configured));
    const kind = String(rec?.surface?.kind ?? "").toLowerCase();
    if (kind === "window" || kind === "tmux") return DEFAULT_SURFACE_PARALLEL;
    if (kind === "none") return DEFAULT_HEADLESS_PARALLEL;
    return DEFAULT_SURFACE_PARALLEL;
  }

  private dispatchStateOf(t: any): string {
    if (t?.dispatch_state) return String(t.dispatch_state);
    // 旧任务没有 dispatch_state：已 claim 的定向任务视为在途；open 定向任务可能已经
    // 由旧版本直接下发过，也按在途处理，避免升级后瞬间再灌一条。
    if (t?.to && t?.state === "claimed") return "active";
    if (t?.to && t?.state === "open") return "notified";
    return "closed";
  }

  private isTerminalDispatch(t: any): boolean {
    return ["done", "released", "blocked", "failed"].includes(String(t?.state ?? ""));
  }

  /** 基础优先级 + 排队老化 + 截止时间加成。数值越小越优先。 */
  private effectivePriority(t: any, now = Date.now()): number {
    let p = clampPriority(t?.priority);
    const created = Number(t?.created_at ?? now);
    const waited = Math.max(0, now - created);
    p = Math.max(0, p - Math.floor(waited / PRIORITY_AGING_MS));
    const deadline = Number(t?.deadline_at ?? 0);
    if (deadline && deadline <= now) p = 0;
    else if (deadline && deadline - now <= 10 * 60_000) p = Math.min(p, 1);
    return p;
  }

  /** 队列统一排序：有效优先级 → 最近截止 → 最早创建。 */
  private compareQueue(a: any, b: any, now = Date.now()): number {
    const pa = this.effectivePriority(a, now);
    const pb = this.effectivePriority(b, now);
    if (pa !== pb) return pa - pb;
    const da = Number(a?.deadline_at ?? Infinity);
    const db = Number(b?.deadline_at ?? Infinity);
    if (da !== db) return da - db;
    return Number(a?.created_at ?? 0) - Number(b?.created_at ?? 0);
  }

  /** 重试时间未到的任务仍处于 queued，但不能被 promoteQueue 提前下发。 */
  private retryReady(t: any, now = Date.now()): boolean {
    return !t?.next_retry_at || Number(t.next_retry_at) <= now;
  }

  /** 当前占用并发槽的定向任务数。notified（已发消息）和 active（已 claim）都算；
   *  done/released/blocked 释放槽位。 */
  private async directedInFlight(agentId: string): Promise<number> {
    if (!agentId) return 0;
    const tasks = await this.listRawTasks();
    return tasks.filter((t: any) => t.to === agentId && !this.isTerminalDispatch(t)
      && ["notified", "active"].includes(this.dispatchStateOf(t))).length;
  }

  private async queuePosition(agentId: string, taskId: string): Promise<number> {
    if (!agentId) return 0;
    const now = Date.now();
    const queued = (await this.listRawTasks())
      .filter((t: any) => t.to === agentId && t.state === "open" && this.dispatchStateOf(t) === "queued"
        && this.retryReady(t, now))
      .sort((a: any, b: any) => this.compareQueue(a, b, now));
    const idx = queued.findIndex((t: any) => String(t.task_id ?? t.id ?? "") === taskId);
    return idx >= 0 ? idx + 1 : 0;
  }

  private async listRawTasks(): Promise<any[]> {
    const m = await this.st.list({ prefix: "task:" });
    return [...m.values()].map((v: any) => v).filter(Boolean);
  }

  /** 把任务写入派发状态并发一条任务消息；没有槽位时只入队，不发消息。
   *  这是“服务端单飞”的核心：窗口客户端不需要自己猜 TUI 是否在忙。
   *  dispatchGate 保证“查在途→发任务”是原子的，避免并发创建时两条同时下发。 */
  private dispatchTaskOrQueue(project: string, t: any, extra: any = {}): Promise<any> {
    return this.serializeDispatch(() => this.dispatchTaskOrQueueUnlocked(project, t, extra));
  }

  private async dispatchTaskOrQueueUnlocked(project: string, t: any, extra: any = {}): Promise<any> {
    if (!t?.to) return { notified: false, max_parallel: 0 };
    const max = await this.agentMaxParallel(t.to);
    const inFlight = await this.directedInFlight(t.to);
    const taskId = String(t.task_id ?? t.id ?? "");
    if (inFlight >= max) {
      const pos = await this.queuePosition(t.to, taskId);
      const queued = { ...t, dispatch_state: "queued", updated_at: Date.now() };
      await this.st.put(`task:${taskId}`, queued);
      // 排队也是状态变化：没有这条事件，管理端和客户端只能等任务真正下发才知道它存在。
      let seq: number | undefined;
      try {
        seq = await this.append({
          project, sender: "admin", topic: "task", kind: "queued", to: t.to,
          payload: { task_id: taskId, title: t.title ?? "", work_item: false,
                     dispatch_state: "queued", queue_position: pos, max_parallel: max,
                     priority: clampPriority(t.priority), effective_priority: this.effectivePriority(t),
                     deadline_at: t.deadline_at ?? null, attempts: Number(t.attempts ?? 0),
                     retry: Number(t.attempts ?? 0) > 0 },
          dedupe_key: `task-queued:${taskId}:${Number(t.dispatch_count ?? 0)}:${Date.now()}`,
        });
      } catch (e: any) {
        console.warn("task queued event failed", taskId, e?.message ?? e);
      }
      return { notified: false, dispatch_state: "queued", queue_position: pos,
               max_parallel: max, seq };
    }
    const count = Number(t.dispatch_count ?? 0) + 1;
    const retried = Number(t.attempts ?? 0) > 0;
    const next = { ...t, dispatch_state: "notified", notified_at: Date.now(),
                   dispatch_count: count, updated_at: Date.now() };
    await this.st.put(`task:${taskId}`, next);
    const seq = await this.append({
      project, sender: "admin", topic: "task", kind: "task", to: t.to,
      payload: { task_id: taskId, title: t.title ?? "", body: t.body ?? "",
                 work_item: true, dispatch_count: count, priority: clampPriority(t.priority),
                 effective_priority: this.effectivePriority(t), deadline_at: t.deadline_at ?? null,
                 attempts: Number(t.attempts ?? 0), retried, ...extra },
      dedupe_key: `task-dispatch:${taskId}:${count}`,
    });
    return { notified: true, dispatch_state: "notified", seq, max_parallel: max };
  }

  /** 释放一个槽位后，按优先级/截止/老化补发队列里的任务，直到达到并发上限。
   *  与 dispatchTaskOrQueue 共用同一把派单锁，保证补位和新建不会并发越过单飞上限。 */
  private promoteQueue(project: string, agentId: string | null | undefined): Promise<any[]> {
    return this.serializeDispatch(() => this.promoteQueueUnlocked(project, agentId));
  }

  private async promoteQueueUnlocked(project: string, agentId: string | null | undefined): Promise<any[]> {
    if (!agentId) return [];
    const max = await this.agentMaxParallel(agentId);
    let inFlight = await this.directedInFlight(agentId);
    const promoted: any[] = [];
    while (inFlight < max) {
      const now = Date.now();
      const queued = (await this.listRawTasks())
        .filter((t: any) => t.to === agentId && t.state === "open" && this.dispatchStateOf(t) === "queued"
          && this.retryReady(t, now))
        .sort((a: any, b: any) => this.compareQueue(a, b, now));
      const t = queued[0];
      if (!t) break;
      const taskId = String(t.task_id ?? t.id ?? "");
      const count = Number(t.dispatch_count ?? 0) + 1;
      const retried = Number(t.attempts ?? 0) > 0;
      const next = { ...t, dispatch_state: "notified", notified_at: Date.now(),
                     next_retry_at: null, dispatch_count: count, updated_at: Date.now() };
      await this.st.put(`task:${taskId}`, next);
      const seq = await this.append({
        project, sender: "admin", topic: "task", kind: "task", to: agentId,
        payload: { task_id: taskId, title: t.title ?? "", body: t.body ?? "",
                   work_item: true, dispatch_count: count, queue_promoted: true,
                   priority: clampPriority(t.priority), effective_priority: this.effectivePriority(t),
                   deadline_at: t.deadline_at ?? null, attempts: Number(t.attempts ?? 0), retried },
        dedupe_key: `task-dispatch:${taskId}:${count}`,
      });
      promoted.push({ task_id: taskId, seq, retried, attempts: Number(t.attempts ?? 0) });
      inFlight++;
    }
    return promoted;
  }

  async fetch(req: Request): Promise<Response> {
    try {
      return await this.handle(req);
    } catch (e: any) {
      if (e instanceof DoError) return json({ error: e.code, ...publicErrorDetail(e.detail) }, e.status);
      throw e;
    }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = url.pathname.replace(/^\/do\//, "/").replace(/^\/+/, "");
    const body: any = req.method === "GET" ? null : await req.json().catch(() => null);

    switch (action) {
      case "publish":      return this.publish(body);
      case "inbox":        return this.inbox(Number(url.searchParams.get("since") ?? 0),
                                             url.searchParams.get("topics"), Number(url.searchParams.get("limit") ?? 100),
                                             url.searchParams.get("agent"),
                                             url.searchParams.get("desc") === "1",
                                             url.searchParams.get("project"),
                                             url.searchParams.get("event_role") ?? "agent");
      case "events":       return this.eventsFeed(url);
      case "heartbeat":    return this.heartbeat(body);
      case "ack":          return this.ack(body);
      case "report":       return this.report(body);
      case "tasks/claim":  return this.claim(body);
      case "tasks/claim-next": return this.claimNext(body);
      case "tasks/release":return this.release(body);
      case "tasks/fail":   return this.failTask(body);
      case "tasks/admin-retry": return this.adminRetry(body);
      case "tasks/admin-merge": return this.adminMerge(body);
      case "tasks/admin-requeue": return this.adminRequeue(body);
      case "tasks/timeline": return this.taskTimeline(body);
      case "observability": return this.observability(body);
      case "tasks/submission-settled": return this.submissionSettled(body);
      case "tasks/list":   return this.listTasks();
      case "tasks/active-load": return this.activeLoad(body);
      case "tasks/get":    return this.getTask(body);
      case "tasks/create": return this.createTask(body);
      case "tasks/admin-close": return this.adminClose(body);
      case "tasks/admin-reclaim": return this.adminReclaim(body);
      case "tasks/admin-reassign": return this.adminReassign(body);
      case "broadcast":    return this.broadcast(body);
      case "agent/list":   return this.agents();
      case "agent/get":    return this.getAgent(new URL(req.url));
      case "agent/control": return this.controlAgent(body);
      case "agent/activity": return this.markActivity(body);
      case "agents/config": return this.setAgentConfig(body);
      case "webhook/get":  return this.webhookGet();
      case "webhook/set":  return this.webhookSet(body);
      case "webhook/test": return this.webhookTest();
      case "agents/idle-list": return this.idleList(body);
      case "agents/idle-remind": return this.idleRemind(body);
      case "agent/remove": return this.removeAgent(body);
      case "ws":           return this.ws(req);
      case "wsstat": {
        // 只报"活着的会话"，并按 agent 汇总；sockets 字段保留给旧客户端/提示词
        const live = this.liveSockets();
        return json({ sockets: live.length, agents: new Set(live.map((x) => x.agent)).size, live });
      }
      case "snapshot":     return this.snapshot();
      case "cron/tick":    return this.tick(body);
      default:             return json({ error: "unknown_action", code: "unknown_action", action,
                                       hint: "当前服务端没有这个 action。先 GET /capabilities 和 GET /skill；节点给管理员发消息用 POST /p/{project}/publish，不要用 /send。",
                                       capabilities: "/capabilities", docs: "/skill" }, 404);
    }
  }

  // 房间代号：换 DO 命名空间后 seq 从 0 开始，归档必须按房间分段，
  // 否则新 seq 会覆盖旧归档（v6→v7 实测踩到）。
  private isToMe(to: any, me: string | null): boolean {
    if (!to) return true;
    if (Array.isArray(to)) return !!me && to.includes(me);
    return to === me;
  }

  // 普通 agent 的收件箱只接收件人明确指向它的消息；另加管理端的 announce 广播。
  // 普通 agent 自己发出的无收件人广播（issue/report/status 等）只进管理台；
  // Issue 生命周期、artifact、task 生命周期和普通项目事件也不进普通 inbox。
  // 这样既保留管理端“通知全员”的公告，又不让普通 agent 的 issue/汇报互相刷屏。
  private agentCanSee(m: Msg, me: string | null): boolean {
    if (!me || me === "*") return true;
    if (m.to) return this.isToMe(m.to, me);
    // 管理端公告仍可广播给全员；其它无收件人消息只给管理台/观察员事件流。
    if (m.sender === "admin" && m.topic === "announce") return true;
    return false;
  }

  /** 任务播报（topic=task, kind=task）在创建时冻结收件范围：无主任务先播报给
   * 全员，定向任务只投给目标；之后被转派、被别人领走或已关闭时，旧播报仍留在
   * 原收件人的 inbox 里，点了只会吃 not_your_task / locked / 终态 409
   * （ISS-MWSO8HVB-A957CB）。这里按任务的当前记录复核失效；任务记录查不到时
   * 保留（fail-open），管理员视角（me="*"/null）在调用处已跳过，不过滤。 */
  private async dropStaleTaskAnnouncements(messages: Msg[], me: string): Promise<Msg[]> {
    const isAnnouncement = (m: any) =>
      m.topic === "task" && m.kind === "task" && !!(m.payload as any)?.task_id;
    if (!messages.some(isAnnouncement)) return messages;
    const out: Msg[] = [];
    const cache = new Map<string, any>();
    for (const m of messages) {
      if (!isAnnouncement(m)) { out.push(m); continue; }
      const id = String((m.payload as any).task_id);
      if (!cache.has(id)) cache.set(id, await this.st.get(`task:${id}`));
      const t: any = cache.get(id);
      if (!t) { out.push(m); continue; }
      if (t.to && !this.isToMe(t.to, me)) continue;
      // 只隐藏“仍被别人有效持有”的任务；已过期 lease 可被重新 claim，播报仍有效。
      if (t.state === "claimed" && t.owner && t.owner !== me
          && Number(t.lease_until ?? 0) > Date.now()) continue;
      // done / blocked / released 都不可 claim，留在别人 inbox 只会换来 409：
      // done=already_done，blocked=blocked，released=released_pending_collection。
      if (t.state === "done" || t.state === "blocked" || t.state === "released") continue;
      out.push(m);
    }
    return out;
  }

  private projectName(): string {
    try { return String((this.state.id as any).name ?? ""); } catch { return ""; }
  }

  /** 对外展示的项目名：DO 名带 v9: 前缀，webhook 事件里不能带内部命名空间。 */
  private projectSlug(): string {
    return this.projectName().replace(/^v9:/, "");
  }

  private async room(): Promise<string> {
    let ep = await this.st.get<string>("epoch");
    if (!ep) {
      ep = Math.random().toString(36).slice(2, 10);
      await this.st.put("epoch", ep);
    }
    return ep;
  }

  // ── 客户端实时事件：与消息共用 seq，客户端只按 type 订阅，不解析 topic/kind ──
  /** topic/kind → 稳定事件类型。返回 null 表示这条消息不值得进入事件流（ack 等噪音）。 */
  private eventTypeOf(msg: Msg): string | null {
    const p: any = msg.payload ?? {};
    if (msg.topic === "artifact" && p.submission_id) return "submission.created";
    if (msg.topic === "submission") {
      if (msg.kind === "collected") return "submission.collected";
      if (msg.kind === "archived") return "submission.archived";
      if (msg.kind === "apply_conflict") return "submission.apply_conflict";
      return "submission.reviewed";
    }
    if (msg.topic === "task") {
      if (msg.kind === "task") return p.retried ? "task.retried" : "task.dispatched";
      if (msg.kind === "created") return "task.created";
      if (msg.kind === "queued") return "task.queued";
      if (msg.kind === "claimed") return "task.claimed";
      if (msg.kind === "failed") return "task.failed";
      if (msg.kind === "dead_lettered") return "task.dead_lettered";
      if (msg.kind === "retry_scheduled") return "task.retry_scheduled";
      if (msg.kind === "retried") return "task.retried";
      if (msg.kind === "merged") return "task.merged";
      if (msg.kind === "requeued") return "task.requeued";
      if (msg.kind === "released") return "task.released";
      if (msg.kind === "blocked") return "task.blocked";
      if (msg.kind === "done") return "task.done";
      if (msg.kind === "open") return "task.reopened";
      if (msg.kind === "reclaimed" || msg.kind === "reclaimed_away") return "task.reclaimed";
      if (msg.kind === "reassigned" || msg.kind === "reassigned_away") return "task.reassigned";
      return "task.updated";
    }
    if (msg.topic === "announce") return "announcement.created";
    if (msg.topic === "admin") return "notice.created";
    if (msg.topic === "system") return "system.notice";
    if (msg.topic === "report") return "report.created";
    if (msg.topic === "issue") {
      if (msg.kind === "closed") return "issue.closed";
      if (msg.kind === "reopened") return "issue.reopened";
      if (msg.kind === "merged") return "issue.merged";
      if (msg.kind === "dispatched") return "issue.dispatched";
      if (msg.kind === "updated") return "issue.updated";
      return "issue.created";
    }
    if (msg.topic === "ci") return "ci.status";
    if (msg.topic === "status") return "status.changed";
    if (msg.topic === "alert") return "alert.created";
    return null;
  }

  private taskStateOfEvent(kind: string): string | undefined {
    if (["task", "created", "queued", "open", "reassigned", "reassigned_away", "retried"].includes(kind)) return "open";
    if (["failed", "retry_scheduled"].includes(kind)) return "open";
    if (kind === "dead_lettered") return "failed";
    if (kind === "claimed") return "claimed";
    if (kind === "done") return "done";
    if (kind === "released") return "released";
    if (kind === "blocked") return "blocked";
    if (kind === "reclaimed" || kind === "reclaimed_away") return "open";
    return undefined;
  }

  /** 把一条已落库消息映射为客户端事件；不复制信封内部字段。 */
  private clientEventOf(msg: Msg): ClientEvent | null {
    const type = this.eventTypeOf(msg);
    if (!type) return null;
    const data: any = { ...(msg.payload as any ?? {}) };
    const taskId = typeof data.task_id === "string" ? data.task_id : undefined;
    const submissionId = typeof data.submission_id === "string" ? data.submission_id : undefined;
    const project = String(msg.project ?? this.projectSlug() ?? "").replace(/^v9:/, "");
    const state = msg.topic === "task" ? (msg.kind === "failed" && data.dead_letter === true
      ? "failed" : this.taskStateOfEvent(String(msg.kind)))
      : msg.topic === "submission" ? String(data.state ?? msg.kind) : undefined;
    const reviewState = msg.topic === "submission" || (msg.topic === "artifact" && submissionId)
      ? String(data.review_state ?? (msg.topic === "artifact" ? "pending" : msg.kind))
      : undefined;
    return {
      id: `evt-${project || "p"}-${msg.seq}`,
      version: 1,
      source: "synapse-agent-hub",
      project,
      type,
      seq: msg.seq,
      ts: msg.ts || new Date().toISOString(),
      actor: String(msg.sender ?? "unknown"),
      to: msg.to ?? null,
      ...(taskId ? { task_id: taskId } : {}),
      ...(submissionId ? { submission_id: submissionId } : {}),
      ...(state ? { state } : {}),
      ...(reviewState ? { review_state: reviewState } : {}),
      data,
    };
  }

  /** 事件可见性：管理端（role=admin）、观察员（role=observer）全量；普通 agent 只看
   *  to/actor 明确指向自己的任务、交付或自己发起的动作事件，以及管理端 announce 广播。
   *  普通 agent 自己的无收件人广播（issue/report/status）和别人的项目事件只给管理端。 */
  private eventVisible(e: ClientEvent, att: any): boolean {
    if (!att || att.role === "admin" || att.role === "observer") return true;
    const me = String(att.me ?? "");
    if (!me || me === "unknown" || me === "*") return false;
    if (e.to && this.isToMe(e.to, me)) return true;
    if (e.actor === me) return true;             // 自己发起的 claim/release/submit 也要收到
    const d: any = e.data ?? {};
    for (const key of ["agent_id", "task_assignee", "owner", "assignee"]) {
      const v = d[key];
      if (typeof v === "string" && v === me) return true;
      if (Array.isArray(v) && v.includes(me)) return true;
    }
    // 管理端公告仍向全员广播；普通 agent 自己发的 issue/report 广播不再互相下发。
    if (e.type === "announcement.created" && !e.to && e.actor === "admin") return true;
    return false;
  }

  private pushEvent(msg: Msg, ws: any, att: any) {
    const event = this.clientEventOf(msg);
    if (!event || !this.eventVisible(event, att)) return false;
    try {
      ws.send(JSON.stringify({ type: "event", event }));
      return true;
    } catch { return false; }
  }

  // ── Webhook：管理侧事件推送 ──────────────────────────────────
  private webhookTopicOf(msg: Msg): string | null {
    if (msg.topic === "artifact" && (msg.payload as any)?.submission_id) return "submission";
    if (msg.topic === "submission") return "submission";
    if (msg.topic === "task") return "task";
    if (msg.topic === "issue") return "issue";
    if (msg.topic === "ci") return "ci";
    if (msg.topic === "alert") return "alert";
    if (msg.topic === "announce") return "announce";
    if (msg.topic === "admin") return "admin";
    if (msg.topic === "system") return "system";
    return null;
  }

  private webhookEvent(msg: Msg): any {
    const event = this.clientEventOf(msg);
    if (event) return { ...event, sender: msg.sender };
    const payload: any = msg.payload ?? {};
    const project = String(msg.project ?? this.projectSlug() ?? "").replace(/^v9:/, "");
    return {
      id: `evt-${project || "p"}-${msg.seq}`,
      version: 1,
      source: "synapse-agent-hub",
      project,
      type: `${msg.topic}.${msg.kind}`,
      seq: msg.seq,
      ts: msg.ts || new Date().toISOString(),
      actor: msg.sender,
      to: msg.to ?? null,
      data: payload,
    };
  }

  private async postWebhook(cfg: WebhookConfig, event: any): Promise<{ ok: boolean; status: number; error?: string }> {
    const body = JSON.stringify(event);
    const ts = String(Date.now());
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "synapse-agent-hub/webhook",
      "x-synapse-event": String(event.type ?? ""),
      "x-synapse-timestamp": ts,
    };
    if (cfg.secret) {
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(cfg.secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
      headers["x-synapse-signature"] = `sha256=${hexBytes(sig)}`;
    }
    try {
      const res = await fetch(String(cfg.url), {
        method: "POST", headers, body, signal: AbortSignal.timeout(5000),
      });
      let detail = "";
      try { detail = (await res.text()).slice(0, 160); } catch { /* 2xx 无正文也正常 */ }
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `http_${res.status}${detail ? `: ${detail}` : ""}` };
    } catch (e: any) {
      return { ok: false, status: 0, error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  private async recordWebhook(last: any) {
    await this.st.put("webhook:last", { ...last, at: Date.now() }).catch(() => {});
  }

  private scheduleWebhook(msg: Msg) {
    const promise = this.deliverWebhook(msg).catch((e: any) =>
      console.warn("webhook deliver failed", msg.seq, e));
    const state: any = this.state;
    if (typeof state.waitUntil === "function") state.waitUntil(promise);
  }

  private async deliverWebhook(msg: Msg) {
    const cfg: WebhookConfig | undefined = await this.st.get("webhook:config").catch(() => undefined);
    if (!cfg?.enabled || !cfg.url) return;
    const topic = this.webhookTopicOf(msg);
    if (!topic) return;
    const topics = Array.isArray(cfg.topics) && cfg.topics.length ? cfg.topics : ["submission"];
    if (!(topics.includes("all") || topics.includes(topic))) return;
    const event = this.webhookEvent(msg);
    const result = await this.postWebhook(cfg, event);
    await this.recordWebhook({ event_type: event.type, ok: result.ok,
                               status: result.status, error: result.error ?? null, seq: msg.seq });
    const qkey = `whq:${msg.seq}`;
    if (result.ok) {
      await this.st.delete(qkey).catch(() => {});
      return;
    }
    // 失败重试：5s 起，指数退避，最多 8 次；同时用 DO alarm 触发，cron tick 兜底。
    const prev: any = await this.st.get(qkey).catch(() => null);
    const attempts = Number(prev?.attempts ?? 0) + 1;
    if (attempts > 8) { await this.st.delete(qkey).catch(() => {}); return; }
    const nextAt = Date.now() + Math.min(60_000, 5_000 * (2 ** (attempts - 1)));
    await this.st.put(qkey, { event, attempts, next_at: nextAt }).catch(() => {});
    const storage: any = this.st;
    if (typeof storage.setAlarm === "function") {
      await storage.setAlarm(nextAt).catch(() => {});
    }
  }

  private async flushWebhooks(): Promise<{ sent: number; failed: number }> {
    const cfg: WebhookConfig | undefined = await this.st.get("webhook:config").catch(() => undefined);
    if (!cfg?.enabled || !cfg.url) return { sent: 0, failed: 0 };
    const rows = await this.st.list<any>({ prefix: "whq:" }).catch(() => null);
    if (!rows) return { sent: 0, failed: 0 };
    let sent = 0, failed = 0, earliest = 0;
    for (const [key, item] of rows) {
      if (!item?.event) { await this.st.delete(key).catch(() => {}); continue; }
      if (Number(item.next_at ?? 0) > Date.now()) {
        earliest = Math.min(earliest || Number(item.next_at), Number(item.next_at));
        continue;
      }
      const result = await this.postWebhook(cfg, item.event);
      await this.recordWebhook({ event_type: item.event.type, ok: result.ok,
                                 status: result.status, error: result.error ?? null, seq: item.event.seq });
      if (result.ok) {
        sent++;
        await this.st.delete(key).catch(() => {});
        continue;
      }
      failed++;
      const attempts = Number(item.attempts ?? 0) + 1;
      if (attempts > 8) { await this.st.delete(key).catch(() => {}); continue; }
      const nextAt = Date.now() + Math.min(60_000, 5_000 * (2 ** (attempts - 1)));
      await this.st.put(key, { ...item, attempts, next_at: nextAt }).catch(() => {});
      earliest = Math.min(earliest || nextAt, nextAt);
    }
    const storage: any = this.st;
    if (earliest && typeof storage.setAlarm === "function") await storage.setAlarm(earliest).catch(() => {});
    return { sent, failed };
  }

  private async webhookGet() {
    const cfg: WebhookConfig | undefined = await this.st.get("webhook:config").catch(() => undefined);
    const last = await this.st.get("webhook:last").catch(() => null);
    return json({
      enabled: !!cfg?.enabled, url: cfg?.url ?? "",
      topics: Array.isArray(cfg?.topics) ? cfg.topics : ["submission"],
      has_secret: !!cfg?.secret, last: last ?? null,
    });
  }

  private async webhookSet(b: any) {
    const url = String(b?.url ?? "").trim();
    if (url) {
      if (url.length > 512) return json({ error: "webhook_url_too_long" }, 422);
      try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:")
          return json({ error: "webhook_url_bad_protocol" }, 422);
      } catch { return json({ error: "webhook_url_invalid" }, 422); }
    }
    const enabled = b?.enabled === true;
    if (enabled && !url) return json({ error: "webhook_url_required" }, 422);
    const rawTopics = Array.isArray(b?.topics) ? b.topics : ["submission"];
    const topics = [...new Set(rawTopics.map((x: any) => String(x).trim()).filter(Boolean))];
    if (!topics.length || topics.some((x) => !WEBHOOK_TOPICS.has(x)))
      return json({ error: "bad_webhook_topics", allowed: [...WEBHOOK_TOPICS] }, 422);
    const prev: WebhookConfig | undefined = await this.st.get("webhook:config").catch(() => undefined);
    const secret = String(b?.secret ?? "").trim();
    if (secret && (secret.length < 8 || secret.length > 128))
      return json({ error: "webhook_secret_length", min: 8, max: 128 }, 422);
    if (enabled && !secret && !prev?.secret)
      return json({ error: "webhook_secret_required", hint: "启用 webhook 必须设置签名密钥；至少 8 位" }, 422);
    const next: WebhookConfig = { enabled, url, topics,
      secret: secret || prev?.secret || "", updated_at: Date.now() };
    await this.st.put("webhook:config", next);
    return json({ ok: true, enabled, url, topics, has_secret: !!next.secret });
  }

  private async webhookTest() {
    const cfg: WebhookConfig | undefined = await this.st.get("webhook:config").catch(() => undefined);
    if (!cfg?.enabled || !cfg.url) return json({ error: "webhook_disabled" }, 409);
    const event = { id: `test-${Date.now()}`, source: "synapse-agent-hub",
      project: this.projectSlug(), type: "webhook.test", seq: 0,
      ts: new Date().toISOString(), sender: "system", to: "admin",
      data: { message: "Synapse webhook self-test" } };
    const result = await this.postWebhook(cfg, event);
    await this.recordWebhook({ event_type: event.type, ok: result.ok,
                               status: result.status, error: result.error ?? null, seq: 0 });
    return json({ ok: result.ok, status: result.status, error: result.error ?? null });
  }

  // ── 消息追加：seq 分配 + dedupe ─────────────────────────────
  private async append(m: Partial<Msg>): Promise<number> {
    // 所有写入路径统一过这里：大小按 UTF-8 字节算（不是 JS 字符数），限流按发送者分钟桶
    const size = utf8Bytes(JSON.stringify(m.payload ?? {}));
    if (size > 64 * 1024)
      throw new DoError(413, "payload_too_large", { size, cap: 64 * 1024 });
    const who = String(m.sender ?? "unknown");
    if (m.dedupe_key) {
      const dup = await this.st.get<number>(`dedupe:${who}:${m.dedupe_key}`);
      if (dup) return dup;
    }
    const cap = Math.max(1, Math.min(1000, Number((m as any).max_per_min ?? 60)));
    const bucket = `rate:${who}:${Math.floor(Date.now() / 60000)}`;
    const n = (await this.st.get<number>(bucket)) ?? 0;
    if (n >= cap) throw new DoError(429, `rate_limited:${cap}/min`, { minute_count: n, cap });
    await this.st.put(bucket, n + 1);
    // 清掉同发送者上一分钟的桶，避免 rate:* 永久累积
    for (const k of (await this.st.list({ prefix: `rate:${who}:`, limit: 20 })).keys()) {
      if (k.name !== bucket) await this.st.delete(k.name);
    }
    const seq = ((await this.st.get<number>("seq")) ?? 0) + 1;
    await this.st.put("seq", seq);
    // max_per_min / project / sender 等只是 Worker 注入的信封字段，不该同时复制进 payload；
    // 广播和旧任务消息曾把内部字段带进 payload，这里做统一脱敏（只删与信封同值的副本）。
    const { max_per_min: _internalCap, ...publicMsg } = m as any;
    const payload: any = { ...(publicMsg.payload ?? {}) };
    delete payload.max_per_min;
    if (payload.project === (m as any).project) delete payload.project;
    if (payload.sender === who) delete payload.sender;
    if (payload.agent_id === who) delete payload.agent_id;
    if (payload.role && (m as any).role && payload.role === (m as any).role) delete payload.role;
    publicMsg.payload = payload;
    const msg: Msg = { ...(publicMsg as Msg), seq, ts: new Date().toISOString() };
    await this.st.put(msgKey(seq), msg);
    if (m.dedupe_key) await this.st.put(`dedupe:${who}:${m.dedupe_key}`, seq);
    if (seq > LATEST_KEEP) await this.st.delete(msgKey(seq - LATEST_KEEP));
    // F2：同步落 D1，热窗口之外仍可回读 / 回执；失败不阻断实时链路
    try {
      const room = await this.room();
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO archive (project, room, seq, sender, topic, kind, to_agent, payload_json, ts)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(msg.project ?? "", room, seq, msg.sender ?? "", msg.topic ?? "", msg.kind ?? "",
             (msg as any).to ?? null, JSON.stringify(msg.payload ?? {}), msg.ts).run();
    } catch { /* D1 抖动时保留 DO 热副本 */ }
    this.push(msg);
    // 事件推送：先立即 POST webhook；失败进 whq 重试队列，不阻塞 append/主流程。
    // artifact(submission) 是管理侧最关心的“交付到达”事件；task 等按订阅开关。
    this.scheduleWebhook(msg);
    return seq;
  }

  // ── WebSocket：连接挂在 DO 上，空闲可休眠 ───────────────────
  private liveSockets(): any[] {
    const live: any[] = [];
    for (const ws of this.state.getWebSockets()) {
      let att: any = null;
      try { att = ws.deserializeAttachment?.(); } catch { att = null; }
      live.push({ agent: att?.me ?? "unknown", role: att?.role ?? "agent", connected_at: att?.at ?? null });
    }
    return live;
  }

  private ws(req: Request): Response {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
      return json({ error: "upgrade_required" }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // 客户端身份随连接保存，断线重连时管理端能看到"谁连着"
    const me = req.headers.get("x-agent-id") ?? "unknown";
    const role = req.headers.get("x-role") ?? "agent";
    // 同一 agent 只保留最新一条会话：旧连接先踢掉，避免两个 run 实例同时消费、重复回执。
    // 管理台例外：多个标签页/设备可以并存，否则会互相踢成“连接中”循环。
    for (const old of this.state.getWebSockets()) {
      try {
        const att: any = old.deserializeAttachment?.();
        if (role !== "admin" && att?.me === me) old.close(4001, "superseded by new connection");
      } catch { /* 旧运行时没有 attachment */ }
    }
    this.state.acceptWebSocket(server, [me]);
    try { server.serializeAttachment({ me, role, at: Date.now() }); } catch { /* 兼容旧运行时 */ }
    server.send(JSON.stringify({
      type: "hello", at: Date.now(), role, agent_id: me,
      events: true, event_version: 1,
      event_types: ["submission.created", "submission.reviewed", "submission.collected",
                    "submission.archived", "submission.apply_conflict", "task.created", "task.queued", "task.dispatched",
                    "task.claimed", "task.released", "task.blocked", "task.done",
                    "task.reopened", "task.reclaimed", "task.reassigned", "task.updated",
                    "task.failed", "task.retry_scheduled", "task.retried", "task.dead_lettered",
                    "task.merged", "task.requeued",
                    "issue.created", "issue.closed", "issue.reopened", "issue.merged",
                    "issue.dispatched", "issue.updated", "ci.status",
                    "announcement.created", "notice.created", "system.notice"],
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // 客户端 ping / pong；异常关闭不影响其它连接
  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data === "string" && data.includes("ping"))
      ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code === 1000 ? 1000 : 1011, reason); } catch { /* 已断 */ }
  }

  private push(msg: Msg) {
    const payload = JSON.stringify({ type: "msg", ...msg });
    for (const ws of this.state.getWebSockets()) {
      let att: any = null;
      try { att = ws.deserializeAttachment?.(); } catch { att = null; }
      const me = att?.me ?? "unknown";
      const isAdmin = att?.role === "admin";
      // 与 HTTP inbox 使用同一套可见性：管理端看全量；普通 agent 只看定向消息和管理端 announce。
      if (isAdmin || this.agentCanSee(msg, me)) {
        try { ws.send(payload); } catch { /* 单条连接坏了就跳过 */ }
      }
      // 事件帧独立于原始消息：普通 agent 看不到别人的 artifact 原文，但能收到
      // 与自己相关的 submission.created 事件。订阅方只解析 type，不解析 topic/kind。
      this.pushEvent(msg, ws, att);
    }
  }

  private async publish(b: any) {
    if (!b?.dedupe_key) return json({ error: "dedupe_key_required" }, 422);
    const who = String(b.sender ?? b.agent_id ?? "unknown");
    const dup = await this.st.get<number>(`dedupe:${who}:${b.dedupe_key}`);
    if (dup) return json({ seq: dup, deduped: true });
    const seq = await this.append(b);
    return json({ seq });
  }

  private async inbox(since: number, topics: string | null, limit: number,
                      me: string | null = null, desc = false, project: string | null = null,
                      eventRole: string = "agent") {
    since = Math.max(0, Number.isFinite(since) ? since : 0);
    limit = Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : 100));
    // 历史键 `msg:87` 是字符串，字典序里 msg:100 < msg:99，since 游标会失效。
    // 新键统一零填充；读取时两段都扫，按 seq 去重合并，老数据不丢。
    // desc 是「只要最新 N 条」：必须从键尾反向取，否则 limit 300 会先取到最老的 300 条，
    // seq 超过 300 后管理台永远看不到新消息（定向消息看起来像没发出去）。
    const padded = await this.st.list<Msg>({
      start: msgKey(since + 1), end: "msg:9999999999", limit: 300, reverse: desc,
    });
    const legacy = await this.st.list<Msg>({
      start: `msg:${since + 1}`, end: "msg:\uffff", limit: 300, reverse: desc,
    });
    const seen = new Set<number>();
    const total = (await this.st.get<number>("seq")) ?? 0;
    // F2：游标落在热窗口之前时，把 D1 归档里的段补进来（否则永久丢失）
    let archived: Msg[] = [];
    if (project && since < Math.max(0, total - LATEST_KEEP)) {
      const lim = Math.min(300, Math.max(limit, 100));
      const q = await this.env.DB.prepare(
        `SELECT seq, sender, topic, kind, to_agent, payload_json, ts FROM archive
          WHERE project = ? AND room = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`
      ).bind(project, await this.room(), since, Math.max(0, total - LATEST_KEEP), lim).all<any>();
      archived = (q.results ?? []).map((r: any) => ({
        seq: Number(r.seq), sender: r.sender, topic: r.topic, kind: r.kind,
        to: r.to_agent ?? undefined, payload: safeJson(r.payload_json), ts: r.ts,
      })) as Msg[];
    }
    let messages = [...archived, ...padded.values(), ...legacy.values()]
      .filter((m: any) => (m?.seq ? !seen.has(m.seq) && (seen.add(m.seq), true) : false))
      .sort((a: any, b: any) => a.seq - b.seq);
    if (topics) {
      const t = topics.split(",").map((x) => x.trim()).filter(Boolean);
      messages = messages.filter((m) => t.includes(m.topic));
    }
    // 普通 agent 只看定向消息和管理端 announce；普通 agent 自己发的项目广播/Issue/artifact/task 生命周期只进管理台。
    // me="*" 是管理员视角：不做过滤，看全量。
    const rawMessages = messages;
    let visible = messages.filter((m: any) => this.agentCanSee(m, me));
    // 任务播报冻结的是创建时的 to：无主播报之后被指派/领走/关闭，对其他人已失效，
    // 返回前按任务当前记录复核（ISS-MWSO8HVB-A957CB）。
    if (me && me !== "*") visible = await this.dropStaleTaskAnnouncements(visible, me);
    const page = desc ? visible.slice(-limit) : visible.slice(0, limit);
    // 游标必须推进到“已扫描的原始消息”末条：如果这一页全被过滤掉，
    // 还停在 since 会让客户端每次轮询都重复拉同一段噪音。
    const lastRawSeq = rawMessages.length ? rawMessages[rawMessages.length - 1].seq : since;
    const next = desc
      ? (page.length ? page[page.length - 1].seq : lastRawSeq)
      : (page.length < limit ? lastRawSeq : page[page.length - 1].seq);
    // 房间被重建（换命名空间）时 seq 会从头开始，客户端靠 epoch 判断要重置游标
    const epoch = await this.room();
    // 事件视图与消息视图共用游标，但可见范围独立：普通 agent 收不到别人的 artifact 原文，
    // 仍应收到自己的 submission.created；管理端（me="*"）看全量。
    const eventAtt = { me: me === "*" ? "*" : me,
      role: (me === "*" || me === null) ? "admin" : (eventRole === "observer" ? "observer" : "agent") };
    const eventRows = rawMessages
      .map((m: any) => ({ m, e: this.clientEventOf(m) }))
      .filter((x: any) => x.e && this.eventVisible(x.e, eventAtt))
      .map((x: any) => x.e);
    const eventPage = desc ? eventRows.slice(-limit) : eventRows.slice(0, limit);
    const events = eventPage;
    // 事件游标不能复用消息页的 next：observer 的消息页通常为空/很小，
    // 但事件可见性是全量；复用会把游标直接跳到 lastRawSeq，跳过中间事件。
    const nextEvent = desc
      ? (eventPage.length ? eventPage[eventPage.length - 1].seq : lastRawSeq)
      : (eventPage.length < limit ? lastRawSeq : eventPage[eventPage.length - 1].seq);
    return json({ messages: page, events, next_cursor: next, next_event_cursor: nextEvent,
                  epoch, has_more: rawMessages.length > page.length });
  }

  /** 事件专用拉取：给没有 WebSocket 的客户端/降级通道用；游标与消息 seq 同源。 */
  private async eventsFeed(url: URL) {
    const since = Number(url.searchParams.get("since") ?? 0);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 100)));
    const me = url.searchParams.get("agent");
    const topics = url.searchParams.get("topics");
    const project = url.searchParams.get("project");
    const eventRole = url.searchParams.get("event_role") ?? "agent";
    // 不能把 topics 交给 inbox：submission.created 的原始消息 topic 是 artifact，
    // 用 submission 过滤会把它整条排掉。这里取全量事件，再按事件类别过滤。
    const r = await this.inbox(since, null, limit, me, false, project, eventRole);
    const d: any = await r.json().catch(() => ({}));
    let events: any[] = d.events ?? [];
    if (topics) {
      const wanted = new Set(topics.split(",").map((s) => s.trim()).filter(Boolean));
      if (!wanted.has("all")) {
        events = events.filter((e: any) => {
          const type = String(e.type ?? "");
          const category = type.startsWith("task.") ? "task"
            : type.startsWith("submission.") ? "submission"
            : type.startsWith("announcement.") ? "announce"
            : type.startsWith("notice.") ? "admin"
            : type.startsWith("system.") ? "system"
            : type.split(".")[0] || "";
          return wanted.has(category) || (category === "submission" && wanted.has("artifact"));
        });
      }
    }
    const nextEvent = d.next_event_cursor ?? d.next_cursor ?? since;
    return json({ events, next_cursor: nextEvent, next_event_cursor: nextEvent,
                  epoch: d.epoch ?? null });
  }

  // ── 心跳：覆盖写 + 顺带续租 + 每 5 分钟落一行历史 ──────────
  private async heartbeat(b: any) {
    if (!b?.agent_id) return json({ error: "agent_id_required" }, 422);
    const key = `agent:${b.agent_id}`;
    const prev: any = (await this.st.get(key)) ?? {};
    const now = Date.now();
    const clientVersion = String(b.sdk_version ?? "").trim().slice(0, 40);
    const latestVersion = String(b.latest_sdk_version ?? "").trim().slice(0, 40);
    const incomingHash = launchText(b.launch_hash, 100);
    const incomingLaunch = normalizeLaunch(b.launch, now, clientVersion);
    const hashMatched = !!(incomingHash && prev.launch_hash === incomingHash);
    const launchRequired = !incomingLaunch && (!prev.launch || (!!incomingHash && !hashMatched));
    const prevLaunch = prev.launch;
    const nextLaunch = incomingLaunch ?? prevLaunch ?? null;
    const nextAuto = nextLaunch?.delivery?.auto;
    const prevAuto = prevLaunch?.delivery?.auto;
    const restartCount = (() => {
      const a = Number(prevLaunch?.started_at ?? 0);
      const b2 = Number(nextLaunch?.started_at ?? 0);
      if (!a || !b2 || a === b2) return Number(prev.restart_count ?? 0);
      return Number(prev.restart_count ?? 0) + 1;
    })();
    const launchHash = incomingLaunch
      ? (incomingHash ?? prev.launch_hash ?? null)
      : (hashMatched ? prev.launch_hash : prev.launch_hash ?? null);
    const launchReceivedMs = incomingLaunch || hashMatched
      ? now : (prev.launch_received_ms ?? null);
    const autoSinceMs = (() => {
      if (nextAuto === undefined) return prev.auto_since_ms ?? null;
      if (prevAuto === undefined || prevAuto !== nextAuto) return now;
      return prev.auto_since_ms ?? now;
    })();
    const autoOffSinceMs = nextAuto === false
      ? (prevAuto === false ? (prev.auto_off_since_ms ?? now) : now)
      : null;
    const launchChangeCount = incomingHash && prev.launch_hash && incomingHash !== prev.launch_hash
      ? Number(prev.launch_change_count ?? 0) + 1
      : Number(prev.launch_change_count ?? 0);
    const deliveryHealth = normalizeDeliveryHealth(b.delivery_health, now) ?? prev.delivery_health ?? null;
    const incomingDebug = normalizeDebug(b.debug, now);
    // debug 关闭时客户端不再上传日志；保留上次日志供事后查看，只把 enabled 置为 false。
    const debug = incomingDebug
      ? { ...incomingDebug,
          logs: incomingDebug.enabled === true
            ? incomingDebug.logs
            : (Array.isArray(prev.debug?.logs) ? prev.debug.logs : []) }
      : (prev.debug ?? null);
    const incomingErrors = normalizeErrors(b.errors, now);
    const clientErrors = incomingErrors.length
      ? mergeClientErrors(prev.client_errors, incomingErrors, now)
      : (Array.isArray(prev.client_errors) ? prev.client_errors : []);
    // 管理员身份不催升级；普通 agent 未上报版本也按旧客户端处理。
    const outdated = b.role !== "admin" && !!latestVersion && isSdkOutdated(clientVersion, latestVersion);
    const rec = {
      agent_id: b.agent_id,
      role: b.role ?? "agent",
      work: b.work ?? { state: "idle" },
      load: b.load ?? {},
      env: b.env ?? {},
      // 外观/运行形态由客户端上报，用于计算默认并发；管理端覆盖值不能被心跳冲掉。
      surface: b.surface ?? prev.surface ?? null,
      // 最后一次启动现场：新客户端只有第一次或变更后才发全量；其余心跳只带 hash。
      launch: incomingLaunch ?? prev.launch ?? null,
      launch_hash: launchHash,
      launch_received_ms: launchReceivedMs,
      launch_change_count: launchChangeCount,
      restart_count: restartCount,
      auto_since_ms: autoSinceMs,
      auto_off_since_ms: autoOffSinceMs,
      control_applied_rev: incomingLaunch?.control?.rev ?? prev.control_applied_rev ?? null,
      remote_control: normalizeRemoteControl(prev.remote_control) ?? null,
      delivery_health: deliveryHealth,
      debug: debug,
      client_errors: clientErrors,
      client_max_parallel_tasks: Number.isFinite(Number(b.max_parallel_tasks))
        ? Math.max(0, Math.min(MAX_PARALLEL_TASKS, Math.floor(Number(b.max_parallel_tasks)))) : null,
      max_parallel_tasks: prev.max_parallel_tasks ?? null,
      sdk_version: clientVersion || null,
      sdk_latest: latestVersion || null,
      sdk_outdated: outdated,
      last_hb_ms: now,
      first_seen_ms: prev.first_seen_ms ?? now,
      hb_count: (prev.hb_count ?? 0) + 1,
      last_bucket: prev.last_bucket ?? 0,
    };
    await this.st.put(key, rec);

    // 旧客户端提醒：同一天同一版本只发一次，避免每个心跳刷屏。
    if (outdated) {
      const shown = clientVersion || "未上报版本";
      const day = new Date(now).toISOString().slice(0, 10);
      try {
        await this.append({
          project: b.project ?? this.projectName(),
          sender: "system", topic: "system", kind: "sdk_upgrade", to: b.agent_id,
          payload: {
            title: "客户端版本过旧：请升级 SDK",
            body: `检测到当前 agent SDK 为 ${shown}，服务端最新为 ${latestVersion}。` +
                  "请执行 /dl/install.sh 升级并重启；升级后心跳会自动上报新版本。",
            notice: true,
            agent_id: b.agent_id,
            current_version: clientVersion || null,
            latest_version: latestVersion,
            install_url: "/dl/install.sh",
          },
          max_per_min: 1000,
          dedupe_key: `sdk-upgrade:${b.agent_id}:${clientVersion || "unknown"}:${latestVersion}:${day}`,
        } as any);
      } catch (e) {
        console.warn("sdk upgrade reminder failed", b.project, b.agent_id, e);
      }
    }

    // 任务租约挂心跳：持有者活着就续，TTL = LEASE_TTL_S（默认 12h）
    const tasks = await this.st.list<Task>({ prefix: "task:" });
    for (const [k, t] of tasks) {
      if (t.owner === b.agent_id && t.state === "claimed") {
        await this.st.put(k, { ...t, lease_until: now + this.taskLeaseMs() });
      }
    }

    const bucket = Math.floor(now / 300_000);
    if (rec.last_bucket !== bucket) {
      rec.last_bucket = bucket;
      await this.st.put(key, rec);
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO hb_hist
         (project, agent_id, bucket, cpu_pct, mem_used_mb, mem_total_mb, disk_used_pct, work_state)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(
        b.project ?? "unknown", b.agent_id, bucket,
        b.load?.cpu_pct ?? null, b.load?.mem_used_mb ?? null, b.load?.mem_total_mb ?? null,
        b.load?.disk?.[0]?.used_pct ?? null, b.work?.state ?? null
      ).run().catch(() => {});   // 心跳不能因 D1 配额/抖动失败；DO 仍会续租
    }
    return json({
      ok: true,
      next_in_s: Math.max(15, Math.min(300, Number(rec.remote_control?.heartbeat_s ?? 60))),
      server_ms: now,
      launch_hash: rec.launch_hash ?? null,
      launch_required: launchRequired,
      control: rec.remote_control ? {
        rev: rec.remote_control.rev,
        auto_forward: rec.remote_control.auto_forward,
        debug: rec.remote_control.debug,
        heartbeat_s: rec.remote_control.heartbeat_s,
        updated_at: rec.remote_control.updated_at,
        updated_by: rec.remote_control.updated_by,
      } : null,
      ...(outdated ? {
        upgrade: {
          required: true,
          current: clientVersion || null,
          latest: latestVersion,
          install_url: "/dl/install.sh",
        },
      } : {}),
    });
  }

  // F1：任务创建入口（否则租约台账永远是死代码）
  private async createTask(b: any) {
    const id = String(b?.task_id ?? "").trim();
    const title = String(b?.title ?? "").trim();
    if (!id || !title) return json({ error: "task_id_and_title_required" }, 422);
    if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(id)) return json({ error: "bad_task_id" }, 422);
    const old = await this.st.get(`task:${id}`);
    if (old) return json({ error: "task_exists", task_id: id }, 409);
    const now = Date.now();
    const to = b.to === undefined || b.to === null || String(b.to).trim() === "" ? null : String(b.to).trim();
    const issueId = b.issue_id === undefined || b.issue_id === null || String(b.issue_id).trim() === ""
      ? null : String(b.issue_id).trim();
    if (issueId && !/^[A-Za-z0-9._:-]{1,128}$/.test(issueId)) return json({ error: "bad_issue_id" }, 422);
    const priority = clampPriority(b.priority);
    const deadlineAt = parseDeadlineAt(b.deadline_at);
    if (b.deadline_at !== undefined && b.deadline_at !== null && String(b.deadline_at).trim() !== ""
        && deadlineAt === null) return json({ error: "bad_deadline_at" }, 422);
    const maxRaw = b.max_attempts;
    const maxAttempts = maxRaw === undefined || maxRaw === null || String(maxRaw).trim() === ""
      ? DEFAULT_MAX_ATTEMPTS
      : Number.isFinite(Number(maxRaw))
        ? Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(Number(maxRaw))))
        : DEFAULT_MAX_ATTEMPTS;
    if (to) {
      const project = String(b.project ?? this.projectName());
      const active = await this.env.DB.prepare(
        `SELECT 1 FROM agents WHERE project = ? AND agent_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
      ).bind(project, to, now).first<any>().catch(() => null);
      if (!active) return json({ error: "target_not_found", to }, 422);
      // Issue 自助认领（sender=agent，enforce_agent_limit=true）走这里；管理员派单不传该标记，
      // 只由 Worker 在响应里提醒，不阻断管理员。
      if (b.enforce_agent_limit === true) {
        const load = await this.activeTaskLoad(to);
        if (load.active_tasks >= ACTIVE_TASK_LIMIT)
          return json({ error: "agent_task_limit_exceeded", active_tasks: load.active_tasks,
                        limit: ACTIVE_TASK_LIMIT, task_ids: load.task_ids,
                        hint: "先完成或释放部分任务，再认领新任务；定向任务不受这个上限限制。",
                        use: {
                          mine: { method: "GET", path: `/p/${project}/tasks?mine=1` },
                          release: { method: "POST", path: `/p/${project}/tasks/release`, required_scope: "tasks.release",
                                     body_template: { task_id: "<task_id>", state: "open", note: "<reason>" } },
                        } }, 409);
      }
    }
    const projectName = String(b.project ?? this.projectName());
    // 新建前先按优先级把已有队列补满空槽；否则新任务会插队到老任务前面。
    if (to) await this.promoteQueue(projectName, to);
    const t: any = { task_id: id, title, body: String(b.body ?? ""), state: "open",
                     project: projectName,
                     owner: null, lease_until: 0, created_at: now, updated_at: now,
                     created_by: b.sender ?? "admin", to, issue_id: issueId,
                     priority, deadline_at: deadlineAt, max_attempts: maxAttempts, attempts: 0,
                     last_error: null, next_retry_at: null, dead_letter: false,
                     dispatch_state: to ? "queued" : undefined, dispatch_count: 0 };
    await this.st.put(`task:${id}`, t);
    // 任务创建事件对所有任务都落库：时间线需要稳定起点；它不是工作指令，
    // 不进入任务队列，也不带 work_item。
    let createdSeq: number | undefined;
    try {
      createdSeq = await this.append({
        project: projectName, sender: String(b.sender ?? "admin"), topic: "task", kind: "created", to: "admin",
        payload: { task_id: id, title, body: String(b.body ?? ""), state: "open",
                   issue_id: issueId, work_item: false },
        dedupe_key: `task-created:${id}`,
      });
    } catch (e: any) {
      console.warn("task created event failed", id, e?.message ?? e);
    }
    // 定向任务先经过单飞队列：没有槽位时只登记排队，不往窗口/循环里发消息。
    // 公共池任务不排队，仍然按原逻辑广播，agent 自己 claim。
    const dispatch = to
      ? await this.dispatchTaskOrQueue(projectName, t)
      : { notified: false, max_parallel: 0 };
    const seq = dispatch.seq ?? createdSeq ?? null;
    // S5：指派事件至少落一条定向消息（节点 wait/run 下一次拉取即被唤醒）。
    // 离线节点仍收不到，管理台账用 to_online 明确标出，避免“已派单”造成在线错觉。
    const hb: any = to ? await this.st.get(`agent:${to}`).catch(() => null) : null;
    const targetAge = hb?.last_hb_ms ? now - Number(hb.last_hb_ms) : Infinity;
    return json({ task_id: id, state: "open", seq,
                  priority, deadline_at: deadlineAt, max_attempts: maxAttempts, attempts: 0,
                  dispatch_state: dispatch.dispatch_state ?? (to ? "queued" : "closed"),
                  queue_position: dispatch.queue_position ?? 0,
                  max_parallel_tasks: dispatch.max_parallel ?? 0,
                  wake: to ? { channel: "inbox", target: to,
                               online: targetAge <= 300_000,
                               alive: targetAge <= 120_000 ? "alive" : targetAge <= 300_000 ? "late" : "offline" } : null });
  }

  private async ack(b: any) {
    // 只能在「发给我的」或「广播」的消息上回执：否则任意 agent 可替别人完成任务
    let target: any = await this.st.get(msgKey(Number(b.seq)));
    if (!target && b.project) {
      // 热窗口外的老消息：从 D1 归档取（F2 之后 ack 不再因为窗口滚动而 404）
      const row = await this.env.DB.prepare(
        "SELECT seq, sender, to_agent FROM archive WHERE project = ? AND room = ? AND seq = ?"
      ).bind(b.project, await this.room(), Number(b.seq)).first<any>().catch(() => null);
      if (row) target = { seq: row.seq, sender: row.sender, to: row.to_agent ?? undefined };
    }
    if (!target) return json({ error: "unknown_seq" }, 404);
    if (target.to && !this.isToMe(target.to, b.agent_id)) return json({ error: "not_your_message" }, 403);
    // 先落回执消息再更新回执表：限流/大小校验失败时不会留下“表已写、消息没发”的脏状态
    const ackSeq = await this.append({ project: b.project, sender: b.agent_id, topic: "ack", kind: b.status,
                                       to: "admin",
                                       payload: { seq: b.seq, detail: b.detail ?? {} },
                                       ...(b.max_per_min ? { max_per_min: b.max_per_min } : {}),
                                       dedupe_key: `ack:${b.seq}:${b.agent_id}` });
    let box: any = await this.st.get(`ack:${b.seq}`);
    // 定向发给单个 agent 的任务没有广播回执表，补建一个空的，
    // 否则 agent 认真回执却收到 404（实测踩到）。
    if (!box) box = { required: false, pending: [], done: {}, deadline: null };
    box.pending = (box.pending as string[]).filter((x) => x !== b.agent_id);
    box.done = { ...box.done, [b.agent_id]: { status: b.status, detail: b.detail ?? {}, at: Date.now() } };
    await this.st.put(`ack:${b.seq}`, box);
    return json({ ok: true, seq: ackSeq });
  }

  private async report(b: any) {
    // payload 只保留 report 本身；不要把 Worker 注入的 project/agent_id/sender/
    // role/max_per_min 一起写进消息，否则会随 inbox/WS 暴露内部字段。
    const seq = await this.append({ project: b.project, sender: b.agent_id, topic: "report",
                                    kind: b.report_id ?? "report",
                                    to: "admin",
                                    payload: { report_id: b.report_id, task: b.task,
                                               resources: b.resources ?? {}, env: b.env ?? {} },
                                    ...(b.max_per_min ? { max_per_min: b.max_per_min } : {}),
                                    dedupe_key: `report:${b.report_id}:${b.agent_id}` });
    return json({ ok: true, seq });
  }

  // ── 任务租约：CPU 单线程，CAS 免费 ─────────────────────────
  private async claim(b: any) {
    const t: any = await this.st.get(`task:${b.task_id}`);
    const project = String(b.project ?? this.projectName());
    if (!t) return json({ error: "not_found", task_id: b.task_id,
      hint: "任务不存在或已被清理；先列自己的任务，不要用缓存里的旧 task_id。",
      use: { mine: { method: "GET", path: `/p/${project}/tasks?mine=1` } } }, 404);
    const now = Date.now();
    if (t.state === "failed" || t.dead_letter === true)
      return json({ error: "task_dead_letter", state: t.state, attempts: Number(t.attempts ?? 0),
                    max_attempts: Number(t.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
                    hint: "任务已进死信，节点不能自己 claim；让管理员在管理台重试/重派，或去领别的任务。",
                    use: { mine: { method: "GET", path: `/p/${project}/tasks?mine=1` } } }, 409);
    if (Number(t.next_retry_at ?? 0) > now)
      return json({ error: "task_retry_scheduled", task_id: t.task_id ?? t.id,
                    retry_in_ms: Number(t.next_retry_at) - now,
                    attempts: Number(t.attempts ?? 0),
                    hint: "失败退避中；到 retry_in_ms 后再 claim，不要立即重试刷接口。",
                    use: { claim: { method: "POST", path: `/p/${project}/tasks/claim`, body: { task_id: String(t.task_id ?? t.id) } } } }, 409);
    if (t.to && !this.isToMe(t.to, b.agent_id)) return json({ error: "not_your_task", task_id: t.task_id ?? t.id,
      hint: "这是别的节点的定向任务，claim 会被拒；用 tasks?mine=1 只看自己的任务。",
      use: { mine: { method: "GET", path: `/p/${project}/tasks?mine=1` } } }, 403);
    if (t.to && this.dispatchStateOf(t) === "queued")
      return json({ error: "task_not_dispatched", task_id: t.task_id ?? t.id,
                    queue_position: await this.queuePosition(String(t.to), String(t.task_id ?? t.id ?? "")),
                    hint: "定向任务还在该节点的派单队列，等前序任务释放后会自动下发；现在 claim 会被拒。",
                    use: { mine: { method: "GET", path: `/p/${project}/tasks?mine=1` } } }, 409);
    if (t.state === "claimed" && t.owner === b.agent_id && Number(t.lease_until ?? 0) > now)
      return json({ ok: true, task_id: String(t.task_id ?? t.id ?? b.task_id), lease_until: t.lease_until,
                    already: true, task: t, next: this.taskNext(String(b.project ?? t.project ?? this.projectName()),
                                                                 String(t.task_id ?? t.id ?? b.task_id)) });
    // 自领公共任务前检查名下已 claim 未完成任务；定向任务不受此限（管理员派单只提醒不拦截）。
    // 过期后重领自己原来的任务时，把该任务本身从计数里排除。
    if (!t.to && (t.state === "open" || (t.state === "claimed" && Number(t.lease_until ?? 0) < now))) {
      const load = await this.activeTaskLoad(b.agent_id, String(t.task_id ?? t.id ?? ""));
      if (load.active_tasks >= ACTIVE_TASK_LIMIT)
        return json({ error: "agent_task_limit_exceeded", active_tasks: load.active_tasks,
                      limit: ACTIVE_TASK_LIMIT, task_ids: load.task_ids,
                      retryable: false,
                      hint: "先完成或释放部分任务，再领取公共任务；不要换 task_id 反复试。",
                      use: {
                        mine: { method: "GET", path: `/p/${project}/tasks?mine=1` },
                        release: { method: "POST", path: `/p/${project}/tasks/release`, required_scope: "tasks.release",
                                   body_template: { task_id: "<task_id>", state: "open", note: "<reason>" } },
                      } }, 409);
    }
    // 非 open 状态按真实原因报错，不能一律说 locked：done/blocked/released 的
    // owner 与 lease_until 都是空值，旧实现会拼出“被锁定但 owner=null、租约 0”的
    // 假象，让节点以为任务被不存在的人占着（ISS-MWSSGUQ1-88BD71）。
    if (t.state === "done")
      return json({ error: "already_done", state: t.state,
        hint: "任务已完成，不能再次 claim；直接领下一个。",
        use: { claim_next: { method: "POST", path: `/p/${project}/tasks/claim-next`, required_scope: "tasks.claim" } } }, 409);
    if (t.state === "blocked")
      return json({ error: "blocked", state: t.state,
        hint: "任务被依赖/管理侧阻塞；等解除后由系统重新下发，或让管理员 reopen。",
        use: { mine: { method: "GET", path: `/p/${project}/tasks?mine=1` } } }, 409);
    if (t.state === "released") {
      // 误绑/错单自救：交付人 release 后仍可重新 claim 自己刚放下的任务，修正交付；
      // 仍待管理侧取件时不能把任务直接判 done，但也不该把 agent 永久锁在门外。
      const pendingNow = await this.pendingDeliveries(b.project ?? t.project ?? this.projectName(),
                                                      String(t.task_id ?? t.id ?? ""));
      if (!(t.released_by === b.agent_id && pendingNow > 0))
        return json({ error: "released_pending_collection", state: t.state,
                      pending_submissions: Number(t.pending_submissions ?? pendingNow),
                      released_by: t.released_by ?? null,
                      hint: "该任务已释放但还有待管理侧取走的交付；先等取件，或让管理员归档旧交付后再 claim。",
                      use: { mine: { method: "GET", path: `/p/${project}/tasks?mine=1` },
                             submissions: { method: "GET", path: `/p/${project}/submissions?mine=1` } } }, 409);
    }
    if (t.state !== "open" && t.state !== "released"
        && !(t.state === "claimed" && Number(t.lease_until ?? 0) < now))
      return json({ error: "locked", state: t.state, owner: t.owner, lease_until: t.lease_until,
        hint: "任务在别人名下且租约未过期；等 lease_until 到期后再 claim，或换下一个任务。",
        use: { claim_next: { method: "POST", path: `/p/${project}/tasks/claim-next`, required_scope: "tasks.claim" },
               mine: { method: "GET", path: `/p/${project}/tasks?mine=1` } } }, 409);
    const lease = now + this.taskLeaseMs();
    const claimedTask = { ...t, state: "claimed", owner: b.agent_id, released_by: null,
                   ...(t.to ? { dispatch_state: "active" } : {}),
                   ...(t.state === "claimed" ? {} : { claimed_at: now }),
                   lease_until: lease, updated_at: now };
    await this.st.put(`task:${b.task_id}`, claimedTask);
    await this.append({ project: b.project, sender: b.agent_id, topic: "task", kind: "claimed",
                        payload: { task_id: b.task_id, title: t.title ?? "", body: t.body ?? "",
                                   lease_until: lease, attempts: Number(t.attempts ?? 0),
                                   priority: clampPriority(t.priority),
                                   deadline_at: t.deadline_at ?? null },
                        dedupe_key: `claim:${b.task_id}:${b.agent_id}:${now}` });
    return json({ ok: true, task_id: b.task_id, lease_until: lease, task: claimedTask,
                  next: this.taskNext(String(b.project ?? t.project ?? this.projectName()),
                                       String(b.task_id)) });
  }

  /** claim/claim-next 的响应自带下一步，agent 不需要再背 endpoint。 */
  private taskNext(project: string, taskId: string) {
    return {
      task: { method: "GET", path: `/p/${project}/tasks/${encodeURIComponent(taskId)}` },
      submit: { method: "POST", path: `/p/${project}/submissions`, required_scope: "submissions.create",
                body_template: { task_id: taskId, base_sha: "<7-64 hex>", kind: "patch",
                                 title: "<title>", refs: [], checks: { tests: { passed: 0, failed: 0 } } } },
      release_done: { method: "POST", path: `/p/${project}/tasks/release`, required_scope: "tasks.release",
                      body: { task_id: taskId, state: "done" } },
      release_open: { method: "POST", path: `/p/${project}/tasks/release`, required_scope: "tasks.release",
                      body: { task_id: taskId, state: "open" } },
      claim_next: { method: "POST", path: `/p/${project}/tasks/claim-next`, required_scope: "tasks.claim" },
    };
  }

  /** 一次调用领取一个可执行任务：优先定向给本节点的，再取公共池；DO 单线程保证选择+claim 原子。 */
  private async claimNext(b: any) {
    const agentId = String(b?.agent_id ?? "").trim();
    if (!agentId) return json({ error: "agent_id_required",
      hint: "claim-next 必须带真实 agent_id；由 Worker 注入，节点不要自己伪造。" }, 422);
    const project = String(b?.project ?? this.projectName());
    const now = Date.now();
    const tasks = await this.listRawTasks();
    const taskIdOf = (t: any) => String(t?.task_id ?? t?.id ?? "");
    const candidate = tasks.filter((t: any) => {
      if (!t || !taskIdOf(t) || t.dead_letter === true) return false;
      if (!this.retryReady(t, now)) return false;
      const state = String(t.state ?? "");
      if (t.to === agentId) {
        if (state === "claimed" && t.owner === agentId) return true;
        if (state !== "open") return false;
        // queued 定向任务还没轮到本节点，不能提前 claim；notified/active 可以。
        return this.dispatchStateOf(t) !== "queued";
      }
      if (t.to) return false;                       // 别的节点的定向任务
      if (state === "open") return true;            // 公共池
      return state === "claimed" && Number(t.lease_until ?? 0) < now;
    });
    const directed = candidate.filter((t: any) => t.to === agentId)
      .sort((a: any, b: any) => this.compareQueue(a, b, now));
    const publicPool = candidate.filter((t: any) => !t.to)
      .sort((a: any, b: any) => this.compareQueue(a, b, now));
    let last: any = null;
    for (const t of [...directed, ...publicPool]) {
      const id = taskIdOf(t);
      const r = await this.claim({ ...b, project, agent_id: agentId, task_id: id });
      const d: any = await r.json().catch(() => ({ error: "claim_bad_payload" }));
      if (r.ok) return json(d, r.status);
      last = { status: r.status, body: d };
      // 配额已满时后面的公共任务也不会成功；定向任务已经先试过，直接返回。
      if (d?.error === "agent_task_limit_exceeded") return json(d, r.status);
      // 已被别人拿走/状态变化：继续试下一个；权限/死信等错误直接返回。
      if (!["not_your_task", "task_not_dispatched", "locked", "not_found", "already_done", "blocked",
            "released_pending_collection"].includes(String(d?.error ?? "")))
        return json(d, r.status);
    }
    return json({
      error: "no_task_available",
      hint: "当前没有你已收到或可领取的任务。先 GET /p/{project}/tasks?mine=1 检查；公共池用 GET /p/{project}/tasks；若任务还在 queued，等它下发。",
      use: {
        mine: { method: "GET", path: `/p/${project}/tasks?mine=1` },
        public_pool: { method: "GET", path: `/p/${project}/tasks` },
        inbox: { method: "GET", path: `/p/${project}/inbox?since=0` },
      },
      ...(last ? { last_error: last.body, last_status: last.status } : {}),
    }, 404);
  }

  /** 该任务还有多少件交付没被管理侧取走（state = delivered）。真源在 D1 submissions。 */
  private async pendingDeliveries(project: string, taskId: string): Promise<number> {
    if (!project) return 0;
    const row = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE project = ? AND task_id = ? AND state = 'delivered'"
    ).bind(project, taskId).first<any>();
    return Number(row?.n ?? 0);
  }

  /** S4：待裁决 = 已收下但尚未 approved 的交付；rejected 不再等待。 */
  private async pendingReview(project: string, taskId: string): Promise<number> {
    if (!project) return 0;
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submissions
        WHERE project = ? AND task_id = ? AND state != 'archived'
          AND review_state IN ('pending', 'accepted')`
    ).bind(project, taskId).first<any>().catch(() => ({ n: 0 }));
    return Number(row?.n ?? 0);
  }

  /** 报告类没有 approved 不许关单；代码类取走后可按已验收处理。 */
  private async unapprovedReports(project: string, taskId: string): Promise<number> {
    if (!project) return 0;
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submissions
        WHERE project = ? AND task_id = ? AND kind = 'report'
          AND state != 'archived' AND review_state != 'approved'`
    ).bind(project, taskId).first<any>().catch(() => ({ n: 0 }));
    return Number(row?.n ?? 0);
  }

  /**
   * issue → task 的反向联动：任务真正 done 时自动关闭源 issue。
   * 只关闭仍为 open 的 issue，不覆盖人工关闭/合并；D1 失败不能影响任务结算。
   */
  private async closeIssueForTask(t: any) {
    const project = String(t?.project ?? this.projectName());
    const taskId = String(t?.task_id ?? t?.id ?? "");
    if (!taskId) return;
    const issueId = t?.issue_id;
    const now = Date.now();
    // S3：先按任务记录里的 issue_id 关；再按 issues.task_id 兜底补关。
    // release 后交付/旧数据缺 issue_id 时，不能漏关同一任务派出的 issue。
    let changed = 0;
    if (issueId) {
      const r: any = await this.env.DB.prepare(
        `UPDATE issues SET status = 'closed', closed_at = ?, closed_by = 'task',
           close_reason = ?, updated_at = ?
         WHERE project = ? AND issue_id = ? AND status = 'open'`
      ).bind(now, `task_done:${taskId}`, now, project, issueId).run()
        .catch((e: any) => { console.warn("issue auto-close failed", issueId, e); return { meta: { changes: 0 } }; });
      changed += Number(r?.meta?.changes ?? 0);
    }
    const fallback: any = await this.env.DB.prepare(
      `UPDATE issues SET status = 'closed', closed_at = ?, closed_by = 'task',
         close_reason = ?, updated_at = ?
       WHERE project = ? AND task_id = ? AND status = 'open'`
    ).bind(now, `task_done:${taskId}`, now, project, taskId).run()
      .catch((e: any) => { console.warn("issue fallback auto-close failed", taskId, e); return { meta: { changes: 0 } }; });
    changed += Number(fallback?.meta?.changes ?? 0);
    if (!changed) return;
    const rows = await this.env.DB.prepare(
      `SELECT issue_id FROM issues WHERE project = ? AND (task_id = ? OR issue_id = ?)
         AND status = 'closed' AND closed_by = 'task' AND closed_at = ?`
    ).bind(project, taskId, String(issueId ?? ""), now).all<any>().catch(() => ({ results: [] }));
    for (const row of (rows.results ?? [])) {
      await this.append({
        project, sender: "system", topic: "issue", kind: "closed",
        payload: { issue_id: String(row.issue_id), task_id: taskId, status: "closed",
                   closed_by: "task", closed_at: now, message: `任务 ${taskId} 完成，issue 自动关闭` },
        dedupe_key: `issue-close:${row.issue_id}:${taskId}`,
      }).catch(() => {});
    }
  }

  /** 任务因交付被拒而重新打开时，把同一任务自动关闭的 issue 也恢复为 open。 */
  private async reopenIssueForTask(t: any) {
    const project = String(t?.project ?? this.projectName());
    const taskId = String(t?.task_id ?? t?.id ?? "");
    if (!taskId) return;
    const now = Date.now();
    const issueId = String(t?.issue_id ?? "");
    const r: any = await this.env.DB.prepare(
      `UPDATE issues SET status = 'open', closed_at = NULL, closed_by = NULL,
         close_reason = NULL, updated_at = ?
       WHERE project = ? AND (task_id = ? OR issue_id = ?) AND status = 'closed' AND closed_by = 'task'`
    ).bind(now, project, taskId, issueId).run()
      .catch((e: any) => { console.warn("issue auto-reopen failed", taskId, e); return { meta: { changes: 0 } }; });
    if (!Number(r?.meta?.changes ?? 0)) return;
    const rows = await this.env.DB.prepare(
      `SELECT issue_id FROM issues WHERE project = ? AND (task_id = ? OR issue_id = ?)
         AND status = 'open' AND updated_at = ?`
    ).bind(project, taskId, issueId, now).all<any>().catch(() => ({ results: [] }));
    for (const row of (rows.results ?? [])) {
      await this.append({
        project, sender: "system", topic: "issue", kind: "reopened",
        payload: { issue_id: String(row.issue_id), task_id: taskId, status: "open",
                   reopened_by: "review", message: `任务 ${taskId} 重新打开，issue 恢复` },
        dedupe_key: `issue-reopen:${row.issue_id}:${taskId}:${now}`,
      }).catch(() => {});
    }
  }

  private async release(b: any) {
    const t: any = await this.st.get(`task:${b.task_id}`);
    if (!t) return json({ error: "not_found" }, 404);
    if (t.owner !== b.agent_id) return json({ error: "not_owner" }, 403);
    const want = b.state ?? "done";
    if (!["done", "open", "blocked"].includes(want))
      return json({ error: "bad_release_state", allowed: ["done", "open", "blocked"] }, 422);
    if (t.state === want && !t.owner && t.released_by === b.agent_id)
      return json({ ok: true, state: t.state, pending_submissions: t.pending_submissions ?? 0, already: true });
    let state = want;
    // 所有出口都重算待取数；state=open/blocked 也要保留真实 pending，
    // 否则 agent 放弃/阻塞后管理台会把“还有交付待取”误显示成 0。
    const project = b.project ?? t.project ?? "";
    const pending = await this.pendingDeliveries(project, b.task_id);
    const pendingReview = await this.pendingReview(project, b.task_id);
    // 联动：目标是 done 时先看交付——还有没取走的，任务只进 released（已交付待取），
    // 不许直接 done。最后一件被取走时由 submissionSettled 收成 done。
    if (want === "done" && pending > 0) state = "released";
    const now = Date.now();
    const patch: any = { state, owner: null, lease_until: 0, pending_submissions: pending,
                         pending_review: pendingReview,
                         updated_at: now, released_by: b.agent_id,
                         next_retry_at: null,
                         ...(t.to ? { dispatch_state: "closed" } : {}) };
    if (state === "done") { patch.closed_at = now; patch.closed_by = "agent"; }
    if (state === "blocked") { patch.blocked_at = now; }
    const next = { ...t, ...patch };
    await this.st.put(`task:${b.task_id}`, next);
    if (state === "done") await this.closeIssueForTask(next);
    await this.append({ project: b.project, sender: b.agent_id, topic: "task", kind: state,
                        to: b.agent_id,
                        payload: { task_id: b.task_id, title: t.title ?? "", body: t.body ?? "",
                                   pending_submissions: pending,
                                   ...(state === "open" ? { abandoned_by: b.agent_id } : {}) },
                        dedupe_key: `release:${b.task_id}:${Date.now()}` });
    const promoted = await this.promoteQueue(project, t.to);
    return json({ ok: true, state, pending_submissions: pending, promoted });
  }

  /**
   * 管理侧取走/归档一件交付后由 Worker 回调：重算待取数。
   * S1：claimed/released 且最后一件取走、无待批报告 → 直接 done；
   * S4：report 必须 approved 才允许关单；accepted 只是“收走待裁决”。
   */
  private async submissionSettled(b: any) {
    const t: any = await this.st.get(`task:${b.task_id}`);
    if (!t) return json({ error: "not_found" }, 404);
    const project = b.project ?? t.project ?? "";
    const pending = await this.pendingDeliveries(project, b.task_id);
    const pendingReview = await this.pendingReview(project, b.task_id);
    const unapproved = await this.unapprovedReports(project, b.task_id);
    let state = t.state;
    // 交付被本人撤回：任务回到 open，让错绑/错单的 agent 能重新 claim 修正；
    // 不能走默认 canClose 分支把 released 直接收成 done，否则撤回反而关单。
    if (b.reopen_on_withdraw === true) {
      const now = Date.now();
      const reopened = { ...t, state: "open", owner: null, lease_until: 0,
        pending_submissions: pending, pending_review: pendingReview, updated_at: now,
        closed_at: null, closed_by: null, reopened_at: now, reopened_by: "submission_withdraw",
        ...(t.to ? { dispatch_state: "queued" } : {}) };
      await this.st.put(`task:${b.task_id}`, reopened);
      await this.reopenIssueForTask(reopened);
      await this.append({ project, sender: b.sender ?? "system", topic: "task", kind: "open",
                          to: t.released_by ?? t.to ?? undefined,
                          payload: { task_id: b.task_id, reopened_by: "submission_withdraw",
                                     reason: "delivery_withdrawn" },
                          dedupe_key: `withdraw-reopen:${b.task_id}:${now}` });
      const promoted = await this.promoteQueue(project, t.to);
      return json({ ok: true, task_id: b.task_id, state: "open", pending_submissions: pending,
                    pending_review: pendingReview, unapproved_reports: unapproved, promoted });
    }
    // 已结任务被明确 rejected：重新打开，绝不让拒收留在 done。
    if (b.reopen_on_reject === true && t.state === "done") {
      state = "open";
      const reopened = { ...t, state, owner: null, lease_until: 0,
        pending_submissions: pending, pending_review: pendingReview, updated_at: Date.now(),
        closed_at: null, closed_by: null, reopened_at: Date.now(), reopened_by: "review",
        ...(t.to ? { dispatch_state: "queued" } : {}) };
      await this.st.put(`task:${b.task_id}`, reopened);
      await this.reopenIssueForTask(reopened);
      await this.append({ project, sender: b.sender ?? "admin", topic: "task", kind: "open",
                          to: t.to ?? undefined,
                          payload: { task_id: b.task_id, reopened_by: "review", reason: "delivery_rejected" },
                          dedupe_key: `reopen:${b.task_id}:${Date.now()}` });
      const promoted = await this.promoteQueue(project, t.to);
      return json({ ok: true, task_id: b.task_id, state, pending_submissions: pending,
                    pending_review: pendingReview, unapproved_reports: unapproved, promoted });
    }
    const canClose = pending === 0 && unapproved === 0
      && (t.state === "claimed" || t.state === "released");
    if (canClose) {
      state = "done";
      const now = Date.now();
      const closed = { ...t, state, owner: null, lease_until: 0,
                       pending_submissions: 0, pending_review: pendingReview,
                       updated_at: now, closed_at: now,
                       ...(t.to ? { dispatch_state: "closed" } : {}),
                       closed_by: b.closed_by === "approval" ? "approval" : "collection" };
      await this.st.put(`task:${b.task_id}`, closed);
      await this.closeIssueForTask(closed);
      await this.append({ project, sender: b.sender ?? "admin", topic: "task", kind: "done",
                          to: t.owner ?? t.to ?? undefined,
                          payload: { task_id: b.task_id, title: t.title ?? "", body: t.body ?? "",
                                     closed_by: b.closed_by === "approval" ? "approval" : "collection",
                                     pending_review: pendingReview },
                          dedupe_key: `close:${b.task_id}` });
      await this.promoteQueue(project, t.to);
    } else {
      await this.st.put(`task:${b.task_id}`, { ...t, pending_submissions: pending,
                                               pending_review: pendingReview, updated_at: Date.now() });
    }
    return json({ ok: true, task_id: b.task_id, state, pending_submissions: pending,
                  pending_review: pendingReview, unapproved_reports: unapproved });
  }

  /**
   * 执行失败入口。调用者必须是当前 owner；失败次数达到 max_attempts 后进死信，
   * 否则按指数退避设置 next_retry_at，释放并发槽位并让其它排队任务先跑。
   */
  private async failTask(b: any) {
    const id = this.taskIdOf(b);
    if (!id) return json({ error: "task_id_required" }, 422);
    const t: any = await this.st.get(`task:${id}`);
    if (!t) return json({ error: "not_found", task_id: id }, 404);
    if (t.owner !== b.agent_id) return json({ error: "not_owner", owner: t.owner ?? null }, 403);
    if (t.state !== "claimed") return json({ error: "task_not_claimed", state: t.state }, 409);
    const project = String(b.project ?? t.project ?? this.projectName());
    const pending = await this.pendingDeliveries(project, id);
    if (pending > 0) return json({ error: "has_pending_deliveries", pending }, 409);
    const now = Date.now();
    const attempts = Number(t.attempts ?? 0) + 1;
    const maxAttempts = Number.isFinite(Number(t.max_attempts))
      ? Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(Number(t.max_attempts))))
      : DEFAULT_MAX_ATTEMPTS;
    const retryable = b.retryable !== false && attempts < maxAttempts;
    const error = String(b.error ?? b.message ?? "task_failed").trim().slice(0, 500);
    const dead = !retryable;
    const nextRetryAt = dead ? null
      : now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)));
    const patch: any = {
      state: dead ? "failed" : "open",
      owner: null, lease_until: 0, updated_at: now,
      attempts, last_error: error, last_failed_at: now,
      next_retry_at: nextRetryAt,
      dead_letter: dead,
      ...(dead ? { dead_lettered_at: now } : {}),
      ...(t.to ? { dispatch_state: dead ? "closed" : "queued" } : { dispatch_state: "closed" }),
    };
    const next = { ...t, ...patch };
    await this.st.put(`task:${id}`, next);
    const copy = dead
      ? `任务失败 ${attempts}/${maxAttempts} 次，已进入死信；管理端重试后可再次下发。`
      : `任务失败 ${attempts}/${maxAttempts} 次，将在 ${Math.max(1, Math.round((nextRetryAt! - now) / 1000))}s 后重试。`;
    await this.append({
      project, sender: b.agent_id, topic: "task", kind: "failed",
      to: t.owner ?? t.to ?? "admin",
      payload: { task_id: id, title: t.title ?? "", body: t.body ?? "",
                 work_item: false, attempts, max_attempts: maxAttempts,
                 error, retryable, dead_letter: dead, next_retry_at: nextRetryAt,
                 message: copy },
      dedupe_key: `task-fail:${id}:${attempts}:${now}`,
    });
    if (dead) {
      await this.append({
        project, sender: b.agent_id, topic: "task", kind: "dead_lettered",
        to: t.owner ?? t.to ?? "admin",
        payload: { task_id: id, title: t.title ?? "", work_item: false,
                   attempts, max_attempts: maxAttempts, error,
                   message: "任务已进入死信，管理端重试后可再次下发。" },
        dedupe_key: `task-dead-lettered:${id}:${attempts}:${now}`,
      });
    }
    if (nextRetryAt) {
      await this.append({
        project, sender: "agent", topic: "task", kind: "retry_scheduled",
        to: t.owner ?? t.to ?? "admin",
        payload: { task_id: id, title: t.title ?? "", work_item: false,
                   attempts, max_attempts: maxAttempts, retry_at: nextRetryAt,
                   retry_in_ms: Math.max(0, nextRetryAt - now),
                   message: copy },
        dedupe_key: `task-retry-scheduled:${id}:${attempts}:${now}`,
      });
    }
    if (nextRetryAt) await this.setAlarmAt(nextRetryAt);
    // 失败释放了一个并发槽位：先让队列里的其它任务补位，失败任务等退避时间到再参与。
    const promoted = await this.promoteQueue(project, t.to);
    return json({ ok: true, task_id: id, state: next.state, attempts, max_attempts: maxAttempts,
                  retry_at: nextRetryAt, retry_in_ms: nextRetryAt ? Math.max(0, nextRetryAt - now) : null,
                  dead_letter: dead, promoted, message: copy });
  }

  /** 管理端手动重试死信/阻塞任务：清空本轮失败计数，重新入优先级队列。 */
  private async adminRetry(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    if (!["failed", "blocked"].includes(String(t.state)) && t.dead_letter !== true)
      return json({ error: "task_not_retryable", state: t.state,
                    hint: "只有 failed（死信）或 blocked 任务需要手动重试" }, 409);
    const now = Date.now();
    const task = {
      ...t, state: "open", owner: null, lease_until: 0,
      attempts: 0, next_retry_at: null, dead_letter: false,
      manual_retries: Number(t.manual_retries ?? 0) + 1,
      last_error: t.last_error ?? null, retried_at: now, updated_at: now,
      ...(t.to ? { dispatch_state: "queued" } : { dispatch_state: "closed" }),
    };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    const reason = this.adminReason(b) || "管理员手动重试";
    await this.append({
      project, sender: "admin", topic: "task", kind: "retried",
      to: t.owner ?? t.to ?? "admin",
      payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                 work_item: false, manual: true, reason,
                 manual_retries: task.manual_retries, prev_state: t.state },
      dedupe_key: `task-retry:${t.task_id ?? t.id}:${now}`,
    });
    // 定向任务重新参与优先级队列；公共池任务只需恢复 open，等待 agent 自领。
    const promoted = t.to ? await this.promoteQueue(project, String(t.to)) : [];
    return json({ ok: true, task_id: t.task_id ?? t.id, state: "open",
                  dispatch_state: task.dispatch_state, promoted,
                  manual_retries: task.manual_retries });
  }


  /** S1：合入回写。任务进入 READY/done 后由管理端或 CI 记录最终合入提交。 */
  private async adminMerge(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    const sha = String(b.merged_sha ?? b.sha ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{7,64}$/.test(sha))
      return json({ error: "bad_merged_sha", hint: "merged_sha 需要 7–64 位十六进制提交号" }, 422);
    if (t.state === "failed" || t.dead_letter === true)
      return json({ error: "task_not_mergeable", state: t.state,
                    hint: "死信任务先重试成功，再回写合入" }, 409);
    const now = Date.now();
    const task = {
      ...t, merged_sha: sha, merged_at: now, merged_by: "admin",
      merged_branch: String(b.branch ?? b.merged_branch ?? "").trim().slice(0, 120) || null,
      merge_note: String(b.note ?? "").trim().slice(0, 500) || null,
      updated_at: now,
    };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    await this.append({
      project, sender: "admin", topic: "task", kind: "merged",
      to: t.owner ?? t.to ?? "admin",
      payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                 work_item: false, merged_sha: sha, merged_at: now,
                 merged_branch: task.merged_branch, note: task.merge_note,
                 message: `已合入 ${sha.slice(0, 12)}` },
      dedupe_key: `task-merged:${t.task_id ?? t.id}:${sha}`,
    });
    return json({ ok: true, task_id: t.task_id ?? t.id, state: t.state,
                  merged_sha: sha, merged_at: now, merged_branch: task.merged_branch });
  }

  /** S5：把长期排队/目标离线的定向任务退回公共池，管理台可人工改派。 */
  private async adminRequeue(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    if (t.state !== "open" || !t.to)
      return json({ error: "task_not_requeueable", state: t.state,
                    hint: "只有定向且仍处于 open 的排队任务可以退回公共池" }, 409);
    const now = Date.now();
    const from = String(t.to);
    const task = {
      ...t, to: null, owner: null, lease_until: 0,
      dispatch_state: "closed", requeued_at: now, requeued_from: from,
      reassigned_from: from, reassigned_at: now, updated_at: now,
    };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    await this.append({
      project, sender: "admin", topic: "task", kind: "requeued",
      to: from,
      payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                 work_item: false, from, requeued_to: "public",
                 reason: this.adminReason(b) || "排队超时/目标离线，退回公共池",
                 message: "任务已退回公共池，原定向节点不再收到该任务；请重新认领或由管理端改派。" },
      dedupe_key: `task-requeued:${t.task_id ?? t.id}:${now}`,
    });
    return json({ ok: true, task_id: t.task_id ?? t.id, state: "open",
                  dispatch_state: "closed", requeued_from: from, requeued_to: "public" });
  }


  private async getTask(b: any) {
    const id = this.taskIdOf(b);
    if (!id) return json({ error: "task_id_required" }, 422);
    const t: any = await this.st.get(`task:${id}`);
    if (!t) return json({ error: "not_found", task_id: id }, 404);
    return json({
      task_id: t.task_id ?? t.id,
      state: t.state,
      owner: t.owner ?? null,
      to: t.to ?? null,
      project: t.project ?? this.projectName(),
      dispatch_state: this.dispatchStateOf(t),
      dispatch_count: Number(t.dispatch_count ?? 0),
      notified_at: Number(t.notified_at ?? 0) || null,
    });
  }

  /** 配额只统计“已 claim 到自己”的 claimed 任务。
   * 未 claim 的 open 定向单只是待办提示，不占坑；blocked 是“干不了/已退还”，
   * 同样不占坑，否则节点会被自己的阻塞单永久锁死（ISS-MWUA0IR3-B2C294）。
   * released（已交付待管理侧取件）和 done 也不再占用名额。 */
  private async activeTaskLoad(agentId: string, excludeTaskId = ""): Promise<{ active_tasks: number; task_ids: string[] }> {
    const rows = await this.st.list<any>({ prefix: "task:" });
    const ids: string[] = [];
    for (const t of rows.values()) {
      if (!t || t.state !== "claimed" || t.owner !== agentId) continue;
      if (excludeTaskId && String(t.task_id ?? t.id ?? "") === excludeTaskId) continue;
      ids.push(String(t.task_id ?? t.id ?? ""));
    }
    return { active_tasks: ids.length, task_ids: ids.filter(Boolean).slice(0, 20) };
  }

  private async activeLoad(b: any) {
    const agentId = String(b?.agent_id ?? "").trim();
    if (!agentId) return json({ error: "agent_id_required" }, 422);
    return json({ agent_id: agentId, ...(await this.activeTaskLoad(agentId)) });
  }

  private async listTasks() {
    const r = await this.st.list<Task>({ prefix: "task:" });
    const now = Date.now();
    const agents = new Map<string, any>();
    for (const a of (await this.st.list<any>({ prefix: "agent:" })).values()) agents.set(a.agent_id, a);
    // 队列位置只对当前可调度的 queued 定向任务有意义；按优先级/截止/老化排序。
    const queuedBy = new Map<string, any[]>();
    for (const t of r.values()) {
      const anyT: any = t;
      if (!anyT.to || anyT.state !== "open" || this.dispatchStateOf(anyT) !== "queued"
          || !this.retryReady(anyT, now)) continue;
      const list = queuedBy.get(String(anyT.to)) ?? [];
      list.push(anyT);
      queuedBy.set(String(anyT.to), list);
    }
    const queuePos = new Map<string, number>();
    for (const [to, list] of queuedBy) {
      list.sort((a: any, b: any) => this.compareQueue(a, b, now));
      list.forEach((t: any, i: number) => queuePos.set(String(t.task_id ?? t.id ?? ""), i + 1));
    }
    const tasks = [...r.values()].map((t: any) => {
      const ownerAge = t.owner ? now - Number(agents.get(t.owner)?.last_hb_ms ?? 0) : Infinity;
      const toAge = t.to ? now - Number(agents.get(t.to)?.last_hb_ms ?? 0) : Infinity;
      const deadlineAt = Number(t.deadline_at ?? 0) || null;
      return {
        ...t,
        priority: clampPriority(t.priority),
        effective_priority: this.effectivePriority(t, now),
        deadline_at: deadlineAt,
        deadline_left_ms: deadlineAt ? deadlineAt - now : null,
        sla_breached: !!deadlineAt && deadlineAt <= now
          && !["done", "failed"].includes(String(t.state)),
        attempts: Number(t.attempts ?? 0),
        max_attempts: Number(t.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
        retry_in_ms: t.next_retry_at ? Math.max(0, Number(t.next_retry_at) - now) : null,
        dispatch_state: this.dispatchStateOf(t),
        queue_position: queuePos.get(String(t.task_id ?? t.id ?? "")) ?? 0,
        lease_left_ms: Math.max(0, Number(t.lease_until ?? 0) - now),
        owner_online: t.owner ? ownerAge <= 300_000 : null,
        owner_alive: t.owner ? (ownerAge <= 120_000 ? "alive" : ownerAge <= 300_000 ? "late" : "offline") : null,
        // S5：定向任务在 claim 之前也要看见目标节点在线状态，否则只能等它出现。
        to_online: !t.owner && t.to ? toAge <= 300_000 : null,
        to_alive: !t.owner && t.to ? (toAge <= 120_000 ? "alive" : toAge <= 300_000 ? "late" : "offline") : null,
        pending_review: Number(t.pending_review ?? 0),
      };
    });
    const rank = (s: string) => s === "claimed" ? 0 : s === "open" ? 1 : s === "released" ? 2
      : s === "blocked" ? 3 : s === "failed" ? 4 : 5;
    tasks.sort((a: any, b: any) => rank(a.state) - rank(b.state)
      || Number(b.updated_at ?? b.created_at ?? 0) - Number(a.updated_at ?? a.created_at ?? 0));
    return json({ tasks });
  }

  private adminReason(b: any): string {
    return String(b?.reason ?? "").trim().slice(0, 240);
  }

  /** 任务是否仍处于有效 claim 租约内；DO 单线程，检查与写入之间不会被并发穿插。 */
  private activeLease(t: any, now = Date.now()): boolean {
    return t?.state === "claimed" && !!t.owner && Number(t.lease_until ?? 0) > now;
  }

  /** 管理侧要覆盖有效租约时的统一拒绝体：先让 owner 释放/等到期，或显式 force。 */
  private leaseConflict(t: any, op: string): Response {
    const now = Date.now();
    return json({
      error: "task_active_lease",
      task_id: t.task_id ?? t.id,
      state: t.state,
      owner: t.owner ?? null,
      lease_until: Number(t.lease_until ?? 0),
      lease_left_ms: Math.max(0, Number(t.lease_until ?? 0) - now),
      hint: `任务仍在 ${t.owner} 的有效租约内；先让 owner release 或等租约到期，确认要覆盖时传 force:true 强制${op}`,
    }, 409);
  }

  /** 强制换人/取回时定向通知旧 owner 停止工作（best-effort，不阻断管理动作）。 */
  private async notifyLeaseEvicted(project: string, t: any, to: string | null,
                                   reason: string, forced: boolean, kind: string) {
    const prev = t?.owner;
    if (!prev || prev === to) return;
    const id = String(t.task_id ?? t.id ?? "");
    try {
      await this.append({
        project, sender: "admin", topic: "task", kind, to: prev,
        payload: {
          task_id: id, title: t.title ?? "", body: "",
          to, reason, forced,
          message: "任务所有权已被管理侧收回，请立即停止该任务的修改与提交，避免交付被判越权。",
        },
        dedupe_key: `${kind}:${id}:${prev}:${Date.now()}`,
      });
    } catch (e: any) {
      console.warn(`${kind} notify failed`, id, e?.message ?? e);
    }
  }

  private taskIdOf(b: any): string | null {
    const id = String(b?.task_id ?? "").trim();
    return id || null;
  }

  private async loadTaskForAdmin(b: any): Promise<{ t: any; project: string } | Response> {
    if (b?.sender !== "admin") return json({ error: "admin_only" }, 403);
    const id = this.taskIdOf(b);
    if (!id) return json({ error: "task_id_required" }, 422);
    const t: any = await this.st.get(`task:${id}`);
    if (!t) return json({ error: "not_found", task_id: id }, 404);
    return { t, project: String(b.project ?? t.project ?? this.projectName()) };
  }

  private async adminClose(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    if (t.state === "done") return json({ ok: true, task: t, already: true });
    const now = Date.now();
    const reason = this.adminReason(b);
    const pending = await this.pendingDeliveries(project, t.task_id ?? t.id);
    const task = { ...t, state: "done", owner: null, lease_until: 0,
                   pending_submissions: pending, updated_at: now,
                   ...(t.to ? { dispatch_state: "closed" } : {}),
                   closed_at: now, closed_by: "admin" };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    await this.closeIssueForTask(task);
    await this.append({ project, sender: "admin", topic: "task", kind: "done",
                        to: t.owner ?? t.to ?? undefined,
                        payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                                   closed_by: "admin", pending_submissions: pending,
                                   prev_state: t.state, reason },
                        dedupe_key: `admin-close:${t.task_id ?? t.id}:${now}` });
    const promoted = await this.promoteQueue(project, t.to);
    return json({ ok: true, task, promoted });
  }

  private async adminReclaim(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    if (t.state === "done") return json({ error: "task_done", task_id: t.task_id ?? t.id }, 409);
    const now = Date.now();
    const forced = b?.force === true;
    // 互斥/租约保护：claim 仍在有效期内时，管理侧不能静默把任务抽回公共池。
    // DO 是单线程，activeLease 检查与后面的 put 之间不会被其他 claim 穿插。
    if (this.activeLease(t, now) && !forced) return this.leaseConflict(t, "取回");
    const reason = this.adminReason(b);
    const prevOwner = t.owner ?? null;
    const prevTo = t.to ?? null;
    const pending = await this.pendingDeliveries(project, t.task_id ?? t.id);
    const task = { ...t, state: "open", owner: null, lease_until: 0, to: null,
                   pending_submissions: pending, updated_at: now, reclaimed_at: now,
                   reclaimed_from: prevOwner, forced_reclaim: forced,
                   ...(prevTo ? { dispatch_state: "closed" } : {}) };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    if (prevOwner) await this.notifyLeaseEvicted(project, t, null, reason, forced, "reclaimed_away");
    await this.append({ project, sender: "admin", topic: "task", kind: "reclaimed",
                        to: prevOwner ?? prevTo ?? undefined,
                        payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                                   prev_state: t.state, prev_owner: prevOwner,
                                   prev_to: t.to ?? null, reason, forced },
                        dedupe_key: `admin-reclaim:${t.task_id ?? t.id}:${now}` });
    const promoted = await this.promoteQueue(project, prevTo);
    return json({ ok: true, task, promoted });
  }

  private async adminReassign(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    if (t.state === "done") return json({ error: "task_done", task_id: t.task_id ?? t.id }, 409);
    const to = String(b.to ?? "").trim();
    if (!to) return json({ error: "assignee_required" }, 422);
    const now = Date.now();
    // 同人转派是 no-op，不能把正在 claimed 的任务重置成 open，否则等于静默丢锁。
    // 但只有任务确实已在目标队列/在途时才 no-op：blocked/released、以及 agent
    // release(open) 后 dispatch_state=closed 的任务仍保留 to，必须允许重新派给同一人，
    // 否则“阻塞/放弃 → 转派给原节点”会被误判成 already，任务永久卡住。
    const ds = this.dispatchStateOf(t);
    const sameLane = t.to === to
      && (t.state === "claimed" ? t.owner === to : ["queued", "notified", "active"].includes(ds));
    if (sameLane)
      return json({ ok: true, task: t, already: true, brief_embedded: true });
    const forced = b?.force === true;
    // 互斥/租约保护：有效 claim 期间默认拒绝转派，避免正在做工的人被中途换掉。
    if (this.activeLease(t, now) && !forced) return this.leaseConflict(t, "转派");
    const agent = await this.env.DB.prepare(
      `SELECT agent_id FROM agents WHERE project = ? AND agent_id = ?
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
    ).bind(project, to, now).first<any>();
    if (!agent) return json({ error: "assignee_not_found", agent_id: to }, 422);
    const reason = this.adminReason(b);
    const prevOwner = t.owner ?? null;
    const prevTo = t.to ?? null;
    const pending = await this.pendingDeliveries(project, t.task_id ?? t.id);
    const task = { ...t, state: "open", owner: null, lease_until: 0, to,
                   pending_submissions: pending, updated_at: now,
                   reassigned_at: now, reassigned_from: prevOwner ?? prevTo,
                   forced_reassign: forced, dispatch_state: "queued" };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    if (prevOwner) await this.notifyLeaseEvicted(project, t, to, reason, forced, "reassigned_away");
    // 任务可能已下发但还没 claim（没有 owner）；旧窗口仍持有 active，需要一条
    // 生命周期消息让它释放本地 task 锁，否则下一条会被自己的 dispatcher 挡住。
    if (!prevOwner && prevTo && prevTo !== to) {
      await this.append({ project, sender: "admin", topic: "task", kind: "reassigned_away", to: prevTo,
                          payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", to,
                                     reason, forced, message: "任务已转派，请停止当前任务的修改与提交。" },
                          dedupe_key: `reassigned-away:${t.task_id ?? t.id}:${prevTo}:${now}` });
    }
    // 先释放旧目标的槽位，再按新目标的并发上限决定“立即下发”还是“排队”。
    const promoted = await this.promoteQueue(project, prevTo);
    const dispatched = await this.dispatchTaskOrQueue(project, task,
      { reassigned: true, to, prev_state: t.state, prev_owner: prevOwner,
        prev_to: prevTo, reason, forced });
    const stored: any = await this.st.get(`task:${t.task_id ?? t.id}`);
    return json({ ok: true, task: stored ?? task,
                  brief_embedded: true,
                  dispatch_state: dispatched.dispatch_state ?? "queued",
                  queue_position: dispatched.queue_position ?? 0,
                  promoted });
  }

  // ── 广播：一条消息 + 待确认名单 + supersedes 失效 ─────────
  private async broadcast(b: any) {
    if (!b?.broadcast_id) return json({ error: "broadcast_id_required" }, 422);
    const dup = await this.st.get<number>(`bc:${b.broadcast_id}`);
    if (dup) return json({ seq: dup, deduped: true });

    const seq = await this.append({ project: b.project, sender: b.sender ?? "admin",
                                    topic: "announce", kind: "broadcast",
                                    payload: { ...b, notice: true },
                                    ...(b.max_per_min ? { max_per_min: b.max_per_min } : {}),
                                    dedupe_key: `bc:${b.broadcast_id}` });
    await this.st.put(`bc:${b.broadcast_id}`, seq);

    const agents = await this.st.list<any>({ prefix: "agent:" });
    await this.st.put(`ack:${seq}`, {
      required: !!b.action_required?.ack_required,
      // 管理端 announce 广播仍会到普通 agent；确认清单保持全员。
      pending: [...agents.values()].map((a) => a.agent_id),
      done: {}, deadline: b.action_required?.deadline ?? null,
    });

    if (b.supersedes) {
      const old = await this.st.get<number>(`bc:${b.supersedes}`);
      if (old) await this.st.put(`superseded:${old}`, true);
    }
    return json({ seq });
  }

  private async removeAgent(b: any) {
    const id = String(b?.agent_id ?? "").trim();
    if (!id) return json({ error: "agent_id_required" }, 422);
    await this.st.delete(`agent:${id}`);
    return json({ ok: true });
  }

  /** 管理端修改单个 agent 的定向任务并发上限；0 表示恢复自动默认。 */
  private async setAgentConfig(b: any) {
    const id = String(b?.agent_id ?? "").trim();
    if (!id) return json({ error: "agent_id_required" }, 422);
    const raw = Number(b?.max_parallel_tasks);
    if (!Number.isFinite(raw) || raw < 0 || raw > MAX_PARALLEL_TASKS || Math.floor(raw) !== raw)
      return json({ error: "bad_max_parallel_tasks", min: 0, max: MAX_PARALLEL_TASKS }, 422);
    const rec: any = await this.st.get(`agent:${id}`);
    if (!rec) return json({ error: "agent_not_found", agent_id: id }, 404);
    // 0 = 清除覆盖，回到按 surface 类型自动取默认。
    const next = { ...rec, max_parallel_tasks: raw > 0 ? raw : null, updated_at: Date.now() };
    await this.st.put(`agent:${id}`, next);
    // 调高上限后要立刻补发排队任务，否则管理员改完看不到任何变化。
    const promoted = await this.promoteQueue(this.projectName(), id);
    return json({ ok: true, agent_id: id, max_parallel_tasks: raw,
                  effective: await this.agentMaxParallel(id), promoted });
  }

  /** 远程参数：只接受可回滚的安全项；不以消息通道下发命令，避免管理端变成远程执行入口。 */
  private async controlAgent(b: any) {
    const id = String(b?.agent_id ?? "").trim();
    if (!id) return json({ error: "agent_id_required" }, 422);
    const rec: any = await this.st.get(`agent:${id}`);
    if (!rec) return json({ error: "agent_not_found", agent_id: id }, 404);
    const raw = b?.remote_control;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return json({ error: "remote_control_required" }, 422);
    const hasAuto = "auto_forward" in raw;
    const hasDebug = "debug" in raw;
    const hasHeartbeat = "heartbeat_s" in raw;
    if (!hasAuto && !hasDebug && !hasHeartbeat)
      return json({ error: "control_field_required" }, 422);
    const prev = normalizeRemoteControl(rec.remote_control) ?? {
      rev: 0, auto_forward: "inherit", debug: false, heartbeat_s: null,
      updated_at: 0, updated_by: "admin",
    };
    const auto = hasAuto ? launchEnum(raw.auto_forward, ["inherit", "on", "off"]) : prev.auto_forward;
    if (hasAuto && !auto) return json({ error: "bad_auto_forward" }, 422);
    if (auto === "on") {
      const launch = rec.launch;
      const hasTarget = !!(launch?.delivery?.target || launch?.effective?.window_app
        || launch?.effective?.tmux_target || launch?.effective?.notify_cmd);
      if (!launch || !hasTarget)
        return json({ error: "delivery_target_missing" }, 422);
    }
    let debug = prev.debug;
    if (hasDebug) {
      if (typeof raw.debug !== "boolean") return json({ error: "bad_debug" }, 422);
      debug = raw.debug;
    }
    let heartbeat = prev.heartbeat_s;
    if (hasHeartbeat) {
      if (raw.heartbeat_s === null || raw.heartbeat_s === 0) {
        heartbeat = null;                       // 0/null = 清除远程覆盖，跟随客户端本地配置
      } else {
        const n = Number(raw.heartbeat_s);
        if (!Number.isFinite(n) || n < 15 || n > 300 || Math.floor(n) !== n)
          return json({ error: "bad_heartbeat_s", min: 15, max: 300, clear_with: 0 }, 422);
        heartbeat = n;
      }
    }
    const next = {
      ...prev,
      rev: Number(prev.rev ?? 0) + 1,
      auto_forward: auto ?? "inherit",
      debug,
      heartbeat_s: heartbeat,
      updated_at: Date.now(),
      updated_by: String(b?.sender ?? "admin").slice(0, 80),
    };
    await this.st.put(`agent:${id}`, { ...rec, remote_control: next, updated_at: Date.now() });
    return json({ ok: true, agent_id: id, remote_control: next });
  }

  private agentView(a: any, now = Date.now()) {
    const age = now - Number(a.last_hb_ms ?? 0);
    const alive = age <= 120_000 ? "alive" : age <= 300_000 ? "late" : "offline";
    return { ...a, alive, age_s: Math.round(age / 1000) };
  }

  private async agents() {
    const now = Date.now();
    const r = await this.st.list<any>({ prefix: "agent:" });
    const list = [...r.values()].map((a) => {
      const view = this.agentView(a, now);
      const launch = view.launch;
      const health = view.delivery_health;
      const errors = Array.isArray(view.client_errors) ? view.client_errors : [];
      const remote = view.remote_control;
      // 名册不携带完整 argv/日志（31–200 个节点会放大每次列表流量）；详情用 agent/get 取全量。
      const { launch: _launch, debug: _debug, client_errors: _errors, ...rest } = view;
      return {
        ...rest,
        launch_summary: launch ? {
          auto: launch.delivery?.auto === true,
          kind: launch.delivery?.kind ?? "none",
          target: launch.delivery?.target ?? null,
          started_at: launch.started_at ?? null,
          received_at: view.launch_received_ms ?? launch.received_at ?? null,
          auto_since_ms: view.auto_since_ms ?? null,
          auto_off_since_ms: view.auto_off_since_ms ?? null,
          restart_count: view.restart_count ?? 0,
          launch_hash: view.launch_hash ?? null,
          change_count: view.launch_change_count ?? 0,
        } : null,
        delivery_health: health ? {
          status: health.status,
          last_attempt_ms: health.last_attempt_ms,
          last_ok_ms: health.last_ok_ms,
          last_error: health.last_error,
          consecutive_failures: health.consecutive_failures,
        } : null,
        debug_enabled: view.debug?.enabled === true,
        error_count: errors.length,
        last_error_at: errors.length ? errors[0]?.ts ?? null : null,
        remote_control: remote ? {
          rev: remote.rev,
          auto_forward: remote.auto_forward,
          debug: remote.debug,
          heartbeat_s: remote.heartbeat_s,
          updated_at: remote.updated_at,
          applied_rev: view.control_applied_rev ?? 0,
        } : null,
      };
    });
    return json({ agents: list });
  }

  private async getAgent(url: URL) {
    const id = String(url.searchParams.get("id") ?? "").trim();
    if (!id) return json({ error: "agent_id_required" }, 422);
    const rec: any = await this.st.get<any>(`agent:${id}`);
    if (!rec) return json({ error: "agent_not_found", agent_id: id }, 404);
    return json({ agent: this.agentView(rec) });
  }

  // ── 空闲提醒：活动记录、配置和 cron 扫描 ──────────────────
  /** 记录一次主动调用；由 Worker 在数据面入口异步写入，避免拖慢原请求。 */
  private async markActivity(b: any) {
    const agentId = String(b?.agent_id ?? "").trim();
    if (!agentId) return json({ error: "agent_id_required" }, 422);
    const project = String(b?.project ?? "").trim();
    if (!project) return json({ error: "project_required" }, 422);
    const kind = String(b?.kind ?? "activity");
    const now = Date.now();
    try {
      await this.env.DB.prepare(
        `INSERT INTO agent_idle
           (project, agent_id, idle_since_ms, reminded_at, flagged_at,
            last_task_list_ms, last_issue_list_ms, last_active_ms)
         VALUES (?,?,?,0,0,?,?,?)
         ON CONFLICT(project, agent_id) DO UPDATE SET
           last_task_list_ms = CASE WHEN excluded.last_task_list_ms > 0
             THEN excluded.last_task_list_ms ELSE agent_idle.last_task_list_ms END,
           last_issue_list_ms = CASE WHEN excluded.last_issue_list_ms > 0
             THEN excluded.last_issue_list_ms ELSE agent_idle.last_issue_list_ms END,
           last_active_ms = excluded.last_active_ms,
           idle_since_ms = excluded.idle_since_ms,
           reminded_at = 0,
           flagged_at = 0`
      ).bind(
        project, agentId, now,
        kind === "task_list" ? now : 0,
        kind === "issue_list" ? now : 0,
        now,
      ).run();
    } catch (e) {
      console.warn("agent activity write failed", project, agentId, e);
    }
    return json({ ok: true });
  }

  private async idleConfig(project: string) {
    const fallback = {
      enabled: true,
      idle_after_s: IDLE_AFTER_DEFAULT_S,
      followup_after_s: IDLE_FOLLOWUP_DEFAULT_S,
      message: IDLE_DEFAULT_MESSAGE,
    };
    if (!project) return { ...fallback, enabled: false };
    try {
      const row = await this.env.DB.prepare(
        `SELECT enabled, idle_after_s, followup_after_s, message
           FROM idle_reminder_config WHERE project = ?`
      ).bind(project).first<any>();
      if (!row) return fallback;
      return {
        enabled: Number(row.enabled) !== 0,
        idle_after_s: Math.max(1, Math.min(86400, Number(row.idle_after_s) || IDLE_AFTER_DEFAULT_S)),
        followup_after_s: Math.max(1, Math.min(86400, Number(row.followup_after_s) || IDLE_FOLLOWUP_DEFAULT_S)),
        message: String(row.message || IDLE_DEFAULT_MESSAGE),
      };
    } catch (e) {
      // 迁移未跑/表缺失时不要误发提醒；管理台会提示先执行迁移。
      console.warn("idle config read failed", project, e);
      return { ...fallback, enabled: false };
    }
  }

  private renderIdleMessage(template: string, project: string, agentId: string,
                            idleAfterS: number, followupS: number) {
    const vars: Record<string, string> = {
      project, agent_id: agentId,
      idle_minutes: String(Math.round(idleAfterS / 60)),
      followup_minutes: String(Math.round(followupS / 60)),
      task_endpoint: `/p/${project}/tasks`,
      issue_endpoint: `/p/${project}/issues`,
    };
    return String(template).replace(/\{(project|agent_id|idle_minutes|followup_minutes|task_endpoint|issue_endpoint)\}/g,
      (_, k) => vars[k] ?? `{${k}}`);
  }

  private async saveIdleRow(project: string, agentId: string, row: any) {
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO agent_idle
         (project, agent_id, idle_since_ms, reminded_at, flagged_at,
          last_task_list_ms, last_issue_list_ms, last_active_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(project, agentId,
      Number(row.idle_since_ms ?? 0), Number(row.reminded_at ?? 0), Number(row.flagged_at ?? 0),
      Number(row.last_task_list_ms ?? 0), Number(row.last_issue_list_ms ?? 0),
      Number(row.last_active_ms ?? 0),
    ).run().catch((e) => console.warn("idle row save failed", project, agentId, e));
  }

  private async idleTick(project: string) {
    const cfg = await this.idleConfig(project);
    const now = Date.now();
    if (!cfg.enabled) {
      // 关闭自动提醒时清空提醒/上榜，重新打开后从新的空闲周期开始。
      await this.env.DB.prepare(
        `UPDATE agent_idle SET idle_since_ms = ?, reminded_at = 0, flagged_at = 0
           WHERE project = ?`
      ).bind(now, project).run().catch((e) => console.warn("idle reset failed", project, e));
      return { reminded: 0, flagged: 0 };
    }
    let rows: any[] = [];
    try {
      const r = await this.env.DB.prepare(
        `SELECT project, agent_id, idle_since_ms, reminded_at, flagged_at,
                last_task_list_ms, last_issue_list_ms, last_active_ms
           FROM agent_idle WHERE project = ?`
      ).bind(project).all<any>();
      rows = r.results ?? [];
    } catch (e) {
      console.warn("idle rows read failed", project, e);
      return { reminded: 0, flagged: 0 };
    }
    const byId = new Map(rows.map((r) => [String(r.agent_id), r]));
    const agents = await this.st.list<any>({ prefix: "agent:" });
    let reminded = 0, flagged = 0;
    for (const rec of agents.values()) {
      const agentId = String(rec?.agent_id ?? "").trim();
      if (!agentId || rec.role === "admin") continue;
      const hbAge = now - Number(rec.last_hb_ms ?? 0);
      if (hbAge > IDLE_ONLINE_MS) continue;
      const load = await this.activeTaskLoad(agentId);
      let row: any = byId.get(agentId) ?? {
        idle_since_ms: 0, reminded_at: 0, flagged_at: 0,
        last_task_list_ms: 0, last_issue_list_ms: 0, last_active_ms: 0,
      };
      let dirty = false;
      if (load.active_tasks > 0) {
        if (row.idle_since_ms || row.reminded_at || row.flagged_at) {
          row.idle_since_ms = row.reminded_at = row.flagged_at = 0;
          dirty = true;
        }
        if (dirty) await this.saveIdleRow(project, agentId, row);
        continue;
      }
      if (!row.idle_since_ms) {
        row.idle_since_ms = now;
        dirty = true;
      }
      // 防止“ Worker 写活动、DO 读旧行”的竞态：以活动时间作为新的空闲起点。
      if (Number(row.last_active_ms ?? 0) > Number(row.idle_since_ms ?? 0)) {
        row.idle_since_ms = Number(row.last_active_ms);
        dirty = true;
      }
      if (cfg.enabled && Number(row.reminded_at) === 0 &&
          now - Number(row.idle_since_ms) >= cfg.idle_after_s * 1000) {
        const message = this.renderIdleMessage(cfg.message, project, agentId,
                                              cfg.idle_after_s, cfg.followup_after_s);
        try {
          await this.append({
            project, sender: "system", topic: "system", kind: "idle_reminder",
            to: agentId,
            payload: {
              title: "空闲提醒：去公共池找任务或上报 Issue",
              body: message,
              notice: true,
              agent_id: agentId,
              task_endpoint: `/p/${project}/tasks`,
              issue_endpoint: `/p/${project}/issues`,
            },
            max_per_min: 1000,
            dedupe_key: `idle-reminder:${agentId}:${row.idle_since_ms}`,
          } as any);
          row.reminded_at = now;
          row.flagged_at = 0;
          dirty = true;
          reminded++;
        } catch (e) {
          console.warn("idle reminder append failed", project, agentId, e);
        }
      }
      if (Number(row.reminded_at) > 0 && Number(row.flagged_at) === 0 &&
          now - Number(row.reminded_at) >= cfg.followup_after_s * 1000) {
        if (Number(row.last_active_ms ?? 0) > Number(row.reminded_at)) {
          row.reminded_at = 0;
          row.flagged_at = 0;
          row.idle_since_ms = Math.max(now, Number(row.last_active_ms));
        } else {
          row.flagged_at = now;
          flagged++;
        }
        dirty = true;
      }
      if (dirty) await this.saveIdleRow(project, agentId, row);
    }
    return { reminded, flagged };
  }

  /** 管理台“待唤醒”列表：只返回已超过 followup 仍无动作的在线 agent。 */
  private async idleList(b: any) {
    const project = String(b?.project ?? "").trim();
    if (!project) return json({ agents: [] });
    const cfg = await this.idleConfig(project);
    if (!cfg.enabled) return json({ agents: [] });
    let rows: any[] = [];
    try {
      const r = await this.env.DB.prepare(
        `SELECT * FROM agent_idle WHERE project = ? AND flagged_at > 0
           ORDER BY flagged_at ASC`
      ).bind(project).all<any>();
      rows = r.results ?? [];
    } catch (e) {
      console.warn("idle list read failed", project, e);
      return json({ agents: [], error: "idle_list_read_failed" });
    }
    const now = Date.now();
    const records = await this.st.list<any>({ prefix: "agent:" });
    const agents: any[] = [];
    for (const row of rows) {
      const rec = records.get(`agent:${row.agent_id}`);
      if (!rec || rec.role === "admin") continue;
      if (now - Number(rec.last_hb_ms ?? 0) > IDLE_ONLINE_MS) continue;
      if (Number(row.last_active_ms ?? 0) > Number(row.flagged_at ?? 0)) continue;
      const load = await this.activeTaskLoad(String(row.agent_id));
      if (load.active_tasks > 0) continue;
      agents.push({
        agent_id: row.agent_id,
        online: true,
        last_hb_ms: rec.last_hb_ms ?? 0,
        active_tasks: load.active_tasks,
        idle_since_ms: row.idle_since_ms ?? 0,
        reminded_at: row.reminded_at ?? 0,
        flagged_at: row.flagged_at ?? 0,
        last_task_list_ms: row.last_task_list_ms ?? 0,
        last_issue_list_ms: row.last_issue_list_ms ?? 0,
        last_active_ms: row.last_active_ms ?? 0,
      });
    }
    return json({ agents });
  }

  /** 管理台手动重发：发一条空闲提醒，并把 followup 周期重置。 */
  private async idleRemind(b: any) {
    const project = String(b?.project ?? "").trim();
    const agentId = String(b?.agent_id ?? "").trim();
    if (!project) return json({ error: "project_required" }, 422);
    if (!agentId) return json({ error: "agent_id_required" }, 422);
    const now = Date.now();
    const rec = await this.st.get<any>(`agent:${agentId}`);
    if (!rec) return json({ error: "agent_not_found", agent_id: agentId }, 404);
    if (rec.role === "admin") return json({ error: "admin_not_idle_target" }, 409);
    if (rec.project && String(rec.project) !== project)
      return json({ error: "agent_project_mismatch" }, 409);
    const hbAge = now - Number(rec.last_hb_ms ?? 0);
    if (hbAge > IDLE_ONLINE_MS)
      return json({ error: "agent_offline", agent_id: agentId, hb_age_s: Math.round(hbAge / 1000) }, 409);
    const load = await this.activeTaskLoad(agentId);
    if (load.active_tasks > 0)
      return json({ error: "agent_has_tasks", agent_id: agentId, active_tasks: load.active_tasks }, 409);
    const cfg = await this.idleConfig(project);
    if (!cfg.enabled) return json({ error: "idle_disabled" }, 409);

    let row: any = null;
    try {
      row = await this.env.DB.prepare(
        `SELECT idle_since_ms, reminded_at, flagged_at,
                last_task_list_ms, last_issue_list_ms, last_active_ms
           FROM agent_idle WHERE project = ? AND agent_id = ?`
      ).bind(project, agentId).first<any>();
    } catch (e) {
      console.warn("idle remind read failed", project, agentId, e);
      return json({ error: "idle_migration_required" }, 503);
    }
    // 手动重发后重新开始 followup 计时；否则下一次 cron 会立刻再次上榜。
    const idleSince = Number(row?.idle_since_ms ?? 0) || now;
    const message = this.renderIdleMessage(cfg.message, project, agentId,
                                           cfg.idle_after_s, cfg.followup_after_s);
    try {
      await this.append({
        project, sender: "system", topic: "system", kind: "idle_reminder",
        to: agentId,
        payload: {
          title: "空闲提醒：去公共池找任务或上报 Issue",
          body: message,
          notice: true,
          agent_id: agentId,
          task_endpoint: `/p/${project}/tasks`,
          issue_endpoint: `/p/${project}/issues`,
          manual: true,
        },
        max_per_min: 1000,
        dedupe_key: `idle-reminder:manual:${agentId}:${now}`,
      } as any);
    } catch (e: any) {
      console.warn("idle reminder manual append failed", project, agentId, e);
      return json({ error: "idle_remind_failed" }, 503);
    }
    try {
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO agent_idle
           (project, agent_id, idle_since_ms, reminded_at, flagged_at,
            last_task_list_ms, last_issue_list_ms, last_active_ms)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(
        project, agentId, idleSince, now, 0,
        Number(row?.last_task_list_ms ?? 0), Number(row?.last_issue_list_ms ?? 0),
        Number(row?.last_active_ms ?? 0),
      ).run();
    } catch (e) {
      console.warn("idle reminder state save failed", project, agentId, e);
      return json({ error: "idle_state_save_failed", sent: true, agent_id: agentId }, 503);
    }
    return json({ ok: true, agent_id: agentId, reminded_at: now, idle_since_ms: idleSince });
  }

  /** 由 DO 单线程统一设置闹钟；已有更早的闹钟时不要把它推迟。 */
  private async setAlarmAt(at: number) {
    const storage: any = this.st;
    if (typeof storage.setAlarm !== "function") return;
    const current = typeof storage.getAlarm === "function"
      ? await storage.getAlarm().catch(() => null) : null;
    if (current && Number(current) > 0 && Number(current) <= at) return;
    await storage.setAlarm(at).catch(() => {});
  }

  /** 到期的重试任务从“退避等待”切回可调度；实际补位仍走 promoteQueue 的优先级排序。 */
  private async processRetries() {
    const now = Date.now();
    let due = 0;
    let retried = 0;
    const tasks = await this.listRawTasks();
    for (const t of tasks) {
      if (!t || t.state !== "open" || !t.next_retry_at || Number(t.next_retry_at) > now) continue;
      const project = String(t.project ?? this.projectName());
      const cleared = { ...t, next_retry_at: null, updated_at: now };
      await this.st.put(`task:${t.task_id ?? t.id}`, cleared);
      due++;
      if (t.to) {
        const promoted = await this.promoteQueue(project, String(t.to));
        if (promoted.some((p: any) => String(p.task_id) === String(t.task_id ?? t.id))) retried++;
      } else {
        // 公共池任务没有服务端投递通道，发一条管理端可见的“可重领”事件即可。
        await this.append({
          project, sender: "system", topic: "task", kind: "retried", to: "admin",
          payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", work_item: false,
                     attempts: Number(t.attempts ?? 0), pool: true,
                     message: "公共池任务退避结束，可重新领取。" },
          dedupe_key: `task-retry-ready:${t.task_id ?? t.id}:${now}`,
        }).catch(() => {});
      }
    }
    // 下一次最近的重试时间重新挂闹钟（webhook 队列自己的 flush 会再设）。
    let next = Infinity;
    for (const t of await this.listRawTasks()) {
      if (t?.state === "open" && t.next_retry_at) next = Math.min(next, Number(t.next_retry_at));
    }
    if (next < Infinity) await this.setAlarmAt(next);
    return { due, retried };
  }

  async alarm() {
    try { await this.flushWebhooks(); } catch (e) { console.warn("webhook alarm failed", e); }
    try { await this.processRetries(); } catch (e) { console.warn("retry alarm failed", e); }
  }

  /** 管理台效率观测：队列健康度、等待/周期分位、失败与死信、节点 lane。 */
  private async observability(b: any) {
    const now = Date.now();
    const rawWindow = Number(b?.window_ms ?? 24 * 60 * 60_000);
    const windowMs = Number.isFinite(rawWindow)
      ? Math.max(60 * 60_000, Math.min(7 * 24 * 60 * 60_000, rawWindow)) : 24 * 60 * 60_000;
    const tasks = await this.listRawTasks();
    const agents = [...(await this.st.list<any>({ prefix: "agent:" })).values()];
    const doneWindow = tasks.filter((t: any) => t.state === "done" && Number(t.closed_at ?? 0) >= now - windowMs);
    const failedWindow = tasks.filter((t: any) => Number(t.last_failed_at ?? 0) >= now - windowMs
      || (t.state === "failed" && Number(t.dead_lettered_at ?? t.last_failed_at ?? 0) >= now - windowMs));
    const queued = tasks.filter((t: any) => t.to && t.state === "open"
      && this.dispatchStateOf(t) === "queued" && this.retryReady(t, now));
    const retryWait = tasks.filter((t: any) => t.to && t.state === "open"
      && Number(t.next_retry_at ?? 0) > now);
    const publicPool = tasks.filter((t: any) => !t.to && t.state === "open");
    const inFlight = tasks.filter((t: any) => t.to && !this.isTerminalDispatch(t)
      && ["notified", "active"].includes(this.dispatchStateOf(t)));
    const claimed = tasks.filter((t: any) => t.state === "claimed");
    const waitValues: number[] = [];
    for (const t of tasks) {
      if (!t.created_at) continue;
      const activeOrQueued = !["done", "failed", "blocked"].includes(String(t.state));
      if (Number(t.notified_at ?? 0) > 0
          && (activeOrQueued || Number(t.notified_at) >= now - windowMs))
        waitValues.push(Math.max(0, Number(t.notified_at) - Number(t.created_at)));
      else if (t.to && t.state === "open" && this.dispatchStateOf(t) === "queued")
        waitValues.push(Math.max(0, now - Number(t.created_at)));
    }
    const queueAges = queued.map((t: any) => Math.max(0, now - Number(t.created_at ?? now)));
    const cycleValues = doneWindow.map((t: any) => Number(t.closed_at ?? t.updated_at ?? now) - Number(t.created_at ?? now))
      .filter((x: number) => x >= 0);
    const deadLetters = tasks.filter((t: any) => t.state === "failed" || t.dead_letter === true);
    const slaBreaches = tasks.filter((t: any) => {
      const deadline = Number(t.deadline_at ?? 0);
      if (!deadline) return false;
      if (["done", "failed"].includes(String(t.state))) return Number(t.closed_at ?? now) > deadline;
      return deadline <= now;
    });
    const queueP95 = percentile(waitValues, 95);
    const oldestQueueAge = queueAges.length ? Math.max(...queueAges) : 0;
    // S5：排队超时/目标离线单独列成可操作清单，而不是只在 health 里给一句总账。
    const hbByAgent = new Map<string, number>();
    for (const a of agents) hbByAgent.set(String(a.agent_id ?? ""), Number(a.last_hb_ms ?? 0));
    const queueAlertsAll = queued.map((t: any) => {
      const ageMs = Math.max(0, now - Number(t.created_at ?? now));
      const hb = hbByAgent.get(String(t.to ?? "")) ?? 0;
      const toAge = hb ? now - hb : Infinity;
      const toAlive = toAge <= 120_000 ? "alive" : toAge <= 300_000 ? "late" : "offline";
      const stale = ageMs >= QUEUE_STALE_MS;
      const offline = toAge >= QUEUE_OFFLINE_STALE_MS;
      return {
        task_id: t.task_id ?? t.id, title: t.title ?? "", to: t.to ?? null,
        age_ms: ageMs, to_online: toAge <= 300_000, to_alive: toAlive,
        created_at: Number(t.created_at ?? 0), stale, target_offline: offline,
        reason: stale && offline ? "排队超时且目标离线" : stale ? "排队超过 2 小时" : "目标离线超过 1 小时",
      };
    }).filter((x: any) => x.stale || x.target_offline)
      .sort((a: any, b: any) => b.age_ms - a.age_ms);
    const queueAlerts = queueAlertsAll.slice(0, 20);
    const failedCount = failedWindow.length;
    const denominator = doneWindow.length + failedCount;
    const healthReasons: string[] = [];
    if (deadLetters.length) healthReasons.push(`${deadLetters.length} 个死信待处理`);
    if (oldestQueueAge > 2 * 60 * 60_000) healthReasons.push(`最老排队已 ${Math.round(oldestQueueAge / 60_000)} 分钟`);
    if (queueAlertsAll.length) healthReasons.push(`${queueAlertsAll.length} 个排队任务超时或目标离线`);
    if (queued.some((t: any) => {
      const age = now - Number(agents.find((a: any) => a.agent_id === t.to)?.last_hb_ms ?? 0);
      return age > 5 * 60_000;
    }) && !queueAlerts.length) healthReasons.push("有排队任务的目标节点离线");
    if (queueP95 !== null && queueP95 > 30 * 60_000) healthReasons.push(`等待 P95 ${Math.round(queueP95 / 60_000)} 分钟`);
    const health = healthReasons.length ? (deadLetters.length || oldestQueueAge > 2 * 60 * 60_000 ? "bad" : "warn") : "ok";

    const lanes: any[] = [];
    for (const a of agents) {
      const id = String(a.agent_id ?? "");
      const maxParallel = await this.agentMaxParallel(id);
      const laneQueued = queued.filter((t: any) => t.to === id);
      const laneRetry = retryWait.filter((t: any) => t.to === id);
      const laneInFlight = inFlight.filter((t: any) => t.to === id);
      const laneDone = doneWindow.filter((t: any) => t.to === id || t.released_by === id || t.owner === id);
      const laneFailed = failedWindow.filter((t: any) => t.to === id || t.owner === id || t.released_by === id);
      const laneDead = deadLetters.filter((t: any) => t.to === id || t.owner === id);
      const laneAges = laneQueued.map((t: any) => Math.max(0, now - Number(t.created_at ?? now)));
      const laneWait = laneQueued.map((t: any) => Math.max(0, now - Number(t.created_at ?? now)))
        .concat(laneRetry.map((t: any) => Math.max(0, now - Number(t.created_at ?? now))));
      const hbAge = now - Number(a.last_hb_ms ?? 0);
      lanes.push({
        agent_id: id,
        online: hbAge <= 300_000,
        alive: hbAge <= 120_000 ? "alive" : hbAge <= 300_000 ? "late" : "offline",
        max_parallel: maxParallel,
        in_flight: laneInFlight.length,
        queued: laneQueued.length,
        retry_wait: laneRetry.length,
        oldest_queue_age_ms: laneAges.length ? Math.max(...laneAges) : 0,
        wait_p50_ms: percentile(laneWait, 50),
        wait_p95_ms: percentile(laneWait, 95),
        utilization: maxParallel ? Math.round((laneInFlight.length / maxParallel) * 100) : 0,
        completed_window: laneDone.length,
        failed_window: laneFailed.length,
        dead_letters: laneDead.length,
      });
    }
    lanes.sort((a: any, b: any) => b.queued - a.queued || b.retry_wait - a.retry_wait
      || a.agent_id.localeCompare(b.agent_id));
    const recentDead = deadLetters
      .sort((a: any, b: any) => Number(b.dead_lettered_at ?? b.last_failed_at ?? 0)
        - Number(a.dead_lettered_at ?? a.last_failed_at ?? 0))
      .slice(0, 20)
      .map((t: any) => ({
        task_id: t.task_id ?? t.id, title: t.title ?? "", to: t.to ?? null,
        attempts: Number(t.attempts ?? 0), max_attempts: Number(t.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
        last_error: t.last_error ?? null, at: t.dead_lettered_at ?? t.last_failed_at ?? t.updated_at ?? 0,
      }));
    return json({
      generated_at: now, window_ms: windowMs,
      dead_letters_total: deadLetters.length,
      queue_alerts_total: queueAlertsAll.length,
      recent_dead_returned: recentDead.length,
      queue_alerts_returned: queueAlerts.length,
      summary: {
        tasks_total: tasks.length,
        active: tasks.filter((t: any) => !["done", "failed"].includes(String(t.state))).length,
        wip: tasks.filter((t: any) => t.state === "claimed"
          || (!!t.to && !this.isTerminalDispatch(t) && this.dispatchStateOf(t) === "notified")).length,
        claimed: claimed.length,
        queued: queued.length,
        retry_wait: retryWait.length,
        public_pool: publicPool.length,
        done_window: doneWindow.length,
        failed_window: failedCount,
        retries_window: failedWindow.reduce((sum: number, t: any) => sum + Number(t.attempts ?? 0), 0),
        dead_letters: deadLetters.length,
        sla_breaches: slaBreaches.length,
        oldest_queue_age_ms: oldestQueueAge,
        queue_wait_p50_ms: percentile(waitValues, 50),
        queue_wait_p95_ms: queueP95,
        cycle_p50_ms: percentile(cycleValues, 50),
        cycle_p95_ms: percentile(cycleValues, 95),
        failure_rate: denominator ? Math.round((failedCount / denominator) * 1000) / 1000 : null,
        throughput_per_hour: Math.round((doneWindow.length / (windowMs / 3_600_000)) * 100) / 100,
      },
      public_pool: {
        open: publicPool.length,
        claimed: tasks.filter((t: any) => !t.to && t.state === "claimed").length,
        oldest_age_ms: publicPool.length
          ? Math.max(0, ...publicPool.map((t: any) => Math.max(0, now - Number(t.created_at ?? now)))) : 0,
      },
      lanes, recent_dead: recentDead, queue_alerts: queueAlerts,
      health: { status: health, reasons: healthReasons },
    });
  }

  /** 单任务时间线：热窗口 + D1 归档消息 + 任务记录里程碑；管理台专用。 */
  private async taskTimeline(b: any) {
    const id = this.taskIdOf(b);
    if (!id) return json({ error: "task_id_required" }, 422);
    const t: any = await this.st.get(`task:${id}`);
    if (!t) return json({ error: "not_found", task_id: id }, 404);
    const project = String(b?.project ?? t.project ?? this.projectName());
    const room = await this.room();
    // S7：把关联 issue 的事件并入任务时间线；任务记录缺 issue_id 时按 issues.task_id 反查。
    const linkedIssueRows = await this.env.DB.prepare(
      `SELECT issue_id, title, status, task_id, reporter, priority, merged_into,
              closed_by, close_reason, created_at, closed_at, updated_at
         FROM issues WHERE project = ? AND (task_id = ? OR issue_id = ?)
       ORDER BY created_at ASC LIMIT 50`
    ).bind(project, id, String(t.issue_id ?? "")).all<any>().catch(() => ({ results: [] }));
    const linkedIssueIds = new Set<string>((linkedIssueRows.results ?? []).map((r: any) => String(r.issue_id)));
    const events: any[] = [];
    const seen = new Set<string>();
    const addRaw = (m: any) => {
      const p: any = safeJson(m?.payload);
      if (String(p?.task_id ?? "") !== id && !linkedIssueIds.has(String(p?.issue_id ?? ""))) return;
      const e = this.clientEventOf(m as Msg);
      if (e) {
        const key = `msg:${e.seq}`;
        if (!seen.has(key)) { seen.add(key); events.push(e); }
      }
    };
    for (const m of (await this.st.list<Msg>({ prefix: "msg:", limit: 2000 })).values()) addRaw(m);
    const archived = await this.env.DB.prepare(
      `SELECT seq, sender, topic, kind, to_agent, payload_json, ts FROM archive
        WHERE project = ? AND room = ? AND payload_json LIKE ? ORDER BY seq ASC LIMIT 500`
    ).bind(project, room, `%${id}%`).all<any>().catch(() => ({ results: [] }));
    for (const r of archived.results ?? []) {
      addRaw({ seq: r.seq, sender: r.sender, topic: r.topic, kind: r.kind,
               to: r.to_agent ?? undefined, payload: safeJson(r.payload_json), ts: r.ts });
    }
    const derived = (type: string, at: number, data: any = {}, state?: string, actor = "system") => {
      if (!at) return;
      const ts = new Date(at).toISOString();
      // 实际消息和任务字段记录的是同一个里程碑；2 秒内同类型只保留消息版本。
      if (events.some((e: any) => e.type === type && Math.abs(new Date(e.ts).getTime() - at) <= 2000)) return;
      events.push({ id: `tl-${id}-${type}-${at}`, version: 1, source: "synapse-agent-hub",
                    project, type, seq: 0, ts, actor, to: null, task_id: id,
                    ...(state ? { state } : {}),
                    data: { task_id: id, ...data, derived: true } });
    };
    derived("task.created", Number(t.created_at ?? 0), { title: t.title ?? "" }, "open", t.created_by ?? "system");
    derived("task.dispatched", Number(t.notified_at ?? 0), { dispatch_count: t.dispatch_count ?? 0 }, "open", t.created_by ?? "admin");
    derived("task.claimed", Number(t.claimed_at ?? 0), { owner: t.owner ?? null }, "claimed", t.owner ?? "system");
    derived("task.failed", Number(t.last_failed_at ?? 0), { attempts: t.attempts ?? 0, error: t.last_error ?? null }, t.dead_letter ? "failed" : "open", t.owner ?? "system");
    derived("task.done", Number(t.closed_at ?? 0), { closed_by: t.closed_by ?? null }, "done", t.closed_by ?? "system");
    derived("task.merged", Number(t.merged_at ?? 0), { merged_sha: t.merged_sha ?? null,
                                                       merged_branch: t.merged_branch ?? null,
                                                       note: t.merge_note ?? null },
            t.state, t.merged_by ?? "admin");
    derived("task.requeued", Number(t.requeued_at ?? 0), { from: t.requeued_from ?? null,
                                                           to: "public" }, "open", "admin");
    const rows = await this.env.DB.prepare(
      `SELECT submission_id, state, review_state, created_at FROM submissions
        WHERE project = ? AND task_id = ? ORDER BY created_at ASC LIMIT 100`
    ).bind(project, id).all<any>().catch(() => ({ results: [] }));
    for (const s of rows.results ?? []) {
      const at = Number(s.created_at ?? 0);
      derived("submission.created", at, { submission_id: s.submission_id, state: s.state,
                                           review_state: s.review_state });
    }
    // S7：D1 里的 issue 生命周期也生成里程碑；老 issue 没有事件时时间线同样可读。
    for (const i of linkedIssueRows.results ?? []) {
      derived("issue.created", Number(i.created_at ?? 0), { issue_id: i.issue_id, title: i.title,
                                                             status: "open", reporter: i.reporter ?? null },
              "open", i.reporter ?? "system");
      if (i.status === "merged") {
        derived("issue.merged", Number(i.closed_at ?? i.updated_at ?? 0),
                { issue_id: i.issue_id, merged_into: i.merged_into ?? null }, undefined, "admin");
      } else if (i.status === "closed") {
        derived("issue.closed", Number(i.closed_at ?? i.updated_at ?? 0),
                { issue_id: i.issue_id, closed_by: i.closed_by ?? null,
                  close_reason: i.close_reason ?? null }, undefined, i.closed_by ?? "system");
      }
    }
    events.sort((a: any, b: any) => String(a.ts).localeCompare(String(b.ts)) || Number(a.seq) - Number(b.seq));
    const limited = events.slice(-200);
    return json({
      task_id: id, task: { ...t, dispatch_state: this.dispatchStateOf(t),
                           effective_priority: this.effectivePriority(t),
                           retry_in_ms: t.next_retry_at ? Math.max(0, Number(t.next_retry_at) - Date.now()) : null },
      issue: (linkedIssueRows.results ?? [])[0] ?? null,
      events: limited, count: limited.length, truncated: events.length > 200,
    });
  }


  private async snapshot() {
    const seq = (await this.st.get<number>("seq")) ?? 0;
    const now = Date.now();
    const agentRecs = await this.st.list<any>({ prefix: "agent:" });
    const agents = [...agentRecs.values()].map((a) => {
      const age = now - a.last_hb_ms;
      return { ...a, alive: age <= 120_000 ? "alive" : age <= 300_000 ? "late" : "offline",
               age_s: Math.round(age / 1000) };
    });
    const taskRecs = await this.st.list<Task>({ prefix: "task:" });
    return json({ seq, agents, tasks: [...taskRecs.values()] });
  }

  // ── cron：回收过期租约 ────────────────────────────────────
  private async tick(b: any = {}) {
    const now = Date.now();
    let reclaimed = 0;
    const r = await this.st.list<Task>({ prefix: "task:" });
    // S5：cron 主动扫长期排队/离线目标；同一任务 6 小时内只提醒一次，管理侧不必一直开着观测页。
    const hbBy = new Map<string, number>();
    for (const a of (await this.st.list<any>({ prefix: "agent:" })).values())
      hbBy.set(String(a.agent_id ?? ""), Number(a.last_hb_ms ?? 0));
    for (const t of r.values()) {
      if (!t.to || t.state !== "open" || this.dispatchStateOf(t) !== "queued") continue;
      const age = Math.max(0, now - Number(t.created_at ?? now));
      const hb = hbBy.get(String(t.to)) ?? 0;
      const offlineAge = hb ? now - hb : Infinity;
      if (age < QUEUE_STALE_MS && offlineAge < QUEUE_OFFLINE_STALE_MS) continue;
      const key = `queue-alert:${String(t.task_id ?? t.id ?? "")}`;
      const last = await this.st.get<number>(key).catch(() => 0);
      if (last && now - Number(last) < 6 * 3600_000) continue;
      await this.st.put(key, now).catch(() => {});
      await this.append({
        project: String((t as any).project ?? this.projectName()),
        sender: "system", topic: "alert", kind: "queue_stale", to: "admin",
        payload: {
          task_id: t.task_id ?? t.id, title: t.title ?? "", to: t.to,
          age_ms: age, target_offline: offlineAge >= QUEUE_OFFLINE_STALE_MS,
          reason: age >= QUEUE_STALE_MS && offlineAge >= QUEUE_OFFLINE_STALE_MS
            ? "排队超时且目标离线" : age >= QUEUE_STALE_MS
            ? "排队超过 2 小时" : "目标离线超过 1 小时",
          message: "排队任务长期未消化；可在观测页退回公共池或改派在线节点。",
        },
        dedupe_key: `queue-stale:${String(t.task_id ?? t.id ?? "")}:${now}`,
      }).catch(() => {});
    }
    for (const [k, t] of r) {
      if (t.state === "claimed" && t.lease_until < now) {
        const prevOwner = t.owner;
        const draft: any = { ...t, state: "open", owner: null, lease_until: 0,
                             updated_at: now, reclaimed_at: now, reclaimed_from: prevOwner,
                             // 定向任务过期后仍占着原目标的槽位，避免自动把下一条灌给
                             // 可能已经失联的同一个窗口；管理员 reclaim 后再放行。
                             ...(t.to ? { dispatch_state: "notified" } : {}) };
        await this.st.put(k, draft);
        await this.append({ project: (t as any).project ?? this.projectName(),
                            sender: "system", topic: "task", kind: "reclaimed",
                            to: prevOwner ?? (t as any).to ?? undefined,
                            payload: { task_id: (t as any).task_id ?? (t as any).id, prev_owner: prevOwner },
                            max_per_min: 1000,
                            dedupe_key: `reclaim:${(t as any).task_id ?? (t as any).id}:${now}` });
        reclaimed++;
      }
    }
    const project = String(b?.project ?? "").trim();
    const idle = project ? await this.idleTick(project) : { reminded: 0, flagged: 0 };
    // 兜底：alarm 没触发时，每分钟 cron 也把 webhook 重试队列推一遍。
    const webhook = await this.flushWebhooks();
    const retry = await this.processRetries();
    return json({ ok: true, reclaimed, webhook, retry, ...idle });
  }
}

/** 统一响应序列化：不输出异常堆栈字段（错误响应只留稳定的 error code）。 */
function jsonBody(value: unknown): string {
  return JSON.stringify(value, (key, val) =>
    key === "stack" || key === "stackTrace" ? undefined : val);
}

function json(o: unknown, status = 200) {
  return new Response(jsonBody(o), { status, headers: { "content-type": "application/json" } });
}
