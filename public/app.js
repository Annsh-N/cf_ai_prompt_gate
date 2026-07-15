const el = (id) => document.getElementById(id);

const state = {
  userId: "",
  clientSecret: "",
  processing: false,
};

const elements = {
  userId: el("userId"),
  copyUserId: el("copyUserId"),
  openSettings: el("openSettings"),
  closeSettings: el("closeSettings"),
  settingsModal: el("settingsModal"),
  secretsProtection: el("secretsProtection"),
  strictMode: el("strictMode"),
  optimize: el("optimize"),
  optimizeLevel: el("optimizeLevel"),
  checksEnabled: el("checksEnabled"),
  dailyBudget: el("dailyBudget"),
  rpmLimit: el("rpmLimit"),
  saveSettings: el("saveSettings"),
  messageInput: el("messageInput"),
  sendBtn: el("sendBtn"),
  conversation: el("conversation"),
  historyList: el("historyList"),
  clearHistory: el("clearHistory"),
};

function generateUserId() {
  return crypto.randomUUID();
}

function generateClientSecret() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

function loadUserId() {
  const stored = localStorage.getItem("promptgate_userId");
  const storedSecret = localStorage.getItem("promptgate_clientSecret");
  state.userId = stored || generateUserId();
  state.clientSecret = storedSecret || generateClientSecret();
  localStorage.setItem("promptgate_userId", state.userId);
  localStorage.setItem("promptgate_clientSecret", state.clientSecret);
  elements.userId.value = state.userId;
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${state.clientSecret}`,
  };
}

function collectSettings() {
  return {
    secretsProtection: elements.secretsProtection.checked,
    strictMode: elements.strictMode.checked,
    optimize: elements.optimize.checked,
    optimizeLevel: elements.optimizeLevel.value,
    checksEnabled: elements.checksEnabled.checked,
    dailyBudget: Number(elements.dailyBudget.value),
    rpmLimit: Number(elements.rpmLimit.value),
  };
}

function applySettings(settings) {
  if (!settings) return;
  elements.secretsProtection.checked = !!settings.secretsProtection;
  elements.strictMode.checked = !!settings.strictMode;
  elements.optimize.checked = !!settings.optimize;
  elements.optimizeLevel.value = settings.optimizeLevel || "light";
  elements.checksEnabled.checked = !!settings.checksEnabled;
  elements.dailyBudget.value = settings.dailyBudget ?? 20000;
  elements.rpmLimit.value = settings.rpmLimit ?? 20;
}

async function fetchState() {
  const res = await fetch(`/api/state?userId=${encodeURIComponent(state.userId)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return;
  const data = await res.json();
  applySettings(data.settings);
}

async function fetchHistory() {
  const res = await fetch(`/api/history?userId=${encodeURIComponent(state.userId)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return;
  const data = await res.json();
  renderHistory(data.entries || []);
}

async function saveSettings() {
  const payload = {
    userId: state.userId,
    settings: collectSettings(),
  };
  const res = await fetch("/api/state", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    alert("Failed to save settings");
    return;
  }
  const data = await res.json();
  applySettings(data.settings);
  toggleSettings(false);
}

async function clearHistory() {
  const res = await fetch("/api/clear-history", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ userId: state.userId }),
  });
  if (!res.ok) {
    alert("Failed to clear history");
    return;
  }
  await fetchHistory();
}

function toggleSettings(open) {
  elements.settingsModal.classList.toggle("hidden", !open);
  elements.settingsModal.setAttribute("aria-hidden", String(!open));
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function legacyCopy(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let success = false;
  try {
    if (document.execCommand) success = document.execCommand("copy");
  } catch {
    success = false;
  }
  document.body.removeChild(textarea);
  if (success) return true;

  const editable = document.createElement("div");
  editable.textContent = value;
  editable.contentEditable = "true";
  editable.style.position = "fixed";
  editable.style.top = "0";
  editable.style.left = "0";
  editable.style.opacity = "0";
  editable.style.pointerEvents = "none";
  document.body.appendChild(editable);
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editable);
  selection?.removeAllRanges();
  selection?.addRange(range);
  try {
    if (document.execCommand) success = document.execCommand("copy");
  } catch {
    success = false;
  }
  selection?.removeAllRanges();
  document.body.removeChild(editable);
  return success;
}

async function copyText(value) {
  if (!value) return false;

  if (legacyCopy(value)) return true;

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function flashButton(button, label) {
  if (!button) return;
  const original = button.textContent || "";
  const target = label || "Copied";
  button.textContent = target;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1000);
}

function buildExchange(originalMessage) {
  const exchange = document.createElement("div");
  exchange.className = "exchange";
  exchange.dataset.id = crypto.randomUUID();

  const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  exchange.innerHTML = `
    <div class="exchange-header">
      <span>Original</span>
      <span>${timestamp}</span>
    </div>
    <div class="original-message"></div>
    <div class="compiled-block">
      <div class="section-title">Compiled prompt</div>
      <div class="code-box primary" data-role="compiled"></div>
      <div class="action-row">
        <button class="ghost" data-role="copy-compiled">Copy compiled prompt</button>
      </div>
    </div>
    <div class="metrics">
      <div class="metrics-grid" data-role="metrics"></div>
      <div class="metrics-actions">
        <button class="inline-link" data-role="copy-metrics">Copy metrics JSON</button>
      </div>
    </div>
    <div class="error-banner hidden" data-role="error"></div>
  `;

  exchange.querySelector(".original-message").textContent = originalMessage;

  const copyCompiled = exchange.querySelector('[data-role="copy-compiled"]');
  copyCompiled.addEventListener("click", async () => {
    const compiled = exchange.querySelector('[data-role="compiled"]').textContent || "";
    const ok = await copyText(compiled);
    flashButton(copyCompiled, ok ? "Copied" : "Copy failed");
  });

  const copyMetrics = exchange.querySelector('[data-role="copy-metrics"]');
  copyMetrics.addEventListener("click", async () => {
    const metrics = exchange.dataset.metricsJson || "{}";
    const ok = await copyText(metrics);
    flashButton(copyMetrics, ok ? "Copied" : "Copy failed");
  });

  elements.conversation.prepend(exchange);
  return exchange;
}

function formatRedactionSummary(items) {
  if (!items || !items.length) return "None";
  return items.map((item) => `${item.type}: ${item.count}`).join(", ");
}

function formatRedactionPreviews(items) {
  if (!items || !items.length) return "";
  return items
    .map((item) => `${item.type}: ${item.previews.join(" ")}`)
    .join(" | ");
}

function appendMetric(parent, label, valueNode) {
  const metric = document.createElement("div");
  metric.className = "metric";
  const strong = document.createElement("strong");
  strong.textContent = label;
  const span = document.createElement("span");
  if (valueNode instanceof Node) {
    span.appendChild(valueNode);
  } else {
    span.textContent = String(valueNode);
  }
  metric.append(strong, span);
  parent.appendChild(metric);
}

function badge(label, kind = "") {
  const item = document.createElement("span");
  item.className = kind ? `badge ${kind}` : "badge";
  item.textContent = label;
  return item;
}

function setMetrics(exchange, report) {
  const metrics = exchange.querySelector('[data-role="metrics"]');
  if (!metrics || !report) return;

  const tokens = report.tokens || {};
  const cost = report.cost || {};
  const cache = report.cache || {};
  const timing = report.timing_ms || {};
  const usage = report.usage || {};
  const redactionReport = report.redactionReport || { totalRedactions: 0, items: [] };
  const checks = report.checks || {};

  const checksPassed =
    checks.constraintCheck?.passed && (checks.meaningCheck?.passed ?? true) && !checks.optimizationFailed;
  const redactionSummary = formatRedactionSummary(redactionReport.items);
  const redactionPreviews = formatRedactionPreviews(redactionReport.items);

  metrics.replaceChildren();

  appendMetric(metrics, "Tokens", `${tokens.original_est} -> ${tokens.compiled_est} (${tokens.saved_pct}%)`);
  appendMetric(
    metrics,
    "Cost",
    `${formatMoney(cost.original_est_usd)} -> ${formatMoney(cost.compiled_est_usd)} (${cost.saved_pct}%)`
  );

  const cacheNode = document.createDocumentFragment();
  cacheNode.appendChild(cache.hit ? badge("HIT", "success") : badge("MISS", "warning"));
  if (cache.key_short) cacheNode.append(` #${cache.key_short}`);
  appendMetric(metrics, "Cache", cacheNode);

  appendMetric(metrics, "Timing", `${timing.redaction}ms / ${timing.normalization}ms / ${timing.optimize_llm}ms`);
  appendMetric(metrics, "Redactions", redactionSummary);

  const checksNode = checks.enabled
    ? badge(checksPassed ? "PASS" : "ISSUES", checksPassed ? "success" : "error")
    : badge("OFF");
  appendMetric(metrics, "Checks", checksNode);
  appendMetric(metrics, "Budget", `${usage.daily_remaining_tokens} remaining`);
  appendMetric(metrics, "RPM", `${usage.rpm_used}/${usage.rpm_limit}`);

  if (redactionPreviews) {
    appendMetric(metrics, "Redaction previews", redactionPreviews);
  }

  exchange.dataset.metricsJson = JSON.stringify(report, null, 2);
}

function setCompiledPrompt(exchange, text) {
  const compiled = exchange.querySelector('[data-role="compiled"]');
  compiled.textContent = text || "";
}

function setError(exchange, message) {
  const errorBanner = exchange.querySelector('[data-role="error"]');
  if (!message) {
    errorBanner.classList.add("hidden");
    errorBanner.textContent = "";
    return;
  }
  errorBanner.classList.remove("hidden");
  errorBanner.textContent = message;
}

async function sendCompile(message, exchange) {
  const payload = {
    userId: state.userId,
    text: message,
    settingsOverride: collectSettings(),
  };

  const res = await fetch("/api/compile", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  setCompiledPrompt(exchange, data.compiledPrompt || "");
  setMetrics(exchange, data.report);
  setError(exchange, data.error);

  if (res.ok) {
    await fetchHistory();
  }
}

async function handleSend() {
  const message = elements.messageInput.value.trim();
  if (!message || state.processing) return;

  state.processing = true;
  elements.messageInput.value = "";
  elements.messageInput.disabled = true;
  elements.sendBtn.disabled = true;

  const exchange = buildExchange(message);
  setCompiledPrompt(exchange, "Processing...");

  try {
    await sendCompile(message, exchange);
  } finally {
    state.processing = false;
    elements.messageInput.disabled = false;
    elements.sendBtn.disabled = false;
    elements.messageInput.focus();
  }
}

function renderHistory(entries) {
  elements.historyList.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "No history yet.";
    elements.historyList.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const timestamp = new Date(entry.timestamp).toLocaleString();
    const savings = entry.report?.tokens?.saved_pct ?? 0;
    const header = document.createElement("header");
    const timestampNode = document.createElement("span");
    timestampNode.textContent = timestamp;
    const savingsNode = document.createElement("span");
    savingsNode.textContent = `${savings}% saved`;
    header.append(timestampNode, savingsNode);

    const body = document.createElement("div");
    body.className = "history-body";
    body.textContent = entry.compiledPrompt || "";

    const actionRow = document.createElement("div");
    actionRow.className = "action-row";
    const copyBtn = document.createElement("button");
    copyBtn.className = "ghost";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy compiled";
    actionRow.appendChild(copyBtn);
    item.append(header, body, actionRow);

    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(entry.compiledPrompt || "");
      flashButton(copyBtn, ok ? "Copied" : "Copy failed");
    });

    elements.historyList.appendChild(item);
  });
}

function wireEvents() {
  elements.saveSettings.addEventListener("click", saveSettings);
  elements.sendBtn.addEventListener("click", handleSend);
  elements.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });
  elements.copyUserId.addEventListener("click", async () => {
    const ok = await copyText(state.userId);
    flashButton(elements.copyUserId, ok ? "Copied" : "Copy failed");
  });
  elements.userId.addEventListener("change", () => {
    state.userId = elements.userId.value.trim();
    localStorage.setItem("promptgate_userId", state.userId);
    fetchState();
    fetchHistory();
  });
  elements.openSettings.addEventListener("click", () => toggleSettings(true));
  elements.closeSettings.addEventListener("click", () => toggleSettings(false));
  elements.settingsModal.addEventListener("click", (event) => {
    if (event.target === elements.settingsModal) {
      toggleSettings(false);
    }
  });
  elements.clearHistory.addEventListener("click", clearHistory);
}

loadUserId();
fetchState();
fetchHistory();
wireEvents();
