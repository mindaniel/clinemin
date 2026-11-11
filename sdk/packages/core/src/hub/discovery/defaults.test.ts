import { CLINE_BUILD_ENV_ENV } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_HUB_PORT as BASE_HUB_PORT,
	hubPortUserOffset,
	resolveDefaultHubPort,
	resolveHubEndpointOptions,
} from "./defaults";

const USERNAME = "alice";
const DEV_HUB_PORT = 25466 + hubPortUserOffset(USERNAME);
const DEFAULT_HUB_PORT = BASE_HUB_PORT + hubPortUserOffset(USERNAME);

describe("hubPortUserOffset", () => {
	it("gives different users different ports, the same user the same one", () => {
		expect(hubPortUserOffset("alice")).toBe(hubPortUserOffset("ALICE"));
		expect(hubPortUserOffset("alice")).not.toBe(hubPortUserOffset("bob"));
		expect(hubPortUserOffset("")).toBe(0);
	});

	it("keeps every user's ports in range and apart from other users'", () => {
		for (const name of ["alice", "bob", "qmn1", "yf43", "root"]) {
			const offset = hubPortUserOffset(name);
			expect(offset % 10).toBe(0);
			expect(25466 + offset).toBeLessThan(32768);
		}
	});
});

describe("resolveDefaultHubPort", () => {
	it("returns the dev hub port when CLINE_BUILD_ENV is development and CLINE_HUB_PORT is unset", () => {
		expect(
			resolveDefaultHubPort({
				env: { [CLINE_BUILD_ENV_ENV]: "development" },
				execArgv: [],
				username: USERNAME,
			}),
		).toBe(DEV_HUB_PORT);
	});

	it("returns the production hub port when CLINE_BUILD_ENV is production and CLINE_HUB_PORT is unset", () => {
		expect(
			resolveDefaultHubPort({
				env: { [CLINE_BUILD_ENV_ENV]: "production" },
				execArgv: [],
				username: USERNAME,
			}),
		).toBe(DEFAULT_HUB_PORT);
	});

	it("returns the production hub port when the build env cannot be determined", () => {
		expect(
			resolveDefaultHubPort({ env: {}, execArgv: [], username: USERNAME }),
		).toBe(DEFAULT_HUB_PORT);
	});

	it("treats --conditions=development as a development build", () => {
		expect(
			resolveDefaultHubPort({
				env: {},
				execArgv: ["--conditions=development"],
				username: USERNAME,
			}),
		).toBe(DEV_HUB_PORT);
	});

	it("honors an explicit CLINE_HUB_PORT override in development", () => {
		expect(
			resolveDefaultHubPort({
				env: {
					[CLINE_BUILD_ENV_ENV]: "development",
					CLINE_HUB_PORT: "31000",
				},
				execArgv: [],
				username: USERNAME,
			}),
		).toBe(31000);
	});

	it("honors an explicit CLINE_HUB_PORT override in production", () => {
		expect(
			resolveDefaultHubPort({
				env: {
					[CLINE_BUILD_ENV_ENV]: "production",
					CLINE_HUB_PORT: "31000",
				},
				execArgv: [],
				username: USERNAME,
			}),
		).toBe(31000);
	});

	it("falls back to the dev default when CLINE_HUB_PORT is invalid in development", () => {
		expect(
			resolveDefaultHubPort({
				env: {
					[CLINE_BUILD_ENV_ENV]: "development",
					CLINE_HUB_PORT: "not-a-port",
				},
				execArgv: [],
				username: USERNAME,
			}),
		).toBe(DEV_HUB_PORT);
	});

	it("falls back to the production default when CLINE_HUB_PORT is invalid in production", () => {
		expect(
			resolveDefaultHubPort({
				env: {
					[CLINE_BUILD_ENV_ENV]: "production",
					CLINE_HUB_PORT: "0",
				},
				execArgv: [],
				username: USERNAME,
			}),
		).toBe(DEFAULT_HUB_PORT);
	});
});

describe("resolveHubEndpointOptions", () => {
	it("composes the dev hub port when overrides are not provided in development", () => {
		expect(
			resolveHubEndpointOptions(
				{},
				{
					env: { [CLINE_BUILD_ENV_ENV]: "development" },
					execArgv: [],
					username: USERNAME,
				},
			),
		).toEqual({
			host: "127.0.0.1",
			port: DEV_HUB_PORT,
			pathname: "/hub",
		});
	});

	it("respects explicit port overrides regardless of build env", () => {
		expect(
			resolveHubEndpointOptions(
				{ port: 40000 },
				{
					env: { [CLINE_BUILD_ENV_ENV]: "development" },
					execArgv: [],
					username: USERNAME,
				},
			).port,
		).toBe(40000);
	});
});
