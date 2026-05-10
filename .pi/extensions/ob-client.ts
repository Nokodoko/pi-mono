/**
 * OpenBrain REST API client for pi-mono extensions.
 *
 * Shared transport logic: Unix socket -> SSE local -> SSE remote fallback.
 * Mirrors the Go transport package at openbrain/hooks/go/internal/hooklib/transport/.
 *
 * This module is imported by the individual OB hook extensions, not loaded
 * directly as an extension itself. The default export is a no-op so the
 * extension loader doesn't report an error.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { env } from "node:process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportType = "unix" | "sse" | "sse-remote" | "none";

export type ItemType = "observation" | "session" | "project" | "contact" | "task" | "event";

export type Priority = 1 | 2 | 3 | 4;

export interface EntryEntities {
	tags: string[];
	files_modified?: string[];
	tools_used?: string[];
	tool_count?: number;
	duration?: string;
	project?: string;
	host?: string;
}

export interface WriteRequest {
	item_type: ItemType;
	raw_content: string;
	priority: Priority;
	entities: EntryEntities;
}

export interface ReadEntry {
	id: string;
	item_type: string;
	raw_content: string;
	priority: number;
	entities: EntryEntities;
	captured_at: string;
	created_at: string;
}

export interface ReadResponse {
	entries: ReadEntry[];
	count: number;
	has_more: boolean;
}

export interface ReadParams {
	type?: string;
	q?: string;
	since?: string;
	limit?: number;
}

export interface OBConfig {
	socketPath: string;
	sseLocalURL: string;
	sseRemoteURL: string;
	apiKey: string;
	hostName: string;
	timeout: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
	try {
		const content = readFileSync(path, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx < 0) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			let value = trimmed.slice(eqIdx + 1).trim();
			value = value.replace(/^["']|["']$/g, "");
			if (!env[key]) {
				env[key] = value;
			}
		}
	} catch {
		// File not found or unreadable -- ignore.
	}
}

export function loadConfig(timeoutMs = 500): OBConfig {
	const home = env.HOME || "/tmp";
	loadEnvFile(join(home, ".config", "openbrain", "context.env"));

	const uid = process.getuid?.() ?? 1000;

	const cfg: OBConfig = {
		socketPath: env.OB_SOCKET || `/run/user/${uid}/ob-mcp.sock`,
		sseLocalURL: env.OB_SSE_URL || env.OB_URL || "http://localhost:8200",
		sseRemoteURL: env.OB_REMOTE_URL || "",
		apiKey: env.OB_API_KEY || "",
		hostName: env.OB_HOST_NAME || resolveHostname(),
		timeout: timeoutMs,
	};

	return cfg;
}

function resolveHostname(): string {
	try {
		return hostname().split(".")[0];
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------------------
// Transport Detection
// ---------------------------------------------------------------------------

async function healthCheck(url: string, timeoutMs: number): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const resp = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		return Math.floor(resp.status / 100) === 2;
	} catch {
		return false;
	}
}

/**
 * Detect the best available transport. Returns the transport type and the
 * base URL to use for requests.
 */
export async function detectTransport(
	cfg: OBConfig,
): Promise<{ type: TransportType; baseURL: string }> {
	// Tier 1: Unix socket -- Node's fetch doesn't support unix sockets natively,
	// so we skip to SSE transports. If unix socket support is added later via
	// undici or a custom agent, this tier can be enabled.
	// For now, check if socket exists and probe via SSE local as a proxy.

	// Tier 2: SSE local.
	if (cfg.sseLocalURL) {
		if (await healthCheck(`${cfg.sseLocalURL}/healthz`, 200)) {
			return { type: "sse", baseURL: cfg.sseLocalURL };
		}
	}

	// Tier 3: SSE remote.
	if (cfg.sseRemoteURL) {
		if (await healthCheck(`${cfg.sseRemoteURL}/healthz`, 200)) {
			return { type: "sse-remote", baseURL: cfg.sseRemoteURL };
		}
	}

	return { type: "none", baseURL: "" };
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

const ENTRIES_PATH = "/api/v1/openbrain/entries";

export async function obWrite(cfg: OBConfig, wr: WriteRequest): Promise<boolean> {
	const transport = await detectTransport(cfg);
	if (transport.type === "none") return false;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeout);
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (cfg.apiKey) {
			headers.Authorization = `Bearer ${cfg.apiKey}`;
		}

		const resp = await fetch(`${transport.baseURL}${ENTRIES_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify(wr),
			signal: controller.signal,
		});
		clearTimeout(timer);
		return Math.floor(resp.status / 100) === 2;
	} catch {
		return false;
	}
}

export async function obRead(cfg: OBConfig, params: ReadParams): Promise<ReadEntry[]> {
	const transport = await detectTransport(cfg);
	if (transport.type === "none") return [];

	const searchParams = new URLSearchParams();
	if (params.type) searchParams.set("type", params.type);
	if (params.q) searchParams.set("q", params.q);
	if (params.since) searchParams.set("since", params.since);
	if (params.limit) searchParams.set("limit", String(params.limit));

	const qs = searchParams.toString();
	const url = `${transport.baseURL}${ENTRIES_PATH}${qs ? `?${qs}` : ""}`;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeout);
		const headers: Record<string, string> = {};
		if (cfg.apiKey) {
			headers.Authorization = `Bearer ${cfg.apiKey}`;
		}

		const resp = await fetch(url, { headers, signal: controller.signal });
		clearTimeout(timer);

		if (Math.floor(resp.status / 100) !== 2) return [];

		const data = (await resp.json()) as ReadResponse;
		return data.entries ?? [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk up from dir to find a .git directory, return that root. */
export function gitRoot(dir: string): string {
	let current = dir;
	for (;;) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return "";
		current = parent;
	}
}

/** Derive project name from a file path (git root basename or parent dir). */
export function projectFromPath(filePath: string): string {
	const dir = dirname(filePath);
	const root = gitRoot(dir);
	if (root) return basename(root);
	return basename(dir);
}

/** Truncate a string to maxLen with "..." appended. */
export function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 3) + "...";
}

/** Return the first non-empty line of a string. */
export function firstLine(s: string): string {
	return s.split("\n")[0]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// No-op extension default export (required by pi-mono extension loader)
// ---------------------------------------------------------------------------

export default function obClientModule(_pi: ExtensionAPI) {
	// Shared library module -- no handlers registered.
}
