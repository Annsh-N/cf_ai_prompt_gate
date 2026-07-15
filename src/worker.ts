/// <reference types="@cloudflare/workers-types" />
import { UserStateDO } from "./durable/UserStateDO";

export { UserStateDO };

export interface Env {
  AI: any;
  USER_STATE: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status: number, code: string, error: string): Response {
  return withCors(
    new Response(JSON.stringify({ error, code }), {
      status,
      headers: { "content-type": "application/json" },
    })
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname.startsWith("/api/")) {
      let userId = url.searchParams.get("userId");
      if (!userId && request.method === "POST") {
        try {
          const cloned = request.clone();
          const body = (await cloned.json()) as unknown;
          if (body && typeof body === "object" && "userId" in body) {
            const candidate = (body as { userId?: unknown }).userId;
            userId = typeof candidate === "string" ? candidate : null;
          }
        } catch {
          return jsonError(400, "invalid_json", "Invalid JSON");
        }
      }

      if (!userId) {
        return jsonError(400, "missing_user_id", "Missing userId");
      }

      const id = env.USER_STATE.idFromName(userId);
      const stub = env.USER_STATE.get(id);
      const response = await stub.fetch(request);
      return withCors(response);
    }

    return env.ASSETS.fetch(request);
  },
};
