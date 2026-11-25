/**
 * Agent Hub SDK（TypeScript）。与 Python 版同构：心跳托管、游标续传、离线队列。
 * 在 Cloudflare Workers 内使用时不要起定时器，改由 ctx.waitUntil 驱动 tick()。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { detectProfile } from "./profile.js";
import { join, basename } from "node:path";
import { Admin } from "./admin.js";

export type WorkState = "busy" | "idle" | "blocked";
export interface Work { state: WorkState; taskId?: string; phase?: string; progressPct?: number }

export interface ClientOptions {
  endpoint: string; project: string; token: string; agentId: string;
  stateDir?: string; heartbeatS?: number;
}

const VERSION = "0.5.10";

const LAUNCH_SECRET_FLAGS = new Set(["--token", "--admin-token", "--api-key", "--secret", "--password", "--proxy"]);

/** 启动参数进管理台前先脱敏；代理/token 只留参数名。 */
function redactedArgv(argv: string[], limit = 64): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const raw of argv.slice(0, limit)) {
    const s = String(raw).slice(0, 512);
    if (hideNext) { out.push("***"); hideNext = false; continue; }
    const lower = s.toLowerCase();
    if (LAUNCH_SECRET_FLAGS.has(lower)) {
      out.push(s);
      hideNext = true;
    } else if (["--token", "--admin-token", "--api-key", "--secret", "--password", "--proxy"]
      .some((k) => lower.startsWith(k + "="))) {
      out.push(s.split("=")[0] + "=***");
    } else {
      out.push(s);
    }
  }
  return out;
}

function fetchT(url: string, init: any = {}) {
  // 无超时的 fetch 会把心跳链一起拖死（实测可挂 300s）
  return fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
}

/** 去掉末尾的 `/`，不用 `/+$` 正则，避免端点字符串触发 ReDoS 扫描。 */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

export class Client {
  private opts: Required<ClientOptions>;
  private work: Work = { state: "idle" };
  private timer?: any;
  private running = false;
  private hb = 0;
  private readonly startedAt = Date.now();
  private eventListeners = new Set<(event: any) => void>();

  constructor(opts: ClientOptions) {
    if (opts.endpoint.startsWith("http://") && !/127\.0\.0\.1|localhost/.test(opts.endpoint))
      throw new Error("refuse plaintext http; use https");
    this.opts = {
      ...opts,
      stateDir: opts.stateDir || join(homedir(), ".synapse-agent"),
      heartbeatS: opts.heartbeatS || 60,
    } as Required<ClientOptions>;
    mkdirSync(this.opts.stateDir, { recursive: true });
  }

  /** 安装时调用一次：写 600 配置；heartbeat 由运行环境 profile 决定。 */
  static init(opts: { endpoint: string; project: string; token: string; agentId?: string; stateDir?: string }): Client {
    if (!opts.token) throw new Error("init 需要 token");
    const stateDir = opts.stateDir ?? join(homedir(), ".synapse-agent");
    const agentId = opts.agentId ?? `agent-${Math.random().toString(16).slice(2, 8)}`;
    const prof = detectProfile(agentId);
    mkdirSync(stateDir, { recursive: true });
    const cfg = { endpoint: trimTrailingSlashes(opts.endpoint), project: opts.project, agent_id: agentId,
                  token: opts.token, heartbeat_s: prof.heartbeatS, state_dir: stateDir };
    const file = join(stateDir, "config.json");
    writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
    return Client.fromConfig(file, false);
  }

  static fromConfig(path?: string, auto = true): Client {
    let p = path ?? join(homedir(), ".synapse-agent", "config.json");
    if (!existsSync(p)) {
      const legacy = join(homedir(), ".yanshi-agent", "config.json");
      if (existsSync(legacy)) p = legacy;
    }
    const raw = JSON.parse(readFileSync(p, "utf8"));
    // 兼容 Python 写的 config.json（agent_id / state_dir / heartbeat_s）
    const cfg = { endpoint: raw.endpoint, project: raw.project,
                  agentId: raw.agentId ?? raw.agent_id,
                  stateDir: raw.stateDir ?? raw.state_dir,
                  heartbeatS: raw.heartbeatS ?? raw.heartbeat_s };
    const token = process.env.SYNAPSE_TOKEN ?? process.env.YANSHI_TOKEN ?? raw.token;
    const c = new Client({ ...cfg, token } as ClientOptions);
    if (auto) c.start();                      // 构造即开始心跳，调用方无需手动触发
    return c;
  }

  /** 常驻：心跳 + 出站补发，直到 SIGINT/SIGTERM。 */
  async runDaemon(_drainMs = 5000): Promise<void> {
    this.start();
    const stop = () => { this.stop(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise<void>(() => {});        // 永不 resolve，保活
  }

  get endpoint(): string { return this.opts.endpoint; }
  get project(): string { return this.opts.project; }
  get agentId(): string { return this.opts.agentId; }

  setWork(w: Partial<Work>) { this.work = { ...this.work, ...w }; }

  // ── 心跳 ──────────────────────────────────────────────
  private launchSnapshot() {
    return {
      schema: "synapse.launch.v1",
      kind: "ts",
      version: VERSION,
      started_at: this.startedAt,
      argv: redactedArgv(process.argv),
      cwd: process.cwd(),
      config_dir: this.opts.stateDir,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      delivery: {
        auto: false, kind: "none", target: "",
        window_forward: false, tmux_forward: false, tmux_verify: true,
      },
      effective: {
        cmd: "sdk", role: "agent", agent_id: this.opts.agentId,
        project: this.opts.project, heartbeat_s: this.opts.heartbeatS,
        config_dir: this.opts.stateDir,
      },
    };
  }

  async heartbeatOnce(): Promise<any> {
    this.hb++;
    return this.post(`/p/${this.opts.project}/heartbeat`, {
      hb: this.hb, agent_id: this.opts.agentId, work: this.work,
      surface: { kind: "none", forward: false }, max_parallel_tasks: 2,
      load: await this.collectLoad(), env: this.collectEnv(), sdk_version: VERSION,
      launch: this.launchSnapshot(),
    }).catch((e) => ({ ok: false, error: String(e) }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.heartbeatOnce();
      if (!this.running) return;
      this.timer = setTimeout(tick, (this.opts.heartbeatS + Math.random() * 15) * 1000);
    };
    void tick();
  }
  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  // ── 消息 ──────────────────────────────────────────────
  async *events(topics?: string): AsyncGenerator<any> {
    this.start();
    while (true) {
      const since = this.cursorLoad();
      const q = `/p/${this.opts.project}/inbox?since=${since}${topics ? `&topics=${encodeURIComponent(topics)}` : ""}`
                  + `&agent=${encodeURIComponent(this.opts.agentId)}`;
      const r = await this.get(q);
      const nextCursor = Number(r.next_cursor ?? since);
      for (const m of r.messages ?? []) {
        yield m;
        this.cursorSave(m.seq);
      }
      if (!(r.messages?.length)) {
        // 整页都是项目事件时 messages 为空，但 next_cursor 已前进；保存它避免死循环。
        if (Number.isFinite(nextCursor) && nextCursor > since) this.cursorSave(nextCursor);
        await new Promise((s) => setTimeout(s, 1000));
      } else if (Number.isFinite(nextCursor) && nextCursor > since) {
        this.cursorSave(Math.max(nextCursor, this.cursorLoad()));
      }
    }
  }

  publish(topic: string, kind: string, payload: unknown, dedupeKey?: string) {
    return this.post(`/p/${this.opts.project}/publish`, {
      topic, kind, payload, dedupe_key: dedupeKey ?? `${this.opts.agentId}:${crypto.randomUUID()}`,
    });
  }

  /** 订阅客户端实时事件（task.* / submission.* / announce 等）。返回取消订阅函数。 */
  onEvent(listener: (event: any) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  dispatchEvent(event: any): void {
    if (!event) return;
    const seq = Number(event.seq) || 0;
    if (seq > 0 && seq > this.eventCursorLoad()) this.eventCursorSave(seq);
    for (const fn of this.eventListeners) {
      try { fn(event); } catch { /* 单个通知回调不能打断 WS 收包 */ }
    }
  }

  /** 降级轮询事件流：与消息流使用独立游标，不会把任务消息消费掉。 */
  async *eventStream(topics?: string, signal?: AbortSignal): AsyncGenerator<any> {
    this.start();
    while (!signal?.aborted) {
      const events = await this.pollEvents(topics);
      for (const e of events) yield e;
      if (!events.length) await new Promise((s) => setTimeout(s, 1000));
    }
  }

  async pollEvents(topics?: string, limit = 100): Promise<any[]> {
    let since = this.eventCursorLoad();
    const q = (cursor: number) => `/p/${this.opts.project}/events?since=${cursor}&limit=${limit}`
      + (topics ? `&topics=${encodeURIComponent(topics)}` : "");
    let r = await this.get(q(since));
    const ep = String(r.epoch ?? "");
    if (ep && ep !== this.eventEpochLoad()) {
      // 房间重建：seq 归零，旧事件游标作废
      this.eventCursorSave(0, ep);
      since = 0;
      r = await this.get(q(0));
    }
    const events: any[] = r.events ?? [];
    const next = Number(r.next_cursor ?? since);
    if (events.length) {
      this.eventCursorSave(Math.max(next, Number(events[events.length - 1]?.seq) || 0));
    } else if (Number.isFinite(next) && next > since) {
      this.eventCursorSave(next);
    }
    return events;
  }

  /** 换一次性 WS 票据（90 秒、用过即废），避免 token 进 URL */
  async wsTicket(): Promise<string> {
    const r = await this.get(`/p/${this.opts.project}/ws-ticket`);
    return r.ticket;
  }

  /** 从游标处拉新消息；不投递，只取数据（Loop 用） */
  /** 自己发出的广播不回收，否则自己回复自己会形成回声风暴 */
  isForMe(m: any): boolean {
    // 事件通知不是任务正文：work_item=false 的排队/创建消息不能进入执行队列。
    if (m?.payload?.work_item === false) return false;
    if (m?.topic === "submission" || m?.topic === "artifact") return false;
    if (m?.topic === "task" && m?.kind !== "task" && m?.kind !== "reassigned") return false;
    return !(m?.sender === this.opts.agentId && !m?.to);
  }

  /** WS 收到并确认要处理后推进游标；重连 catch-up 不会重复投递。 */
  advanceCursor(seq: number): void {
    if (Number.isFinite(seq) && seq > 0) this.cursorSave(seq);
  }

  async pollInbox(topics?: string, limit = 50): Promise<any[]> {
    let since = this.cursorLoad();
    const out: any[] = [];
    let pages = 0;
    while (true) {
      const r = await this.get(`/p/${this.opts.project}/inbox?since=${since}&limit=${limit}`
        + (topics ? `&topics=${encodeURIComponent(topics)}` : "")
        + `&agent=${encodeURIComponent(this.opts.agentId)}`);
      const ep = r.epoch as string | undefined;
      const stored = this.epochLoad();
      if (ep && ep !== stored) {
        // 房间重建（换命名空间），seq 从头开始：游标归零后立即重取
        this.cursorSave(0); this.epochSave(ep); since = 0; pages++;
        if (pages <= 1) continue;
        break;
      }
      const msgs: any[] = r.messages ?? [];
      const nextCursor = Number(r.next_cursor ?? since);
      if (!msgs.length) {
        // 服务端可能过滤掉整页项目事件：messages 为空但 next_cursor 已前进，
        // 不保存会让客户端一直从旧游标重复请求，永远读不到后面的消息。
        if (Number.isFinite(nextCursor) && nextCursor > since) this.cursorSave(nextCursor);
        break;
      }
      out.push(...msgs);
      since = Math.max(since, Number.isFinite(nextCursor) ? nextCursor : 0,
                       Number(msgs[msgs.length - 1].seq) || 0);
      this.cursorSave(since);
      pages++;
      if (!r.has_more || pages >= 5) break;
    }
    return out.filter((m) => this.isForMe(m));
  }

  private epochLoad(): string { try { return (JSON.parse(readFileSync(this.cursorPath(), "utf8")) as any).epoch ?? ""; } catch { return ""; } }
  private epochSave(ep: string) { try { const d = JSON.parse(readFileSync(this.cursorPath(), "utf8")); d.epoch = ep; writeFileSync(this.cursorPath(), JSON.stringify(d)); } catch { writeFileSync(this.cursorPath(), JSON.stringify({ seq: 0, epoch: ep })); } }

  ack(seq: number, status: string, detail: object = {}) {
    return this.post(`/p/${this.opts.project}/ack`, { seq, status, detail });
  }

  report(reportId: string, task: object, resources?: object) {
    return this.post(`/p/${this.opts.project}/report`, {
      report_id: reportId, task, resources: resources ?? {}, env: this.collectEnv(),
    });
  }

  /** 上报 Issue；所有 agent 默认可上报，服务端注入 reporter。 */
  reportIssue(title: string, body = "", priority: "low" | "normal" | "high" | "urgent" = "normal",
              labels = "", selfAssign = false) {
    return this.post(`/p/${this.opts.project}/issues`, {
      title, body, priority, labels, self_assign: selfAssign,
    });
  }

  /** 上报者把仍 open、未派发的 Issue 转成自己的任务。 */
  takeIssue(issueId: string) {
    return this.post(`/p/${this.opts.project}/issues/${encodeURIComponent(issueId)}/take`, {});
  }

  // ── 交付 ──────────────────────────────────────────────
  async upload(path: string) {
    const data = readFileSync(path);
    const sha = createHash("sha256").update(data).digest("hex");
    const res = await fetchT(`${this.opts.endpoint}/p/${this.opts.project}/artifact/${sha}`, {
      method: "PUT", body: data, headers: this.headers(), timeoutMs: 300_000,
    });
    if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
    return { sha256: sha, name: basename(path), bytes: data.length };
  }

  async submit(kind: string, title: string, refs: any[], baseSha?: string, checks: object = {}, taskId?: string) {
    const base = baseSha || this.collectEnv().git_head || "";
    if (!base) throw new Error("base_sha required: pass baseSha or run inside a git repo");
    const boundTaskId = taskId || this.activeTaskId();
    return this.post(`/p/${this.opts.project}/submissions`, {
      submission_id: `sub-${this.opts.agentId}-${crypto.randomUUID().slice(0, 8)}`,
      agent_id: this.opts.agentId, kind, title, refs, base_sha: base, checks,
      ...(boundTaskId ? { task_id: boundTaskId } : {}),
    });
  }

  // ── active task：CLI/SDK 共享同一份“当前任务”上下文 ─────────
  activeTaskPath() { return join(this.opts.stateDir, "active_task.json"); }
  activeTaskId(): string | undefined {
    try {
      const body = JSON.parse(readFileSync(this.activeTaskPath(), "utf8"));
      const id = String(body.task_id ?? "").trim();
      return id || undefined;
    } catch { return undefined; }
  }
  activeTaskSet(taskId: string, seq = 0, title = "") {
    const file = this.activeTaskPath();
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ task_id: taskId, seq, title, since: Date.now(),
                                        agent_id: this.opts.agentId }));
    renameSync(tmp, file);
  }
  activeTaskClear(taskId?: string) {
    if (taskId && this.activeTaskId() !== taskId) return;
    try { unlinkSync(this.activeTaskPath()); } catch {}
  }

  // ── 任务租约 ────────────────────────────────────────────
  claimTask(taskId: string) {
    return this.post(`/p/${this.opts.project}/tasks/claim`, { task_id: taskId });
  }
  releaseTask(taskId: string, state: "done" | "open" | "blocked" = "done") {
    return this.post(`/p/${this.opts.project}/tasks/release`, { task_id: taskId, state });
  }
  async failTask(taskId: string, error: string, retryable = true) {
    const r = await this.post(`/p/${this.opts.project}/tasks/fail`,
      { task_id: taskId, error: String(error).slice(0, 500), retryable });
    if ((r as any)?.ok) this.activeTaskClear(taskId);
    return r;
  }

  // ── 内部 ──────────────────────────────────────────────
  private headers() {
    return { authorization: `Bearer ${this.opts.token}`, "x-sdk-version": VERSION,
             "user-agent": `synapse-agent/${VERSION} (typescript)` };
  }
  private async post(path: string, body: unknown) {
    const res = await fetchT(this.opts.endpoint + path, {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("token revoked or unknown");
    if (res.status === 403) throw new Error("scope/project mismatch");
    if (res.status === 426) throw new Error("sdk too old");
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json();
  }
  private async get(path: string) {
    // 网络瞬断（IPv6 黑洞/连接重置）重试 2 次；4xx 不重试
    let last: any;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetchT(this.opts.endpoint + path, { headers: this.headers() });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        return await res.json();
      } catch (e: any) {
        last = e;
        // S6：fetch/JSON 读取中途断开（chunked 中断）也走这里的重试；4xx 不重试。
        if (/^4\d\d:/.test(String(e?.message))) throw e;
        if (i < 2) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw last;
  }

  // ── 管理面门面（token 需 role=admin） ───────────────────
  reqGet(path: string) { return this.get(path); }
  reqPost(path: string, body: unknown) { return this.post(path, body); }
  async reqDelete(path: string, body: unknown) {
    const res = await fetchT(this.opts.endpoint + path, {
      method: "DELETE", headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DELETE ${path} ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async reqBytes(path: string): Promise<Buffer> {
    const res = await fetchT(this.opts.endpoint + path, { headers: this.headers() });
    if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }
  /** 问服务端发版信息（不下载） */
  async checkUpdate() {
    const m = await this.get("/sdk/manifest");
    return { current: VERSION, latest: String(m.version ?? ""), update: String(m.version ?? "") !== VERSION,
             installUrl: m.install_url, binaries: m.binaries ?? [], notes: m.notes ?? [] };
  }

  /** 默认只给命令；apply=true 且设置了 SYNAPSE_UPGRADE_CMD/YANSHI_UPGRADE_CMD 才执行。 */
  async upgrade(apply = false) {
    const info = await this.checkUpdate();
    if (!info.update) return { ...info, action: "already-latest" };
    const cmd = process.env.SYNAPSE_UPGRADE_CMD ?? process.env.YANSHI_UPGRADE_CMD ?? "";
    if (!apply) return { ...info, action: "manual", cmd: cmd || "curl -fsSL <endpoint>/dl/install.sh | sh" };
    if (!cmd) return { ...info, action: "refused", why: "未设置 SYNAPSE_UPGRADE_CMD，拒绝自动执行远程脚本" };
    const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
    return { ...info, action: "ran", rc: r.status ?? 1 };
  }

  asAdmin() { return new Admin(this); }

  private cursorPath() { return join(this.opts.stateDir, "cursor.json"); }
  private eventCursorPath() { return join(this.opts.stateDir, "event_cursor.json"); }
  private eventCursorLoad(): number {
    try { return JSON.parse(readFileSync(this.eventCursorPath(), "utf8")).seq ?? 0; } catch { return 0; }
  }
  private eventEpochLoad(): string {
    try { return JSON.parse(readFileSync(this.eventCursorPath(), "utf8")).epoch ?? ""; } catch { return ""; }
  }
  private eventCursorSave(seq: number, epoch?: string) {
    const tmp = this.eventCursorPath() + ".tmp";
    const ep = epoch ?? this.eventEpochLoad();
    writeFileSync(tmp, JSON.stringify({ seq, at: Date.now(), ...(ep ? { epoch: ep } : {}) }));
    renameSync(tmp, this.eventCursorPath());
  }
  private cursorLoad(): number {
    try { return JSON.parse(readFileSync(this.cursorPath(), "utf8")).seq ?? 0; } catch { return 0; }
  }
  private cursorSave(seq: number) {
    const tmp = this.cursorPath() + ".tmp";
    // 必须保留 epoch：否则下一轮 pollInbox 判定 epoch 变了，游标反复归零重拉
    let ep = "";
    try { ep = JSON.parse(readFileSync(this.cursorPath(), "utf8")).epoch ?? ""; } catch {}
    writeFileSync(tmp, JSON.stringify({ seq, at: Date.now(), ...(ep ? { epoch: ep } : {}) }));
    renameSync(tmp, this.cursorPath());
  }

  private collectEnv() {
    const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    return {
      git_head: head.status === 0 ? head.stdout.trim() || null : null,
      dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
    };
  }

  private async collectLoad() {
    const load: any = {};
    try {
      const la = readFileSync("/proc/loadavg", "utf8").split(" ");
      load.load1 = Number(la[0]);
    } catch { load.degraded = true; }
    return load;
  }
}

/** 任务租约：进入即认领，每 4 分钟续租，退出按成功/失败交还。 */
export class TaskLease {
  private timer?: any;
  constructor(private client: Client, public taskId: string, private renewMs = 240_000) {}

  async enter(): Promise<this> {
    const r = await this.client.claimTask(this.taskId);
    if (!r?.ok) throw new Error(`claim failed: ${JSON.stringify(r)}`);
    this.client.activeTaskSet(this.taskId);
    this.client.setWork({ state: "busy", taskId: this.taskId });
    this.timer = setInterval(() => {
      this.client.claimTask(this.taskId).catch(() => {});   // 网络抖动下一轮再续
    }, this.renewMs);
    this.timer.unref?.();
    return this;
  }

  async release(state: "done" | "open" | "blocked" = "done") {
    this.stop();
    try {
      return await this.client.releaseTask(this.taskId, state);
    } finally {
      this.client.activeTaskClear(this.taskId);
      this.client.setWork({ state: "idle" });
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
