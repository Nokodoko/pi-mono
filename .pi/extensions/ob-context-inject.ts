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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	type OBConfig,
	type ReadEntry,
	type GraphSearchEntity,
	loadConfig,
	detectTransport,
	obRead,
	obGraphSearch,
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
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

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

	// Render a status line where ONLY the state literal (connected/disconnected)
	// is colored — mirrors the cc convention (sessionbanner.cardStateLabel,
	// ob1tail.formatStatus, tgviz header). Visible width = label + 1 + token.
	const statusLine = (label: string, token: string, colorCode: string): string => {
		const visLen = label.length + 1 + token.length;
		const pad = Math.max(0, inner - visLen);
		return `${border("│")} ${label} ${colorCode}${token}${RESET}${" ".repeat(pad)} ${border("│")}`;
	};

	const lines: string[] = [
		`${border("╭")}${border("─".repeat(dashLeft))}${BOLD}${titleText}${RESET}${border("─".repeat(dashRight))}${border("╮")}`,
		connected
			? statusLine("ob1", "connected", GREEN)
			: statusLine("ob1", "disconnected", RED),
		padLine("project:", project),
	];

	if (lastEntry?.raw_content) lines.push(padLine("Last:", lastEntry.raw_content));
	if (pending.length > 0) lines.push(padLine(`Pending (${pending.length}):`, pending[0]?.raw_content ?? ""));
	if (recent.length > 0) lines.push(padLine(`Recent (${recent.length}/24h):`, recent[0]?.raw_content ?? ""));

	lines.push(`${border("╰")}${border("─".repeat(width - 2))}${border("╯")}`);
	return lines;
}

// ---------------------------------------------------------------------------
// TrustGraph viz card
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleWidth(s: string): number {
	return s.replace(ANSI_RE, "").length;
}

async function buildTgVizCard(width: number, hostName: string): Promise<string[]> {
	const inner = width - 4;
	const host = hostName.split(".")[0] ?? "local";
	const border = (s: string) => `${CYAN}${s}${RESET}`;

	const makeLine = (text: string): string => {
		const pad = Math.max(0, inner - visibleWidth(text));
		return `${border("│")} ${text}${" ".repeat(pad)} ${border("│")}`;
	};

	const makeHeader = (state: string): string => {
		const titleText = ` tg · ${state} · ${host} `;
		const dashCount = Math.max(0, width - 2 - visibleWidth(titleText));
		const dashLeft = Math.floor(dashCount / 2);
		const dashRight = dashCount - dashLeft;
		return `${border("╭")}${border("─".repeat(dashLeft))}${BOLD}${titleText}${RESET}${border("─".repeat(dashRight))}${border("╮")}`;
	};

	const footer = `${border("╰")}${border("─".repeat(width - 2))}${border("╯")}`;

	// Colored state tokens — mirrors the cc tgviz convention (only the literal
	// connected/disconnected token is colored; the rest of the header is plain).
	const connectedToken = `${GREEN}connected${RESET}`;
	const disconnectedToken = `${RED}disconnected${RESET}`;

	// Degraded box helper — same height as a 3-body-line success box (header + 3 + footer = 5).
	const degradedBox = (reason: string): string[] => [
		makeHeader(disconnectedToken),
		makeLine(`${DIM}${reason}${RESET}`),
		makeLine(""),
		makeLine(""),
		footer,
	];

	let stdout: string;
	try {
		const result = await execFileAsync("cmdr", ["tg-summary", "--no-color"], {
			timeout: 5000,
		});
		stdout = result.stdout.trim();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("ENOENT") || msg.includes("not found")) {
			return degradedBox("cmdr not found");
		}
		return degradedBox("cmdr tg-summary error");
	}

	const rawLines = stdout.split("\n").filter(Boolean);
	if (rawLines.length === 0) return degradedBox("no output");

	const summary = rawLines[0] ?? "";
	const bodyLines = rawLines.slice(1);

	// State token in the header is colored (green=connected, red=disconnected).
	// The richer cmdr summary (e.g. "110 nodes · 200 edges") moves to the first
	// body line so the header stays parity-shaped with cc's tgviz pane.
	const summaryTrimmed = summary.replace(/^TG\s*·\s*/, "");
	const isDisconnected = summaryTrimmed.toLowerCase().includes("disconnected");
	const stateToken = isDisconnected ? disconnectedToken : connectedToken;

	const lines: string[] = [makeHeader(stateToken)];
	if (!isDisconnected && summaryTrimmed.length > 0) {
		lines.push(makeLine(truncate(summaryTrimmed, inner)));
	}
	for (const line of bodyLines) {
		lines.push(makeLine(truncate(line, inner)));
	}
	// Pad to consistent height (3 body lines) for layout stability.
	while (lines.length < 4) lines.push(makeLine(""));
	lines.push(footer);
	return lines;
}

// ---------------------------------------------------------------------------
// Horizontal card join
// ---------------------------------------------------------------------------

/**
 * Join two string[] card frames side-by-side with a single space separator.
 * Both frames are padded to equal height by inserting empty interior lines
 * (before the bottom border) in the shorter one.
 */
function joinCardsHorizontal(left: string[], right: string[]): string[] {
	// Pad a card to targetLen by inserting blank interior lines before the last line.
	const padCard = (card: string[], targetLen: number): string[] => {
		if (card.length >= targetLen) return card;
		const top = card.slice(0, -1);
		const bottom = card[card.length - 1] ?? "";
		// Determine interior width from the first body line (index 1).
		const sampleLine = card[1] ?? card[0] ?? "";
		const fullWidth = visibleWidth(sampleLine);
		const blankLine = " ".repeat(fullWidth);
		const blanks = Array(targetLen - card.length).fill(blankLine);
		return [...top, ...blanks, bottom];
	};

	const maxLen = Math.max(left.length, right.length);
	const paddedLeft = padCard(left, maxLen);
	const paddedRight = padCard(right, maxLen);

	return paddedLeft.map((line, i) => `${line} ${paddedRight[i] ?? ""}`);
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
// Graph context
// ---------------------------------------------------------------------------

// Maximum number of graph entities to include in the block.
const GRAPH_ENTITY_LIMIT = 5;
// Maximum character length per entity text before truncation.
const GRAPH_ENTITY_MAX_CHARS = 200;
// Budget for graph search: must return before this deadline or be omitted.
const GRAPH_SEARCH_TIMEOUT_MS = 2000;

/**
 * Assemble a <graph-context> XML block from obGraphSearch results.
 * Returns an empty string if no usable entities are found or TG times out.
 */
async function buildGraphContextBlock(cfg: OBConfig, query: string): Promise<string> {
	// Apply a hard 2-second deadline so TG latency never blocks SessionStart.
	const raceTimeout = new Promise<null>((resolve) =>
		setTimeout(() => resolve(null), GRAPH_SEARCH_TIMEOUT_MS),
	);

	let entities: GraphSearchEntity[] = [];
	try {
		const result = await Promise.race([
			obGraphSearch(cfg, query, { limit: GRAPH_ENTITY_LIMIT }),
			raceTimeout,
		]);
		if (!result || !result.ok || !result.data) return "";
		entities = result.data.entities;
	} catch {
		// Silent skip — TG must never block SessionStart.
		return "";
	}

	if (entities.length === 0) return "";

	const now = new Date().toISOString();
	const lines: string[] = [];
	lines.push(`\n<graph-context fetched="${now}" source="trustgraph">`);

	for (const ent of entities.slice(0, GRAPH_ENTITY_LIMIT)) {
		const text = truncate(`[${ent.entity_type}] ${ent.entity}`, GRAPH_ENTITY_MAX_CHARS);
		lines.push(`  <entry>${text}</entry>`);
	}

	lines.push("</graph-context>\n");
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
	// Cached <openbrain-context>+<graph-context> block assembled at session_start.
	// Injected into the model's view via the system prompt on the FIRST
	// before_agent_start of the session, then cleared so subsequent turns only
	// get the protocol stanza (data stays in conversation context after turn 1).
	contextBlock: string;
	contextBlockConsumed: boolean;
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

		const workdir = ctx.cwd;

		// Fetch OB layers and TrustGraph context in parallel. The graph search
		// uses the project name as its seed query (it runs concurrently with the
		// layer fetches, so richer session metadata is not yet available). If the
		// graph search exceeds its internal 2-second deadline it returns "" and
		// the SessionStart block ships without it.
		const [results, graphBlock, tgCard] = await Promise.all([
			connected ? fetchAllLayers(cfg, workdir) : Promise.resolve([] as LayerResult[]),
			connected
				? buildGraphContextBlock(cfg, basename(workdir)).catch(() => "")
				: Promise.resolve(""),
			ctx.hasUI ? buildTgVizCard(62, cfg.hostName) : Promise.resolve([] as string[]),
		]);

		// Cache transport + host + the assembled context block so before_agent_start
		// can prepend a model-visible block on turn 1 (same path the protocol
		// stanza already uses). This replaces the prior pi.sendMessage approach,
		// which races against the first model turn and depended on custom→user
		// role conversion happening before the LLM call assembled history.
		if (connected) {
			const xml = assembleXML(results, transport.type, workdir);
			const fullBlock = (xml || graphBlock) ? (xml ?? "") + graphBlock : "";
			runtime = {
				transportType: transport.type,
				hostName: cfg.hostName,
				contextBlock: fullBlock,
				contextBlockConsumed: false,
			};
		}

		// Always render the dual card so disconnected state is visible to the user.
		if (ctx.hasUI) {
			const obCard = buildCard(results, workdir, cfg.hostName, connected);
			const joined = joinCardsHorizontal(obCard, tgCard);
			ctx.ui.setWidget("ob1-card", joined, { placement: "belowFooter" });
		}
	});

	// Append the ob1 context block (turn 1) and the protocol stanza (every turn)
	// to the assembled system prompt so the model sees ob1 awareness AND the
	// fetched data, not just the UI/custom-message layer.
	pi.on("before_agent_start", async (event) => {
		if (!runtime) return undefined;
		let systemPrompt = event.systemPrompt + buildOb1SystemAddendum(runtime);
		if (!runtime.contextBlockConsumed && runtime.contextBlock) {
			systemPrompt = systemPrompt + "\n" + runtime.contextBlock;
			runtime.contextBlockConsumed = true;
		}
		return { systemPrompt };
	});
}
