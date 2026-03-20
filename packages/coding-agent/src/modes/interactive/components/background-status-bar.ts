/**
 * BackgroundStatusBar - Shows count and status of running background agents.
 *
 * Rendered above the editor when background agents are active.
 * Shows a single summary line with agent count and a hint to manage them.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { BackgroundAgentManager } from "../../../core/background-agent-manager.js";
import { theme } from "../theme/theme.js";

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

export class BackgroundStatusBar implements Component {
	constructor(
		private manager: BackgroundAgentManager,
		_onManage: () => void,
	) {}

	render(width: number): string[] {
		const runningCount = this.manager.getRunningCount();
		const completedCount = this.manager.getCompletedResults().length;
		const totalCount = runningCount + completedCount;

		if (totalCount === 0) return [];

		const parts: string[] = [];

		if (runningCount > 0) {
			const label = runningCount === 1 ? "agent" : "agents";
			parts.push(theme.fg("accent", `${runningCount} background ${label} running`));
		}

		if (completedCount > 0) {
			const label = completedCount === 1 ? "result" : "results";
			parts.push(theme.fg("success", `${completedCount} ${label} ready`));
		}

		const statusText = parts.join(theme.fg("dim", " | "));
		const hint = theme.fg("dim", " (Ctrl+B to manage)");
		const prefix = theme.fg("dim", " ↓ ");

		const line = `${prefix}${statusText}${hint}`;
		return [truncateToWidth(line, width, theme.fg("dim", "…"))];
	}

	invalidate(): void {
		// No cached state to invalidate
	}
}

export { formatDuration };
