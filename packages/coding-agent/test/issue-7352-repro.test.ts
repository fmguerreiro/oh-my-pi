import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ManagedChild, ModuleClient, ModuleContext, ModuleTunnel } from "../src/daemon/module";
import { INFER_EMBED_TIMEOUT_MS, INFER_INITIALIZATION_TIMEOUT_MS, inferModule } from "../src/daemon/modules/infer";
import { GLOBAL_SCOPE } from "../src/daemon/protocol";

const client: ModuleClient = { connectionId: "test", pid: 1, build: "test" };
const encoder = new TextEncoder();

afterEach(() => vi.useRealTimers());

/** Exercise the daemon's routing and reaping without a native embedding runtime. */
async function harness() {
	const children: { child: ManagedChild; killed: string[] }[] = [];
	const context: ModuleContext = {
		stateDir: "",
		spawn() {
			const killed: string[] = [];
			const { promise: exited, resolve } = Promise.withResolvers<{ signal?: number }>();
			const child: ManagedChild = {
				pid: children.length + 1,
				write: () => true,
				drained: async () => {},
				onStdout: () => {},
				onStderr: () => {},
				exited,
				kill(signal) {
					killed.push(signal ?? "SIGTERM");
					resolve({ signal: 9 });
				},
				pauseOutput: async () => {},
				resumeOutput: () => {},
				state: () => ({ pid: 1, startedAt: 0, stdin: 0, stdout: 0, stderr: 0 }),
			};
			children.push({ child, killed });
			return child;
		},
		adoptChild: () => undefined,
		changed: () => {},
		unit: () => undefined,
	};
	const unit = await inferModule.open(context, {
		unitId: "test",
		scope: GLOBAL_SCOPE,
		key: "test",
		client,
		params: { worker: "embed", label: "embed", application: "worker", args: [], cwd: "/", env: {} },
	});
	const replies: { type: string; id: string; error?: string }[] = [];
	let receive: (chunk: Uint8Array) => void = () => {};
	let close: () => void = () => {};
	const tunnel: ModuleTunnel = {
		client,
		send(data) {
			replies.push(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)));
			return true;
		},
		drained: async () => {},
		start(onData, onClose) {
			receive = onData;
			close = onClose;
		},
		close() {
			close();
		},
	};
	await unit.attach(tunnel, undefined);
	return {
		unit,
		children,
		replies,
		send: (type: string, id: string) => receive(encoder.encode(`${JSON.stringify({ type, id })}\n`)),
		close: () => close(),
	};
}

describe("issue #7352: wedged embedding workers", () => {
	it("kills a stalled embed, fails the request, and starts a new child on the next request", async () => {
		vi.useFakeTimers();
		const h = await harness();
		h.send("embed", "first");
		vi.advanceTimersByTime(INFER_EMBED_TIMEOUT_MS);
		expect(h.children[0].killed).toEqual(["SIGKILL"]);
		expect(h.replies).toEqual([{ type: "error", id: "first", error: "embed request timed out" }]);
		h.send("embed", "second");
		expect(h.children).toHaveLength(2);
		await h.unit.stop("test complete");
	});

	it("gives initialization its longer deadline, then kills a stalled child", async () => {
		vi.useFakeTimers();
		const h = await harness();
		h.send("init", "load");
		vi.advanceTimersByTime(INFER_EMBED_TIMEOUT_MS);
		expect(h.children[0].killed).toEqual([]);
		vi.advanceTimersByTime(INFER_INITIALIZATION_TIMEOUT_MS - INFER_EMBED_TIMEOUT_MS);
		expect(h.children[0].killed).toEqual(["SIGKILL"]);
		expect(h.replies).toEqual([{ type: "error", id: "load", error: "embed request timed out" }]);
		await h.unit.stop("test complete");
	});

	it("still reaps a stalled initialization after its client disconnects", async () => {
		vi.useFakeTimers();
		const h = await harness();
		h.send("init", "load");
		h.close();
		expect(h.unit.busy()).toBe(false);
		vi.advanceTimersByTime(INFER_INITIALIZATION_TIMEOUT_MS);
		expect(h.children[0].killed).toEqual(["SIGKILL"]);
		expect(h.replies).toEqual([]);
		await h.unit.stop("test complete");
	});

	it("does not kill another model when initialization times out", async () => {
		vi.useFakeTimers();
		const stalled = await harness();
		const other = await harness();
		stalled.send("init", "load");
		vi.advanceTimersByTime(INFER_INITIALIZATION_TIMEOUT_MS);
		expect(stalled.children[0].killed).toEqual(["SIGKILL"]);
		expect(other.children[0].killed).toEqual([]);
		await stalled.unit.stop("test complete");
		await other.unit.stop("test complete");
	});
});
