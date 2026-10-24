import { describe, expect, it } from "vitest";
import { estimateLoadPercent } from "./llamacpp-runtime";

// Lines as llama-server prints them at `-lv 4` (captured from b11853).
const LOG = [
	"0.00.082.547 I srv    load_model: loading model 'models/qwen.gguf'",
	"0.01.346.444 I load_tensors: loading model tensors, this can take a while... (load_mode = mmap)",
	"0.01.419.386 I load_tensors: offloaded 25/25 layers to GPU",
	"0.01.475.998 I llama_context: constructing llama_context",
	"0.01.551.351 I cmn  common_init_: warming up the model with an empty run - please wait ... (--no-warmup to disable)",
	"0.01.799.205 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 32768, kv_unified = 'true'",
	"0.01.838.089 I srv  llama_server: model loaded",
];

describe("estimateLoadPercent", () => {
	it("is 0 before llama-server has logged anything", () => {
		expect(estimateLoadPercent("")).toBe(0);
	});

	it("rises with each load stage and reaches 100 once loaded", () => {
		const seen = LOG.map((_, i) =>
			estimateLoadPercent(LOG.slice(0, i + 1).join("\n")),
		);
		expect(seen).toEqual([5, 15, 40, 50, 60, 95, 100]);
	});
});
