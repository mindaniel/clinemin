import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_PROVIDER_BROWSERS } from "./browser-profiles";

const vendorsDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("WEB_PROVIDER_BROWSERS", () => {
	it("matches the debug port each provider actually launches on", () => {
		// The table is a copy, kept so resetting a profile does not have to import
		// seven provider modules and their Chrome launch machinery. Read the real
		// constants back so the copy cannot drift unnoticed.
		for (const browser of WEB_PROVIDER_BROWSERS) {
			const source = fs.readFileSync(
				path.join(vendorsDir, `${browser.providerId}.ts`),
				"utf-8",
			);
			const match = /const DEFAULT_DEBUG_PORT = (\d+);/.exec(source);
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
			.readdirSync(vendorsDir)
			.filter((file) => file.endsWith(".ts") && !file.includes(".test."))
			.filter((file) =>
				fs
					.readFileSync(path.join(vendorsDir, file), "utf-8")
					.includes("const DEFAULT_DEBUG_PORT = "),
			)
			.map((file) => file.replace(/\.ts$/, ""))
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
