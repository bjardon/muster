import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function command(
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; allowFailure?: boolean },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout, stderr, exitCode: code ?? 1 };
      if (result.exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${executable} ${args.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`));
      } else {
        resolve(result);
      }
    });
  });
}

export async function shell(
  script: string,
  options: { cwd: string; signal?: AbortSignal; allowFailure?: boolean },
): Promise<CommandResult> {
  return await command("/bin/zsh", ["-lc", script], options);
}
