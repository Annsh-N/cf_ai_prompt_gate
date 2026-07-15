export type ConstraintCheckResult = {
  passed: boolean;
  missing: string[];
  constraints: string[];
};

type ConstraintRule = {
  label: string;
  test: (optimized: string) => boolean;
};

function normalize(text: string): string {
  return text.toLowerCase();
}

function countWords(text: string): number {
  const words = text.trim().match(/\b[\p{L}\p{N}'-]+\b/gu);
  return words?.length ?? 0;
}

function extractWordLimit(text: string): ConstraintRule | null {
  const patterns = [
    /(?:under|less than|no more than|at most|maximum of)\s+(\d{1,5})\s+words?/i,
    /(\d{1,5})\s+words?\s+(?:or less|max(?:imum)?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const count = Number(match[1]);
      const label = `at most ${count} words`;
      return {
        label,
        test: (optimized) => countWords(optimized) <= count,
      };
    }
  }
  return null;
}

function extractTone(text: string): ConstraintRule | null {
  const patterns = [
    /tone\s*[:=-]\s*([a-z][a-z \-]{2,})/i,
    /in a\s+([a-z][a-z \-]{2,})\s+tone/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const tone = match[1].trim();
      return {
        label: `tone: ${tone}`,
        test: (optimized) => normalize(optimized).includes(normalize(tone)),
      };
    }
  }
  return null;
}

function extractIncludeExclude(text: string): ConstraintRule[] {
  const rules: ConstraintRule[] = [];
  const includeMatch = text.match(/\binclude\b\s+([^\n.]{3,80})/i);
  if (includeMatch) {
    const phrase = includeMatch[1].trim();
    const label = `include ${phrase}`;
    rules.push({
      label,
      test: (optimized) => normalize(optimized).includes(normalize(phrase)),
    });
  }
  const excludeMatch = text.match(/\bexclude\b\s+([^\n.]{3,80})/i);
  if (excludeMatch) {
    const phrase = excludeMatch[1].trim();
    const label = `exclude ${phrase}`;
    rules.push({
      label,
      test: (optimized) => !normalize(optimized).includes(normalize(phrase)),
    });
  }
  return rules;
}

function hasBulletList(text: string): boolean {
  return /^\s*[-*+]\s+/m.test(text);
}

export function checkConstraints(redactedText: string, optimizedPrompt: string): ConstraintCheckResult {
  const rules: ConstraintRule[] = [];

  const wordRule = extractWordLimit(redactedText);
  if (wordRule) rules.push(wordRule);

  const toneRule = extractTone(redactedText);
  if (toneRule) rules.push(toneRule);

  if (/\bjson\b/i.test(redactedText)) {
    rules.push({
      label: "JSON output",
      test: (optimized) => /\bjson\b/i.test(optimized),
    });
  }

  if (/\bbullet points?\b|\bbulleted list\b|\bbullets\b/i.test(redactedText)) {
    rules.push({
      label: "bullet points",
      test: (optimized) => /\bbullet\b/i.test(optimized) || hasBulletList(optimized),
    });
  }

  rules.push(...extractIncludeExclude(redactedText));

  const missing = rules.filter((rule) => !rule.test(optimizedPrompt)).map((rule) => rule.label);

  return {
    passed: missing.length === 0,
    missing,
    constraints: rules.map((rule) => rule.label),
  };
}
