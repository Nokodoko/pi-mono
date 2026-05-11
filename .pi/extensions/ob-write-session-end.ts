/**
 * OpenBrain Session End Extension
 *
 * session_shutdown hook: extracts session metadata from the in-memory
 * tool activity log, builds a structured session summary, and synchronously
 * writes it to OB before the process exits.
 *
 * Port of: openbrain/hooks/go/cmd/ob-write-session-end/
 *
 * Also handles deferred nudge entries that were queued during the session.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import { env } from "node:process";
import {
	type WriteRequest,
	loadConfig,
	obWrite,
} from "./ob-client.js";

// ---------------------------------------------------------------------------
// In-memory session activity tracking (global singleton)
// ---------------------------------------------------------------------------

interface ToolRecord {
	ts: string;
	tool: string;
	file: string;
	project: string;
}

interface OBSessionState {
	activity: ToolRecord[];
	deferred: WriteRequest[];
}

// Use a global symbol to ensure the same state object is shared across
// multiple jiti instances (each extension gets its own jiti context).
const OB_STATE_KEY = Symbol.for("__ob_session_state__");

function getSessionState(): OBSessionState {
	const g = globalThis as Record<symbol, OBSessionState | undefined>;
	if (!g[OB_STATE_KEY]) {
		g[OB_STATE_KEY] = { activity: [], deferred: [] };
	}
	return g[OB_STATE_KEY]!;
}

/** Module-level accessors for the global session state. */
export const sessionActivity = {
	get records(): ToolRecord[] {
		return getSessionState().activity;
	},
	push(record: ToolRecord): void {
		getSessionState().activity.push(record);
	},
	slice(start?: number, end?: number): ToolRecord[] {
		return getSessionState().activity.slice(start, end);
	},
	get length(): number {
		return getSessionState().activity.length;
	},
};

export const deferredEntries = {
	get records(): WriteRequest[] {
		return getSessionState().deferred;
	},
	push(wr: WriteRequest): void {
		getSessionState().deferred.push(wr);
	},
};

// ---------------------------------------------------------------------------
// Session summary extraction
// ---------------------------------------------------------------------------

interface SessionSummary {
	filesModified: string[];
	toolsUsed: string[];
	toolCount: number;
	duration: string;
	topFiles: string;
}

function extractSummary(): SessionSummary {
	const records = sessionActivity.records;
	if (records.length === 0) {
		return { filesModified: [], toolsUsed: [], toolCount: 0, duration: "unknown", topFiles: "" };
	}

	const fileCount = new Map<string, number>();
	const toolSet = new Set<string>();

	for (const rec of records) {
		if (rec.file) {
			fileCount.set(rec.file, (fileCount.get(rec.file) ?? 0) + 1);
		}
		if (rec.tool) {
			toolSet.add(rec.tool);
		}
	}

	// Sort files by touch count descending.
	const fileSorted = [...fileCount.entries()].sort((a, b) => b[1] - a[1]);
	const uniqueFiles = fileSorted.map(([path]) => path);

	// Top 3 files by touch count.
	const topNames = fileSorted
		.slice(0, 3)
		.map(([path]) => basename(path));

	// Duration from first to last timestamp.
	let duration = "unknown";
	const firstTS = records[0]?.ts;
	const lastTS = records[records.length - 1]?.ts;
	if (firstTS && lastTS && firstTS !== lastTS) {
		const t0 = new Date(firstTS).getTime();
		const t1 = new Date(lastTS).getTime();
		if (!Number.isNaN(t0) && !Number.isNaN(t1)) {
			const mins = Math.floor((t1 - t0) / 60000);
			duration = mins < 1 ? "<1min" : `~${mins}min`;
		}
	}

	return {
		filesModified: uniqueFiles,
		toolsUsed: [...toolSet].sort(),
		toolCount: records.length,
		duration,
		topFiles: topNames.join(", "),
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function obWriteSessionEndExtension(pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		const cfg = loadConfig(5000);

		const workdir = ctx.cwd;
		const project = basename(workdir) || "unknown";
		const host = cfg.hostName;

		// Write deferred nudge entries first.
		for (const wr of deferredEntries.records) {
			await obWrite(cfg, wr);
		}

		// Extract session summary.
		const summary = extractSummary();

		// Build raw_content summary line.
		let focusSuffix = "";
		if (summary.topFiles) {
			focusSuffix = `. Focus: ${summary.topFiles}`;
		}
		const rawContent = `pi session: project=${project} host=${host} duration=${summary.duration} files_modified=${summary.filesModified.length} tool_calls=${summary.toolCount}${focusSuffix}`;

		// Build tags.
		const tags = ["session-summary", `project:${project}`, `host:${host}`, "agent:pi", "source:pi"];
		const archType = env.ARCHITECTURE_TYPE;
		if (archType) {
			tags.push(`arch:${archType}`);
		}

		const wr: WriteRequest = {
			item_type: "session",
			raw_content: rawContent,
			priority: 2,
			entities: {
				tags,
				files_modified: summary.filesModified,
				tools_used: summary.toolsUsed,
				tool_count: summary.toolCount,
				duration: summary.duration,
				project,
				host,
			},
		};

		const success = await obWrite(cfg, wr);
		if (success && ctx.hasUI) {
			ctx.ui.notify(`OB1: session summary written (${summary.duration})`, "info");
		}
	});
}
