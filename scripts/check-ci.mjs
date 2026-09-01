#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LineCounter, parseDocument } from "yaml";

const workflowExtension = /\.(?:yaml|yml)$/i;
const githubReference =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/i;
const dockerUsesReference = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/i;
const containerImageReference = /^[^\s@]+@sha256:[0-9a-f]{64}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containedBy(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function displayPath(repositoryRoot, path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function describeValue(value) {
  if (typeof value === "string") return value || "<empty>";
  if (value === undefined) return "<missing>";
  return `<${Array.isArray(value) ? "array" : typeof value}>`;
}

function dockerfileParserDirectives(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const syntaxFrontends = [];
  let escapeCharacter = "\\";
  for (const [index, rawLine] of lines.entries()) {
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    const match = /^\s*#\s*(syntax|escape)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!match) break;
    if (match[1].toLowerCase() === "syntax") {
      syntaxFrontends.push({ line: index + 1, value: match[2] });
    } else if (match[2] === "\\" || match[2] === "`") {
      escapeCharacter = match[2];
    }
  }
  return { escapeCharacter, syntaxFrontends };
}

function dockerfileLogicalInstructions(source, escapeCharacter) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const instructions = [];
  let current = "";
  let startLine = 1;
  for (const [index, rawLine] of lines.entries()) {
    const trimmedStart = rawLine.trimStart();
    if (trimmedStart.length === 0 || trimmedStart.startsWith("#")) continue;

    const trimmedEnd = rawLine.trimEnd();
    let trailingEscapes = 0;
    for (
      let cursor = trimmedEnd.length - 1;
      cursor >= 0 && trimmedEnd[cursor] === escapeCharacter;
      cursor -= 1
    ) {
      trailingEscapes += 1;
    }
    const continued = trailingEscapes % 2 === 1;
    const fragment = continued ? trimmedEnd.slice(0, -1) : rawLine;
    if (current.length === 0) startLine = index + 1;
    current += fragment;
    if (!continued) {
      instructions.push({ line: startLine, value: current.trim() });
      current = "";
    }
  }
  if (current.length > 0)
    instructions.push({ line: startLine, value: current.trim() });
  return instructions;
}

function parseYaml(repositoryRoot, path, violations) {
  const source = readFileSync(path, "utf8");
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    for (const error of document.errors) {
      violations.push(
        `${displayPath(repositoryRoot, path)}: invalid YAML: ${error.message}`,
      );
    }
    return undefined;
  }

  let value;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    violations.push(
      `${displayPath(repositoryRoot, path)}: invalid YAML aliases: ${error.message}`,
    );
    return undefined;
  }

  if (!isRecord(value)) {
    violations.push(
      `${displayPath(repositoryRoot, path)}: YAML document must be a mapping`,
    );
    return undefined;
  }

  return { document, lineCounter, value };
}

function nodeLine(parsed, path) {
  const node = parsed.document.getIn(path, true);
  if (!node?.range) return 1;
  return parsed.lineCounter.linePos(node.range[0]).line;
}

export function validateCiDependencies(inputRoot = process.cwd()) {
  const requestedRoot = resolve(inputRoot);
  const repositoryRoot = realpathSync(requestedRoot);
  const workflowsDirectory = join(repositoryRoot, ".github", "workflows");
  let workflowEntries;
  try {
    workflowEntries = readdirSync(workflowsDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Cannot read ${displayPath(repositoryRoot, workflowsDirectory)}: ${error.message}`,
    );
  }

  const workflowFiles = workflowEntries
    .filter((entry) => entry.isFile() && workflowExtension.test(entry.name))
    .map((entry) => join(workflowsDirectory, entry.name))
    .sort();
  if (workflowFiles.length === 0) {
    throw new Error("No GitHub Actions workflow files were found");
  }

  const violations = [];
  const activeArtifacts = new Set();
  const completedArtifacts = new Set();
  let externalReferences = 0;
  let localActionManifests = 0;

  function location(path, line) {
    return `${displayPath(repositoryRoot, path)}:${line}`;
  }

  function record(path, line, message, value) {
    violations.push(
      `${location(path, line)}: ${message}: ${describeValue(value)}`,
    );
  }

  function validateExternalUses(value, path, line) {
    externalReferences += 1;
    if (!githubReference.test(value) && !dockerUsesReference.test(value)) {
      record(
        path,
        line,
        "external action or reusable workflow must use a 40-hex commit SHA or image digest",
        value,
      );
    }
  }

  function validateContainerImage(value, path, line) {
    externalReferences += 1;
    if (!containerImageReference.test(value)) {
      record(path, line, "container image must use a sha256 digest", value);
    }
  }

  function resolveActionExecutable(value, manifestPath, line, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
      record(manifestPath, line, `${label} must be a non-empty path`, value);
      return undefined;
    }

    const lexicalPath = resolve(dirname(manifestPath), value);
    if (!containedBy(repositoryRoot, lexicalPath)) {
      record(
        manifestPath,
        line,
        `${label} resolves outside the repository`,
        value,
      );
      return undefined;
    }

    let realPath;
    try {
      realPath = realpathSync(lexicalPath);
    } catch (error) {
      record(
        manifestPath,
        line,
        `${label} cannot be resolved (${error.code ?? error.message})`,
        value,
      );
      return undefined;
    }
    if (!containedBy(repositoryRoot, realPath)) {
      record(
        manifestPath,
        line,
        `${label} resolves through a symlink outside the repository`,
        value,
      );
      return undefined;
    }

    let stats;
    try {
      stats = statSync(realPath);
    } catch (error) {
      record(
        manifestPath,
        line,
        `${label} cannot be inspected (${error.code ?? error.message})`,
        value,
      );
      return undefined;
    }
    if (!stats.isFile()) {
      record(
        manifestPath,
        line,
        `${label} must reference an existing regular file`,
        value,
      );
      return undefined;
    }
    return realPath;
  }

  function inspectDockerfile(path) {
    inspectArtifact(path, "Dockerfile", () => {
      const source = readFileSync(path, "utf8");
      const { escapeCharacter, syntaxFrontends } =
        dockerfileParserDirectives(source);
      for (const frontend of syntaxFrontends) {
        externalReferences += 1;
        if (!containerImageReference.test(frontend.value)) {
          record(
            path,
            frontend.line,
            "Dockerfile syntax frontend must use a sha256 digest",
            frontend.value,
          );
        }
      }

      const namedStages = new Set();
      for (const instruction of dockerfileLogicalInstructions(
        source,
        escapeCharacter,
      )) {
        const parsedInstruction = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(
          instruction.value,
        );
        if (!parsedInstruction || parsedInstruction[1].toUpperCase() !== "FROM")
          continue;

        const tokens = (parsedInstruction[2] ?? "").trim().split(/\s+/);
        let imageIndex = 0;
        while (tokens[imageIndex]?.startsWith("--")) imageIndex += 1;
        const image = tokens[imageIndex];
        if (!image) {
          record(
            path,
            instruction.line,
            "Dockerfile FROM requires an image",
            image,
          );
          continue;
        }

        const suffix = tokens.slice(imageIndex + 1);
        let stageName;
        if (suffix.length > 0) {
          if (
            suffix.length === 2 &&
            suffix[0].toUpperCase() === "AS" &&
            /^[A-Za-z0-9_.-]+$/.test(suffix[1])
          ) {
            stageName = suffix[1].toLowerCase();
          } else {
            record(
              path,
              instruction.line,
              "Dockerfile FROM has an invalid stage declaration",
              instruction.value,
            );
          }
        }

        const normalizedImage = image.toLowerCase();
        if (image.includes("$")) {
          record(
            path,
            instruction.line,
            "Dockerfile FROM image must be statically resolved and digest-pinned",
            image,
          );
        } else if (
          normalizedImage !== "scratch" &&
          !namedStages.has(normalizedImage)
        ) {
          externalReferences += 1;
          if (!containerImageReference.test(image)) {
            record(
              path,
              instruction.line,
              "Dockerfile FROM image must use a sha256 digest",
              image,
            );
          }
        }
        if (stageName) namedStages.add(stageName);
      }
    });
  }

  function resolveLocal(value, originPath, line) {
    const lexicalPath = resolve(repositoryRoot, value);
    if (!containedBy(repositoryRoot, lexicalPath)) {
      record(
        originPath,
        line,
        "local reference resolves outside the repository",
        value,
      );
      return undefined;
    }

    let realPath;
    try {
      realPath = realpathSync(lexicalPath);
    } catch (error) {
      record(
        originPath,
        line,
        `local reference cannot be resolved (${error.code ?? error.message})`,
        value,
      );
      return undefined;
    }
    if (!containedBy(repositoryRoot, realPath)) {
      record(
        originPath,
        line,
        "local reference resolves through a symlink outside the repository",
        value,
      );
      return undefined;
    }
    return realPath;
  }

  function inspectArtifact(path, kind, inspect) {
    if (activeArtifacts.has(path)) {
      violations.push(
        `${displayPath(repositoryRoot, path)}: local CI dependency cycle detected`,
      );
      return;
    }
    if (completedArtifacts.has(path)) return;

    activeArtifacts.add(path);
    try {
      inspect();
      completedArtifacts.add(path);
    } catch (error) {
      violations.push(
        `${displayPath(repositoryRoot, path)}: cannot inspect local ${kind}: ${error.message}`,
      );
    } finally {
      activeArtifacts.delete(path);
    }
  }

  function inspectUses(value, originPath, line, usage) {
    if (typeof value !== "string" || value.length === 0) {
      record(originPath, line, "uses must be a non-empty string", value);
      return;
    }
    if (!value.startsWith("./")) {
      validateExternalUses(value, originPath, line);
      return;
    }

    const localPath = resolveLocal(value, originPath, line);
    if (!localPath) return;
    let stats;
    try {
      stats = statSync(localPath);
    } catch (error) {
      record(
        originPath,
        line,
        `local reference cannot be inspected (${error.code ?? error.message})`,
        value,
      );
      return;
    }

    if (usage === "workflow") {
      if (!stats.isFile() || !workflowExtension.test(localPath)) {
        record(
          originPath,
          line,
          "local reusable workflow must reference a YAML file",
          value,
        );
        return;
      }
      inspectWorkflow(localPath);
      return;
    }

    if (!stats.isDirectory()) {
      record(
        originPath,
        line,
        "local action must reference a directory",
        value,
      );
      return;
    }

    const candidates = [
      join(localPath, "action.yml"),
      join(localPath, "action.yaml"),
    ];
    let manifestPath;
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) {
          manifestPath = realpathSync(candidate);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          record(
            originPath,
            line,
            `local action manifest cannot be inspected (${error.code ?? error.message})`,
            value,
          );
          return;
        }
      }
    }
    if (!manifestPath) {
      record(
        originPath,
        line,
        "local action directory has no action.yml or action.yaml",
        value,
      );
      return;
    }
    if (!containedBy(repositoryRoot, manifestPath)) {
      record(
        originPath,
        line,
        "local action manifest resolves outside the repository",
        value,
      );
      return;
    }
    inspectActionManifest(manifestPath);
  }

  function inspectStepUses(steps, path, parsed, yamlPath) {
    if (!Array.isArray(steps)) return;
    for (const [index, step] of steps.entries()) {
      if (!isRecord(step) || !("uses" in step)) continue;
      const usesPath = [...yamlPath, index, "uses"];
      inspectUses(step.uses, path, nodeLine(parsed, usesPath), "action");
    }
  }

  function inspectWorkflow(path) {
    inspectArtifact(path, "workflow", () => {
      const parsed = parseYaml(repositoryRoot, path, violations);
      if (!parsed) return;
      const jobs = parsed.value.jobs;
      if (!isRecord(jobs)) return;

      for (const [jobName, job] of Object.entries(jobs)) {
        if (!isRecord(job)) continue;
        const jobPath = ["jobs", jobName];
        if ("uses" in job) {
          const usesPath = [...jobPath, "uses"];
          inspectUses(job.uses, path, nodeLine(parsed, usesPath), "workflow");
        }
        inspectStepUses(job.steps, path, parsed, [...jobPath, "steps"]);

        if (typeof job.container === "string") {
          validateContainerImage(
            job.container,
            path,
            nodeLine(parsed, [...jobPath, "container"]),
          );
        } else if (isRecord(job.container) && "image" in job.container) {
          const imagePath = [...jobPath, "container", "image"];
          if (typeof job.container.image === "string") {
            validateContainerImage(
              job.container.image,
              path,
              nodeLine(parsed, imagePath),
            );
          } else {
            record(
              path,
              nodeLine(parsed, imagePath),
              "container image must be a string",
              job.container.image,
            );
          }
        }

        if (isRecord(job.services)) {
          for (const [serviceName, service] of Object.entries(job.services)) {
            if (!isRecord(service) || !("image" in service)) continue;
            const imagePath = [...jobPath, "services", serviceName, "image"];
            if (typeof service.image === "string") {
              validateContainerImage(
                service.image,
                path,
                nodeLine(parsed, imagePath),
              );
            } else {
              record(
                path,
                nodeLine(parsed, imagePath),
                "service container image must be a string",
                service.image,
              );
            }
          }
        }
      }
    });
  }

  function inspectActionManifest(path) {
    inspectArtifact(path, "action manifest", () => {
      localActionManifests += 1;
      const parsed = parseYaml(repositoryRoot, path, violations);
      if (!parsed) return;
      const runs = parsed.value.runs;
      if (!isRecord(runs)) return;

      inspectStepUses(runs.steps, path, parsed, ["runs", "steps"]);
      if ("image" in runs) {
        const imagePath = ["runs", "image"];
        const imageLine = nodeLine(parsed, imagePath);
        if (typeof runs.image !== "string") {
          record(
            path,
            imageLine,
            "Docker action image must be a string",
            runs.image,
          );
        } else if (runs.image.startsWith("docker://")) {
          validateExternalUses(runs.image, path, imageLine);
        } else {
          const dockerfilePath = resolveActionExecutable(
            runs.image,
            path,
            imageLine,
            "Docker action image",
          );
          if (dockerfilePath) inspectDockerfile(dockerfilePath);
        }
      } else if (runs.using === "docker") {
        record(
          path,
          nodeLine(parsed, ["runs"]),
          "Docker action image must be a non-empty path",
          undefined,
        );
      }

      if (typeof runs.using === "string" && /^node\d+$/i.test(runs.using)) {
        for (const entrypoint of ["main", "pre", "post"]) {
          if (entrypoint !== "main" && !(entrypoint in runs)) continue;
          const entrypointPath = ["runs", entrypoint];
          resolveActionExecutable(
            runs[entrypoint],
            path,
            nodeLine(parsed, entrypointPath),
            `JavaScript action ${entrypoint}`,
          );
        }
      }
    });
  }

  for (const workflowPath of workflowFiles)
    inspectWorkflow(realpathSync(workflowPath));

  if (violations.length > 0) {
    throw new Error(
      `CI executable dependencies must be immutable and repository-contained:\n${violations.join("\n")}`,
    );
  }

  return {
    externalReferences,
    localActionManifests,
    workflowFiles: workflowFiles.length,
  };
}

function main() {
  const result = validateCiDependencies();
  console.log(
    `validated ${result.externalReferences} immutable external executable reference(s) across ${result.workflowFiles} workflow(s) and ${result.localActionManifests} local action manifest(s)`,
  );
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
