// Worker：唯一入口。data plane = /p/{project}/…（agent token）
//                      control plane = /admin/…（admin token 或 Access 已通过）
import { Env, IDLE_AFTER_DEFAULT_S, IDLE_DEFAULT_MESSAGE, IDLE_FOLLOWUP_DEFAULT_S } from "./types";
import CONSOLE_HTML from "../../admin/index.html";
import { ACTIVE_TASK_LIMIT } from "./project-room";
import { AGENT_CAPABILITIES, AGENT_SKILL_BODY } from "./skill";
export { ProjectRoom } from "./project-room";

const AGENT_SCOPES = ["poll", "ack", "report", "heartbeat", "publish", "tasks.claim", "tasks.release",
                      "tasks.read", "issues.read", "issues.report",
                      "artifact.write", "submissions.read", "submissions.create"];
const ADMIN_SCOPES = ["admin", ...AGENT_SCOPES, "artifact.read"];
const ALL_SCOPES = new Set([...ADMIN_SCOPES, ...AGENT_SCOPES]);
// 观察员只读：能心跳、拉事件/任务/Issue/交付，但不能 claim、report、写 artifact。
// 管理身份只需要全量事件时用它，避免为了看事件签发 admin 全写 token。
const OBSERVER_SCOPES = ["poll", "heartbeat", "tasks.read", "issues.read", "submissions.read"];

// 公开版本探针：只看构建标记，不含任何项目数据/凭据
const BUILD_TAG = "events-visibility-20261125";
// SDK 发版号：客户端据此判断是否需要自我升级（与二进制 sha 一起下发，防中间人换包）
const SDK_VERSION = "0.5.10";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") return html(LANDING);

    // 公开能力自描述：只包含版本与公开 API 说明，不含项目数据/token。
    // 客户端升级后先读 /ver 的 skill_sha256，再决定是否拉 /skill。
    if (path === "/skill") return skillResponse(req);
    if (path === "/capabilities") return capabilitiesResponse();

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
        } catch { out.decode_error = "invalid_assertion"; }
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
      return json({ ...(await versionPayload()), at: Date.now() });

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
    // 观察员是只读身份：可心跳、可 GET 事件/任务/Issue/交付，但不能 claim/report/写 artifact。
    if (auth.role === "observer" && req.method !== "GET" && !action.startsWith("heartbeat"))
      return err(403, "observer_read_only");
    // 交付只读（仅精确的 list / bundle 两个 GET）走 submissions.read：
    // 返工节点要按真实补丁开工，不能要求 admin token（ISS-MWSZPB49-B96120）；
    // 写路径仍按 submissions.create 查，其它 submissions GET 不在这里放行。
    const subRead = req.method === "GET" &&
      (action === "submissions" || /^submissions\/[^/]+\/bundle$/.test(action));
    const taskPoolRead = req.method === "GET" && action === "tasks";
    // 单条任务自查：GET /p/{project}/tasks/{task_id}。排除内部动作，避免把
    // tasks/active-load 等管理端点误当成任务详情而绕过 admin 鉴权。
    const taskInternal = /^(claim|release|create|list|get|active-load|admin-close|admin-reclaim|admin-reassign|fail|submission-settled)$/;
    const taskDetailRead = req.method === "GET" && /^tasks\/[A-Za-z0-9._:-]{1,64}$/.test(action) &&
      !taskInternal.test(action.slice(6));
    const issuePoolRead = req.method === "GET" && action === "issues";
    const requiredScope = taskPoolRead || taskDetailRead ? "tasks.read"
      : issuePoolRead ? "issues.read"
      : subRead ? "submissions.read" : need(action);
    if (!inScope(auth.scopes!, requiredScope))
      return err(403, `insufficient_scope: 需要 ${requiredScope}，当前 [${(auth.scopes || []).join(",")}]`);
    if (auth.projectStatus === "paused" && req.method !== "GET") return err(423, "project_paused");

    // 普通 agent 的主动调用记录：心跳/自动 ack/收件不算，其余接口都算“有动作”，
    // 避免把一直在 wait 的节点误判为空闲。写 D1 异步执行，不拖慢原请求。
    const idlePassive = action.startsWith("heartbeat") || action.startsWith("ack") ||
      action === "inbox" || action === "events" || action === "ws-ticket";
    if (auth.role !== "admin" && auth.agentId && !idlePassive) {
      const kind = taskPoolRead ? "task_list" : issuePoolRead ? "issue_list" : "activity";
      ctx.waitUntil(markIdleActivity(env, project, auth.agentId, kind));
    }

    // 任务自查：?mine=1 返回自己名下任务（含未 claim 的定向 open、blocked 等）。
    if (taskPoolRead && url.searchParams.get("mine") === "1")
      return listMyTasks(env, project, url, auth.agentId!);
    // 单条任务详情：仅 owner / to / released_by 命中自己的任务；admin 可看全部。
    if (taskDetailRead)
      return getTaskForAgent(env, project, action.slice(6), auth.agentId!, auth.role === "admin");
    // 公共池只读发现：普通 agent 先看再 claim；接口只返回未指派 open 任务。
    if (taskPoolRead) return listPublicTasks(env, project, url);
    // open 且未指派 Issue 只读发现；不发正文之外的审计字段。
    if (issuePoolRead) return listOpenIssues(env, project, url);

    // 交付创建在 Worker 侧完成（需查 R2 + 写 D1），不转发给 DO
    if (action === "submissions" && req.method === "POST")
      return createSubmission(req, env, project, auth.agentId!, auth.role === "admin");

    // 交付只读在 Worker 侧查 D1 / 拼 bundle，不转发给 DO（DO 没有 submissions 动作，
    // 此前 GET /p/<proj>/submissions 只会得到 404 unknown_action）。
    if (action === "submissions" && req.method === "GET")
      return listSubmissions(env, project, url, auth.role === "admin");
    const subBundle = action.match(/^submissions\/([^/]+)\/bundle$/);
    if (subBundle && req.method === "GET")
      return bundleSubmission(env, project, subBundle[1]);

    // Issue 上报同样在 Worker 侧写 D1；权限对所有 agent 默认放行（见 inScope）。
    if (action === "issues" && req.method === "POST")
      return createIssue(req, env, project, auth.agentId!);

    // 上报者自助转任务：只允许 issue.reporter 本人，且必须仍是 open 且未派发。
    // 不能复用管理员的 /dispatch 路由，否则普通 agent 可以替别人派单。
    const issueTake = action.match(/^issues\/([A-Za-z0-9._:-]{1,128})\/take$/);
    if (issueTake && req.method === "POST")
      return takeIssue(req, env, project, auth.agentId!, issueTake[1]);
    // 任意项目 agent 认领一条 open 且未指派的 Issue；等价于转成自己的定向任务。
    const issueClaim = action.match(/^issues\/([A-Za-z0-9._:-]{1,128})\/claim$/);
    if (issueClaim && req.method === "POST")
      return takeIssue(req, env, project, auth.agentId!, issueClaim[1], false);

    let pubMaxPerMin = 0;
    if (["publish", "report"].includes(action) && req.method === "POST") {
      // 只注入配额，计数由 DO 原子完成；Worker 侧预查会让幂等重试误吃 429
      pubMaxPerMin = (await projectQuota(env, project)).maxMsgsPerMin;
    }
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
    let doSearch = url.search;
    if (action === "inbox" || action === "events") {
      // 必须“覆盖”而不是“追加”：append 会让 URLSearchParams.get 取到攻击者传来的第一个 agent。
      // 管理角色（含管理 agent）使用 "*" 订阅全项目事件/消息；普通 agent 只能用自己的 id。
      // 兼容历史管理 token：role=agent 但 scopes 里带 admin/* 的，也按管理视角处理。
      const scopes = auth.scopes ?? [];
      const adminView = auth.role === "admin" || scopes.includes("admin") || scopes.includes("*");
      const q = new URLSearchParams(url.search);
      q.set("agent", adminView ? "*" : (auth.agentId ?? ""));
      q.set("event_role", auth.role === "observer" ? "observer" : adminView ? "admin" : "agent");
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
                                   ...(action.startsWith("heartbeat") ? { latest_sdk_version: SDK_VERSION } : {}),
                                   ...(pubMaxPerMin ? { max_per_min: pubMaxPerMin } : {}) });
    }
    // S4：事件流响应带服务端版本，客户端/管理侧不用再逐个接口探版本。
    if (action === "events" && req.method === "GET") {
      const er = await stub.fetch(new Request(doUrl, init));
      const ed: any = await er.json().catch(() => ({}));
      return json({ ...ed, server_version: { sdk: SDK_VERSION, build: BUILD_TAG } }, er.status);
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
          await stub.fetch(new Request("https://do/cron/tick", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: r.project }),
          }));
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
                   "tasks.claim", "tasks.release", "tasks.read", "issues.read", "issues.report",
                   "submissions.read", "submissions.create", "artifact.write", "artifact.read"];
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
  // 兼容历史管理 token：role=agent 但带 admin/* scope，WS 也要有全量事件视角。
  // 普通 agent/observer 仍按自身角色；observer 不升成 admin，避免拿到原始全量消息。
  const scopes = auth.scopes ?? [];
  const adminView = auth.role === "admin" || scopes.includes("admin") || scopes.includes("*");
  const ticketRole = auth.role === "observer" ? "observer" : adminView ? "admin" : auth.role;
  try {
    await env.DB.prepare(
      "INSERT INTO ws_tickets (ticket,project,agent_id,role,exp_ms,used) VALUES (?,?,?,?,?,0)"
    ).bind(ticket, project, auth.agentId, ticketRole, exp).run();
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
  if (action.startsWith("inbox") || action === "events") return "poll";
  if (action === "tasks/claim") return "tasks.claim";
  if (action === "tasks/release" || action === "tasks/fail") return "tasks.release";
  if (action.startsWith("tasks/admin-")) return "admin";
  if (action === "tasks/list" || action === "tasks/get" || action === "tasks/active-load") return "admin";
  // 台账/单任务元数据/内部 active-load 不对普通 agent 开放
  if (action === "tasks/create") return "admin";                        // 建单只允许管理端
  if (action === "agent/activity" || action === "agent/get" || action === "agent/control" || action === "agents/idle-list") return "admin";
  if (action === "issues" || action.startsWith("issues/")) return "issues.report";
  if (action.startsWith("submissions")) return "submissions.create";
  return "publish";
}
const inScope = (s: string[], n: string) => {
  // 管理端签发过的 token 可能用 "*" 表示全量 scope；不能只按具体名称匹配，
  // 否则管理 agent 连 inbox/events 都会被 403（WS 又走 role，表现成“只有长连接能用”）。
  if (s.includes("*")) return true;
  // 需求：上报 issue 默认对所有 agent 开放。不能只靠新 token 的 scope，
  // 存量 token 的 scopes 里没有 issues.report，也必须在数据面放行。
  if (n === "issues.report") return true;
  // 交付只读：存量 token 没有新加的 submissions.read，但默认都有 submissions.create，
  // 用 create 作为兼容别名，避免升级后返工节点突然看不到补丁。
  if (n === "submissions.read")
    return s.includes("submissions.read") || s.includes("submissions.create") || s.includes("admin");
  return s.includes(n) || s.includes("admin") ||
    // 兼容：存量 token 只有 publish，给它们继续走 claim/release 的过渡期。
    ((n === "tasks.claim" || n === "tasks.release") && s.includes("publish"));
};

async function projectQuota(env: Env, project: string) {
  const r = await env.DB.prepare(
    "SELECT max_agents, max_storage_mb, max_msgs_per_min FROM projects WHERE project = ?"
  ).bind(project).first<any>().catch(() => null);
  return {
    maxAgents: Number(r?.max_agents ?? 200),
    maxStorageMb: Number(r?.max_storage_mb ?? 2048),
    maxMsgsPerMin: Number(r?.max_msgs_per_min ?? 60),
  };
}

/** 管理侧派单提醒：只提醒，不阻断。读取 DO 的 active-load，按同一口径统计。 */
async function taskLoadWarning(stub: any, agentId: string): Promise<any | null> {
  if (!agentId) return null;
  const r = await stub.fetch(new Request("https://do/tasks/active-load", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  })).catch(() => null);
  if (!r || !r.ok) return null;
  const d: any = await r.json().catch(() => ({}));
  const active = Number(d.active_tasks ?? 0);
  if (active <= ACTIVE_TASK_LIMIT) return null;
  return {
    code: "agent_task_load_high",
    agent_id: agentId,
    active_tasks: active,
    limit: ACTIVE_TASK_LIMIT,
    task_ids: Array.isArray(d.task_ids) ? d.task_ids : [],
    message: `${agentId} 当前名下已 claim 未完成任务 ${active} 个，超过建议上限 ${ACTIVE_TASK_LIMIT}；仍已派发，请提醒其先完成或释放部分任务。`,
  };
}

/** 记录普通 agent 的主动调用；写 D1 的 agent_idle，供 cron 和管理台使用。 */
async function markIdleActivity(env: Env, project: string, agentId: string, kind: string) {
  const now = Date.now();
  try {
    await env.DB.prepare(
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
}

async function idleConfig(env: Env, project: string) {
  const fallback = {
    enabled: true,
    idle_after_s: IDLE_AFTER_DEFAULT_S,
    followup_after_s: IDLE_FOLLOWUP_DEFAULT_S,
    message: IDLE_DEFAULT_MESSAGE,
    ready: true,
  };
  try {
    const row = await env.DB.prepare(
      `SELECT enabled, idle_after_s, followup_after_s, message
         FROM idle_reminder_config WHERE project = ?`
    ).bind(project).first<any>();
    if (!row) return fallback;
    return {
      enabled: Number(row.enabled) !== 0,
      idle_after_s: Math.max(1, Math.min(86400, Number(row.idle_after_s) || IDLE_AFTER_DEFAULT_S)),
      followup_after_s: Math.max(1, Math.min(86400, Number(row.followup_after_s) || IDLE_FOLLOWUP_DEFAULT_S)),
      message: String(row.message || IDLE_DEFAULT_MESSAGE),
      ready: true,
    };
  } catch (e) {
    console.warn("idle config read failed", project, e);
    return { ...fallback, enabled: false, ready: false };
  }
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
    const project = String(url.searchParams.get("project") ?? "").trim();
    const policy = await loadPolicy(env);
    const allRows = (await env.DB.prepare(
      "SELECT project FROM projects WHERE status='active' ORDER BY created_at"
    ).all<any>()).results.map((r: any) => String(r.project));
    let visible = policy.mode === "all" ? allRows : allRows.filter((p) => (policy.projects || []).includes(p));
    if (project) {
      if (!/^[a-z0-9-]{2,40}$/.test(project)) return err(422, "bad_project");
      if (!visible.includes(project)) return err(403, "project_not_visible");
      visible = [project];
    }
    // 统计卡必须和其它管理台列表使用同一套可见项目口径；全局视图不能把
    // policy 隐藏或已归档的项目算进来，否则顶部“项目/交付/Issue”会和列表对不上。
    const scope = project || "*";
    const cacheKey = project ? `p:${project}` : `g:${policy.mode}:${visible.join(",")}`;
    if (!fresh) {
      const cached = cacheGet(STATS_CACHE, cacheKey, 180_000);
      if (cached) return json({ ...cached, at: now, cached: true });
    }
    const inSql = visible.length
      ? ` AND project IN (${visible.map(() => "?").join(",")})`
      : " AND 0";
    const args = visible.length ? [...visible] : [];
    const sub = await env.DB.prepare(
      "SELECT state, COUNT(*) AS n FROM submissions WHERE 1=1" + inSql + " GROUP BY state"
    ).bind(...args).all<any>();
    const issue = await env.DB.prepare(
      "SELECT status, COUNT(*) AS n FROM issues WHERE 1=1" + inSql + " GROUP BY status"
    ).bind(...args).all<any>();
    const ag = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)" + inSql
    ).bind(now, ...args).first<any>();
    const enr = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM enrollments WHERE status='pending'" + inSql
    ).bind(...args).first<any>();
    const hb = await env.DB.prepare(
      "SELECT COUNT(DISTINCT project || ':' || agent_id) AS n FROM hb_hist WHERE bucket > ?" + inSql
    ).bind(Math.floor(now / 300000) - 288, ...args).first<any>();
    const perProj = await env.DB.prepare(
      `SELECT project, COUNT(*) AS agents FROM agents
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)` + inSql +
      ` GROUP BY project ORDER BY project`
    ).bind(now, ...args).all<any>();
    const online = await env.DB.prepare(
      "SELECT COUNT(DISTINCT project || ':' || agent_id) AS n FROM hb_hist WHERE bucket >= ?" + inSql
    ).bind(Math.floor(now / 300000) - 1, ...args).first<any>();
    const payload = {
      projects: visible.length,
      agents_online: online?.n ?? 0,
      agents_active: ag?.n ?? 0, enrollments_pending: enr?.n ?? 0,
      agents_heartbeat_24h: hb?.n ?? 0,
      submissions: Object.fromEntries(sub.results.map((r: any) => [r.state, Number(r.n ?? 0)])),
      issues: Object.fromEntries(issue.results.map((r: any) => [r.status, Number(r.n ?? 0)])),
      per_project: perProj.results,
      scope, generated_at: now, at: now, cached: false,
    };
    cacheSet(STATS_CACHE, cacheKey, payload);
    return json(payload);
  }

  // 管理台数据看板：消息/交付/Issue 趋势 + 交付状态分布。支持 7/30/90 天，
  // 同时返回上一个等长周期用于对比；只查 D1 聚合，不读 DO 正文。
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
    const days = analyticsDays(url.searchParams.get("days"), 7);
    const fresh = url.searchParams.get("fresh") === "1";
    const cacheKey = JSON.stringify([only, policy.mode, projects, days]);
    if (!fresh) {
      const cached = cacheGet(ANALYTICS_CACHE, cacheKey, 300_000);
      if (cached) return json({ ...cached, at: now, cached: true });
    }
    const dayKeys = analyticsDayKeys(days);
    const sinceDay = dayKeys[0];
    const prevStartDay = analyticsPrevStartDay(dayKeys, days);
    const prevStartMs = Date.parse(prevStartDay + "T00:00:00Z");
    const range = {
      days, from: sinceDay, to: dayKeys[dayKeys.length - 1],
      previous_from: prevStartDay,
      previous_to: new Date(Date.parse(sinceDay + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10),
    };
    const zeroDaily = dayKeys.map((day) => ({ day, messages: 0, submissions: 0, issues: 0 }));
    const zeroTotals = { messages: 0, submissions: 0, issues: 0 };
    if (!projects.length) {
      return json({ at: now, scope: only || "all", projects: [], days, range,
                    activity_available: true, daily: zeroDaily,
                    submission_states: {}, issue_states: {},
                    totals: zeroTotals, previous: zeroTotals });
    }
    const inSql = projects.map(() => "?").join(",");
    const [archive, subs, states, issueDaily, issueStates] = await Promise.all([
      env.DB.prepare(
        `SELECT substr(ts,1,10) AS day, COUNT(*) AS n FROM archive
          WHERE project IN (${inSql}) AND ts >= ? GROUP BY day`
      ).bind(...projects, prevStartDay).all<any>(),
      env.DB.prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM submissions
          WHERE project IN (${inSql}) AND created_at >= ? GROUP BY day`
      ).bind(...projects, prevStartMs).all<any>(),
      env.DB.prepare(
        `SELECT state, COUNT(*) AS n FROM submissions WHERE project IN (${inSql}) GROUP BY state`
      ).bind(...projects).all<any>(),
      env.DB.prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM issues
          WHERE project IN (${inSql}) AND created_at >= ? GROUP BY day`
      ).bind(...projects, prevStartMs).all<any>(),
      env.DB.prepare(
        `SELECT status, COUNT(*) AS n FROM issues WHERE project IN (${inSql}) GROUP BY status`
      ).bind(...projects).all<any>(),
    ]);
    const msgRows = activityRowsOf(archive);
    const subRows = activityRowsOf(subs);
    const issueRows = activityRowsOf(issueDaily);
    const msgMap = activityCountMap(msgRows);
    const subMap = activityCountMap(subRows);
    const issueMap = activityCountMap(issueRows);
    const daily = dayKeys.map((day) => ({
      day, messages: msgMap.get(day) ?? 0, submissions: subMap.get(day) ?? 0,
      issues: issueMap.get(day) ?? 0,
    }));
    const previous = {
      messages: activityPrevious(msgRows, sinceDay),
      submissions: activityPrevious(subRows, sinceDay),
      issues: activityPrevious(issueRows, sinceDay),
    };
    const totals = daily.reduce((a, b) => ({
      messages: a.messages + b.messages, submissions: a.submissions + b.submissions,
      issues: a.issues + b.issues,
    }), { messages: 0, submissions: 0, issues: 0 });
    const payload = {
      at: now,
      scope: only || "all",
      projects, days, range, activity_available: true,
      daily,
      submission_states: Object.fromEntries(states.results.map((r: any) => [r.state, Number(r.n)])),
      issue_states: Object.fromEntries(issueStates.results.map((r: any) => [r.status, Number(r.n)])),
      totals, previous,
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
    let projectsOk = 0;
    const failedProjects: string[] = [];
    for (const project of visible) {
      try {
        const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.IDFromName("v9:" + project));
        const r = await stub.fetch(new Request("https://do/agent/list"));
        const d = await r.json<any>().catch(() => null);
        if (!r.ok) throw new Error(`agent_list_${r.status}`);
        if (!d || !Array.isArray(d.agents)) throw new Error("agent_list_bad_payload");
        for (const a of d.agents) agents.push({ ...a, project });
        projectsOk++;
      } catch { failedProjects.push(project); /* 单个项目的 DO 抖动不影响其它项目的总览，但必须让前端知道少了一个项目 */ }
    }
    agents.sort((a, b) =>
      String(a.project ?? "").localeCompare(String(b.project ?? "")) ||
      String(a.agent_id ?? "").localeCompare(String(b.agent_id ?? "")));
    const projectsFailed = visible.length - projectsOk;
    return json({ agents, at: Date.now(), projects_total: visible.length,
                  projects_ok: projectsOk, projects_failed: projectsFailed,
                  projects_failed_names: failedProjects, partial: projectsFailed > 0 });
  }

  if (path === "/admin/enrollments" && req.method === "GET") {
    const policy = await loadPolicy(env);
    const active = (await env.DB.prepare(
      "SELECT project FROM projects WHERE status='active' ORDER BY created_at"
    ).all<any>()).results.map((r: any) => String(r.project));
    const visible = policy.mode === "all" ? active : active.filter((p) => (policy.projects || []).includes(p));
    const inSql = visible.length ? ` AND project IN (${visible.map(() => "?").join(",")})` : " AND 0";
    const args = visible.length ? [...visible] : [];
    const rows = await env.DB.prepare(
      `SELECT id, project, agent_id, scopes, machine, created_at, status, code
         FROM enrollments WHERE status IN ('pending','approved','rejected')` + inSql +
      ` ORDER BY created_at DESC LIMIT 50`
    ).bind(...args).all();
    const countRows = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM enrollments
        WHERE status IN ('pending','approved','rejected')` + inSql + ` GROUP BY status`
    ).bind(...args).all<any>();
    const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, total: 0 };
    for (const r of countRows.results ?? []) {
      const k = String(r.status ?? "");
      const n = Number(r.n ?? 0);
      if (k in counts) counts[k] = n;
      counts.total += n;
    }
    return json({ enrollments: rows.results, counts, total: counts.total, limit: 50,
                  returned: rows.results.length, truncated: counts.total > rows.results.length });
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
      // 管理台批准时可直接改 Agent ID：新 ID 会写回 enrollment，并随
      // GET /p/enroll/{id} 的轮询响应下发给节点。未传就沿用申请时的 ID。
      const targetAgentId = String(b.agent_id ?? e.agent_id).trim();
      if (!/^[A-Za-z0-9._-]{2,40}$/.test(targetAgentId))
        return err(422, "bad_agent_id: Agent ID 需为 2-40 位字母/数字/点/下划线/短横线");
      // 改名撞上项目里另一个 active agent 时拒绝，避免把别人的 token 轮换掉；
      // 改成自己原来的 ID 仍按“同 agent 换钥”处理。
      if (targetAgentId !== e.agent_id) {
        const conflict = await env.DB.prepare(
          `SELECT 1 FROM agents WHERE project = ? AND agent_id = ? AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
        ).bind(e.project, targetAgentId, now).first<any>();
        if (conflict) return err(409, `agent_id_conflict:${targetAgentId}`);
      }
      // 先查配额；不要把旧 token 先吊销，否则后续 INSERT 失败会把现有 agent 弄成不可用。
      {
        const q = await projectQuota(env, e.project);
        const n = await activeAgentCountExcluding(env, e.project, targetAgentId);
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
      ).bind(e.project, targetAgentId, "agent", scopes, e.token_sha, now).run();
      await env.DB.prepare(
        `UPDATE agents SET revoked_at = ?
          WHERE project = ? AND agent_id = ? AND revoked_at IS NULL AND token_sha <> ?`
      ).bind(now, e.project, targetAgentId, e.token_sha).run();
      await env.DB.prepare(
        "UPDATE enrollments SET status='approved', agent_id=?, scopes=?, decided_at=?, decided_by=? WHERE id=?"
      ).bind(targetAgentId, scopes, now, who, id).run();
      return json({ ok: true, status: "approved", agent_id: targetAgentId,
                    previous_agent_id: e.agent_id, renamed: targetAgentId !== e.agent_id,
                    project: e.project, scopes });
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
    const maxAgents = Math.max(1, Math.min(1000, Number(b.max_agents ?? 200)));
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

  if (p === "/ver") return json({ ...(await versionPayload()), at: Date.now() });

  // /admin/p/{project}/…
  const m = p.match(/^\/admin\/p\/([a-z0-9-]+)\/(.+)$/);
  if (m) {
    const [, project, action] = m;
    const policy = await loadPolicy(env);
    if (policy.mode === "list" && !policy.projects.includes(project))
      return err(403, "project_not_visible");
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));

    if (action === "idle" && req.method === "GET") {
      const config = await idleConfig(env, project);
      if (!config.ready) return json({ config, agents: [], migration_required: true });
      const r = await stub.fetch(new Request("https://do/agents/idle-list", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
      })).catch(() => null);
      const d: any = r && r.ok ? await r.json().catch(() => null) : null;
      const listError = !r || !r.ok || !d || !!d.error || !Array.isArray(d.agents);
      return json({ config, agents: config.enabled && !listError ? d.agents : [],
                    list_error: listError, list_error_detail: d?.error ?? null });
    }
    if (action === "idle" && (req.method === "POST" || req.method === "PUT")) {
      const b: any = await req.json().catch(() => ({}));
      const enabled = b.enabled === false || b.enabled === 0 || b.enabled === "0" ? 0 : 1;
      const idleAfter = Math.max(1, Math.min(86400, Number(b.idle_after_s) || IDLE_AFTER_DEFAULT_S));
      const followup = Math.max(1, Math.min(86400, Number(b.followup_after_s) || IDLE_FOLLOWUP_DEFAULT_S));
      const message = String(b.message ?? "").trim().slice(0, 2000) || IDLE_DEFAULT_MESSAGE;
      try {
        await env.DB.prepare(
          `INSERT INTO idle_reminder_config
             (project, enabled, idle_after_s, followup_after_s, message, updated_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(project) DO UPDATE SET
             enabled = excluded.enabled,
             idle_after_s = excluded.idle_after_s,
             followup_after_s = excluded.followup_after_s,
             message = excluded.message,
             updated_at = excluded.updated_at`
        ).bind(project, enabled, idleAfter, followup, message, Date.now()).run();
      } catch (e) {
        console.warn("idle config save failed", project, e);
        return err(503, "idle_migration_required");
      }
      return json({ ok: true, config: await idleConfig(env, project) });
    }
    if (action === "idle/check" && req.method === "POST") {
      const r = await stub.fetch(new Request("https://do/cron/tick", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
      })).catch(() => null);
      if (!r || !r.ok) return err(503, "idle_check_failed");
      return json(await r.json().catch(() => ({ ok: true })));
    }
    if (action === "idle/remind" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const agentId = String(b?.agent_id ?? "").trim();
      if (!agentId) return err(422, "agent_id_required");
      const cfg = await idleConfig(env, project);
      if (!cfg.ready) return err(503, "idle_migration_required");
      if (!cfg.enabled) return err(409, "idle_disabled");
      // DO 负责在线/任务占用检查、发送消息并重置 followup 周期。
      const r = await stub.fetch(new Request("https://do/agents/idle-remind", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, agent_id: agentId }),
      })).catch(() => null);
      const d: any = r ? await r.json().catch(() => ({ error: "idle_remind_failed" }))
                       : { error: "idle_remind_failed" };
      return json(d, r?.status || 503);
    }
    if (action === "agents") return stub.fetch(new Request("https://do/agent/list"));
    if (action === "agents/config" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const r = await stub.fetch(new Request("https://do/agents/config", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project }),
      }));
      return Response.json(await r.json().catch(() => ({})), { status: r.status });
    }
    // 外部管理端事件推送配置。webhook 配置和 secret 只存在该项目 DO；
    // GET 只回 has_secret，绝不把 secret 回传给浏览器/管理端。
    if (action === "webhook" && req.method === "GET")
      return stub.fetch(new Request("https://do/webhook/get"));
    if (action === "webhook" && (req.method === "PUT" || req.method === "POST")) {
      const b: any = await req.json().catch(() => ({}));
      const r = await stub.fetch(new Request("https://do/webhook/set", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project }),
      }));
      return Response.json(await r.json().catch(() => ({})), { status: r.status });
    }
    if (action === "webhook/test" && req.method === "POST") {
      const r = await stub.fetch(new Request("https://do/webhook/test", { method: "POST" }));
      return Response.json(await r.json().catch(() => ({})), { status: r.status });
    }
    // 效率观测：队列健康度、等待/周期分位、失败率、死信与节点 lane。
    if (action === "observability" && req.method === "GET") {
      const windowMs = Number(url.searchParams.get("window_ms") ?? 24 * 60 * 60_000);
      const r = await stub.fetch(new Request("https://do/observability", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, window_ms: windowMs }),
      }));
      const d: any = await r.json().catch(() => ({}));
      // S4：管理侧一眼分清 manifest 标版与实际 worker；旧 DO 也由 Worker 统一补齐。
      return json({ ...d, server_version: { sdk: SDK_VERSION, build: BUILD_TAG,
                                            at: new Date().toISOString() } }, r.status);
    }
    // 单任务时间线：management-only，返回热窗口 + D1 归档 + 记录里程碑。
    if (action === "tasks/timeline" && req.method === "GET") {
      const taskId = String(url.searchParams.get("task_id") ?? "").trim();
      if (!taskId) return err(422, "task_id_required");
      const r = await stub.fetch(new Request("https://do/tasks/timeline", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, task_id: taskId, sender: "admin" }),
      }));
      return Response.json(await r.json().catch(() => ({})), { status: r.status });
    }
    // S1：合入回写。任务时间线与任务台账据此显示最终合入提交；不重开任务，只补审计字段。
    if (action === "tasks/merge" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (!String(b.task_id ?? "").trim()) return err(422, "task_id_required");
      const r = await stub.fetch(new Request("https://do/tasks/admin-merge", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin" }),
      }));
      return Response.json(await r.json().catch(() => ({})), { status: r.status });
    }
    // S5：把长期排队/目标离线的定向任务退回公共池；管理台可再转派给在线节点。
    if (action === "tasks/requeue" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (!String(b.task_id ?? "").trim()) return err(422, "task_id_required");
      const r = await stub.fetch(new Request("https://do/tasks/admin-requeue", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin" }),
      }));
      return Response.json(await r.json().catch(() => ({})), { status: r.status });
    }
    // S1：main CI 状态回写。红/绿都进事件流，管理侧或 Webhook 可即时收到。
    if (action === "ci" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const status = String(b.status ?? b.state ?? "").trim().toLowerCase();
      if (!["ok", "red", "green", "failed", "passed", "pending"].includes(status))
        return err(422, "bad_ci_status");
      const normalized = ["red", "failed"].includes(status) ? "red"
        : ["ok", "green", "passed"].includes(status) ? "green" : "pending";
      const sha = String(b.sha ?? b.commit ?? "").trim().toLowerCase().slice(0, 64);
      if (sha && !/^[a-f0-9]{7,64}$/.test(sha)) return err(422, "bad_commit_sha");
      const now = Date.now();
      const r = await stub.fetch(new Request("https://do/publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project, sender: "admin", topic: "ci", kind: "status",
          payload: { status: normalized, sha: sha || null,
                     branch: String(b.branch ?? "main").trim().slice(0, 120) || "main",
                     url: String(b.url ?? "").trim().slice(0, 500) || null,
                     summary: String(b.summary ?? "").trim().slice(0, 500) || null,
                     message: normalized === "red" ? "main CI 变红" : `CI ${normalized}` },
          dedupe_key: `ci:${normalized}:${sha}:${now}`,
        }),
      }));
      return Response.json({ ok: r.ok, ci: normalized, sha: sha || null,
                             branch: String(b.branch ?? "main") }, { status: r.ok ? 200 : r.status });
    }
    // 手动重试死信/阻塞任务；与任务四个出口一样由 admin sender 走 DO 审计。
    if (action === "tasks/retry" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (!String(b.task_id ?? "").trim()) return err(422, "task_id_required");
      const r = await stub.fetch(new Request("https://do/tasks/admin-retry", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin" }),
      }));
      return Response.json(await r.json().catch(() => ({})), { status: r.status });
    }
    if (action === "tasks" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const quota = await projectQuota(env, project);
      const r = await stub.fetch(new Request("https://do/tasks/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...b, project, sender: "admin", max_per_min: quota.maxMsgsPerMin,
                               enforce_agent_limit: false }),
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
        const warning = await taskLoadWarning(stub, String(b.to));
        if (warning) d.warning = warning;
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
          brief = { error: "brief_failed" };
        }
        d.brief = brief;
      }
      if (action === "tasks/reassign" && dr.ok && b.to) {
        const warning = await taskLoadWarning(stub, String(b.to));
        if (warning) d.warning = warning;
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
        await publishIssueEvent(env, project, { ...row, status: "closed" }, "closed",
                                { close_reason: reason });
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
        await publishIssueEvent(env, project, { ...row, status: "open",
                                                task_id: clearTask ? null : row.task_id }, "reopened",
                                { task_id_cleared: clearTask });
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
        await publishIssueEvent(env, project, { ...row, status: "merged" }, "merged",
                                { merged_into: into });
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
      const target = b.to === undefined || b.to === null || String(b.to).trim() === ""
        ? "" : String(b.to).trim();
      const warning = target ? await taskLoadWarning(stub, target) : null;
      await publishIssueEvent(env, project, { ...row, status: "open", task_id: out.task_id }, "dispatched",
                              { target: target || "public", warning: warning ? warning.warning ?? null : null });
      return json({ ok: true, issue_id: issueId, status: "open", task_id: out.task_id,
                    dispatched: true, task_link: out.task, ...(warning ? { warning } : {}) });
    }

    if (action === "snapshot") return stub.fetch(new Request("https://do/snapshot"));

    // 单个 agent 的活动趋势：只回日粒度聚合，不把消息/任务正文拖进管理台；
    // 供详情页的小图和“完整趋势”弹层共用，避免每次切换范围都重新拉整份详情。
    const agentActivityMatch = action.match(/^agent\/([A-Za-z0-9._:-]{1,80})\/activity$/);
    if (agentActivityMatch && req.method === "GET") {
      const id = decodeURIComponent(agentActivityMatch[1]);
      const days = analyticsDays(url.searchParams.get("days"), 7);
      return json(await loadAgentActivity(env, project, id, days));
    }

    // 单个 agent 的远程运行参数：自动投送强制开关、debug 日志、心跳周期。
    // 只写 DO 的期望状态，由客户端下一次心跳拉取并回报 control.rev；不通过消息通道执行命令。
    const agentControlMatch = action.match(/^agent\/([A-Za-z0-9._:-]{1,80})\/control$/);
    if (agentControlMatch && req.method === "POST") {
      const id = decodeURIComponent(agentControlMatch[1]);
      const b: any = await req.json().catch(() => ({}));
      const remote: any = {};
      if ("auto_forward" in b) remote.auto_forward = b.auto_forward;
      if ("debug" in b) remote.debug = b.debug;
      if ("heartbeat_s" in b) remote.heartbeat_s = b.heartbeat_s;
      if (!Object.keys(remote).length) return err(422, "control_field_required");
      const dr = await stub.fetch(new Request("https://do/agent/control", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: id, remote_control: remote, sender: "admin" }),
      }));
      const d: any = await dr.json().catch(() => ({ error: "agent_control_failed" }));
      return json(d, dr.status);
    }

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

    // 单个 agent 详情：资源曲线 + 消息 + 提交 + 任务履历/工作统计
    if (action.startsWith("agent/") && req.method === "GET") {
      const id = decodeURIComponent(action.slice(6));
      const days = analyticsDays(url.searchParams.get("days"), 7);
      const activity = await loadAgentActivity(env, project, id, days);
      // 启动参数只存在 DO 热记录里；详情单独取一次，名册只回摘要，避免轮询把 argv 反复拉大。
      let client: any = null;
      let clientAvailable = false;
      try {
        const cr = await stub.fetch(new Request(`https://do/agent/get?id=${encodeURIComponent(id)}`));
        const cd: any = await cr.json().catch(() => null);
        if (!cr.ok || !cd || !cd.agent) throw new Error(`agent_get_${cr.status}`);
        client = cd.agent;
        clientAvailable = true;
      } catch { /* DO 抖动时详情其余部分仍可用，前端明确显示启动参数读取失败 */ }
      const hb = await env.DB.prepare(
        `SELECT bucket,cpu_pct,mem_used_mb,disk_used_pct,work_state FROM hb_hist
         WHERE project=? AND agent_id=? ORDER BY bucket DESC LIMIT 120`
      ).bind(project, id).all();
      const subs = await env.DB.prepare(
        `SELECT submission_id,state,kind,title,base_sha,task_id,review_state,created_at,updated_at
           FROM submissions WHERE project=? AND agent_id=?
          ORDER BY created_at DESC LIMIT 50`
      ).bind(project, id).all();
      const ag = await env.DB.prepare(
        `SELECT agent_id,role,scopes,created_at,expires_at,revoked_at FROM agents
         WHERE project=? AND agent_id=? AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`).bind(project, id).first();
      let inbox: any = { messages: [] };
      let messagesAvailable = false;
      try {
        const ir = await stub.fetch(new Request(`https://do/inbox?since=0&limit=200&agent=*&desc=1`));
        const idata: any = await ir.json();
        if (!ir.ok || !idata || !Array.isArray(idata.messages)) throw new Error("inbox_bad_payload");
        inbox = idata;
        messagesAvailable = true;
      } catch { /* 消息读取失败时不要渲染成“暂无消息” */ }
      const msgs = (inbox.messages ?? []).filter((m: any) =>
        m.sender === id || (Array.isArray(m.to) ? m.to.includes(id) : m.to === id)).slice(-30);

      // 任务履历：owner（做过）、to（定向给它但还没 claim）、released_by（做完释放）、
      // reassigned_from/reclaimed_from（转派/取回前的负责人）并集；按更新时间倒序保留 60 条。
      let allTasks: any[] = [];
      let tasksKnown = false;
      try {
        const tr = await stub.fetch(new Request("https://do/tasks/list"));
        const td: any = await tr.json();
        if (!tr.ok || !td || !Array.isArray(td.tasks)) throw new Error("task_list_bad_payload");
        allTasks = td.tasks;
        tasksKnown = true;
      } catch { /* 任务列表读不到时，详情仍应显示曲线与提交，但任务统计必须标未知 */ }
      const touches = (t: any) => {
        const to = Array.isArray(t.to) ? t.to : t.to ? [t.to] : [];
        return t.owner === id || to.includes(id) || t.released_by === id
          || t.reassigned_from === id || t.reclaimed_from === id;
      };
      const tasks = allTasks.filter(touches).sort((a: any, b: any) =>
        Number(b.updated_at ?? b.created_at ?? 0) - Number(a.updated_at ?? a.created_at ?? 0));
      const taskState: Record<string, number> = { open: 0, claimed: 0, released: 0, blocked: 0, done: 0 };
      for (const t of tasks) taskState[t.state] = (taskState[t.state] ?? 0) + 1;

      // 提交与 Issue 的聚合在 D1 侧一次算完，避免把近百条历史拉到前端再数。
      const subStats: any = await env.DB.prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN review_state='approved' THEN 1 ELSE 0 END) approved,
                SUM(CASE WHEN review_state='rejected' THEN 1 ELSE 0 END) rejected,
                SUM(CASE WHEN review_state IN ('pending','accepted') THEN 1 ELSE 0 END) pending
           FROM submissions WHERE project=? AND agent_id=?`
      ).bind(project, id).first().catch(() => null);
      const issueStats: any = await env.DB.prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open,
                SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) closed,
                SUM(CASE WHEN status='merged' THEN 1 ELSE 0 END) merged
           FROM issues WHERE project=? AND reporter=?`
      ).bind(project, id).first().catch(() => null);
      const issues = await env.DB.prepare(
        `SELECT issue_id,title,status,priority,created_at,closed_at FROM issues
          WHERE project=? AND reporter=? ORDER BY created_at DESC LIMIT 12`
      ).bind(project, id).all().catch(() => ({ results: [] }));
      const idle: any = await env.DB.prepare(
        `SELECT last_active_ms,idle_since_ms,reminded_at,flagged_at FROM agent_idle
          WHERE project=? AND agent_id=?`
      ).bind(project, id).first().catch(() => null);
      const num = (x: any) => x === null || x === undefined ? null : Number(x);
      const num0 = (x: any) => Number(x ?? 0);
      return json({
        agent: ag,
        client,
        client_available: clientAvailable,
        activity,
        hb: hb.results ?? [],
        submissions: subs.results ?? [],
        messages: msgs,
        messages_available: messagesAvailable,
        tasks: tasksKnown ? tasks.slice(0, 60) : [],
        issues: issues.results ?? [],
        stats_available: {
          tasks: tasksKnown,
          submissions: !!subStats,
          issues: !!issueStats,
        },
        idle: idle ? {
          last_active_ms: num0(idle.last_active_ms),
          idle_since_ms: num0(idle.idle_since_ms),
          reminded_at: num0(idle.reminded_at),
          flagged_at: num0(idle.flagged_at),
        } : null,
        stats: {
          tasks_total: tasksKnown ? tasks.length : null,
          tasks_open: tasksKnown ? taskState.open : null,
          tasks_claimed: tasksKnown ? taskState.claimed : null,
          tasks_released: tasksKnown ? taskState.released : null,
          tasks_blocked: tasksKnown ? taskState.blocked : null,
          tasks_done: tasksKnown ? taskState.done : null,
          tasks_failed: tasksKnown ? (taskState.failed ?? 0) : null,
          submissions_total: num(subStats?.total),
          submissions_approved: subStats ? Number(subStats.approved ?? 0) : null,
          submissions_rejected: subStats ? Number(subStats.rejected ?? 0) : null,
          submissions_pending: subStats ? Number(subStats.pending ?? 0) : null,
          issues_total: issueStats ? Number(issueStats.total ?? 0) : null,
          issues_open: issueStats ? Number(issueStats.open ?? 0) : null,
          issues_closed: issueStats ? Number(issueStats.closed ?? 0) : null,
          issues_merged: issueStats ? Number(issueStats.merged ?? 0) : null,
          last_active_ms: idle?.last_active_ms ?? null,
          idle_since_ms: idle?.idle_since_ms ?? null,
        },
      });
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
        const kind = String(b.kind ?? "notice");
        const workItem = b.work_item === true && !!b.task_id;
        const r = await stub.fetch(new Request("https://do/publish", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project, sender: "admin", topic: b.topic ?? "admin", kind,
            to: t,
            payload: { title: b.title ?? "", body: b.body ?? "",
                       // 非任务消息走通知 lane，允许在任务执行期间注入窗口；但仍标明
                       // “不是新任务”，避免 TUI 把它当成下一条派单。
                       notice: b.notice !== false && !workItem,
                       ...(workItem ? { work_item: true, task_id: b.task_id } : {}),
                       action_required: { kind, ack_required: !!b.ack_required } },
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
      // 越单只能由管理侧显式发起；普通 agent 不能自报 allow_overtake 绕过绑定。
      const allowOvertake = isAdmin && b.allow_overtake === true;
      const overtakeReason = String(b.overtake_reason ?? "").trim().slice(0, 240);
      if (allowOvertake && !overtakeReason) return err(422, "overtake_reason_required");
      const bind = await resolveSubmissionTask(env, project, agentId, b.task_id, allowOvertake, false);
      if (bind.error) return bind.error;
      const missing = deliveryFormatMissing(kind, norm.refs).concat(deliveryChecksMissing(kind, b.checks));
      if (missing.length) return deliveryFormatError(kind, missing);
      const contentMissing = await deliveryFormatContentMissing(env, project, kind, norm.refs, String(b.base_sha));
      if (contentMissing.length) return deliveryFormatError(kind, contentMissing);
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
                                          kind, title: b.title ?? "", base_sha: b.base_sha,
                                          review_state: "pending",
                                          refs: norm.refs,
                                          overtake: bind.overtake, overtake_reason: bind.overtake ? overtakeReason : null },
                               dedupe_key: `sub:${sid}` }),
      }));
      return Response.json({ submission_id: sid, state: "delivered", task_id: taskId,
                             task_assignee: bind.assigneeAtSubmit, auto_bound: bind.autoBound,
                             overtake: bind.overtake, seq: await seq.json() });
    }

    const bun = action.match(/^submissions\/([^/]+)\/bundle$/);
    if (bun && req.method === "GET") return bundleSubmission(env, project, bun[1]);

    if (action === "submissions" && req.method === "GET")
      return listSubmissions(env, project, url, true);

    const col = action.match(/^submissions\/([^/]+)\/(collect|archive|result)$/);
    if (col && req.method === "POST") {
      const [, id, op] = col;
      const row = await env.DB.prepare(
        "SELECT submission_id, task_id, kind, state, review_state, agent_id FROM submissions WHERE project = ? AND submission_id = ?"
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
        // 裁决变化立即推给交付人；approved 还可能触发任务 done，两条事件各自独立。
        await publishSubmissionEvent(env, project, row, verdict, {
          review_state: verdict, note: note || raw, reviewed_at: now,
        });
        // approved 可能在 collect 之后才到；这里立即按 D1 状态结算。
        let taskLink: any = null;
        if (verdict === "approved" && row.task_id) {
          try { taskLink = await settleTaskAfterSubmission(env, project, row.task_id, "approval"); }
          catch (e: any) { taskLink = { error: "settle_unreachable" }; }
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
      // 交付箱状态变化（收走/归档）也让交付人实时知道；任务结算事件随后单独发。
      await publishSubmissionEvent(env, project, row, op === "collect" ? "collected" : "archived", {
        review_state: review, state, reviewed_at: now,
      });
      // 联动：这件交付挂在某个任务上时，由 Worker 按 D1 的待取/待批状态结算。
      // 结算失败不回滚已落库的取走状态，但必须在响应里响亮标出，不许静默脱钩。
      let taskLink: any = null;
      if (row.task_id) {
        try {
          taskLink = await settleTaskAfterSubmission(env, project, row.task_id, "collection");
        } catch (e: any) {
          taskLink = { error: "settle_unreachable" };
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
    const role = source.role === "admin" ? "admin"
      : source.role === "observer" ? "observer" : "agent";
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
    if (role !== "admin" && role !== "agent" && role !== "observer") return err(422, "bad_role");
    const proj = await env.DB.prepare("SELECT status FROM projects WHERE project = ?").bind(b.project).first<any>();
    if (!proj || proj.status !== "active") return err(404, "project_not_found");

    // 只接受已知 scope；缺省按角色给默认集，管理员绝不能签发成没有 admin 权限的假管理员。
    let list: string[];
    if (b.scopes === undefined || b.scopes === null || b.scopes === "") {
      list = role === "admin" ? [...ADMIN_SCOPES]
        : role === "observer" ? [...OBSERVER_SCOPES]
        : [...AGENT_SCOPES];
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

/** 普通 agent 的公共任务池：只读、只返回 open 且无 to 的任务，按创建时间先到先得。 */
async function listPublicTasks(env: Env, project: string, url: URL) {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 50;
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  const r = await stub.fetch(new Request("https://do/tasks/list"));
  if (!r.ok) return err(r.status, "task_list_failed");
  const d: any = await r.json().catch(() => ({ tasks: [] }));
  const tasks = (d.tasks ?? [])
    .filter((t: any) => t && t.state === "open" && !t.to && !t.owner)
    .sort((a: any, b: any) => Number(a.effective_priority ?? a.priority ?? 2)
      - Number(b.effective_priority ?? b.priority ?? 2)
      || Number(a.deadline_at ?? Infinity) - Number(b.deadline_at ?? Infinity)
      || Number(a.created_at ?? 0) - Number(b.created_at ?? 0))
    .slice(0, limit)
    .map((t: any) => ({
      task_id: t.task_id ?? t.id,
      title: t.title ?? "",
      body: t.body ?? "",
      priority: Number(t.priority ?? 2),
      effective_priority: Number(t.effective_priority ?? t.priority ?? 2),
      deadline_at: t.deadline_at ?? null,
      attempts: Number(t.attempts ?? 0),
      max_attempts: Number(t.max_attempts ?? 3),
      created_at: t.created_at ?? 0,
      updated_at: t.updated_at ?? 0,
      ...(t.issue_id ? { issue_id: t.issue_id } : {}),
    }));
  return json({ tasks, count: tasks.length, limit });
}

/** 任务是否属于某个 agent：owner、定向 to，或由它 release 成 blocked/released。 */
function taskBelongsToAgent(t: any, agentId: string): boolean {
  if (!t || !agentId) return false;
  if (t.owner === agentId) return true;
  const to = Array.isArray(t.to) ? t.to.includes(agentId) : t.to === agentId;
  return !!to || (t.released_by === agentId && (t.state === "blocked" || t.state === "released"));
}

/** 普通 agent 可见的任务字段；不返回内部审计字段。 */
function agentTaskView(t: any, agentId: string) {
  return {
    task_id: t.task_id ?? t.id ?? "",
    title: t.title ?? "",
    body: t.body ?? "",
    state: t.state ?? "",
    owner: t.owner ?? null,
    to: t.to ?? null,
    dispatch_state: t.dispatch_state ?? (t.to && t.state === "claimed" ? "active"
      : t.to && t.state === "open" ? "notified" : "closed"),
    queue_position: Number(t.queue_position ?? 0),
    dispatch_count: Number(t.dispatch_count ?? 0),
    priority: Number(t.priority ?? 2),
    effective_priority: Number(t.effective_priority ?? t.priority ?? 2),
    deadline_at: t.deadline_at ?? null,
    deadline_left_ms: t.deadline_at ? Number(t.deadline_at) - Date.now() : null,
    sla_breached: !!t.deadline_at && Number(t.deadline_at) <= Date.now()
      && t.state !== "done" && t.state !== "failed",
    attempts: Number(t.attempts ?? 0),
    max_attempts: Number(t.max_attempts ?? 3),
    retry_in_ms: t.next_retry_at ? Math.max(0, Number(t.next_retry_at) - Date.now()) : null,
    dead_letter: t.dead_letter === true,
    issue_id: t.issue_id ?? null,
    created_at: t.created_at ?? 0,
    updated_at: t.updated_at ?? 0,
    lease_until: t.lease_until ?? 0,
    pending_submissions: Number(t.pending_submissions ?? 0),
    pending_review: Number(t.pending_review ?? 0),
    blocked_at: t.blocked_at ?? 0,
    released_by: t.released_by ?? null,
    // 配额口径：只有已 claim 到自己名下的 claimed 任务占坑。
    counts_toward_limit: t.state === "claimed" && t.owner === agentId,
  };
}

/** 普通 agent 自查：?mine=1 列出自己名下任务（含 open 定向、blocked、released）。 */
async function listMyTasks(env: Env, project: string, url: URL, agentId: string) {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 50;
  const mine = (await projectTasks(env, project))
    .filter((t: any) => taskBelongsToAgent(t, agentId))
    .sort((a: any, b: any) => Number(b.updated_at ?? b.created_at ?? 0) - Number(a.updated_at ?? a.created_at ?? 0));
  const active = mine.filter((t: any) => t.state === "claimed" && t.owner === agentId).length;
  const tasks = mine.slice(0, limit).map((t: any) => agentTaskView(t, agentId));
  return json({ tasks, count: tasks.length, mine: true,
    quota: { limit: ACTIVE_TASK_LIMIT, active_tasks: active } });
}

/** 普通 agent 自查单条任务；不是自己名下的一律 404，避免枚举/泄露。 */
async function getTaskForAgent(env: Env, project: string, taskId: string, agentId: string, isAdmin: boolean) {
  const task = (await projectTasks(env, project)).find((t: any) => String(t.task_id ?? t.id ?? "") === taskId);
  if (!task || (!isAdmin && !taskBelongsToAgent(task, agentId))) {
    return err(404, "task_not_found");
  }
  return json(agentTaskView(task, agentId));
}

/** 普通 agent 的 Issue 池：只列 open 且尚未生成任务的 Issue。 */
async function listOpenIssues(env: Env, project: string, url: URL) {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 50;
  const rows = await env.DB.prepare(
    `SELECT issue_id, title, body, status, priority, labels, reporter, created_at, updated_at
       FROM issues
      WHERE project = ? AND status = 'open' AND task_id IS NULL
      ORDER BY created_at ASC LIMIT ?`
  ).bind(project, limit).all<any>();
  return json({ issues: rows.results ?? [], count: (rows.results ?? []).length, limit });
}

/** 交付列表（只读）：管理面与数据面共用查询；数据面只返回返工需要的字段。
 *  `result`、`reviewed_by`、`reviewed_at`、`overtake_reason` 属于管理侧审计信息，
 *  不返回给普通 agent。 */
async function listSubmissions(env: Env, project: string, url: URL, full = false) {
  const state = url.searchParams.get("state") ?? "";
  const taskId = url.searchParams.get("task_id") ?? "";
  const review = url.searchParams.get("review_state") ?? "";
  const withCounts = url.searchParams.get("counts") === "1";
  const valid = ["delivered", "collected", "archived"].includes(state);
  const validReview = ["pending", "accepted", "approved", "rejected"].includes(review);
  const cond = ["project = ?"];
  const vals: any[] = [project];
  if (valid) { cond.push("state = ?"); vals.push(state); }
  if (taskId && /^[a-zA-Z0-9._:-]{1,64}$/.test(taskId)) { cond.push("task_id = ?"); vals.push(taskId); }
  if (validReview) { cond.push("review_state = ?"); vals.push(review); }
  const cols = full ? "*" : "submission_id,agent_id,task_id,base_sha,kind,title,refs_json," +
    "checks_json,review_state,task_assignee,overtake,state,created_at,updated_at";
  const rows = await env.DB.prepare(
    `SELECT ${cols} FROM submissions WHERE ${cond.join(" AND ")} ORDER BY created_at DESC LIMIT 100`
  ).bind(...vals).all();
  if (!withCounts) return Response.json(rows.results);
  // 交付箱的“共 N / 待取 / 待裁决”必须基于全量计数，不能拿 LIMIT 100 的行数冒充总数。
  const all = await env.DB.prepare(
    `SELECT state, review_state, COUNT(*) AS n FROM submissions WHERE ${cond.join(" AND ")} GROUP BY state, review_state`
  ).bind(...vals).all<any>();
  const byState: Record<string, number> = {};
  const byReview: Record<string, number> = {};
  let total = 0, delivered = 0, pendingReview = 0;
  for (const r of all.results ?? []) {
    const st = String(r.state ?? "");
    const rv = String(r.review_state ?? "pending");
    const n = Number(r.n ?? 0);
    total += n;
    byState[st] = (byState[st] ?? 0) + n;
    if (st !== "archived") byReview[rv] = (byReview[rv] ?? 0) + n;
    if (st === "delivered") delivered += n;
    if (st !== "archived" && (rv === "pending" || rv === "accepted")) pendingReview += n;
  }
  return Response.json({
    submissions: rows.results,
    total, delivered, pending_review: pendingReview,
    by_state: byState, by_review: byReview,
    limit: 100, returned: rows.results.length, truncated: total > rows.results.length,
  });
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
 * - task_id 必填；不再按“名下只有一个 claimed”猜测，猜错会把交付挂到旧任务；
 * - 显式 task_id 必须是该 agent 当前 active/已 claim 的任务；当前 active 由派单队列
 *   （notified/active）或 claim（claimed）决定，别的 assigned 任务不接收交付；
 * - 管理侧代建可显式 allowOvertake，落库标记「越单」并留理由。
 */
async function resolveSubmissionTask(
  env: Env, project: string, agentId: string, rawTaskId: unknown,
  allowOvertake = false, requireClaimed = true
): Promise<TaskBinding> {
  const taskId = rawTaskId === undefined || rawTaskId === null || String(rawTaskId).trim() === ""
    ? null : String(rawTaskId).trim();
  const autoBound = false;
  const all = await projectTasks(env, project);
  const activeIds = all
    .filter((t: any) => t?.state !== "done"
      && ((t.state === "claimed" && t.owner === agentId)
        || (t.to === agentId && t.state === "open"
          && (!t.dispatch_state || ["notified", "active"].includes(t.dispatch_state)))))
    .map((t: any) => String(t.task_id ?? t.id ?? ""))
    .filter(Boolean)
    .slice(0, 20);
  if (taskId === null) {
    return { taskId: null, task: null, autoBound, overtake: false, assigneeAtSubmit: null,
      error: json({ error: "task_id_required",
                    reason: "提交必须显式指定当前任务；服务端不再按 claimed 数量自动绑定",
                    active_task_ids: activeIds,
                    hint: "用任务消息里的 [task:<id>]，或让 CLI 从 active_task.json 读取；多任务并发时尤其不能省略" }, 422) };
  }

  if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(taskId))
    return { taskId: null, task: null, autoBound, overtake: false, assigneeAtSubmit: null,
             error: err(422, "bad_task_id") };
  let t: any = all.find((x: any) => String(x.task_id ?? x.id ?? "") === taskId) ?? null;
  if (!t) t = await taskMeta(env, project, taskId);
  if (!t)
    return { taskId, task: null, autoBound, overtake: false, assigneeAtSubmit: null,
             error: err(422, `task_not_found:${taskId}`) };
  if (t.state === "done")
    return { taskId, task: t, autoBound, overtake: false, assigneeAtSubmit: null,
             error: err(409, `task_done:${taskId}`) };

  const isOwner = t.state === "claimed" && t.owner === agentId;
  const isAssigned = t.to === agentId && t.state !== "done";
  const isActive = activeIds.includes(taskId);
  // 管理侧显式越单：仍要求任务存在且未 done，但跳过“当前上下文”限制并留痕。
  if (allowOvertake) {
    return { taskId, task: t, autoBound, overtake: true, assigneeAtSubmit: t.owner ?? t.to ?? null };
  }
  // 先查上下文，再查是否 claimed：错误信息要能区分“你拿错任务了”和“你没 claim”。
  if (!isActive) {
    return { taskId, task: t, autoBound, overtake: false, assigneeAtSubmit: t.owner ?? t.to ?? null,
      error: json({ error: "task_context_mismatch", task_id: taskId,
                    task_state: t.state, task_owner: t.owner ?? null, task_to: t.to ?? null,
                    active_task_ids: activeIds,
                    hint: "只能交付当前 active/已 claim 的任务；如果确实要越单，管理侧代建需带 allow_overtake + overtake_reason" }, 409) };
  }
  if (requireClaimed && !isOwner) {
    return { taskId, task: t, autoBound, overtake: false, assigneeAtSubmit: t.owner ?? t.to ?? null,
      error: json({ error: "task_not_claimed", task_id: taskId,
                    task_state: t.state, task_to: t.to ?? null,
                    active_task_ids: activeIds,
                    hint: "该任务已经下发但还没有 claim；先 task-claim，再交付" }, 409) };
  }
  if (!isOwner && !isAssigned) {
    return { taskId, task: t, autoBound, overtake: false, assigneeAtSubmit: t.owner ?? t.to ?? null,
      error: json({ error: "task_not_assignee", task_id: taskId,
                    task_state: t.state, task_owner: t.owner ?? null, task_to: t.to ?? null,
                    hint: "只能交付自己 owner 或被指派的任务；管理侧代建可用 allow_overtake 留痕" }, 409) };
  }
  return { taskId, task: t, autoBound, overtake: false,
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

/** S2：补丁/回执只读首 8MB，避免把 Worker 当大文件转码器。 */
const PATCH_MAX_BYTES = 8 * 1024 * 1024;

function refBaseName(r: NormalizedRef): string {
  return String(r.name ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

/** 统一 diff 的结构校验：文件头、hunk 头、hunk 声明行数与实际 +/- 行必须自洽。
 *  只做语法级校验，不执行 git apply；真正 apply 仍由 CI/管理侧在仓库里做。 */
function validatePatchText(text: string): string | null {
  if (text.length > PATCH_MAX_BYTES) return "patch_too_large";
  if (!/^diff --git |^--- /m.test(text)) return "patch_header_missing";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let files = 0;
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^diff --git /.test(line)) { files++; continue; }
    if (/^--- /.test(line)) { files++; continue; }
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hm) continue;
    hunks++;
    const oldNeed = hm[2] === undefined ? 1 : Number(hm[2]);
    const newNeed = hm[4] === undefined ? 1 : Number(hm[4]);
    let oldGot = 0;
    let newGot = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const body = lines[j];
      if (/^diff --git /.test(body) || /^@@ /.test(body)
          || /^--- /.test(body) || /^\+\+\+ /.test(body)) break;
      if (/^\\ No newline at end of file/.test(body)) continue;
      if (body === "") {
        if (j + 1 < lines.length && (/^diff --git /.test(lines[j + 1]) || /^@@ /.test(lines[j + 1]))) break;
        continue;
      }
      // format-patch appends "-- " plus a version footer after the last hunk.
      // Once the declared hunk counts are complete, it must not be counted as
      // a deleted line; otherwise oldGot overshoots and the whole patch is 422.
      // A -0,0 hunk starts with zero counts but still has body lines, so only
      // apply the footer rule after at least one body line was consumed.
      if (oldGot === oldNeed && newGot === newNeed
          && (oldGot + newGot > 0 || (oldNeed === 0 && newNeed === 0))) {
        if (body === "-- " || (body === "--" && (
          j + 1 >= lines.length
          || lines[j + 1] === ""
          || /^\d+(?:\.\d+)+/.test(lines[j + 1])
          || /^git version /.test(lines[j + 1])
        ))) break;
        if (body[0] === " " || body[0] === "-" || body[0] === "+")
          return `patch_hunk_mismatch:${oldGot}/${oldNeed},${newGot}/${newNeed}`;
        break;
      }
      const c = body[0];
      if (c === " ") { oldGot++; newGot++; }
      else if (c === "-") oldGot++;
      else if (c === "+") newGot++;
      else break;
    }
    if (oldGot !== oldNeed || newGot !== newNeed)
      return `patch_hunk_mismatch:${oldGot}/${oldNeed},${newGot}/${newNeed}`;
    i = j - 1;
  }
  if (files === 0) return "patch_file_header_missing";
  if (hunks === 0) return "patch_hunk_missing";
  return null;
}

/** 回执解析：支持 `key: value`、Markdown 列表 `- key: value` 和 `| key | value |` 表格。 */
function parseReceiptFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const aliases: Record<string, string> = {
    base_sha: "base", commit_sha: "commit", merged_sha: "commit",
    logs_path: "logs", test: "tests", test_result: "tests", clippy_result: "clippy",
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^#[#\s]/.test(line)) continue;
    let key = "";
    let val = "";
    const kv = line.match(/^(?:[-*]\s*)?([A-Za-z][A-Za-z0-9_-]*)\s*[:=：]\s*(.+)$/);
    if (kv) { key = kv[1]; val = kv[2]; }
    else {
      const row = line.match(/^\|\s*([A-Za-z][A-Za-z0-9_-]*)\s*\|\s*(.+?)\s*\|/);
      if (row) { key = row[1]; val = row[2]; }
    }
    if (!key) continue;
    key = aliases[key.toLowerCase()] ?? key.toLowerCase().replace(/-/g, "_");
    val = val.replace(/`/g, "").trim();
    if (val && (!fields[key] || fields[key].length < val.length)) fields[key] = val;
  }
  return fields;
}

/** 回执必填字段：base/branch/commit/box/fmt/clippy/tests/logs。 */
function validateReceiptText(text: string, baseSha: string): string[] {
  const fields = parseReceiptFields(text);
  const required = ["base", "branch", "commit", "box", "fmt", "clippy", "tests", "logs"];
  const issues: string[] = [];
  for (const key of required) if (!fields[key]) issues.push(`receipt_field_missing:${key}`);
  if (fields.commit && !/^[a-f0-9]{7,64}$/i.test(fields.commit)) issues.push("receipt_commit_invalid");
  if (fields.base && !/^[a-f0-9]{7,64}$/i.test(fields.base)) issues.push("receipt_base_invalid");
  if (fields.base && /^[a-f0-9]{7,64}$/i.test(fields.base)) {
    const rb = String(fields.base).toLowerCase();
    const sb = String(baseSha).toLowerCase();
    if (!(rb.startsWith(sb) || sb.startsWith(rb))) issues.push("receipt_base_mismatch");
  }
  return issues;
}

/** S2：base 提交在远端仓库是否存在。配置 GITHUB_REPO 时启用；限流/网络不明时不误杀交付。 */
async function baseCommitExists(env: Env, sha: string): Promise<boolean | null> {
  const repo = String(env.GITHUB_REPO ?? "").trim();
  if (!repo || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) return null;
  const key = `basecheck:${repo}:${String(sha).toLowerCase()}`;
  try {
    const cached = await env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = ?")
      .bind(key).first<any>();
    if (cached && Date.now() - Number(cached.updated_at ?? 0) < 7 * 24 * 3600_000)
      return String(cached.value) === "1" ? true : String(cached.value) === "0" ? false : null;
  } catch { /* settings 未迁移时继续走远端 */ }
  try {
    // 无 token 时走 GitHub 提交页 HEAD：避免 API 60 次/小时的匿名限流；
    // 有 token 时走 API，能区分 403/429（不明时不误杀）。
    const url = env.GITHUB_TOKEN
      ? `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(sha)}`
      : `https://github.com/${repo}/commit/${encodeURIComponent(sha)}`;
    const res = await fetch(url, {
      method: env.GITHUB_TOKEN ? "GET" : "HEAD",
      headers: {
        accept: env.GITHUB_TOKEN ? "application/vnd.github+json" : "text/html",
        "user-agent": "synapse-agent-hub",
        ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (res.status !== 200 && res.status !== 404) return null;
    const ok = res.status === 200;
    try {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, ok ? "1" : "0", Date.now()).run();
    } catch { /* 缓存失败不影响本次判定 */ }
    return ok;
  } catch {
    return null;
  }
}

/** S2：读补丁/回执正文做交付门；不合格直接 422，不先收下再由管理侧拒。 */
async function deliveryFormatContentMissing(
  env: Env, project: string, kindRaw: unknown, refs: NormalizedRef[], baseSha: string
): Promise<string[]> {
  const kind = String(kindRaw ?? "patch").trim().toLowerCase();
  if (kind !== "patch" && kind !== "bundle") return [];
  const pick = (re: RegExp, fallback?: (n: string) => boolean) =>
    refs.find((r) => re.test(refBaseName(r)) || (fallback ? fallback(refBaseName(r)) : false));
  const patchRef = pick(/\.(patch|diff)$/i, (n) => /patch|diff/.test(n));
  const receiptRef = pick(/(^|[-_.])(receipt|回执)([-_.]|$)/i,
                          (n) => n.startsWith("receipt") || n.startsWith("回执"));
  const issues: string[] = [];
  const read = async (ref: NormalizedRef, label: string): Promise<string | null> => {
    try {
      const obj = await env.BLOBS.get(`p/${project}/artifacts/${ref.sha256}`);
      if (!obj) { issues.push(`${label}_blob_missing`); return null; }
      if (Number(obj.size ?? 0) > PATCH_MAX_BYTES) { issues.push("patch_too_large"); return null; }
      return await obj.text();
    } catch {
      issues.push(`${label}_read_failed`);
      return null;
    }
  };
  if (!patchRef) issues.push("patch_file");
  if (!receiptRef) issues.push("receipt_file");
  const patchText = patchRef ? await read(patchRef, "patch") : null;
  if (patchText) {
    const bad = validatePatchText(patchText);
    if (bad) issues.push(bad);
    const exists = await baseCommitExists(env, baseSha);
    if (exists === false) issues.push("base_sha_not_remote");
  }
  const receiptText = receiptRef ? await read(receiptRef, "receipt") : null;
  if (receiptText) issues.push(...validateReceiptText(receiptText, baseSha));
  return [...new Set(issues)];
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
    patch_content_invalid: "合法 unified diff：文件头、@@ hunk 头、hunk 行数完整",
    patch_header_missing: "补丁需含 diff --git 或 ---/+++ 文件头",
    patch_file_header_missing: "补丁需至少一个文件头",
    patch_hunk_missing: "补丁需至少一个 @@ hunk",
    patch_hunk_mismatch: "@@ 声明的旧/新行数必须与实际的 -/+/空格行数一致",
    patch_too_large: "补丁不超过 8MB",
    patch_blob_missing: "补丁 blob 在 R2 中可读",
    patch_read_failed: "补丁 blob 可读取",
    receipt_blob_missing: "回执 blob 在 R2 中可读",
    receipt_read_failed: "回执 blob 可读取",
    receipt_commit_invalid: "receipt.commit 需为 7–64 位十六进制",
    receipt_base_invalid: "receipt.base 需为 7–64 位十六进制",
    receipt_base_mismatch: "receipt.base 必须与提交的 base_sha 一致",
    base_sha_not_remote: "base_sha 必须存在于配置的远端仓库（可通过 GITHUB_REPO 配置）",
  };
  const codeOf = (m: string) => m.split(":")[0];
  return json({ error: "delivery_format_incomplete", kind,
                missing, required: missing.map((m) => expected[codeOf(m)] ?? m),
                hint: "代码类交付必须含可解析补丁、完整回执（base/branch/commit/box/fmt/clippy/tests/logs）与结构化自测计数；不合格直接拒收，请按 required 修正后重新提交。" }, 422);
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
                                      reassigned: true, work_item: true, reason },
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

/** 交付状态变化单独发一条 submission 事件：客户端只订阅事件流即可知道
 *  管理侧已收走/已批准/已驳回，不必再轮询 submissions。best-effort，不阻断管理动作。 */
async function publishSubmissionEvent(env: Env, project: string, row: any,
                                     kind: string, extra: Record<string, unknown> = {}) {
  const agentId = String(row?.agent_id ?? "").trim();
  if (!agentId) return;
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  await stub.fetch(new Request("https://do/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project, sender: "admin", topic: "submission", kind, to: agentId,
      payload: { submission_id: row.submission_id, task_id: row.task_id ?? null,
                 kind: row.kind ?? null, ...extra },
      dedupe_key: `sub-event:${row.submission_id}:${kind}:${Date.now()}`,
    }),
  })).catch((e: any) => console.warn("submission event publish failed", row?.submission_id, e?.message ?? e));
}

/** S7：issue 生命周期事件。任务时间线按 task_id / issue_id 合并，不再只靠 issue.created。 */
async function publishIssueEvent(
  env: Env, project: string, row: any, kind: string, extra: Record<string, unknown> = {}
) {
  const issueId = String(row?.issue_id ?? "").trim();
  if (!issueId) return;
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
  await stub.fetch(new Request("https://do/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project, sender: "admin", topic: "issue", kind,
      payload: {
        issue_id: issueId, title: String(row?.title ?? "").slice(0, 200),
        task_id: row?.task_id ?? null, status: String(row?.status ?? ""),
        reporter: row?.reporter ?? null, priority: row?.priority ?? null,
        ...extra,
      },
      dedupe_key: `issue-event:${issueId}:${kind}:${Date.now()}`,
    }),
  })).catch((e: any) => console.warn("issue event publish failed", issueId, e?.message ?? e));
}

async function createSubmission(req: Request, env: Env, project: string, agentId: string, isAdmin = false) {
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
  const contentMissing = await deliveryFormatContentMissing(env, project, kind, norm.refs, String(b.base_sha));
  if (contentMissing.length) return deliveryFormatError(kind, contentMissing);
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
                                      kind, base_sha: b.base_sha, title: b.title ?? "",
                                      agent_id: agentId, refs: norm.refs },
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
  opts: { to: string | null; sender: string; taskId?: string; title?: string; body?: string;
          enforceAgentLimit?: boolean },
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
                             project, sender: opts.sender, max_per_min: quota.maxMsgsPerMin,
                             enforce_agent_limit: opts.enforceAgentLimit === true }),
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

/** 把一条 open issue 转成自己的任务：/take 仅 reporter（requireReporter=true），/claim 任意项目 agent。 */
async function takeIssue(req: Request, env: Env, project: string, agentId: string, issueId: string,
                         requireReporter = true) {
  const row = await env.DB.prepare(
    "SELECT issue_id, reporter, status, task_id FROM issues WHERE project = ? AND issue_id = ?"
  ).bind(project, issueId).first<any>();
  if (!row) return err(404, "issue_not_found");
  if (requireReporter && row.reporter !== agentId) return err(403, "not_issue_reporter");
  const b: any = await req.json().catch(() => ({}));
  const out = await dispatchIssueToTask(env, project, issueId, {
    to: agentId, sender: agentId, taskId: String(b.task_id ?? "").trim() || undefined,
    enforceAgentLimit: true,
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

  // 让管理台 WS 立即刷新 Issue tab；这是无收件人的项目广播，普通 agent 不再可见。
  // 消息写入失败不影响已经落库的 issue。
  let seq: number | null = null;
  try {
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("v9:" + project));
    const r = await stub.fetch(new Request("https://do/publish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, sender: agentId, topic: "issue", kind: "issue",
                             payload: { issue_id: issueId, title, priority, status: "open",
                                        reporter: agentId, task_id: selfTask?.task_id ?? null },
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

// ── Agent 能力自描述：/ver 给 hash，/skill 给说明，/capabilities 给机器可读清单 ──
type SkillMeta = { text: string; sha256: string };
let SKILL_META_CACHE: Promise<SkillMeta> | null = null;
function skillMeta(): Promise<SkillMeta> {
  if (!SKILL_META_CACHE) {
    const text = `# Synapse Agent Skill\n\n- SDK: ${SDK_VERSION}\n- Build: ${BUILD_TAG}\n- 生成方式: 服务端构建内嵌，随部署更新\n${AGENT_SKILL_BODY}`;
    SKILL_META_CACHE = sha256(text).then((sha256) => ({ text, sha256 }));
  }
  return SKILL_META_CACHE;
}
async function capabilityManifest() {
  const capabilities = AGENT_CAPABILITIES;
  const capsSha = await sha256(JSON.stringify(capabilities));
  return { capabilities, sha256: capsSha };
}
async function versionPayload() {
  const meta = await skillMeta();
  const caps = await capabilityManifest();
  return {
    build: BUILD_TAG,
    sdk: SDK_VERSION,
    tabs: true,
    skill_url: "/skill",
    skill_sha256: meta.sha256,
    capabilities_url: "/capabilities",
    capabilities_sha256: caps.sha256,
    capabilities: caps.capabilities.map((c) => c.id),
  };
}
async function capabilitiesResponse() {
  const meta = await skillMeta();
  const caps = await capabilityManifest();
  return json({
    manifest_version: 1,
    sdk: SDK_VERSION,
    build: BUILD_TAG,
    skill_url: "/skill",
    skill_sha256: meta.sha256,
    capabilities_sha256: caps.sha256,
    capabilities: caps.capabilities,
  });
}
async function skillResponse(req: Request) {
  if (req.method !== "GET" && req.method !== "HEAD") return err(405, "method_not_allowed");
  const meta = await skillMeta();
  const etag = `"${meta.sha256}"`;
  const headers = {
    ...SEC_HEADERS,
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "public, max-age=60, must-revalidate",
    "etag": etag,
    "x-skill-sha256": meta.sha256,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : meta.text, { headers });
}
/** 统一响应序列化：不输出异常堆栈字段（错误响应只留稳定的 error code）。 */
function jsonBody(value: unknown): string {
  return JSON.stringify(value, (key, val) =>
    key === "stack" || key === "stackTrace" ? undefined : val);
}
const json = (o: unknown, status = 200) =>
  new Response(jsonBody(o), { status, headers: { "content-type": "application/json", "x-hub": "1" } });
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

/** 管理台趋势只开放三个稳定窗口，避免任意 days 参数把 D1 扫描放大。 */
function analyticsDays(raw: string | null | undefined, fallback = 7): number {
  const n = Number(raw);
  return [7, 30, 90].includes(n) ? n : fallback;
}
/** 以 UTC 日期为桶；管理台全站都按 UTC 日期展示，避免客户端时区改变历史桶。 */
function analyticsDayKeys(days: number): string[] {
  const today = new Date();
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: days }, (_, i) =>
    new Date(base - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}
function analyticsPrevStartDay(dayKeys: string[], days: number): string {
  const first = Date.parse(dayKeys[0] + "T00:00:00Z");
  return new Date(first - days * 86_400_000).toISOString().slice(0, 10);
}
function activityRowsOf(res: any): any[] {
  return Array.isArray(res?.results) ? res.results : [];
}
function activityCountMap(rows: any[]): Map<string, number> {
  return new Map(rows.map((r) => [String(r.day), Number(r.n ?? 0)]));
}
function activityPrevious(rows: any[], sinceDay: string): number {
  return rows.reduce((a, r) => a + (String(r.day) < sinceDay ? Number(r.n ?? 0) : 0), 0);
}

/** 单个 agent 的日粒度活动：消息按 sender、交付按 agent_id、Issue 按 reporter。 */
async function loadAgentActivity(env: Env, project: string, agentId: string, days: number): Promise<any> {
  const dayKeys = analyticsDayKeys(days);
  const sinceDay = dayKeys[0];
  const prevStartDay = analyticsPrevStartDay(dayKeys, days);
  const prevStartMs = Date.parse(prevStartDay + "T00:00:00Z");
  let msg: any = null, sub: any = null, iss: any = null;
  try {
    [msg, sub, iss] = await Promise.all([
      env.DB.prepare(
        `SELECT substr(ts,1,10) AS day, COUNT(*) AS n FROM archive
          WHERE project = ? AND sender = ? AND ts >= ? GROUP BY day`
      ).bind(project, agentId, prevStartDay).all<any>(),
      env.DB.prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM submissions
          WHERE project = ? AND agent_id = ? AND created_at >= ? GROUP BY day`
      ).bind(project, agentId, prevStartMs).all<any>(),
      env.DB.prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM issues
          WHERE project = ? AND reporter = ? AND created_at >= ? GROUP BY day`
      ).bind(project, agentId, prevStartMs).all<any>(),
    ]);
  } catch { /* D1 抖动时返回不可用，不把 0 伪装成真实趋势 */ }
  const zeroDaily = dayKeys.map((day) => ({ day, messages: 0, submissions: 0, issues: 0 }));
  if (!msg || !sub || !iss) {
    return { days, available: false, daily: zeroDaily, totals: null, previous: null,
             range: { from: sinceDay, to: dayKeys[dayKeys.length - 1], previous_from: prevStartDay } };
  }
  const msgMap = activityCountMap(activityRowsOf(msg));
  const subMap = activityCountMap(activityRowsOf(sub));
  const issMap = activityCountMap(activityRowsOf(iss));
  const daily = dayKeys.map((day) => ({
    day, messages: msgMap.get(day) ?? 0, submissions: subMap.get(day) ?? 0,
    issues: issMap.get(day) ?? 0,
  }));
  const totals = daily.reduce((a, b) => ({
    messages: a.messages + b.messages, submissions: a.submissions + b.submissions,
    issues: a.issues + b.issues,
  }), { messages: 0, submissions: 0, issues: 0 });
  const previous = {
    messages: activityPrevious(activityRowsOf(msg), sinceDay),
    submissions: activityPrevious(activityRowsOf(sub), sinceDay),
    issues: activityPrevious(activityRowsOf(iss), sinceDay),
  };
  return {
    days, available: true, daily, totals, previous,
    range: { from: sinceDay, to: dayKeys[dayKeys.length - 1], previous_from: prevStartDay },
    definition: { messages: "sender=该 agent 的归档消息", submissions: "agent_id=该 agent 的交付", issues: "reporter=该 agent 的 Issue" },
  };
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

