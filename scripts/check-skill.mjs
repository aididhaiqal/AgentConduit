#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

function fail(message) {
  process.stderr.write(`skill validation failed: ${message}\n`);
  process.exitCode = 1;
}

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function frontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return undefined;
  const values = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
    if (entry) values.set(entry[1], scalar(entry[2]));
  }
  return values;
}

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1) {
  fail("usage: check-skill.mjs <skill-directory>");
} else {
  const requestedRoot = resolve(arguments_[0]);
  if (!existsSync(requestedRoot) || !lstatSync(requestedRoot).isDirectory()) {
    fail(`skill directory does not exist: ${requestedRoot}`);
  } else {
    const root = realpathSync(requestedRoot);
    const skillPath = resolve(root, "SKILL.md");
    if (!existsSync(skillPath) || !lstatSync(skillPath).isFile()) {
      fail("SKILL.md is missing or is not a regular file");
    } else {
      const source = readFileSync(skillPath, "utf8");
      const metadata = frontmatter(source);
      const name = metadata?.get("name");
      const description = metadata?.get("description");
      if (!metadata) fail("SKILL.md must begin with YAML frontmatter");
      if (typeof name !== "string" || !/^[a-z0-9-]{1,63}$/.test(name)) {
        fail(
          "frontmatter name must use 1-63 lowercase letters, digits, or hyphens",
        );
      } else if (name !== basename(root)) {
        fail(`frontmatter name ${name} must match directory ${basename(root)}`);
      }
      if (
        typeof description !== "string" ||
        description.length < 20 ||
        description.length > 1_024
      ) {
        fail("frontmatter description must contain 20-1024 characters");
      }
      if (/\b(?:TODO|TBD|FIXME)\b/.test(source)) {
        fail("SKILL.md contains an unfinished scaffold marker");
      }

      const linked = new Set();
      for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].split("#", 1)[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (isAbsolute(target)) {
          fail(`skill link must be package-relative: ${target}`);
          continue;
        }
        const resolved = resolve(dirname(skillPath), target);
        if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
          fail(`skill link escapes the package: ${target}`);
          continue;
        }
        if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
          fail(`linked skill resource is missing: ${target}`);
          continue;
        }
        linked.add(target);
      }

      const packagePath = resolve(root, "package.json");
      if (existsSync(packagePath)) {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        const files = Array.isArray(packageJson.files) ? packageJson.files : [];
        if (!files.includes("SKILL.md")) {
          fail("package.json files must include SKILL.md");
        }
        if (
          [...linked].some((target) => target.startsWith("references/")) &&
          !files.includes("references")
        ) {
          fail("package.json files must include linked references");
        }
      }

      const claudePath = resolve(root, "CLAUDE.md");
      if (
        !existsSync(claudePath) ||
        readFileSync(claudePath, "utf8").trim() !== "@AGENTS.md"
      ) {
        fail("CLAUDE.md must be the one-line @AGENTS.md shim");
      }

      if (process.exitCode !== 1) {
        process.stdout.write(
          `validated ${name}: ${linked.size} linked resource(s)\n`,
        );
      }
    }
  }
}
