import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing inside an injected page script may look like a module.
 *
 * Every web vendor holds a large template literal (`SEND_MESSAGE_SOURCE`)
 * containing plain browser JavaScript that is handed to Chrome via
 * `Runtime.evaluate`. It is a string to TypeScript: never parsed, never
 * typechecked, never executed by any test in this repo.
 *
 * That makes it the one place in this folder where a refactor can break a
 * provider completely and leave every check green. It has happened: splitting
 * `kimi-web.ts` into a folder involved prefixing `export` onto each top-level
 * declaration so the new modules could import each other, and the regex matched
 * the `async function` lines INSIDE the template literal too. Chrome received a
 * script with `export` at top level, threw a SyntaxError before running a line,
 * and typed nothing into the chat box. Tests, tsc, biome and the build all
 * passed. A person watching a browser do nothing found it.
 *
 * So this reads the vendor sources as text and fails on the shape of that
 * mistake. It deliberately does not parse TypeScript, because the thing it
 * guards is not parsed either.
 */

const vendorsDir = path.dirname(fileURLToPath(import.meta.url));

/** Every vendor source, single-file or folder, excluding tests. */
function vendorSources(): { file: string; source: string }[] {
	const out: { file: string; source: string }[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name), rel);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) {
				continue;
			}
			out.push({
				file: rel,
				source: fs.readFileSync(path.join(dir, entry.name), "utf-8"),
			});
		}
	};
	walk(vendorsDir, "");
	return out;
}

/**
 * The lines of each injected page script in a file.
 *
 * Anchored on the declaration and its closing line rather than on backtick
 * parity. Parity looked simpler and was wrong: a ```` ``` ```` fence inside a doc
 * comment flips it, so a first draft of this test reported fourteen offenders
 * that were all ordinary exported functions.
 */
export function injectedScriptLines(
	source: string,
): { line: number; text: string }[] {
	const lines = source.split("\n");
	const out: { line: number; text: string }[] = [];
	let inside = false;
	lines.forEach((text, index) => {
		if (!inside) {
			if (/^(export )?const [A-Z][A-Z0-9_]* = `$/.test(text)) {
				inside = true;
			}
			return;
		}
		if (text === "`;") {
			inside = false;
			return;
		}
		out.push({ line: index + 1, text });
	});
	return out;
}

describe("injected page scripts", () => {
	const sources = vendorSources();

	it("finds the vendor sources and their scripts at all", () => {
		// A guard that silently scans nothing is worse than no guard.
		expect(sources.length).toBeGreaterThan(8);
		const withScripts = sources.filter(
			({ source }) => injectedScriptLines(source).length > 0,
		);
		// chatgpt, claude, deepseek-web-v2, gemini, grok, qwen, and kimi's
		// send-script.ts. If this drops, the scanner stopped finding them and
		// every other assertion here became vacuous.
		expect(withScripts.length).toBeGreaterThanOrEqual(7);
	});

	it("carry no module syntax", () => {
		const offenders: string[] = [];
		for (const { file, source } of sources) {
			for (const { line, text } of injectedScriptLines(source)) {
				if (/^\s*(export|import)\s/.test(text)) {
					offenders.push(`${file}:${line}: ${text.trim().slice(0, 60)}`);
				}
			}
		}
		// `export` or `import` in one of these strings is not TypeScript being
		// exported — it is a SyntaxError being shipped to a browser.
		expect(offenders).toEqual([]);
	});
});
