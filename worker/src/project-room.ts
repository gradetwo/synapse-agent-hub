// ProjectRoom：每项目一个 Durable Object。
// 单线程 ⇒ seq 单调递增、任务认领免锁 CAS、心跳覆盖写。
import { Env, Msg, Task } from "./types";

const LATEST_KEEP = 2000; // 热窗口：最近 2000 条；更早的查 D1（归档任务）

function safeJson(x: any) { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return {}; } }

const msgKey = (n: number) => `msg:${String(n).padStart(10, "0")}`;

class DoError extends Error {
  constructor(public status: number, public code: string, public detail: any = {}) {
    super(code);
  }
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export class ProjectRoom implements DurableObject {
  private st: DurableObjectStorage;
  constructor(private state: DurableObjectState, private env: Env) {
    this.st = state.storage;
  }

  async fetch(req: Request): Promise<Response> {
    try {
      return await this.handle(req);
    } catch (e: any) {
      if (e instanceof DoError) return json({ error: e.code, ...e.detail }, e.status);
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
                                             url.searchParams.get("project"));
      case "heartbeat":    return this.heartbeat(body);
      case "ack":          return this.ack(body);
      case "report":       return this.report(body);
      case "tasks/claim":  return this.claim(body);
      case "tasks/release":return this.release(body);
      case "tasks/list":   return this.listTasks();
      case "tasks/create": return this.createTask(body);
      case "broadcast":    return this.broadcast(body);
      case "agent/list":   return this.agents();
      case "ws":           return this.ws(req);
      case "wsstat":       return json({ sockets: this.state.getWebSockets().length });
      case "snapshot":     return this.snapshot();
      case "cron/tick":    return this.tick();
      default:             return json({ error: "unknown_action", action }, 404);
    }
  }

  // 房间代号：换 DO 命名空间后 seq 从 0 开始，归档必须按房间分段，
  // 否则新 seq 会覆盖旧归档（v6→v7 实测踩到）。
  private isToMe(to: any, me: string | null): boolean {
    if (!to) return true;
    if (Array.isArray(to)) return !!me && to.includes(me);
    return to === me;
  }

  private projectName(): string {
    try { return String((this.state.id as any).name ?? ""); } catch { return ""; }
  }

  private async room(): Promise<string> {
    let ep = await this.st.get<string>("epoch");
    if (!ep) {
      ep = Math.random().toString(36).slice(2, 10);
      await this.st.put("epoch", ep);
    }
    return ep;
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
    return seq;
  }

  // ── WebSocket：连接挂在 DO 上，空闲可休眠 ───────────────────
  private ws(req: Request): Response {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
      return json({ error: "upgrade_required" }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // 客户端身份随连接保存，断线重连时管理端能看到"谁连着"
    const me = req.headers.get("x-agent-id") ?? "unknown";
    const role = req.headers.get("x-role") ?? "agent";
    this.state.acceptWebSocket(server, [me]);
    try { server.serializeAttachment({ me, role }); } catch { /* 兼容旧运行时 */ }
    server.send(JSON.stringify({ type: "hello", at: Date.now() }));
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
      // 与 HTTP inbox 使用同一套可见性：管理端看全量；定向只给收件人；
      // ack/report 是给管理端的，不能因为走 WebSocket 就漏给其他 agent。
      if (!isAdmin) {
        if (msg.to && !this.isToMe(msg.to, me)) continue;
        if (!msg.to && ["ack", "report"].includes(msg.topic ?? "")) continue;
      }
      try { ws.send(payload); } catch { /* 单条连接坏了就跳过 */ }
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
                      me: string | null = null, desc = false, project: string | null = null) {
    since = Math.max(0, Number.isFinite(since) ? since : 0);
    limit = Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : 100));
    // 历史键 `msg:87` 是字符串，字典序里 msg:100 < msg:99，since 游标会失效。
    // 新键统一零填充；读取时两段都扫，按 seq 去重合并，老数据不丢。
    const padded = await this.st.list<Msg>({ start: msgKey(since + 1), end: "msg:9999999999", limit: 300 });
    const legacy = await this.st.list<Msg>({ start: `msg:${since + 1}`, end: "msg:\uffff", limit: 300 });
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
    // 定向消息：带 to 的只投给收件人；其余是项目内广播
    // me="*" 是管理员视角：不做定向过滤，看全量
    messages = messages.filter((m: any) => {
      // 1) 定向消息只给收件人；广播给所有人；me="*" 是管理员视角
      const directedOk = !m.to || me === "*" || (!!me && this.isToMe(m.to, me));
      if (!directedOk) return false;
      // 2) ack/report 默认是「发给管理端看的」，不进任何 agent 的收件箱（含自己的）
      if (me && me !== "*" && !m.to && ["ack", "report"].includes(m.topic)) return false;
      return true;
    });
    messages = desc ? messages.slice(-limit) : messages.slice(0, limit);
    const next = messages.length ? messages[messages.length - 1].seq : since;
    // 房间被重建（换命名空间）时 seq 会从头开始，客户端靠 epoch 判断要重置游标
    const epoch = await this.room();
    return json({ messages, next_cursor: next, epoch,
                  has_more: archived.length + padded.size + legacy.size > messages.length });
  }

  // ── 心跳：覆盖写 + 顺带续租 + 每 5 分钟落一行历史 ──────────
  private async heartbeat(b: any) {
    if (!b?.agent_id) return json({ error: "agent_id_required" }, 422);
    const key = `agent:${b.agent_id}`;
    const prev: any = (await this.st.get(key)) ?? {};
    const now = Date.now();
    const rec = {
      agent_id: b.agent_id,
      role: b.role ?? "agent",
      work: b.work ?? { state: "idle" },
      load: b.load ?? {},
      env: b.env ?? {},
      sdk_version: b.sdk_version ?? null,
      last_hb_ms: now,
      first_seen_ms: prev.first_seen_ms ?? now,
      hb_count: (prev.hb_count ?? 0) + 1,
      last_bucket: prev.last_bucket ?? 0,
    };
    await this.st.put(key, rec);

    // 任务租约挂心跳：持有者活着就续，共 120s
    const tasks = await this.st.list<Task>({ prefix: "task:" });
    for (const [k, t] of tasks) {
      if (t.owner === b.agent_id && t.state === "claimed") {
        await this.st.put(k, { ...t, lease_until: now + 120_000 });
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
      ).run();
    }
    return json({ ok: true, next_in_s: 60, server_ms: now });
  }

  // F1：任务创建入口（否则租约台账永远是死代码）
  private async createTask(b: any) {
    const id = String(b?.task_id ?? "").trim();
    const title = String(b?.title ?? "").trim();
    if (!id || !title) return json({ error: "task_id_and_title_required" }, 422);
    if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(id)) return json({ error: "bad_task_id" }, 422);
    const old = await this.st.get(`task:${id}`);
    if (old) return json({ error: "task_exists", task_id: id }, 409);
    const t: any = { task_id: id, title, body: String(b.body ?? ""), state: "open",
                     project: b.project ?? this.projectName(),
                     owner: null, lease_until: 0, created_at: Date.now(),
                     created_by: b.sender ?? "admin", to: b.to ?? null };
    await this.st.put(`task:${id}`, t);
    const seq = await this.append({ project: b.project, sender: b.sender ?? "admin", topic: "task",
                                   kind: "task", to: b.to ?? undefined,
                                   payload: { task_id: id, title, body: t.body },
                                   dedupe_key: `task:${id}` });
    return json({ task_id: id, state: "open", seq });
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
                                    payload: { report_id: b.report_id, task: b.task,
                                               resources: b.resources ?? {}, env: b.env ?? {} },
                                    ...(b.max_per_min ? { max_per_min: b.max_per_min } : {}),
                                    dedupe_key: `report:${b.report_id}:${b.agent_id}` });
    return json({ ok: true, seq });
  }

  // ── 任务租约：CPU 单线程，CAS 免费 ─────────────────────────
  private async claim(b: any) {
    const t: any = await this.st.get(`task:${b.task_id}`);
    if (!t) return json({ error: "not_found" }, 404);
    const now = Date.now();
    if (t.to && !this.isToMe(t.to, b.agent_id)) return json({ error: "not_your_task" }, 403);
    if (t.state !== "open" && !(t.state === "claimed" && t.lease_until < now))
      return json({ error: "locked", owner: t.owner, lease_until: t.lease_until }, 409);
    const lease = now + 120_000;
    await this.st.put(`task:${b.task_id}`, { ...t, state: "claimed", owner: b.agent_id, lease_until: lease });
    await this.append({ project: b.project, sender: b.agent_id, topic: "task", kind: "claimed",
                        payload: { task_id: b.task_id, lease_until: lease },
                        dedupe_key: `claim:${b.task_id}:${b.agent_id}:${now}` });
    return json({ ok: true, lease_until: lease });
  }

  private async release(b: any) {
    const t: any = await this.st.get(`task:${b.task_id}`);
    if (!t) return json({ error: "not_found" }, 404);
    if (t.owner !== b.agent_id) return json({ error: "not_owner" }, 403);
    await this.st.put(`task:${b.task_id}`, { ...t, state: b.state ?? "done", owner: null, lease_until: 0 });
    await this.append({ project: b.project, sender: b.agent_id, topic: "task", kind: b.state ?? "done",
                        payload: { task_id: b.task_id }, dedupe_key: `release:${b.task_id}:${Date.now()}` });
    return json({ ok: true });
  }

  private async listTasks() {
    const r = await this.st.list<Task>({ prefix: "task:" });
    return json({ tasks: [...r.values()] });
  }

  // ── 广播：一条消息 + 待确认名单 + supersedes 失效 ─────────
  private async broadcast(b: any) {
    if (!b?.broadcast_id) return json({ error: "broadcast_id_required" }, 422);
    const dup = await this.st.get<number>(`bc:${b.broadcast_id}`);
    if (dup) return json({ seq: dup, deduped: true });

    const seq = await this.append({ project: b.project, sender: b.sender ?? "admin",
                                    topic: "announce", kind: "broadcast", payload: b,
                                    ...(b.max_per_min ? { max_per_min: b.max_per_min } : {}),
                                    dedupe_key: `bc:${b.broadcast_id}` });
    await this.st.put(`bc:${b.broadcast_id}`, seq);

    const agents = await this.st.list<any>({ prefix: "agent:" });
    await this.st.put(`ack:${seq}`, {
      required: !!b.action_required?.ack_required,
      pending: [...agents.values()].map((a) => a.agent_id),
      done: {}, deadline: b.action_required?.deadline ?? null,
    });

    if (b.supersedes) {
      const old = await this.st.get<number>(`bc:${b.supersedes}`);
      if (old) await this.st.put(`superseded:${old}`, true);
    }
    return json({ seq });
  }

  private async agents() {
    const now = Date.now();
    const r = await this.st.list<any>({ prefix: "agent:" });
    const list = [...r.values()].map((a) => {
      const age = now - a.last_hb_ms;
      const alive = age <= 120_000 ? "alive" : age <= 300_000 ? "late" : "offline";
      return { ...a, alive, age_s: Math.round(age / 1000) };
    });
    return json({ agents: list });
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
  private async tick() {
    const now = Date.now();
    let reclaimed = 0;
    const r = await this.st.list<Task>({ prefix: "task:" });
    for (const [k, t] of r) {
      if (t.state === "claimed" && t.lease_until < now) {
        await this.st.put(k, { ...t, state: "open", owner: null, lease_until: 0 });
        await this.append({ project: (t as any).project ?? this.projectName(),
                            sender: "system", topic: "task", kind: "reclaimed",
                            payload: { task_id: (t as any).task_id ?? (t as any).id, prev_owner: t.owner },
                            max_per_min: 1000,
                            dedupe_key: `reclaim:${(t as any).task_id ?? (t as any).id}:${now}` });
        reclaimed++;
      }
    }
    return json({ ok: true, reclaimed });
  }
}

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}
