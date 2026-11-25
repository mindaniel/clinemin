import { describe, expect, it } from "vitest";
import { parseChathubFrame } from "./capture";

const RS = "\u001e";
const update = (arg: object) =>
	JSON.stringify({ type: 1, target: "update", arguments: [arg] }) + RS;

describe("parseChathubFrame", () => {
	it("takes the bot reply and skips progress lines", () => {
		const info = parseChathubFrame(
			update({
				messages: [
					{ author: "user", text: "hi" },
					{
						author: "bot",
						text: "Looking into it",
						contentType: "EarlyProgress",
					},
					{ author: "bot", text: "```py\nprint(1)\n```" },
				],
				throttling: {
					maxNumUserMessagesInConversation: 600,
					numUserMessagesInConversation: 4,
				},
			}),
		);
		expect(info.text).toBe("```py\nprint(1)\n```");
		expect(info.throttling?.numUserMessagesInConversation).toBe(4);
		expect(info.done).toBe(false);
	});

	it("ends the turn on the last update or a completion", () => {
		expect(parseChathubFrame(update({ isLastUpdate: true })).done).toBe(true);
		expect(
			parseChathubFrame(JSON.stringify({ type: 3, invocationId: "0" }) + RS)
				.done,
		).toBe(true);
	});

	it("reports an error completion", () => {
		const info = parseChathubFrame(
			JSON.stringify({ type: 3, invocationId: "0", error: "boom" }) + RS,
		);
		expect(info).toMatchObject({ done: true, error: "boom" });
	});
});

describe("parseChathubFrame daily limit", () => {
	it("reads the notice off a failed turn's result", () => {
		const frame = `${JSON.stringify({
			type: 2,
			invocationId: "0",
			item: {
				turnState: "Failed",
				messages: [
					{ author: "user", text: "batch" },
					{
						author: "bot",
						text: "You've reached your daily limit. Get more usage now or check back at 12:00 AM.",
						turnState: "Failed",
					},
				],
			},
		})}\u001e`;
		expect(parseChathubFrame(frame).text).toContain("daily limit");
	});
});
