import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("browser source safety", () => {
  const app = readFileSync("public/app.js", "utf8");

  it("does not render compiled history entries through template innerHTML", () => {
    expect(app).not.toContain('<div class="history-body">${entry.compiledPrompt}</div>');
    expect(app).toContain("body.textContent = entry.compiledPrompt || \"\"");
  });

  it("sends bearer auth on API calls", () => {
    expect(app).toContain("Authorization: `Bearer ${state.clientSecret}`");
  });
});

