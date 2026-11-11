import { createStart, createMiddleware } from "@tanstack/react-start";

// Adds security headers to every response (pages, server functions, API routes).
const securityHeaders = createMiddleware({ type: "request" }).server(async ({ next }) => {
  const result = await next();
  const { buildSecurityHeaders } = await import("@/lib/security.server");
  const headers = buildSecurityHeaders();
  try {
    for (const [k, v] of Object.entries(headers)) result.response.headers.set(k, v);
  } catch {
    // Immutable response: rebuild below.
    const res = result.response;
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    return { ...result, response: new Response(res.body, { status: res.status, statusText: res.statusText, headers: h }) };
  }
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}));
