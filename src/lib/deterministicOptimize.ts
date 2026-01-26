export type OptimizationLevel = "light" | "aggressive";

const BOILERPLATE_PATTERNS = [
  /^you are (an )?ai.*$/i,
  /^as an ai.*$/i,
  /^i\'?m an ai.*$/i,
  /^sure, here.*$/i,
  /^please follow these instructions.*$/i,
];

const LIST_ITEM_REGEX = /^\s*(?:[-*+]|\d+[.)])\s+/;

function removeBoilerplate(lines: string[]): string[] {
  return lines.filter((line) => !BOILERPLATE_PATTERNS.some((re) => re.test(line.trim())));
}

function normalizeForCompare(value: string): string {
  return value
    .trim()
    .replace(LIST_ITEM_REGEX, "")
    .replace(/[ \t]+/g, " ")
    .replace(/([!?.,])\1+/g, "$1")
    .replace(/[.!?]+$/g, "")
    .toLowerCase();
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (result[result.length - 1] === "") continue;
      result.push("");
      continue;
    }
    const key = normalizeForCompare(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function compressWhitespace(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function collapseRepeatedSections(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  const seenHeaders = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = /^(task|context|constraints|output format)\s*:?$/i.test(trimmed);
    if (isHeader) {
      const key = trimmed.toLowerCase();
      if (seenHeaders.has(key)) continue;
      seenHeaders.add(key);
    }
    output.push(line);
  }

  return output.join("\n");
}

export function deterministicOptimize(text: string, level: OptimizationLevel): string {
  if (!text) return "";
  let lines = text.split(/\r?\n/);
  lines = removeBoilerplate(lines);
  lines = dedupeLines(lines);
  let result = lines.join("\n");
  if (level === "aggressive") {
    result = collapseRepeatedSections(result);
  }
  return compressWhitespace(result);
}
