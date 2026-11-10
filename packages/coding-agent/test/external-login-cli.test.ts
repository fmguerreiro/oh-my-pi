import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test("a failed external login does not report success for an existing session", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omp-external-login-"));
	const agentDir = path.join(root, ".omp", "agent");
	try {
		await mkdir(path.join(agentDir, "extensions"), { recursive: true });
		await writeFile(
			path.join(agentDir, "extensions", "external.ts"),
			`export default function (pi) {
	pi.registerProvider("external-test", {
		externalLogin: {
			name: "External Test",
			loginCommand: [${JSON.stringify(process.execPath)}, "-e", "process.exit(2)"],
			statusCommand: [${JSON.stringify(process.execPath)}, "-e", "process.exit(0)"],
		},
	});
}`,
		);
		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "login", "external-test"],
			{
				cwd: root,
				env: { ...process.env, PI_CONFIG_DIR: path.join(root, ".omp"), PI_CODING_AGENT_DIR: agentDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("login command exited with code 2");
		expect(stdout).not.toContain("Logged in to External Test");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
