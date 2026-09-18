import { describe, expect, it } from "vitest";
import { consumeChatGPTSse } from "./sse";

function parse(body: string): string {
	let text = "";
	consumeChatGPTSse(
		body,
		(chunk) => {
			text += chunk;
		},
		() => {},
		(err) => {
			throw err;
		},
	);
	return text;
}

function event(data: unknown): string {
	return `event: delta\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("consumeChatGPTSse", () => {
	it("keeps patch batches that inherit the patch op (delta encoding v1)", () => {
		// Shape captured from chatgpt.com: only the first batch names
		// `o: "patch"`; the rest are bare `{ v: [...] }`. The reply used to stop
		// at "Yes." because those later batches were ignored.
		const citation = {
			p: "/message/metadata/conversation_context_citation_metadata/0/citation_uuid",
			o: "replace",
			v: "49f268e9",
		};
		const body = [
			'event: delta_encoding\ndata: "v1"\n\n',
			event({
				o: "patch",
				v: [
					{ p: "/message/content/parts/0", o: "append", v: "Yes." },
					citation,
				],
			}),
			event({
				v: [
					{
						p: "/message/content/parts/0",
						o: "append",
						v: " Run this:\n\n```powershell\nGet-ChildItem\n```",
					},
					citation,
				],
			}),
			event({
				v: [
					{ p: "/message/content/parts/0", o: "append", v: "\n\nPaste it." },
					{ p: "/message/status", o: "replace", v: "finished_successfully" },
				],
			}),
			"data: [DONE]\n\n",
		].join("");

		expect(parse(body)).toBe(
			"Yes. Run this:\n\n```powershell\nGet-ChildItem\n```\n\nPaste it.",
		);
	});

	it("still appends bare string deltas", () => {
		const body = [
			event({ p: "/message/content/parts/0", o: "append", v: "Hello" }),
			event({ v: " world" }),
		].join("");
		expect(parse(body)).toBe("Hello world");
	});
});
