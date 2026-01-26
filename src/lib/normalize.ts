const BOILERPLATE_PATTERNS = [
  "you are an expert assistant",
  "please be concise",
  "use bullet points",
];

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "");
}

function collapseSpaces(value: string): string {
  return value.replace(/[ \t]+/g, " ").trim();
}

function normalizeForCompare(value: string): string {
  return stripTrailingPunctuation(collapseSpaces(value)).toLowerCase();
}

function stripListPrefix(value: string): string {
  return value.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

function splitSentences(value: string): string[] {
  return value.split(/(?<=[.!?])\s+/).filter(Boolean);
}

export function normalizeForOptimization(text: string): {
  text: string;
  removedDuplicateLines: number;
  removedDuplicateSentences: number;
} {
  if (!text) {
    return { text: "", removedDuplicateLines: 0, removedDuplicateSentences: 0 };
  }

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const seenLines = new Set<string>();
  const seenBoilerplate = new Set<string>();
  const output: string[] = [];
  let removedDuplicateLines = 0;
  let removedDuplicateSentences = 0;
  let lastWasEmpty = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (lastWasEmpty) {
        removedDuplicateLines += 1;
        continue;
      }
      output.push("");
      lastWasEmpty = true;
      continue;
    }

    lastWasEmpty = false;

    let line = collapseSpaces(trimmed);
    let sentenceRemoved = 0;

    if (/[.!?]/.test(line)) {
      const sentences = splitSentences(line);
      const seenSentence = new Set<string>();
      const kept: string[] = [];
      for (const sentence of sentences) {
        const key = normalizeForCompare(sentence);
        if (seenSentence.has(key)) {
          sentenceRemoved += 1;
          continue;
        }
        seenSentence.add(key);
        kept.push(sentence.trim());
      }
      if (kept.length) {
        line = kept.join(" ").trim();
      }
    }

    removedDuplicateSentences += sentenceRemoved;

    if (!line) {
      removedDuplicateLines += 1;
      continue;
    }

    const boilerplateKey = normalizeForCompare(stripListPrefix(line));
    if (BOILERPLATE_PATTERNS.includes(boilerplateKey)) {
      if (seenBoilerplate.has(boilerplateKey)) {
        removedDuplicateLines += 1;
        continue;
      }
      seenBoilerplate.add(boilerplateKey);
    }

    const lineKey = normalizeForCompare(line);
    if (seenLines.has(lineKey)) {
      removedDuplicateLines += 1;
      continue;
    }
    seenLines.add(lineKey);
    output.push(line);
  }

  const normalizedText = output
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: normalizedText,
    removedDuplicateLines,
    removedDuplicateSentences,
  };
}
