import { describe, expect, it } from "vitest";
import {
	describeProfile,
	isValidProfileName,
	parseProfileStore,
	profileConnection,
} from "./profile";
import { parseTeamRoster } from "./roster";

const WORK: Parameters<typeof profileConnection>[0] = {
	name: "deepseek-work",
	providerId: "deepseek-web",
	browserProfile: "work",
};

describe("parseProfileStore", () => {
	it("accepts two profiles on one provider", () => {
		// The whole point: `providers.json` is keyed by provider id, so this shape
		// is the thing it cannot express.
		const parsed = parseProfileStore(
			JSON.stringify({
				version: 1,
				profiles: [
					{
						name: "deepseek-work",
						providerId: "deepseek-web",
						browserProfile: "work",
					},
					{
						name: "deepseek-personal",
						providerId: "deepseek-web",
						browserProfile: "personal",
					},
				],
			}),
		);
		expect(parsed.ok).toBe(true);
	});

	it("rejects two profiles with the same name", () => {
		const parsed = parseProfileStore(
			JSON.stringify({
				version: 1,
				profiles: [
					{ name: "same", providerId: "a" },
					{ name: "same", providerId: "b" },
				],
			}),
		);
		expect(parsed.ok).toBe(false);
	});

	it("reports a bad file instead of throwing", () => {
		const parsed = parseProfileStore("{ not json");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.error).toContain("profiles.json");
		}
	});

	it("rejects an unknown key rather than ignoring it", () => {
		// Strict for the same reason the roster is: a typo that silently falls
		// back to the shared credential is invisible until two workers collide.
		const parsed = parseProfileStore(
			JSON.stringify({
				version: 1,
				profiles: [{ name: "x", providerId: "a", browserProfil: "work" }],
			}),
		);
		expect(parsed.ok).toBe(false);
	});
});

describe("isValidProfileName", () => {
	it("takes the same characters an agentId does", () => {
		expect(isValidProfileName("deepseek-work")).toBe(true);
		expect(isValidProfileName("work account")).toBe(false);
		expect(isValidProfileName("")).toBe(false);
	});
});

describe("profileConnection", () => {
	it("omits what the profile does not set, so inherited values survive", () => {
		// Spread over an inherited config: writing `apiKey: undefined` here would
		// erase the key `providers.json` supplied.
		const connection = profileConnection(WORK);
		expect(connection).toEqual({
			providerId: "deepseek-web",
			browserProfile: "work",
		});
		expect("apiKey" in connection).toBe(false);
		expect("modelId" in connection).toBe(false);
	});

	it("carries every field the profile does set", () => {
		const connection = profileConnection({
			name: "proxy",
			providerId: "anthropic",
			modelId: "claude-sonnet-4.6",
			apiKey: "placeholder-key",
			baseUrl: "https://proxy.example.com",
			temperature: 0.2,
		});
		expect(connection.modelId).toBe("claude-sonnet-4.6");
		expect(connection.apiKey).toBe("placeholder-key");
		expect(connection.baseUrl).toBe("https://proxy.example.com");
		expect(connection.temperature).toBe(0.2);
	});
});

describe("describeProfile", () => {
	it("says a key exists without printing it", () => {
		const described = describeProfile({
			name: "proxy",
			providerId: "anthropic",
			apiKey: "placeholder-must-not-be-printed",
		});
		expect(described).toContain("own key");
		expect(described).not.toContain("placeholder-must-not-be-printed");
	});

	it("names the Chrome login, which is what tells two profiles apart", () => {
		expect(describeProfile(WORK)).toContain("chrome:work");
	});
});

describe("the roster's profile field", () => {
	it("is accepted on a worker", () => {
		const parsed = parseTeamRoster(
			JSON.stringify({
				version: 1,
				workers: [
					{ agentId: "a", rolePrompt: "read", profile: "deepseek-work" },
					{ agentId: "b", rolePrompt: "read", profile: "deepseek-personal" },
				],
			}),
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.roster.workers[0]?.profile).toBe("deepseek-work");
		}
	});

	it("still accepts a roster written before profiles existed", () => {
		const parsed = parseTeamRoster(
			JSON.stringify({
				version: 1,
				workers: [{ agentId: "a", rolePrompt: "read", providerId: "qwen-web" }],
			}),
		);
		expect(parsed.ok).toBe(true);
	});
});
