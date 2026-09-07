import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_PROVIDER_BROWSERS } from "./browser-profiles";

const vendorsDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * Read a vendor's source, whichever shape it is in.
 *
 * A vendor is either `<id>.ts` or a `<id>/` folder whose `config.ts` holds the
 * constants. kimi-web is the folder form; the rest are still single files, and
 * this test has to keep guarding both while that is true.
 */
function readVendorSource(providerId: string): string | undefined {
	for (const candidate of [
		path.join(vendorsDir, `${providerId}.ts`),
		path.join(vendorsDir, providerId, "config.ts"),
	]) {
		if (fs.existsSync(candidate)) {
			return fs.readFileSync(candidate, "utf-8");
		}
	}
	return undefined;
}

describe("WEB_PROVIDER_BROWSERS", () => {
	it("matches the debug port each provider actually launches on", () => {
		// The table is a copy, kept so resetting a profile does not have to import
		// seven provider modules and their Chrome launch machinery. Read the real
		// constants back so the copy cannot drift unnoticed.
		for (const browser of WEB_PROVIDER_BROWSERS) {
			const source = readVendorSource(browser.providerId);
			expect(
				source,
				`${browser.providerId} has no source file or folder`,
			).toBeDefined();
			const match = /DEFAULT_DEBUG_PORT = (\d+);/.exec(source ?? "");
			expect(
				match?.[1],
				`${browser.providerId} declares no debug port`,
			).toBeDefined();
			expect(Number(match?.[1]), browser.providerId).toBe(
				browser.defaultDebugPort,
			);
		}
	});

	it("covers every browser-driven provider", () => {
		const declared = fs
			.readdirSync(vendorsDir, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() ||
					(entry.name.endsWith(".ts") && !entry.name.includes(".test.")),
			)
			.map((entry) => entry.name.replace(/\.ts$/, ""))
			.filter((providerId) =>
				(readVendorSource(providerId) ?? "").includes("DEFAULT_DEBUG_PORT = "),
			)
			.sort();

		expect([...WEB_PROVIDER_BROWSERS.map((b) => b.providerId)].sort()).toEqual(
			declared,
		);
	});

	it("gives every provider a port of its own", () => {
		const ports = WEB_PROVIDER_BROWSERS.map((b) => b.defaultDebugPort);
		expect(new Set(ports).size).toBe(ports.length);
	});
});
