/**
 * BackgroundAgentPanel - Overlay for managing background agents.
 *
 * Shows a list of running and completed background agents with options
 * to abort, view results, or dismiss completed agents.
 */

import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { BackgroundAgentResult, BackgroundAgentStatus } from "../../../core/background-agent.js";
import type { BackgroundAgentManager } from "../../../core/background-agent-manager.js";
import { theme } from "../theme/theme.js";
import { formatDuration } from "./background-status-bar.js";

export interface BackgroundAgentPanelCallbacks {
	/** Called when the panel should close */
	onClose: () => void;
	/** Called when user wants to view results of a completed agent */
	onViewResults: (result: BackgroundAgentResult) => void;
	/** Called when user wants to insert results into chat */
	onInsertResults: (result: BackgroundAgentResult) => void;
}

export class BackgroundAgentPanel implements Component {
	private selectedIndex = 0;
	private items: Array<
		{ type: "running"; status: BackgroundAgentStatus } | { type: "completed"; result: BackgroundAgentResult }
	> = [];

	constructor(
		private manager: BackgroundAgentManager,
		private callbacks: BackgroundAgentPanelCallbacks,
	) {
		this.refreshItems();
	}

	private refreshItems(): void {
		this.items = [];

		// Running agents first
		for (const status of this.manager.getActiveAgents()) {
			this.items.push({ type: "running", status });
		}

		// Completed results
		for (const result of this.manager.getCompletedResults()) {
			this.items.push({ type: "completed", result });
		}

		// Clamp selection
		if (this.selectedIndex >= this.items.length) {
			this.selectedIndex = Math.max(0, this.items.length - 1);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.callbacks.onClose();
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			return;
		}

		// Abort running agent
		if (matchesKey(data, "x") || matchesKey(data, "delete")) {
			const item = this.items[this.selectedIndex];
			if (item?.type === "running") {
				this.manager.abort(item.status.id);
				this.refreshItems();
			} else if (item?.type === "completed") {
				this.manager.dismiss(item.result.id);
				this.refreshItems();
				if (this.items.length === 0) {
					this.callbacks.onClose();
				}
			}
			return;
		}

		// View results or insert
		if (matchesKey(data, "return")) {
			const item = this.items[this.selectedIndex];
			if (item?.type === "completed") {
				this.callbacks.onViewResults(item.result);
			}
			return;
		}

		if (matchesKey(data, "i")) {
			const item = this.items[this.selectedIndex];
			if (item?.type === "completed") {
				this.callbacks.onInsertResults(item.result);
			}
			return;
		}

		// Abort all
		if (matchesKey(data, "shift+x")) {
			this.manager.abortAll();
			this.refreshItems();
			if (this.items.length === 0) {
				this.callbacks.onClose();
			}
			return;
		}
	}

	render(width: number): string[] {
		this.refreshItems();

		const lines: string[] = [];
		const innerWidth = Math.min(width - 4, 60);
		const border = "─".repeat(innerWidth);

		lines.push(theme.fg("dim", `┌─ Background Agents ${border.slice(21)}┐`));
		lines.push(theme.fg("dim", `│${" ".repeat(innerWidth)}│`));

		if (this.items.length === 0) {
			const msg = "  No background agents";
			lines.push(theme.fg("dim", `│${msg.padEnd(innerWidth)}│`));
		} else {
			for (let i = 0; i < this.items.length; i++) {
				const item = this.items[i];
				const selected = i === this.selectedIndex;
				const prefix = selected ? theme.fg("accent", "▸ ") : "  ";

				if (item.type === "running") {
					const elapsed = formatDuration(Date.now() - item.status.startTime);
					const label = truncateLabel(item.status.label, innerWidth - 30);
					const line1 = `${prefix}${theme.bold(`"${label}"`)} - ${theme.fg("accent", "Running")} (${elapsed})`;
					lines.push(theme.fg("dim", "│") + padLine(line1, innerWidth) + theme.fg("dim", "│"));

					if (item.status.currentActivity) {
						const activity = `    ↳ ${item.status.currentActivity}`;
						lines.push(
							theme.fg("dim", "│") + padLine(theme.fg("dim", activity), innerWidth) + theme.fg("dim", "│"),
						);
					}

					if (selected) {
						const hint = `    ${theme.fg("warning", "[x]")} Abort`;
						lines.push(theme.fg("dim", "│") + padLine(hint, innerWidth) + theme.fg("dim", "│"));
					}
				} else {
					const duration = formatDuration(item.result.duration);
					const label = truncateLabel(item.result.label, innerWidth - 30);
					const stateColor = item.result.success ? "success" : "error";
					const stateText = item.result.success ? "Completed" : "Failed";
					const line1 = `${prefix}${theme.bold(`"${label}"`)} - ${theme.fg(stateColor, stateText)} (${duration})`;
					lines.push(theme.fg("dim", "│") + padLine(line1, innerWidth) + theme.fg("dim", "│"));

					const summary = `    ↳ ${item.result.toolCallCount} tool calls, ${item.result.turnCount} turns`;
					lines.push(theme.fg("dim", "│") + padLine(theme.fg("dim", summary), innerWidth) + theme.fg("dim", "│"));

					if (selected) {
						const hints = `    ${theme.fg("accent", "[Enter]")} View  ${theme.fg("accent", "[i]")} Insert  ${theme.fg("warning", "[x]")} Dismiss`;
						lines.push(theme.fg("dim", "│") + padLine(hints, innerWidth) + theme.fg("dim", "│"));
					}
				}

				lines.push(theme.fg("dim", `│${" ".repeat(innerWidth)}│`));
			}
		}

		// Footer hints
		const footerHints = `  ${theme.fg("dim", "[Shift+X] Abort All")}${" ".repeat(Math.max(0, innerWidth - 40))}${theme.fg("dim", "[Esc] Close")}`;
		lines.push(theme.fg("dim", "│") + padLine(footerHints, innerWidth) + theme.fg("dim", "│"));
		lines.push(theme.fg("dim", `└${border}┘`));

		return lines;
	}

	invalidate(): void {
		this.refreshItems();
	}
}

function truncateLabel(label: string, maxWidth: number): string {
	if (visibleWidth(label) <= maxWidth) return label;
	return `${label.slice(0, maxWidth - 1)}…`;
}

function padLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return line;
	return line + " ".repeat(width - lineWidth);
}
