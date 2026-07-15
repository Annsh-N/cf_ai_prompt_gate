import { describe, expect, it } from "vitest";
import worker from "../../src/worker";

describe("Worker API edge cases", () => {
  it("handles CORS preflight", async () => {
    const response = await worker.fetch(
      new Request("https://promptgate.test/api/compile", { method: "OPTIONS" }),
      {} as any,
      {} as ExecutionContext
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects API calls without a userId before Durable Object routing", async () => {
    const response = await worker.fetch(
      new Request("https://promptgate.test/api/state"),
      {} as any,
      {} as ExecutionContext
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Missing userId",
      code: "missing_user_id",
    });
  });
});
