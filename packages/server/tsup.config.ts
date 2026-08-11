import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"adapters/stdio": "src/adapters/stdio.ts",
		"adapters/streamable-http": "src/adapters/streamable-http.ts",
		"adapters/sse": "src/adapters/sse.ts",
	},
	format: ["esm"],
	target: "node22",
	platform: "neutral",
	dts: true,
	sourcemap: true,
	clean: true,
});
