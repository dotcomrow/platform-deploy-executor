import assert from "node:assert/strict";
import test from "node:test";

import { shouldRetryTerraformRun } from "./terraform-cloud-provider.js";
import {
  TerraformCloudRunStalledError,
  TerraformCloudRunTerminalError,
  TerraformCloudRunTimeoutError,
} from "./tfe-client.js";

test("retries stalled, timed-out, and errored Terraform runs before the attempt limit", () => {
  assert.equal(shouldRetryTerraformRun(new TerraformCloudRunStalledError("run-1", "cost_estimating", 900), 1, 3), true);
  assert.equal(shouldRetryTerraformRun(new TerraformCloudRunTimeoutError("run-2", 7200), 1, 3), true);
  assert.equal(shouldRetryTerraformRun(new TerraformCloudRunTerminalError("run-3", "errored"), 1, 3), true);
});

test("does not retry operator-canceled runs or exceed the attempt limit", () => {
  assert.equal(shouldRetryTerraformRun(new TerraformCloudRunTerminalError("run-4", "canceled"), 1, 3), false);
  assert.equal(shouldRetryTerraformRun(new TerraformCloudRunStalledError("run-5", "cost_estimating", 900), 3, 3), false);
});
