/**
 * Agent Hub SDK（TypeScript）。与 Python 版同构：心跳托管、游标续传、离线队列。
 * 在 Cloudflare Workers 内使用时不要起定时器，改由 ctx.waitUntil 驱动 tick()。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { detectProfile } from "./profile.js";
import { join } from "node:path";
import { Admin } from "./admin.js";

export type WorkState = "busy" | "idle" | "blocked";
export interface Work { state: WorkState; taskId?: string; phase?: string; progressPct?: number }

export interface ClientOptions {
  endpoint: string; project: string; token: string; agentId: string;
  stateDir?: string; heartbeatS?: number;
}

const VERSION = "0.5.2";

function fetchT(url: string, init: any = {}) {
  // 无超时的 fetch 会把心跳链一起拖死（实测可挂 300s）
  return fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
}

export class Client {
  private opts: Required<ClientOptions>;
  private work: Work = { state: "idle" };
  private timer?: any;
  private hb = 0;

  constructor(opts: ClientOptions) {
    if (opts.endpoint.startsWith("http://") && !/127\.0\.0\.1|localhost/.test(opts.endpoint))
      throw new Error("refuse plaintext http; use https");
    this.opts = {
      stateDir: opts.stateDir ?? join(homedir(), ".synapse-agent"),
      heartbeatS: opts.heartbeatS ?? 60,
      ...opts,
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
    const cfg = { endpoint: opts.endpoint.replace(/\/+$/, ""), project: opts.project, agent_id: agentId,
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
    const token = process.env.YANSHI_TOKEN ?? raw.token;
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

  setWork(w: Partial<Work>) { this.work = { ...this.work, ...w }; }

  // ── 心跳 ──────────────────────────────────────────────
  async heartbeatOnce(): Promise<any> {
    this.hb++;
    return this.post(`/p/${this.opts.project}/heartbeat`, {
      hb: this.hb, agent_id: this.opts.agentId, work: this.work,
      load: await this.collectLoad(), env: this.collectEnv(), sdk_version: VERSION,
    }).catch((e) => ({ ok: false, error: String(e) }));
  }

  start(): void {
    if (this.timer) return;                   // 幂等：重复调用不会起第二个定时器
    const tick = async () => {
      await this.heartbeatOnce();
      this.timer = setTimeout(tick, (this.opts.heartbeatS + Math.random() * 15) * 1000);
    };
    tick();
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); }

  // ── 消息 ──────────────────────────────────────────────
  async *events(topics?: string): AsyncGenerator<any> {
    this.start();
    while (true) {
      const since = this.cursorLoad();
      const q = `/p/${this.opts.project}/inbox?since=${since}${topics ? `&topics=${topics}` : ""}`
                  + `&agent=${encodeURIComponent(this.opts.agentId)}`;
      const r = await this.get(q);
      for (const m of r.messages ?? []) {
        yield m;
        this.cursorSave(m.seq);
      }
      if (!(r.messages?.length)) await new Promise((s) => setTimeout(s, 1000));
    }
  }

  publish(topic: string, kind: string, payload: unknown, dedupeKey?: string) {
    return this.post(`/p/${this.opts.project}/publish`, {
      topic, kind, payload, dedupe_key: dedupeKey ?? `${this.opts.agentId}:${crypto.randomUUID()}`,
    });
  }

  /** 换一次性 WS 票据（90 秒、用过即废），避免 token 进 URL */
  async wsTicket(): Promise<string> {
    const r = await this.get(`/p/${this.opts.project}/ws-ticket`);
    return r.ticket;
  }

  /** 从游标处拉新消息；不投递，只取数据（Loop 用） */
  /** 自己发出的广播不回收，否则自己回复自己会形成回声风暴 */
  isForMe(m: any): boolean { return !(m?.sender === this.opts.agentId && !m?.to); }

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
        + (topics ? `&topics=${topics}` : "")
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
      if (!msgs.length) break;
      out.push(...msgs);
      since = msgs[msgs.length - 1].seq;
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

  // ── 交付 ──────────────────────────────────────────────
  async upload(path: string) {
    const data = readFileSync(path);
    const sha = createHash("sha256").update(data).digest("hex");
    const res = await fetchT(`${this.opts.endpoint}/p/${this.opts.project}/artifact/${sha}`, {
      method: "PUT", body: data, headers: this.headers(), timeoutMs: 300_000,
    });
    if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
    return { sha256: sha, name: path.split("/").pop()!, bytes: data.length };
  }

  async submit(kind: string, title: string, refs: any[], baseSha?: string, checks: object = {}, taskId?: string) {
    const base = baseSha || this.collectEnv().git_head || "";
    if (!base) throw new Error("base_sha required: pass baseSha or run inside a git repo");
    return this.post(`/p/${this.opts.project}/submissions`, {
      submission_id: `sub-${this.opts.agentId}-${crypto.randomUUID().slice(0, 8)}`,
      agent_id: this.opts.agentId, kind, title, refs, base_sha: base, checks,
      ...(taskId ? { task_id: taskId } : {}),
    });
  }

  // ── 任务租约 ────────────────────────────────────────────
  claimTask(taskId: string) {
    return this.post(`/p/${this.opts.project}/tasks/claim`, { task_id: taskId });
  }
  releaseTask(taskId: string, state: "done" | "open" | "blocked" = "done") {
    return this.post(`/p/${this.opts.project}/tasks/release`, { task_id: taskId, state });
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
    this.client.setWork({ state: "busy", taskId: this.taskId });
    this.timer = setInterval(() => {
      this.client.claimTask(this.taskId).catch(() => {});   // 网络抖动下一轮再续
    }, this.renewMs);
    this.timer.unref?.();
    return this;
  }

  async release(state: "done" | "open" | "blocked" = "done") {
    this.stop();
    const r = await this.client.releaseTask(this.taskId, state);
    this.client.setWork({ state: "idle" });
    return r;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
