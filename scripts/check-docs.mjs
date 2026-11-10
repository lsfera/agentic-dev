#!/usr/bin/env node
// Docs consistency check (no dependencies). Run from the repo root: node scripts/check-docs.mjs
//  1. every relative markdown link resolves to a file
//  2. every "ADR-NNNN" mention refers to an existing ADR (removed ones are allow-listed)
//  3. no stale ".sandcastle/*.ts" path (sources live in .sandcastle/src/) outside ADRs
//  4. every ADR has a Status line and appears in docs/adr/README.md
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = process.cwd();
const REMOVED = new Set(["0006", "0007", "0009", "0010"]); // folded into successors, see docs/adr/README.md
const errors = [];
const fail = (f, m) => errors.push(`${relative(root, f)}: ${m}`);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if ([".git", "node_modules", "logs", "worktrees"].includes(e)) continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : /\.md$/.test(e) && out.push(p);
  }
  return out;
};
const files = walk(root);

const adrDir = join(root, "docs", "adr");
const adrFiles = readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f));
const adrIds = new Set(adrFiles.map((f) => f.slice(0, 4)));
const index = readFileSync(join(adrDir, "README.md"), "utf8");

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const noCode = text.replace(/```[\s\S]*?```/g, "");
  for (const m of noCode.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!existsSync(resolve(dirname(f), target))) fail(f, `broken link: ${m[1]}`);
  }
  for (const m of text.matchAll(/ADR-(\d{4})/g)) {
    if (!adrIds.has(m[1]) && !REMOVED.has(m[1])) fail(f, `references missing ADR-${m[1]}`);
  }
  if (!f.includes(`${join("docs", "adr")}`) && /\.sandcastle\/\*\.ts/.test(text)) {
    fail(f, "stale path .sandcastle/*.ts (use .sandcastle/src/)");
  }
}

for (const f of adrFiles) {
  const id = f.slice(0, 4);
  if (!/^\*\*Status/m.test(readFileSync(join(adrDir, f), "utf8"))) fail(join(adrDir, f), "missing Status line");
  if (!index.includes(`[${id}]`)) fail(join(adrDir, "README.md"), `ADR-${id} missing from index`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} docs problem(s)`);
  process.exit(1);
}
console.log(`docs ok (${files.length} markdown files, ${adrFiles.length} ADRs)`);
