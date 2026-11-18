import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TfeClient, type TerraformVar } from "./tfe-client.js";

type Scenario = "created-before-failure" | "failed-before-create";

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/vnd.api+json" });
  response.end(JSON.stringify(body));
}

async function createTerraformApi(scenario: Scenario) {
  let created = false;
  let postCount = 0;
  let patchCount = 0;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    if (request.method === "GET" && path === "/workspaces/ws-test/vars") {
      json(response, 200, {
        data: created
          ? [{ id: "var-existing", type: "vars", attributes: { key: "example", category: "terraform" } }]
          : []
      });
      return;
    }
    if (request.method === "POST" && path === "/vars") {
      postCount += 1;
      if (postCount === 1) {
        created = scenario === "created-before-failure";
        json(response, 500, { errors: [{ detail: "temporary upstream failure" }] });
        return;
      }
      created = true;
      json(response, 201, { data: { id: "var-created", type: "vars" } });
      return;
    }
    if (request.method === "PATCH" && path === "/vars/var-existing") {
      patchCount += 1;
      json(response, 200, { data: { id: "var-existing", type: "vars" } });
      return;
    }
    json(response, 404, { errors: [{ detail: "not found" }] });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    counts: () => ({ patchCount, postCount }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

const variable: TerraformVar = {
  key: "example",
  value: "value",
  description: "retry test"
};

async function runScenario(scenario: Scenario) {
  const api = await createTerraformApi(scenario);
  const directory = await mkdtemp(join(tmpdir(), "platform-deploy-tfe-var-"));
  const logFile = join(directory, "executor.log");
  const client = new TfeClient({
    apiBase: api.apiBase,
    token: "test-token",
    organization: "test-org",
    logFile,
    redactedValues: ["test-token"]
  });
  try {
    await client.upsertTerraformVars("ws-test", [variable]);
    return { counts: api.counts(), log: await readFile(logFile, "utf8") };
  } finally {
    await api.close();
  }
}

test("reconciles an ambiguous variable-create failure without creating a duplicate", async () => {
  const result = await runScenario("created-before-failure");

  assert.deepEqual(result.counts, { patchCount: 1, postCount: 1 });
  assert.match(result.log, /was applied before the response failed; reconciling with PATCH/);
});

test("retries variable creation when the failed request did not create it", async () => {
  const result = await runScenario("failed-before-create");

  assert.deepEqual(result.counts, { patchCount: 0, postCount: 2 });
  assert.match(result.log, /reconciling before attempt 2\/3/);
});
