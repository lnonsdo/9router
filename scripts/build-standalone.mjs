#!/usr/bin/env node
/**
 * Build the Next.js standalone bundle the desktop shell ships: src-tauri bundles
 * `standalone-dist/` as a resource (see tauri.conf.json `bundle.resources`).
 *
 * The previous package.json one-liner paid full price on every run:
 *   `next build` (~2m40s measured on this machine) plus a fresh `npm install` of
 *   next into standalone-dist (~1m, network).
 * Two caches make repeat builds cheap:
 *
 *   stamp  sha256 over every source the build consumes. When it still matches and
 *          standalone-dist is intact the build is skipped entirely, so a Rust-only
 *          desktop iteration costs just the Tauri compile.
 *   deps   the node_modules npm resolves for `next@<version>` is snapshotted and
 *          cloned back (APFS clonefile on macOS, ~1s) instead of re-fetched.
 *
 * Usage: node scripts/build-standalone.mjs [--force]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "standalone-dist");
const CACHE = join(ROOT, ".build-cache");
const STAMP = join(CACHE, "standalone.stamp");
const DEPS_CACHE = join(CACHE, "deps");
const FORCE = process.argv.includes("--force");

// What `next build` actually reads. .env* is untracked but inlined at build time,
// so it is listed explicitly instead of relying on a git file list.
const INPUT_DIRS = ["src", "open-sse", "public"];
const INPUT_FILES = [
  "custom-server.js",
  "next.config.mjs",
  "postcss.config.mjs",
  "jsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
  "scripts/copy-standalone-assets.mjs",
  ".env",
  ".env.local",
  ".env.production",
];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (result.status !== 0) {
    console.error(`[standalone] ${cmd} ${args.join(" ")} failed (exit ${result.status})`);
    process.exit(result.status || 1);
  }
  return result;
}

function hashInputs() {
  const hash = createHash("sha256");
  const eat = (label, body) => {
    hash.update(label);
    hash.update("\0");
    hash.update(body);
    hash.update("\0");
  };
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      if (name === ".DS_Store" || name === "node_modules" || name === ".next") continue;
      const child = join(abs, name);
      const childRel = `${rel}/${name}`;
      if (statSync(child).isDirectory()) visit(child, childRel);
      else eat(childRel, readFileSync(child));
    }
  };
  for (const dir of INPUT_DIRS) {
    const abs = join(ROOT, dir);
    if (existsSync(abs)) visit(abs, dir);
  }
  for (const file of INPUT_FILES) {
    const abs = join(ROOT, file);
    if (existsSync(abs)) eat(file, readFileSync(abs));
  }
  return hash.digest("hex");
}

// Anything that changes the resolved dependency tree invalidates the snapshot:
// next version, node/npm version (tree layout differs), platform, and the flags
// that select platform-specific optional deps (sharp / @swc).
function depsKey(nextVersion) {
  const npmVersion = spawnSync("npm", ["-v"], { encoding: "utf8" }).stdout?.trim() ?? "";
  return createHash("sha256")
    .update(
      [
        `next@${nextVersion}`,
        `node@${process.version}`,
        `npm@${npmVersion}`,
        `${process.platform}/${process.arch}`,
        "--omit=dev --cpu=arm64 --os=darwin",
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);
}

// APFS clonefile: a 342 MB tree lands in ~1s and shares blocks with the cache.
// Falls back to a plain recursive copy where `cp -c` is unavailable.
//
// followLinks: the traced .next/standalone/node_modules is a pnpm tree of
// relative symlinks into .next/standalone/node_modules/.pnpm. Clonefile keeps
// the links, and npm then re-resolves every package itself (measured: 8+ min and
// still going, vs ~1 min when the links are materialized like the old `cp -r`).
function cloneCopy(src, dest, { followLinks = false } = {}) {
  rmSync(dest, { recursive: true, force: true });
  const deref = followLinks ? ["-L"] : [];
  const flags = process.platform === "darwin" ? ["-c", ...deref, "-R"] : [...deref, "-R"];
  const result = spawnSync("cp", [...flags, src, dest], { stdio: "inherit" });
  if (result.status !== 0) run("cp", [...deref, "-R", src, dest]);
}

const started = Date.now();
const stamp = hashInputs();

if (
  !FORCE &&
  existsSync(join(DIST, "custom-server.js")) &&
  existsSync(STAMP) &&
  readFileSync(STAMP, "utf8").trim() === stamp
) {
  console.log(`[standalone] unchanged (${stamp.slice(0, 8)}) — reusing standalone-dist`);
  process.exit(0);
}

console.log("[standalone] sources changed — running next build");
run("pnpm", ["run", "build"]);

rmSync(DIST, { recursive: true, force: true });
cloneCopy(join(ROOT, ".next", "standalone"), DIST, { followLinks: true });

// `next build` does not always leave these inside .next/standalone (postbuild is
// not guaranteed to run under `pnpm run`), so copy them the same way the old
// one-liner did — but replace the destination first: when postbuild already
// copied static/public in, `cp -R src dest` would nest them (static/static).
for (const [src, dest] of [
  [join(ROOT, ".next", "static"), join(DIST, ".next", "static")],
  [join(ROOT, "public"), join(DIST, "public")],
  [join(ROOT, "custom-server.js"), join(DIST, "custom-server.js")],
]) {
  if (existsSync(src)) cloneCopy(src, dest);
}

// npm is asked for the same "next only" tree the old one-liner installed: the
// traced node_modules from a pnpm workspace points into the store via symlinks,
// which do not exist once the bundle is shipped inside the app.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const nextVersion = pkg.dependencies?.next;
if (!nextVersion) {
  console.error("[standalone] root package.json has no dependencies.next");
  process.exit(1);
}
writeFileSync(join(DIST, ".npmrc"), "node-linker=hoisted\n");
const distPkg = JSON.parse(readFileSync(join(DIST, "package.json"), "utf8"));
distPkg.dependencies = { next: nextVersion };
distPkg.devDependencies = {};
distPkg.optionalDependencies = {};
writeFileSync(join(DIST, "package.json"), JSON.stringify(distPkg, null, 2));

const key = depsKey(nextVersion);
const cachedDeps = join(DEPS_CACHE, key, "node_modules");
if (existsSync(cachedDeps)) {
  console.log(`[standalone] deps cache hit (${key}) — cloning node_modules`);
  cloneCopy(cachedDeps, join(DIST, "node_modules"));
} else {
  console.log(`[standalone] deps cache miss (${key}) — npm install`);
  run("npm", ["install", "--no-save", "--omit=dev", "--cpu=arm64", "--os=darwin"], { cwd: DIST });
  mkdirSync(dirname(cachedDeps), { recursive: true });
  cloneCopy(join(DIST, "node_modules"), cachedDeps);
}

mkdirSync(join(DIST, "node_modules", "open-sse"), { recursive: true });
run("cp", ["-R", `${join(ROOT, "open-sse")}/.`, join(DIST, "node_modules", "open-sse")]);
writeFileSync(
  join(DIST, "node_modules", "open-sse", "package.json"),
  '{"name":"open-sse","version":"0.0.0","main":"index.js"}'
);

console.log("[standalone] slimming");
run("find", [".", "-name", "*.map", "-delete"], { cwd: DIST });
rmSync(join(DIST, "node_modules", ".cache"), { recursive: true, force: true });

mkdirSync(CACHE, { recursive: true });
writeFileSync(STAMP, stamp);
console.log(`[standalone] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
