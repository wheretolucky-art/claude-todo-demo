#!/usr/bin/env node
// The reverse of pack.mjs: restores private/us/ from the sealed files in us/pack/,
// so the words and photographs can be edited again in a fresh checkout.
//
//   node tools/us/unpack.mjs <key>
//
// <key> is the part after the # in the link you shared.

import { createDecipheriv } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const priv = join(root, "private", "us");
const pack = join(root, "us", "pack");

const keyText = (process.argv[2] || "").replace(/^.*#/, "").trim();
const key = Buffer.from(keyText, "base64url");
if (key.length !== 16) {
  console.error("Usage: node tools/us/unpack.mjs <key>   (the 22 characters after the # in your link)");
  process.exit(1);
}

function open(name) {
  const buf = readFileSync(join(pack, name));
  const decipher = createDecipheriv("aes-128-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
}

const EXT = { "image/webp": ".webp", "image/jpeg": ".jpg", "image/png": ".png" };

let content;
try {
  content = JSON.parse(open("content.bin").toString("utf8"));
} catch {
  console.error("That key does not open this pack.");
  process.exit(1);
}

mkdirSync(join(priv, "photos"), { recursive: true });
const { images, ...rest } = content;
for (const [id, { file, type }] of Object.entries(images)) {
  writeFileSync(join(priv, "photos", id + EXT[type]), open(file));
}
writeFileSync(join(priv, "content.json"), JSON.stringify(rest, null, 2) + "\n");
writeFileSync(join(priv, "KEY.txt"), keyText + "\n", { mode: 0o600 });

console.log(`Restored content.json and ${Object.keys(images).length} photographs into private/us/`);
