import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import express from "express";
import httpProxy from "http-proxy";
import {
  canServeGatewayRequest,
  describeGatewayHealth,
} from "./gateway-readiness.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

const JARVIS_BUILDER_URL =
  process.env.JARVIS_BUILDER_URL?.trim()?.replace(/\/+$/, "");

const LOG_FILE = path.join(STATE_DIR, "server.log");
const LOG_RING_BUFFER_MAX = 1000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;

const logRingBuffer = [];
const sseClients = new Set();

function writeLog(level, category, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${category}] ${message}`;

  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;

  consoleFn(line);

  logRingBuffer.push(line);

  if (logRingBuffer.length > LOG_RING_BUFFER_MAX) {
    logRingBuffer.shift();
  }

  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), {
      recursive: true,
    });

    fs.appendFileSync(LOG_FILE, line + "\n");

    const stat = fs.statSync(LOG_FILE);

    if (stat.size > MAX_LOG_FILE_SIZE) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n");

      fs.writeFileSync(
        LOG_FILE,
        lines.slice(Math.floor(lines.length / 2)).join("\n"),
      );
    }
  } catch {}
}

const log = {
  info: (category, message) =>
    writeLog("INFO", category, message),

  warn: (category, message) =>
    writeLog("WARN", category, message),

  error: (category, message) =>
    writeLog("ERROR", category, message),
};

async function jarvisBuilderRequest(endpoint, options = {}) {
  if (!JARVIS_BUILDER_URL) {
    const error = new Error(
      "JARVIS_BUILDER_URL is not configured",
    );

    error.status = 503;
    throw error;
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    120_000,
  );

  try {
    const response = await fetch(
      `${JARVIS_BUILDER_URL}${endpoint}`,
      {
        ...options,

        signal: controller.signal,

        headers: {
          Accept: "application/json",

          ...(options.body
            ? {
                "Content-Type": "application/json",
              }
            : {}),

          ...(options.headers || {}),
        },
      },
    );

    const text = await response.text();

    let body = null;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {
          raw: text,
        };
      }
    }

    if (!response.ok) {
      const error = new Error(
        body?.error ||
          body?.detail ||
          `Jarvis Builder returned HTTP ${response.status}`,
      );

      error.status = response.status;
      error.builderBody = body;

      throw error;
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveGatewayToken() {
  const envTok =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim();

  if (envTok) {
    return envTok;
  }

  const tokenPath =
    path.join(
      STATE_DIR,
      "gateway.token",
    );

  try {
    const existing =
      fs.readFileSync(
        tokenPath,
        "utf8",
      ).trim();

    if (existing) {
      return existing;
    }
  } catch (err) {
    log.warn(
      "gateway-token",
      `could not read existing token: ${err.code || err.message}`,
    );
  }

  const generated =
    crypto.randomBytes(32).toString("hex");

  try {
    fs.mkdirSync(
      STATE_DIR,
      {
        recursive: true,
      },
    );

    fs.writeFileSync(
      tokenPath,
      generated,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  } catch (err) {
    log.warn(
      "gateway-token",
      `could not persist token: ${err.code || err.message}`,
    );
  }

  return generated;
}

const OPENCLAW_GATEWAY_TOKEN =
  resolveGatewayToken();

process.env.OPENCLAW_GATEWAY_TOKEN =
  OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const version =
      await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "--version",
        ]),
      );

    cachedOpenclawVersion =
      version.output.trim();
  }

  return {
    version:
      cachedOpenclawVersion,
  };
}

const INTERNAL_GATEWAY_PORT =
  Number.parseInt(
    process.env.INTERNAL_GATEWAY_PORT ??
      "18789",
    10,
  );

const INTERNAL_GATEWAY_HOST =
  process.env.INTERNAL_GATEWAY_HOST ??
  "127.0.0.1";

const GATEWAY_TARGET =
  `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() ||
  "/openclaw/dist/entry.js";

const OPENCLAW_NODE =
  process.env.OPENCLAW_NODE?.trim() ||
  "node";

function clawArgs(args) {
  return [
    OPENCLAW_ENTRY,
    ...args,
  ];
}

function stripAnsi(value) {
  return String(value)
    .replace(
      /\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\/g,
      "",
    )
    .replace(
      /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g,
      "",
    );
}

let deviceBootstrapSdkPromise =
  null;

function resolveDeviceBootstrapSdkPath() {
  const entryPath =
    path.resolve(
      OPENCLAW_ENTRY,
    );

  try {
    const requireFromOpenclaw =
      createRequire(entryPath);

    return requireFromOpenclaw.resolve(
      "openclaw/plugin-sdk/device-bootstrap",
    );
  } catch {
    const openclawRoot =
      path.dirname(
        path.dirname(
          entryPath,
        ),
      );

    return path.join(
      openclawRoot,
      "dist",
      "plugin-sdk",
      "device-bootstrap.js",
    );
  }
}

async function loadDeviceBootstrapSdk() {
  if (!deviceBootstrapSdkPromise) {
    deviceBootstrapSdkPromise =
      import(
        pathToFileURL(
          resolveDeviceBootstrapSdkPath(),
        ).href
      ).catch((err) => {
        deviceBootstrapSdkPromise =
          null;

        throw err;
      });
  }

  return deviceBootstrapSdkPromise;
}

async function probeDeviceBootstrapSdk() {
  try {
    await loadDeviceBootstrapSdk();

    log.info(
      "devices",
      `device bootstrap SDK ready: ${resolveDeviceBootstrapSdkPath()}`,
    );
  } catch (err) {
    log.warn(
      "devices",
      `device bootstrap SDK unavailable at startup (${resolveDeviceBootstrapSdkPath()}): ${err?.message || String(err)}`,
    );
  }
}

function devicePairingTimestamp(request) {
  const ts =
    request?.ts;

  if (
    typeof ts ===
    "number"
  ) {
    return ts;
  }

  if (
    typeof ts ===
    "string"
  ) {
    const parsed =
      Date.parse(ts);

    return Number.isNaN(parsed)
      ? 0
      : parsed;
  }

  return 0;
}

function newestPendingDevicePairing(
  pending,
) {
  if (
    !Array.isArray(pending) ||
    pending.length === 0
  ) {
    return null;
  }

  return pending.reduce(
    (latest, current) =>
      devicePairingTimestamp(current) >
      devicePairingTimestamp(latest)
        ? current
        : latest,
  );
}

function describeDeviceApprovalForbidden(
  result,
) {
  const scope =
    result?.scope ||
    "unknown";

  const role =
    result?.role ||
    "unknown";

  switch (
    result?.reason
  ) {
    case "caller-scopes-required":
      return `missing scope: ${scope}`;

    case "caller-missing-scope":
      return `missing scope: ${scope}`;

    case "scope-outside-requested-roles":
      return `invalid scope for requested roles: ${scope}`;

    case "bootstrap-role-not-allowed":
      return `bootstrap profile does not allow role: ${role}`;

    case "bootstrap-scope-not-allowed":
      return `bootstrap profile does not allow scope: ${scope}`;

    default:
      return "Device approval is forbidden by bootstrap policy.";
  }
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(
      STATE_DIR,
      "openclaw.json",
    )
  );
}

function isConfigured() {
  try {
    return fs.existsSync(
      configPath(),
    );
  } catch {
    return false;
  }
}

async function syncAllowedOrigins() {
  const publicDomain =
    process.env.RAILWAY_PUBLIC_DOMAIN;

  if (!publicDomain) {
    return;
  }

  const origin =
    `https://${publicDomain}`;

  const current =
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "get",
        "gateway.controlUi.allowedOrigins",
      ]),
    );

  if (
    current.code === 0 &&
    current.output.includes(origin)
  ) {
    return;
  }

  const result =
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.controlUi.allowedOrigins",
        JSON.stringify([
          origin,
        ]),
      ]),
    );

  if (
    result.code === 0
  ) {
    log.info(
      "gateway",
      `set allowedOrigins to [${origin}]`,
    );
  } else {
    log.warn(
      "gateway",
      `failed to set allowedOrigins (exit=${result.code})`,
    );
  }
}

let gatewayProc =
  null;

let gatewayStarting =
  null;

let shuttingDown =
  false;

let gatewayRestartCount =
  0;

let gatewayLastStartTime =
  0;

let intentionalRestart =
  false;

function sleep(ms) {
  return new Promise(
    (r) =>
      setTimeout(
        r,
        ms,
      ),
  );
}

async function probeGatewayOnce(
  opts = {},
) {
  const endpoints = [
    "/openclaw",
    "/",
    "/health",
  ];

  const timeoutMs =
    opts.timeoutMs ??
    2000;

  for (
    const endpoint of endpoints
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        timeoutMs,
      );

    try {
      const res =
        await fetch(
          `${GATEWAY_TARGET}${endpoint}`,
          {
            method: "GET",
            signal:
              controller.signal,
          },
        );

      if (
        res.status < 500
      ) {
        return {
          ok: true,
          endpoint,
        };
      }
    } catch (err) {
      if (
        err.name !==
          "AbortError" &&
        err.code !==
          "ECONNREFUSED" &&
        err.cause?.code !==
          "ECONNREFUSED"
      ) {
        const msg =
          err.code ||
          err.message;

        if (
          msg !==
            "fetch failed" &&
          msg !==
            "UND_ERR_CONNECT_TIMEOUT"
        ) {
          log.warn(
            "gateway",
            `health check error: ${msg}`,
          );
        }
      }
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  return {
    ok: false,
    endpoint: null,
  };
}

async function waitForGatewayReady(
  opts = {},
) {
  const timeoutMs =
    opts.timeoutMs ??
    60_000;

  const start =
    Date.now();

  while (
    Date.now() -
      start <
    timeoutMs
  ) {
    const probe =
      await probeGatewayOnce();

    if (probe.ok) {
      log.info(
        "gateway",
        `ready at ${probe.endpoint}`,
      );

      return true;
    }

    await sleep(250);
  }

  log.error(
    "gateway",
    `failed to become ready after ${timeoutMs / 1000} seconds`,
  );

  return false;
}

async function startGateway() {
  if (gatewayProc) {
    return;
  }

  if (!isConfigured()) {
    throw new Error(
      "Gateway cannot start: not configured",
    );
  }

  fs.mkdirSync(
    STATE_DIR,
    {
      recursive: true,
    },
  );

  fs.mkdirSync(
    WORKSPACE_DIR,
    {
      recursive: true,
    },
  );

  const stopResult =
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "gateway",
        "stop",
      ]),
    );

  log.info(
    "gateway",
    `stop existing gateway exit=${stopResult.code}`,
  );

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(
      INTERNAL_GATEWAY_PORT,
    ),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayLastStartTime =
    Date.now();

  gatewayProc =
    childProcess.spawn(
      OPENCLAW_NODE,
      clawArgs(args),
      {
        stdio: "inherit",

        env: {
          ...process.env,

          OPENCLAW_STATE_DIR:
            STATE_DIR,

          OPENCLAW_WORKSPACE_DIR:
            WORKSPACE_DIR,
        },
      },
    );

  const safeArgs =
    args.map(
      (arg, i) =>
        args[i - 1] ===
        "--token"
          ? "[REDACTED]"
          : arg,
    );

  log.info(
    "gateway",
    `starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`,
  );

  log.info(
    "gateway",
    `STATE_DIR: ${STATE_DIR}`,
  );

  log.info(
    "gateway",
    `WORKSPACE_DIR: ${WORKSPACE_DIR}`,
  );

  log.info(
    "gateway",
    `config path: ${configPath()}`,
  );

  gatewayProc.on(
    "error",
    (err) => {
      log.error(
        "gateway",
        `spawn error: ${String(err)}`,
      );

      gatewayProc =
        null;
    },
  );

  gatewayProc.on(
    "exit",
    (
      code,
      signal,
    ) => {
      log.error(
        "gateway",
        `exited code=${code} signal=${signal}`,
      );

      const uptime =
        Date.now() -
        gatewayLastStartTime;

      gatewayProc =
        null;

      if (
        !shuttingDown &&
        !intentionalRestart &&
        isConfigured()
      ) {
        if (
          uptime >
          30_000
        ) {
          gatewayRestartCount =
            0;
        } else {
          gatewayRestartCount++;
        }

        const delay =
          Math.min(
            2000 *
              Math.pow(
                2,
                gatewayRestartCount,
              ),
            60_000,
          );

        log.info(
          "gateway",
          `scheduling auto-restart in ${delay / 1000}s`,
        );

        setTimeout(
          async () => {
            if (
              shuttingDown ||
              gatewayProc ||
              !isConfigured()
            ) {
              return;
            }

            const probe =
              await probeGatewayOnce();

            if (probe.ok) {
              gatewayRestartCount =
                0;

              return;
            }

            ensureGatewayRunning().catch(
              (err) => {
                log.error(
                  "gateway",
                  `auto-restart failed: ${err.message}`,
                );
              },
            );
          },
          delay,
        );
      }
    },
  );
}

async function ensureGatewayRunning() {
  if (!isConfigured()) {
    return {
      ok: false,
      reason:
        "not configured",
    };
  }

  if (gatewayProc) {
    return {
      ok: true,
    };
  }

  const probe =
    await probeGatewayOnce();

  if (probe.ok) {
    return {
      ok: true,
      reason:
        "reachable",
    };
  }

  if (!gatewayStarting) {
    gatewayStarting =
      (async () => {
        await syncAllowedOrigins();

        await startGateway();

        const ready =
          await waitForGatewayReady({
            timeoutMs:
              60_000,
          });

        if (!ready) {
          throw new Error(
            "Gateway did not become ready in time",
          );
        }
      })().finally(() => {
        gatewayStarting =
          null;
      });
  }

  await gatewayStarting;

  return {
    ok: true,
  };
}

function isGatewayStarting() {
  return (
    gatewayStarting !== null
  );
}

function isGatewayReady() {
  return (
    gatewayProc !== null &&
    gatewayStarting === null
  );
}

async function restartGateway() {
  if (gatewayProc) {
    intentionalRestart =
      true;

    try {
      gatewayProc.kill(
        "SIGTERM",
      );
    } catch (err) {
      log.warn(
        "gateway",
        `kill error: ${err.message}`,
      );
    }

    await sleep(750);

    gatewayProc =
      null;

    intentionalRestart =
      false;
  }

  await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "gateway",
      "stop",
    ]),
  );

  gatewayRestartCount =
    0;

  return ensureGatewayRunning();
}

const setupRateLimiter = {
  attempts:
    new Map(),

  windowMs:
    60_000,

  maxAttempts:
    50,

  cleanupInterval:
    setInterval(
      function () {
        const now =
          Date.now();

        for (
          const [
            ip,
            data,
          ] of setupRateLimiter.attempts
        ) {
          if (
            now -
              data.windowStart >
            setupRateLimiter.windowMs
          ) {
            setupRateLimiter.attempts.delete(
              ip,
            );
          }
        }
      },
      60_000,
    ),

  isRateLimited(ip) {
    const now =
      Date.now();

    const data =
      this.attempts.get(
        ip,
      );

    if (
      !data ||
      now -
        data.windowStart >
        this.windowMs
    ) {
      this.attempts.set(
        ip,
        {
          windowStart:
            now,

          count:
            1,
        },
      );

      return false;
    }

    data.count++;

    return (
      data.count >
      this.maxAttempts
    );
  },
};

function requireSetupAuth(
  req,
  res,
  next,
) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type(
        "text/plain",
      )
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown";

  if (
    setupRateLimiter.isRateLimited(
      ip,
    )
  ) {
    return res
      .status(429)
      .type(
        "text/plain",
      )
      .send(
        "Too many requests. Try again later.",
      );
  }

  const header =
    req.headers.authorization ||
    "";

  const [
    scheme,
    encoded,
  ] =
    header.split(" ");

  if (
    scheme !== "Basic" ||
    !encoded
  ) {
    res.set(
      "WWW-Authenticate",
      'Basic realm="OpenClaw Setup"',
    );

    return res
      .status(401)
      .send(
        "Auth required",
      );
  }

  const decoded =
    Buffer.from(
      encoded,
      "base64",
    ).toString(
      "utf8",
    );

  const idx =
    decoded.indexOf(
      ":",
    );

  const password =
    idx >= 0
      ? decoded.slice(
          idx + 1,
        )
      : "";

  const passwordHash =
    crypto
      .createHash(
        "sha256",
      )
      .update(password)
      .digest();

  const expectedHash =
    crypto
      .createHash(
        "sha256",
      )
      .update(
        SETUP_PASSWORD,
      )
      .digest();

  const isValid =
    crypto.timingSafeEqual(
      passwordHash,
      expectedHash,
    );

  if (!isValid) {
    res.set(
      "WWW-Authenticate",
      'Basic realm="OpenClaw Setup"',
    );

    return res
      .status(401)
      .send(
        "Invalid password",
      );
  }

  return next();
}

const app =
  express();

app.disable(
  "x-powered-by",
);

app.use(
  express.json({
    limit:
      "1mb",
  }),
);

app.get(
  "/styles.css",
  (_req, res) => {
    res.sendFile(
      path.join(
        process.cwd(),
        "src",
        "public",
        "styles.css",
      ),
    );
  },
);

app.get(
  "/healthz",
  async (_req, res) => {
    const configured =
      isConfigured();

    const health =
      describeGatewayHealth({
        configured,

        hasProcessHandle:
          isGatewayReady(),

        starting:
          isGatewayStarting(),

        reachable:
          configured
            ? (
                await probeGatewayOnce()
              ).ok
            : false,
      });

    res.json({
      ok: true,

      gateway:
        health.gateway,

      jarvisBuilderConfigured:
        Boolean(
          JARVIS_BUILDER_URL,
        ),
    });
  },
);

app.get(
  "/setup/healthz",
  async (_req, res) => {
    const configured =
      isConfigured();

    const health =
      describeGatewayHealth({
        configured,

        hasProcessHandle:
          isGatewayReady(),

        starting:
          isGatewayStarting(),

        reachable:
          configured
            ? (
                await probeGatewayOnce()
              ).ok
            : false,
      });

    res
      .status(
        health.statusCode,
      )
      .json({
        ok: true,
        wrapper: true,
        configured,

        gatewayRunning:
          health.gatewayRunning,

        gatewayStarting:
          health.gatewayStarting,

        gatewayReachable:
          health.gatewayReachable,

        jarvisBuilderConfigured:
          Boolean(
            JARVIS_BUILDER_URL,
          ),
      });
  },
);

// ============================================================
// JARVIS BUILDER BRIDGE
// ============================================================

app.get(
  "/setup/api/builder/health",
  requireSetupAuth,
  async (_req, res) => {
    try {
      const result =
        await jarvisBuilderRequest(
          "/health",
        );

      return res.json({
        ok: true,
        builder:
          result,
      });
    } catch (err) {
      const status =
        Number(
          err?.status,
        ) ||
        502;

      return res
        .status(status)
        .json({
          ok: false,

          error:
            err?.message ||
            String(err),

          builder:
            err?.builderBody ||
            null,
        });
    }
  },
);

app.post(
  "/setup/api/builder/build-tool",
  requireSetupAuth,
  async (req, res) => {
    const toolName =
      String(
        req.body?.toolName ||
          "",
      ).trim();

    const description =
      String(
        req.body?.description ||
          "",
      ).trim();

    const requirements =
      String(
        req.body?.requirements ||
          "",
      ).trim();

    if (
      !toolName ||
      !description
    ) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "toolName and description are required",
        });
    }

    try {
      const result =
        await jarvisBuilderRequest(
          "/build-tool",
          {
            method:
              "POST",

            body:
              JSON.stringify({
                toolName,
                description,
                requirements,
              }),
          },
        );

      log.info(
        "jarvis-builder",
        `proposal created tool=${toolName} toolId=${result?.toolId || "unknown"}`,
      );

      return res
        .status(201)
        .json({
          ok: true,
          builder:
            result,
        });
    } catch (err) {
      const status =
        Number(
          err?.status,
        ) ||
        502;

      log.error(
        "jarvis-builder",
        `build-tool failed: ${err?.message || String(err)}`,
      );

      return res
        .status(status)
        .json({
          ok: false,

          error:
            err?.message ||
            String(err),

          builder:
            err?.builderBody ||
            null,
        });
    }
  },
);

app.get(
  "/setup/api/builder/proposal/:toolId",
  requireSetupAuth,
  async (req, res) => {
    const toolId =
      String(
        req.params.toolId ||
          "",
      ).trim();

    try {
      const result =
        await jarvisBuilderRequest(
          `/proposal/${encodeURIComponent(
            toolId,
          )}`,
        );

      return res.json({
        ok: true,
        builder:
          result,
      });
    } catch (err) {
      const status =
        Number(
          err?.status,
        ) ||
        502;

      return res
        .status(status)
        .json({
          ok: false,

          error:
            err?.message ||
            String(err),

          builder:
            err?.builderBody ||
            null,
        });
    }
  },
);

app.post(
  "/setup/api/builder/run-tests",
  requireSetupAuth,
  async (req, res) => {
    const toolId =
      String(
        req.body?.toolId ||
          "",
      ).trim();

    const testType =
      String(
        req.body?.testType ||
          "all",
      ).trim();

    if (!toolId) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "toolId is required",
        });
    }

    try {
      const result =
        await jarvisBuilderRequest(
          "/run-tests",
          {
            method:
              "POST",

            body:
              JSON.stringify({
                toolId,
                testType,
              }),
          },
        );

      return res.json({
        ok: true,
        builder:
          result,
      });
    } catch (err) {
      const status =
        Number(
          err?.status,
        ) ||
        502;

      return res
        .status(status)
        .json({
          ok: false,

          error:
            err?.message ||
            String(err),

          builder:
            err?.builderBody ||
            null,
        });
    }
  },
);

app.post(
  "/setup/api/builder/publish",
  requireSetupAuth,
  async (req, res) => {
    const toolId =
      String(
        req.body?.toolId ||
          "",
      ).trim();

    const targetBranch =
      String(
        req.body?.targetBranch ||
          "main",
      ).trim();

    const confirm =
      req.body?.confirm ===
      true;

    if (!toolId) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "toolId is required",
        });
    }

    if (!confirm) {
      return res
        .status(409)
        .json({
          ok: false,

          status:
            "human_approval_required",

          error:
            "Publishing requires explicit human confirmation.",

          required: {
            confirm:
              true,
          },
        });
    }

    try {
      const result =
        await jarvisBuilderRequest(
          "/publish",
          {
            method:
              "POST",

            body:
              JSON.stringify({
                toolId,
                targetBranch,
              }),
          },
        );

      log.info(
        "jarvis-builder",
        `publish approved toolId=${toolId} pr=${result?.pullRequestUrl || "unknown"}`,
      );

      return res
        .status(201)
        .json({
          ok: true,
          builder:
            result,
        });
    } catch (err) {
      const status =
        Number(
          err?.status,
        ) ||
        502;

      return res
        .status(status)
        .json({
          ok: false,

          error:
            err?.message ||
            String(err),

          builder:
            err?.builderBody ||
            null,
        });
    }
  },
);

// ============================================================
// SETUP UI
// ============================================================

app.get(
  "/setup",
  requireSetupAuth,
  (_req, res) => {
    res.sendFile(
      path.join(
        process.cwd(),
        "src",
        "public",
        "setup.html",
      ),
    );
  },
);

app.get(
  "/setup/config",
  requireSetupAuth,
  (_req, res) => {
    res.sendFile(
      path.join(
        process.cwd(),
        "src",
        "public",
        "config.html",
      ),
    );
  },
);

// IMPORTANTE:
// A partir de aquí debes conservar el resto de tu server.js original:
// todos los endpoints /setup/api existentes,
// pairing/devices/import/export/doctor,
// logs,
// proxy,
// websocket upgrade,
// server listen,
// shutdown,
// etc.
//
// No borres esa parte.
//
// Si quieres evitar cualquier riesgo de pegar 1800+ líneas a mano,
// dime "parche exacto" y te doy SOLO los bloques que hay que insertar
// en tu server.js actual, con la posición exacta de cada uno.
