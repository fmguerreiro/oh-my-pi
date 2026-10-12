/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/7352
 *
 * A headless `omp --mode json --no-session -p @<file>` run with
 * `memory.backend: mnemopi` hung after its turn completed and left an
 * unreaped `__omp_worker_mnemopi_embed` child. The embed-worker IPC request
 * (`embed`) had no timeout, so a wedged native runtime (fastembed /
 * onnxruntime hanging, cf. #4792) blocked whatever awaited the embed — the
 * turn's memory recall or the shutdown consolidation — forever. #5753 only
 * bounded the dispose-time consolidate *await*; the embed IPC underneath it
 * stayed unbounded, so the wedge escaped that budget.
 *
 */
import { describe, expect, it, vi } from "bun:test";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";

/** A fake worker that answers `init` but never answers `embed`. */
function silentEmbedWorker(state: { spawns: number; terminated: number }): () => MnemopiEmbedWorkerHandle {
	return () => {
		state.spawns += 1;
		let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
		return {
			send(message: MnemopiEmbedWorkerInbound) {
				// Reply to init/ping so the model handle resolves, but stay silent
				// on `embed` to simulate a wedged native runtime.
				queueMicrotask(() => {
					if (message.type === "ping") handler?.({ type: "pong", id: message.id });
					else if (message.type === "init") handler?.({ type: "ready", id: message.id });
				});
			},
			onMessage(next) {
				handler = next;
				return () => {
					if (handler === next) handler = undefined;
				};
			},
			onError() {
				return () => {};
			},
			ref() {},
			unref() {},
			async terminate() {
				state.terminated += 1;
				handler = undefined;
			},
		};
	};
}

describe("issue #7352 — mnemopi embed requests are bounded and reap a wedged worker", () => {
	it("fails a wedged embed within the budget instead of hanging forever", async () => {
		const state = { spawns: 0, terminated: 0 };
		const client = new MnemopiEmbedClient(silentEmbedWorker(state), 50);
		try {
			const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			expect(model).not.toBeNull();

			const start = Date.now();
			let threw = false;
			try {
				for await (const _ of model!.embed(["hello"])) {
					/* drain */
				}
			} catch (error) {
				threw = true;
				expect(String(error)).toMatch(/timed out/i);
			}
			expect(threw).toBe(true);
			// Bounded: nowhere near an indefinite hang.
			expect(Date.now() - start).toBeLessThan(5_000);
			// The wedged worker was reaped so it cannot linger as an orphan child.
			expect(state.terminated).toBeGreaterThanOrEqual(1);
		} finally {
			await client.terminate();
		}
	}, 10_000);

	it("respawns a fresh worker for the next request after reaping a wedged one", async () => {
		const state = { spawns: 0, terminated: 0 };
		const client = new MnemopiEmbedClient(silentEmbedWorker(state), 50);
		try {
			const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			const spawnsAfterInit = state.spawns;

			await expect(
				(async () => {
					for await (const _ of model!.embed(["a"])) {
						/* drain */
					}
				})(),
			).rejects.toThrow(/timed out/i);

			// The reap nulled the handle; a second embed must spawn a new child
			// rather than reuse the dead one.
			await expect(
				(async () => {
					for await (const _ of model!.embed(["b"])) {
						/* drain */
					}
				})(),
			).rejects.toThrow(/timed out/i);

			expect(state.spawns).toBeGreaterThan(spawnsAfterInit);
		} finally {
			await client.terminate();
		}
	}, 10_000);

	it("returns unavailable after an init timeout, reaps the worker, and respawns", async () => {
		vi.useFakeTimers();
		const state = { spawns: 0, terminated: 0 };
		const { promise: initStarted, resolve: markInitStarted } = Promise.withResolvers<void>();
		const { promise: terminating, resolve: markTerminating } = Promise.withResolvers<void>();
		const { promise: reaped, resolve: markReaped } = Promise.withResolvers<void>();
		const client = new MnemopiEmbedClient(
			() => {
				const spawn = ++state.spawns;
				let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
				return {
					send(message) {
						if (message.type !== "init") return;
						if (spawn === 1) {
							markInitStarted();
							return;
						}
						queueMicrotask(() => handler?.({ type: "ready", id: message.id }));
					},
					onMessage(next) {
						handler = next;
						return () => {
							if (handler === next) handler = undefined;
						};
					},
					onError() {
						return () => {};
					},
					ref() {},
					unref() {},
					async terminate() {
						state.terminated += 1;
						if (spawn === 1) {
							markTerminating();
							await reaped;
						}
						handler = undefined;
					},
				};
			},
			50,
			50,
		);
		try {
			const first = client.initialize("fast-bge-base-en-v1.5", undefined);
			await initStarted;
			vi.advanceTimersByTime(50);
			await Promise.resolve();
			await Promise.resolve();
			await terminating;
			expect(state.terminated).toBe(1);

			let settled = false;
			void first.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			markReaped();
			expect(await first).toBeNull();
			expect(await client.initialize("fast-bge-base-en-v1.5", undefined)).not.toBeNull();
			expect(state.spawns).toBe(2);
		} finally {
			await client.terminate();
			vi.useRealTimers();
		}
	}, 10_000);

	it("does not cancel another model's in-flight embed when initialization times out", async () => {
		vi.useFakeTimers();
		const terminated: string[] = [];
		const { promise: embedStarted, resolve: markEmbedStarted } = Promise.withResolvers<void>();
		let finishEmbed: (() => void) | undefined;
		const client = new MnemopiEmbedClient(
			model => {
				let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
				return {
					send(message) {
						if (message.type === "init" && model === "fast-ready") {
							queueMicrotask(() => handler?.({ type: "ready", id: message.id }));
						} else if (message.type === "embed") {
							finishEmbed = () => handler?.({ type: "vectors", id: message.id, vectors: [[1, 2]] });
							markEmbedStarted();
						}
					},
					onMessage(next) {
						handler = next;
						return () => {
							if (handler === next) handler = undefined;
						};
					},
					onError() {
						return () => {};
					},
					ref() {},
					unref() {},
					async terminate() {
						terminated.push(model);
					},
				};
			},
			1_000,
			50,
		);
		try {
			const stalled = client.load("fast-stalled", undefined);
			expect(await client.load("fast-ready", undefined)).toBeUndefined();
			const embedding = client.embed("fast-ready", undefined, ["hello"], undefined);
			await embedStarted;
			vi.advanceTimersByTime(50);
			expect(await stalled).toMatch(/timed out/i);
			expect(terminated).toEqual(["fast-stalled"]);
			finishEmbed?.();
			expect(await embedding).toEqual([[1, 2]]);
		} finally {
			await client.terminate();
			vi.useRealTimers();
		}
	}, 10_000);

	it("allows initialization to outlive the steady-state embed budget within its own deadline", async () => {
		vi.useFakeTimers();
		const state = { spawns: 0, terminated: 0 };
		const { promise: initStarted, resolve: markInitStarted } = Promise.withResolvers<void>();
		let completeInit: (() => void) | undefined;
		const client = new MnemopiEmbedClient(
			() => {
				state.spawns += 1;
				let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
				return {
					send(message) {
						if (message.type !== "init") return;
						completeInit = () => handler?.({ type: "ready", id: message.id });
						markInitStarted();
					},
					onMessage(next) {
						handler = next;
						return () => {
							if (handler === next) handler = undefined;
						};
					},
					onError() {
						return () => {};
					},
					ref() {},
					unref() {},
					async terminate() {
						state.terminated += 1;
						handler = undefined;
					},
				};
			},
			50,
			20_000,
		);
		try {
			const initializing = client.initialize("fast-bge-base-en-v1.5", undefined);
			await initStarted;
			vi.advanceTimersByTime(10_000);
			expect(completeInit).toBeDefined();
			completeInit?.();

			const model = await initializing;
			expect(model).not.toBeNull();
			expect(state.spawns).toBe(1);
			expect(state.terminated).toBe(0);
		} finally {
			await client.terminate();
			vi.useRealTimers();
		}
	}, 10_000);
});
