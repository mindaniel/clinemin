import { describe, expect, it } from "vitest";
import { listConnectors } from "./registry";

describe("connector registry", () => {
	it("lists the supported connectors and no Discord", () => {
		const names = listConnectors().map((connector) => connector.name);
		expect(names).toContain("telegram");
		expect(names).not.toContain("discord");
	});
});
