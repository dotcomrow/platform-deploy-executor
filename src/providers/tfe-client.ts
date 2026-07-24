import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { request as undiciRequest } from "undici";
import { config } from "../config.js";
import { runCommand } from "../lib/command.js";
import { httpJson } from "../lib/http.js";
import { asRecord, asString, JsonRecord, truncate } from "../lib/json.js";

type TfeClientOptions = {
  apiBase: string;
  token: string;
  organization: string;
  logFile: string;
  redactedValues: string[];
};

export type TerraformVar = {
  key: string;
  value: string;
  description: string;
  hcl?: boolean;
  sensitive?: boolean;
};

export class TfeClient {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly organization: string;
  private readonly logFile: string;
  private readonly redactedValues: string[];

  constructor(options: TfeClientOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, "");
    this.token = options.token;
    this.organization = options.organization;
    this.logFile = options.logFile;
    this.redactedValues = options.redactedValues;
  }

  async lookupProjectId(projectName: string): Promise<string> {
    const response = await this.request<JsonRecord>("GET", `/organizations/${encodeURIComponent(this.organization)}/projects?page%5Bsize%5D=100`);
    const data = Array.isArray(response.data) ? response.data.map(asRecord).filter(Boolean) as JsonRecord[] : [];
    const exact = data.find((project) => asString(asRecord(project.attributes)?.name).toLowerCase() === projectName.toLowerCase());
    const contains = data.find((project) => asString(asRecord(project.attributes)?.name).toLowerCase().includes(projectName.toLowerCase()));
    const id = asString((exact ?? contains)?.id);
    if (!id) {
      throw new Error(`Unable to resolve Terraform Cloud project id for '${projectName}'.`);
    }
    return id;
  }

  async createOrGetWorkspace(workspaceName: string, projectId: string, agentPoolId: string): Promise<string> {
    const path = `/organizations/${encodeURIComponent(this.organization)}/workspaces/${encodeURIComponent(workspaceName)}`;
    const lookup = await this.raw<JsonRecord>("GET", path);
    let workspaceId = "";
    if (lookup.statusCode === 200) {
      const payload = asRecord(lookup.payload) ?? {};
      workspaceId = asString(asRecord(payload.data)?.id);
    } else if (lookup.statusCode === 404) {
      const created = await this.request<JsonRecord>("POST", `/organizations/${encodeURIComponent(this.organization)}/workspaces`, {
        data: {
          attributes: {
            name: workspaceName,
            "execution-mode": "agent",
            "agent-pool-id": agentPoolId,
            "setting-overwrites": { "execution-mode": true, "agent-pool": true },
            "auto-apply": true
          },
          type: "workspaces",
          relationships: {
            project: {
              data: { type: "projects", id: projectId }
            }
          }
        }
      });
      workspaceId = asString(asRecord(created.data)?.id);
    } else {
      throw new Error(`Failed to lookup Terraform Cloud workspace ${workspaceName}: HTTP ${lookup.statusCode} ${truncate(lookup.text, 700)}`);
    }

    if (!workspaceId) {
      throw new Error(`Terraform Cloud did not return an id for workspace ${workspaceName}.`);
    }

    await this.request<JsonRecord>("PATCH", path, {
      data: {
        type: "workspaces",
        attributes: {
          "execution-mode": "agent",
          "agent-pool-id": agentPoolId,
          "setting-overwrites": { "execution-mode": true, "agent-pool": true },
          "auto-apply": true
        }
      }
    });
    return workspaceId;
  }

  async upsertTerraformVars(workspaceId: string, variables: TerraformVar[]): Promise<void> {
    const existingResponse = await this.request<JsonRecord>("GET", `/workspaces/${encodeURIComponent(workspaceId)}/vars`);
    const existing = Array.isArray(existingResponse.data) ? existingResponse.data.map(asRecord).filter(Boolean) as JsonRecord[] : [];
    for (const variable of variables) {
      if (variable.value === "") {
        continue;
      }
      const current = existing.find((item) => {
        const attributes = asRecord(item.attributes) ?? {};
        return asString(attributes.key) === variable.key && asString(attributes.category) === "terraform";
      });
      const body = {
        data: {
          type: "vars",
          attributes: {
            key: variable.key,
            value: variable.value,
            description: variable.description,
            category: "terraform",
            hcl: Boolean(variable.hcl),
            sensitive: Boolean(variable.sensitive)
          },
          relationships: {
            workspace: {
              data: { id: workspaceId, type: "workspaces" }
            }
          }
        }
      };
      if (current?.id) {
        await this.request<JsonRecord>("PATCH", `/vars/${encodeURIComponent(asString(current.id))}`, body);
      } else {
        await this.request<JsonRecord>("POST", "/vars", body);
      }
    }
  }

  async uploadConfiguration(workspaceId: string, terraformDir: string, operationDir: string): Promise<string> {
    const created = await this.request<JsonRecord>("POST", `/workspaces/${encodeURIComponent(workspaceId)}/configuration-versions`, {
      data: {
        type: "configuration-versions",
        attributes: {
          "auto-queue-runs": false
        }
      }
    });
    const data = asRecord(created.data) ?? {};
    const configVersionId = asString(data.id);
    const uploadUrl = asString(asRecord(data.attributes)?.["upload-url"]);
    if (!configVersionId || !uploadUrl) {
      throw new Error("Terraform Cloud did not return a configuration version id and upload URL.");
    }

    const tarball = join(operationDir, `tfc-config-${workspaceId}.tgz`);
    await runCommand("tar", ["-czf", tarball, "-C", terraformDir, "."], {
      logFile: this.logFile,
      secrets: this.redactedValues,
      timeoutMs: 5 * 60 * 1000
    });
    const body = await readFile(tarball);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs * 4);
    try {
      const response = await undiciRequest(uploadUrl, {
        method: "PUT",
        body,
        headers: { "content-type": "application/octet-stream" },
        signal: controller.signal
      });
      const text = await response.body.text();
      if (response.statusCode < 200 || response.statusCode > 299) {
        throw new Error(`Failed to upload Terraform Cloud configuration: HTTP ${response.statusCode} ${truncate(text, 700)}`);
      }
    } finally {
      clearTimeout(timer);
    }
    return configVersionId;
  }

  async createRun(workspaceId: string, configVersionId: string, message: string, destroy: boolean): Promise<string> {
    const response = await this.request<JsonRecord>("POST", "/runs", {
      data: {
        type: "runs",
        attributes: {
          message,
          "is-destroy": destroy
        },
        relationships: {
          workspace: { data: { type: "workspaces", id: workspaceId } },
          "configuration-version": { data: { type: "configuration-versions", id: configVersionId } }
        }
      }
    });
    const runId = asString(asRecord(response.data)?.id);
    if (!runId) {
      throw new Error("Terraform Cloud did not return a run id.");
    }
    return runId;
  }

  runUrl(workspaceName: string, runId: string): string {
    return `https://app.terraform.io/app/${encodeURIComponent(this.organization)}/workspaces/${encodeURIComponent(workspaceName)}/runs/${encodeURIComponent(runId)}`;
  }

  async pollRun(runId: string, timeoutSeconds: number, pollSeconds: number): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const response = await this.request<JsonRecord>("GET", `/runs/${encodeURIComponent(runId)}`);
      const status = asString(asRecord(asRecord(response.data)?.attributes)?.status);
      await appendFile(this.logFile, `[tfe] run ${runId} status=${status || "unknown"}\n`, "utf8");
      if (["applied", "planned_and_finished"].includes(status)) {
        return status;
      }
      if (["errored", "canceled", "discarded", "force_canceled"].includes(status)) {
        throw new Error(`Terraform Cloud run ${runId} ended with status '${status}'.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
    throw new Error(`Timed out waiting for Terraform Cloud run ${runId}.`);
  }

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const result = await this.raw<T>(method, path, body);
    if (result.statusCode >= 400) {
      throw new Error(`Terraform Cloud ${method} ${path} failed: HTTP ${result.statusCode} ${truncate(result.text, 900)}`);
    }
    return result.payload;
  }

  private async raw<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown) {
    return httpJson<T>(`${this.apiBase}${path}`, {
      method,
      body,
      timeoutMs: config.requestTimeoutMs,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/vnd.api+json"
      }
    });
  }
}
