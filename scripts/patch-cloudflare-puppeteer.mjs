import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function patchFile(relativePath, transform) {
  const filePath = path.join(root, relativePath);
  const original = await fs.readFile(filePath, 'utf8');
  const updated = transform(original);

  if (updated === original) {
    return;
  }

  await fs.writeFile(filePath, updated, 'utf8');
}

await patchFile(
  'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/environment.js',
  (source) => source.replace(
    "export const isNode = !!(typeof process !== 'undefined' && process.version);",
    'export const isNode = false;'
  )
);

await patchFile(
  'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/cloudflare/globalPatcher.js',
  (_source) => `/**
 * @license
 * Copyright 2025 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
class BufferPolyfill extends Uint8Array {
    static from(value, encoding = 'utf8') {
        if (value instanceof Uint8Array) {
            return new BufferPolyfill(value);
        }
        if (ArrayBuffer.isView(value)) {
            return new BufferPolyfill(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        }
        if (value instanceof ArrayBuffer) {
            return new BufferPolyfill(value.slice(0));
        }
        if (typeof value === 'string') {
            if (encoding === 'base64') {
                return new BufferPolyfill(decodeBase64(value));
            }
            return new BufferPolyfill(new TextEncoder().encode(value));
        }
        if (Array.isArray(value)) {
            return new BufferPolyfill(Uint8Array.from(value));
        }
        return new BufferPolyfill(0);
    }
    static concat(chunks) {
        const arrays = chunks.map(chunk => BufferPolyfill.from(chunk));
        const total = arrays.reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new BufferPolyfill(total);
        let offset = 0;
        for (const chunk of arrays) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        return merged;
    }
}
if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = BufferPolyfill;
}
//# sourceMappingURL=globalPatcher.js.map
`
);

await patchFile(
  'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/common/util.js',
  (source) => source.replace("import { Buffer } from 'node:buffer';\n", '')
);

console.log('Patched @cloudflare/puppeteer for Cloudflare Workers runtime.');
