/**
 * 运行环境自检（与 Python/Rust 同构）：判断宿主类型与本地/云机，给出默认传输与节流。
 * 默认最优 = 长连接 + 异步队列；条件不满足逐级回退到轮询。
 */
import { existsSync, readFileSync } from "node:fs";

const has = (...needles: string[]) => {
  const keys = Object.keys(process.env).join(" ").toUpperCase();
  return needles.some((n) => keys.includes(n.toUpperCase()));
};

const inContainer = () => {
  if (existsSync("/.dockerenv")) return true;
  try {
    return /docker|kubepods|containerd/.test(readFileSync("/proc/1/cgroup", "utf8"));
  } catch { return false; }
};

export interface Profile {
  runtime: "doubao" | "workerbody" | "ci" | "generic";
  host: "cloud" | "local";
  wsBlocked: boolean;
  transport: "ws" | "poll";
  heartbeatS: number; pollMs: number; probeMs: number; queueMax: number;
  reason: string;
}

export function detectProfile(agentId = ""): Profile {
  let runtime: Profile["runtime"] = "generic";
  if (has("DOUBAO") || agentId.startsWith("doubao")) runtime = "doubao";
  else if (has("WORKERBODY", "WORKER_BODY")) runtime = "workerbody";
  else if (has("GITHUB_ACTIONS") || process.env.CI) runtime = "ci";

  const forced = process.env.YANSHI_HOST;
  const host: Profile["host"] =
    forced === "cloud" || forced === "local" ? forced
    : (inContainer() || has("KUBERNETES", "CF_", "AWS_", "ALIYUN", "TENCENT", "VERCEL", "GOOGLE_CLOUD")) ? "cloud" : "local";

  const wsBlocked = process.env.YANSHI_NO_WS === "1";

  let transport: Profile["transport"] = "ws";
  let heartbeatS = 60, pollMs = 5000, probeMs = 4000, queueMax = 200;
  if (wsBlocked || runtime === "ci") { transport = "poll"; heartbeatS = 120; pollMs = 10000; probeMs = 0; queueMax = 50; }
  else if (runtime === "doubao") { heartbeatS = 30; pollMs = host === "local" ? 4000 : 3000; }
  else if (runtime === "workerbody") { heartbeatS = 60; pollMs = 5000; queueMax = 500; }
  else if (host === "cloud") { heartbeatS = 45; pollMs = 4000; queueMax = 300; }

  return {
    runtime, host, wsBlocked, transport, heartbeatS, pollMs, probeMs, queueMax,
    reason: wsBlocked ? "YANSHI_NO_WS=1：强制轮询" : `${runtime}/${host}：长连优先，失败回退轮询`,
  };
}
