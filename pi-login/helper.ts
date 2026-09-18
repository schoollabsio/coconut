#!/usr/bin/env bun
// coconut-login — headless driver for pi's ModelRuntime auth flows.
//
// Speaks line-delimited JSON over stdio. stdout carries ONLY protocol
// lines; diagnostics go to stderr. One process lifetime serves many
// requests; the Go actor spawns it on demand (see internal/core/auth.go).
//
// Required env:
//   COCONUT_AGENT_DIR  — pi agent dir (holds auth.json / models.json),
//                        i.e. the same dir the sidecar gets as
//                        PI_CODING_AGENT_DIR.
//
// Inbound (one JSON per line, stdin):
//   {"type":"login","id":"1","provider":"github-copilot","authType":"oauth"|"api_key"}
//   {"type":"prompt_response","id":"<promptId>","value":"..."}   // value omitted = cancel
//   {"type":"cancel","id":"<loginId>"}
//   {"type":"set_api_key","id":"2","provider":"anthropic","key":"sk-..."}
//   {"type":"logout","id":"3","provider":"github-copilot"}
//   {"type":"status","id":"4"}
//   {"type":"models","id":"5","provider":"github-copilot"}
//
// Outbound (one JSON per line, stdout):
//   {"type":"ready"}
//   {"type":"notify","id":"<loginId>","event":{...}}          // pi AuthEvent
//   {"type":"prompt","id":"<promptId>","loginId":"...","prompt":{...}}
//   {"type":"done","id":"<loginId>","provider":"...","authType":"..."}
//   {"type":"cancelled","id":"<loginId>","message":"..."}
//   {"type":"error","id":"...","message":"..."}
//   {"type":"status_result","id":"...","providers":[...],"credentials":[...]}
//   {"type":"models_result","id":"...","models":[...]}
//   {"type":"ack","id":"..."}                                 // set_api_key / logout

import { spawn } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// pi lazy-loads its OAuth flow modules through a runtime import() that
// bundlers deliberately cannot follow (pi-ai dist/auth/oauth/load.js:
// "variable specifier so bundlers cannot follow the import"). In a
// compiled binary those imports fail unless the flows were registered
// up front — which pi's own dist/bun/cli.js does via bun-oauth. Without
// this call every OAuth login dies with:
//   Cannot find module './github-copilot.js' from '/$bunfs/root/coconut-login'
// (under the bun *interpreter* the dynamic import resolves on disk, so
// this only bites in the compiled helper — exactly what ships).
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
registerBunOAuthFlows();

const agentDir = process.env.COCONUT_AGENT_DIR;
if (!agentDir) {
  console.error("coconut-login: COCONUT_AGENT_DIR is required");
  process.exit(2);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (m: string) => console.error(`[coconut-login] ${m}`);

function openUrl(url: string) {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.on("error", () => {}); // no browser / no opener — fine
    p.unref();
  } catch {
    // best effort only
  }
}

const rt: any = await ModelRuntime.create({
  authPath: `${agentDir}/auth.json`,
  modelsPath: `${agentDir}/models.json`,
  modelsStorePath: `${agentDir}/models-store.json`,
  refreshOnCreate: false,
});
out({ type: "ready" });

// ── in-flight logins & pending prompts ────────────────────────────────
const activeLogins = new Map<string, AbortController>();
const pendingPrompts = new Map<string, {
  loginId: string;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}>();
let promptSeq = 0;

function rejectPromptsFor(loginId: string, err: Error) {
  for (const [pid, pp] of pendingPrompts) {
    if (pp.loginId === loginId) {
      pendingPrompts.delete(pid);
      pp.reject(err);
    }
  }
}

async function handleLogin(id: string, provider: string, authType: string) {
  if (activeLogins.size > 0) {
    out({ type: "error", id, message: "login already in progress" });
    return;
  }
  if (!provider || !authType) {
    out({ type: "error", id, message: "provider and authType are required" });
    return;
  }
  const ac = new AbortController();
  activeLogins.set(id, ac);
  const interaction = {
    signal: ac.signal,
    async prompt(p: any): Promise<string> {
      const pid = `p-${++promptSeq}`;
      const wire: any = { ...p };
      delete wire.signal;
      out({ type: "prompt", id: pid, loginId: id, prompt: wire });
      return new Promise<string>((resolve, reject) => {
        pendingPrompts.set(pid, { loginId: id, resolve, reject });
        ac.signal.addEventListener("abort", () => {
          if (pendingPrompts.has(pid)) {
            pendingPrompts.delete(pid);
            reject(new Error("cancelled"));
          }
        }, { once: true });
      });
    },
    notify(e: any) {
      out({ type: "notify", id, event: e });
      // Best-effort: open the sign-in page in the default browser so
      // device-code / OAuth flows finish like a normal "sign in with…".
      // Never fatal — the UI also renders the link for the user.
      if (e && (e.type === "auth_url" || e.type === "device_code")) {
        const url = e.url || e.verificationUri;
        if (typeof url === "string" && /^https?:\/\//i.test(url)) openUrl(url);
      }
    },
  };
  try {
    const cred = await rt.login(provider, authType, interaction);
    out({
      type: "done", id, provider, authType,
      credential: { type: cred?.type, expires: cred?.expires },
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const cancelled = /cancel|abort/i.test(msg) || ac.signal.aborted;
    out({ type: cancelled ? "cancelled" : "error", id, message: msg });
  } finally {
    activeLogins.delete(id);
    rejectPromptsFor(id, new Error("cancelled"));
  }
}

async function handleStatus(id: string) {
  try {
    // checkAuth is the reliable status source: it resolves stored credentials
    // and ambient sources. (getProviderAuthStatus/isUsingOAuth report
    // configured:false for stored OAuth credentials — verified against
    // pi 0.84.2.)
    const base = rt.getProviders().map((p: any) => ({
      id: p.id,
      name: p.name,
      auth: { apiKey: Boolean(p.auth?.apiKey), oauth: Boolean(p.auth?.oauth) },
    }));
    const providers = await Promise.all(base.map(async (p: any) => {
      let status: any = { configured: false };
      try {
        const check = await rt.checkAuth(p.id);
        if (check) status = { configured: true, ...check };
      } catch { /* provider check failed — leave unconfigured */ }
      return { ...p, status };
    }));
    const credentials = await rt.listCredentials();
    out({ type: "status_result", id, providers, credentials });
  } catch (e: any) {
    out({ type: "error", id, message: String(e?.message ?? e) });
  }
}

async function handleModels(id: string, provider?: string) {
  try {
    const models = (await rt.getAvailable(provider)).map((m: any) => ({
      id: m.id,
      name: m.name,
      provider: m.provider ?? provider,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
    }));
    out({ type: "models_result", id, models });
  } catch (e: any) {
    out({ type: "error", id, message: String(e?.message ?? e) });
  }
}

async function handleSetApiKey(id: string, provider: string, key: string) {
  try {
    if (!provider || typeof key !== "string") {
      throw new Error("provider and key are required");
    }
    await rt.setRuntimeApiKey(provider, key);
    out({ type: "ack", id });
  } catch (e: any) {
    out({ type: "error", id, message: String(e?.message ?? e) });
  }
}

async function handleLogout(id: string, provider: string) {
  try {
    if (!provider) throw new Error("provider is required");
    await rt.logout(provider);
    out({ type: "ack", id });
  } catch (e: any) {
    out({ type: "error", id, message: String(e?.message ?? e) });
  }
}

// ── stdin line loop ────────────────────────────────────────────────────
let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      out({ type: "error", message: "invalid JSON" });
      continue;
    }
    const id = String(req.id ?? "");
    switch (req.type) {
      case "login":
        void handleLogin(id, String(req.provider ?? ""), String(req.authType ?? "oauth"));
        break;
      case "prompt_response": {
        const pp = pendingPrompts.get(String(req.id ?? ""));
        if (!pp) {
          out({ type: "error", id: String(req.id ?? ""), message: "unknown prompt" });
          break;
        }
        pendingPrompts.delete(String(req.id ?? ""));
        if (req.value === undefined) pp.reject(new Error("cancelled"));
        else pp.resolve(String(req.value));
        break;
      }
      case "cancel": {
        const ac = activeLogins.get(String(req.id ?? ""));
        if (ac) ac.abort();
        break;
      }
      case "set_api_key":
        void handleSetApiKey(id, String(req.provider ?? ""), String(req.key ?? ""));
        break;
      case "logout":
        void handleLogout(id, String(req.provider ?? ""));
        break;
      case "status":
        void handleStatus(id);
        break;
      case "models":
        void handleModels(id, req.provider ? String(req.provider) : undefined);
        break;
      default:
        out({ type: "error", id, message: `unknown request type: ${req.type}` });
    }
  }
});
process.stdin.on("end", () => {
  log("stdin closed; exiting");
  process.exit(0);
});
log(`ready (agentDir=${agentDir})`);
