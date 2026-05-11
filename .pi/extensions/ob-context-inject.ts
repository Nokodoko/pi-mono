/**
 * OpenBrain Context Injection Extension
 *
 * SessionStart hook: fetches identity, project, session, and last-session
 * context layers from the OB API in parallel, assembles them into an
 * <openbrain-context> XML block, and injects it into the system prompt.
 *
 * Port of: openbrain/hooks/go/cmd/ob-context-inject/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import {
	type OBConfig,
	type ReadEntry,
	loadConfig,
	detectTransport,
	obRead,
} from "./ob-client.js";

// ---------------------------------------------------------------------------
// Terminal card renderer
// ---------------------------------------------------------------------------

interface LayerResult {
	name: "identity" | "project" | "session" | "last_session";
	entries: ReadEntry[];
}

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function timeOfDay(): string {
	const h = new Date().getHours();
	if (h < 12) return "morning";
	if (h < 17) return "afternoon";
	if (h < 22) return "evening";
	return "late";
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

function buildCard(
	results: LayerResult[],
	workdir: string,
	hostName: string,
	connected: boolean,
): string[] {
	const width = Math.min(Math.max((process.stdout.columns ?? 70), 40), 70);
	const inner = width - 4;
	const user = process.env.USER ?? "pi";
	const host = hostName.split(".")[0] ?? "local";

	const lastSession = results.find((r) => r.name === "last_session");
	const sessionLayer = results.find((r) => r.name === "session");
	const lastEntry = lastSession?.entries[0];
	const sessionEntries = sessionLayer?.entries ?? [];
	const pending = sessionEntries.filter((e) => e.item_type === "task");
	const recent = sessionEntries.filter((e) => e.item_type !== "task");

	const project = basename(workdir);
	const titleText = ` ob1 · ${timeOfDay()} · ${user}@${host} `;
	const titleLen = titleText.length;
	const dashCount = Math.max(0, width - 2 - titleLen);
	const dashLeft = Math.floor(dashCount / 2);
	const dashRight = dashCount - dashLeft;

	// Magenta frame; bold title text inside.
	const border = (s: string) => `${MAGENTA}${s}${RESET}`;
	const padLine = (label: string, value: string): string => {
		const content = `${BOLD}${label}${RESET} ${truncate(value, inner - label.length - 1)}`;
		const visLen = label.length + 1 + Math.min(value.length, inner - label.length - 1);
		const pad = Math.max(0, inner - visLen);
		return `${border("│")} ${content}${" ".repeat(pad)} ${border("│")}`;
	};

	// Render a colored status line (no BOLD label, no truncation of escape codes).
	// statusText is the visible text; colorCode is its ANSI color.
	const statusLine = (statusText: string, colorCode: string): string => {
		const visLen = statusText.length;
		const pad = Math.max(0, inner - visLen);
		return `${border("│")} ${colorCode}${statusText}${RESET}${" ".repeat(pad)} ${border("│")}`;
	};

	const lines: string[] = [
		`${border("╭")}${border("─".repeat(dashLeft))}${BOLD}${titleText}${RESET}${border("─".repeat(dashRight))}${border("╮")}`,
		connected
			? statusLine("ob1 connected", GREEN)
			: statusLine("ob1 disconnected", RED),
		padLine("project:", project),
	];

	if (lastEntry?.raw_content) lines.push(padLine("Last:", lastEntry.raw_content));
	if (pending.length > 0) lines.push(padLine(`Pending (${pending.length}):`, pending[0]?.raw_content ?? ""));
	if (recent.length > 0) lines.push(padLine(`Recent (${recent.length}/24h):`, recent[0]?.raw_content ?? ""));

	lines.push(`${border("╰")}${border("─".repeat(width - 2))}${border("╯")}`);
	return lines;
}

// ---------------------------------------------------------------------------
// Layer fetching
// ---------------------------------------------------------------------------

async function fetchIdentityLayer(cfg: OBConfig): Promise<LayerResult> {
	const entries = await obRead(cfg, { type: "contact", limit: 5 });
	return { name: "identity", entries };
}

async function fetchProjectLayer(cfg: OBConfig, workdir: string): Promise<LayerResult> {
	const projectName = basename(workdir);
	const query = `project ${projectName} architecture decisions`;
	const entries = await obRead(cfg, { type: "project", q: query, limit: 10 });
	return { name: "project", entries };
}

async function fetchSessionLayer(cfg: OBConfig): Promise<LayerResult> {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const [sessions, observations] = await Promise.all([
		obRead(cfg, { type: "session", since, limit: 10 }),
		obRead(cfg, { type: "observation", since, limit: 5 }),
	]);

	return { name: "session", entries: [...sessions, ...observations] };
}

async function fetchLastSessionLayer(cfg: OBConfig): Promise<LayerResult> {
	const entries = await obRead(cfg, { type: "session", limit: 1 });
	return { name: "last_session", entries };
}

async function fetchAllLayers(cfg: OBConfig, workdir: string): Promise<LayerResult[]> {
	const results = await Promise.allSettled([
		fetchIdentityLayer(cfg),
		fetchProjectLayer(cfg, workdir),
		fetchSessionLayer(cfg),
		fetchLastSessionLayer(cfg),
	]);

	return results
		.filter((r): r is PromiseFulfilledResult<LayerResult> => r.status === "fulfilled")
		.map((r) => r.value);
}

// ---------------------------------------------------------------------------
// XML assembly
// ---------------------------------------------------------------------------

function writeEntries(entries: ReadEntry[], indent: string): string {
	const lines: string[] = [];
	for (const entry of entries) {
		const itemType = entry.item_type || "unknown";
		const priority = entry.priority || 2;
		const content = entry.raw_content;
		if (!content) continue;

		lines.push(`${indent}<entry type="${itemType}" priority="${priority}">`);
		lines.push(`${indent}  ${content}`);
		lines.push(`${indent}</entry>`);
	}
	return lines.join("\n");
}

function assembleXML(
	results: LayerResult[],
	transportType: string,
	workdir: string,
): string {
	const totalEntries = results.reduce((sum, r) => sum + r.entries.length, 0);
	if (totalEntries === 0) return "";

	const now = new Date().toISOString();
	const lines: string[] = [];

	lines.push(`\n<openbrain-context fetched="${now}" transport="${transportType}">`);

	for (const r of results) {
		if (r.entries.length === 0) continue;

		switch (r.name) {
			case "identity":
				lines.push("  <identity>");
				lines.push(writeEntries(r.entries, "    "));
				lines.push("  </identity>");
				break;

			case "project": {
				const projectName = basename(workdir);
				lines.push(`  <project name="${projectName}" dir="${workdir}">`);
				lines.push(writeEntries(r.entries, "    "));
				lines.push("  </project>");
				break;
			}

			case "last_session":
				lines.push("  <last-session>");
				lines.push(writeEntries(r.entries, "    "));
				lines.push("  </last-session>");
				break;

			case "session":
				lines.push('  <session since="24h">');
				lines.push(writeEntries(r.entries, "    "));
				lines.push("  </session>");
				break;
		}
	}

	lines.push("</openbrain-context>\n");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// Per-process ob1 transport state, captured at session_start, consumed by
// before_agent_start to build a model-visible system-prompt addendum each turn.
interface Ob1RuntimeState {
	transportType: string;
	hostName: string;
}

function buildOb1SystemAddendum(state: Ob1RuntimeState): string {
	return `

<openbrain-protocol transport="${state.transportType}" host="${state.hostName}">
OpenBrain (ob1) is your persistent memory layer.
- Session start injects an <openbrain-context> block above; treat it as authoritative recent state.
- When the user mentions ob1/openbrain or references prior sessions/decisions, consult that block before asking.
- For unfamiliar terms, acronyms, or project names, query ob1 (semantic search) before asking the user.
- After clarification on any unknown term, persist the answer to ob1 so the next session does not re-ask.
</openbrain-protocol>`;
}

export default function obContextInjectExtension(pi: ExtensionAPI) {
	let runtime: Ob1RuntimeState | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig(500);

		const transport = await detectTransport(cfg);
		const connected = transport.type !== "none";

		// Cache transport + host so before_agent_start can append a model-visible
		// stanza without re-running detection every turn. Only cache when
		// actually connected — disconnected sessions skip the protocol addendum.
		if (connected) {
			runtime = { transportType: transport.type, hostName: cfg.hostName };
		}

		const workdir = ctx.cwd;
		const results = connected ? await fetchAllLayers(cfg, workdir) : [];

		if (connected) {
			const xml = assembleXML(results, transport.type, workdir);
			if (xml) {
				pi.sendMessage({
					customType: "openbrain-context",
					content: xml,
					display: false,
				});
			}
		}

		// Always render the card so disconnected state is visible to the user.
		if (ctx.hasUI) {
			ctx.ui.setWidget(
				"ob1-card",
				buildCard(results, workdir, cfg.hostName, connected),
				{ placement: "belowFooter" },
			);
		}
	});

	// Append an ob1 protocol stanza to the assembled system prompt each turn so
	// the model itself sees ob1 awareness, not just the UI/custom-message layer.
	pi.on("before_agent_start", async (event) => {
		if (!runtime) return undefined;
		return { systemPrompt: event.systemPrompt + buildOb1SystemAddendum(runtime) };
	});
}
