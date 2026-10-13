import { describe, expect, test } from "bun:test";
import type { Fetch } from "../../src/cli/build-service";
import { fetchAvailableReleaseNotes } from "../../src/utils/changelog";

const changelog = `# Changelog

## [Unreleased]

## [18.10.4] - 2026-10-13

### Added

- Future feature.

## [18.10.3] - 2026-10-12

### Added

- Third release feature.
- Another third release feature.
- Yet another third release feature.

### Fixed

- Third release fix.

## [18.10.2] - 2026-10-12

### Changed

- Second release change.

## [18.10.1] - 2026-10-12

### Fixed

- Installed release fix.
`;

const fetchChangelog: Fetch = async () => new Response(changelog);

describe("available coding-agent release notes", () => {
	test("shows every release after installed version through advertised version, with per-version categories", async () => {
		const summary = await fetchAvailableReleaseNotes("18.10.1", "18.10.3", "summary", fetchChangelog);
		expect(summary).toContain("v18.10.2 · 1 changed\n  • Second release change.");
		expect(summary).toContain("v18.10.3 · 3 added · 1 fixed");
		expect(summary).toContain("Third release feature.");
		expect(summary).not.toContain("Yet another third release feature.");
		expect(summary).not.toContain("Future feature.");
		expect(summary).not.toContain("Installed release fix.");
		expect(summary?.indexOf("v18.10.2")).toBeLessThan(summary?.indexOf("v18.10.3") ?? 0);
		expect(summary).toContain("https://github.com/can1357/oh-my-pi/compare/v18.10.1...v18.10.3");
	});

	test("expanded mode shows more bullets, without including another package's section", async () => {
		const response = `${changelog}\n## @oh-my-pi/pi-ai\n\n### Fixed\n\n- Other package fix.\n`;
		const notes = await fetchAvailableReleaseNotes(
			"18.10.2",
			"18.10.3",
			"expanded",
			async () => new Response(response),
		);
		expect(notes).toContain("Yet another third release feature.");
		expect(notes).not.toContain("Other package fix.");
		expect(notes).not.toContain("Second release change.");
	});

	test("failed or malformed fetch leaves existing update banner without notes", async () => {
		const failed: Fetch = async () => {
			throw new Error("offline");
		};
		expect(await fetchAvailableReleaseNotes("18.10.1", "18.10.3", "summary", failed)).toBeUndefined();
		expect(
			await fetchAvailableReleaseNotes(
				"18.10.1",
				"18.10.3",
				"summary",
				async () => new Response("rate limited", { status: 429 }),
			),
		).toBeUndefined();
		expect(
			await fetchAvailableReleaseNotes(
				"18.10.1",
				"18.10.3",
				"summary",
				async () => new Response("## [18.10.2]\n- Older only"),
			),
		).toBeUndefined();
		expect(
			await fetchAvailableReleaseNotes(
				"18.10.1",
				"18.10.3",
				"summary",
				async () => new Response("## [18.10.3]\nNo release bullets"),
			),
		).toBeUndefined();
	});

	test("hidden mode does not fetch release notes", async () => {
		const unexpected: Fetch = async () => {
			throw new Error("must not fetch");
		};
		expect(await fetchAvailableReleaseNotes("18.10.1", "18.10.3", "hidden", unexpected)).toBeUndefined();
	});
});
