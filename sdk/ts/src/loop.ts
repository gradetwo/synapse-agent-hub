/**
 * 忙时异步、闲时阻塞（与 Python 版 Loop 一一对应）。
 *
 *   IDLE（await idle() 阻塞） --收到任务--> BUSY（后台定时轮询，check() 随时取）
 *   BUSY（check() 非阻塞）    --任务结束--> IDLE（继续 await idle()）
 *
 * 服务端没有长轮询，idle() 内部就是定时轮询，但对外是阻塞语义。
 */
import { Client } from "./client.js";
import { detectProfile } from "./profile.js";

export type LoopState = "idle" | "busy";

export interface LoopOptions {
  pollMs?: number;          // 轮询间隔（仅在环境不支持长连接时使用）
  ackStatus?: string;       // 自动回执状态，默认 done
  transport?: "auto" | "ws" | "poll";   // 默认 auto：先试长连接，不行才轮询
  probeMs?: number;         // 长连接探测窗口，默认 4000
}

export class Loop {
  c: Client;
  pollMs: number;
  ackStatus: string;
  private q: Array<Record<string, any>> = [];
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private ws: WebSocket | null = null;
  private mode: "ws" | "poll" = "poll";
  private needCatchup = false;
  private transport: "auto" | "ws" | "poll" = "auto";
  private probeMs = 4000;
  private probing = false;
  private stopped = false;
  private probeTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  profile: ReturnType<typeof detectProfile>;

  constructor(client: Client, opts: LoopOptions = {}) {
    this.c = client;
    const prof = detectProfile(client.agentId);
    this.profile = prof;
    this.pollMs = opts.pollMs ?? prof.pollMs;
    this.ackStatus = opts.ackStatus ?? "done";
    this.transport = opts.transport ?? "auto";
    this.probeMs = opts.probeMs ?? 4000;
    this.c.start();        // 心跳托管
    if (this.transport !== "poll") void this.probeWs();
  }

  get state(): LoopState { return this.busy ? "busy" : "idle"; }

  private async tick(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const msgs = await this.c.pollInbox();
      for (const m of msgs) {
        this.q.push(m);
        await this.maybeAck(m);
      }
    } catch { /* 网络抖动不杀任务 */ }
    finally { this.inflight = false; }
  }

  get usingWs(): boolean { return this.mode === "ws"; }

  /** 先试长连接；环境不支持（无 WebSocket / 握手失败）就退回轮询 */
  private async probeWs(): Promise<void> {
    if (this.stopped || this.probing) return;
    const GS: any = (globalThis as any).WebSocket;
    if (!GS) { this.mode = "poll"; return; }
    this.probing = true;
    let ws: any = null;
    try {
      const ticket = await this.c.wsTicket();
      const base = this.c.endpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
      ws = new GS(`${base}/p/${this.c.project}/ws?ticket=${ticket}`);
      // 先挂 onmessage，避免 open 到赋值之间丢帧。
      this.ws = ws;
      this.needCatchup = true;
      ws.onmessage = (ev: any) => this.onWsMessage(ev);
      ws.onclose = () => {
        if (this.ws !== ws) return;             // 旧连接的 close 不能清掉新连接/重连定时器
        this.ws = null; this.mode = "poll";
        this.stopPing();
        if (!this.stopped) this.probeTimer = setTimeout(() => void this.probeWs(), 5000);
      };
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws timeout")), this.probeMs);
        ws.onopen = () => { clearTimeout(t); resolve(); };
        ws.onerror = () => { clearTimeout(t); reject(new Error("ws error")); };
      });
      this.mode = "ws";
      this.catchUp();                 // 连接建立前的空窗，以及重连期间的缺口
      this.startPing(ws);
    } catch {
      if (this.ws === ws) this.ws = null;
      this.mode = "poll";
      if (this.transport === "ws" && !this.stopped) throw new Error("transport=ws 但长连接建立失败");
      // auto 模式初次探测失败后不能永久停在 poll：按固定间隔重试，直到升级成功。
      if (!this.stopped) {
        if (this.probeTimer) clearTimeout(this.probeTimer);
        this.probeTimer = setTimeout(() => void this.probeWs(), 5000);
      }
    } finally {
      this.probing = false;
    }
  }

  private startPing(ws: any): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); } catch {}
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
  }

  private onWsMessage(ev: any): void {
    try {
      const m = JSON.parse(String(ev.data));
      if (m?.type === "msg" && this.c.isForMe(m)) {   // 回声/自广播不进队列
        const seq = Number(m.seq) || 0;
        if (!this.q.some((x) => x.seq === m.seq)) this.q.push(m);
        this.c.advanceCursor(seq);                   // 重连补拉不会重复入队
        void this.maybeAck(m);
      }
    } catch { /* 非法帧忽略 */ }
  }

  private catchUp(): void {
    if (!this.needCatchup) return;
    this.needCatchup = false;
    void this.c.pollInbox()
      .then((msgs: any[]) => { for (const m of msgs) this.q.push(m); })
      .catch(() => {});
  }

  private async maybeAck(m: Record<string, any>): Promise<void> {
    if (m?.payload?.action_required?.ack_required) {
      try { await this.c.ack(m.seq, this.ackStatus, { note: "SDK 已自动回执" }); } catch {}
    }
  }

  private enterBusy(label = ""): void {
    if (this.busy) return;
    this.busy = true;
    this.c.setWork({ state: "busy", phase: label.slice(0, 80) });
    void this.c.heartbeatOnce();
    if (this.mode === "ws") return;          // 长连接已在推，不再轮询
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    void this.tick();
  }

  private leaveBusy(): void {
    this.busy = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.c.setWork({ state: "idle", phase: "等指令" });
    void this.c.heartbeatOnce();
  }

  /** 任务中非阻塞取走攒下的消息 */
  check(): Array<Record<string, any>> {
    const out = this.q; this.q = []; return out;
  }

  /** 包住一段工作：进入 BUSY，结束回 IDLE */
  async task<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    this.enterBusy(label);
    try { return await fn(); } finally { this.leaveBusy(); }
  }

  /** 闲置阻塞：内部定时轮询，收到第一条即返回并转 BUSY */
  async idle(timeoutMs?: number): Promise<Record<string, any> | null> {
    const picked = this.check();
    if (picked.length) { this.enterBusy("接任务"); return picked[0]; }
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    if (this.mode === "ws") {
      this.catchUp();
      while (this.mode === "ws" && Date.now() < deadline) {
        if (this.q.length) { const m = this.q.shift()!; this.enterBusy("接任务"); return m; }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.mode === "ws") return null;
    }
    while (Date.now() < deadline) {
      try {
        const msgs = await this.c.pollInbox();
        if (msgs.length) {
          this.enterBusy("接任务");
          for (const m of msgs.slice(1)) { this.q.push(m); void this.maybeAck(m); }
          await this.maybeAck(msgs[0]);
          return msgs[0];
        }
      } catch { /* 忽略抖动，继续等 */ }
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, 2000)));
    }
    return null;
  }

  /** 最小主循环：闲 → 接任务 → 干活 → 回闲 */
  async serve(handler: (task: any, loop: Loop) => Promise<void> | void, opts: { timeoutMs?: number; once?: boolean } = {}): Promise<void> {
    while (true) {
      const t = await this.idle(opts.timeoutMs);
      if (!t) return;
      await this.task(t?.payload?.title ?? "task", async () => {
        try { await handler(t, this); }
        catch (e: any) {
          await this.c.publish("report", "report", { title: "任务失败", body: String(e?.message ?? e) });
        }
      });
      if (opts.once) return;
    }
  }

  close(): void {
    this.stopped = true;
    this.stopPing();
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.leaveBusy();
    this.c.stop();
  }
}
