/**
 * 管理面（/x/admin/*）门面。与 Python 版同构：
 * 共用同一枚 token 和同一个 HTTP 会话，role 只在服务端生效。
 */
export interface AdminHost {
  endpoint: string; project: string;
  reqGet(path: string): Promise<any>;
  reqPost(path: string, body: unknown): Promise<any>;
  reqDelete(path: string, body: unknown): Promise<any>;
  reqBytes(path: string): Promise<Buffer>;
}

export class Admin {
  constructor(private c: AdminHost) {}

  private p(s: string) { return `/x/admin/p/${this.c.project}${s}`; }

  agents(): Promise<any[]> { return this.c.reqGet(this.p("/agents")).then((r) => r.agents ?? []); }
  stats(): Promise<any> { return this.c.reqGet("/x/admin/stats"); }
  wsstat(): Promise<number> { return this.c.reqGet(`/p/${this.c.project}/wsstat`).then((r) => r.sockets ?? 0); }
  messages(limit = 50, desc = true): Promise<any[]> {
    return this.c.reqGet(`${this.p("/messages")}?limit=${limit}${desc ? "&desc=1" : ""}`).then((r) => r.messages ?? []);
  }
  agent(id: string): Promise<any> { return this.c.reqGet(this.p(`/agent/${encodeURIComponent(id)}`)); }

  createTask(taskId: string, title: string, body = "", to?: string): Promise<any> {
    return this.c.reqPost(this.p("/tasks"), {
      task_id: taskId, title, body, to: to ?? null,
    });
  }

  tasks(): Promise<any[]> {
    return this.c.reqGet(this.p("/tasks")).then((r) => r.tasks ?? []);
  }

  send(to: string[], title = "", body = "", ack = true, kind = "task"): Promise<any> {
    const who = (to || []).filter(Boolean);
    if (!who.length) return this.broadcast(title, body, ack, kind);
    return this.c.reqPost(this.p("/send"), {
      to: who, title: title || "(无标题)", body, kind,
      action_required: { kind, ack_required: ack },
    });
  }

  broadcast(title: string, body = "", ack = true, kind = "task", id?: string): Promise<any> {
    return this.c.reqPost(this.p("/broadcast"), {
      broadcast_id: id ?? `bc-${Date.now()}`, title: title || "(无标题)", body, kind,
      action_required: { kind, ack_required: ack },
    });
  }

  submissions(state?: string): Promise<any[]> {
    const q = state ? `/submissions?state=${encodeURIComponent(state)}` : "/submissions";
    // 服务端当前返回裸数组；兼容未来改成 {submissions: [...]} 的版本
    return this.c.reqGet(this.p(q)).then((r) => Array.isArray(r) ? r : (r.submissions ?? []));
  }

  /** 取交付物 zip 到磁盘（不解压；需要则自行 unzip）。 */
  async download(id: string, to: string): Promise<string> {
    const buf = await this.c.reqBytes(this.p(`/submissions/${id}/bundle`));
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, buf);
    return to;
  }

  revoke(agentId: string): Promise<any> {
    return this.c.reqDelete("/x/admin/agents", { project: this.c.project, agent_id: agentId });
  }

  issue(agentId: string, opts: { role?: string; scopes?: string[]; ttl_days?: number; rotate?: boolean } = {}): Promise<any> {
    return this.c.reqPost("/x/admin/agents", {
      project: this.c.project, agent_id: agentId,
      role: opts.role ?? "agent", ttl_days: opts.ttl_days ?? 30, rotate: opts.rotate ?? true,
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
    });
  }
}
