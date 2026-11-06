import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.MARS_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.MARS_EXPERIMENTAL;
		} else {
			process.env.MARS_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when MARS_EXPERIMENTAL is unset", () => {
		delete process.env.MARS_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MARS_EXPERIMENTAL is empty", () => {
		process.env.MARS_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when MARS_EXPERIMENTAL is set to 1", () => {
		process.env.MARS_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when MARS_EXPERIMENTAL is set to 0", () => {
		process.env.MARS_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MARS_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.MARS_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
