import "./style.css";
import "@fontsource/comic-neue/400.css";

declare const __MANAGED_ORACLE__: boolean;
declare const __ORACLE_SUPPORTS_VISION__: boolean;
declare const __ORACLE_ENDPOINT__: string;
declare const __DEFAULT_ORACLE_URL__: string;
declare const __DEFAULT_ORACLE_MODEL__: string;

type Tool = "pen" | "eraser";
type ReplyFont = "script" | "comic" | "book" | "typewriter";

interface InkPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  altitude: number;
  azimuth: number;
  time: number;
}

interface Stroke {
  id: string;
  pointerType: string;
  points: InkPoint[];
}

interface DiaryEntry {
  id: string;
  createdAt: string;
  transcript: string;
  reply: string;
  strokes: Stroke[];
}

interface OracleSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  autoSubmit: boolean;
  fadeInk: boolean;
  inlineReply: boolean;
  replyFont: ReplyFont;
}

interface OracleAnswer {
  transcript: string;
  reply: string;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const canvas = $("#inkCanvas") as HTMLCanvasElement;
const context = canvas.getContext("2d", { alpha: true }) as CanvasRenderingContext2D;
if (!context) throw new Error("Canvas 2D is unavailable");

const canvasFrame = $("#canvasFrame") as HTMLElement;
const diaryPage = $(".page") as HTMLElement;
const emptyHint = $("#emptyHint") as HTMLElement;
const thinkingState = $("#thinkingState") as HTMLElement;
const telemetry = $("#penTelemetry") as HTMLElement;
const pageStatus = $("#pageStatus") as HTMLElement;
const replyPanel = $("#replyPanel") as HTMLElement;
const replyText = $("#replyText") as HTMLElement;
const undoButton = $("#undoButton") as HTMLButtonElement;
const clearButton = $("#clearButton") as HTMLButtonElement;
const settingsDialog = $("#settingsDialog") as HTMLDialogElement;
const memoryDialog = $("#memoryDialog") as HTMLDialogElement;
const memoryList = $("#memoryList") as HTMLElement;
const memoryCount = $("#memoryCount") as HTMLElement;
const toast = $("#toast") as HTMLElement;
const installButton = $("#installButton") as HTMLButtonElement;

const SETTINGS_KEY = "riddle.web.settings.v1";
const DB_NAME = "riddle-web";
const DB_VERSION = 1;
const DRAFT_KEY = "current-page";
const IDLE_DELAY = 2800;
const MAX_MEMORIES = 400;

let strokes: Stroke[] = [];
let currentStroke: Stroke | null = null;
let activePointer: number | null = null;
let activeTool: Tool = "pen";
let idleTimer: number | undefined;
let isThinking = false;
let penRecentlyActiveUntil = 0;
let revealTimer: number | undefined;
let installPrompt: InstallPromptEvent | null = null;
let settings = loadSettings();
let drawingRevision = 0;
let committedRevision = 0;
let lastReplyStrokes: Stroke[] = [];
const managedOracle = __MANAGED_ORACLE__;
const oracleSupportsVision = __ORACLE_SUPPORTS_VISION__;

function loadSettings(): OracleSettings {
  const defaults: OracleSettings = {
    apiKey: "",
    baseUrl: __DEFAULT_ORACLE_URL__,
    model: __DEFAULT_ORACLE_MODEL__,
    autoSubmit: true,
    fadeInk: true,
    inlineReply: true,
    replyFont: "script",
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbRequest<T>(storeName: "entries" | "drafts", mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = run(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function saveDraft(): Promise<void> {
  await idbRequest("drafts", "readwrite", (store) => store.put(strokes, DRAFT_KEY));
}

async function loadDraft(): Promise<Stroke[]> {
  return (await idbRequest("drafts", "readonly", (store) => store.get(DRAFT_KEY))) || [];
}

async function loadEntries(): Promise<DiaryEntry[]> {
  const entries = await idbRequest<DiaryEntry[]>("entries", "readonly", (store) => store.getAll());
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function saveEntry(entry: DiaryEntry): Promise<void> {
  await idbRequest("entries", "readwrite", (store) => store.put(entry));
  const entries = await loadEntries();
  for (const old of entries.slice(MAX_MEMORIES)) {
    await idbRequest("entries", "readwrite", (store) => store.delete(old.id));
  }
}

async function clearEntries(): Promise<void> {
  await idbRequest("entries", "readwrite", (store) => store.clear());
}

function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  renderInk();
}

function pointFromEvent(event: PointerEvent): InkPoint {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  return {
    x,
    y,
    pressure: event.pressure || (event.pointerType === "mouse" ? 0.45 : 0.3),
    tiltX: event.tiltX || 0,
    tiltY: event.tiltY || 0,
    altitude: event.altitudeAngle || 0,
    azimuth: event.azimuthAngle || 0,
    time: event.timeStamp,
  };
}

function drawStroke(target: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number): void {
  if (!stroke.points.length) return;
  target.lineCap = "round";
  target.lineJoin = "round";
  target.strokeStyle = "#1d1916";
  target.fillStyle = "#1d1916";
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    target.beginPath();
    target.arc(point.x * width, point.y * height, 1.4 + point.pressure * 2.6, 0, Math.PI * 2);
    target.fill();
    return;
  }
  for (let index = 1; index < stroke.points.length; index += 1) {
    const from = stroke.points[index - 1];
    const to = stroke.points[index];
    const pressure = (from.pressure + to.pressure) / 2;
    target.lineWidth = 1.25 + pressure * 5.2;
    target.beginPath();
    target.moveTo(from.x * width, from.y * height);
    target.lineTo(to.x * width, to.y * height);
    target.stroke();
  }
}

function renderInk(): void {
  const rect = canvas.getBoundingClientRect();
  context.clearRect(0, 0, rect.width, rect.height);
  for (const stroke of strokes) drawStroke(context, stroke, rect.width, rect.height);
  updateDrawingState();
}

function updateDrawingState(): void {
  const hasInk = strokes.length > 0;
  emptyHint.classList.toggle("hidden", hasInk);
  undoButton.disabled = !hasInk || isThinking;
  clearButton.disabled = !hasInk || isThinking;
}

function shouldIgnore(event: PointerEvent): boolean {
  if (event.pointerType === "pen") {
    penRecentlyActiveUntil = Date.now() + 900;
    return false;
  }
  return event.pointerType === "touch" && Date.now() < penRecentlyActiveUntil;
}

function startPointer(event: PointerEvent): void {
  if (isThinking || shouldIgnore(event) || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  activePointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  window.clearTimeout(idleTimer);
  hideReply();
  if (activeTool === "eraser") {
    eraseAt(pointFromEvent(event));
    return;
  }
  currentStroke = { id: crypto.randomUUID(), pointerType: event.pointerType, points: [pointFromEvent(event)] };
  strokes.push(currentStroke);
  drawingRevision += 1;
  updateTelemetry(event);
  renderInk();
}

function movePointer(event: PointerEvent): void {
  if (activePointer !== event.pointerId || shouldIgnore(event)) return;
  event.preventDefault();
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
  if (activeTool === "eraser") {
    for (const sample of events) eraseAt(pointFromEvent(sample));
  } else if (currentStroke) {
    for (const sample of events) currentStroke.points.push(pointFromEvent(sample));
    renderInk();
  }
  updateTelemetry(event);
}

function endPointer(event: PointerEvent): void {
  if (activePointer !== event.pointerId) return;
  event.preventDefault();
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  activePointer = null;
  currentStroke = null;
  void saveDraft().catch(() => showToast("The draft could not be saved."));
  scheduleCommit();
}

function eraseAt(point: InkPoint): void {
  const rect = canvas.getBoundingClientRect();
  const radius = 24;
  const remaining = strokes.filter((stroke) => !stroke.points.some((candidate) => {
    const dx = (candidate.x - point.x) * rect.width;
    const dy = (candidate.y - point.y) * rect.height;
    return dx * dx + dy * dy < radius * radius;
  }));
  if (remaining.length !== strokes.length) drawingRevision += 1;
  strokes = remaining;
  renderInk();
}

function updateTelemetry(event: PointerEvent): void {
  const type = event.pointerType === "pen" ? "Pencil" : event.pointerType === "touch" ? "Touch" : "Pointer";
  const pressure = Math.round(event.pressure * 100);
  telemetry.classList.add("active");
  telemetry.innerHTML = `<span class="pen-dot"></span><span>${type} · ${pressure}% pressure · ${Math.round(event.tiltX)}° tilt</span>`;
}

function scheduleCommit(): void {
  window.clearTimeout(idleTimer);
  if (!settings.autoSubmit || !strokes.length || isThinking || drawingRevision === committedRevision) return;
  pageStatus.textContent = "Rest the pen — the page is listening.";
  idleTimer = window.setTimeout(() => void commitPage(), IDLE_DELAY);
}

function exportPage(source: Stroke[]): string {
  const output = document.createElement("canvas");
  output.width = 1536;
  output.height = 2048;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("Could not prepare the page image.");
  ctx.fillStyle = "#f4efdf";
  ctx.fillRect(0, 0, output.width, output.height);
  for (const stroke of source) drawStroke(ctx, stroke, output.width, output.height);
  return output.toDataURL("image/png");
}

async function askOracle(imageUrl: string, confirmedTranscript: string): Promise<OracleAnswer> {
  if (!managedOracle && !settings.apiKey.trim()) throw new Error("Open settings and add an API key before asking the diary.");
  if (!navigator.onLine) throw new Error("The page is safe offline. Reconnect before asking the oracle.");
  const entries = (await loadEntries()).slice(0, 8).reverse();
  const memory = entries.length
    ? entries.map((entry) => `Writer: ${entry.transcript}\nDiary: ${entry.reply}`).join("\n\n")
    : "No earlier pages.";
  const prompt = [
    "You are Tom Riddle's diary. Answer briefly, warmly, and a little mysteriously.",
    oracleSupportsVision ? "Read the attached handwritten page as the source of truth. Do not mention being an AI or describe the image." : `The writer transcribed their handwritten page as: ${confirmedTranscript}`,
    oracleSupportsVision ? "Return only strict JSON with two strings: transcript (a faithful transcription of the handwriting) and reply (your response, at most 90 words)." : "Return only strict JSON with one string: reply (your response, at most 90 words).",
    `Recent locally remembered pages:\n${memory}`,
  ].join("\n\n");
  const endpoint = managedOracle ? __ORACLE_ENDPOINT__ : `${settings.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
  const requestContent = oracleSupportsVision
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }]
    : prompt;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: managedOracle ? { "Content-Type": "application/json" } : { Authorization: `Bearer ${settings.apiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model.trim(),
      messages: [{ role: "user", content: requestContent }],
      max_tokens: 400,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`Oracle error ${response.status}: ${detail}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
  const raw = payload.choices?.[0]?.message?.content;
  const content = typeof raw === "string" ? raw : raw?.map((part) => part.text || "").join("");
  if (!content) throw new Error("The oracle returned an unreadable response.");
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Partial<OracleAnswer>;
    if (!parsed.reply?.trim()) throw new Error("missing reply");
    return { transcript: confirmedTranscript || parsed.transcript?.trim() || "Handwritten page", reply: parsed.reply.trim() };
  } catch {
    return { transcript: confirmedTranscript || "Handwritten page", reply: content.trim() };
  }
}

function requestTranscript(): Promise<string | null> {
  const dialog = $("#transcriptDialog") as HTMLDialogElement;
  const form = $("#transcriptForm") as HTMLFormElement;
  const input = $("#transcriptInput") as HTMLTextAreaElement;
  input.value = "";
  dialog.showModal();
  window.setTimeout(() => input.focus(), 80);
  return new Promise((resolve) => {
    const close = () => {
      dialog.removeEventListener("close", close);
      form.removeEventListener("submit", submit);
      resolve(dialog.returnValue === "default" && input.value.trim() ? input.value.trim() : null);
    };
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      dialog.close("default");
    };
    dialog.addEventListener("close", close);
    form.addEventListener("submit", submit);
  });
}

async function commitPage(): Promise<void> {
  if (!strokes.length || isThinking) return;
  const confirmedTranscript = managedOracle && !oracleSupportsVision ? await requestTranscript() : "";
  if (managedOracle && !oracleSupportsVision && !confirmedTranscript) {
    pageStatus.textContent = "Your ink is still on the page.";
    return;
  }
  isThinking = true;
  updateDrawingState();
  const committed = structuredClone(strokes);
  const submittedRevision = drawingRevision;
  const image = exportPage(committed);
  thinkingState.classList.add("visible");
  if (settings.fadeInk) {
    canvasFrame.classList.add("drinking");
    pageStatus.textContent = "The page is drinking your ink.";
    await wait(760);
    strokes = [];
    renderInk();
    canvasFrame.classList.remove("drinking");
  } else {
    pageStatus.textContent = "The diary is considering the ink before it.";
  }
  try {
    const answer = await askOracle(image, confirmedTranscript || "");
    const entry: DiaryEntry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), transcript: answer.transcript, reply: answer.reply, strokes: committed };
    await saveEntry(entry);
    await saveDraft();
    await refreshMemory();
    committedRevision = submittedRevision;
    thinkingState.classList.remove("visible");
    pageStatus.textContent = "The diary has answered.";
    revealReply(answer.reply, committed);
  } catch (error) {
    strokes = committed;
    renderInk();
    thinkingState.classList.remove("visible");
    const message = error instanceof Error ? error.message : "The diary could not answer.";
    pageStatus.textContent = message;
    showToast(message);
    if (!managedOracle && !settings.apiKey.trim()) settingsDialog.showModal();
  } finally {
    isThinking = false;
    updateDrawingState();
  }
}

function revealReply(text: string, source: Stroke[]): void {
  window.clearInterval(revealTimer);
  lastReplyStrokes = source;
  applyReplyPresentation();
  replyText.textContent = "";
  replyPanel.classList.add("visible");
  const words = text.split(/\s+/);
  let index = 0;
  revealTimer = window.setInterval(() => {
    replyText.textContent += `${index ? " " : ""}${words[index]}`;
    index += 1;
    if (index >= words.length) window.clearInterval(revealTimer);
  }, 88);
}

function hideReply(): void {
  window.clearInterval(revealTimer);
  replyPanel.classList.remove("visible");
  replyText.textContent = "";
}

function applyReplyPresentation(): void {
  const fonts: Record<ReplyFont, string> = {
    script: '"Dancing Script", cursive',
    comic: '"Comic Neue", "Comic Sans MS", cursive',
    book: '"Iowan Old Style", "Palatino Linotype", serif',
    typewriter: '"American Typewriter", "Courier New", monospace',
  };
  document.documentElement.style.setProperty("--reply-font", fonts[settings.replyFont]);
  replyPanel.classList.toggle("inline", settings.inlineReply);
  if (settings.inlineReply && lastReplyStrokes.length) {
    const lastInk = lastReplyStrokes.reduce((maximum, stroke) => stroke.points.reduce((strokeMaximum, point) => Math.max(strokeMaximum, point.y), maximum), 0);
    replyPanel.style.top = `${Math.min(72, Math.max(34, 24 + lastInk * 54))}%`;
    replyPanel.style.bottom = "auto";
  } else {
    replyPanel.style.removeProperty("top");
    replyPanel.style.removeProperty("bottom");
  }
}

async function refreshMemory(): Promise<void> {
  const entries = await loadEntries();
  memoryCount.textContent = entries.length ? `${entries.length} remembered ${entries.length === 1 ? "page" : "pages"}` : "No memories yet";
  memoryList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "The pages are quiet. Your finished entries will appear here.";
    memoryList.append(empty);
    return;
  }
  for (const entry of entries) {
    const article = document.createElement("article");
    const date = document.createElement("time");
    date.dateTime = entry.createdAt;
    date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt));
    const transcript = document.createElement("h3");
    transcript.textContent = entry.transcript;
    const reply = document.createElement("p");
    reply.textContent = entry.reply;
    article.append(date, transcript, reply);
    memoryList.append(article);
  }
}

function setTool(tool: Tool): void {
  activeTool = tool;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  canvas.classList.toggle("eraser-active", tool === "eraser");
  pageStatus.textContent = tool === "pen" ? "Ink follows pressure and tilt." : "Erase whole strokes with the pointer.";
}

function populateSettings(): void {
  const apiKeyInput = $("#apiKeyInput") as HTMLInputElement;
  const baseUrlInput = $("#baseUrlInput") as HTMLInputElement;
  const modelInput = $("#modelInput") as HTMLInputElement;
  apiKeyInput.value = settings.apiKey;
  baseUrlInput.value = settings.baseUrl;
  modelInput.value = settings.model;
  apiKeyInput.disabled = managedOracle;
  baseUrlInput.disabled = managedOracle;
  modelInput.disabled = managedOracle;
  $("#managedProviderNote").classList.toggle("hidden", !managedOracle);
  ($("#autoSubmitInput") as HTMLInputElement).checked = settings.autoSubmit;
  ($("#fadeInkInput") as HTMLInputElement).checked = settings.fadeInk;
  ($("#inlineReplyInput") as HTMLInputElement).checked = settings.inlineReply;
  ($("#replyFontInput") as HTMLSelectElement).value = settings.replyFont;
}

function saveSettings(): void {
  settings = {
    apiKey: managedOracle ? "" : ($("#apiKeyInput") as HTMLInputElement).value,
    baseUrl: managedOracle ? "" : ($("#baseUrlInput") as HTMLInputElement).value,
    model: managedOracle ? __DEFAULT_ORACLE_MODEL__ : ($("#modelInput") as HTMLInputElement).value,
    autoSubmit: ($("#autoSubmitInput") as HTMLInputElement).checked,
    fadeInk: ($("#fadeInkInput") as HTMLInputElement).checked,
    inlineReply: ($("#inlineReplyInput") as HTMLInputElement).checked,
    replyFont: ($("#replyFontInput") as HTMLSelectElement).value as ReplyFont,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  applyReplyPresentation();
  showToast("Oracle settings saved on this device.");
  scheduleCommit();
}

function updateConnection(): void {
  const badge = $("#connectionBadge") as HTMLElement;
  badge.classList.toggle("online", navigator.onLine);
  badge.querySelector("span")!.textContent = navigator.onLine ? "Online" : "Offline ready";
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 3600);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function bindEvents(): void {
  const preventNativeCanvasGesture = (event: Event) => event.preventDefault();
  canvas.addEventListener("pointerdown", startPointer);
  canvas.addEventListener("pointermove", movePointer);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("touchstart", preventNativeCanvasGesture, { passive: false });
  canvas.addEventListener("touchmove", preventNativeCanvasGesture, { passive: false });
  canvas.addEventListener("gesturestart", preventNativeCanvasGesture);
  diaryPage.addEventListener("selectstart", preventNativeCanvasGesture);
  diaryPage.addEventListener("dragstart", preventNativeCanvasGesture);
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (selection?.anchorNode && diaryPage.contains(selection.anchorNode)) selection.removeAllRanges();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool as Tool)));
  undoButton.addEventListener("click", () => {
    strokes.pop();
    drawingRevision += 1;
    renderInk();
    void saveDraft();
    scheduleCommit();
  });
  clearButton.addEventListener("click", () => {
    window.clearTimeout(idleTimer);
    strokes = [];
    drawingRevision += 1;
    committedRevision = drawingRevision;
    hideReply();
    renderInk();
    void saveDraft();
    pageStatus.textContent = "A clean page is waiting.";
  });
  $("#settingsButton").addEventListener("click", () => { populateSettings(); settingsDialog.showModal(); });
  $("#settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings();
    settingsDialog.close();
  });
  $("#memoryButton").addEventListener("click", () => { void refreshMemory(); memoryDialog.showModal(); });
  document.querySelectorAll<HTMLElement>("[data-close-memory]").forEach((button) => button.addEventListener("click", () => memoryDialog.close()));
  $("#forgetButton").addEventListener("click", async () => {
    if (!window.confirm("Forget every locally remembered page? This cannot be undone.")) return;
    await clearEntries();
    await refreshMemory();
    showToast("The diary has forgotten every finished page.");
  });
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    installButton.classList.remove("hidden");
  });
  installButton.addEventListener("click", async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") installButton.classList.add("hidden");
      installPrompt = null;
      return;
    }
    showToast("On iPad: Share → Add to Home Screen.");
  });
}

async function start(): Promise<void> {
  const now = new Date();
  $("#dateLabel").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(now);
  bindEvents();
  updateConnection();
  strokes = await loadDraft().catch(() => []);
  committedRevision = drawingRevision;
  applyReplyPresentation();
  await refreshMemory().catch(() => undefined);
  requestAnimationFrame(resizeCanvas);
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => void navigator.serviceWorker.register("./sw.js"));
  }
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  if (isIos && !standalone) {
    installButton.classList.remove("hidden");
    installButton.textContent = "Add to Home Screen";
  }
}

void start();
