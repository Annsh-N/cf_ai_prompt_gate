type RedactionItem = {
  type: string;
  count: number;
  previews: string[];
};

type RedactionReport = {
  enabled: boolean;
  strict: boolean;
  strictApplied: boolean;
  totalRedactions: number;
  items: RedactionItem[];
};

type RedactionResult = {
  redactedText: string;
  report: RedactionReport;
};

type Pattern = {
  type: string;
  label: string;
  regex: RegExp;
  replace?: (match: string, placeholder: string, groups: string[]) => string;
  extract?: (match: string, groups: string[]) => string;
  test?: (match: string) => boolean;
  strictOnly?: boolean;
};

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX =
  /(^|[^\w])((?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4})(?!\w)/g;
const JWT_REGEX = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const COMMON_SECRET_PATTERNS: Pattern[] = [
  { type: "secret", label: "SECRET", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { type: "secret", label: "SECRET", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { type: "secret", label: "SECRET", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { type: "secret", label: "SECRET", regex: /\bgho_[A-Za-z0-9]{20,}\b/g },
  { type: "secret", label: "SECRET", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { type: "secret", label: "SECRET", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "secret", label: "SECRET", regex: /\bxoxe-[A-Za-z0-9-]{10,}\b/g },
  {
    type: "secret",
    label: "SECRET",
    regex: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{10,})/gi,
    replace: (match, placeholder, groups) => {
      const prefix = match.match(/^\s*Authorization\s*:\s*Bearer\s+/i)?.[0] ?? "";
      return `${prefix}${placeholder}`;
    },
    extract: (_match, groups) => groups[0] ?? "",
  },
  {
    type: "secret",
    label: "SECRET",
    regex: /\bBearer\s+([A-Za-z0-9._~+/=-]{10,})/gi,
    replace: (match, placeholder) => match.replace(/\s+[^\s]+$/, ` ${placeholder}`),
    extract: (_match, groups) => groups[0] ?? "",
  },
  {
    type: "secret",
    label: "SECRET",
    regex: /\b(password|pass|api_key|apikey|token|secret|authorization|bearer)\b\s*[:=]\s*(['"]?)([^\s'"&]+)\2/gi,
    replace: (match, placeholder, groups) => {
      const keyMatch = match.match(/^(\s*[^:=]+?[:=]\s*)/i);
      const key = keyMatch ? keyMatch[1] : "";
      return `${key}${placeholder}`;
    },
    extract: (_match, groups) => groups[2] ?? "",
  },
];

const STRICT_TOKEN_CANDIDATE_REGEX = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;
const COMMON_WORDS = new Set([
  "assistant",
  "instructions",
  "information",
  "requirements",
  "configuration",
  "preferences",
  "context",
  "example",
  "examples",
  "environment",
  "application",
  "development",
  "production",
  "consolidated",
  "definition",
  "parameters",
  "constraints",
  "assignment",
  "implementation",
  "description",
  "miscellaneous",
]);

function hasMixedClasses(value: string): boolean {
  let lower = false;
  let upper = false;
  let digit = false;
  let symbol = false;
  for (const ch of value) {
    if (ch >= "a" && ch <= "z") lower = true;
    else if (ch >= "A" && ch <= "Z") upper = true;
    else if (ch >= "0" && ch <= "9") digit = true;
    else symbol = true;
  }
  const classes = [lower, upper, digit, symbol].filter(Boolean).length;
  return classes >= 2;
}

function looksLikeCommonWord(value: string): boolean {
  const lower = value.toLowerCase();
  if (COMMON_WORDS.has(lower)) return true;
  return /^[a-z]+$/.test(lower) && lower.length <= 24;
}

function looksLikeStrictToken(value: string): boolean {
  const length = value.length;
  if (length < 32) return false;
  const isHex = /^[A-Fa-f0-9]+$/.test(value);
  if (isHex && length < 40) return false;
  const isBase64Url = /^[A-Za-z0-9_-]+$/.test(value);
  const isBase64 = /^[A-Za-z0-9+/=]+$/.test(value);
  if (!isHex && !isBase64Url && !isBase64) return false;
  if (!hasMixedClasses(value)) return false;
  if (looksLikeCommonWord(value)) return false;
  const uniqueRatio = new Set(value).size / length;
  return uniqueRatio >= 0.2;
}

function maskPreview(value: string): string {
  if (!value) return "";
  if (value.length <= 2) return `${value[0] ?? ""}***`;
  if (value.length <= 4) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function createRedactionState() {
  const counters = new Map<string, number>();
  const items = new Map<string, RedactionItem>();
  let strictApplied = false;

  const nextPlaceholder = (label: string, type: string) => {
    const current = counters.get(type) ?? 0;
    const next = current + 1;
    counters.set(type, next);
    return `[${label}_${next}]`;
  };

  const record = (type: string, value: string, source: "pattern" | "strict-heuristic") => {
    const entry = items.get(type) ?? { type, count: 0, previews: [] };
    entry.count += 1;
    if (entry.previews.length < 3) entry.previews.push(maskPreview(value));
    items.set(type, entry);
    if (source === "strict-heuristic") strictApplied = true;
  };

  return { nextPlaceholder, record, items, strictApplied: () => strictApplied };
}

function applyPattern(
  input: string,
  pattern: Pattern,
  state: ReturnType<typeof createRedactionState>
): string {
  return input.replace(pattern.regex, (...args: (string | number)[]) => {
    const match = String(args[0] ?? "");
    const groups = args.slice(1, -2).map((value) => String(value));
    if (pattern.test && !pattern.test(match)) return match;
    const placeholder = state.nextPlaceholder(pattern.label, pattern.type);
    const extracted = pattern.extract ? pattern.extract(match, groups) : match;
    state.record(pattern.type, extracted, pattern.strictOnly ? "strict-heuristic" : "pattern");
    if (pattern.replace) return pattern.replace(match, placeholder, groups);
    return placeholder;
  });
}

export function redactSecrets(text: string, strictMode: boolean): RedactionResult {
  if (!text) {
    return {
      redactedText: "",
      report: { enabled: true, strict: strictMode, strictApplied: false, totalRedactions: 0, items: [] },
    };
  }

  const state = createRedactionState();
  let output = text;

  for (const pattern of COMMON_SECRET_PATTERNS) {
    output = applyPattern(output, pattern, state);
  }

  output = applyPattern(output, { type: "jwt", label: "JWT", regex: JWT_REGEX }, state);
  output = applyPattern(output, { type: "email", label: "EMAIL", regex: EMAIL_REGEX }, state);
  output = applyPattern(
    output,
    {
      type: "phone",
      label: "PHONE",
      regex: PHONE_REGEX,
      replace: (_match, placeholder, groups) => `${groups[0] ?? ""}${placeholder}`,
      extract: (_match, groups) => groups[1] ?? "",
    },
    state
  );

  if (strictMode) {
    output = applyPattern(
      output,
      {
        type: "secret",
        label: "SECRET",
        regex: STRICT_TOKEN_CANDIDATE_REGEX,
        strictOnly: true,
        test: looksLikeStrictToken,
      },
      state
    );
  }

  const items = Array.from(state.items.values());
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return {
    redactedText: output,
    report: {
      enabled: true,
      strict: strictMode,
      strictApplied: strictMode ? state.strictApplied() : false,
      totalRedactions: total,
      items,
    },
  };
}
