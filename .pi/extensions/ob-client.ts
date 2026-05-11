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
import { spawnSync } from "node:child_process";
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
		const ok = Math.floor(resp.status / 100) === 2;
		if (ok) {
			piDunst("pi-ob1 write", `${wr.item_type}: ${truncate(firstLine(wr.raw_content), 80)}`, "normal");
		} else {
			piDunst("pi-ob1 write FAILED", `${wr.item_type} → HTTP ${resp.status}`, "critical");
		}
		return ok;
	} catch (err) {
		piDunst("pi-ob1 write FAILED", String(err).slice(0, 80), "critical");
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

		if (Math.floor(resp.status / 100) !== 2) {
			piDunst("pi-ob1 read FAILED", `HTTP ${resp.status} via ${transport.type}`, "critical");
			return [];
		}

		const data = (await resp.json()) as ReadResponse;
		const entries = data.entries ?? [];

		obReadSuccessCount++;
		if (obReadSuccessCount % OB_READ_NOTIFY_EVERY === 0) {
			piDunst("pi-ob1 read", `${entries.length} entries via ${transport.type}`, "low");
		}

		return entries;
	} catch (err) {
		piDunst("pi-ob1 read FAILED", String(err).slice(0, 80), "critical");
		return [];
	}
}

// ---------------------------------------------------------------------------
// TrustGraph Types
// ---------------------------------------------------------------------------

export interface GraphQueryOpts {
	limit?: number;
	collection?: string;
}

export interface GraphQueryResult {
	ok: boolean;
	data?: { response: string; tool: string };
	error?: string;
	degraded?: boolean;
}

export interface GraphSearchEntity {
	entity: string;
	entity_type: string;
	score: number;
}

export interface GraphSearchResult {
	ok: boolean;
	data?: { entities: GraphSearchEntity[]; count: number; tool: string };
	error?: string;
	degraded?: boolean;
}

export interface TriplesValue {
	value: string;
	type: string;
	is_entity: boolean;
}

export interface Triple {
	s: TriplesValue;
	p: TriplesValue;
	o: TriplesValue;
}

export interface TriplesOpts {
	subject?: string;
	predicate?: string;
	object?: string;
	limit?: number;
}

export interface TriplesResult {
	ok: boolean;
	data?: { triples: Triple[]; count: number; tool: string };
	error?: string;
	degraded?: boolean;
}

// ---------------------------------------------------------------------------
// TrustGraph MCP SSE helpers
// ---------------------------------------------------------------------------

/** Module-level counter for throttling graph success notifications. */
let obGraphSuccessCount = 0;
const OB_GRAPH_NOTIFY_EVERY = Number(env.OB_GRAPH_NOTIFY_EVERY ?? 10) || 10;

/**
 * Call an ob-mcp MCP tool via the SSE JSON-RPC protocol.
 * Establishes a one-shot SSE session, sends the tool call, reads the response.
 */
async function callMCPTool(
	baseURL: string,
	apiKey: string,
	toolName: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		// Step 1: connect to SSE endpoint to get a session URL.
		const sseResp = await fetch(`${baseURL}/sse`, {
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});

		if (!sseResp.ok || !sseResp.body) {
			return { success: false, error: `SSE connect failed: HTTP ${sseResp.status}` };
		}

		// Parse the first SSE event to extract the message endpoint URL.
		let messageURL = "";
		const reader = sseResp.body.getReader();
		const decoder = new TextDecoder();
		let sseBuffer = "";
		let sessionID = "";

		// Read SSE events until we find the endpoint or timeout.
		outer: while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			sseBuffer += decoder.decode(value, { stream: true });
			const lines = sseBuffer.split("\n");
			sseBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("data:")) {
					const data = line.slice(5).trim();
					// The SSE server sends the message endpoint as the first event.
					if (data.startsWith("/message") || data.includes("sessionId=")) {
						messageURL = data.startsWith("http") ? data : `${baseURL}${data}`;
						const match = data.match(/sessionId=([^&\s]+)/);
						if (match) sessionID = match[1];
						break outer;
					}
				}
			}
		}

		if (!messageURL || !sessionID) {
			reader.cancel();
			return { success: false, error: "SSE did not provide message endpoint" };
		}

		// Step 2: POST JSON-RPC tool call to /message?sessionId=<id>.
		const rpcID = Date.now();
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: rpcID,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: { api_key: apiKey, ...params },
			},
		});

		const postResp = await fetch(messageURL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal: controller.signal,
		});

		// SSE transport returns 202 Accepted; the actual response comes via SSE.
		if (postResp.status !== 202) {
			reader.cancel();
			return { success: false, error: `tool call rejected: HTTP ${postResp.status}` };
		}

		// Step 3: read SSE events until we find the response for our rpcID.
		let resultPayload: unknown;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			sseBuffer += decoder.decode(value, { stream: true });
			const lines = sseBuffer.split("\n");
			sseBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("data:")) {
					const data = line.slice(5).trim();
					try {
						const msg = JSON.parse(data) as {
							id?: unknown;
							result?: { content?: Array<{ text?: string }> };
							error?: { message?: string };
						};
						if (msg.id === rpcID) {
							if (msg.error) {
								reader.cancel();
								return { success: false, error: msg.error.message ?? "rpc error" };
							}
							const text = msg.result?.content?.[0]?.text;
							if (text) {
								resultPayload = JSON.parse(text);
							}
							break;
						}
					} catch {
						// Not JSON or not our message — continue.
					}
				}
			}
			if (resultPayload !== undefined) break;
		}

		reader.cancel();

		if (resultPayload === undefined) {
			return { success: false, error: "no response received from SSE stream" };
		}

		return { success: true, result: resultPayload };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Query the TrustGraph knowledge graph using natural language (GraphRAG).
 */
export async function obGraphQuery(
	cfg: OBConfig,
	query: string,
	opts: GraphQueryOpts = {},
): Promise<GraphQueryResult> {
	const transport = await detectTransport(cfg);
	if (transport.type === "none") return { ok: false, error: "no transport available" };

	const params: Record<string, unknown> = { question: query };
	if (opts.collection) params.collection = opts.collection;
	if (opts.limit) params.entity_limit = opts.limit;

	try {
		const res = await callMCPTool(
			transport.baseURL,
			cfg.apiKey,
			"ob.graph_query",
			params,
			3000,
		);

		if (!res.success) {
			piDunst("pi-ob1-graph query FAILED", truncate(res.error ?? "unknown", 80), "critical");
			return { ok: false, error: res.error, degraded: true };
		}

		const payload = res.result as { success?: boolean; degraded?: boolean; response?: string; error?: string; tool?: string };

		if (payload.degraded || !payload.success) {
			piDunst("pi-ob1-graph query degraded", truncate(payload.error ?? "degraded", 80), "critical");
			return { ok: false, error: payload.error, degraded: true };
		}

		obGraphSuccessCount++;
		if (obGraphSuccessCount % OB_GRAPH_NOTIFY_EVERY === 0) {
			piDunst("pi-ob1-graph query", truncate(payload.response ?? "", 80), "low");
		}

		return { ok: true, data: { response: payload.response ?? "", tool: payload.tool ?? "ob.graph_query" } };
	} catch (err) {
		piDunst("pi-ob1-graph query FAILED", String(err).slice(0, 80), "critical");
		return { ok: false, error: String(err), degraded: true };
	}
}

/**
 * Search the TrustGraph knowledge graph for entities similar to a text query.
 */
export async function obGraphSearch(
	cfg: OBConfig,
	query: string,
	opts: GraphQueryOpts = {},
): Promise<GraphSearchResult> {
	const transport = await detectTransport(cfg);
	if (transport.type === "none") return { ok: false, error: "no transport available" };

	const params: Record<string, unknown> = { query };
	if (opts.collection) params.collection = opts.collection;
	if (opts.limit) params.limit = opts.limit;

	try {
		const res = await callMCPTool(
			transport.baseURL,
			cfg.apiKey,
			"ob.graph_search",
			params,
			3000,
		);

		if (!res.success) {
			piDunst("pi-ob1-graph search FAILED", truncate(res.error ?? "unknown", 80), "critical");
			return { ok: false, error: res.error, degraded: true };
		}

		const payload = res.result as {
			success?: boolean;
			degraded?: boolean;
			entities?: GraphSearchEntity[];
			count?: number;
			error?: string;
			tool?: string;
		};

		if (payload.degraded || !payload.success) {
			piDunst("pi-ob1-graph search degraded", truncate(payload.error ?? "degraded", 80), "critical");
			return { ok: false, error: payload.error, degraded: true };
		}

		obGraphSuccessCount++;
		if (obGraphSuccessCount % OB_GRAPH_NOTIFY_EVERY === 0) {
			piDunst("pi-ob1-graph search", `${payload.count ?? 0} entities via ${transport.type}`, "low");
		}

		return {
			ok: true,
			data: {
				entities: payload.entities ?? [],
				count: payload.count ?? 0,
				tool: payload.tool ?? "ob.graph_search",
			},
		};
	} catch (err) {
		piDunst("pi-ob1-graph search FAILED", String(err).slice(0, 80), "critical");
		return { ok: false, error: String(err), degraded: true };
	}
}

/**
 * Query knowledge graph triples by subject/predicate/object pattern.
 */
export async function obTriples(cfg: OBConfig, opts: TriplesOpts = {}): Promise<TriplesResult> {
	const transport = await detectTransport(cfg);
	if (transport.type === "none") return { ok: false, error: "no transport available" };

	const params: Record<string, unknown> = {};
	if (opts.subject) params.subject = opts.subject;
	if (opts.predicate) params.predicate = opts.predicate;
	if (opts.object) params.object = opts.object;
	if (opts.limit) params.limit = opts.limit;

	try {
		const res = await callMCPTool(
			transport.baseURL,
			cfg.apiKey,
			"ob.triples",
			params,
			3000,
		);

		if (!res.success) {
			piDunst("pi-ob1-graph triples FAILED", truncate(res.error ?? "unknown", 80), "critical");
			return { ok: false, error: res.error, degraded: true };
		}

		const payload = res.result as {
			success?: boolean;
			degraded?: boolean;
			triples?: Triple[];
			count?: number;
			error?: string;
			tool?: string;
		};

		if (payload.degraded || !payload.success) {
			piDunst("pi-ob1-graph triples degraded", truncate(payload.error ?? "degraded", 80), "critical");
			return { ok: false, error: payload.error, degraded: true };
		}

		obGraphSuccessCount++;
		if (obGraphSuccessCount % OB_GRAPH_NOTIFY_EVERY === 0) {
			piDunst("pi-ob1-graph triples", `${payload.count ?? 0} triples via ${transport.type}`, "low");
		}

		return {
			ok: true,
			data: {
				triples: payload.triples ?? [],
				count: payload.count ?? 0,
				tool: payload.tool ?? "ob.triples",
			},
		};
	} catch (err) {
		piDunst("pi-ob1-graph triples FAILED", String(err).slice(0, 80), "critical");
		return { ok: false, error: String(err), degraded: true };
	}
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const PI_DUNST_ICON = "/home/n0ko/Pictures/neonIcons/goldArcRune.png";

/** Module-level counter for throttling obRead success notifications. */
let obReadSuccessCount = 0;
const OB_READ_NOTIFY_EVERY = 10;

/**
 * Fire a desktop notification via notify-send, gated by OB_PI_NOTIFY env var.
 * OB_PI_NOTIFY defaults to ON; set OB_PI_NOTIFY=0 to disable.
 */
function piDunst(title: string, body: string, urgency: "low" | "normal" | "critical"): void {
	if (env.OB_PI_NOTIFY === "0") return;
	spawnSync("notify-send", [
		"--app-name=pi-ob1",
		`--icon=${PI_DUNST_ICON}`,
		`--urgency=${urgency}`,
		title,
		body,
	]);
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
