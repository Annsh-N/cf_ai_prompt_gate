export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateTokensForMessages(
  messages: Array<{ role: string; content: string }>
): number {
  const joined = messages.map((m) => m.content).join("\n");
  return estimateTokens(joined);
}
