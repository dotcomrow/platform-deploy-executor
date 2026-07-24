import { config } from "../config.js";
import { DeployStepProvider } from "./provider.js";
import { DryRunProvider } from "./dry-run-provider.js";
import { NotImplementedProvider } from "./not-implemented-provider.js";
import { TerraformCloudProvider } from "./terraform-cloud-provider.js";

export function providerForConfiguredMode(): DeployStepProvider {
  if (config.executorMode === "dry_run") {
    return new DryRunProvider();
  }
  if (config.executorMode === "terraform_cloud") {
    return new TerraformCloudProvider();
  }
  return new NotImplementedProvider(config.executorMode);
}
