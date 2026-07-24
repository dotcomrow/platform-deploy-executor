import { DeployStepProvider, ProviderExecutionContext, buildResult } from "./provider.js";

export class DryRunProvider implements DeployStepProvider {
  readonly mode = "dry_run";

  async execute(context: ProviderExecutionContext) {
    return buildResult(context, this.mode, true, {
      message: "Dry-run step accepted. No Terraform, Cloudflare, GitHub, or app build mutation was performed."
    });
  }
}
