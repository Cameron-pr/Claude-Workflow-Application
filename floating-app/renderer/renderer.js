const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const pinBtn = document.getElementById('pin-btn');
const minBtn = document.getElementById('min-btn');
const closeBtn = document.getElementById('close-btn');
const modelSelect = document.getElementById('model-select');
const permissionSelect = document.getElementById('permission-select');
const effortSelect = document.getElementById('effort-select');
const sessionsBtn = document.getElementById('sessions-btn');
const activeBtn = document.getElementById('active-btn');
const sessionsPanel = document.getElementById('sessions-panel');
const sessionsList = document.getElementById('sessions-list');
const newSessionBtn = document.getElementById('new-session-btn');
const archivedToggle = document.getElementById('archived-toggle');
const activeSidebar = document.getElementById('active-sidebar');
const activeSidebarList = document.getElementById('active-sidebar-list');
const activeNewBtn = document.getElementById('active-new-btn');

// ---------------------------------------------------------------------------
// Conversation state.
//
// Every conversation (whether newly started here or resumed from history)
// lives in this map for as long as the app is open, independent of which one
// is currently displayed. Switching away from a conversation mid-turn does
// NOT cancel it or stop it updating — its events keep arriving and get
// recorded, so switching back shows exactly what happened while you were
// elsewhere. Rendering is a pure function of a conversation's event log: any
// update just re-renders the whole thing from scratch rather than patching
// existing DOM, which also sidesteps a whole class of stale/overlapping
// element bugs from incremental DOM surgery.
// ---------------------------------------------------------------------------

const conversations = new Map(); // id -> conversation
let activeConversationId = null;

function makeId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function newConversation() {
  const convo = {
    id: makeId(),
    claudeSessionId: null,
    title: null,
    status: 'idle', // idle | working | waiting | finished | error
    events: [],
    turnStartTime: null,
    pausedTotalMs: 0,
    pauseBeganAt: null,
    paused: false,
  };
  conversations.set(convo.id, convo);
  return convo;
}

function activeConvo() {
  return activeConversationId ? conversations.get(activeConversationId) : null;
}

function findToolEvent(convo, id) {
  for (let i = convo.events.length - 1; i >= 0; i--) {
    const ev = convo.events[i];
    if (ev.kind === 'tool' && ev.id === id) return ev;
  }
  return null;
}

function findRequestEvent(convo, requestId) {
  for (let i = convo.events.length - 1; i >= 0; i--) {
    const ev = convo.events[i];
    if ((ev.kind === 'approval' || ev.kind === 'question') && ev.requestId === requestId) return ev;
  }
  return null;
}

// Re-renders the active conversation's whole transcript from its event log,
// plus a live status indicator at the bottom if it's still working/waiting.
function renderActive() {
  const convo = activeConvo();
  messagesEl.innerHTML = '';
  // Reflects the ACTIVE conversation's own status, not whichever request last
  // resolved — a background conversation still working must not lock out
  // typing in whatever conversation you've switched to.
  sendBtn.disabled = !!(convo && convo.status === 'working');
  if (!convo) return;
  convo.events.forEach((ev) => renderEvent(convo, ev));
  if (convo.status === 'working' || convo.status === 'waiting') {
    currentThinkingEl = createThinkingIndicator();
  } else {
    currentThinkingEl = null;
  }
  refreshHeaderAnimation();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function switchToConversation(convo) {
  activeConversationId = convo.id;
  renderActive();
  sessionsPanel.hidden = true;
  refreshActiveSidebar();
}

// ---------------------------------------------------------------------------
// Basic rendering helpers
// ---------------------------------------------------------------------------

function addMessage(text, cls) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  if (cls === 'claude') {
    div.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Wraps agent-side entries (thinking, tool calls/results, replies, errors) in
// a dotted timeline: white = normal, green = succeeded, red = failed. Plain
// flex flow, deliberately no position:absolute anywhere.
function addTimelineItem(contentEl, dotColor, durationLabel) {
  const item = document.createElement('div');
  item.className = 'timeline-item';

  const dotCol = document.createElement('div');
  dotCol.className = 'timeline-dot-col';

  const dot = document.createElement('span');
  dot.className = `timeline-dot dot-${dotColor}`;
  dotCol.appendChild(dot);

  const line = document.createElement('div');
  line.className = 'timeline-line';
  dotCol.appendChild(line);

  item.appendChild(dotCol);

  const content = document.createElement('div');
  content.className = 'timeline-content';
  content.appendChild(contentEl);

  if (durationLabel) {
    const dur = document.createElement('span');
    dur.className = 'timeline-duration';
    dur.textContent = durationLabel;
    content.appendChild(dur);
  }

  item.appendChild(content);
  messagesEl.appendChild(item);
  return item;
}

const MODEL_LABELS = {
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-5': 'Opus 5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

function formatToolInput(name, input) {
  if (!input) return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string' && input.old_string) {
    return `${input.file_path}\n- ${input.old_string.slice(0, 80)}\n+ ${input.new_string.slice(0, 80)}`;
  }
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// Truncates to a 3-line preview by swapping actual text content, rather than
// clamping with a dynamic CSS max-height — that pattern (max-height/overflow
// toggling inside a nested flex+scroll layout) was triggering a genuine
// Chromium paint bug that made unrelated cards visually overlap, reproducible
// even under software rendering, so the CSS approach is out entirely.
function truncatePreview(text, maxLines = 3, maxCharsPerLine = 50) {
  const lines = text.split('\n');
  let preview = lines.slice(0, maxLines).join('\n');
  const limit = maxLines * maxCharsPerLine;
  if (preview.length > limit) preview = preview.slice(0, limit);
  return preview;
}

// Shared 3-line-preview + Expand + Open-in-window block, used for both the
// Bash/tool command text and its output.
function renderClampableBlock(text, extraClass, openTitle) {
  const wrapper = document.createElement('div');
  wrapper.className = 'clampable-block';

  const pre = document.createElement('pre');
  pre.className = extraClass ? `tool-pre ${extraClass}` : 'tool-pre';

  const preview = truncatePreview(text);
  const needsToggle = preview.length < text.length;
  let expanded = false;
  pre.textContent = needsToggle ? preview + ' …' : text;
  wrapper.appendChild(pre);

  const toolbar = document.createElement('div');
  toolbar.className = 'tool-output-toolbar';

  const expandBtn = document.createElement('button');
  expandBtn.className = 'tool-btn';
  expandBtn.textContent = 'Expand ▾';
  expandBtn.disabled = !needsToggle;
  expandBtn.addEventListener('click', () => {
    if (!needsToggle) return;
    expanded = !expanded;
    pre.textContent = expanded ? text : preview + ' …';
    expandBtn.textContent = expanded ? 'Collapse ▲' : 'Expand ▾';
  });
  toolbar.appendChild(expandBtn);

  const openBtn = document.createElement('button');
  openBtn.className = 'tool-btn';
  openBtn.textContent = '⧉ Open in window';
  openBtn.addEventListener('click', () => {
    window.api.openOutputWindow(openTitle, text);
  });
  toolbar.appendChild(openBtn);

  wrapper.appendChild(toolbar);
  return { wrapper, pre };
}

// ---------------------------------------------------------------------------
// Event log -> DOM. One dispatcher, used identically for live updates and for
// replaying a conversation's full history when switching back to it.
// ---------------------------------------------------------------------------

function renderEvent(convo, ev) {
  switch (ev.kind) {
    case 'user':
      addMessage(ev.text, 'user');
      break;
    case 'text': {
      const div = document.createElement('div');
      div.className = 'msg claude';
      div.innerHTML = DOMPurify.sanitize(marked.parse(ev.text));
      addTimelineItem(div, 'white');
      break;
    }
    case 'thinking': {
      const div = document.createElement('div');
      div.className = 'msg thinking';
      div.textContent = ev.text;
      addTimelineItem(div, 'white', formatDuration(ev.elapsedMs));
      break;
    }
    case 'tool':
      renderToolEvent(ev);
      break;
    case 'approval':
      renderApprovalEvent(convo, ev);
      break;
    case 'question':
      renderQuestionEvent(convo, ev);
      break;
    case 'error':
      addTimelineItem(Object.assign(document.createElement('div'), { textContent: ev.text }), 'red');
      break;
    case 'model_tag': {
      const label = document.createElement('div');
      label.className = 'model-used-tag';
      label.textContent = `via ${MODEL_LABELS[ev.model] || ev.model}`;
      messagesEl.appendChild(label);
      break;
    }
  }
}

function renderToolEvent(ev) {
  const card = document.createElement('div');
  card.className = 'msg tool-card';

  const header = document.createElement('div');
  header.className = 'tool-header';
  header.textContent = `▶ ${ev.name}`;
  card.appendChild(header);

  const inputText = formatToolInput(ev.name, ev.input);
  if (inputText) {
    const { wrapper } = renderClampableBlock(inputText, null, `${ev.name} command`);
    card.appendChild(wrapper);
  }

  let dotColor = 'white';
  let durationLabel = '';
  if (ev.result) {
    const { wrapper: outputBlock } = renderClampableBlock(
      ev.result.text || '(no output)',
      ev.result.isError ? 'tool-output-error' : null,
      `${ev.name || 'Tool'} output`
    );
    card.appendChild(outputBlock);
    dotColor = ev.result.isError ? 'red' : 'green';
    durationLabel = formatDuration(ev.result.toolElapsedMs);
  }

  addTimelineItem(card, dotColor, durationLabel);
}

function renderQuestionEvent(convo, ev) {
  if (ev.resolved) {
    const div = document.createElement('div');
    div.className = 'msg claude';
    div.textContent = Object.values(ev.answers || {}).join(' / ') || 'Answered.';
    addTimelineItem(div, 'white');
    return;
  }

  const card = document.createElement('div');
  card.className = 'msg claude question-card';

  const state = {};

  ev.questions.forEach((q) => {
    state[q.question] = q.multiSelect ? [] : null;

    const block = document.createElement('div');
    block.className = 'question-block';

    const header = document.createElement('div');
    header.className = 'question-header';
    header.textContent = q.header || '';
    block.appendChild(header);

    const qText = document.createElement('div');
    qText.className = 'question-text';
    qText.textContent = q.question;
    block.appendChild(qText);

    const optionsDiv = document.createElement('div');
    optionsDiv.className = 'question-options';

    (q.options || []).forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = opt.label;
      btn.title = opt.description || '';
      btn.addEventListener('click', () => {
        if (q.multiSelect) {
          btn.classList.toggle('selected');
          const list = state[q.question];
          const idx = list.indexOf(opt.label);
          if (idx >= 0) list.splice(idx, 1);
          else list.push(opt.label);
        } else {
          [...optionsDiv.querySelectorAll('.option-btn')].forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          state[q.question] = opt.label;
          otherInput.value = '';
        }
      });
      optionsDiv.appendChild(btn);
    });

    const otherInput = document.createElement('input');
    otherInput.className = 'option-other';
    otherInput.placeholder = 'Other...';
    otherInput.addEventListener('input', () => {
      if (!otherInput.value) return;
      if (q.multiSelect) {
        state[q.question] = [otherInput.value];
      } else {
        [...optionsDiv.querySelectorAll('.option-btn')].forEach((b) => b.classList.remove('selected'));
        state[q.question] = otherInput.value;
      }
    });
    optionsDiv.appendChild(otherInput);

    block.appendChild(optionsDiv);
    card.appendChild(block);
  });

  const submitBtn = document.createElement('button');
  submitBtn.className = 'question-submit';
  submitBtn.textContent = 'Submit';
  submitBtn.addEventListener('click', () => {
    const answers = {};
    for (const q of ev.questions) {
      const val = state[q.question];
      answers[q.question] = Array.isArray(val) ? val.join(', ') : val;
    }
    ev.resolved = true;
    ev.answers = answers;
    resumeConvoStatus(convo);
    window.api.answerQuestion(ev.requestId, answers);
    if (convo.id === activeConversationId) renderActive();
  });
  card.appendChild(submitBtn);

  messagesEl.appendChild(card);
}

function renderApprovalEvent(convo, ev) {
  if (ev.resolved) {
    const div = document.createElement('div');
    div.className = 'msg claude';
    div.textContent = ev.allowed ? `✓ Allowed: ${ev.toolName}` : `✗ Denied: ${ev.toolName}`;
    addTimelineItem(div, ev.allowed ? 'green' : 'red');
    return;
  }

  const card = document.createElement('div');
  card.className = 'msg claude approval-card';

  const titleEl = document.createElement('div');
  titleEl.className = 'approval-title';
  titleEl.textContent = ev.title || `Allow ${ev.displayName}?`;
  card.appendChild(titleEl);

  if (ev.description) {
    const descEl = document.createElement('div');
    descEl.className = 'approval-description';
    descEl.textContent = ev.description;
    card.appendChild(descEl);
  }

  const commandText = formatToolInput(ev.toolName, ev.input);
  if (commandText) {
    const { wrapper } = renderClampableBlock(commandText, null, `${ev.toolName} command`);
    card.appendChild(wrapper);
  }

  const buttons = document.createElement('div');
  buttons.className = 'approval-buttons';

  function answer(allow) {
    ev.resolved = true;
    ev.allowed = allow;
    resumeConvoStatus(convo);
    window.api.answerApproval(ev.requestId, allow);
    if (convo.id === activeConversationId) renderActive();
  }

  const allowBtn = document.createElement('button');
  allowBtn.className = 'approval-allow';
  allowBtn.textContent = 'Allow';
  allowBtn.addEventListener('click', () => answer(true));

  const denyBtn = document.createElement('button');
  denyBtn.className = 'approval-deny';
  denyBtn.textContent = 'Deny';
  denyBtn.addEventListener('click', () => answer(false));

  buttons.appendChild(allowBtn);
  buttons.appendChild(denyBtn);
  card.appendChild(buttons);

  messagesEl.appendChild(card);
}

// ---------------------------------------------------------------------------
// Header status animation (spinner + typewriter status word + elapsed timer).
// Reflects whichever conversation is currently active; elapsed/pause state is
// stored per-conversation so it stays correct across switching away and back.
// ---------------------------------------------------------------------------

// Same whimsical status verbs Claude Code's own CLI spinner cycles through.
const STATUS_WORDS = [
  'Accomplishing', 'Actioning', 'Baking', 'Brewing', 'Calculating', 'Channelling',
  'Churning', 'Cogitating', 'Computing', 'Concocting', 'Conjuring', 'Considering',
  'Contemplating', 'Cooking', 'Crafting', 'Deliberating', 'Determining', 'Doing',
  'Envisioning', 'Finagling', 'Forging', 'Frolicking', 'Generating', 'Germinating',
  'Hatching', 'Herding', 'Hustling', 'Ideating', 'Imagining', 'Incubating',
  'Inferring', 'Manifesting', 'Marinating', 'Meandering', 'Moseying', 'Mulling',
  'Munging', 'Musing', 'Mustering', 'Noodling', 'Percolating', 'Perusing',
  'Philosophising', 'Pondering', 'Pontificating', 'Processing', 'Puttering',
  'Puzzling', 'Reticulating', 'Ruminating', 'Schlepping', 'Shimmying', 'Simmering',
  'Spelunking', 'Spinning', 'Stewing', 'Summoning', 'Synthesizing', 'Tinkering',
  'Transmuting', 'Unfurling', 'Unravelling', 'Vibing', 'Wandering', 'Whirring',
  'Wizarding', 'Wrangling',
];
const SPINNER_FRAMES = ['✢', '✳', '✶', '✻'];
const SPINNER_TICK_MS = 350;
const TYPE_CHAR_MS = 45;
const DELETE_CHAR_MS = 25;
const HOLD_MS = 1800;

let spinnerFrame = 0;
let spinnerTimer = null;
let wordTimer = null;
let currentWordDisplay = '';
let currentThinkingEl = null;
let animationRunId = 0;

const headerStatus = document.getElementById('status-text');
const headerSpinner = document.getElementById('header-spinner');
const headerWord = document.getElementById('header-word');
const headerElapsed = document.getElementById('header-elapsed');

function pickWord() {
  return STATUS_WORDS[Math.floor(Math.random() * STATUS_WORDS.length)];
}

function getElapsedSeconds(convo) {
  if (!convo || convo.turnStartTime == null) return 0;
  const pausedSoFar = convo.pausedTotalMs + (convo.paused ? Date.now() - convo.pauseBeganAt : 0);
  return Math.max(0, Math.round((Date.now() - convo.turnStartTime - pausedSoFar) / 1000));
}

function renderStatusText() {
  const convo = activeConvo();
  const elapsedLabel = `(${getElapsedSeconds(convo)}s)`;
  const frame = SPINNER_FRAMES[spinnerFrame];
  headerSpinner.textContent = frame;
  headerWord.textContent = convo && convo.paused ? 'Waiting' : currentWordDisplay;
  headerElapsed.textContent = elapsedLabel;
  if (currentThinkingEl) {
    const star = currentThinkingEl.querySelector('.spinner-star');
    const word = currentThinkingEl.querySelector('.status-word');
    const elapsedEl = currentThinkingEl.querySelector('.status-elapsed');
    if (star) star.textContent = frame;
    if (word) word.textContent = convo && convo.paused ? 'Waiting' : currentWordDisplay;
    if (elapsedEl) elapsedEl.textContent = elapsedLabel;
  }
}

// (Re)starts or stops the header/thinking-indicator animation to match
// whichever conversation is currently active. Safe to call any time
// something status-relevant happens; it's a no-op if nothing changed.
function refreshHeaderAnimation() {
  const runId = ++animationRunId; // invalidates any in-flight typewriter chain
  clearInterval(spinnerTimer);
  clearTimeout(wordTimer);

  const convo = activeConvo();
  if (!convo || (convo.status !== 'working' && convo.status !== 'waiting')) {
    headerStatus.hidden = true;
    return;
  }

  headerStatus.hidden = false;
  spinnerFrame = 0;
  currentWordDisplay = '';
  renderStatusText();

  spinnerTimer = setInterval(() => {
    const c = activeConvo();
    if (!c || c.paused) return;
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    renderStatusText();
  }, SPINNER_TICK_MS);

  runTypewriter(runId, pickWord(), 0, 'typing');
}

// Types a word out, holds it, deletes it, then picks a new one — same cadence
// as the real CLI status line. `runId` lets a stale chain (from a since
// switched-away-from conversation) notice it's obsolete and stop.
function runTypewriter(runId, target, idx, phase) {
  if (runId !== animationRunId) return;
  const convo = activeConvo();
  if (!convo || (convo.status !== 'working' && convo.status !== 'waiting')) return;
  if (convo.paused) {
    renderStatusText();
    wordTimer = setTimeout(() => runTypewriter(runId, target, idx, phase), 200);
    return;
  }
  if (phase === 'typing') {
    idx++;
    currentWordDisplay = target.slice(0, idx);
    renderStatusText();
    if (idx < target.length) {
      wordTimer = setTimeout(() => runTypewriter(runId, target, idx, 'typing'), TYPE_CHAR_MS);
    } else {
      wordTimer = setTimeout(() => runTypewriter(runId, target, idx, 'deleting'), HOLD_MS);
    }
  } else {
    idx--;
    currentWordDisplay = target.slice(0, idx);
    renderStatusText();
    if (idx > 0) {
      wordTimer = setTimeout(() => runTypewriter(runId, target, idx, 'deleting'), DELETE_CHAR_MS);
    } else {
      wordTimer = setTimeout(() => runTypewriter(runId, pickWord(), 0, 'typing'), 150);
    }
  }
}

function pauseConvoStatus(convo) {
  if (convo.paused) return;
  convo.paused = true;
  convo.pauseBeganAt = Date.now();
  convo.status = 'waiting';
  if (convo.id === activeConversationId) renderStatusText();
  refreshActiveSidebar();
}

function resumeConvoStatus(convo) {
  if (!convo.paused) return;
  convo.pausedTotalMs += Date.now() - convo.pauseBeganAt;
  convo.paused = false;
  convo.status = 'working';
  refreshActiveSidebar();
}

function createThinkingIndicator() {
  const div = document.createElement('div');
  div.className = 'thinking-indicator';
  const star = document.createElement('span');
  star.className = 'spinner-star';
  const word = document.createElement('span');
  word.className = 'status-word';
  const cursor = document.createElement('span');
  cursor.className = 'type-cursor';
  cursor.textContent = '▊';
  const elapsed = document.createElement('span');
  elapsed.className = 'status-elapsed';
  div.appendChild(star);
  div.appendChild(document.createTextNode(' '));
  div.appendChild(word);
  div.appendChild(cursor);
  div.appendChild(document.createTextNode(' '));
  div.appendChild(elapsed);
  return addTimelineItem(div, 'white');
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;

  let convo = activeConvo();
  if (!convo) {
    convo = newConversation();
    activeConversationId = convo.id;
  }
  if (!convo.title) convo.title = text.slice(0, 60);

  inputEl.value = '';
  inputEl.style.height = 'auto';

  convo.events.push({ kind: 'user', text });
  convo.status = 'working';
  convo.turnStartTime = Date.now();
  convo.pausedTotalMs = 0;
  convo.paused = false;

  if (convo.id === activeConversationId) renderActive();
  refreshActiveSidebar();

  const model = modelSelect.value;
  const permissionMode = permissionSelect.value;
  const effort = effortSelect.value;

  const result = await window.api.sendMessage(text, {
    model,
    permissionMode,
    effort,
    conversationId: convo.id,
    resumeSessionId: convo.claudeSessionId,
  });

  if (result.sessionId) convo.claudeSessionId = result.sessionId;

  if (!result.ok) {
    convo.status = 'error';
    convo.events.push({ kind: 'error', text: result.error });
  } else {
    convo.status = 'finished';
    if (result.usedModel) convo.events.push({ kind: 'model_tag', model: result.usedModel });
  }
  convo.turnStartTime = null;
  refreshActiveSidebar();

  if (convo.id === activeConversationId) {
    renderActive();
    inputEl.focus();
  }
}

sendBtn.addEventListener('click', send);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
});

pinBtn.addEventListener('click', async () => {
  const pinned = await window.api.togglePin();
  pinBtn.classList.toggle('active', pinned);
});

minBtn.addEventListener('click', () => window.api.minimize());
closeBtn.addEventListener('click', () => window.api.close());

// ---------------------------------------------------------------------------
// Live events from main.js — routed to whichever conversation they belong to,
// regardless of what's currently displayed. Only re-rendered live if that
// conversation happens to be the active one.
// ---------------------------------------------------------------------------

window.api.onAgentEvent((evt) => {
  const convo = conversations.get(evt.conversationId);
  if (!convo) return;

  if (evt.kind === 'text') {
    convo.events.push({ kind: 'text', text: evt.text });
  } else if (evt.kind === 'thinking') {
    convo.events.push({ kind: 'thinking', text: evt.text, elapsedMs: evt.elapsedMs });
  } else if (evt.kind === 'tool_use') {
    convo.events.push({ kind: 'tool', id: evt.id, name: evt.name, input: evt.input, result: null });
  } else if (evt.kind === 'tool_result') {
    const toolEv = findToolEvent(convo, evt.id);
    if (toolEv) {
      toolEv.result = { text: evt.text, isError: evt.isError, toolElapsedMs: evt.toolElapsedMs };
    } else {
      convo.events.push({
        kind: 'tool',
        id: evt.id,
        name: evt.name || 'Tool',
        input: null,
        result: { text: evt.text, isError: evt.isError, toolElapsedMs: evt.toolElapsedMs },
      });
    }
  }

  if (convo.id === activeConversationId) renderActive();
});

window.api.onAskQuestion(({ requestId, conversationId, questions }) => {
  const convo = conversations.get(conversationId);
  if (!convo) return;
  pauseConvoStatus(convo);
  convo.events.push({ kind: 'question', requestId, questions, resolved: false, answers: null });
  if (convo.id === activeConversationId) renderActive();
});

window.api.onAskApproval(({ requestId, conversationId, toolName, input, displayName, title, description }) => {
  const convo = conversations.get(conversationId);
  if (!convo) return;
  pauseConvoStatus(convo);
  convo.events.push({
    kind: 'approval',
    requestId,
    toolName,
    input,
    displayName,
    title,
    description,
    resolved: false,
    allowed: null,
  });
  if (convo.id === activeConversationId) renderActive();
});

// ---------------------------------------------------------------------------
// "All conversations" (☰) — a modal overlay listing persisted history.
// "Active" (⬤) — a persistent side panel (widens the window) listing
// whatever's part of your current working set: still running, waiting on
// you, or just sitting there finished-for-now ready to pick back up. There's
// no special "finished" status color — almost everything ends up finished,
// so it isn't informative; those just get a neutral dot.
// ---------------------------------------------------------------------------

let showArchived = false;

// working/waiting/error are the only statuses worth a distinct color;
// everything else (finished, idle) is just "not currently doing anything."
function displayStatus(status) {
  return status === 'working' || status === 'waiting' || status === 'error' ? status : 'done';
}

function statusDot(status) {
  const dot = document.createElement('span');
  const shown = displayStatus(status);
  dot.className = `session-status-dot status-${shown}`;
  dot.title = { done: 'Not currently running', waiting: 'Waiting for permission', working: 'Working', error: 'Error' }[shown];
  return dot;
}

sessionsBtn.addEventListener('click', async () => {
  sessionsPanel.hidden = !sessionsPanel.hidden;
  if (!sessionsPanel.hidden) await refreshSessionsList();
});

newSessionBtn.addEventListener('click', () => {
  const convo = newConversation();
  switchToConversation(convo);
});

activeNewBtn.addEventListener('click', () => {
  const convo = newConversation();
  switchToConversation(convo);
});

archivedToggle.addEventListener('click', async () => {
  showArchived = !showArchived;
  archivedToggle.textContent = showArchived ? 'Hide archived' : 'Show archived';
  await refreshSessionsList();
});

activeBtn.addEventListener('click', async () => {
  const opening = activeSidebar.hidden;
  activeSidebar.hidden = !activeSidebar.hidden;
  await window.api.setSidebarOpen(!activeSidebar.hidden);
  if (opening) refreshActiveSidebar();
});

// Whatever you've started or opened in this session — regardless of whether
// it's still running or just finished and waiting for you to continue it.
function refreshActiveSidebar() {
  if (activeSidebar.hidden) return;
  activeSidebarList.innerHTML = '';

  const items = [...conversations.values()]
    .filter((c) => c.events.length > 0)
    .sort((a, b) => (b.turnStartTime || 0) - (a.turnStartTime || 0));

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#777';
    empty.style.padding = '8px';
    empty.style.fontSize = '12px';
    empty.textContent = 'Nothing active yet.';
    activeSidebarList.appendChild(empty);
    return;
  }

  items.forEach((convo) => {
    const item = document.createElement('div');
    item.className = 'active-item' + (convo.id === activeConversationId ? ' current' : '');
    item.appendChild(statusDot(convo.status));

    const titleEl = document.createElement('div');
    titleEl.className = 'active-item-title';
    titleEl.textContent = convo.title || '(untitled)';
    titleEl.title = convo.title || '(untitled)';
    item.appendChild(titleEl);

    item.addEventListener('click', () => switchToConversation(convo));
    activeSidebarList.appendChild(item);
  });
}

function buildSessionItem({ title, time, status, onClick, onArchive, onDelete }) {
  const item = document.createElement('div');
  item.className = 'session-item';

  item.appendChild(statusDot(status));

  const titleEl = document.createElement('div');
  titleEl.className = 'session-title';
  titleEl.textContent = title;
  titleEl.title = title;
  item.appendChild(titleEl);

  if (time) {
    const timeEl = document.createElement('div');
    timeEl.className = 'session-time';
    timeEl.textContent = time;
    item.appendChild(timeEl);
  }

  const actions = document.createElement('div');
  actions.className = 'session-actions';

  if (onArchive) {
    const archiveBtn = document.createElement('button');
    archiveBtn.textContent = showArchived ? '↩' : '🗄';
    archiveBtn.title = showArchived ? 'Unarchive' : 'Archive';
    archiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onArchive();
    });
    actions.appendChild(archiveBtn);
  }

  if (onDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete permanently';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    actions.appendChild(deleteBtn);
  }

  item.appendChild(actions);
  item.addEventListener('click', onClick);
  return item;
}

async function refreshSessionsList() {
  sessionsList.innerHTML = '';

  const sessions = await window.api.listSessions();
  const filtered = sessions.filter((s) => s.archived === showArchived);
  sessionsList.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#777';
    empty.style.padding = '8px';
    empty.textContent = showArchived ? 'No archived conversations.' : 'No conversations yet.';
    sessionsList.appendChild(empty);
    return;
  }

  filtered.forEach((s) => {
    const liveConvo = [...conversations.values()].find((c) => c.claudeSessionId === s.sessionId);
    const status = liveConvo ? liveConvo.status : 'done';

    sessionsList.appendChild(
      buildSessionItem({
        title: s.title,
        time: new Date(s.lastModified).toLocaleDateString(),
        status,
        onClick: async () => {
          if (liveConvo) {
            switchToConversation(liveConvo);
            return;
          }
          const events = await window.api.loadSession(s.sessionId);
          const convo = newConversation();
          convo.claudeSessionId = s.sessionId;
          convo.title = s.title;
          convo.status = 'finished';
          convo.events = events;
          switchToConversation(convo);
        },
        onArchive: async () => {
          if (showArchived) await window.api.unarchiveSession(s.sessionId);
          else await window.api.archiveSession(s.sessionId);
          await refreshSessionsList();
        },
        onDelete: async () => {
          await window.api.deleteSession(s.sessionId);
          await refreshSessionsList();
        },
      })
    );
  });
}

// Always start at the conversation picker rather than silently continuing
// whatever was last active — the user picks a past chat or starts fresh.
sessionsPanel.hidden = false;
refreshSessionsList();
