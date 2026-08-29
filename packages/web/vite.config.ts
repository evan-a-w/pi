import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [preact()],
	server: {
		proxy: {
			"/ws": { target: "http://localhost:4464", ws: true },
			"/theme": { target: "http://localhost:4464" },
			"/themes": { target: "http://localhost:4464" },
		},
	},
	build: {
		outDir: "dist",
		target: "es2022",
	},
});
