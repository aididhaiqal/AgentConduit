#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  { name: "@agentconduit/core", directory: "packages/core" },
  { name: "@agentconduit/server", directory: "apps/server" },
  { name: "@agentconduit/bridge", directory: "packages/bridge" },
  { name: "@agentconduit/hub", directory: "apps/hub" },
  { name: "@agentconduit/node", directory: "apps/node" },
  {
    name: "@agentconduit/coordination-skill",
    directory: "skills/agentconduit-coordination",
  },
];

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`
      : "";
    throw new Error(
      `${command} ${arguments_.join(" ")} exited ${result.status}${detail}`,
    );
  }
  return result;
}

const root = mkdtempSync(join(tmpdir(), "agentconduit-pack-check-"));
const tarballs = join(root, "tarballs");
const installation = join(root, "installation");
try {
  mkdirSync(tarballs);
  mkdirSync(installation);
  for (const package_ of packages) {
    run(
      pnpm,
      ["--filter", package_.name, "pack", "--pack-destination", tarballs],
      { cwd: repositoryRoot },
    );
  }
  const archives = readdirSync(tarballs)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(tarballs, entry));
  if (archives.length !== packages.length) {
    throw new Error(
      `expected ${packages.length} tarballs, found ${archives.length}`,
    );
  }

  const dependencies = {};
  for (const package_ of packages) {
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, package_.directory, "package.json"),
        "utf8",
      ),
    );
    const expectedName = `${package_.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
    const archive = archives.find((path) => path.endsWith(expectedName));
    if (!archive) throw new Error(`packed archive is missing: ${expectedName}`);
    dependencies[package_.name] = `file:${archive}`;
  }
  writeFileSync(
    join(installation, "package.json"),
    `${JSON.stringify(
      {
        name: "agentconduit-pack-smoke",
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(installation, "pnpm-workspace.yaml"),
    `packages:\n  - .\noverrides:\n  "@agentconduit/core": ${JSON.stringify(dependencies["@agentconduit/core"])}\n  "@agentconduit/server": ${JSON.stringify(dependencies["@agentconduit/server"])}\n`,
  );
  run(pnpm, ["install", "--prefer-offline", "--ignore-scripts"], {
    cwd: installation,
  });

  const serverMain = join(
    installation,
    "node_modules",
    "@agentconduit",
    "server",
    "dist",
    "main.js",
  );
  const help = run(process.execPath, [serverMain, "--help"], {
    cwd: installation,
    capture: true,
  });
  if (!help.stdout.includes("AgentConduit MCP broker")) {
    throw new Error("packed server launcher did not return its help contract");
  }
  const hubMain = join(
    installation,
    "node_modules",
    "@agentconduit",
    "hub",
    "dist",
    "main.js",
  );
  const hubHelp = run(process.execPath, [hubMain, "help"], {
    cwd: installation,
    capture: true,
  });
  if (!hubHelp.stdout.includes("agentconduit-hub serve")) {
    throw new Error("packed Hub launcher did not return its help contract");
  }
  const nodeMain = join(
    installation,
    "node_modules",
    "@agentconduit",
    "node",
    "dist",
    "main.js",
  );
  const nodeHelp = run(process.execPath, [nodeMain, "--help"], {
    cwd: installation,
    capture: true,
  });
  if (!nodeHelp.stdout.includes("agentconduit-node enroll")) {
    throw new Error("packed Node launcher did not return its help contract");
  }
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('@agentconduit/core'); await import('@agentconduit/server'); await import('@agentconduit/bridge'); await import('@agentconduit/hub'); await import('@agentconduit/node');",
    ],
    { cwd: installation, capture: true },
  );

  const skillRoot = join(
    installation,
    "node_modules",
    "@agentconduit",
    "coordination-skill",
  );
  for (const relative of [
    "SKILL.md",
    "references/fullrouter.md",
    "references/recovery.md",
    "references/routing.md",
    "references/topology.md",
  ]) {
    const path = join(skillRoot, relative);
    if (!existsSync(path) || readFileSync(path, "utf8").length === 0) {
      throw new Error(`packed skill is missing ${relative}`);
    }
  }
  const hubPublic = join(
    installation,
    "node_modules",
    "@agentconduit",
    "hub",
    "public",
  );
  for (const relative of ["index.html", "styles.css", "app.js"]) {
    const path = join(hubPublic, relative);
    if (!existsSync(path) || readFileSync(path, "utf8").length === 0) {
      throw new Error(`packed Hub dashboard is missing ${relative}`);
    }
  }
  process.stdout.write(
    `verified ${archives.length} packed artifacts in a clean install\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
