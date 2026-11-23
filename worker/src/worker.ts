// Worker：唯一入口。data plane = /p/{project}/…（agent token）
//                      control plane = /admin/…（admin token 或 Access 已通过）
import { Env } from "./types";
import CONSOLE_HTML from "../../admin/index.html";
export { ProjectRoom } from "./project-room";

const AGENT_SCOPES = ["poll", "ack", "report", "heartbeat", "publish", "tasks.claim", "tasks.release",
                      "artifact.write", "submissions.create", "issues.report"];
const ADMIN_SCOPES = ["admin", ...AGENT_SCOPES, "artifact.read"];
const ALL_SCOPES = new Set([...ADMIN_SCOPES, ...AGENT_SCOPES]);

// 公开版本探针：只看构建标记，不含任何项目数据/凭据
const BUILD_TAG = "issue-self-assign-20261123";
// SDK 发版号：客户端据此判断是否需要自我升级（与二进制 sha 一起下发，防中间人换包）
const SDK_VERSION = "0.5.3";

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
      try { return await admin(req, env, u2); }
      catch (e) { console.warn("console admin route failed", e); return dbUnavailable(); }
    }

    // 受 Access 保护的子路径：把 Access 身份换成 8 小时 HttpOnly 会话 cookie。
    // 这样即使 Access 只覆盖 /console（不覆盖 /admin），后续 XHR 也能凭 cookie 通过。
    // 诊断：只回 header 名字与判定，不回任何值（不含敏感信息）
    if (path === "/console/debug") {
      const via = await verifyAccessJwt(req, env);
      const cookieId = await accessIdentityFromCookie(req);
      const identity = via?.email ?? cookieId;
      if (identity && !adminEmailAllowed(env, identity))
        return new Response(JSON.stringify({ error: "admin_required" }), {
          status: 403, headers: { "content-type": "application/json", ...SEC_HEADERS },
        });
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
      const via = await verifyAccessJwt(req, env);
      const cookieId = await accessIdentityFromCookie(req);
      const sess = await readSession(req, env);
      if (!sess && !via && !cookieId) return err(401, "unauthorized");
      const email = via?.email ?? cookieId ?? (sess?.includes("@") ? sess : "");
      if (email && !adminEmailAllowed(env, email)) return err(403, "admin_required");
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
      if (!adminEmailAllowed(env, who)) return new Response(JSON.stringify({ ok: false, error: "admin_required" }), {
        status: 403, headers: { "content-type": "application/json", ...SEC_HEADERS },
      });
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
      if (identity && !adminEmailAllowed(env, identity))
        return new Response(GATE_HTML, { status: 403, headers: secHeaders("text/html; charset=utf-8") });
      const sessionWho = identity ? "" : await readSession(req, env);
      if (!identity && sessionWho?.includes("@") && !adminEmailAllowed(env, sessionWho))
        return new Response(GATE_HTML, { status: 403, headers: secHeaders("text/html; charset=utf-8") });
      const sess = identity ?? sessionWho;
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
      let g: Awaited<ReturnType<typeof globalCheck>>;
      let gate: Awaited<ReturnType<typeof guardCheck>>;
      try {
        g = await globalCheck(env);
        gate = await guardCheck(ip, env);
      } catch (e) {
        console.warn("login guard db unavailable", e);
        return dbUnavailable();
      }
      if (g.blocked) {
        return new Response(JSON.stringify({ error: "too_many_attempts", retry_after_s: g.retry }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": String(g.retry), ...SEC_HEADERS },
        });
      }
      if (gate.blocked) {
        return new Response(JSON.stringify({ error: gate.permanent ? "ip_blocked" : "too_many_attempts",
                                             retry_after_s: gate.retry }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": String(gate.retry), ...SEC_HEADERS },
        });
      }
      const b: any = await req.json().catch(() => ({}));
      const raw = String(b.token ?? "").trim();
      if (!raw) { await guardFail(ip, env).catch(() => {}); await globalFail(env).catch(() => {}); return err(401, "bad_credentials"); }
      const sha = await sha256(raw);
      let row: any;
      try {
        row = await env.DB.prepare(
          `SELECT agent_id FROM agents WHERE token_sha = ? AND role = 'admin' AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`
        ).bind(sha, Date.now()).first<any>();
      } catch (e) {
        console.warn("login token lookup failed", e);
        return dbUnavailable();
      }
      if (!row) { await guardFail(ip, env).catch(() => {}); await globalFail(env).catch(() => {}); return err(401, "bad_credentials"); }
      await guardReset(ip, env).catch(() => {});
      const cookie = await makeSession(row.agent_id, env.SESSION_SECRET, await sessEpoch(env));
      return new Response(JSON.stringify({ ok: true, agent: row.agent_id }), {
        headers: { "content-type": "application/json", "set-cookie": cookie, ...SEC_HEADERS },
      });
    }

    if (path.startsWith("/admin/")) {
      try { return await admin(req, env, url); }
      catch (e) { console.warn("admin route failed", e); return dbUnavailable(); }
    }

    // 机器通路（CLI/agent）：不在 Access 覆盖范围内，只认 Bearer token
    if (path.startsWith("/x/admin/")) {
      const u2 = new URL(url.toString());
      u2.pathname = path.replace(/^\/x\/admin/, "/admin");
      try { return await admin(req, env, u2); }
      catch (e) { console.warn("x-admin route failed", e); return dbUnavailable(); }
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
      const winX64Key = "bin/synapse-agent-x86_64-windows-msvc.exe";
      const macX64Key = "bin/synapse-agent-x86_64-apple-darwin";
      const macArm64Key = "bin/synapse-agent-aarch64-apple-darwin";
      const [shaX64, shaArm64, shaX64Gnu, shaArm64Gnu, shaWinX64, shaMacX64, shaMacArm64] = await Promise.all([
        r2Sha(env, x64Key),
        r2Sha(env, arm64Key),
        r2Sha(env, x64GnuKey),
        r2Sha(env, arm64GnuKey),
        r2Sha(env, winX64Key),
        r2Sha(env, macX64Key),
        r2Sha(env, macArm64Key),
      ]);
      const binaries: any[] = [];
      if (shaX64) binaries.push({ platform: "linux-x86_64", url: "/dl/synapse-agent-x86_64-linux-musl", sha256: shaX64 });
      if (shaArm64) binaries.push({ platform: "linux-aarch64", url: "/dl/synapse-agent-aarch64-linux-musl", sha256: shaArm64 });
      if (shaX64Gnu) binaries.push({ platform: "linux-x86_64-gnu", url: "/dl/synapse-agent-x86_64-linux-gnu", sha256: shaX64Gnu });
      if (shaArm64Gnu) binaries.push({ platform: "linux-aarch64-gnu", url: "/dl/synapse-agent-aarch64-linux-gnu", sha256: shaArm64Gnu });
      if (shaWinX64) binaries.push({ platform: "windows-x86_64", url: "/dl/synapse-agent-x86_64-windows-msvc.exe", sha256: shaWinX64 });
      if (shaMacX64) binaries.push({ platform: "darwin-x86_64", url: "/dl/synapse-agent-x86_64-apple-darwin", sha256: shaMacX64 });
      if (shaMacArm64) binaries.push({ platform: "darwin-aarch64", url: "/dl/synapse-agent-aarch64-apple-darwin", sha256: shaMacArm64 });
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

    // Issue 上报同样在 Worker 侧写 D1；权限对所有 agent 默认放行（见 inScope）。
    if (action === "issues" && req.method === "POST")
      return createIssue(req, env, project, auth.agentId!);

    // 上报者自助转任务：只允许 issue.reporter 本人，且必须仍是 open 且未派发。
    // 不能复用管理员的 /dispatch 路由，否则普通 agent 可以替别人派单。
    const issueTake = action.match(/^issues\/([A-Za-z0-9._:-]{1,128})\/take$/);
    if (issueTake && req.method === "POST")
      return takeIssue(req, env, project, auth.agentId!, issueTake[1]);

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

  // cron：逐项目回收过期租约 + 归档/心跳历史清理；每个项目独立失败，不中断后续项目
  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const rows = await env.DB.prepare(
      "SELECT project, retention_days FROM projects WHERE status='active'"
    ).all<{ project: string; retention_days: number }>();
    ctx.waitUntil((async () => {
      for (const r of rows.results) {
        try {
          const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + r.project));
          await stub.fetch(new Request("https://do/cron/tick"));
          // F2 收尾：归档按项目 retention_days 清理，避免无限增长
          const days = Math.max(1, Number(r.retention_days ?? 30));
          const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
          await env.DB.prepare("DELETE FROM archive WHERE project = ? AND ts < ?")
            .bind(r.project, cutoff).run().catch(() => {});
          // hb_hist 只保留 14 天（5 分钟一个 bucket，14 天 = 4032 个桶）
          const hbCutoff = Math.floor(Date.now() / 300_000) - 4032;
          await env.DB.prepare("DELETE FROM hb_hist WHERE project = ? AND bucket < ?")
            .bind(r.project, hbCutoff).run().catch(() => {});
        } catch (e) {
          console.warn("cron project failed", r.project, e);
        }
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

/** 管理台第二道门：Access 邮箱必须命中白名单。默认只允许仓库主，
 *  部署到别的团队时用 ADMIN_EMAILS（逗号分隔）覆盖。 */
function adminEmailAllowed(env: Env, email?: string | null): boolean {
  if (!email) return false;
  const allow = String(env.ADMIN_EMAILS ?? "gradetwo@gmail.com")
    .split(/[,\s]+/).filter(Boolean).map((e) => e.toLowerCase());
  return allow.includes(email.toLowerCase());
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
                   "tasks.claim", "tasks.release",
                   "submissions.create", "artifact.write", "artifact.read"];
  const bad = listScopes.filter((x) => x && !allowed.includes(x));
  if (bad.length) return err(422, `bad_scope:${bad.join(",")}`);
  const scopes = listScopes.filter(Boolean).length
    ? [...new Set(listScopes.filter(Boolean))].join(",")
    : allowed.join(",");
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
  try {
    await env.DB.prepare(
      "INSERT INTO ws_tickets (ticket,project,agent_id,role,exp_ms,used) VALUES (?,?,?,?,?,0)"
    ).bind(ticket, project, auth.agentId, auth.role, exp).run();
  } catch (e) {
    console.warn("ws-ticket insert failed", e);
    return dbUnavailable();
  }
  // 顺手清掉过期票，避免表无限增长；清理失败不影响出票
  await env.DB.prepare("DELETE FROM ws_tickets WHERE exp_ms < ?").bind(Date.now() - 3600_000).run().catch(() => {});
  return json({ ticket, exp_ms: exp, ttl_s: 90 });
}

/** 升级为 WebSocket 并转给 DO（连接由 DO 持有，可休眠） */
async function wsConnect(req: Request, env: Env, project: string, url: URL) {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
    return err(426, "upgrade_required");
  const ticket = url.searchParams.get("ticket") ?? "";
  let agentId = "", role = "";

  try {
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
  } catch (e) {
    console.warn("ws connect db failed", e);
    return dbUnavailable();
  }

  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  return stub.fetch(new Request("https://do/ws", {
    headers: { upgrade: "websocket", "x-agent-id": agentId, "x-role": role },
  }));
}

async function authenticate(req: Request, env: Env, project: string) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return { ok: false, status: 401, reason: "missing_token" as string };
  const sha = await sha256(bearer);
  let row: any;
  try {
    row = await env.DB.prepare(
      `SELECT a.agent_id, a.role, a.scopes, a.revoked_at, a.expires_at, p.status
         FROM agents a JOIN projects p ON p.project = a.project
        WHERE a.token_sha = ? AND a.project = ?`
    ).bind(sha, project).first<any>();
  } catch (e) {
    console.warn("token lookup failed", e);
    return { ok: false, status: 503, reason: "db_unavailable" as string };
  }
  if (!row) return { ok: false, status: 401, reason: "unauthorized" };
  if (row.revoked_at) return { ok: false, status: 401, reason: "unauthorized" };
  if (row.expires_at && row.expires_at < Date.now()) return { ok: false, status: 401, reason: "unauthorized" };
  return { ok: true, agentId: row.agent_id, role: row.role,
           scopes: String(row.scopes ?? "").split(",").filter(Boolean),
           projectStatus: row.status, status: 200, reason: "" };
}

function need(action: string) {
  if (action.startsWith("heartbeat")) return "heartbeat";
  if (action.startsWith("ack")) return "ack";
  if (action.startsWith("report")) return "report";
  if (action.startsWith("inbox")) return "poll";
  if (action === "tasks/claim") return "tasks.claim";
  if (action === "tasks/release") return "tasks.release";
  if (action.startsWith("tasks/admin-")) return "admin";
  if (action === "tasks/list" || action === "tasks/get") return "admin"; // 台账/单任务元数据不对普通 agent 开放
  if (action === "tasks/create") return "admin";                        // 建单只允许管理端
  if (action === "issues" || action.startsWith("issues/")) return "issues.report";
  if (action.startsWith("submissions")) return "submissions.create";
  return "publish";
}
const inScope = (s: string[], n: string) => {
  // 需求：上报 issue 默认对所有 agent 开放。不能只靠新 token 的 scope，
  // 存量 token 的 scopes 里没有 issues.report，也必须在数据面放行。
  if (n === "issues.report") return true;
  return s.includes(n) || s.includes("admin") ||
    // 兼容：存量 token 只有 publish，给它们继续走 claim/release 的过渡期。
    ((n === "tasks.claim" || n === "tasks.release") && s.includes("publish"));
};

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
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > 0 && declared > limit) return err(413, "too_large");
    const buf = new Uint8Array(await req.arrayBuffer());     // chunked 仍会在读完后按字节数兜底
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
  let identityEmail = "";
  let viaSession = false;
  let sessionWho = "";

  if (bearer) {
    const sha = await sha256(bearer);
    const row = await env.DB.prepare(
      `SELECT role FROM agents WHERE token_sha = ? AND role = 'admin' AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`
    ).bind(sha, Date.now()).first<any>();
    authorized = !!row;
  } else {
    // 浏览器：Access JWT（验签）/ Access cookie 身份 / HttpOnly 会话 cookie
    const jwt = await verifyAccessJwt(req, env);
    if (jwt) { authorized = true; identityEmail = String(jwt.email ?? ""); }
    if (!authorized) {
      const cookieEmail = await accessIdentityFromCookie(req);
      if (cookieEmail) { authorized = true; identityEmail = cookieEmail; }
    }
    if (!authorized) {
      const sess = await readSession(req, env);
      if (sess) { authorized = true; viaSession = true; sessionWho = sess; }
    }
  }
  if (authorized && !bearer) {
    // 第二道门：Access 身份 / 旧 Access 会话必须命中管理员邮箱白名单。
    // sessionWho 里带 @ 的是 Access 身份换来的会话；admin token 换来的会话不是邮箱。
    const email = viaSession ? (sessionWho.includes("@") ? sessionWho : "") : identityEmail;
    if (viaSession && !email) {
      // admin token 登录的会话，角色在签发时已经验过
    } else if (!adminEmailAllowed(env, email)) {
      const r = err(403, "admin_required");
      r.headers.set("x-hub-auth", "not_admin");
      return r;
    }
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
    const fresh = url.searchParams.get("fresh") === "1";
    if (!fresh) {
      const cached = cacheGet(STATS_CACHE, "global", 180_000);
      if (cached) return json({ ...cached, at: now, cached: true });
    }
    const pr = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE status='active'").first<any>();
    const ag = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
    ).bind(now).first<any>();
    const sub = await env.DB.prepare("SELECT state, COUNT(*) AS n FROM submissions GROUP BY state").all<any>();
    const issue = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM issues GROUP BY status").all<any>();
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
    const payload = {
      projects: pr?.n ?? 0,
      agents_online: online?.n ?? 0,
      agents_active: ag?.n ?? 0, enrollments_pending: enr?.n ?? 0,
      agents_heartbeat_24h: hb?.n ?? 0,
      submissions: Object.fromEntries(sub.results.map((r: any) => [r.state, Number(r.n ?? 0)])),
      issues: Object.fromEntries(issue.results.map((r: any) => [r.status, Number(r.n ?? 0)])),
      per_project: perProj.results,
      at: now,
    };
    cacheSet(STATS_CACHE, "global", payload);
    return json(payload);
  }

  // 管理台数据看板：最近 7 天消息/交付趋势 + 当前可见项目的交付状态分布。
  // 只查 D1 聚合，不读 DO 正文；前端把任务/节点分布和这里拼成看板。
  if (path === "/admin/analytics" && req.method === "GET") {
    const policy = await loadPolicy(env);
    const allRows = (await env.DB.prepare(
      "SELECT project FROM projects WHERE status='active' ORDER BY created_at"
    ).all<any>()).results.map((r: any) => String(r.project));
    let projects = policy.mode === "all" ? allRows : allRows.filter((p) => (policy.projects || []).includes(p));
    const only = String(url.searchParams.get("project") ?? "").trim();
    if (only) {
      if (!/^[a-z0-9-]{2,40}$/.test(only)) return err(422, "bad_project");
      if (!projects.includes(only)) return err(403, "project_not_visible");
      projects = [only];
    }
    const now = Date.now();
    const fresh = url.searchParams.get("fresh") === "1";
    const cacheKey = JSON.stringify([only, policy.mode, projects]);
    if (!fresh) {
      const cached = cacheGet(ANALYTICS_CACHE, cacheKey, 300_000);
      if (cached) return json({ ...cached, at: now, cached: true });
    }
    const dayMs = 86_400_000;
    const today = new Date();
    const dayKeys: string[] = [];
    for (let i = 6; i >= 0; i--) {
      dayKeys.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(),
        today.getUTCDate()) - i * dayMs).toISOString().slice(0, 10));
    }
    const zeroDaily = dayKeys.map((day) => ({ day, messages: 0, submissions: 0, issues: 0 }));
    if (!projects.length) {
      return json({ at: now, scope: only || "all", projects: [], daily: zeroDaily,
                    submission_states: {}, issue_states: {},
                    totals: { messages: 0, submissions: 0, issues: 0 } });
    }
    const inSql = projects.map(() => "?").join(",");
    const sinceDay = dayKeys[0];
    const sinceMs = Date.parse(sinceDay + "T00:00:00Z");
    const [archive, subs, states, issueDaily, issueStates] = await Promise.all([
      env.DB.prepare(
        `SELECT substr(ts,1,10) AS day, COUNT(*) AS n FROM archive
          WHERE project IN (${inSql}) AND ts >= ? GROUP BY day`
      ).bind(...projects, sinceDay).all<any>(),
      env.DB.prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM submissions
          WHERE project IN (${inSql}) AND created_at >= ? GROUP BY day`
      ).bind(...projects, sinceMs).all<any>(),
      env.DB.prepare(
        `SELECT state, COUNT(*) AS n FROM submissions WHERE project IN (${inSql}) GROUP BY state`
      ).bind(...projects).all<any>(),
      env.DB.prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM issues
          WHERE project IN (${inSql}) AND created_at >= ? GROUP BY day`
      ).bind(...projects, sinceMs).all<any>(),
      env.DB.prepare(
        `SELECT status, COUNT(*) AS n FROM issues WHERE project IN (${inSql}) GROUP BY status`
      ).bind(...projects).all<any>(),
    ]);
    const msgMap = new Map<string, number>(archive.results.map((r: any) => [String(r.day), Number(r.n)]));
    const subMap = new Map<string, number>(subs.results.map((r: any) => [String(r.day), Number(r.n)]));
    const issueMap = new Map<string, number>(issueDaily.results.map((r: any) => [String(r.day), Number(r.n)]));
    const daily = dayKeys.map((day) => ({
      day, messages: msgMap.get(day) ?? 0, submissions: subMap.get(day) ?? 0,
      issues: issueMap.get(day) ?? 0,
    }));
    const payload = {
      at: now,
      scope: only || "all",
      projects,
      daily,
      submission_states: Object.fromEntries(states.results.map((r: any) => [r.state, Number(r.n)])),
      issue_states: Object.fromEntries(issueStates.results.map((r: any) => [r.status, Number(r.n)])),
      totals: {
        messages: daily.reduce((a, b) => a + b.messages, 0),
        submissions: daily.reduce((a, b) => a + b.submissions, 0),
        issues: daily.reduce((a, b) => a + b.issues, 0),
      },
    };
    cacheSet(ANALYTICS_CACHE, cacheKey, payload);
    return json(payload);
  }

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
      const r = await stub.fetch(new Request("https://do/tasks/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin", max_per_min: quota.maxMsgsPerMin }),
      }));
      const d: any = await r.json().catch(() => ({}));
      // S5：旧 DO 实例不带 wake 时由 Worker 补齐；定向消息本身已经落库。
      if (r.ok && d?.task_id && b.to) {
        const ar = await stub.fetch(new Request("https://do/agent/list"));
        const ad: any = await ar.json().catch(() => ({ agents: [] }));
        const hb = (ad.agents ?? []).find((a: any) => a.agent_id === b.to);
        const age = hb?.last_hb_ms ? Date.now() - Number(hb.last_hb_ms) : Infinity;
        d.wake = d.wake ?? { channel: "inbox", target: b.to, online: age <= 300_000,
                             alive: age <= 120_000 ? "alive" : age <= 300_000 ? "late" : "offline" };
      }
      return Response.json(d, { status: r.status });
    }
    if (action === "tasks" && req.method === "GET") {
      const r = await stub.fetch(new Request("https://do/tasks/list"));
      if (!r.ok) return r;
      const data: any = await r.json().catch(() => ({ tasks: [] }));
      // S4：任务台账直接显示待裁决数；旧 task 对象没有该字段，按 D1 实时补齐。
      const counts = await env.DB.prepare(
        `SELECT task_id, COUNT(*) AS n FROM submissions
          WHERE project = ? AND task_id IS NOT NULL AND state != 'archived'
            AND review_state IN ('pending', 'accepted')
          GROUP BY task_id`
      ).bind(project).all<any>().catch(() => ({ results: [] }));
      const byTask = new Map((counts.results ?? []).map((x: any) => [x.task_id, Number(x.n ?? 0)]));
      // S5：旧 DO 实例只给 claimed 的 owner_online；open 定向任务的 to_online 由 Worker 补齐。
      const ar = await stub.fetch(new Request("https://do/agent/list"));
      const ad: any = await ar.json().catch(() => ({ agents: [] }));
      const hbBy = new Map((ad.agents ?? []).map((a: any) => [a.agent_id, Number(a.last_hb_ms ?? 0)]));
      data.tasks = (data.tasks ?? []).map((t: any) => {
        const target = t.owner ?? t.to;
        const age = target ? Date.now() - Number(hbBy.get(target) ?? 0) : Infinity;
        return {
          ...t,
          pending_review: byTask.get(t.task_id ?? t.id) ?? 0,
          to_online: !t.owner && t.to ? (t.to_online ?? age <= 300_000) : null,
          to_alive: !t.owner && t.to
            ? (t.to_alive ?? (age <= 120_000 ? "alive" : age <= 300_000 ? "late" : "offline")) : null,
        };
      });
      return Response.json(data);
    }
    // 任务四个出口里的管理侧动作：关单、取回、转派。sender 固定 admin，不接受客户端伪造。
    if (["tasks/close", "tasks/reclaim", "tasks/reassign"].includes(action) && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (!String(b.task_id ?? "").trim()) return err(422, "task_id_required");
      const doAction = action === "tasks/close" ? "tasks/admin-close"
        : action === "tasks/reclaim" ? "tasks/admin-reclaim" : "tasks/admin-reassign";
      const dr = await stub.fetch(new Request("https://do/" + doAction, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin" }),
      }));
      const d: any = await dr.json().catch(() => ({}));
      // S2/S5：旧 DO 的 reassigned 消息缺 title/body，转派成功后补一条定向任务简报。
      let brief: any = null;
      if (action === "tasks/reassign" && dr.ok && b.to && d.brief_embedded !== true) {
        try {
          brief = await publishTaskBrief(env, project, String(b.task_id), String(b.to),
                                         String(b.reason ?? "").slice(0, 240));
        } catch (e: any) {
          brief = { error: "brief_failed", detail: String(e?.message ?? e) };
        }
        d.brief = brief;
      }
      return Response.json(d, { status: dr.status });
    }
    // ── Issue 台账 ────────────────────────────────────────────────
    // 所有 agent 都能上报（数据面 /p/{project}/issues）；管理侧只负责合并/关闭/
    // 重开/派发。状态：open → closed / merged；派发后 task_id 关联，任务 done 时
    // 由 ProjectRoom 回写 closed（closed_by=task）。
    if (action === "issues" && req.method === "GET") {
      const status = String(url.searchParams.get("status") ?? "").trim();
      if (status && !["open", "closed", "merged"].includes(status)) return err(422, "bad_status");
      const rawLimit = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 100;
      const where = status ? "project = ? AND status = ?" : "project = ?";
      const vals: any[] = status ? [project, status] : [project];
      const rows = await env.DB.prepare(
        `SELECT issue_id, title, body, status, priority, labels, reporter, task_id,
                merged_into, close_reason, closed_by, created_at, updated_at, closed_at
           FROM issues WHERE ${where} ORDER BY updated_at DESC LIMIT ?`
      ).bind(...vals, limit).all<any>();
      const counts = await env.DB.prepare(
        "SELECT status, COUNT(*) AS n FROM issues WHERE project = ? GROUP BY status"
      ).bind(project).all<any>();
      return json({ issues: rows.results ?? [],
                    counts: Object.fromEntries((counts.results ?? []).map((r: any) => [r.status, Number(r.n)])) });
    }

    const issueAction = action.match(/^issues\/([A-Za-z0-9._:-]{1,128})(?:\/(close|reopen|merge|dispatch))?$/);
    if (issueAction && req.method === "POST") {
      const [, issueId, op] = issueAction;
      if (!op) return err(405, "method_not_allowed");
      const row = await env.DB.prepare(
        "SELECT * FROM issues WHERE project = ? AND issue_id = ?"
      ).bind(project, issueId).first<any>();
      if (!row) return err(404, "issue_not_found");
      const now = Date.now();
      const b: any = await req.json().catch(() => ({}));

      if (op === "close") {
        if (row.status === "merged") return err(409, "issue_merged");
        const reason = String(b.reason ?? "").trim().slice(0, 240) || "管理员关闭";
        const upd = await env.DB.prepare(
          `UPDATE issues SET status = 'closed', closed_at = ?, closed_by = 'admin',
             close_reason = ?, updated_at = ? WHERE project = ? AND issue_id = ? AND status != 'merged'`
        ).bind(now, reason, now, project, issueId).run();
        if (upd.meta.changes === 0) return err(409, "issue_merged");
        return json({ ok: true, issue_id: issueId, status: "closed", close_reason: reason });
      }

      if (op === "reopen") {
        // 任务完成自动关闭的 issue 重开时清掉旧 task_id，允许作为新的跟进单再派发；
        // 人工关闭但任务仍在跑的重开则保留关联，任务 done 时继续自动收口。
        const clearTask = row.closed_by === "task";
        const upd = await env.DB.prepare(
          `UPDATE issues SET status = 'open', closed_at = NULL, closed_by = NULL,
             close_reason = NULL, merged_into = NULL, task_id = ${clearTask ? "NULL" : "task_id"},
             updated_at = ?
           WHERE project = ? AND issue_id = ? AND status IN ('closed', 'merged')`
        ).bind(now, project, issueId).run();
        if (upd.meta.changes === 0) return err(409, "issue_not_reopenable");
        return json({ ok: true, issue_id: issueId, status: "open", task_id_cleared: clearTask });
      }

      if (op === "merge") {
        const into = String(b.into ?? "").trim();
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(into)) return err(422, "into_required");
        if (into === issueId) return err(422, "merge_self");
        if (row.status !== "open") return err(409, "issue_not_open");
        if (row.task_id) return err(409, "issue_has_task");
        const target = await env.DB.prepare(
          "SELECT issue_id, status, task_id FROM issues WHERE project = ? AND issue_id = ?"
        ).bind(project, into).first<any>();
        if (!target) return err(404, "target_issue_not_found");
        if (target.status !== "open") return err(409, "target_not_open");
        const upd = await env.DB.prepare(
          `UPDATE issues SET status = 'merged', merged_into = ?, closed_at = ?, closed_by = 'admin',
             close_reason = 'merged', updated_at = ? WHERE project = ? AND issue_id = ?
             AND status = 'open' AND task_id IS NULL`
        ).bind(into, now, now, project, issueId).run();
        if (upd.meta.changes === 0) return err(409, "issue_changed");
        return json({ ok: true, issue_id: issueId, status: "merged", merged_into: into });
      }

      // dispatch：把 issue 转成任务并派发；任务完成后 ProjectRoom 自动 close issue。
      const out = await dispatchIssueToTask(env, project, issueId, {
        to: b.to === undefined || b.to === null || String(b.to).trim() === ""
          ? null : String(b.to).trim(),
        sender: "admin",
        taskId: String(b.task_id ?? "").trim() || undefined,
        title: b.title,
        body: b.body,
      });
      if (!out.ok) return out.detail ? json(out.detail, out.status) : err(out.status, out.error);
      return json({ ok: true, issue_id: issueId, status: "open", task_id: out.task_id,
                    dispatched: true, task_link: out.task });
    }

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
        // DO 名册同步清理，避免管理台/转派下拉继续显示已吊销节点
        await stub.fetch(new Request("https://do/agent/remove", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent_id: id }),
        })).catch(() => {});
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
         WHERE project=? AND agent_id=? AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`).bind(project, id).first();
      const inbox: any = await (await stub.fetch(new Request(
        `https://do/inbox?since=0&limit=200&agent=*&desc=1`))).json().catch(() => ({ messages: [] }));
      const msgs = (inbox.messages ?? []).filter((m: any) =>
        m.sender === id || (Array.isArray(m.to) ? m.to.includes(id) : m.to === id)).slice(-30);
      return json({ agent: ag, hb: hb.results ?? [], submissions: subs.results ?? [], messages: msgs });
    }

    // 定向指令：发给一个或多个 agent（不是广播）。
    // S6 兼容入口：POST /messages 与 /send 等价，旧管理脚本不用改路径。
    if ((action === "send" || action === "messages") && req.method === "POST") {
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
      return json({ ok: true, sent: out, channel: "inbox" });
    }

    // 消息历史：管理员看全量（含定向私信），不分页滚动，取最近 N 条
    if (action === "messages" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 200);
      return stub.fetch(new Request(`https://do/inbox?since=0&limit=${limit}&agent=*&desc=1`));
    }

    if (action === "broadcast") {
      if (req.method !== "POST") return err(405, "method_not_allowed");
      const b: any = await req.json();
      const quota = await projectQuota(env, project);
      return stub.fetch(new Request("https://do/broadcast", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin", max_per_min: quota.maxMsgsPerMin }),
      }));
    }

    if (action === "submissions" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (!b.submission_id || !/^[a-zA-Z0-9._:-]{1,128}$/.test(String(b.submission_id).trim()))
        return err(422, "submission_id_required");
      if (!b.agent_id) return err(422, "agent_id_required");
      if (!b.base_sha) return err(422, "base_sha_required");
      if (!/^[a-f0-9]{7,64}$/.test(String(b.base_sha))) return err(422, "base_sha_not_hex");
      const agentId = String(b.agent_id).trim();
      if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(agentId)) return err(422, "bad_agent_id");
      const activeAgent = await env.DB.prepare(
        `SELECT 1 FROM agents WHERE project = ? AND agent_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
      ).bind(project, agentId, Date.now()).first<any>();
      if (!activeAgent) return err(422, "agent_not_found");
      const scan = JSON.stringify({ title: b.title, refs: b.refs, checks: b.checks });
      if (/(AKIA[0-9A-Z]{16}|-----BEGIN[^"]{0,40}PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)/.test(scan))
        return err(422, "secret_detected");          // DESIGN §7 的第四项检查
      const norm = normalizeRefs(b.refs);
      if (norm.error) return err(422, norm.error);
      for (const r of norm.refs) {
        const obj = await env.BLOBS.head(`p/${project}/artifacts/${r.sha256}`);
        if (!obj) return err(422, `blob_missing:${r.sha256}`);
      }
      const kind = String(b.kind ?? "patch");
      const allowOvertake = b.allow_overtake === true;
      const overtakeReason = String(b.overtake_reason ?? "").trim().slice(0, 240);
      if (allowOvertake && !overtakeReason) return err(422, "overtake_reason_required");
      const bind = await resolveSubmissionTask(env, project, agentId, b.task_id, allowOvertake, false);
      if (bind.error) return bind.error;
      const missing = deliveryFormatMissing(kind, norm.refs).concat(deliveryChecksMissing(kind, b.checks));
      if (missing.length) return deliveryFormatError(kind, missing);
      const taskId = bind.taskId;
      const sid = String(b.submission_id).trim();
      const now = Date.now();
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO submissions
         (project, submission_id, agent_id, task_id, task_assignee, overtake, overtake_reason,
          base_sha, kind, title, refs_json, checks_json, state, review_state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'delivered', 'pending', ?, ?)`
      ).bind(project, sid, agentId, taskId, bind.assigneeAtSubmit, bind.overtake ? 1 : 0,
             bind.overtake ? overtakeReason : null,
             b.base_sha, kind, b.title ?? "",
             JSON.stringify(norm.refs), JSON.stringify(b.checks ?? {}), now, now).run();
      if (res.meta.changes === 0) {
        const old = await env.DB.prepare(
          "SELECT agent_id FROM submissions WHERE project = ? AND submission_id = ?"
        ).bind(project, sid).first<any>();
        if (old?.agent_id !== agentId) return err(409, "submission_id_conflict");
        return json({ submission_id: sid, state: "delivered", deduped: true, seq: null,
                      task_id: taskId, task_assignee: bind.assigneeAtSubmit, auto_bound: bind.autoBound });
      }
      const seq = await stub.fetch(new Request("https://do/publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, sender: agentId, topic: "artifact", kind,
                               payload: { submission_id: sid, task_id: taskId,
                                          task_assignee: bind.assigneeAtSubmit,
                                          overtake: bind.overtake, overtake_reason: bind.overtake ? overtakeReason : null },
                               dedupe_key: `sub:${sid}` }),
      }));
      return Response.json({ submission_id: sid, state: "delivered", task_id: taskId,
                             task_assignee: bind.assigneeAtSubmit, auto_bound: bind.autoBound,
                             overtake: bind.overtake, seq: await seq.json() });
    }

    const bun = action.match(/^submissions\/([^/]+)\/bundle$/);
    if (bun && req.method === "GET") return bundleSubmission(env, project, bun[1]);

    if (action === "submissions" && req.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      const taskId = url.searchParams.get("task_id") ?? "";
      const review = url.searchParams.get("review_state") ?? "";
      const valid = ["delivered", "collected", "archived"].includes(state);
      const validReview = ["pending", "accepted", "approved", "rejected"].includes(review);
      const cond = ["project = ?"];
      const vals: any[] = [project];
      if (valid) { cond.push("state = ?"); vals.push(state); }
      if (taskId && /^[a-zA-Z0-9._:-]{1,64}$/.test(taskId)) { cond.push("task_id = ?"); vals.push(taskId); }
      if (validReview) { cond.push("review_state = ?"); vals.push(review); }
      const rows = await env.DB.prepare(
        `SELECT * FROM submissions WHERE ${cond.join(" AND ")} ORDER BY created_at DESC LIMIT 100`
      ).bind(...vals).all();
      return Response.json(rows.results);
    }

    const col = action.match(/^submissions\/([^/]+)\/(collect|archive|result)$/);
    if (col && req.method === "POST") {
      const [, id, op] = col;
      const row = await env.DB.prepare(
        "SELECT submission_id, task_id, kind, state, review_state FROM submissions WHERE project = ? AND submission_id = ?"
      ).bind(project, id).first<any>();
      if (!row) return err(404, "submission_not_found");
      if (op === "result") {
        const b: any = await req.json().catch(() => ({}));
        const raw = String(b.result ?? "").trim();
        const verdict = raw.toLowerCase();
        const allowed = ["pending", "accepted", "approved", "rejected"];
        if (!allowed.includes(verdict)) {
          // 兼容旧客户端：非枚举文本只当人工评语，不动裁决态。
          await env.DB.prepare(`UPDATE submissions SET result = ?, updated_at = ? WHERE project = ? AND submission_id = ?`)
            .bind(raw, Date.now(), project, id).run();
          return json({ ok: true, review_state: row.review_state ?? "pending", legacy: true });
        }
        const note = String(b.note ?? "").trim().slice(0, 4000);
        const now = Date.now();
        await env.DB.prepare(
          `UPDATE submissions
              SET review_state = ?, result = ?, reviewed_at = ?, reviewed_by = 'admin', updated_at = ?
            WHERE project = ? AND submission_id = ?`
        ).bind(verdict, note || raw, now, now, project, id).run();
        // approved 可能在 collect 之后才到；这里立即按 D1 状态结算。
        let taskLink: any = null;
        if (verdict === "approved" && row.task_id) {
          try { taskLink = await settleTaskAfterSubmission(env, project, row.task_id, "approval"); }
          catch (e: any) { taskLink = { error: "settle_unreachable", detail: String(e?.message ?? e) }; }
        }
        return json({ ok: true, review_state: verdict, task_id: row.task_id ?? null, task_link: taskLink });
      }
      const state = op === "collect" ? "collected" : "archived";
      const wasPending = row.review_state === "pending" || row.review_state === null;
      // 代码类取走即视为验收通过（S1 的自动 done 语义）；报告类只进入 accepted 待裁决（S4）。
      const review = op === "collect" && wasPending
        ? (String(row.kind) === "report" ? "accepted" : "approved")
        : row.review_state;
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE submissions SET state = ?, review_state = COALESCE(?, review_state),
           reviewed_at = CASE WHEN ? = 'approved' AND reviewed_at IS NULL THEN ? ELSE reviewed_at END,
           reviewed_by = CASE WHEN ? = 'approved' AND reviewed_by IS NULL THEN 'collection' ELSE reviewed_by END,
           updated_at = ?
          WHERE project = ? AND submission_id = ?`
      ).bind(state, review, review, now, review, now, project, id).run();
      // 联动：这件交付挂在某个任务上时，由 Worker 按 D1 的待取/待批状态结算。
      // 结算失败不回滚已落库的取走状态，但必须在响应里响亮标出，不许静默脱钩。
      let taskLink: any = null;
      if (row.task_id) {
        try {
          taskLink = await settleTaskAfterSubmission(env, project, row.task_id, "collection");
        } catch (e: any) {
          taskLink = { error: "settle_unreachable", detail: String(e?.message ?? e) };
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

  // 只改权限，不重签 token：同一 agent 的所有活跃 token 行同步更新。
  // 现有 POST /admin/agents 会生成新 token 并吊销旧 token，不适合做权限编辑。
  if (p === "/admin/agents" && req.method === "PATCH") {
    const b: any = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return err(400, "bad_json");
    if (!/^[a-z0-9-]{2,40}$/.test(String(b.project ?? ""))) return err(422, "bad_project_name");
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(String(b.agent_id ?? ""))) return err(422, "bad_agent_id");

    const ag = await env.DB.prepare(
      `SELECT role, scopes FROM agents
       WHERE project=? AND agent_id=? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 1`
    ).bind(b.project, b.agent_id, Date.now()).first<any>();
    if (!ag) return err(404, "agent_not_found");

    let list: string[];
    if (b.scopes === undefined || b.scopes === null || b.scopes === "") {
      return err(422, "bad_scopes");
    } else if (typeof b.scopes === "string") {
      list = b.scopes.split(",").map((x: string) => x.trim()).filter(Boolean);
    } else if (Array.isArray(b.scopes)) {
      list = b.scopes.map((x: any) => String(x).trim()).filter(Boolean);
    } else {
      return err(422, "bad_scopes");
    }
    list = [...new Set(list)];
    const unknown = list.filter((x) => !ALL_SCOPES.has(x));
    if (unknown.length) return err(422, `unknown_scopes:${unknown.join(",")}`);
    if (!list.length) return err(422, "empty_scopes");
    if (ag.role !== "admin" && list.includes("admin")) return err(422, "admin_scope_requires_admin");
    if (ag.role === "admin" && !list.includes("admin")) list.unshift("admin");

    const r = await env.DB.prepare(
      "UPDATE agents SET scopes = ? WHERE project = ? AND agent_id = ? AND role = ? AND revoked_at IS NULL"
    ).bind(list.join(","), b.project, b.agent_id, ag.role).run();
    return Response.json({
      ok: true, agent_id: b.agent_id, role: ag.role,
      scopes: list.join(","), updated: r.meta.changes,
    });
  }

  // 吊销：某 agent 名下所有未吊销 token 全失效
  if (p === "/admin/agents" && req.method === "DELETE") {
    const b: any = await req.json().catch(() => ({}));
    if (!b.project || !b.agent_id) return err(422, "project_and_agent_required");
    const r = await env.DB.prepare(
      "UPDATE agents SET revoked_at = ? WHERE project = ? AND agent_id = ? AND revoked_at IS NULL"
    ).bind(Date.now(), b.project, b.agent_id).run();
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + b.project));
    await stub.fetch(new Request("https://do/agent/remove", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: b.agent_id }),
    })).catch(() => {});
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
  if (refs.length > 200) return err(413, "bundle_too_many_files");
  const maxBundle = 80 * 1024 * 1024;

  const files: { name: string; data: Uint8Array }[] = [];
  let total = 0;
  // 先按 R2 元数据估算，避免单个大对象先读进内存再判超限（128MB Worker 很容易 1101）。
  const normalized = refs.map((r) => typeof r === "string" ? { sha256: r } : r);
  for (const r of normalized) {
    const sha = String(r?.sha256 ?? "");
    if (!/^[a-f0-9]{64}$/.test(sha)) continue;
    const head = await env.BLOBS.head(`p/${project}/artifacts/${sha}`);
    if (!head) return err(422, `blob_missing:${sha}`);
    total += Number(head.size ?? 0);
    if (total > maxBundle) return err(413, "bundle_too_large");
  }
  for (const r of normalized) {
    const sha = String(r?.sha256 ?? "");
    if (!/^[a-f0-9]{64}$/.test(sha)) continue;
    const obj = await env.BLOBS.get(`p/${project}/artifacts/${sha}`);
    if (!obj) return err(422, `blob_missing:${sha}`);
    const buf = new Uint8Array(await obj.arrayBuffer());
    // 总大小已在上面的 head 阶段校验，这里不再累加，避免误以为读了两次
    const safe = String(r?.name ?? `${sha.slice(0, 12)}.bin`).replace(/^[^\w.-]+/, "").replace(/[^\w.-]+/g, "_");
    files.push({ name: safe || `${sha.slice(0, 12)}.bin`, data: buf });
  }

  let checks: any = {};
  try { checks = JSON.parse(row.checks_json ?? "{}"); } catch { checks = {}; }
  const prov = {
    project, submission_id: row.submission_id, agent_id: row.agent_id, base_sha: row.base_sha,
    task_id: row.task_id ?? null, task_assignee: row.task_assignee ?? null,
    review_state: row.review_state ?? "pending", overtake: !!row.overtake,
    kind: row.kind, title: row.title, state: row.state, checks,
    created_at: row.created_at, updated_at: row.updated_at,
    refs: normalized.map((r) => ({ sha256: r?.sha256, name: r?.name, bytes: r?.bytes })),
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
type NormalizedRef = { sha256: string; name?: string; bytes?: number };

/** refs 统一归一化：字符串 sha 也要变成对象，否则 bundle 阶段会静默跳过。 */
function normalizeRefs(raw: unknown): { refs: NormalizedRef[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { refs: [], error: "refs_required" };
  if (raw.length > 200) return { refs: [], error: "too_many_refs" };
  const refs: NormalizedRef[] = [];
  for (const r of raw) {
    const rr: any = typeof r === "string" ? { sha256: r } : r;
    if (!rr || typeof rr !== "object" || !/^[a-f0-9]{64}$/.test(String(rr?.sha256 ?? "")))
      return { refs: [], error: "bad_ref_sha: refs 需要 {sha256:<64位hex>}，也可直接传 sha 字符串" };
    let name = rr.name === undefined || rr.name === null ? undefined : String(rr.name).trim();
    if (name) {
      name = name.replace(/\\/g, "/");
      if (name.startsWith("/") || name.split("/").includes(".."))
        return { refs: [], error: `bad_ref_name:${name}` };
    }
    const item: NormalizedRef = { sha256: String(rr.sha256) };
    if (name) item.name = name;
    if (rr.bytes !== undefined && Number.isFinite(Number(rr.bytes))) item.bytes = Number(rr.bytes);
    refs.push(item);
  }
  return { refs };
}

/** 任务板快照：只在交付缺省 task_id 时用一次，避免 agent 名下多任务时猜错单。 */
async function projectTasks(env: Env, project: string): Promise<any[]> {
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  const r = await stub.fetch(new Request("https://do/tasks/list"));
  if (!r.ok) return [];
  const data = await r.json<any>().catch(() => ({ tasks: [] }));
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

type TaskBinding = {
  taskId: string | null;
  task: any | null;
  autoBound: boolean;
  overtake: boolean;
  assigneeAtSubmit: string | null;
  error?: Response;
};

/**
 * S1/S2：交付绑定与越单校验。
 * - 显式 task_id：校验存在、非 done、提交者是 owner 或被指派者；
 * - 缺省 task_id：该 agent 名下恰好一件 claimed 任务时自动绑定，多件则要求显式指定；
 * - 管理侧代建可显式 allowOvertake，落库标记「越单」并留理由。
 */
async function resolveSubmissionTask(
  env: Env, project: string, agentId: string, rawTaskId: unknown,
  allowOvertake = false, requireClaimed = true
): Promise<TaskBinding> {
  let taskId = rawTaskId === undefined || rawTaskId === null || String(rawTaskId).trim() === ""
    ? null : String(rawTaskId).trim();
  let autoBound = false;
  if (taskId === null) {
    const mine = (await projectTasks(env, project))
      .filter((t: any) => t.state === "claimed" && t.owner === agentId);
    if (mine.length === 1) {
      taskId = String(mine[0].task_id ?? mine[0].id ?? "").trim() || null;
      autoBound = taskId !== null;
    } else if (mine.length > 1) {
      return { taskId: null, task: null, autoBound: false, overtake: false, assigneeAtSubmit: null,
        error: json({ error: "task_id_required", reason: "当前有多件 claimed 任务，必须显式带 task_id",
                      candidates: mine.map((t: any) => t.task_id ?? t.id).slice(0, 20) }, 409) };
    }
  }
  if (taskId === null)
    return { taskId: null, task: null, autoBound: false, overtake: false, assigneeAtSubmit: null };

  if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(taskId))
    return { taskId: null, task: null, autoBound, overtake: false, assigneeAtSubmit: null,
             error: err(422, "bad_task_id") };
  const t = await taskMeta(env, project, taskId);
  if (!t)
    return { taskId, task: null, autoBound, overtake: false, assigneeAtSubmit: null,
             error: err(422, `task_not_found:${taskId}`) };
  if (t.state === "done")
    return { taskId, task: t, autoBound, overtake: false, assigneeAtSubmit: null,
             error: err(409, `task_done:${taskId}`) };

  const isOwner = t.state === "claimed" && t.owner === agentId;
  const isAssigned = t.to === agentId && t.state !== "done";
  const assigned = requireClaimed ? isOwner : (isOwner || isAssigned);
  if (!assigned && !allowOvertake) {
    return { taskId, task: t, autoBound, overtake: false, assigneeAtSubmit: t.owner ?? t.to ?? null,
      error: json({ error: requireClaimed && isAssigned ? "task_not_claimed" : "task_not_assignee",
                    task_id: taskId, task_state: t.state,
                    task_owner: t.owner ?? null, task_to: t.to ?? null,
                    hint: requireClaimed
                      ? "交付前先 task-claim，且只能交自己 claim 的任务"
                      : "只能交付自己 owner 或被指派的任务；管理侧代建可用 allow_overtake 留痕" }, 409) };
  }
  return { taskId, task: t, autoBound, overtake: !assigned,
           assigneeAtSubmit: t.owner ?? t.to ?? null };
}

/**
 * S3：交付格式门。代码类必须同时有补丁与回执，报告类必须有正文；
 * 只按文件名判断，不读内容，避免 Worker 为校验再下载一遍大文件。
 */
function deliveryFormatMissing(kindRaw: unknown, refs: NormalizedRef[]): string[] {
  const kind = String(kindRaw ?? "patch").trim().toLowerCase();
  const base = (r: NormalizedRef) =>
    String(r.name ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const names = refs.map(base).filter(Boolean);
  const has = (re: RegExp) => names.some((n) => re.test(n));

  if (kind === "report") {
    const body = has(/\.(md|markdown|txt|pdf|html|docx)$/i)
      || names.some((n) => /report|报告/.test(n));
    return body ? [] : ["report_body"];
  }
  if (kind === "patch" || kind === "bundle") {
    const missing: string[] = [];
    if (!has(/\.(patch|diff)$/i) && !names.some((n) => /patch|diff/.test(n))) missing.push("patch_file");
    if (!has(/(^|[-_.])(receipt|回执)([-_.]|$)/i) && !names.some((n) => n.startsWith("receipt") || n.startsWith("回执")))
      missing.push("receipt_file");
    return missing;
  }
  return [];
}

/** R2：代码类交付的自测计数必须结构化，不能只写 built=true。 */
function deliveryChecksMissing(kindRaw: unknown, checksRaw: unknown): string[] {
  const kind = String(kindRaw ?? "patch").trim().toLowerCase();
  if (kind !== "patch" && kind !== "bundle") return [];
  const c: any = checksRaw && typeof checksRaw === "object" ? checksRaw : {};
  const nums = (o: any) => Number.isFinite(Number(o?.passed)) && Number.isFinite(Number(o?.failed));
  if (nums(c.tests) || nums(c)) return [];
  const suites = c.suites;
  if (Array.isArray(suites) && suites.length > 0
      && suites.every((s: any) => String(s?.name ?? "").trim() && nums(s))) return [];
  return ["checks_tests"];
}

/** 交付格式门的统一错误体：缺什么、期望什么，一次说清，避免 agent 反复猜。 */
function deliveryFormatError(kind: string, missing: string[]) {
  const expected: Record<string, string> = {
    patch_file: "*.patch 或 *.diff（代码补丁）",
    receipt_file: "RECEIPT.md 或 *-receipt.*（执行回执）",
    report_body: "*.md / *.txt / *.pdf（报告正文）",
    checks_tests: 'checks 里带 {"tests":{"passed":N,"failed":M}} 或 suites[]',
  };
  return json({ error: "delivery_format_incomplete", kind,
                missing, required: missing.map((m) => expected[m] ?? m),
                hint: "代码类交付必须含补丁、回执与结构化自测计数；报告类必须含正文。补齐后重新提交。" }, 422);
}

/** 读一个任务的元数据；只走 DO 的内部接口，不把任务正文暴露给普通 agent。 */
async function taskMeta(env: Env, project: string, taskId: string): Promise<any | null> {
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  const r = await stub.fetch(new Request("https://do/tasks/get", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, task_id: taskId }),
  }));
  if (!r.ok) return null;
  return r.json<any>().catch(() => null);
}

/** 旧 DO 的 reassigned 生命周期消息只带 prev/reason，不带正文；Worker 在转派后补一条任务简报。 */
async function publishTaskBrief(
  env: Env, project: string, taskId: string, to: string, reason: string
): Promise<any | null> {
  const t = (await projectTasks(env, project)).find((x: any) => (x.task_id ?? x.id) === taskId);
  if (!t || !to) return null;
  const quota = await projectQuota(env, project);
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  const r = await stub.fetch(new Request("https://do/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, sender: "admin", topic: "task", kind: "task", to,
                           payload: { task_id: taskId, title: t.title ?? "", body: t.body ?? "",
                                      reassigned: true, reason },
                           max_per_min: quota.maxMsgsPerMin,
                           dedupe_key: `task-brief:${taskId}:${to}:${Date.now()}` }),
  }));
  return r.json<any>().catch(() => null);
}

/**
 * S1/S4：Worker 侧兜底结算。旧 DO 实例只会在 released 时收单，
 * 这里按 D1 的取走/裁决状态决定是否用 admin-close 收尾，避免升级期空窗。
 */
async function settleTaskAfterSubmission(
  env: Env, project: string, taskId: string, closedBy: "collection" | "approval" = "collection"
): Promise<any | null> {
  const t = await taskMeta(env, project, taskId);
  if (!t) return null;
  const pendingRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM submissions WHERE project = ? AND task_id = ? AND state = 'delivered'"
  ).bind(project, taskId).first<any>().catch(() => ({ n: 0 }));
  const reviewRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM submissions
      WHERE project = ? AND task_id = ? AND state != 'archived'
        AND review_state IN ('pending', 'accepted')`
  ).bind(project, taskId).first<any>().catch(() => ({ n: 0 }));
  const reportRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM submissions
      WHERE project = ? AND task_id = ? AND kind = 'report'
        AND state != 'archived' AND review_state != 'approved'`
  ).bind(project, taskId).first<any>().catch(() => ({ n: 0 }));
  const pending = Number(pendingRow?.n ?? 0);
  const pendingReview = Number(reviewRow?.n ?? 0);
  const unapproved = Number(reportRow?.n ?? 0);
  if (t.state === "done") return { ok: true, task_id: taskId, state: "done",
                                   pending_submissions: 0, pending_review: pendingReview, already: true };
  const canClose = pending === 0 && unapproved === 0
    && (t.state === "claimed" || t.state === "released");
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  if (canClose) {
    const dr = await stub.fetch(new Request("https://do/tasks/admin-close", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, task_id: taskId, sender: "admin",
                             reason: closedBy === "approval" ? "交付 approved，自动关单" : "最后一件交付已取走，自动关单",
                             closed_by: closedBy }),
    }));
    const d = await dr.json<any>().catch(() => ({}));
    if (!dr.ok) return { error: "do_http_" + dr.status, detail: d };
    return { ok: true, task_id: taskId, state: "done", pending_submissions: 0,
             pending_review: pendingReview, unapproved_reports: unapproved,
             closed_by: closedBy };
  }
  const dr = await stub.fetch(new Request("https://do/tasks/submission-settled", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, task_id: taskId, sender: "admin", closed_by: closedBy }),
  }));
  const d = await dr.json<any>().catch(() => ({}));
  if (!dr.ok) return { error: "do_http_" + dr.status, detail: d };
  return { ...d, pending_review: pendingReview, unapproved_reports: unapproved };
}

async function createSubmission(req: Request, env: Env, project: string, agentId: string) {
  const b: any = await req.json().catch(() => ({}));
  if (!b.base_sha) return err(422, "base_sha_required");
  if (!/^[a-f0-9]{7,64}$/.test(String(b.base_sha))) return err(422, "base_sha_not_hex");
  if (!b.submission_id) return err(422, "submission_id_required");
  const sid = String(b.submission_id).trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(sid)) return err(422, "bad_submission_id");
  const scan = JSON.stringify({ title: b.title, refs: b.refs, checks: b.checks });
  if (/(AKIA[0-9A-Z]{16}|-----BEGIN[^"]{0,40}PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)/.test(scan))
    return err(422, "secret_detected");            // 交付卫生：不许把密钥带进仓库
  const norm = normalizeRefs(b.refs);
  if (norm.error) return err(422, norm.error);
  for (const r of norm.refs) {
    const head = await env.BLOBS.head(`p/${project}/artifacts/${r.sha256}`);
    if (!head) return err(422, `blob_missing:${r.sha256}`);
  }
  const kind = String(b.kind ?? "patch");
  const bind = await resolveSubmissionTask(env, project, agentId, b.task_id, false, true);
  if (bind.error) return bind.error;
  const missing = deliveryFormatMissing(kind, norm.refs).concat(deliveryChecksMissing(kind, b.checks));
  if (missing.length) return deliveryFormatError(kind, missing);
  const taskId = bind.taskId;
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO submissions
     (project, submission_id, agent_id, task_id, task_assignee, overtake, overtake_reason,
      base_sha, kind, title, refs_json, checks_json, state, review_state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'delivered', 'pending', ?, ?)`
  ).bind(project, sid, agentId, taskId, bind.assigneeAtSubmit, bind.overtake ? 1 : 0, null,
         b.base_sha, kind, b.title ?? "",
         JSON.stringify(norm.refs), JSON.stringify(b.checks ?? {}), now, now).run();
  if (res.meta.changes === 0) {
    // 幂等只对“同一个 agent 的同一份交付”成立；别的 agent 抢了 ID 必须拒绝。
    const old = await env.DB.prepare(
      "SELECT agent_id FROM submissions WHERE project = ? AND submission_id = ?"
    ).bind(project, sid).first<any>();
    if (old?.agent_id !== agentId) return err(409, "submission_id_conflict");
    return json({ submission_id: sid, state: "delivered", deduped: true, seq: null,
                  task_id: taskId, task_assignee: bind.assigneeAtSubmit, auto_bound: bind.autoBound });
  }

  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  const seqRes = await stub.fetch(new Request("https://do/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, sender: agentId, topic: "artifact", kind,
                           payload: { submission_id: sid, task_id: taskId,
                                      task_assignee: bind.assigneeAtSubmit,
                                      base_sha: b.base_sha, title: b.title ?? "", agent_id: agentId },
                           dedupe_key: `sub:${sid}` }),
  }));
  const seq = await seqRes.json<any>().catch(() => ({}));
  return json({ submission_id: sid, state: "delivered", task_id: taskId,
                task_assignee: bind.assigneeAtSubmit, auto_bound: bind.autoBound,
                seq: seq.seq ?? null });
}

/**
 * 把 issue 原子地转成一个任务。管理员派单和上报者自助转任务共用这一条路径：
 * 先 UPDATE 占住 task_id，再让 DO 建单；建单失败释放占位，避免并发双击造出两个任务。
 */
async function dispatchIssueToTask(
  env: Env, project: string, issueId: string,
  opts: { to: string | null; sender: string; taskId?: string; title?: string; body?: string },
): Promise<{ ok: true; task_id: string; task: any }
        | { ok: false; status: number; error: string; detail?: any }> {
  const row = await env.DB.prepare(
    "SELECT * FROM issues WHERE project = ? AND issue_id = ?"
  ).bind(project, issueId).first<any>();
  if (!row) return { ok: false, status: 404, error: "issue_not_found" };
  if (row.status !== "open") return { ok: false, status: 409, error: "issue_not_open" };
  if (row.task_id) return { ok: false, status: 409, error: "issue_already_dispatched" };
  const now = Date.now();
  const taskId = String(opts.taskId ?? "").trim() ||
    `T-${issueId.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 24)}-${now.toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4)}`;
  if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(taskId))
    return { ok: false, status: 422, error: "bad_task_id" };
  const claim = await env.DB.prepare(
    `UPDATE issues SET task_id = ?, updated_at = ?
       WHERE project = ? AND issue_id = ? AND status = 'open' AND task_id IS NULL`
  ).bind(taskId, now, project, issueId).run();
  if (claim.meta.changes === 0)
    return { ok: false, status: 409, error: "issue_already_dispatched" };
  const title = String(opts.title ?? row.title).trim() || row.title;
  const body = String(opts.body ?? row.body ?? "");
  const quota = await projectQuota(env, project);
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  let dr: Response;
  try {
    dr = await stub.fetch(new Request("https://do/tasks/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: taskId, title, body, to: opts.to, issue_id: issueId,
                             project, sender: opts.sender, max_per_min: quota.maxMsgsPerMin }),
    }));
  } catch (e) {
    await env.DB.prepare(
      "UPDATE issues SET task_id = NULL, updated_at = ? WHERE project = ? AND issue_id = ? AND task_id = ?"
    ).bind(Date.now(), project, issueId, taskId).run().catch(() => {});
    console.warn("issue dispatch failed", issueId, e);
    return { ok: false, status: 503, error: "task_dispatch_failed" };
  }
  const d: any = await dr.json().catch(() => ({}));
  if (!dr.ok) {
    await env.DB.prepare(
      "UPDATE issues SET task_id = NULL, updated_at = ? WHERE project = ? AND issue_id = ? AND task_id = ?"
    ).bind(Date.now(), project, issueId, taskId).run().catch(() => {});
    return { ok: false, status: dr.status, error: String(d.error ?? "task_dispatch_failed"), detail: d };
  }
  return { ok: true, task_id: taskId, task: d };
}

/** 上报者把一条 open issue 转成自己的任务；只有 reporter 本人可以调用。 */
async function takeIssue(req: Request, env: Env, project: string, agentId: string, issueId: string) {
  const row = await env.DB.prepare(
    "SELECT issue_id, reporter, status, task_id FROM issues WHERE project = ? AND issue_id = ?"
  ).bind(project, issueId).first<any>();
  if (!row) return err(404, "issue_not_found");
  if (row.reporter !== agentId) return err(403, "not_issue_reporter");
  const b: any = await req.json().catch(() => ({}));
  const out = await dispatchIssueToTask(env, project, issueId, {
    to: agentId, sender: agentId, taskId: String(b.task_id ?? "").trim() || undefined,
  });
  if (!out.ok) return out.detail ? json(out.detail, out.status) : err(out.status, out.error);
  return json({ ok: true, issue_id: issueId, status: "open", task_id: out.task_id,
                assigned_to: agentId, task_link: out.task });
}

/** 所有 agent 都可上报 issue；身份由服务端注入，不接受客户端自报 reporter。 */
async function createIssue(req: Request, env: Env, project: string, agentId: string) {
  const b: any = await req.json().catch(() => ({}));
  const title = String(b.title ?? "").trim();
  const body = String(b.body ?? "").trim();
  if (!title) return err(422, "title_required");
  if (title.length > 200) return err(422, "title_too_long");
  if (body.length > 20_000) return err(422, "body_too_long");
  const priority = String(b.priority ?? "normal").toLowerCase();
  if (!["low", "normal", "high", "urgent"].includes(priority))
    return err(422, "bad_priority");
  const labels = String(b.labels ?? "").trim().slice(0, 300);
  const selfAssign = b.self_assign === true || b.self_assign === 1
    || b.self_assign === "1" || b.self_assign === "true";
  const now = Date.now();
  // Issue 同样要节流：all-agent 开放后不能变成无限 D1 写入入口。
  // 用项目级分钟窗口，默认最多 20 条/分钟；不额外建表，也不走过期 DO 热状态。
  const quota = await projectQuota(env, project);
  const issueCap = Math.min(20, Math.max(1, quota.maxMsgsPerMin));
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM issues WHERE project = ? AND created_at > ?"
  ).bind(project, now - 60_000).first<any>().catch(() => null);
  if (Number(recent?.n ?? 0) >= issueCap)
    return err(429, `issue_rate_limited:${issueCap}/min`);
  // 与交付同一套卫生检查：issue 标题/正文/标签也不许把密钥带上管理台。
  if (/(AKIA[0-9A-Z]{16}|-----BEGIN[^"]{0,40}PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)/.test(`${title}\n${body}\n${labels}`))
    return err(422, "secret_detected");
  const issueId = "ISS-" + now.toString(36).toUpperCase() + "-" +
    crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  await env.DB.prepare(
    `INSERT INTO issues (project, issue_id, title, body, status, priority, labels,
                         reporter, created_at, updated_at)
     VALUES (?,?,?,?, 'open', ?, ?, ?, ?, ?)`
  ).bind(project, issueId, title, body, priority, labels, agentId, now, now).run();

  // 上报时勾选“自己解决”：Issue 落库后立即转成 reporter 的任务。
  // Issue 已经落库，所以即使建任务失败也返回 201 + self_task.error，避免客户端
  // 把“上报失败”重试成重复 Issue；上报者之后仍可调用 /take 重试。
  let selfTask: any = null;
  if (selfAssign) {
    const out = await dispatchIssueToTask(env, project, issueId, { to: agentId, sender: agentId });
    selfTask = out.ok
      ? { ok: true, task_id: out.task_id, task_link: out.task }
      : { ok: false, status: out.status, error: out.error };
  }

  // 让管理台 WS 立即刷新 Issue tab；普通 agent 看不到这条广播（send 方不是 admin）。
  // 消息写入失败不影响已经落库的 issue。
  let seq: number | null = null;
  try {
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
    const r = await stub.fetch(new Request("https://do/publish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, sender: agentId, topic: "issue", kind: "issue",
                             payload: { issue_id: issueId, title, priority },
                             dedupe_key: `issue:${issueId}` }),
    }));
    const d: any = await r.json().catch(() => ({}));
    seq = d.seq ?? null;
  } catch (e) {
    console.warn("issue publish failed", issueId, e);
  }
  return json({ issue_id: issueId, status: "open", priority, seq, created_at: now,
                self_assign: selfAssign, task_id: selfTask?.task_id ?? null,
                self_task: selfTask }, 201);
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
    "style-src 'unsafe-inline'; connect-src 'self' https://cloudflareinsights.com; " +
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

const R2_SHA_CACHE = new Map<string, { etag: string; sha: string }>();

async function r2Sha(env: Env, key: string): Promise<string> {
  const obj = await env.BLOBS.get(key);
  if (!obj) return "";
  const etag = String((obj as any).etag ?? "");
  const hit = R2_SHA_CACHE.get(key);
  if (hit && hit.etag === etag) return hit.sha;
  let sha = String((obj as any).customMetadata?.sha256 ?? "");
  if (!sha) {
    const buf = new Uint8Array(await obj.arrayBuffer());
    sha = await sha256Bytes(buf);
    try { await env.BLOBS.put(key, buf, { customMetadata: { sha256: sha } }); } catch {}
  }
  if (R2_SHA_CACHE.size > 64) R2_SHA_CACHE.delete(R2_SHA_CACHE.keys().next().value as string);
  R2_SHA_CACHE.set(key, { etag, sha });
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
const err = (status: number, reason: string) => {
  const r = json({ error: reason }, status);
  if (status === 503) r.headers.set("retry-after", "30");
  return r;
};
/** D1 配额/故障时给客户端一个可重试的 JSON 503，不要把 Worker 异常抛成 CF 1101 HTML。 */
const dbUnavailable = () => {
  const r = err(503, "db_unavailable");
  r.headers.set("retry-after", "30");
  return r;
};

// 管理台轮询会高频打 /admin/stats 与 /admin/analytics；D1 免费额度按 rows_read 计，
// 这里做短 TTL 缓存，避免多开标签页把当天额度打穿。
const STATS_CACHE = new Map<string, { at: number; data: any }>();
const ANALYTICS_CACHE = new Map<string, { at: number; data: any }>();
const CACHE_MAX = 64;
function cacheGet(map: Map<string, { at: number; data: any }>, key: string, ttlMs: number) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  if (hit) map.delete(key);
  return null;
}
function cacheSet(map: Map<string, { at: number; data: any }>, key: string, data: any) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value as string);
  map.set(key, { at: Date.now(), data });
}
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
    // 网络优先：二进制/安装脚本会被同名覆盖，cache-first 会长期发旧版本。
    // 只有离线时才回退缓存。
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) caches.open("hub-v2").then((c) => c.put(e.request, r.clone())).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || Response.error())));
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

