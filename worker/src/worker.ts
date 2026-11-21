// Worker：唯一入口。data plane = /p/{project}/…（agent token）
//                      control plane = /admin/…（admin token 或 Access 已通过）
import { Env } from "./types";
import CONSOLE_HTML from "../../admin/index.html";
export { ProjectRoom } from "./project-room";

const AGENT_SCOPES = ["poll", "ack", "report", "heartbeat", "publish", "artifact.write", "submissions.create"];
const ADMIN_SCOPES = ["admin", ...AGENT_SCOPES, "artifact.read"];
const ALL_SCOPES = new Set([...ADMIN_SCOPES, ...AGENT_SCOPES]);

// 公开版本探针：只看构建标记，不含任何项目数据/凭据
const BUILD_TAG = "task-closure-link-20261120";
// SDK 发版号：客户端据此判断是否需要自我升级（与二进制 sha 一起下发，防中间人换包）
const SDK_VERSION = "0.5.1";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") return html(LANDING);

    // 控制台：没有有效会话连页面都不给（不泄露任何界面结构）
    // PWA 资源（公开，不含任何业务数据）
    if (path === "/manifest.webmanifest")
      return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (path === "/auth/whoami") {
      const jwt = req.headers.get("cf-access-jwt-assertion") ?? "";
      const out: any = { access_jwt: !!jwt };
      if (jwt) {
        try {
          const [, p2] = jwt.split(".");
          const pl = JSON.parse(new TextDecoder().decode(b64urlToBytes(p2)));
          out.aud = pl.aud; out.iss = pl.iss; out.email = pl.email; out.exp_ok = pl.exp * 1000 > Date.now();
          out.verified = !!(await verifyAccessJwt(req, env));
        } catch (e) { out.decode_error = String(e); }
      }
      out.session = !!(await readSession(req, env));
      out.ok = out.verified || out.session;
      return json(out);
    }

    if (path === "/sw.js")
      return new Response(SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });

    // Access 只放行了 /console/*，而控制台的 XHR 走 /admin/* 会被边缘 403。
    // 这里给 /console/admin/* 做别名：命中后等价于 /admin/*（鉴权逻辑完全一致）。
    if (path.startsWith("/console/admin/")) {
      const u2 = new URL(req.url);
      u2.pathname = path.slice("/console".length);
      return admin(req, env, u2);
    }

    // 受 Access 保护的子路径：把 Access 身份换成 8 小时 HttpOnly 会话 cookie。
    // 这样即使 Access 只覆盖 /console（不覆盖 /admin），后续 XHR 也能凭 cookie 通过。
    // 诊断：只回 header 名字与判定，不回任何值（不含敏感信息）
    if (path === "/console/debug") {
      const names = [...req.headers.keys()].filter((k) => k.toLowerCase().startsWith("cf-")).sort();
      const jwt = req.headers.get("cf-access-jwt-assertion") ?? "";
      const email = req.headers.get("cf-access-authenticated-user-email") ?? "";
      const body: any = {
        host: req.headers.get("host"),
        access_headers: names,
        jwt_present: !!jwt,
        email_present: !!email,
        verified: jwt ? !!(await verifyAccessJwt(req, env)) : false,
        cookie_names: (req.headers.get("cookie") ?? "").split(";").map((x) => x.split("=")[0].trim()).filter(Boolean),
        session: !!(await readSession(req, env)),
        cookie_identity: await accessIdentityFromCookie(req),
      };
      return new Response(JSON.stringify(body, null, 2), {
        status: jwt || email ? 200 : 401,
        headers: { "content-type": "application/json", ...SEC_HEADERS },
      });
    }

    // 管理面板的实时通道：凭 Access 会话 cookie 升级，不用票据（浏览器带头部受限）
    if (path === "/console/ws") {
      if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return err(426, "upgrade_required");
      const sess = (await readSession(req, env)) ?? (await accessIdentityFromCookie(req));
      if (!sess) return err(401, "unauthorized");
      const project = new URL(req.url).searchParams.get("project") ?? "";
      const row = await env.DB.prepare("SELECT status FROM projects WHERE project = ?").bind(project).first<any>();
      if (!row || row.status !== "active") return err(403, "project_unavailable");
      const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
      return stub.fetch(new Request("https://do/ws", {
        headers: { upgrade: "websocket", "x-agent-id": "admin-panel", "x-role": "admin" },
      }));
    }

    if (path === "/console/whoami") {
      const via = await verifyAccessJwt(req, env);
      const cookieId = await accessIdentityFromCookie(req);
      if (!via && !cookieId) return new Response(JSON.stringify({ ok: false, via: null }), {
        status: 401, headers: { "content-type": "application/json", ...SEC_HEADERS },
      });
      const who = via?.email ?? cookieId ?? "access";
      const cookie = await makeSession(who, env.SESSION_SECRET, await sessEpoch(env));
      return new Response(JSON.stringify({ ok: true, via: "access", email: who }), {
        headers: { "content-type": "application/json", "set-cookie": cookie, ...SEC_HEADERS },
      });
    }

    if (path === "/console" || path === "/console/") {
      // 1) 严格验签；2) 验签失败但请求确实带着 Access 注入的邮箱头（说明已过边缘鉴权，
      //    该路径对匿名是 302，伪造头打不进来）→ 也认。
      const viaAccess = await verifyAccessJwt(req, env);
      const accessEmail = req.headers.get("cf-access-authenticated-user-email") ?? "";
      const cookieId = await accessIdentityFromCookie(req);
      const identity = viaAccess?.email ?? cookieId;   // 不再信任可伪造的邮箱头
      const sess = identity ?? await readSession(req, env);
      if (!sess) return new Response(GATE_HTML, { status: 401, headers: secHeaders("text/html; charset=utf-8") });
      // 关键：打开控制台这一下就把会话 cookie 种好，后续 XHR 直接凭它通过，
      // 不再需要 /console/whoami 那一趟（那趟在部分 Access 配置下拿不到令牌）。
      const cookie = identity ? await makeSession(identity, env.SESSION_SECRET, await sessEpoch(env)) : null;
      const headers: Record<string, string> = { ...secHeaders("text/html; charset=utf-8"),
                                                 "cache-control": "no-store, must-revalidate" };
      if (cookie) headers["set-cookie"] = cookie;
      return new Response(CONSOLE_HTML, { headers });
    }

    // 登录：token 换 HttpOnly 会话 cookie（token 不落前端、不进 URL）
    if ((path === "/auth/login" || path === "/admin/login") && req.method === "POST") {
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      const g = await globalCheck(env);
      if (g.blocked) {
        return new Response(JSON.stringify({ error: "too_many_attempts", retry_after_s: g.retry }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": String(g.retry), ...SEC_HEADERS },
        });
      }
      const gate = await guardCheck(ip, env);
      if (gate.blocked) {
        return new Response(JSON.stringify({ error: gate.permanent ? "ip_blocked" : "too_many_attempts",
                                             retry_after_s: gate.retry }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": String(gate.retry), ...SEC_HEADERS },
        });
      }
      const b: any = await req.json().catch(() => ({}));
      const raw = String(b.token ?? "").trim();
      if (!raw) { await guardFail(ip, env); await globalFail(env); return err(401, "bad_credentials"); }
      const sha = await sha256(raw);
      const row = await env.DB.prepare(
        `SELECT agent_id FROM agents WHERE token_sha = ? AND role = 'admin' AND revoked_at IS NULL`
      ).bind(sha).first<any>();
      if (!row) { await guardFail(ip, env); await globalFail(env); return err(401, "bad_credentials"); }
      await guardReset(ip, env);
      const cookie = await makeSession(row.agent_id, env.SESSION_SECRET, await sessEpoch(env));
      return new Response(JSON.stringify({ ok: true, agent: row.agent_id }), {
        headers: { "content-type": "application/json", "set-cookie": cookie, ...SEC_HEADERS },
      });
    }

    if (path.startsWith("/admin/")) return admin(req, env, url);

    // 机器通路（CLI/agent）：不在 Access 覆盖范围内，只认 Bearer token
    if (path.startsWith("/x/admin/")) {
      const u2 = new URL(url.toString());
      u2.pathname = path.replace(/^\/x\/admin/, "/admin");
      return admin(req, env, u2);
    }
    // 安装入口只保留 R2 上的 /dl/install.sh；旧的 /install* wrapper 已下线。

    // 预编译二进制分发（公开）：/dl/index 列出可用平台，/dl/{name} 直接下
    if (path === "/dl" || path === "/dl/index") {
      const list = (await env.BLOBS.list({ prefix: "bin/" })).objects.map((o) => ({
        name: o.key.replace(/^bin\//, ""), size: o.size,
        url: `/dl/${o.key.replace(/^bin\//, "")}`,
        sha256: (o.customMetadata as any)?.sha256 ?? null,
      }));
      return Response.json({ binaries: list });
    }
    if (path.startsWith("/dl/")) {
      const name = path.slice(4);
      if (!/^[a-z0-9._-]+$/i.test(name)) return err(400, "bad_name");
      const obj = await env.BLOBS.get(`bin/${name}`);
      if (!obj) return err(404, "not_found");
      let shaMeta = String((obj as any).customMetadata?.sha256 ?? "");
      let body: Uint8Array | null = null;
      if (!shaMeta && !name.endsWith(".sha256")) {
        try {
          // 老对象没有元数据：读一次算出来并写回（顺带就自愈了）。
          // 读完后必须用 buf 返回，不能再用已被消费的 obj.body，否则新上传对象会 1101。
          const buf = new Uint8Array(await obj.arrayBuffer());
          body = buf;
          shaMeta = await sha256Bytes(buf);
          await env.BLOBS.put(`bin/${name}`, buf, { customMetadata: { sha256: shaMeta } });
        } catch { shaMeta = ""; }   // 自愈失败不影响下载
      }
      return new Response(req.method === "HEAD" ? null : (body ?? obj.body), {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(obj.size),
          "content-disposition": `attachment; filename="${name}"`,
          "x-sha256": shaMeta,
          ...SEC_HEADERS,
        },
      });
    }

    if (path === "/sdk/manifest") {
      // sha 从 R2 对象真实内容算（并写回元数据），不再硬编码，避免升级校验与服务端不一致
      const x64Key = "bin/synapse-agent-x86_64-linux-musl";
      const arm64Key = "bin/synapse-agent-aarch64-linux-musl";
      const x64GnuKey = "bin/synapse-agent-x86_64-linux-gnu";
      const arm64GnuKey = "bin/synapse-agent-aarch64-linux-gnu";
      const [shaX64, shaArm64, shaX64Gnu, shaArm64Gnu] = await Promise.all([
        r2Sha(env, x64Key),
        r2Sha(env, arm64Key),
        r2Sha(env, x64GnuKey),
        r2Sha(env, arm64GnuKey),
      ]);
      const binaries: any[] = [];
      if (shaX64) binaries.push({ platform: "linux-x86_64", url: "/dl/synapse-agent-x86_64-linux-musl", sha256: shaX64 });
      if (shaArm64) binaries.push({ platform: "linux-aarch64", url: "/dl/synapse-agent-aarch64-linux-musl", sha256: shaArm64 });
      if (shaX64Gnu) binaries.push({ platform: "linux-x86_64-gnu", url: "/dl/synapse-agent-x86_64-linux-gnu", sha256: shaX64Gnu });
      if (shaArm64Gnu) binaries.push({ platform: "linux-aarch64-gnu", url: "/dl/synapse-agent-aarch64-linux-gnu", sha256: shaArm64Gnu });
      return json({
        version: SDK_VERSION,
        install_url: "/dl/install.sh",
        binaries,
        notes: ["长连接优先，自动回退轮询", "SDK 回声过滤", "管理面 Admin 门面"],
        at: Date.now(),
      });
    }

    if (path === "/ver")
      return json({ build: BUILD_TAG, sdk: SDK_VERSION, tabs: true, at: Date.now() });

    // 自助注册必须拦在 /p/{project}/{action} 之前：否则 "enroll" 会被当成 project 名
    if (path === "/p/enroll" || path.startsWith("/p/enroll/")) return enroll(req, env, url, path);

    const m = path.match(/^\/p\/([a-z0-9-]+)\/(.+)$/);
    if (!m) return err(404, "not_found");
    const [, project, action] = m;

    // agent 长连接：ticket 换一次性凭证，避免 token 出现在 URL/日志里
    if (action === "ws") return wsConnect(req, env, project, url);
    if (action === "ws-ticket" && req.method === "GET") return wsTicket(req, env, project);
    if (action === "wsstat" && req.method === "GET") {
      const auth = await authenticate(req, env, project);
      if (!auth.ok) return err(auth.status, auth.reason!);
      const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
      const r = await stub.fetch(new Request("https://do/wsstat", { headers: { "content-type": "application/json" } }));
      return new Response(r.body, { headers: { "content-type": "application/json", ...SEC_HEADERS } });
    }

    // artifact 上传走流式直传 R2，不经过 DO
    if (action.startsWith("artifact/")) return artifact(req, env, project, action);

    const auth = await authenticate(req, env, project);
    if (!auth.ok) return err(auth.status, auth.reason!);
    if (!inScope(auth.scopes!, need(action)))
      return err(403, `insufficient_scope: 需要 ${need(action)}，当前 [${(auth.scopes || []).join(",")}]`);
    if (auth.projectStatus === "paused" && req.method !== "GET") return err(423, "project_paused");

    // 交付创建在 Worker 侧完成（需查 R2 + 写 D1），不转发给 DO
    if (action === "submissions" && req.method === "POST")
      return createSubmission(req, env, project, auth.agentId!);

    let pubMaxPerMin = 0;
    if (["publish", "report"].includes(action) && req.method === "POST") {
      // 只注入配额，计数由 DO 原子完成；Worker 侧预查会让幂等重试误吃 429
      pubMaxPerMin = (await projectQuota(env, project)).maxMsgsPerMin;
    }
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
    let doSearch = url.search;
    if (action === "inbox") {
      // 必须“覆盖”而不是“追加”：append 会让 URLSearchParams.get 取到攻击者传来的第一个 agent
      const q = new URLSearchParams(url.search);
      q.set("agent", auth.agentId ?? "");
      q.set("project", project);
      doSearch = "?" + q.toString();
    }
    const doUrl = `https://do/${action}${doSearch}`;
    const init: RequestInit = { method: req.method, headers: { "content-type": "application/json" } };
    if (req.method !== "GET") {
      const body: any = await req.json().catch(() => ({}));
      // sender 必须由服务端注入：否则 agent 可以自称 admin 或别的 agent（身份伪造）
      init.body = JSON.stringify({ ...body, project, agent_id: auth.agentId,
                                   sender: auth.agentId, role: auth.role,
                                   ...(pubMaxPerMin ? { max_per_min: pubMaxPerMin } : {}) });
    }
    // DO 的响应统一在边界处补安全头（DO 内部不感知 HTTP 语义）
    const dr = await stub.fetch(new Request(doUrl, init));
    const out = new Response(dr.body, dr);
    for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);
    out.headers.set("content-type", "application/json");
    return out;
  },

  // cron：逐项目回收过期租约（并发限 3）
  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const rows = await env.DB.prepare(
      "SELECT project, retention_days FROM projects WHERE status='active'"
    ).all<{ project: string; retention_days: number }>();
    ctx.waitUntil((async () => {
      for (const r of rows.results) {
        const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + r.project));
        await stub.fetch(new Request("https://do/cron/tick"));
        // F2 收尾：归档按项目 retention_days 清理，避免无限增长
        const days = Math.max(1, Number(r.retention_days ?? 30));
        const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
        await env.DB.prepare("DELETE FROM archive WHERE project = ? AND ts < ?")
          .bind(r.project, cutoff).run().catch(() => {});
      }
    })());
  },
};

/** 兜底：JWT 头缺失时，拿浏览器的 CF_Authorization cookie 去问 Access 本人是谁。
 *  这是权威判定（Access 自己验证 cookie），不是"看到 cookie 就放行"。 */
async function accessIdentityFromCookie(req: Request): Promise<string | null> {
  const cookie = req.headers.get("cookie") ?? "";
  if (!cookie.includes("CF_Authorization")) return null;
  const host = req.headers.get("host");
  if (!host) return null;
  try {
    const r = await fetch(`https://${host}/cdn-cgi/access/get-identity`, { headers: { cookie } });
    if (!r.ok) return null;
    const j: any = await r.json();
    return typeof j?.email === "string" && j.email ? j.email : null;
  } catch { return null; }
}

// ── 鉴权 ────────────────────────────────────────────────────
// ── 自助注册：agent 本地生成 token，只上报 sha256；管理端审批后生效 ──
async function enroll(req: Request, env: Env, url: URL, path: string) {
  const m = path.match(/^\/p\/enroll\/([a-f0-9]{16})$/);
  if (req.method === "GET" && m) {
    const code = url.searchParams.get("code") ?? "";
    const row = await env.DB.prepare(
      "SELECT id, status, agent_id, scopes FROM enrollments WHERE id = ? AND code = ?"
    ).bind(m[1], code).first<any>();
    if (!row) return err(404, "not_found");
    return json({ id: row.id, status: row.status, agent_id: row.agent_id, scopes: row.scopes });
  }
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const b: any = await req.json().catch(() => ({}));
  const project = String(b.project ?? "").trim();
  const agentId = String(b.agent_id ?? "").trim();
  const tokenSha = String(b.token_sha ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(project) || !/^[a-z0-9._-]{2,40}$/.test(agentId))
    return err(422, "bad_name");
  if (!/^[a-f0-9]{64}$/.test(tokenSha)) return err(422, "bad_token_sha");
  const p = await env.DB.prepare("SELECT status FROM projects WHERE project = ?").bind(project).first<any>();
  if (!p) return err(404, "unknown_project");
  // 同一个 agent 用同一个 token 重复注册时，复用已有待审申请，避免生成两条
  // 相同 token 的 enrollment；否则审批后一条会撞 agents 的唯一键。
  const samePending = await env.DB.prepare(
    `SELECT id, code FROM enrollments
      WHERE project = ? AND agent_id = ? AND token_sha = ? AND status = 'pending'
        AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`
  ).bind(project, agentId, tokenSha, Date.now()).first<any>();
  if (samePending) {
    return json({ id: samePending.id, code: samePending.code, status: "pending", poll_after_s: 5 });
  }
  const ip = req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM enrollments WHERE ip = ? AND created_at > ?"
  ).bind(ip, Date.now() - 86400000).first<any>();
  if ((recent?.n ?? 0) >= 5) return err(429, "too_many_enrollments");
  const pend = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM enrollments WHERE project = ? AND status = 'pending'"
  ).bind(project).first<any>();
  if ((pend?.n ?? 0) >= 50) return err(429, "queue_full");
  const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
  const id = hex(8), code = hex(4);
  // 兼容两种写法：数组 或 "a,b,c" 逗号串。原来的实现只认数组，
  // 传字符串会被静默替换成默认三项——客户端申请了 ack 却永远 403（实测踩到）。
  const rawScopes = b.scopes;
  const listScopes = Array.isArray(rawScopes)
    ? rawScopes.map((x: any) => String(x).trim())
    : String(rawScopes ?? "").split(",").map((x) => x.trim());
  const allowed = ["heartbeat", "poll", "publish", "report", "ack",
                   "submissions.create", "artifact.write", "artifact.read"];
  const bad = listScopes.filter((x) => x && !allowed.includes(x));
  if (bad.length) return err(422, `bad_scope:${bad.join(",")}`);
  const scopes = listScopes.filter(Boolean).length
    ? [...new Set(listScopes.filter(Boolean))].join(",")
    : "heartbeat,poll,publish";
  await env.DB.prepare(
    `INSERT INTO enrollments (id, project, agent_id, token_sha, code, scopes, machine, ip,
                              created_at, expires_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending')`
  ).bind(id, project, agentId, tokenSha, code, scopes,
         String(b.machine ?? "").slice(0, 80), ip, Date.now(), Date.now() + 86400000).run();
  return json({ id, code, status: "pending", poll_after_s: 5 });
}

/** 一次性 WS 票据：Bearer 换票，90 秒有效、用过即废 */
async function wsTicket(req: Request, env: Env, project: string) {
  const auth = await authenticate(req, env, project);
  if (!auth.ok) return err(auth.status, auth.reason!);
  const ticket = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const exp = Date.now() + 90_000;
  await env.DB.prepare(
    "INSERT INTO ws_tickets (ticket,project,agent_id,role,exp_ms,used) VALUES (?,?,?,?,?,0)"
  ).bind(ticket, project, auth.agentId, auth.role, exp).run();
  // 顺手清掉过期票，避免表无限增长
  await env.DB.prepare("DELETE FROM ws_tickets WHERE exp_ms < ?").bind(Date.now() - 3600_000).run().catch(() => {});
  return json({ ticket, exp_ms: exp, ttl_s: 90 });
}

/** 升级为 WebSocket 并转给 DO（连接由 DO 持有，可休眠） */
async function wsConnect(req: Request, env: Env, project: string, url: URL) {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
    return err(426, "upgrade_required");
  const ticket = url.searchParams.get("ticket") ?? "";
  let agentId = "", role = "";

  if (ticket) {
    const row = await env.DB.prepare(
      "SELECT project, agent_id, role, exp_ms, used FROM ws_tickets WHERE ticket = ?"
    ).bind(ticket).first<any>();
    if (!row || row.project !== project) return err(401, "bad_ticket");
    if (row.used) return err(401, "ticket_used");
    if (row.exp_ms < Date.now()) return err(401, "ticket_expired");
    await env.DB.prepare("UPDATE ws_tickets SET used = 1 WHERE ticket = ?").bind(ticket).run();
    agentId = row.agent_id; role = row.role;
  } else {
    // 浏览器控制台：Access 会话 cookie（WebSocket 不能带自定义 header，但会带 cookie）
    const sess = (await readSession(req, env)) ?? (await accessIdentityFromCookie(req));
    if (!sess) return err(401, "bad_ticket");
    agentId = "admin-panel"; role = "admin";
  }

  const proj = await env.DB.prepare("SELECT status FROM projects WHERE project = ?").bind(project).first<any>();
  if (!proj || proj.status !== "active") return err(403, "project_unavailable");

  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  return stub.fetch(new Request("https://do/ws", {
    headers: { upgrade: "websocket", "x-agent-id": agentId, "x-role": role },
  }));
}

async function authenticate(req: Request, env: Env, project: string) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return { ok: false, status: 401, reason: "missing_token" as string };
  const sha = await sha256(bearer);
  const row = await env.DB.prepare(
    `SELECT a.agent_id, a.role, a.scopes, a.revoked_at, a.expires_at, p.status
       FROM agents a JOIN projects p ON p.project = a.project
      WHERE a.token_sha = ? AND a.project = ?`
  ).bind(sha, project).first<any>();
  if (!row) return { ok: false, status: 401, reason: "unauthorized" };
  if (row.revoked_at) return { ok: false, status: 401, reason: "unauthorized" };
  if (row.expires_at && row.expires_at < Date.now()) return { ok: false, status: 401, reason: "unauthorized" };
  return { ok: true, agentId: row.agent_id, role: row.role, scopes: row.scopes.split(","),
           projectStatus: row.status, status: 200, reason: "" };
}

function need(action: string) {
  if (action.startsWith("heartbeat")) return "heartbeat";
  if (action.startsWith("ack")) return "ack";
  if (action.startsWith("report")) return "report";
  if (action.startsWith("inbox")) return "poll";
  if (action === "tasks/list") return "admin";      // 任务台账含派单对象，不对普通 agent 开放
  if (action.startsWith("submissions")) return "submissions.create";
  return "publish";
}
const inScope = (s: string[], n: string) => s.includes(n) || s.includes("admin");

async function projectQuota(env: Env, project: string) {
  const r = await env.DB.prepare(
    "SELECT max_agents, max_storage_mb, max_msgs_per_min FROM projects WHERE project = ?"
  ).bind(project).first<any>().catch(() => null);
  return {
    maxAgents: Number(r?.max_agents ?? 20),
    maxStorageMb: Number(r?.max_storage_mb ?? 2048),
    maxMsgsPerMin: Number(r?.max_msgs_per_min ?? 60),
  };
}

async function activeAgentCount(env: Env, project: string) {
  // 配额是“agent 数”，不是“token 行数”：同一 agent 换钥会有多行历史。
  const r = await env.DB.prepare(
    `SELECT COUNT(DISTINCT agent_id) AS n FROM agents WHERE project = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(project, Date.now()).first<any>();
  return Number(r?.n ?? 0);
}

async function activeAgentCountExcluding(env: Env, project: string, agentId: string) {
  // 审批同一 agent 的换钥申请时，旧的同名 agent 行要被替换，不能占新配额。
  const r = await env.DB.prepare(
    `SELECT COUNT(DISTINCT agent_id) AS n FROM agents
       WHERE project = ? AND agent_id <> ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(project, agentId, Date.now()).first<any>();
  return Number(r?.n ?? 0);
}

// ── R2 直传 ─────────────────────────────────────────────────
async function artifact(req: Request, env: Env, project: string, action: string) {
  // 注意：上传也必须验 token，但不走 scope 之外的动作
  const auth = await authenticate(req, env, project);
  if (!auth.ok) return err(auth.status, auth.reason!);

  // 读与写分开授权：GET 只需要读取权（poll/publish 的 agent 也能取回交付物），
  // 旧实现一律要求 artifact.write，导致只读 agent 永远下不了文件。
  const canRead = inScope(auth.scopes!, "artifact.read") || inScope(auth.scopes!, "poll") ||
                  inScope(auth.scopes!, "publish") || auth.role === "admin";
  const canWrite = inScope(auth.scopes!, "artifact.write") || auth.role === "admin";

  const sha = action.replace(/^artifact\//, "");
  if (!/^[a-f0-9]{64}$/.test(sha)) return err(400, "bad_sha");
  if (auth.projectStatus === "paused" && req.method === "PUT") return err(423, "project_paused");

  if (req.method === "PUT" && !canWrite) return err(403, "insufficient_scope");
  if (req.method !== "PUT" && !canRead) return err(403, "insufficient_scope");
  if (req.method === "PUT") {
    if (!/^[a-f0-9]{64}$/.test(sha)) return err(400, "bad_sha");
    const hard = Number(env.MAX_SUBMISSION_MB) * 1024 * 1024;
    const quota = await projectQuota(env, project);
    const used = await env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM artifacts WHERE project = ?")
      .bind(project).first<any>().catch(() => ({ b: 0 }));
    const usedBytes = Number(used?.b ?? 0);
    const budget = quota.maxStorageMb * 1024 * 1024;
    const limit = Math.min(hard, budget);
    const buf = new Uint8Array(await req.arrayBuffer());     // 不看 content-length，chunked 也拦得住
    if (buf.byteLength > limit) return err(413, "too_large");
    const got = await sha256Bytes(buf);
    if (got !== sha) return err(422, `hash_mismatch:${got}`);   // 内容寻址完整性：不许覆盖
    const already = await env.DB.prepare("SELECT bytes FROM artifacts WHERE project = ? AND sha = ?")
      .bind(project, sha).first<any>().catch(() => null);
    if (!already && usedBytes + buf.byteLength > budget) return err(413, "storage_quota_exceeded");
    const key = `p/${project}/artifacts/${sha}`;
    await env.BLOBS.put(key, buf, { httpMetadata: { contentType: "application/octet-stream" },
                                   customMetadata: { sha256: sha } });
    await env.DB.prepare(
      "INSERT OR REPLACE INTO artifacts (project, sha, bytes, created_at) VALUES (?,?,?,?)"
    ).bind(project, sha, buf.byteLength, Date.now()).run().catch(() => {});
    return Response.json({ stored: true, sha256: sha, key, bytes: buf.byteLength });
  }
  if (req.method === "GET") {
    const obj = await env.BLOBS.get(`p/${project}/artifacts/${sha}`);
    if (!obj) return err(404, "blob_not_found");
    return new Response(obj.body, { headers: { "content-type": "application/octet-stream", etag: sha } });
  }
  return err(405, "method_not_allowed");
}

// ── 管理端 ─────────────────────────────────────────────────
async function admin(req: Request, env: Env, url: URL) {
  const path = url.pathname;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  let authorized = false;

  if (bearer) {
    const sha = await sha256(bearer);
    const row = await env.DB.prepare("SELECT role FROM agents WHERE token_sha = ? AND role = 'admin' AND revoked_at IS NULL")
      .bind(sha).first<any>();
    authorized = !!row;
  } else {
    // 浏览器：Access JWT（验签）/ Access cookie 身份 / HttpOnly 会话 cookie
    authorized = !!(await verifyAccessJwt(req, env))
              || !!(await accessIdentityFromCookie(req))
              || !!(await readSession(req, env));
  }
  if (!authorized) {
    const r = err(403, "admin_required");
    r.headers.set("x-hub-auth", "none");
    return r;
  }

  // CSRF：浏览器会话用 cookie 认证时，跨站发起的写操作一律拒。
  // 机器通路带 Bearer，不受此限（Bearer 不会被浏览器自动附加）。
  if (!bearer && req.method !== "GET" && path !== "/admin/login" && path !== "/auth/login") {
    const site = req.headers.get("sec-fetch-site");
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (site && site !== "same-origin" && site !== "none") return err(403, "csrf_blocked");
    if (origin) {
      try { if (new URL(origin).host !== host) return err(403, "csrf_blocked"); }
      catch { return err(403, "csrf_blocked"); }
    }
  }

  if (path === "/admin/stats" && req.method === "GET") {
    const now = Date.now();
    const pr = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE status='active'").first<any>();
    const ag = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
    ).bind(now).first<any>();
    const sub = await env.DB.prepare("SELECT state, COUNT(*) AS n FROM submissions GROUP BY state").all<any>();
    const enr = await env.DB.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE status='pending'").first<any>();
    const hb = await env.DB.prepare(
      "SELECT COUNT(DISTINCT project || ':' || agent_id) AS n FROM hb_hist WHERE bucket > ?"
    ).bind(Math.floor(now / 300000) - 288).first<any>();
    const perProj = await env.DB.prepare(
      `SELECT project, COUNT(*) AS agents FROM agents
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        GROUP BY project ORDER BY project`
    ).bind(now).all<any>();
    const online = await env.DB.prepare(
      "SELECT COUNT(DISTINCT project || ':' || agent_id) AS n FROM hb_hist WHERE bucket >= ?"
    ).bind(Math.floor(now / 300000) - 1).first<any>();
    return json({
      projects: pr?.n ?? 0,
      agents_online: online?.n ?? 0,
      agents_active: ag?.n ?? 0, enrollments_pending: enr?.n ?? 0,
      agents_heartbeat_24h: hb?.n ?? 0,
      submissions: Object.fromEntries(sub.results.map((r: any) => [r.state, r.n])),
      per_project: perProj.results,
      at: now,
    });
  }

  // 管理端全局名册：按可见项目聚合并保留 project，前端用于“全部项目”视图。
  if (path === "/admin/agents" && req.method === "GET") {
    const policy = await loadPolicy(env);
    const rows = (await env.DB.prepare(
      "SELECT project FROM projects WHERE status='active' ORDER BY created_at"
    ).all<any>()).results;
    const visible = rows
      .map((r) => r.project as string)
      .filter((p) => policy.mode === "all" || (policy.projects || []).includes(p));
    const agents: any[] = [];
    for (const project of visible) {
      try {
        const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
        const r = await stub.fetch(new Request("https://do/agent/list"));
        const d = await r.json<any>().catch(() => ({ agents: [] }));
        for (const a of (Array.isArray(d.agents) ? d.agents : [])) agents.push({ ...a, project });
      } catch { /* 单个项目的 DO 抖动不影响其它项目的总览 */ }
    }
    agents.sort((a, b) =>
      String(a.project ?? "").localeCompare(String(b.project ?? "")) ||
      String(a.agent_id ?? "").localeCompare(String(b.agent_id ?? "")));
    return json({ agents, at: Date.now() });
  }

  if (path === "/admin/enrollments" && req.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, project, agent_id, scopes, machine, created_at, status, code
         FROM enrollments WHERE status IN ('pending','approved','rejected')
        ORDER BY created_at DESC LIMIT 50`
    ).all();
    return json({ enrollments: rows.results });
  }
  const em = path.match(/^\/admin\/enrollments\/([a-f0-9]{16})\/(approve|reject)$/);
  if (em && req.method === "POST") {
    const id = em[1], verdict = em[2];
    const e = await env.DB.prepare("SELECT * FROM enrollments WHERE id = ?").bind(id).first<any>();
    if (!e) return err(404, "not_found");
    if (e.status !== "pending") return err(409, "already_decided");
    if (Date.now() > e.expires_at) {
      await env.DB.prepare("UPDATE enrollments SET status='expired' WHERE id=?").bind(id).run();
      return err(410, "expired");
    }
    const who = String(req.headers.get("cf-access-authenticated-user-email") ?? "admin");
    const now = Date.now();
    if (verdict === "approve") {
      let scopes = e.scopes;
      const b: any = await req.json().catch(() => ({}));
      if (Array.isArray(b.scopes) && b.scopes.length) scopes = b.scopes.join(",");
      // 先查配额；不要把旧 token 先吊销，否则后续 INSERT 失败会把现有 agent 弄成不可用。
      {
        const q = await projectQuota(env, e.project);
        const n = await activeAgentCountExcluding(env, e.project, e.agent_id);
        if (n >= q.maxAgents) return err(409, `agent_quota_exceeded:${n}/${q.maxAgents}`);
      }
      // 同一个 agent 重新注册且复用了旧 token 时，agents 表里可能还留着同 token 的
      // 已吊销行；直接 INSERT 会撞 PRIMARY KEY(project,agent_id,token_sha) 并返回 500。
      // 用 upsert 把同 token 行恢复为 active，再吊销该 agent 的其他 token。
      await env.DB.prepare(
        `INSERT INTO agents (project, agent_id, role, scopes, token_sha, created_at, expires_at)
         VALUES (?,?,?,?,?,?,NULL)
         ON CONFLICT(project, agent_id, token_sha) DO UPDATE SET
           role = excluded.role, scopes = excluded.scopes,
           revoked_at = NULL, expires_at = NULL, created_at = excluded.created_at`
      ).bind(e.project, e.agent_id, "agent", scopes, e.token_sha, now).run();
      await env.DB.prepare(
        `UPDATE agents SET revoked_at = ?
          WHERE project = ? AND agent_id = ? AND revoked_at IS NULL AND token_sha <> ?`
      ).bind(now, e.project, e.agent_id, e.token_sha).run();
      await env.DB.prepare(
        "UPDATE enrollments SET status='approved', scopes=?, decided_at=?, decided_by=? WHERE id=?"
      ).bind(scopes, now, who, id).run();
      return json({ ok: true, status: "approved", agent_id: e.agent_id, project: e.project, scopes });
    }
    await env.DB.prepare(
      "UPDATE enrollments SET status='rejected', decided_at=?, decided_by=? WHERE id=?"
    ).bind(now, who, id).run();
    return json({ ok: true, status: "rejected" });
  }


  const p = url.pathname;

  // 可见性策略：默认 all；管理员可在面板改成"只看指定项目"
  if (p === "/admin/visibility" && req.method === "GET")
    return Response.json(await loadPolicy(env));

  if (p === "/admin/visibility" && req.method === "POST") {
    const b: any = await req.json();
    if (b.mode !== "all" && b.mode !== "list") return err(422, "bad_mode");
    const projects = (b.projects ?? []).filter((x: string) => /^[a-z0-9-]+$/.test(x));
    await env.DB.prepare(
      `INSERT OR REPLACE INTO admin_policy (scope, mode, projects_json, updated_at) VALUES ('*', ?, ?, ?)`
    ).bind(b.mode, JSON.stringify(projects), Date.now()).run();
    return Response.json({ ok: true, mode: b.mode, projects });
  }

  if (p === "/admin/security/revoke-sessions" && req.method === "POST") {
    const cur = Number(await sessEpoch(env)) || 0;
    const next = String(cur + 1);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sess_epoch', ?)").bind(next).run();
    return json({ ok: true, epoch: next, note: "所有浏览器会话立即失效，需重新登录" });
  }

  // 登录封禁台账：列出 / 解封 / 手动拉黑
  if (p === "/admin/security/blocks" && req.method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT ip, fails, blocked_until FROM login_guard WHERE ip != '__global__' ORDER BY blocked_until DESC LIMIT 200"
    ).all<any>()).results;
    return Response.json({ blocks: rows.map((r) => ({
      ip: r.ip, fails: r.fails, permanent: Number(r.blocked_until) === -1,
      until: Number(r.blocked_until) === -1 ? null : Number(r.blocked_until),
      active: Number(r.blocked_until) === -1 || Number(r.blocked_until) > Date.now(),
    })) });
  }

  if (p === "/admin/security/unblock" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    if (b.ip === "*") await env.DB.prepare("DELETE FROM login_guard WHERE ip != '__global__'").run();
    else if (typeof b.ip === "string" && b.ip) await env.DB.prepare("DELETE FROM login_guard WHERE ip = ?").bind(b.ip).run();
    else return err(422, "ip_required");
    return Response.json({ ok: true, ip: b.ip });
  }

  if (p === "/admin/security/block" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    if (!b.ip) return err(422, "ip_required");
    const mins = Number(b.minutes ?? 30);
    const until = mins === 0 ? -1 : Date.now() + mins * 60_000;
    await env.DB.prepare(
      `INSERT INTO login_guard (ip, fails, first_fail_at, blocked_until) VALUES (?, 20, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET blocked_until = ?`
    ).bind(b.ip, Date.now(), until, until).run();
    return Response.json({ ok: true, ip: b.ip, until });
  }

  if (p === "/admin/projects" && req.method === "GET") {
    const policy = await loadPolicy(env);
    const rows = (await env.DB.prepare("SELECT * FROM projects ORDER BY created_at").all<any>()).results;
    const visible = policy.mode === "all" ? rows : rows.filter((r) => policy.projects.includes(r.project));
    return Response.json({ policy, projects: visible, hidden: rows.length - visible.length });
  }

  if (p === "/admin/projects" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    if (!/^[a-z0-9-]{2,40}$/.test(String(b.project ?? ""))) return err(422, "bad_project_name");
    const maxAgents = Math.max(1, Math.min(1000, Number(b.max_agents ?? 20)));
    const maxStorage = Math.max(1, Math.min(10240, Number(b.max_storage_mb ?? 2048)));
    const maxMsgs = Math.max(1, Math.min(1000, Number(b.max_msgs_per_min ?? 60)));
    const retention = Math.max(1, Math.min(3650, Number(b.retention_days ?? 30)));
    await env.DB.prepare(
      `INSERT OR IGNORE INTO projects
         (project, display_name, status, max_agents, max_storage_mb, max_msgs_per_min,
          retention_days, created_at)
       VALUES (?,?, 'active', ?,?,?,?,?)`
    ).bind(b.project, b.display_name ?? b.project, maxAgents, maxStorage, maxMsgs,
           retention, Date.now()).run();
    return Response.json({ ok: true, quotas: { max_agents: maxAgents, max_storage_mb: maxStorage,
      max_msgs_per_min: maxMsgs, retention_days: retention } });
  }

  if (p === "/ver") return json({ build: BUILD_TAG, tabs: true, at: Date.now() });

  // /admin/p/{project}/…
  const m = p.match(/^\/admin\/p\/([a-z0-9-]+)\/(.+)$/);
  if (m) {
    const [, project, action] = m;
    const policy = await loadPolicy(env);
    if (policy.mode === "list" && !policy.projects.includes(project))
      return err(403, "project_not_visible");
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));

    if (action === "agents") return stub.fetch(new Request("https://do/agent/list"));
    if (action === "tasks" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const quota = await projectQuota(env, project);
      return stub.fetch(new Request("https://do/tasks/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin", max_per_min: quota.maxMsgsPerMin }),
      }));
    }
    if (action === "tasks" && req.method === "GET") return stub.fetch(new Request("https://do/tasks/list"));
    if (action === "snapshot") return stub.fetch(new Request("https://do/snapshot"));

    // 吊销一个或多个 agent（幂等）：二次确认由前端承担，后端要 confirm 标记
    if (action === "revoke" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const ids: string[] = Array.isArray(b.agents) ? b.agents.filter(Boolean) : [];
      if (!ids.length) return err(422, "agents_required");
      if (!b.confirm) return err(422, "confirm_required");
      const done = [];
      for (const id of ids) {
        await env.DB.prepare(`UPDATE agents SET revoked_at=? WHERE project=? AND agent_id=? AND revoked_at IS NULL`)
          .bind(Date.now(), project, id).run();
        done.push(id);
      }
      return json({ ok: true, revoked: done });
    }

    // 单个 agent 详情：资源曲线 + 消息 + 提交
    if (action.startsWith("agent/") && req.method === "GET") {
      const id = decodeURIComponent(action.slice(6));
      const hb = await env.DB.prepare(
        `SELECT bucket,cpu_pct,mem_used_mb,disk_used_pct,work_state FROM hb_hist
         WHERE project=? AND agent_id=? ORDER BY bucket DESC LIMIT 120`
      ).bind(project, id).all();
      const subs = await env.DB.prepare(
        `SELECT submission_id,state,kind,title,base_sha,created_at FROM submissions
         WHERE project=? AND agent_id=? ORDER BY created_at DESC LIMIT 20`
      ).bind(project, id).all();
      const ag = await env.DB.prepare(
        `SELECT agent_id,role,scopes,created_at,expires_at,revoked_at FROM agents
         WHERE project=? AND agent_id=?`).bind(project, id).first();
      const inbox: any = await (await stub.fetch(new Request(
        `https://do/inbox?since=0&limit=200&agent=*&desc=1`))).json().catch(() => ({ messages: [] }));
      const msgs = (inbox.messages ?? []).filter((m: any) =>
        m.sender === id || (Array.isArray(m.to) ? m.to.includes(id) : m.to === id)).slice(-30);
      return json({ agent: ag, hb: hb.results ?? [], submissions: subs.results ?? [], messages: msgs });
    }

    // 定向指令：发给一个或多个 agent（不是广播）
    if (action === "send" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const targets: string[] = Array.isArray(b.to) ? b.to.filter(Boolean) : b.to ? [String(b.to)] : [];
      if (!targets.length) return err(422, "target_required");
      if (!b.body && !b.title) return err(422, "empty_message");
      const out = [];
      for (const t of targets) {
        const r = await stub.fetch(new Request("https://do/publish", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project, sender: "admin", topic: b.topic ?? "task", kind: b.kind ?? "task",
            to: t,
            payload: { title: b.title ?? "", body: b.body ?? "",
                       action_required: { kind: b.kind ?? "task", ack_required: !!b.ack_required } },
            max_per_min: (await projectQuota(env, project)).maxMsgsPerMin,
            dedupe_key: `dm:${t}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          }),
        }));
        out.push({ to: t, ...(await r.json<any>().catch(() => ({}))) });
      }
      return json({ ok: true, sent: out });
    }

    // 消息历史：管理员看全量（含定向私信），不分页滚动，取最近 N 条
    if (action === "messages" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 200);
      return stub.fetch(new Request(`https://do/inbox?since=0&limit=${limit}&agent=*&desc=1`));
    }

    if (action === "broadcast") {
      const b: any = await req.json();
      const quota = await projectQuota(env, project);
      return stub.fetch(new Request("https://do/broadcast", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin", max_per_min: quota.maxMsgsPerMin }),
      }));
    }

    if (action === "submissions" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (!b.submission_id || !/^[a-zA-Z0-9._:-]{1,128}$/.test(String(b.submission_id)))
        return err(422, "submission_id_required");
      if (!b.agent_id) return err(422, "agent_id_required");
      if (!b.base_sha) return err(422, "base_sha_required");
      if (!/^[a-f0-9]{7,64}$/.test(String(b.base_sha))) return err(422, "base_sha_not_hex");
      const scan = JSON.stringify({ title: b.title, refs: b.refs, checks: b.checks });
      if (/(AKIA[0-9A-Z]{16}|-----BEGIN[^"]{0,40}PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)/.test(scan))
        return err(422, "secret_detected");          // DESIGN §7 的第四项检查
      for (const r of b.refs ?? []) {
        if (r?.name && (/^\//.test(r.name) || r.name.split("/").includes("..")))
          return err(422, `bad_ref_name:${r.name}`);
        const obj = await env.BLOBS.head(`p/${project}/artifacts/${r.sha256}`);
        if (!obj) return err(422, `blob_missing:${r.sha256}`);
      }
      const taskId = b.task_id === undefined || b.task_id === null || b.task_id === "" ? null : String(b.task_id);
      if (taskId !== null && !/^[a-zA-Z0-9._:-]{1,64}$/.test(taskId)) return err(422, "bad_task_id");
      await env.DB.prepare(
        `INSERT OR REPLACE INTO submissions
         (project, submission_id, agent_id, task_id, base_sha, kind, title, refs_json, checks_json, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'delivered', ?, ?)`
      ).bind(project, b.submission_id, b.agent_id, taskId, b.base_sha, b.kind, b.title ?? "",
             JSON.stringify(b.refs ?? []), JSON.stringify(b.checks ?? {}), Date.now(), Date.now()).run();
      const seq = await stub.fetch(new Request("https://do/publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, sender: b.agent_id, topic: "artifact", kind: b.kind,
                               payload: { submission_id: b.submission_id, task_id: taskId }, dedupe_key: `sub:${b.submission_id}` }),
      }));
      return Response.json({ submission_id: b.submission_id, state: "delivered", seq: await seq.json() });
    }

    const bun = action.match(/^submissions\/([^/]+)\/bundle$/);
    if (bun && req.method === "GET") return bundleSubmission(env, project, bun[1]);

    if (action === "submissions" && req.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      const valid = ["delivered", "collected", "archived"].includes(state);
      const sql = valid
        ? `SELECT * FROM submissions WHERE project = ? AND state = ? ORDER BY created_at DESC LIMIT 100`
        : `SELECT * FROM submissions WHERE project = ? ORDER BY created_at DESC LIMIT 100`;
      const stmt = valid
        ? env.DB.prepare(sql).bind(project, state)
        : env.DB.prepare(sql).bind(project);
      const rows = await stmt.all();
      return Response.json(rows.results);
    }

    const col = action.match(/^submissions\/([^/]+)\/(collect|archive|result)$/);
    if (col && req.method === "POST") {
      const [, id, op] = col;
      const row = await env.DB.prepare(
        "SELECT submission_id, task_id FROM submissions WHERE project = ? AND submission_id = ?"
      ).bind(project, id).first<any>();
      if (!row) return err(404, "submission_not_found");
      if (op === "result") {
        const b: any = await req.json().catch(() => ({}));
        await env.DB.prepare(`UPDATE submissions SET result = ?, updated_at = ? WHERE project = ? AND submission_id = ?`)
          .bind(b.result, Date.now(), project, id).run();
        return Response.json({ ok: true });
      }
      const state = op === "collect" ? "collected" : "archived";
      await env.DB.prepare(`UPDATE submissions SET state = ?, updated_at = ? WHERE project = ? AND submission_id = ?`)
        .bind(state, Date.now(), project, id).run();
      // 联动：这件交付挂在某个任务上时，通知 DO 重算该任务的待取数；
      // 任务处于 released 且待取归零，DO 会把它收成 done。
      // 通知失败不回滚已落库的取走状态，但必须在响应里响亮标出，不许静默脱钩。
      let taskLink: any = null;
      if (row.task_id) {
        try {
          const dr = await stub.fetch(new Request("https://do/tasks/submission-settled", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project, task_id: row.task_id, submission_id: id, sender: "admin" }),
          }));
          taskLink = await dr.json().catch(() => null);
          if (!dr.ok) taskLink = { error: "do_http_" + dr.status, detail: taskLink };
        } catch (e: any) {
          taskLink = { error: "do_unreachable", detail: String(e?.message ?? e) };
        }
      }
      return Response.json({ ok: true, task_link: taskLink });
    }
  }

  // 把一个已有 agent 以同 agent_id 加入目标项目，或从源项目迁移过去。
  // 数据模型仍是“项目内 agent + 项目 token”；这里不重写 membership，只签发目标 token。
  if (p === "/admin/agents/move" && req.method === "POST") {
    const b: any = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return err(400, "bad_json");
    if (!/^[a-z0-9-]{2,40}$/.test(String(b.from_project ?? ""))) return err(422, "bad_from_project");
    if (!/^[a-z0-9-]{2,40}$/.test(String(b.to_project ?? ""))) return err(422, "bad_to_project");
    if (b.from_project === b.to_project) return err(422, "same_project");
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(String(b.agent_id ?? ""))) return err(422, "bad_agent_id");
    const keepSource = b.keep_source === true;
    const ttlDays = b.ttl_days === undefined ? 30 : Number(b.ttl_days);
    if (!Number.isFinite(ttlDays) || ttlDays < 0 || ttlDays > 3650) return err(422, "bad_ttl");

    const targetProject = await env.DB.prepare("SELECT status FROM projects WHERE project = ?")
      .bind(b.to_project).first<any>();
    if (!targetProject || targetProject.status !== "active") return err(404, "target_project_not_found");

    const source = await env.DB.prepare(
      `SELECT role, scopes FROM agents
        WHERE project = ? AND agent_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC LIMIT 1`
    ).bind(b.from_project, b.agent_id, Date.now()).first<any>();
    if (!source) return err(404, "source_agent_not_found");
    const role = source.role === "admin" ? "admin" : "agent";
    const scopes = String(source.scopes || "").split(",").map((x: string) => x.trim()).filter(Boolean);
    if (!scopes.length) return err(422, "source_agent_has_no_scopes");

    const targetSame = await env.DB.prepare(
      `SELECT 1 FROM agents
        WHERE project = ? AND agent_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
    ).bind(b.to_project, b.agent_id, Date.now()).first<any>();
    const q = await projectQuota(env, b.to_project);
    const n = await activeAgentCount(env, b.to_project);
    if (!targetSame && n >= q.maxAgents) return err(409, `agent_quota_exceeded:${n}/${q.maxAgents}`);

    const plain = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = ttlDays > 0 ? Date.now() + ttlDays * 86400_000 : null;
    await env.DB.prepare("UPDATE agents SET revoked_at = ? WHERE project = ? AND agent_id = ? AND revoked_at IS NULL")
      .bind(Date.now(), b.to_project, b.agent_id).run();
    await env.DB.prepare(
      `INSERT INTO agents (project, agent_id, role, scopes, token_sha, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(b.to_project, b.agent_id, role, scopes.join(","), await sha256(plain), Date.now(), expiresAt).run();
    if (!keepSource) {
      await env.DB.prepare("UPDATE agents SET revoked_at = ? WHERE project = ? AND agent_id = ? AND revoked_at IS NULL")
        .bind(Date.now(), b.from_project, b.agent_id).run();
    }
    return Response.json({
      token: plain, agent_id: b.agent_id, from_project: b.from_project,
      to_project: b.to_project, role, scopes: scopes.join(","),
      expires_at: expiresAt, ttl_days: ttlDays, kept_source: keepSource,
    });
  }

  if (p === "/admin/agents" && req.method === "POST") {
    const b: any = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return err(400, "bad_json");
    if (!/^[a-z0-9-]{2,40}$/.test(String(b.project ?? ""))) return err(422, "bad_project_name");
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(String(b.agent_id ?? ""))) return err(422, "bad_agent_id");
    const role = b.role ?? "agent";
    if (role !== "admin" && role !== "agent") return err(422, "bad_role");
    const proj = await env.DB.prepare("SELECT status FROM projects WHERE project = ?").bind(b.project).first<any>();
    if (!proj || proj.status !== "active") return err(404, "project_not_found");

    // 只接受已知 scope；缺省按角色给默认集，管理员绝不能签发成没有 admin 权限的假管理员。
    let list: string[];
    if (b.scopes === undefined || b.scopes === null || b.scopes === "") {
      list = role === "admin" ? [...ADMIN_SCOPES] : [...AGENT_SCOPES];
    } else if (typeof b.scopes === "string") {
      list = b.scopes.split(",").map((x: string) => x.trim()).filter(Boolean);
    } else if (Array.isArray(b.scopes)) {
      list = b.scopes.map((x: any) => String(x).trim()).filter(Boolean);
    } else {
      return err(422, "bad_scopes");
    }
    const unknown = list.filter((x) => !ALL_SCOPES.has(x));
    if (unknown.length) return err(422, `unknown_scopes:${unknown.join(",")}`);
    if (!list.length) return err(422, "empty_scopes");
    if (role !== "admin" && list.includes("admin")) return err(422, "admin_scope_requires_admin");
    if (role === "admin" && !list.includes("admin")) list.unshift("admin");

    const plain = crypto.randomUUID().replace(/-/g, "");
    // 有效期：默认 30 天；ttl_days=0 表示不限期（仅限集成者显式指定）
    const ttlDays = b.ttl_days === undefined ? 30 : Number(b.ttl_days);
    if (!Number.isFinite(ttlDays) || ttlDays < 0 || ttlDays > 3650) return err(422, "bad_ttl");
    const expiresAt = ttlDays > 0 ? Date.now() + ttlDays * 86400_000 : null;
    // 已有活跃 token 的同一 agent 换钥不新增 agent 数；新 agent 才受 max_agents 限制。
    const prev = await env.DB.prepare(
      "SELECT 1 FROM agents WHERE project = ? AND agent_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1"
    ).bind(b.project, b.agent_id, Date.now()).first<any>();
    {
      const q = await projectQuota(env, b.project);
      const n = await activeAgentCount(env, b.project);
      if (!prev && n >= q.maxAgents) return err(409, `agent_quota_exceeded:${n}/${q.maxAgents}`);
    }
    // 同一 agent 重签默认立即作废旧 token；显式 rotate:false 才保留多钥。
    if (b.rotate !== false) {
      await env.DB.prepare("UPDATE agents SET revoked_at = ? WHERE project = ? AND agent_id = ? AND revoked_at IS NULL")
        .bind(Date.now(), b.project, b.agent_id).run();
    }
    await env.DB.prepare(
      `INSERT INTO agents (project, agent_id, role, scopes, token_sha, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(b.project, b.agent_id, role, list.join(","), await sha256(plain), Date.now(), expiresAt).run();
    return Response.json({ token: plain, agent_id: b.agent_id, role, scopes: list.join(","), expires_at: expiresAt, ttl_days: ttlDays });
  }

  // 吊销：某 agent 名下所有未吊销 token 全失效
  if (p === "/admin/agents" && req.method === "DELETE") {
    const b: any = await req.json().catch(() => ({}));
    if (!b.project || !b.agent_id) return err(422, "project_and_agent_required");
    const r = await env.DB.prepare(
      "UPDATE agents SET revoked_at = ? WHERE project = ? AND agent_id = ? AND revoked_at IS NULL"
    ).bind(Date.now(), b.project, b.agent_id).run();
    return Response.json({ ok: true, revoked_keys: r.meta.changes });
  }

  return err(404, "unknown_admin_action");
}


// ── 交付打包（ZIP STORE，自写，不引依赖）──────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(u8: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

  for (const f of files) {
    const nameB = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = [
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(nameB.length), u16(0),
    ];
    const localSize = 30 + nameB.length;
    chunks.push(...local, nameB, f.data);
    central.push(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(nameB.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameB
    );
    offset += localSize + f.data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }
  chunks.push(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
              u32(cdSize), u32(cdStart), u16(0));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

async function bundleSubmission(env: Env, project: string, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM submissions WHERE project = ? AND submission_id = ?").bind(project, id).first<any>();
  if (!row) return err(404, "submission_not_found");
  let refs: any[] = [];
  try { refs = JSON.parse(row.refs_json ?? "[]"); } catch { refs = []; }

  const files: { name: string; data: Uint8Array }[] = [];
  let total = 0;
  for (const r of refs) {
    const sha = String(r.sha256 ?? "");
    if (!/^[a-f0-9]{64}$/.test(sha)) continue;
    const obj = await env.BLOBS.get(`p/${project}/artifacts/${sha}`);
    if (!obj) return err(422, `blob_missing:${sha}`);
    const buf = new Uint8Array(await obj.arrayBuffer());
    total += buf.length;
    if (total > 80 * 1024 * 1024) return err(413, "bundle_too_large");
    const safe = String(r.name ?? `${sha.slice(0, 12)}.bin`).replace(/^[^\w.-]+/, "").replace(/[^\w.-]+/g, "_");
    files.push({ name: safe || `${sha.slice(0, 12)}.bin`, data: buf });
  }

  let checks: any = {};
  try { checks = JSON.parse(row.checks_json ?? "{}"); } catch { checks = {}; }
  const prov = {
    project, submission_id: row.submission_id, agent_id: row.agent_id, base_sha: row.base_sha,
    kind: row.kind, title: row.title, state: row.state, checks,
    created_at: row.created_at, updated_at: row.updated_at,
    refs: refs.map((r) => ({ sha256: r.sha256, name: r.name, bytes: r.bytes })),
    generated_at: Date.now(), generator: "agent-hub bundle v1",
  };
  files.push({ name: "PROVENANCE.json", data: new TextEncoder().encode(JSON.stringify(prov, null, 2)) });

  const zip = zipStore(files);
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${project}-${id}.zip"`,
      "x-bundle-files": String(files.length),
      ...SEC_HEADERS,
    },
  });
}

// ── 交付创建（Worker 侧：R2 校验 + D1 落库 + 发消息）──────
async function createSubmission(req: Request, env: Env, project: string, agentId: string) {
  const b: any = await req.json().catch(() => ({}));
  if (!b.base_sha) return err(422, "base_sha_required");
  if (!/^[a-f0-9]{7,64}$/.test(String(b.base_sha))) return err(422, "base_sha_not_hex");
  if (!b.submission_id) return err(422, "submission_id_required");
  const scan = JSON.stringify({ title: b.title, refs: b.refs, checks: b.checks });
  if (/(AKIA[0-9A-Z]{16}|-----BEGIN[^"]{0,40}PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)/.test(scan))
    return err(422, "secret_detected");            // 交付卫生：不许把密钥带进仓库
  for (const r of (Array.isArray(b.refs) ? b.refs : [])) {
    if (r?.name && (/^\//.test(r.name) || r.name.split("/").includes("..")))
      return err(422, `bad_ref_name:${r.name}`);
  }
  const refs = Array.isArray(b.refs) ? b.refs : [];
  for (const r of refs) {
    // 兼容裸 sha 字符串：真实联调时就踩了这个坑——refs 传 ["<sha>"] 会被
    // 报成含义不明的 bad_ref_sha，调用方根本看不出该传对象。
    const rr: any = typeof r === "string" ? { sha256: r } : r;
    if (!/^[a-f0-9]{64}$/.test(String(rr?.sha256 ?? "")))
      return err(422, "bad_ref_sha: refs 需要 {sha256:<64位hex>}，也可直接传 sha 字符串");
    const head = await env.BLOBS.head(`p/${project}/artifacts/${rr.sha256}`);
    if (!head) return err(422, `blob_missing:${rr.sha256}`);
  }
  const taskId = b.task_id === undefined || b.task_id === null || b.task_id === "" ? null : String(b.task_id);
  if (taskId !== null && !/^[a-zA-Z0-9._:-]{1,64}$/.test(taskId)) return err(422, "bad_task_id");
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO submissions
     (project, submission_id, agent_id, task_id, base_sha, kind, title, refs_json, checks_json, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'delivered', ?, ?)`
  ).bind(project, b.submission_id, agentId, taskId, b.base_sha, b.kind ?? "patch", b.title ?? "",
         JSON.stringify(refs), JSON.stringify(b.checks ?? {}), now, now).run();

  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  const seqRes = await stub.fetch(new Request("https://do/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, sender: agentId, topic: "artifact", kind: b.kind ?? "patch",
                           payload: { submission_id: b.submission_id, task_id: taskId, base_sha: b.base_sha,
                                      title: b.title ?? "", agent_id: agentId },
                           dedupe_key: `sub:${b.submission_id}` }),
  }));
  const seq = await seqRes.json<any>().catch(() => ({}));
  return json({ submission_id: b.submission_id, state: "delivered",
                deduped: res.meta.changes === 0, seq: seq.seq ?? null });
}

// ── 会话（HttpOnly cookie + HMAC 签名）─────────────────────
const SEC_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-cache, must-revalidate",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; " +
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
    "script-src-elem 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
    "worker-src 'self'; " +                                                      // 缺这一条 sw.js 会被 CSP 拦死
    "style-src 'unsafe-inline'; connect-src 'self' wss://synapse.wangda.today ws://synapse.wangda.today https://cloudflareinsights.com; " +
    "img-src 'self' data:; manifest-src 'self'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
};
const secHeaders = (ct: string) => ({ "content-type": ct, ...SEC_HEADERS });

// 常量时间比较：避免签名逐字节提前返回（侧信道）
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sessEpoch(env: Env): Promise<string> {
  try {
    const r = await env.DB.prepare("SELECT value FROM settings WHERE key='sess_epoch'").first<any>();
    return String(r?.value ?? "0");
  } catch { return "0"; }          // 表还没建时退化为 0，不阻塞登录
}

async function makeSession(agentId: string, secret: string, ep = "0") {
  const exp = Date.now() + 8 * 3600_000;
  // 身份必须 base64url 编码：Access 邮箱形如 gradetwo@gmail.com，含 "." 会把
  // 点分字段切坏（线上实测 session 恒为 false 的根因）。
  const who = b64urlEncode(agentId);
  const payload = `${exp}.${who}.${ep}`;
  const sig = await hmacHex(secret, payload);
  return `hub_sess=v2.${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`;
}

async function readSession(req: Request, env: Env): Promise<string | null> {
  const raw = req.headers.get("cookie") ?? "";
  const m = raw.match(/(?:^|;\s*)hub_sess=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 4 && parts.length !== 5) return null;
  // 5 段格式是 v2.exp.who.ep.sig（epoch 在签名前、签名永远最后一段）
  const [ver, exp, who, fourth, fifth] = parts;
  if (ver !== "v2" && ver !== "v1") return null;
  if (Number(exp) < Date.now()) return null;
  const hasEp = parts.length === 5;
  const ep = hasEp ? fourth : "0";
  const sig = hasEp ? fifth : fourth;
  const whoRaw = who;
  const payload = hasEp ? `${exp}.${whoRaw}.${ep}` : `${exp}.${whoRaw}`;
  const want = await hmacHex(env.SESSION_SECRET, payload);
  if (!ctEq(want, sig)) return null;
  if (ep !== (await sessEpoch(env))) return null;          // 旧格式按 0 算，epoch 变了同样失效


  return ver === "v2" ? new TextDecoder().decode(b64urlToBytes(whoRaw)) : whoRaw;
}


// ── 登录防护：阶梯封禁 ──────────────────────────────────────
// 5 次失败 → 30 分钟；10 次 → 24 小时；20 次 → 永久（blocked_until = -1）
const IP_FAIL_BLOCK = [[5, 30 * 60_000], [10, 24 * 3600_000], [20, -1]] as [number, number][];

async function guardCheck(ip: string, env: Env) {
  const row = await env.DB.prepare("SELECT fails, blocked_until FROM login_guard WHERE ip = ?").bind(ip).first<any>();
  if (!row) return { blocked: false, retry: 0, permanent: false };
  const until = Number(row.blocked_until ?? 0);
  if (until === -1) return { blocked: true, retry: 0, permanent: true };
  if (until > Date.now()) return { blocked: true, permanent: false, retry: Math.ceil((until - Date.now()) / 1000) };
  return { blocked: false, retry: 0, permanent: false };
}

async function guardFail(ip: string, env: Env) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO login_guard (ip, fails, first_fail_at, blocked_until) VALUES (?, 1, ?, 0)
     ON CONFLICT(ip) DO UPDATE SET
       fails = fails + 1,
       first_fail_at = CASE WHEN first_fail_at = 0 THEN ? ELSE first_fail_at END,
       blocked_until = CASE
         WHEN fails + 1 >= 20 THEN -1
         WHEN fails + 1 >= 10 THEN ? + 86400000
         WHEN fails + 1 >= 5  THEN ? + 1800000
         ELSE blocked_until END`
  ).bind(ip, now, now, now, now).run();
}

async function guardReset(ip: string, env: Env) {
  await env.DB.prepare("DELETE FROM login_guard WHERE ip = ?").bind(ip).run();
}


// 全局失败阈值（防代理池轮换 IP）：60 秒内累计 >= 60 次失败 ⇒ 节流 60 秒
const GLOBAL_KEY = "__global__";

async function globalFail(env: Env) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO login_guard (ip, fails, first_fail_at, blocked_until) VALUES (?, 1, ?, 0)
     ON CONFLICT(ip) DO UPDATE SET
       fails = fails + 1,
       first_fail_at = CASE WHEN ? - first_fail_at > 60000 THEN ? ELSE first_fail_at END
     WHERE ip = ?`).bind(GLOBAL_KEY, now, now, now, GLOBAL_KEY).run();
}

async function globalCheck(env: Env) {
  const row = await env.DB.prepare("SELECT fails, first_fail_at, blocked_until FROM login_guard WHERE ip = ?")
    .bind(GLOBAL_KEY).first<any>();
  if (!row) return { blocked: false, retry: 0 };
  const now = Date.now();
  if (Number(row.blocked_until) > now) return { blocked: true, retry: Math.ceil((row.blocked_until - now) / 1000) };
  const windowLive = now - Number(row.first_fail_at) < 60000;
  if (windowLive && Number(row.fails) >= 60) {
    const until = now + 60000;
    await env.DB.prepare("UPDATE login_guard SET blocked_until = ? WHERE ip = ?").bind(until, GLOBAL_KEY).run();
    return { blocked: true, retry: 60 };
  }
  return { blocked: false, retry: 0 };
}

// ── Cloudflare Access JWT 验签（RS256 + aud + exp）─────────
let jwksCache: { at: number; keys: any[] } = { at: 0, keys: [] };

async function accessKeys(team: string) {
  if (Date.now() - jwksCache.at < 3600_000 && jwksCache.keys.length) return jwksCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) return [];
  const j = await res.json<any>();
  jwksCache = { at: Date.now(), keys: j.keys ?? [] };
  return jwksCache.keys;
}

function b64urlEncode(s: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
}

/** 真验签：Access 的 JWT 由 CF 用 RS256 私钥签，公开 JWKS 验。 */
async function verifyAccessJwt(req: Request, env: Env): Promise<{ email?: string } | null> {
  const team = (env.CF_ACCESS_TEAM_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = env.CF_ACCESS_AUD ?? "";
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!team || !aud || !jwt) return null;            // 未配置 Access ⇒ 走 cookie 网关

  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  if (header.alg !== "RS256") return null;
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  if (payload.exp * 1000 < Date.now()) return null;
  // 只认本应用的 aud：iss 兜底等于放行同团队其它 Access 应用的 JWT（越权面）
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
  if (!audOk) return null;

  const keys = await accessKeys(team);
  const jwk = keys.find((k) => k.kid === header.kid) ?? keys[0];
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`));
  return ok ? { email: payload.email } : null;
}

// ── 工具 ───────────────────────────────────────────────────
async function loadPolicy(env: Env): Promise<{ mode: "all" | "list"; projects: string[] }> {
  const row = await env.DB.prepare("SELECT mode, projects_json FROM admin_policy WHERE scope = '*'").first<any>();
  if (!row) return { mode: "all", projects: [] };        // 默认看全部
  let projects: string[] = [];
  try { projects = JSON.parse(row.projects_json ?? "[]"); } catch { projects = []; }
  return { mode: row.mode === "list" ? "list" : "all", projects };
}

async function r2Sha(env: Env, key: string): Promise<string> {
  const obj = await env.BLOBS.get(key);
  if (!obj) return "";
  let sha = String((obj as any).customMetadata?.sha256 ?? "");
  if (!sha) {
    const buf = new Uint8Array(await obj.arrayBuffer());
    sha = await sha256Bytes(buf);
    try { await env.BLOBS.put(key, buf, { customMetadata: { sha256: sha } }); } catch {}
  }
  return sha;
}

async function sha256Bytes(buf: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "x-hub": "1" } });
const err = (status: number, reason: string) => json({ error: reason }, status);
const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
const text = (s: string, ct: string) => new Response(s, { headers: { "content-type": ct } });

const LANDING = `<!doctype html><meta charset="utf-8"><title>Synapse</title>
<h1>agent-hub</h1><p>API: <code>/p/{project}/…</code> · console: <code>/console</code>（需登录）</p>`;

// 未认证时只返回这一页：不含任何控制台代码、不含项目信息
const MANIFEST = JSON.stringify({
  name: "agent-hub 控制台", short_name: "agent-hub",
  start_url: "/console", scope: "/", display: "standalone",
  background_color: "#0e1116", theme_color: "#0e1116",
  description: "多 agent 协作中枢：名册、交付箱、注册审批、封禁管理",
  icons: [
    { src: "/dl/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/dl/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
  ]
});

const SW_JS = `
const SHELL = ["/dl/icon-192.png", "/dl/icon-512.png", "/manifest.webmanifest"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
  self.skipWaiting();
  // 逐个预缓存并容忍失败：addAll 里只要有一个非 2xx（例如 /console 需要 Access 会话）
  // 整个 install 就会 reject，日志里就是那条 net::ERR_FAILED。
  e.waitUntil(caches.open("hub-v2").then((c) =>
    Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== "hub-v2") await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.pathname.startsWith("/admin")) {
    // 数据接口不做离线缓存：宁可失败，也不展示过期状态
    return;
  }
  if (u.pathname.startsWith("/dl/")) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
    return;
  }
  if (u.pathname === "/console" || u.pathname === "/manifest.webmanifest") {
    // 纯网络，且失败时不回退缓存：宁可看到报错，也不要让用户以为"改了没生效"
    e.respondWith(fetch(e.request, { cache: "no-store" }));
  }
});
`;

const GATE_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要登录</title>
<style>
  :root{--bg:#0e1116;--fg:#e6ebf2;--dim:#8b95a5;--line:#232a33;--accent:#4c8dff}
  body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
       font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .box{width:min(380px,88vw);border:1px solid var(--line);border-radius:12px;padding:22px;
       background:#151a21;display:grid;gap:12px}
  h1{font-size:15px;margin:0}
  p{color:var(--dim);font-size:12px;margin:0}
  input,button{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);
       background:#1b222b;color:var(--fg)}
  input{font-family:ui-monospace,Menlo,monospace}
  button{background:var(--accent);border-color:var(--accent);color:#0b0f14;font-weight:600;cursor:pointer}
  .err{color:#f85149;font-size:12px;min-height:16px}
</style>
<div class="box">
  <h1>需要管理凭证</h1>
  <p>此页面仅对已授权会话开放。凭证通过服务端校验后写入 HttpOnly Cookie，不在页面或地址栏中暴露。</p>
  <input id="t" type="password" placeholder="admin token" autocomplete="off" autofocus>
  <div class="err" id="e"></div>
  <button id="go">登录</button>
</div>
<script>
async function go(){
  const t=document.getElementById("t").value.trim();
  const e=document.getElementById("e");
  if(!t){ e.textContent="请输入凭证"; return; }
  e.textContent="";
  try{
    const r=await fetch("/auth/login",{method:"POST",headers:{"content-type":"application/json"},
      credentials:"same-origin",body:JSON.stringify({token:t})});
    if(r.ok){ location.reload(); return; }
    e.textContent = r.status===401 ? "凭证无效" : ("登录失败 "+r.status);
  }catch(_){ e.textContent="网络错误"; }
}
document.getElementById("go").onclick=go;
document.getElementById("t").addEventListener("keydown",ev=>{ if(ev.key==="Enter") go(); });
</script>`;

