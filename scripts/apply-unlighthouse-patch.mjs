/**
 * Unlighthouse calls loggerCtx.set(logger) without replace; a second createUnlighthouse()
 * throws "Context conflict" from unctx. Upstream fix: pass replace=true.
 * @see https://github.com/unjs/unctx — set(instance, replace)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "node_modules", "@unlighthouse", "core", "dist", "index.mjs");

if (!fs.existsSync(target)) {
  process.exit(0);
}

let s = fs.readFileSync(target, "utf8");
const needle = "\tloggerCtx.set(logger);\n";
const replacement = "\tloggerCtx.set(logger, true);\n";

if (s.includes(needle)) {
  fs.writeFileSync(target, s.replace(needle, replacement), "utf8");
  console.log("[postinstall] Patched @unlighthouse/core loggerCtx.set for repeat scans.");
}
