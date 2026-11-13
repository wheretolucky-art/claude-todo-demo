#!/usr/bin/env node
// Builds one self-contained HTML file from us/: the scripts, styles, fonts,
// favicon and the sealed pack are all inlined, so the file works on its own
// (for example as a WhatsApp attachment) with no server.
//
//   node tools/us/build-html.mjs
//
// Writes dist/a-little-place-called-us.html. Run tools/us/pack.mjs first if
// the content has changed. The key is not inside the file; it travels
// separately, and the page asks for it when it is not in the address.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const us = join(root, "us");
const out = join(root, "dist", "a-little-place-called-us.html");

const MIME = { ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const b64 = (path) => readFileSync(path).toString("base64");
const dataUri = (path) => `data:${MIME[extname(path)]};base64,${b64(path)}`;

// 1. Bundle the modules into one classic script.
const js = execFileSync(
  "npx",
  ["--yes", "esbuild@0.24.0", join(us, "assets/js/app.js"), "--bundle", "--format=iife", "--minify", "--target=es2020"],
  { cwd: root, maxBuffer: 64 << 20 },
).toString("utf8");

// 2. Styles, with the fonts and grain texture inlined.
const css = readFileSync(join(us, "assets/css/main.css"), "utf8")
  .replace(/url\("\.\.\/(fonts|img)\/([^"]+)"\)/g, (_, dir, file) => `url("${dataUri(join(us, "assets", dir, file))}")`);

// 3. The sealed pack, keyed by its opaque file names.
const pack = {};
for (const file of readdirSync(join(us, "pack"))) pack[file] = b64(join(us, "pack", file));

// 4. Assemble the page from the shell, swapping external references for inline ones.
const once = (s, from, to) => {
  if (!s.includes(from)) throw new Error("build: could not find " + from.slice(0, 60));
  return s.replace(from, () => to);
};
let html = readFileSync(join(us, "index.html"), "utf8");
html = html.replace(/\s*<link rel="preload"[^>]*>/g, "");
html = html.replace(/<link rel="icon"[^>]*>/, () => `<link rel="icon" href="${dataUri(join(us, "favicon.svg"))}" type="image/svg+xml">`);
html = once(html, '<link rel="stylesheet" href="assets/css/main.css">', `<style>${css}</style>`);
html = once(
  html,
  '<script type="module" src="assets/js/app.js"></script>',
  `<script>window.__US_PACK=${JSON.stringify(pack)};</script>\n  <script>${js.replace(/<\/script/gi, "<\\/script")}</script>`,
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`Wrote ${out} (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB)`);
