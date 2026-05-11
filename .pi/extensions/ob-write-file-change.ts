/**
 * OpenBrain File Change Extension
 *
 * tool_result hook (write/edit): records file modifications as observation
 * entries in OB. Fire-and-forget: the HTTP POST runs asynchronously.
 *
 * Port of: openbrain/hooks/go/cmd/ob-write-file-change/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type WriteRequest,
	loadConfig,
	obWrite,
	projectFromPath,
} from "./ob-client.js";

export default function obWriteFileChangeExtension(pi: ExtensionAPI) {
	pi.on("tool_result", async (event, _ctx) => {
		// Only track write and edit tool results.
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const cfg = loadConfig(2000);
		const host = cfg.hostName;

		// Extract file path from tool input.
		const filePath = (event.input as { path?: string }).path ?? "unknown";
		const toolName = event.toolName;
		const project = projectFromPath(filePath);

		const content = `pi modified ${filePath} via ${toolName} in project ${project} on host ${host}`;

		const wr: WriteRequest = {
			item_type: "observation",
			raw_content: content,
			priority: 1,
			entities: {
				tags: [
					"file_change",
					`tool:${toolName}`,
					`project:${project}`,
					`host:${host}`,
					`file:${filePath}`,
					"agent:pi",
					"source:pi",
				],
			},
		};

		// Fire-and-forget: don't await or block the session.
		void obWrite(cfg, wr);
	});
}
