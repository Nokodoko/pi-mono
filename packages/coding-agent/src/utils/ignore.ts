import { existsSync, readFileSync } from "fs";
import ignore from "ignore";
import { join, relative, sep } from "path";

export const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type IgnoreMatcher = ReturnType<typeof ignore>;

export function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * Add ignore rules from .gitignore/.ignore/.fdignore files found in dir,
 * prefixing patterns relative to rootDir for correct subtree matching.
 */
export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

/**
 * Build an ignore matcher for a flat directory (no recursive prefix logic needed).
 * Loads rules from all ignore files found in dir.
 */
export function buildIgnoreMatcher(dir: string): IgnoreMatcher {
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);
	return ig;
}
