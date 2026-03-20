/**
 * Background agent support.
 *
 * A BackgroundAgent wraps a headless AgentSession that runs autonomously
 * after the user presses Ctrl+B to send the current task to the background.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";

// ============================================================================
// Types
// ============================================================================

export type BackgroundAgentState = "running" | "completed" | "error" | "aborted";

export interface BackgroundAgentStatus {
	id: string;
	label: string;
	state: BackgroundAgentState;
	startTime: number;
	/** Human-readable description of current activity */
	currentActivity?: string;
	toolCallCount: number;
	turnCount: number;
}

export interface BackgroundAgentResult {
	id: string;
	label: string;
	success: boolean;
	/** All messages produced during background execution */
	messages: AgentMessage[];
	error?: string;
	/** Duration in milliseconds */
	duration: number;
	toolCallCount: number;
	turnCount: number;
}

export interface BackgroundAgentConfig {
	id: string;
	/** User-visible label (truncated prompt text) */
	label: string;
	/** The cloned headless session to run */
	session: AgentSession;
	/** Called when the agent finishes (success, error, or abort) */
	onComplete: (result: BackgroundAgentResult) => void;
	/** Called on status changes (tool execution, turn changes) */
	onStatusUpdate: (status: BackgroundAgentStatus) => void;
}

// ============================================================================
// BackgroundAgent
// ============================================================================

export class BackgroundAgent {
	readonly id: string;
	readonly label: string;
	private session: AgentSession;
	private abortController: AbortController;
	private status: BackgroundAgentStatus;
	private startTime: number;
	private onComplete: (result: BackgroundAgentResult) => void;
	private onStatusUpdate: (status: BackgroundAgentStatus) => void;
	private unsubscribe?: () => void;
	private collectedMessages: AgentMessage[] = [];

	constructor(config: BackgroundAgentConfig) {
		this.id = config.id;
		this.label = config.label;
		this.session = config.session;
		this.abortController = new AbortController();
		this.onComplete = config.onComplete;
		this.onStatusUpdate = config.onStatusUpdate;
		this.startTime = Date.now();

		this.status = {
			id: this.id,
			label: this.label,
			state: "running",
			startTime: this.startTime,
			toolCallCount: 0,
			turnCount: 0,
		};
	}

	/**
	 * Start autonomous execution.
	 * Subscribes to agent events for status tracking, then runs the prompt.
	 * Returns when the agent completes, errors, or is aborted.
	 */
	async run(promptText: string): Promise<BackgroundAgentResult> {
		// Subscribe to events for status tracking
		this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
			this.handleEvent(event);
		});

		try {
			await this.session.prompt(promptText);

			this.status.state = "completed";
			this.onStatusUpdate({ ...this.status });

			const result = this.buildResult(true);
			this.onComplete(result);
			return result;
		} catch (err) {
			if (this.abortController.signal.aborted) {
				this.status.state = "aborted";
			} else {
				this.status.state = "error";
			}
			this.onStatusUpdate({ ...this.status });

			const result = this.buildResult(false, err instanceof Error ? err.message : String(err));
			this.onComplete(result);
			return result;
		} finally {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		}
	}

	/** Abort the background agent. */
	abort(): void {
		this.abortController.abort();
		this.session.agent.abort();
	}

	/** Get current status snapshot. */
	getStatus(): BackgroundAgentStatus {
		return { ...this.status };
	}

	private handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "turn_start":
				this.status.turnCount++;
				this.status.currentActivity = "Thinking...";
				this.onStatusUpdate({ ...this.status });
				break;

			case "tool_execution_start":
				this.status.toolCallCount++;
				this.status.currentActivity = `Running ${event.toolName}`;
				this.onStatusUpdate({ ...this.status });
				break;

			case "tool_execution_end":
				this.status.currentActivity = "Thinking...";
				this.onStatusUpdate({ ...this.status });
				break;

			case "message_end":
				this.collectedMessages.push(event.message);
				break;

			case "agent_end":
				this.status.currentActivity = undefined;
				break;
		}
	}

	private buildResult(success: boolean, error?: string): BackgroundAgentResult {
		return {
			id: this.id,
			label: this.label,
			success,
			messages: this.collectedMessages,
			error,
			duration: Date.now() - this.startTime,
			toolCallCount: this.status.toolCallCount,
			turnCount: this.status.turnCount,
		};
	}
}
