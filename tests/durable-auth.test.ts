import { describe, expect, it } from "vitest";
import { UserStateDO } from "../src/durable/UserStateDO";

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, value);
      },
      delete: async (key: string) => {
        data.delete(key);
      },
    },
  } as unknown as DurableObjectState & { data: Map<string, unknown> };
}

function request(secret?: string) {
  return new Request("https://promptgate.test/api/state", {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
}

describe("UserStateDO auth", () => {
  it("requires a client secret", async () => {
    const instance = new UserStateDO(fakeState(), { AI: {} });
    const response = await instance.fetch(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "missing_client_secret" });
  });

  it("binds the first bearer secret and rejects later mismatches", async () => {
    const instance = new UserStateDO(fakeState(), { AI: {} });
    const first = await instance.fetch(request("client-secret-abcdefghijklmnopqrstuvwxyz"));
    const second = await instance.fetch(request("client-secret-abcdefghijklmnopqrstuvwxyz"));
    const wrong = await instance.fetch(request("different-secret-abcdefghijklmnopqrstuvwxyz"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: "invalid_client_secret" });
  });
});

