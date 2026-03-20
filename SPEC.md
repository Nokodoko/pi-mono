# SPEC: Background Agent Support

## 1. Overview

Add job-control-style background agent support to Pi. Users can press Ctrl+B while an agent is running to send it to the background, then continue chatting or launch additional agents. Background agents run autonomously and notify the main thread when complete.

## 2. Motivation

Currently, Pi blocks the main conversation thread while an agent processes a request. Users cannot interact with the system until the agent completes. This is a productivity bottleneck for long-running tasks. Claude Code already supports this pattern (Ctrl+B to background, status indicators, async result integration), and Pi needs parity.

## 3. Goals

- Users can background a running agent with Ctrl+B
- Multiple background agents can run simultaneously
- The main thread remains fully interactive while agents run in the background
- UI clearly indicates active background agents (count, status)
- Background agents notify the main thread upon completion
- Tool permissions are pre-prompted before backgrounding
- Results integrate cleanly into the conversation history

## 4. Non-Goals

- Process-level forking (agents run as async tasks in the same Node.js process)
- Background agents running across Pi restarts (session persistence of background state)
- Background agents with their own independent TUI
- Remote/distributed agent execution

## 5. Architecture

### 5.1 Component Overview

```
InteractiveMode (TUI layer)
  |
  +-- BackgroundAgentManager (NEW)
  |     |
  |     +-- BackgroundAgent[] (NEW)
  |           |
  |           +-- AgentSession (cloned, headless)
  |           +-- AbortController
  |           +-- EventEmitter (status updates)
  |
  +-- BackgroundStatusBar (NEW, UI component)
  +-- BackgroundAgentPanel (NEW, overlay)
  +-- FooterComponent (extended)
```

### 5.2 Key Design Decisions

1. **Same-process async model**: Background agents are `Promise`-based tasks running in the same Node.js event loop. No child processes or workers. This is the same model Claude Code uses.

2. **Cloned AgentSession**: When backgrounding, the current `AgentSession` state is snapshotted. A new headless `AgentSession` is created for the background task, forking from the current conversation state. The main thread gets a fresh session state for continued interaction.

3. **Event-driven completion**: Background agents emit events through the `EventBus` when they complete. The main thread's event loop picks these up during idle periods (between user inputs).

4. **Shared tool registry**: Background agents share the same tool registry and extension runner as the main session. Tool execution is serialized where necessary (e.g., file writes) via the existing `beforeToolCall` hooks.

## 6. Detailed Design

### 6.1 BackgroundAgent

```typescript
// packages/coding-agent/src/core/background-agent.ts

export interface BackgroundAgentConfig {
  id: string;
  label: string;                    // User-visible name (truncated prompt)
  session: AgentSession;            // Cloned headless session
  abortController: AbortController;
  onComplete: (result: BackgroundAgentResult) => void;
  onStatusUpdate: (status: BackgroundAgentStatus) => void;
}

export interface BackgroundAgentStatus {
  id: string;
  label: string;
  state: 'running' | 'completed' | 'error' | 'aborted';
  startTime: number;
  currentActivity?: string;        // e.g., "Running bash command", "Writing file"
  toolCallCount: number;
  turnCount: number;
}

export interface BackgroundAgentResult {
  id: string;
  label: string;
  success: boolean;
  messages: AgentMessage[];         // All messages produced during background execution
  error?: string;
  duration: number;                 // ms
  toolCallCount: number;
  turnCount: number;
}

export class BackgroundAgent {
  readonly id: string;
  private session: AgentSession;
  private abortController: AbortController;
  private status: BackgroundAgentStatus;
  private startTime: number;
  private onComplete: (result: BackgroundAgentResult) => void;
  private onStatusUpdate: (status: BackgroundAgentStatus) => void;

  constructor(config: BackgroundAgentConfig) { ... }

  /** Start autonomous execution. Returns when agent completes or is aborted. */
  async run(): Promise<BackgroundAgentResult> { ... }

  /** Abort the background agent. */
  abort(): void {
    this.abortController.abort();
  }

  /** Get current status snapshot. */
  getStatus(): BackgroundAgentStatus { ... }
}
```

### 6.2 BackgroundAgentManager

```typescript
// packages/coding-agent/src/core/background-agent-manager.ts

export class BackgroundAgentManager {
  private agents: Map<string, BackgroundAgent> = new Map();
  private eventBus: EventBus;
  private completionCallbacks: Set<(result: BackgroundAgentResult) => void> = new Set();

  constructor(eventBus: EventBus) { ... }

  /** Background the current running agent. Returns the background agent ID. */
  async backgroundCurrentAgent(
    session: AgentSession,
    label: string
  ): Promise<string> { ... }

  /** Get all active background agents. */
  getActiveAgents(): BackgroundAgentStatus[] { ... }

  /** Get count of running agents. */
  getRunningCount(): number { ... }

  /** Abort a specific background agent. */
  abort(id: string): void { ... }

  /** Abort all background agents. */
  abortAll(): void { ... }

  /** Subscribe to completion events. */
  onCompletion(callback: (result: BackgroundAgentResult) => void): () => void { ... }

  /** Clean up completed agents older than threshold. */
  pruneCompleted(maxAgeMs?: number): void { ... }
}
```

### 6.3 Keybinding: Ctrl+B

Add `"background"` to the `AppAction` type in `keybindings.ts`:

```typescript
// In packages/coding-agent/src/core/keybindings.ts

export type AppAction =
  | "interrupt"
  | "clear"
  | "exit"
  | "suspend"
  | "background"          // NEW
  | "cycleThinkingLevel"
  // ... rest unchanged

export const DEFAULT_APP_KEYBINDINGS: Record<AppAction, KeyId | KeyId[]> = {
  // ... existing
  background: "ctrl+b",   // NEW
  // ...
};
```

Register the handler in `InteractiveMode.setupEditorHandlers()`:

```typescript
this.defaultEditor.onAction("background", () => this.handleBackground());
```

### 6.4 Background Flow

When the user presses Ctrl+B while an agent is streaming:

1. **Pre-prompt tool permissions**: Before backgrounding, check which tools the agent has access to. Show a brief confirmation: "Background this agent? It has access to: bash, edit, write [Y/n]"
2. **Snapshot state**: Clone the current `AgentSession` state (messages, model, tools, system prompt)
3. **Create headless session**: Instantiate a new `AgentSession` with the cloned state, but no UI bindings
4. **Transfer streaming**: The in-flight LLM stream is transferred to the background agent. The current `agent.prompt()` call continues in the background context.
5. **Reset main thread**: The main `InteractiveMode` gets a fresh prompt state. The editor is re-enabled for input.
6. **Background execution**: The background agent continues autonomously, executing tool calls and LLM turns until the task completes.

### 6.5 Stream Transfer Mechanism

The critical piece is transferring the in-flight agent loop to the background. Two approaches:

**Option A: Abort + Replay (Simpler, Recommended)**
1. Abort the current agent loop via `AbortController`
2. Capture all messages accumulated so far
3. Create a new `AgentSession` with those messages
4. Call `agent.prompt()` on the new session to continue from where it left off
5. The LLM will see the full context and continue naturally

**Option B: Promise Transfer (Complex)**
1. Detach the event listener from the current session
2. Attach a headless event listener
3. Let the existing `prompt()` promise continue resolving in the background
4. This requires careful handling of shared mutable state

**Recommendation**: Option A. The LLM call is cheap relative to the overall task, and it guarantees clean state separation. The replay adds one extra LLM call but avoids complex state transfer bugs.

### 6.6 Tool Permission Pre-Prompting

Before sending an agent to the background, display the active tools and require confirmation:

```
Background this agent?
Active tools: bash, edit, write, read, glob, grep
The agent will continue autonomously with these permissions.
[Enter] to confirm, [Esc] to cancel
```

This uses the existing overlay mechanism (`this.ui.showOverlay()`). The confirmation is mandatory — no way to skip it.

### 6.7 UI Components

#### 6.7.1 BackgroundStatusBar

A persistent component rendered above the editor (in `widgetContainerAbove`) when background agents are active:

```
 ↓ 2 background agents running (↓ to manage)
```

Clicking/pressing ↓ (down arrow with Alt, or a dedicated key) opens the management panel.

```typescript
// packages/coding-agent/src/modes/interactive/components/background-status-bar.ts

export class BackgroundStatusBar implements Component {
  constructor(
    private manager: BackgroundAgentManager,
    private onManage: () => void
  ) {}

  render(width: number): string[] {
    const count = this.manager.getRunningCount();
    if (count === 0) return [];
    const label = count === 1 ? 'agent' : 'agents';
    return [theme.fg('accent', ` ↓ ${count} background ${label} running (↓ to manage)`)];
  }
}
```

#### 6.7.2 BackgroundAgentPanel

An overlay panel (shown via `ui.showOverlay()`) for managing background agents:

```
┌─ Background Agents ───────────────────────┐
│                                            │
│  1. "Fix the login bug" - Running (2m 15s) │
│     ↳ Executing bash command               │
│     [Abort]                                │
│                                            │
│  2. "Write tests for auth" - Running (45s) │
│     ↳ Writing file                         │
│     [Abort]                                │
│                                            │
│  3. "Refactor utils" - Completed (5m 22s)  │
│     ↳ 12 tool calls, 8 turns              │
│     [View Results] [Dismiss]               │
│                                            │
│  [Abort All]                    [Esc] Close │
└────────────────────────────────────────────┘
```

#### 6.7.3 Footer Integration

Extend the existing `FooterComponent` to show background agent count on line 3 (or as an extension status):

```
n0ko | [claude-opus-4 (1M context)] [████░░░░] 42% | $0.1234
~/Programs/pi-mono (feat/bg-agents) • session-abc
⬡ 2 background agents
```

### 6.8 Completion Notification

When a background agent completes:

1. **Event emission**: The `BackgroundAgentManager` emits a completion event through the `EventBus`
2. **Main thread pickup**: `InteractiveMode` listens for completion events and shows an inline notification:

```
┌─ Background Agent Completed ─────────────────┐
│ "Fix the login bug" completed in 5m 22s       │
│ 12 tool calls, 8 turns                        │
│ [View Results] [Insert into Chat] [Dismiss]   │
└───────────────────────────────────────────────┘
```

3. **Result integration**: "Insert into Chat" adds a summary message to the current conversation as a custom message:

```typescript
{
  role: "custom",
  type: "background_agent_result",
  content: {
    label: "Fix the login bug",
    summary: "Made 12 tool calls across 8 turns...",
    messages: [...], // Full message history available on expansion
  }
}
```

### 6.9 Async Messaging (Wake-up)

Background agents can "wake up" the main thread when they need attention. This uses the existing `EventBus`:

```typescript
// Background agent emits:
eventBus.emit('background:attention', {
  agentId: 'abc-123',
  reason: 'permission_needed',
  message: 'Background agent needs to create a new file outside the project'
});

// Main thread listens:
eventBus.on('background:attention', (data) => {
  this.showBackgroundAttentionOverlay(data);
});
```

For v1, background agents run with pre-approved permissions and do not request additional permissions mid-run. The attention mechanism is reserved for future use (e.g., asking the user a question).

## 7. Session Persistence

Background agent results are persisted to the session file as custom entries:

```typescript
export interface BackgroundAgentEntry extends SessionEntryBase {
  type: "background_agent";
  label: string;
  status: 'completed' | 'error' | 'aborted';
  duration: number;
  toolCallCount: number;
  turnCount: number;
  messages: AgentMessage[];
}
```

This allows reviewing background agent results when resuming a session.

## 8. Extension Integration

Background agents interact with the extension system:

- **Extension events**: `background_start`, `background_end` events are emitted through the `ExtensionRunner`
- **Extension status**: Extensions can show status for background agents via `ctx.ui.setStatus()`
- **Tool hooks**: `beforeToolCall` and `afterToolCall` hooks apply to background agent tool calls too

## 9. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Background during compaction | Block — show "Cannot background during compaction" |
| Background with no active agent | Ignore Ctrl+B, no-op |
| Multiple agents writing same file | Serialized via `beforeToolCall` hook. Last writer wins. |
| Background agent hits context overflow | Auto-compact in background, retry. If fails, mark as error. |
| User exits Pi with active background agents | Show confirmation: "2 background agents still running. Exit anyway?" Aborting sends abort signal. |
| Background agent encounters auth error | Mark as error, notify main thread |
| Session switch with active background agents | Background agents continue. They belong to the original session. Switching back shows their results. |

## 10. Implementation Plan

### Phase 1: Core Infrastructure (unix-coder track 1)
1. Create `BackgroundAgent` class (`packages/coding-agent/src/core/background-agent.ts`)
2. Create `BackgroundAgentManager` class (`packages/coding-agent/src/core/background-agent-manager.ts`)
3. Add `"background"` to `AppAction` type and default keybindings
4. Add `BackgroundAgentResult` and `BackgroundAgentStatus` types
5. Add `BackgroundAgentEntry` to session manager types

### Phase 2: Agent Session Cloning (unix-coder track 1, continued)
1. Add `AgentSession.clone()` method for creating headless copies
2. Add `AgentSession.runHeadless()` for autonomous execution without UI
3. Implement abort-and-replay stream transfer (Option A from 6.5)

### Phase 3: UI Components (unix-coder track 2, parallel with Phase 2)
1. Create `BackgroundStatusBar` component
2. Create `BackgroundAgentPanel` overlay component
3. Create completion notification component
4. Extend `FooterComponent` to show background agent count
5. Add background agent result message component for chat history

### Phase 4: Integration (unix-coder track 3, after Phases 1-2)
1. Wire `Ctrl+B` handler in `InteractiveMode`
2. Implement tool permission pre-prompting overlay
3. Wire completion notifications to main thread
4. Add session persistence for background agent entries
5. Handle exit confirmation with active background agents

### Phase 5: Polish (unix-coder track 4, after Phase 4)
1. Add `/background` slash command for listing/managing background agents
2. Add keyboard shortcut hints to header
3. Add background agent status to extension API
4. Test edge cases (compaction, auth errors, multiple agents, exit)

## 11. File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `packages/coding-agent/src/core/background-agent.ts` | BackgroundAgent class |
| `packages/coding-agent/src/core/background-agent-manager.ts` | Manager for multiple background agents |
| `packages/coding-agent/src/modes/interactive/components/background-status-bar.ts` | Status bar UI component |
| `packages/coding-agent/src/modes/interactive/components/background-agent-panel.ts` | Management overlay |
| `packages/coding-agent/src/modes/interactive/components/background-notification.ts` | Completion notification |
| `packages/coding-agent/src/modes/interactive/components/background-result-message.ts` | Chat history component |

### Modified Files
| File | Changes |
|------|---------|
| `packages/coding-agent/src/core/keybindings.ts` | Add `background` action, `ctrl+b` binding |
| `packages/coding-agent/src/core/agent-session.ts` | Add `clone()`, `runHeadless()` methods |
| `packages/coding-agent/src/core/session-manager.ts` | Add `BackgroundAgentEntry` type |
| `packages/coding-agent/src/core/event-bus.ts` | No changes needed (already generic) |
| `packages/coding-agent/src/core/slash-commands.ts` | Add `/background` command |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Wire Ctrl+B, status bar, completion handling, exit confirmation |
| `packages/coding-agent/src/modes/interactive/components/footer.ts` | Show background agent count |

## 12. Testing Strategy

- **Unit tests**: `BackgroundAgent`, `BackgroundAgentManager` — lifecycle, abort, completion events
- **Integration tests**: End-to-end background flow with mock agent
- **Manual tests**: Ctrl+B during streaming, multiple background agents, exit with active agents, session resume with background results

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Memory pressure from multiple agents | High context = high memory | Limit concurrent background agents (default: 3) |
| Race conditions on shared state | Data corruption | Each background agent gets a cloned session; no shared mutable state |
| LLM API rate limits | Background agents competing for API quota | Sequential API calls across all agents (shared semaphore) |
| Tool conflicts (file writes) | Conflicting edits | `beforeToolCall` hook can serialize file operations |

## 14. Feasibility Review Notes

**Confirmed feasible based on codebase analysis:**

1. **Agent cloning**: The `Agent` class (`packages/agent/src/agent.ts`) stores state in a plain `AgentState` object that can be shallow-copied. The `AgentSession` already has a `fork()` method (line 2670) that demonstrates session branching — background cloning follows the same pattern but without creating a new session file.

2. **Abort mechanism**: `Agent` already has `abort()` (line 374) using `AbortController`, and `waitForIdle()` (line 378) for waiting on completion. The abort-and-replay approach (Option A) is cleanly supported.

3. **Keybinding system**: `AppAction` type and `DEFAULT_APP_KEYBINDINGS` in `keybindings.ts` are designed for extension. Adding `"background": "ctrl+b"` follows the established pattern exactly.

4. **UI components**: The `widgetContainerAbove` / `widgetContainerBelow` containers in `InteractiveMode` (line 224-225) are perfect for the status bar. The overlay system (`ui.showOverlay()`) handles the management panel.

5. **Event bus**: The existing `EventBus` (event-bus.ts) is generic and supports arbitrary channels. No changes needed.

6. **Footer extension**: `FooterDataProvider` already supports `setExtensionStatus()` for dynamic status lines. Background agent count can use this directly.

**Key risk identified**: The `Agent.prompt()` method (line 395) throws if called while streaming. The background clone must ensure streaming state is properly reset before `prompt()` is called on the new agent instance. The abort-and-replay approach handles this naturally since aborting sets `isStreaming = false`.

**Concurrency concern**: Multiple background agents will make concurrent LLM API calls. A semaphore (max concurrency limiter) should be added to prevent rate limiting. Recommend max 2 concurrent API calls across all agents.

## 15. Success Criteria

1. User can press Ctrl+B during a running agent to send it to the background
2. The main thread becomes immediately interactive after backgrounding
3. UI shows count and status of background agents
4. Background agents complete autonomously and notify the user
5. Results can be viewed and optionally inserted into the conversation
6. Tool permissions are confirmed before backgrounding
7. Graceful handling of exit with active background agents
8. No shared mutable state between main and background sessions
