import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

/** The gateway's JSON shape when its own upstream retries are exhausted. */
const SERVER_ERROR_BODY = JSON.stringify({
	error: {
		message: "Upstream connection failed before the request could be processed. Please retry.",
		type: "server_error",
		code: 502,
	},
});
const CF_PAGE_BODY = JSON.stringify({
	error_category: "origin",
	retryable: true,
	retry_after: 60,
	cloudflare_error: true,
});
const CF_HTML_BODY = `<!DOCTYPE html><html><head><title>502 Bad Gateway | Cloudflare</title></head><body></body></html>`;
const UPSTREAM_MODEL_ERROR_BODY = JSON.stringify({
	error: { message: "Upstream error: model overloaded (provider outage)", type: "upstream_error", code: 500 },
});

function providerError(status: number | undefined, headers?: Record<string, string>, body?: string): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
		...(body !== undefined ? { body } : {}),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries transient gateway errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(502, undefined, SERVER_ERROR_BODY))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(1200);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("retries Cloudflare error pages and HTML pages", async () => {
		vi.useFakeTimers();
		// CF_PAGE_BODY carries retry_after: 60, capped to 15s; the HTML page has
		// no delay field and uses the 1s backoff step.
		const cases: Array<[string, number]> = [
			[CF_PAGE_BODY, 15_000],
			[CF_HTML_BODY, 1_200],
		];
		for (const [body, delay] of cases) {
			const request = vi
				.fn<() => Promise<string>>()
				.mockRejectedValueOnce(providerError(529, undefined, body))
				.mockResolvedValue("ok");

			const result = retryProviderRequest(request, { maxRetries: 1 });
			await vi.advanceTimersByTimeAsync(delay);
			await expect(result).resolves.toBe("ok");
			expect(request).toHaveBeenCalledTimes(2);
		}
	});

	it("retries server-requested retry-after-ms delays", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(502, { "retry-after-ms": "1000" }, SERVER_ERROR_BODY))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("honors a body retry_after capped at 15 seconds", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(529, undefined, CF_PAGE_BODY))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(14_999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry model-upstream 5xx errors", async () => {
		const error = providerError(500, undefined, UPSTREAM_MODEL_ERROR_BODY);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 3 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry bare 429 or other non-gateway statuses", async () => {
		for (const status of [429, 401, 403, 500]) {
			const error = providerError(status);
			const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

			await expect(retryProviderRequest(request, { maxRetries: 3 })).rejects.toBe(error);
			expect(request).toHaveBeenCalledTimes(1);
		}
	});

	it("retries errors the provider marks as retryable via header", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(400, { "x-should-retry": "true", "retry-after-ms": "100" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(100);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(502, { "x-should-retry": "false" }, SERVER_ERROR_BODY);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry statuses listed in noRetryStatuses", async () => {
		const error = providerError(502, { "retry-after-ms": "0" }, SERVER_ERROR_BODY);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2, noRetryStatuses: [502] })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(providerError(502, { "retry-after": "277403" }, SERVER_ERROR_BODY));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(502, { "retry-after": "2" }, SERVER_ERROR_BODY))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(providerError(502, { "retry-after": "277403" }, SERVER_ERROR_BODY));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops after maxRetries exhausted", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(providerError(502, undefined, SERVER_ERROR_BODY));

		const result = retryProviderRequest(request, { maxRetries: 2 });
		// Attach the rejection expectation before advancing: the final attempt
		// rejects during the last timer tick, and an unhandled rejection is
		// reported otherwise.
		const rejection = expect(result).rejects.toThrow("Provider error: 502");
		// Two backoff delays: 1s and 3s, each ±20%.
		await vi.advanceTimersByTimeAsync(1200 + 3600);
		await rejection;
		expect(request).toHaveBeenCalledTimes(3);
	});
});
