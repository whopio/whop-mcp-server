import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"in-process": "src/runtime/in-process.ts",
		"adapters/stdio": "src/adapters/stdio.ts",
		"adapters/streamable-http": "src/adapters/streamable-http.ts",
	},
	format: ["esm"],
	target: "node22",
	platform: "neutral",
	dts: true,
	sourcemap: true,
	clean: true,
});
