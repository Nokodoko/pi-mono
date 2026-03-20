/**
 * BackgroundAgentManager - Manages multiple background agent instances.
 *
 * Tracks active and completed background agents, provides status queries,
 * and emits completion events through the EventBus.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession } from "./agent-session.js";
import { BackgroundAgent, type BackgroundAgentResult, type BackgroundAgentStatus } from "./background-agent.js";
import type { EventBus } from "./event-bus.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of concurrent background agents */
const MAX_CONCURRENT_AGENTS = 3;

/** Event channel for background agent completion */
export const BACKGROUND_COMPLETE_CHANNEL = "background:complete";

/** Event channel for background agent status updates */
export const BACKGROUND_STATUS_CHANNEL = "background:status";

// ============================================================================
// BackgroundAgentManager
// ============================================================================

export class BackgroundAgentManager {
	private agents = new Map<string, BackgroundAgent>();
	private completedResults = new Map<string, BackgroundAgentResult>();
	private eventBus: EventBus;
	private completionCallbacks = new Set<(result: BackgroundAgentResult) => void>();

	constructor(eventBus: EventBus) {
		this.eventBus = eventBus;
	}

	/**
	 * Create and start a background agent from a cloned session.
	 *
	 * @param session - A cloned headless AgentSession
	 * @param promptText - The prompt text to continue executing
	 * @param label - User-visible label (truncated from prompt)
	 * @returns The background agent ID
	 * @throws Error if max concurrent agents reached
	 */
	async backgroundAgent(session: AgentSession, promptText: string, label: string): Promise<string> {
		const runningCount = this.getRunningCount();
		if (runningCount >= MAX_CONCURRENT_AGENTS) {
			throw new Error(
				`Maximum of ${MAX_CONCURRENT_AGENTS} concurrent background agents reached. ` +
					`Wait for an agent to complete or abort one first.`,
			);
		}

		const id = randomUUID().slice(0, 8);

		const agent = new BackgroundAgent({
			id,
			label,
			session,
			onComplete: (result) => {
				this.agents.delete(id);
				this.completedResults.set(id, result);
				this.eventBus.emit(BACKGROUND_COMPLETE_CHANNEL, result);
				for (const cb of this.completionCallbacks) {
					cb(result);
				}
			},
			onStatusUpdate: (status) => {
				this.eventBus.emit(BACKGROUND_STATUS_CHANNEL, status);
			},
		});

		this.agents.set(id, agent);

		// Start execution in the background (don't await)
		agent.run(promptText).catch(() => {
			// Errors are handled via onComplete callback
		});

		return id;
	}

	/** Get all active (running) background agents. */
	getActiveAgents(): BackgroundAgentStatus[] {
		return Array.from(this.agents.values()).map((a) => a.getStatus());
	}

	/** Get all completed (but not dismissed) results. */
	getCompletedResults(): BackgroundAgentResult[] {
		return Array.from(this.completedResults.values());
	}

	/** Get count of currently running agents. */
	getRunningCount(): number {
		return this.agents.size;
	}

	/** Get total count of running + completed (undismissed) agents. */
	getTotalCount(): number {
		return this.agents.size + this.completedResults.size;
	}

	/** Abort a specific background agent. */
	abort(id: string): boolean {
		const agent = this.agents.get(id);
		if (!agent) return false;
		agent.abort();
		return true;
	}

	/** Abort all running background agents. */
	abortAll(): void {
		for (const agent of this.agents.values()) {
			agent.abort();
		}
	}

	/** Dismiss a completed result (remove from completed list). */
	dismiss(id: string): boolean {
		return this.completedResults.delete(id);
	}

	/** Dismiss all completed results. */
	dismissAll(): void {
		this.completedResults.clear();
	}

	/** Subscribe to completion events. Returns unsubscribe function. */
	onCompletion(callback: (result: BackgroundAgentResult) => void): () => void {
		this.completionCallbacks.add(callback);
		return () => this.completionCallbacks.delete(callback);
	}

	/** Clean up all agents and listeners. */
	dispose(): void {
		this.abortAll();
		this.completedResults.clear();
		this.completionCallbacks.clear();
	}
}
