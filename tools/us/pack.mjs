#!/usr/bin/env node
// Seals the private material (letters, memories, photographs) into us/pack/
// so that the public repository only ever holds ciphertext.
//
//   node tools/us/pack.mjs
//
// Reads   private/us/content.json   – every word shown on the site
//         private/us/photos/*       – web-ready photographs (webp / jpg / png)
//         private/us/KEY.txt        – the key (created on first run)
// Writes  us/pack/*.bin             – AES-128-GCM encrypted, safe to commit
//
// The key is never written inside us/. It travels only in the link you share:
//   https://…/us/#<key>

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const priv = join(root, "private", "us");
const out = join(root, "us", "pack");
const keyFile = join(priv, "KEY.txt");

const TYPES = { ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

function loadKey() {
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, randomBytes(16).toString("base64url") + "\n", { mode: 0o600 });
    console.log("Created a new key in private/us/KEY.txt");
  }
  const text = readFileSync(keyFile, "utf8").trim();
  const key = Buffer.from(text, "base64url");
  if (key.length !== 16) throw new Error("KEY.txt must hold 16 bytes, base64url encoded (22 characters).");
  return { text, key };
}

function seal(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", key, iv);
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

// Opaque file names, so nothing about a photograph leaks from its name.
const opaque = (key, id) => createHash("sha256").update(key).update(id).digest("hex").slice(0, 12);

const { text: keyText, key } = loadKey();
const content = JSON.parse(readFileSync(join(priv, "content.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const images = {};
for (const file of readdirSync(join(priv, "photos")).sort()) {
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) continue;
  const id = basename(file, extname(file));
  const name = opaque(key, id) + ".bin";
  writeFileSync(join(out, name), seal(key, readFileSync(join(priv, "photos", file))));
  images[id] = { file: name, type };
}

// Every photograph the content mentions must exist, and nothing is sealed unused.
const wanted = new Set([
  ...content.her.photos.map((p) => p.id),
  ...content.memories.cards.filter((c) => c.photo).map((c) => c.photo),
]);
for (const id of wanted) if (!images[id]) throw new Error(`content.json mentions "${id}" but private/us/photos has no such file.`);
for (const id of Object.keys(images)) if (!wanted.has(id)) console.warn(`note: photo "${id}" is sealed but not used anywhere.`);

writeFileSync(join(out, "content.bin"), seal(key, Buffer.from(JSON.stringify({ ...content, images }))));

console.log(`Sealed ${Object.keys(images).length} photographs + content into us/pack/`);
console.log(`Link to share:  <your site address>/us/#${keyText}`);
