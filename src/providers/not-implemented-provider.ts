import { StepExecutionResult } from "../steps/types.js";
import { DeployStepProvider, ProviderExecutionContext } from "./provider.js";

export class NotImplementedProvider implements DeployStepProvider {
  constructor(readonly mode: "terraform_cloud" | "local_terraform") {}

  async execute(_context: ProviderExecutionContext): Promise<StepExecutionResult> {
    throw Object.assign(
      new Error(`${this.mode} execution is not implemented yet. Set EXECUTOR_MODE=dry_run until provider modules are complete.`),
      { status: 501 }
    );
  }
}
