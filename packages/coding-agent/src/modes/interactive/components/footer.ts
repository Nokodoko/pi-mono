import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { userInfo } from "os";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Build a visual progress bar.
 * @param percent 0-100
 * @param barWidth number of character cells for the bar (excluding brackets)
 */
function buildProgressBar(percent: number, barWidth: number): string {
	const filled = Math.round((percent / 100) * barWidth);
	const empty = barWidth - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Format context window size for display (e.g., "1M context", "200k context").
 */
function formatContextWindow(contextWindow: number): string {
	return `${formatTokens(contextWindow)} context`;
}

/**
 * Footer component that shows model info, context progress bar, cost, and extension statuses.
 *
 * Layout:
 *   Line 1: username | [model (context)] [progress-bar] pct% | $cost
 *   Line 2: pwd (branch) • session  OR  extension statuses (if any)
 *   Line 3: extension statuses (if pwd line is also shown)
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private cachedUsername: string | undefined;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	private getUsername(): string {
		if (this.cachedUsername === undefined) {
			try {
				this.cachedUsername = userInfo().username;
			} catch {
				this.cachedUsername = process.env.USER || process.env.USERNAME || "user";
			}
		}
		return this.cachedUsername;
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercentKnown = contextUsage?.percent !== null;

		// --- Line 1: username | [model (context)] [progress-bar] pct% | $cost ---

		const username = this.getUsername();

		// Model display name: prefer .name, fall back to .id
		const modelName = state.model?.name || state.model?.id || "no-model";

		// Add thinking level if model supports reasoning
		let modelDisplay = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			if (thinkingLevel !== "off") {
				modelDisplay = `${modelName} • ${thinkingLevel}`;
			}
		}

		// Context window formatted
		const ctxWindowStr = contextWindow > 0 ? ` (${formatContextWindow(contextWindow)})` : "";

		// Model segment: [Model Name (Xk context)]
		const modelSegment = `[${modelDisplay}${ctxWindowStr}]`;

		// Progress bar + percentage
		const pctStr = contextPercentKnown ? `${Math.round(contextPercentValue)}%` : "?%";
		const autoIndicator = this.autoCompactEnabled ? "" : " manual";

		// Cost segment
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const costStr = `$${totalCost.toFixed(4)}${usingSubscription ? " (sub)" : ""}`;

		// Build the line with a dynamic-width progress bar
		// Format: "username | [model (ctx)] [██░░] XX% | $X.XXXX"
		const prefix = `${username} | ${modelSegment} `;
		const suffix = ` ${pctStr}${autoIndicator} | ${costStr}`;
		const prefixWidth = visibleWidth(prefix);
		const suffixWidth = visibleWidth(suffix);
		const barSpace = width - prefixWidth - suffixWidth - 2; // 2 for [ and ]

		// Colorize context percentage based on usage
		let coloredPctStr: string;
		if (contextPercentValue > 90) {
			coloredPctStr = theme.fg("error", pctStr);
		} else if (contextPercentValue > 70) {
			coloredPctStr = theme.fg("warning", pctStr);
		} else {
			coloredPctStr = pctStr;
		}

		let line1: string;
		if (barSpace >= 4) {
			// Enough room for a progress bar
			const bar = buildProgressBar(contextPercentValue, barSpace);
			let coloredBar: string;
			if (contextPercentValue > 90) {
				coloredBar = theme.fg("error", bar);
			} else if (contextPercentValue > 70) {
				coloredBar = theme.fg("warning", bar);
			} else {
				coloredBar = bar;
			}
			const coloredSuffix = ` ${coloredPctStr}${autoIndicator} | ${costStr}`;
			line1 = `${prefix}[${coloredBar}]${coloredSuffix}`;
		} else {
			// Not enough room for bar, compact layout
			line1 = truncateToWidth(
				`${username} | ${modelSegment} ${coloredPctStr}${autoIndicator} | ${costStr}`,
				width,
				"…",
			);
		}

		const dimLine1 = theme.fg("dim", prefix) + line1.slice(prefix.length);

		// --- Line 2: pwd (branch) • session ---

		let pwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}

		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "…"));
		const lines = [dimLine1, pwdLine];

		// --- Line 3 (optional): extension statuses ---
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
		}

		return lines;
	}
}
