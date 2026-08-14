import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: !watch,
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching Opencodex…");
} else {
  await esbuild.build(options);
}
