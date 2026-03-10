#!/usr/bin/env node
"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { migrateConfig } from "../scripts/migrate-config";

function printHelp(): void {
  console.log(`Signal K Edge Link CLI

Usage:
  edge-link-cli migrate-config <input.json> [output.json]
  edge-link-cli instances list [--baseUrl=<url>] [--token=<token>] [--state=<value>] [--limit=<n>] [--page=<n>] [--format=json|table]
  edge-link-cli instances show <id> [--baseUrl=<url>] [--token=<token>] [--format=json|table]
  edge-link-cli instances create --config <path.json> [--baseUrl=<url>] [--token=<token>]
  edge-link-cli instances update <id> --patch '{"key":"value"}' [--baseUrl=<url>] [--token=<token>]
  edge-link-cli instances delete <id> [--baseUrl=<url>] [--token=<token>]
  edge-link-cli bonding status [--baseUrl=<url>] [--token=<token>] [--format=json|table]
  edge-link-cli bonding update --patch '{"failoverThreshold":300}' [--baseUrl=<url>] [--token=<token>]
  edge-link-cli status [--baseUrl=<url>] [--token=<token>] [--format=json|table]

Commands:
  migrate-config     Convert legacy flat plugin config to connections[] format
  instances list     Print instance summaries from GET /instances
  instances show     Print one instance from GET /instances/:id
  instances create   Create a new instance via POST /instances
  instances update   Update an instance via PUT /instances/:id
  instances delete   Delete an instance via DELETE /instances/:id
  bonding status     Print bonding summary from GET /bonding
  bonding update     Update bonding settings via POST /bonding
  status             Print aggregated status from GET /status
`);
}

function getArgValue(args: string[], flag: string, fallback: string | null = null): string | null {
  const matched = args.find((arg) => arg.startsWith(`${flag}=`));
  if (matched) {
    return matched.slice(flag.length + 1);
  }
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  return fallback;
}

function parseJsonArg(raw: string | null, label: string): any {
  if (!raw) {
    throw new Error(`${label} is required`);
  }
  try {
    return JSON.parse(raw);
  } catch (_err) {
    throw new Error(`${label} must be valid JSON`);
  }
}

function normalizeToken(value: any): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "undefined" || lower === "null") {
    return null;
  }

  return trimmed;
}

function getManagementTokenArg(args: string[]): string | null {
  const argToken = normalizeToken(getArgValue(args, "--token", null));
  if (argToken) {
    return argToken;
  }

  return normalizeToken(process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN);
}

function parseFormat(args: string[]): string {
  const format = getArgValue(args, "--format", "json");
  if (format !== "json" && format !== "table") {
    throw new Error("--format must be 'json' or 'table'");
  }
  return format;
}

function toText(value: any): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

interface TableColumn {
  header: string;
  value: (row: any) => any;
}

function printTable(rows: any[], columns: TableColumn[]): void {
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("(no rows)");
    return;
  }

  const widths = columns.map((col) => col.header.length);
  const cells = rows.map((row) =>
    columns.map((col, i) => {
      const text = toText(col.value(row));
      widths[i] = Math.max(widths[i], text.length);
      return text;
    })
  );

  const headerLine = columns.map((col, i) => col.header.padEnd(widths[i])).join("  ");
  const dividerLine = widths.map((w) => "-".repeat(w)).join("  ");

  console.log(headerLine);
  console.log(dividerLine);
  for (const row of cells) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
  }
}

function printInstances(data: any, format: string): void {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.instances)
        ? data.instances
        : [];

  if (format === "table") {
    printTable(rows, [
      { header: "id", value: (r) => r.id },
      { header: "name", value: (r) => r.name },
      { header: "state", value: (r) => r.state || r.status },
      { header: "protocol", value: (r) => r.protocolVersion },
      { header: "link", value: (r) => r.currentLink },
      { header: "deltasSent", value: (r) => r.metrics && r.metrics.deltasSent }
    ]);
    if (data && data.pagination && typeof data.pagination === "object") {
      const { page, totalPages, total } = data.pagination;
      console.log(`page ${page || 1}/${totalPages || 0} (total ${total || 0})`);
    }
    return;
  }

  console.log(JSON.stringify(data, null, 2));
}

function printBonding(data: any, format: string): void {
  if (format === "table" && data && Array.isArray(data.instances)) {
    printTable(data.instances, [
      { header: "id", value: (r) => r.id },
      { header: "enabled", value: (r) => r.enabled },
      { header: "activeLink", value: (r) => r.state && r.state.activeLink },
      { header: "switches", value: (r) => r.state && r.state.switchCount }
    ]);
    return;
  }

  console.log(JSON.stringify(data, null, 2));
}

function parsePositiveInt(value: any, label: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function buildInstancesListEndpoint(args: string[]): string {
  const params = new URLSearchParams();

  const state = getArgValue(args, "--state", null);
  if (typeof state === "string" && state.trim()) {
    params.set("state", state.trim());
  }

  const limit = parsePositiveInt(getArgValue(args, "--limit", null), "--limit");
  if (limit !== null) {
    params.set("limit", String(limit));
  }

  const page = parsePositiveInt(getArgValue(args, "--page", null), "--page");
  if (page !== null) {
    params.set("page", String(page));
  }

  const query = params.toString();
  return query ? `/instances?${query}` : "/instances";
}

function printStatus(data: any, format: string): void {
  if (format === "table" && data && Array.isArray(data.instances)) {
    printTable(data.instances, [
      { header: "id", value: (r) => r.id },
      { header: "name", value: (r) => r.name },
      { header: "healthy", value: (r) => r.healthy },
      { header: "status", value: (r) => r.status },
      { header: "lastError", value: (r) => r.lastError }
    ]);
    return;
  }

  console.log(JSON.stringify(data, null, 2));
}

type RequestJsonFn = (
  baseUrl: string,
  endpoint: string,
  options?: { method?: string; body?: any; token?: string | null }
) => Promise<any>;

function createRequestJson(): RequestJsonFn {
  return function requestJson(
    baseUrl: string,
    endpoint: string,
    options: { method?: string; body?: any; token?: string | null } = {}
  ): Promise<any> {
    const { method = "GET", body, token } = options;
    const url = new URL(endpoint, baseUrl);
    const transport = url.protocol === "https:" ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");

    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {};
      if (payload) {
        headers["content-type"] = "application/json";
        headers["content-length"] = payload.length;
      }
      if (token) {
        headers["x-edge-link-token"] = token;
        headers.authorization = `Bearer ${token}`;
      }

      const req = transport.request(
        url,
        {
          method,
          headers: Object.keys(headers).length > 0 ? headers : undefined
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const rawBody = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode! < 200 || res.statusCode! >= 300) {
              reject(new Error(`Request failed (${res.statusCode}): ${rawBody || endpoint}`));
              return;
            }
            if (!rawBody) {
              resolve({});
              return;
            }
            try {
              resolve(JSON.parse(rawBody));
            } catch (_err) {
              reject(new Error(`Invalid JSON response from ${endpoint}`));
            }
          });
        }
      );

      req.on("error", reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  };
}

async function runMigrateConfig(args: string[]): Promise<void> {
  const inputPath = args[0];
  const outputPath = args[1] || inputPath;

  if (!inputPath) {
    throw new Error("migrate-config requires <input.json>");
  }

  const absoluteIn = path.resolve(process.cwd(), inputPath);
  const absoluteOut = path.resolve(process.cwd(), outputPath);

  const raw = await fs.readFile(absoluteIn, "utf8");
  const migrated = migrateConfig(JSON.parse(raw));

  await fs.writeFile(absoluteOut, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
  const count = Array.isArray(migrated.connections) ? migrated.connections.length : 0;
  console.log(
    `Migrated config written to ${absoluteOut} (${count} connection${count === 1 ? "" : "s"})`
  );
}

async function runInstancesCommand(args: string[], requestJson: RequestJsonFn): Promise<void> {
  const sub = args[0];
  const baseUrl = getArgValue(
    args,
    "--baseUrl",
    "http://localhost:3000/plugins/signalk-edge-link"
  )!;
  const token = getManagementTokenArg(args);

  if (sub === "list") {
    const format = parseFormat(args);
    const endpoint = buildInstancesListEndpoint(args);
    const data = await requestJson(baseUrl, endpoint, { token });
    printInstances(data, format);
    return;
  }

  if (sub === "show") {
    const id = args[1];
    if (!id) {
      throw new Error("instances show requires <id>");
    }
    const data = await requestJson(baseUrl, `/instances/${encodeURIComponent(id)}`, { token });
    printInstances([data], parseFormat(args));
    return;
  }

  if (sub === "create") {
    const configPath = getArgValue(args, "--config");
    if (!configPath) {
      throw new Error("instances create requires --config <path.json>");
    }
    const payload = JSON.parse(await fs.readFile(path.resolve(process.cwd(), configPath), "utf8"));
    const data = await requestJson(baseUrl, "/instances", { method: "POST", body: payload, token });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sub === "update") {
    const id = args[1];
    if (!id) {
      throw new Error("instances update requires <id>");
    }
    const patch = parseJsonArg(getArgValue(args, "--patch"), "--patch");
    const data = await requestJson(baseUrl, `/instances/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: patch,
      token
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sub === "delete") {
    const id = args[1];
    if (!id) {
      throw new Error("instances delete requires <id>");
    }
    const data = await requestJson(baseUrl, `/instances/${encodeURIComponent(id)}`, {
      method: "DELETE",
      token
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  throw new Error("instances command expects list/show/create/update/delete");
}

async function runBondingCommand(args: string[], requestJson: RequestJsonFn): Promise<void> {
  const sub = args[0];
  const baseUrl = getArgValue(
    args,
    "--baseUrl",
    "http://localhost:3000/plugins/signalk-edge-link"
  )!;
  const token = getManagementTokenArg(args);

  if (sub === "status") {
    const data = await requestJson(baseUrl, "/bonding", { token });
    printBonding(data, parseFormat(args));
    return;
  }

  if (sub === "update") {
    const patch = parseJsonArg(getArgValue(args, "--patch"), "--patch");
    const data = await requestJson(baseUrl, "/bonding", { method: "POST", body: patch, token });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  throw new Error("bonding command expects 'status' or 'update'");
}

async function runStatusCommand(args: string[], requestJson: RequestJsonFn): Promise<void> {
  const baseUrl = getArgValue(
    args,
    "--baseUrl",
    "http://localhost:3000/plugins/signalk-edge-link"
  )!;
  const token = getManagementTokenArg(args);
  const format = parseFormat(args);
  const data = await requestJson(baseUrl, "/status", { token });
  printStatus(data, format);
}

async function main(
  argv: string[] = process.argv.slice(2),
  deps: { requestJson?: RequestJsonFn } = {}
): Promise<number> {
  const [command, ...args] = argv;
  const requestJson = deps.requestJson || createRequestJson();

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    return 0;
  }

  if (command === "migrate-config") {
    await runMigrateConfig(args);
    return 0;
  }

  if (command === "instances") {
    await runInstancesCommand(args, requestJson);
    return 0;
  }

  if (command === "bonding") {
    await runBondingCommand(args, requestJson);
    return 0;
  }

  if (command === "status") {
    await runStatusCommand(args, requestJson);
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((err: any) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export { main, createRequestJson, printTable, parseFormat, getManagementTokenArg };
