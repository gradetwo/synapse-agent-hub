// ProjectRoom：每项目一个 Durable Object。
// 单线程 ⇒ seq 单调递增、任务认领免锁 CAS、心跳覆盖写。
import { Env, Msg, Task } from "./types";

const LATEST_KEEP = 2000; // 热窗口：最近 2000 条；更早的查 D1（归档任务）
const DEFAULT_TASK_LEASE_MS = 12 * 60 * 60_000; // 任务 claim 默认租约 12h；心跳会续，LEASE_TTL_S 可调

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

  /** claim 租约：优先读 LEASE_TTL_S（秒），缺省/非法时 12 小时。 */
  private taskLeaseMs(): number {
    const sec = Number(this.env.LEASE_TTL_S);
    // 120 是旧部署未生效的遗留值；别让它把默认 12h 降回 2 分钟。
    if (sec === 120) return DEFAULT_TASK_LEASE_MS;
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : DEFAULT_TASK_LEASE_MS;
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
      case "tasks/submission-settled": return this.submissionSettled(body);
      case "tasks/list":   return this.listTasks();
      case "tasks/get":    return this.getTask(body);
      case "tasks/create": return this.createTask(body);
      case "tasks/admin-close": return this.adminClose(body);
      case "tasks/admin-reclaim": return this.adminReclaim(body);
      case "tasks/admin-reassign": return this.adminReassign(body);
      case "broadcast":    return this.broadcast(body);
      case "agent/list":   return this.agents();
      case "agent/remove": return this.removeAgent(body);
      case "ws":           return this.ws(req);
      case "wsstat": {
        // 只报"活着的会话"，并按 agent 汇总；sockets 字段保留给旧客户端/提示词
        const live = this.liveSockets();
        return json({ sockets: live.length, agents: new Set(live.map((x) => x.agent)).size, live });
      }
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

  // 普通 agent 的收件箱只接：定向给它的消息、管理端广播，以及 agent 之间的
  // status/alert 广播。ack/report、announce、artifact 和 task 生命周期属于项目事件，
  // 只给管理台看；否则 win_bridge 逐行上报会把所有 agent 的 inbox 刷成噪音。
  private agentCanSee(m: Msg, me: string | null): boolean {
    if (!me || me === "*") return true;
    if (m.to) return this.isToMe(m.to, me);
    const topic = m.topic ?? "";
    // 管理端广播照常下发；但 task 生命周期（claimed/released/done/reclaimed）只进管理台。
    if (m.sender === "admin") return !(topic === "task" && m.kind !== "task");
    if (["ack", "report", "announce", "artifact", "dm"].includes(topic)) return false;
    if (topic === "task" && m.kind !== "task") return false;
    return true;
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
      // 与 HTTP inbox 使用同一套可见性：管理端看全量；普通 agent 只看定向消息和管理端广播。
      if (!isAdmin && !this.agentCanSee(msg, me)) continue;
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
    // 普通 agent 只看定向消息和管理端广播；项目事件（announce/artifact/task 生命周期）只进管理台。
    // me="*" 是管理员视角：不做过滤，看全量。
    const rawMessages = messages;
    const visible = messages.filter((m: any) => this.agentCanSee(m, me));
    const page = desc ? visible.slice(-limit) : visible.slice(0, limit);
    // 游标必须推进到“已扫描的原始消息”末条：如果这一页全被过滤掉，
    // 还停在 since 会让客户端每次轮询都重复拉同一段噪音。
    const lastRawSeq = rawMessages.length ? rawMessages[rawMessages.length - 1].seq : since;
    const next = desc
      ? (page.length ? page[page.length - 1].seq : lastRawSeq)
      : (page.length < limit ? lastRawSeq : page[page.length - 1].seq);
    // 房间被重建（换命名空间）时 seq 会从头开始，客户端靠 epoch 判断要重置游标
    const epoch = await this.room();
    return json({ messages: page, next_cursor: next, epoch,
                  has_more: rawMessages.length > page.length });
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
    const now = Date.now();
    const to = b.to === undefined || b.to === null || String(b.to).trim() === "" ? null : String(b.to).trim();
    const issueId = b.issue_id === undefined || b.issue_id === null || String(b.issue_id).trim() === ""
      ? null : String(b.issue_id).trim();
    if (issueId && !/^[A-Za-z0-9._:-]{1,128}$/.test(issueId)) return json({ error: "bad_issue_id" }, 422);
    if (to) {
      const project = String(b.project ?? this.projectName());
      const active = await this.env.DB.prepare(
        `SELECT 1 FROM agents WHERE project = ? AND agent_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
      ).bind(project, to, now).first<any>().catch(() => null);
      if (!active) return json({ error: "target_not_found", to }, 422);
    }
    const t: any = { task_id: id, title, body: String(b.body ?? ""), state: "open",
                     project: b.project ?? this.projectName(),
                     owner: null, lease_until: 0, created_at: now, updated_at: now,
                     created_by: b.sender ?? "admin", to, issue_id: issueId };
    await this.st.put(`task:${id}`, t);
    const seq = await this.append({ project: b.project, sender: b.sender ?? "admin", topic: "task",
                                   kind: "task", to: to ?? undefined,
                                   payload: { task_id: id, title, body: t.body },
                                   dedupe_key: `task:${id}` });
    // S5：指派事件至少落一条定向消息（节点 wait/run 下一次拉取即被唤醒）。
    // 离线节点仍收不到，管理台账用 to_online 明确标出，避免“已派单”造成在线错觉。
    const hb: any = to ? await this.st.get(`agent:${to}`).catch(() => null) : null;
    const targetAge = hb?.last_hb_ms ? now - Number(hb.last_hb_ms) : Infinity;
    return json({ task_id: id, state: "open", seq,
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
    if (!t) return json({ error: "not_found" }, 404);
    const now = Date.now();
    if (t.to && !this.isToMe(t.to, b.agent_id)) return json({ error: "not_your_task" }, 403);
    if (t.state === "claimed" && t.owner === b.agent_id && Number(t.lease_until ?? 0) > now)
      return json({ ok: true, lease_until: t.lease_until, already: true });
    if (t.state !== "open" && !(t.state === "claimed" && t.lease_until < now))
      return json({ error: "locked", owner: t.owner, lease_until: t.lease_until }, 409);
    const lease = now + this.taskLeaseMs();
    await this.st.put(`task:${b.task_id}`, { ...t, state: "claimed", owner: b.agent_id,
                                             lease_until: lease, updated_at: now });
    await this.append({ project: b.project, sender: b.agent_id, topic: "task", kind: "claimed",
                        payload: { task_id: b.task_id, title: t.title ?? "", body: t.body ?? "",
                                   lease_until: lease },
                        dedupe_key: `claim:${b.task_id}:${b.agent_id}:${now}` });
    return json({ ok: true, lease_until: lease });
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
    const issueId = t?.issue_id;
    if (!issueId) return;
    const project = String(t?.project ?? this.projectName());
    const taskId = String(t?.task_id ?? t?.id ?? "");
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE issues SET status = 'closed', closed_at = ?, closed_by = 'task',
         close_reason = ?, updated_at = ?
       WHERE project = ? AND issue_id = ? AND status = 'open' AND task_id = ?`
    ).bind(now, `task_done:${taskId}`, now, project, issueId, taskId).run()
      .catch((e: any) => console.warn("issue auto-close failed", issueId, e));
  }

  /** 任务因交付被拒而重新打开时，把同一任务自动关闭的 issue 也恢复为 open。 */
  private async reopenIssueForTask(t: any) {
    const issueId = t?.issue_id;
    if (!issueId) return;
    const project = String(t?.project ?? this.projectName());
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE issues SET status = 'open', closed_at = NULL, closed_by = NULL,
         close_reason = NULL, updated_at = ?
       WHERE project = ? AND issue_id = ? AND status = 'closed' AND closed_by = 'task'
         AND task_id = ?`
    ).bind(now, project, issueId, taskId).run()
      .catch((e: any) => console.warn("issue auto-reopen failed", issueId, e));
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
                         updated_at: now, released_by: b.agent_id };
    if (state === "done") { patch.closed_at = now; patch.closed_by = "agent"; }
    if (state === "blocked") { patch.blocked_at = now; }
    const next = { ...t, ...patch };
    await this.st.put(`task:${b.task_id}`, next);
    if (state === "done") await this.closeIssueForTask(next);
    await this.append({ project: b.project, sender: b.agent_id, topic: "task", kind: state,
                        payload: { task_id: b.task_id, title: t.title ?? "", body: t.body ?? "",
                                   pending_submissions: pending,
                                   ...(state === "open" ? { abandoned_by: b.agent_id } : {}) },
                        dedupe_key: `release:${b.task_id}:${Date.now()}` });
    return json({ ok: true, state, pending_submissions: pending });
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
    // 已结任务被明确 rejected：重新打开，绝不让拒收留在 done。
    if (b.reopen_on_reject === true && t.state === "done") {
      state = "open";
      const reopened = { ...t, state, owner: null, lease_until: 0,
        pending_submissions: pending, pending_review: pendingReview, updated_at: Date.now(),
        closed_at: null, closed_by: null, reopened_at: Date.now(), reopened_by: "review" };
      await this.st.put(`task:${b.task_id}`, reopened);
      await this.reopenIssueForTask(reopened);
      await this.append({ project, sender: b.sender ?? "admin", topic: "task", kind: "open",
                          payload: { task_id: b.task_id, reopened_by: "review", reason: "delivery_rejected" },
                          dedupe_key: `reopen:${b.task_id}:${Date.now()}` });
      return json({ ok: true, task_id: b.task_id, state, pending_submissions: pending,
                    pending_review: pendingReview, unapproved_reports: unapproved });
    }
    const canClose = pending === 0 && unapproved === 0
      && (t.state === "claimed" || t.state === "released");
    if (canClose) {
      state = "done";
      const now = Date.now();
      const closed = { ...t, state, owner: null, lease_until: 0,
                       pending_submissions: 0, pending_review: pendingReview,
                       updated_at: now, closed_at: now,
                       closed_by: b.closed_by === "approval" ? "approval" : "collection" };
      await this.st.put(`task:${b.task_id}`, closed);
      await this.closeIssueForTask(closed);
      await this.append({ project, sender: b.sender ?? "admin", topic: "task", kind: "done",
                          payload: { task_id: b.task_id, title: t.title ?? "", body: t.body ?? "",
                                     closed_by: b.closed_by === "approval" ? "approval" : "collection",
                                     pending_review: pendingReview },
                          dedupe_key: `close:${b.task_id}` });
    } else {
      await this.st.put(`task:${b.task_id}`, { ...t, pending_submissions: pending,
                                               pending_review: pendingReview, updated_at: Date.now() });
    }
    return json({ ok: true, task_id: b.task_id, state, pending_submissions: pending,
                  pending_review: pendingReview, unapproved_reports: unapproved });
  }

  // 单任务元数据：只给交付校验用，不返回正文，避免普通 agent 拉取任务内容。
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
    });
  }

  private async listTasks() {
    const r = await this.st.list<Task>({ prefix: "task:" });
    const now = Date.now();
    const agents = new Map<string, any>();
    for (const a of (await this.st.list<any>({ prefix: "agent:" })).values()) agents.set(a.agent_id, a);
    const tasks = [...r.values()].map((t: any) => {
      const ownerAge = t.owner ? now - Number(agents.get(t.owner)?.last_hb_ms ?? 0) : Infinity;
      const toAge = t.to ? now - Number(agents.get(t.to)?.last_hb_ms ?? 0) : Infinity;
      return {
        ...t,
        lease_left_ms: Math.max(0, Number(t.lease_until ?? 0) - now),
        owner_online: t.owner ? ownerAge <= 300_000 : null,
        owner_alive: t.owner ? (ownerAge <= 120_000 ? "alive" : ownerAge <= 300_000 ? "late" : "offline") : null,
        // S5：定向任务在 claim 之前也要看见目标节点在线状态，否则只能等它出现。
        to_online: !t.owner && t.to ? toAge <= 300_000 : null,
        to_alive: !t.owner && t.to ? (toAge <= 120_000 ? "alive" : toAge <= 300_000 ? "late" : "offline") : null,
        pending_review: Number(t.pending_review ?? 0),
      };
    });
    const rank = (s: string) => s === "claimed" ? 0 : s === "open" ? 1 : s === "released" ? 2 : s === "blocked" ? 3 : 4;
    tasks.sort((a: any, b: any) => rank(a.state) - rank(b.state)
      || Number(b.updated_at ?? b.created_at ?? 0) - Number(a.updated_at ?? a.created_at ?? 0));
    return json({ tasks });
  }

  private adminReason(b: any): string {
    return String(b?.reason ?? "").trim().slice(0, 240);
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
                   closed_at: now, closed_by: "admin" };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    await this.closeIssueForTask(task);
    await this.append({ project, sender: "admin", topic: "task", kind: "done",
                        payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                                   closed_by: "admin", pending_submissions: pending,
                                   prev_state: t.state, reason },
                        dedupe_key: `admin-close:${t.task_id ?? t.id}:${now}` });
    return json({ ok: true, task });
  }

  private async adminReclaim(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    if (t.state === "done") return json({ error: "task_done", task_id: t.task_id ?? t.id }, 409);
    const now = Date.now();
    const reason = this.adminReason(b);
    const pending = await this.pendingDeliveries(project, t.task_id ?? t.id);
    const task = { ...t, state: "open", owner: null, lease_until: 0, to: null,
                   pending_submissions: pending, updated_at: now, reclaimed_at: now,
                   reclaimed_from: t.owner ?? null };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    await this.append({ project, sender: "admin", topic: "task", kind: "reclaimed",
                        payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                                   prev_state: t.state, prev_owner: t.owner ?? null,
                                   prev_to: t.to ?? null, reason },
                        dedupe_key: `admin-reclaim:${t.task_id ?? t.id}:${now}` });
    return json({ ok: true, task });
  }

  private async adminReassign(b: any) {
    const got = await this.loadTaskForAdmin(b);
    if (got instanceof Response) return got;
    const { t, project } = got;
    if (t.state === "done") return json({ error: "task_done", task_id: t.task_id ?? t.id }, 409);
    const to = String(b.to ?? "").trim();
    if (!to) return json({ error: "assignee_required" }, 422);
    const agent = await this.env.DB.prepare(
      `SELECT agent_id FROM agents WHERE project = ? AND agent_id = ?
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
    ).bind(project, to, Date.now()).first<any>();
    if (!agent) return json({ error: "assignee_not_found", agent_id: to }, 422);
    const now = Date.now();
    const reason = this.adminReason(b);
    const pending = await this.pendingDeliveries(project, t.task_id ?? t.id);
    const task = { ...t, state: "open", owner: null, lease_until: 0, to,
                   pending_submissions: pending, updated_at: now,
                   reassigned_at: now, reassigned_from: t.owner ?? t.to ?? null };
    await this.st.put(`task:${t.task_id ?? t.id}`, task);
    await this.append({ project, sender: "admin", topic: "task", kind: "reassigned", to,
                        payload: { task_id: t.task_id ?? t.id, title: t.title ?? "", body: t.body ?? "",
                                   to, prev_state: t.state, prev_owner: t.owner ?? null,
                                   prev_to: t.to ?? null, reason },
                        dedupe_key: `admin-reassign:${t.task_id ?? t.id}:${now}` });
    return json({ ok: true, task, brief_embedded: true });
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

  private async removeAgent(b: any) {
    const id = String(b?.agent_id ?? "").trim();
    if (!id) return json({ error: "agent_id_required" }, 422);
    await this.st.delete(`agent:${id}`);
    return json({ ok: true });
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
        const prevOwner = t.owner;
        const draft: any = { ...t, state: "open", owner: null, lease_until: 0,
                             updated_at: now, reclaimed_at: now, reclaimed_from: prevOwner };
        await this.st.put(k, draft);
        await this.append({ project: (t as any).project ?? this.projectName(),
                            sender: "system", topic: "task", kind: "reclaimed",
                            payload: { task_id: (t as any).task_id ?? (t as any).id, prev_owner: prevOwner },
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
