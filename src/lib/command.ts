import { spawn } from "node:child_process";
import { createWriteStream, WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type CommandResult = {
  stdout: string;
  stderr: string;
  output: string;
};

export type CommandOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  logFile?: string;
  secrets?: string[];
  timeoutMs?: number;
};

export async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const startedAt = Date.now();
  const secrets = options.secrets?.filter(Boolean) ?? [];
  let logStream: WriteStream | null = null;
  if (options.logFile) {
    await mkdir(dirname(options.logFile), { recursive: true });
    logStream = createWriteStream(options.logFile, { flags: "a" });
  }

  const redact = (value: string): string => {
    let result = value;
    for (const secret of secrets) {
      result = result.split(secret).join("***");
    }
    return result;
  };

  const append = (value: string): void => {
    if (logStream) {
      logStream.write(redact(value));
    }
  };

  const renderedCommand = [command, ...args].map((part) => part.includes(" ") ? JSON.stringify(part) : part).join(" ");
  append(`$ ${redact(renderedCommand)}\n`);

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      append(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      append(text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      logStream?.end();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      append(`$ exit=${code ?? "null"} signal=${signal ?? ""} duration_ms=${durationMs}\n`);
      logStream?.end();
      const result = {
        stdout: redact(stdout),
        stderr: redact(stderr),
        output: redact(`${stdout}${stderr}`)
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      reject(Object.assign(new Error(`${command} failed with ${reason}: ${tail(result.output, 3000)}`), { result }));
    });
  });
}

export function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}
