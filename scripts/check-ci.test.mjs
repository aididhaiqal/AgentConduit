import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const checkerPath = resolve("scripts/check-ci.mjs");
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

async function withRepository(files, run) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "agentconduit-ci-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const destination = join(repositoryRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents, "utf8");
    }
    await run(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

async function runChecker(repositoryRoot) {
  try {
    return await execFileAsync(process.execPath, [checkerPath], {
      cwd: repositoryRoot,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(output || error.message);
  }
}

function workflow(steps) {
  return `name: fixture
on: push
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
${steps}
`;
}

test("rejects a mutable action in a flow mapping", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - { name: checkout, uses: actions/checkout@v4 }",
      ),
    },
    async (root) => {
      await assert.rejects(runChecker(root), /actions\/checkout@v4/);
    },
  );
});

test("rejects a mutable action behind a quoted uses key", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        '      - "uses": actions/setup-node@v4',
      ),
    },
    async (root) => {
      await assert.rejects(runChecker(root), /actions\/setup-node@v4/);
    },
  );
});

test("recursively checks nested local composite actions", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/outer",
      ),
      ".github/actions/outer/action.yml": `name: outer
runs:
  using: composite
  steps:
    - uses: ./.github/actions/inner
`,
      ".github/actions/inner/action.yaml": `name: inner
runs:
  using: composite
  steps:
    - uses: actions/cache@v4
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /actions\/cache@v4/);
    },
  );
});

test("recursively checks local reusable workflows", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": `name: caller
on: push
jobs:
  called:
    uses: ./.github/workflows/reusable.yml
`,
      ".github/workflows/reusable.yml": `name: reusable
on: workflow_call
jobs:
  nested:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /owner\/action@v1/);
    },
  );
});

test("rejects tagged Docker action images", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/docker",
      ),
      ".github/actions/docker/action.yml": `name: docker
runs:
  using: docker
  image: docker://alpine:3.22
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /docker:\/\/alpine:3\.22/);
    },
  );
});

test("rejects mutable base images in local Docker actions", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/dockerfile",
      ),
      ".github/actions/dockerfile/action.yml": `name: dockerfile
runs:
  using: docker
  image: Dockerfile
`,
      ".github/actions/dockerfile/Dockerfile": "FROM node:22\n",
    },
    async (root) => {
      await assert.rejects(runChecker(root), /node:22/);
    },
  );
});

test("rejects mutable bases when the Dockerfile opcode is continued", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/dockerfile",
      ),
      ".github/actions/dockerfile/action.yml": `name: dockerfile
runs:
  using: docker
  image: Dockerfile
`,
      ".github/actions/dockerfile/Dockerfile": `FR\\
OM node:22
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /node:22/);
    },
  );
});

test("rejects mutable Dockerfile syntax frontends", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/dockerfile",
      ),
      ".github/actions/dockerfile/action.yml": `name: dockerfile
runs:
  using: docker
  image: Dockerfile
`,
      ".github/actions/dockerfile/Dockerfile": `# syntax=docker/dockerfile:1
FROM scratch
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /docker\/dockerfile:1/);
    },
  );
});

test("rejects dynamic Dockerfile base images", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/dockerfile",
      ),
      ".github/actions/dockerfile/action.yml": `name: dockerfile
runs:
  using: docker
  image: Dockerfile
`,
      ".github/actions/dockerfile/Dockerfile": `ARG BASE_IMAGE
FROM \${BASE_IMAGE}
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /statically resolved/);
    },
  );
});

test("requires local Docker action images to be regular files", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/dockerfile",
      ),
      ".github/actions/dockerfile/action.yml": `name: dockerfile
runs:
  using: docker
  image: Dockerfile
`,
      ".github/actions/dockerfile/Dockerfile/placeholder": "not an image\n",
    },
    async (root) => {
      await assert.rejects(runChecker(root), /regular file/);
    },
  );
});

test("rejects escaping local JavaScript action entrypoints", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/javascript",
      ),
      ".github/actions/javascript/action.yml": `name: javascript
runs:
  using: node20
  main: ../../../../outside.js
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /outside the repository/);
    },
  );
});

test("validates every declared local JavaScript action entrypoint", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/javascript",
      ),
      ".github/actions/javascript/action.yml": `name: javascript
runs:
  using: node20
  main: dist/index.js
  pre: dist/pre.js
  post: dist/post.js
`,
      ".github/actions/javascript/dist/index.js": "export {};\n",
      ".github/actions/javascript/dist/post.js": "export {};\n",
    },
    async (root) => {
      await assert.rejects(runChecker(root), /pre.*cannot be resolved/i);
    },
  );
});

test("rejects mutable job and service container images", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": `name: containers
on: push
jobs:
  verify:
    runs-on: ubuntu-latest
    container:
      image: node:22
    services:
      database:
        image: postgres:17
    steps:
      - run: node --version
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /node:22/);
      await assert.rejects(runChecker(root), /postgres:17/);
    },
  );
});

test("rejects local references that escape the repository", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow("      - uses: ./../outside"),
    },
    async (root) => {
      await assert.rejects(runChecker(root), /outside the repository/);
    },
  );
});

test("rejects recursive local dependency cycles", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": workflow(
        "      - uses: ./.github/actions/first",
      ),
      ".github/actions/first/action.yml": `name: first
runs:
  using: composite
  steps:
    - uses: ./.github/actions/second
`,
      ".github/actions/second/action.yml": `name: second
runs:
  using: composite
  steps:
    - uses: ./.github/actions/first
`,
    },
    async (root) => {
      await assert.rejects(runChecker(root), /cycle/i);
    },
  );
});

test("accepts immutable direct, reusable, composite, Docker, and container references", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": `name: immutable
on: push
jobs:
  verify:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/example/node@${digest}
    services:
      database:
        image: postgres@${digest}
    steps:
      - { uses: actions/checkout@${sha} }
      - "uses": ./.github/actions/outer
  called:
    uses: ./.github/workflows/reusable.yml
`,
      ".github/workflows/reusable.yml": `name: reusable
on: workflow_call
jobs:
  nested:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/repository/.github/actions/task@${sha}
`,
      ".github/actions/outer/action.yml": `name: outer
runs:
  using: composite
  steps:
    - uses: owner/action@${sha}
    - uses: ./.github/actions/docker
    - uses: ./.github/actions/javascript
`,
      ".github/actions/docker/action.yml": `name: docker
runs:
  using: docker
  image: Dockerfile
`,
      ".github/actions/docker/Dockerfile": `# syntax=docker/dockerfile@${digest}
FROM \\
  ghcr.io/example/action@${digest} AS action
FROM action AS final
FROM scratch
`,
      ".github/actions/javascript/action.yml": `name: javascript
runs:
  using: node20
  main: dist/index.js
  pre: dist/pre.js
  post: dist/post.js
`,
      ".github/actions/javascript/dist/index.js": "export {};\n",
      ".github/actions/javascript/dist/pre.js": "export {};\n",
      ".github/actions/javascript/dist/post.js": "export {};\n",
    },
    async (root) => {
      const result = await runChecker(root);
      assert.match(result.stdout, /validated 7 immutable external/);
    },
  );
});
