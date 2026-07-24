import { config } from "../config.js";
import { DeployStepProvider } from "./provider.js";
import { DryRunProvider } from "./dry-run-provider.js";
import { NotImplementedProvider } from "./not-implemented-provider.js";

export function providerForConfiguredMode(): DeployStepProvider {
  if (config.executorMode === "dry_run") {
    return new DryRunProvider();
  }
  return new NotImplementedProvider(config.executorMode);
}
