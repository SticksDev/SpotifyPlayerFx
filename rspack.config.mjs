// Two bundles:
//   dist/playerfx.js        the Spicetify extension (visualizer behind the player bar)
//   dist/playerfx/index.js  the Player FX page, a Spicetify custom app, plus its manifest
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";

const root = path.dirname(fileURLToPath(import.meta.url));

const swc = {
	test: /\.[jt]sx?$/,
	exclude: /node_modules/,
	loader: "builtin:swc-loader",
	options: {
		jsc: {
			parser: { syntax: "typescript", tsx: true },
			// JSX compiles to h(...) from src/lib/jsx.ts, which wraps Spotify's React.
			transform: { react: { runtime: "classic", pragma: "h", pragmaFrag: "Fragment" } },
			target: "es2022",
		},
	},
	type: "javascript/auto",
};

// CSS is imported as a string and injected by the code itself.
const css = { test: /\.css$/, type: "asset/source" };

const shared = {
	mode: "production",
	target: ["web", "es2022"],
	devtool: false,
	module: { rules: [swc, css] },
	resolve: { extensions: [".ts", ".tsx", ".js"] },
	optimization: {
		// Small either way, and readable output is easier to debug inside Spotify.
		minimize: false,
		splitChunks: false,
		runtimeChunk: false,
	},
};

export default defineConfig([
	{
		...shared,
		name: "extension",
		entry: { playerfx: path.join(root, "src/extension/index.ts") },
		output: {
			path: path.join(root, "dist"),
			filename: "[name].js",
			iife: true,
		},
	},
	{
		...shared,
		name: "page",
		entry: { index: path.join(root, "src/app/index.tsx") },
		output: {
			path: path.join(root, "dist/playerfx"),
			filename: "[name].js",
			iife: true,
		},
		plugins: [
			new rspack.CopyRspackPlugin({
				patterns: [{ from: path.join(root, "src/app/manifest.json"), to: "manifest.json" }],
			}),
		],
	},
]);
