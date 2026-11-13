// The words and photographs live in pack/ as AES-GCM ciphertext.
// The key is never stored on the server: it arrives in the link, after the #.

const KEY_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** Accepts a bare key or a whole pasted link and returns the key, or null. */
export function parseKey(text) {
  const key = String(text || "").trim().replace(/^.*#/, "");
  return KEY_SHAPE.test(key) ? key : null;
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "==";
  const bin = atob(b64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export async function openVault(keyText, base = "pack/") {
  if (!globalThis.crypto?.subtle) throw new Error("insecure-context");
  const key = await crypto.subtle.importKey("raw", fromBase64Url(keyText), "AES-GCM", false, ["decrypt"]);

  async function open(file) {
    const res = await fetch(base + file);
    if (!res.ok) throw new Error("missing " + file);
    const sealed = new Uint8Array(await res.arrayBuffer());
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) }, key, sealed.subarray(12));
    return new Uint8Array(plain);
  }

  const urls = new Map();

  return {
    async json(file) {
      return JSON.parse(new TextDecoder().decode(await open(file)));
    },
    /** Decrypts a photograph once and hands back the same object URL afterwards. */
    image(file, type) {
      if (!urls.has(file)) {
        urls.set(file, open(file).then((bytes) => URL.createObjectURL(new Blob([bytes], { type }))));
      }
      return urls.get(file);
    },
  };
}
