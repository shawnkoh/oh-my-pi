/**
 * Shared command execution utilities for hooks, custom tools and extensions (`pi.exec`).
 */
import { ptree } from "@oh-my-pi/pi-utils";
import { ownerMarkerEnv } from "../session/owned-job-registry";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal. The child inherits this invocation's owner marker
 * (`OMP_OWNER`), so anything it leaves running is found by the owned-job scan.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const result = await ptree.exec([command, ...args], {
		cwd,
		env: { ...process.env, ...ownerMarkerEnv() },
		signal: options?.signal,
		timeout: options?.timeout,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.exitCode ?? 0,
		killed: Boolean(result.exitError?.aborted),
	};
}
