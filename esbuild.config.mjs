import esbuild from "esbuild";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { copyFileSync, mkdirSync } from "fs";
import { addonOptions } from "./scripts/lifecycle.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes("--watch");
const isDeploy = process.argv.includes("--deploy");

const outfile = path.resolve(__dirname, "dist/liquid-lyrics.js");
// Release copy in the repo root: this is the file the Spicetify Marketplace installs.
const releaseFile = path.resolve(__dirname, "liquid-lyrics.js");

const buildOptions = addonOptions({
  entry: path.resolve(__dirname, "src/app.ts"),
  outfile,
  runtime: path.resolve(__dirname, "src/lifecycle/runtime.ts"),
  globals: /^(__liquidLyrics|liquidLyrics)|^(__ll|LiquidLyrics|lenis|lenisVersion)$/,
  platform: "browser",
  target: "es2020",
  alias: {
    "@": path.resolve(__dirname, "src"),
  },
  loader: {
    ".css": "text",
    ".svg": "text",
  },
  define: {
    "process.env.NODE_ENV": '"production"',
    AROMANIZE_EXTEND_STRING: "false",
  },
  minify: !isWatch,
});

function spicetifyConfigDir() {
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(roaming, "spicetify");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "spicetify");
}

function deployToSpicetify() {
  const destDir = path.join(spicetifyConfigDir(), "Extensions");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(outfile, path.join(destDir, path.basename(outfile)));
  console.log(`Deployed to: ${destDir}`);
  console.log("Run: spicetify config extensions liquid-lyrics.js && spicetify apply");
}

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  copyFileSync(outfile, releaseFile);
  console.log("Build complete: dist/liquid-lyrics.js (copied to ./liquid-lyrics.js)");
  if (isDeploy) deployToSpicetify();
}
