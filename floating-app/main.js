const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// If GPU acceleration isn't available (e.g. a remote/RDP session with no
// real graphics driver), fall back to software rendering instead of crashing.
if (process.env.CLAUDE_FLOATING_NO_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}

// The directory the `claude` CLI subprocess runs in — this is what gives it
// a particular project's CLAUDE.md, skills, and memory. Not derived from
// __dirname: this app has to run from a local copy of itself (Electron can't
// spawn its GPU/renderer child processes from a binary sitting on a network
// share), which is unrelated to where you want it actually working.
// Configure via config.json (see config.example.json) or the
// CLAUDE_FLOATING_PROJECT_DIR env var; falls back to the current directory.
function loadProjectDir() {
  if (process.env.CLAUDE_FLOATING_PROJECT_DIR) return process.env.CLAUDE_FLOATING_PROJECT_DIR;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    if (config.projectDir) return config.projectDir;
  } catch {}
  return process.cwd();
}

const PROJECT_DIR = loadProjectDir();

let win;
let requestCounter = 0;
const pendingRequests = new Map();

// The SDK ships as an ES module; this file is CommonJS, so it must be
// loaded via a cached dynamic import rather than require().
let sdkPromise;
function getSdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

function askRendererQuestion(input, conversationId) {
  return new Promise((resolve) => {
    const requestId = String(++requestCounter);
    pendingRequests.set(requestId, { resolve, input });
    win.webContents.send('ask-question', { requestId, conversationId, questions: input.questions });
  });
}

function askRendererApproval(toolName, input, meta, conversationId) {
  return new Promise((resolve) => {
    const requestId = String(++requestCounter);
    pendingRequests.set(requestId, { resolve, input });
    win.webContents.send('ask-approval', {
      requestId,
      conversationId,
      toolName,
      input,
      displayName: meta.displayName || toolName,
      title: meta.title || `Allow ${toolName}?`,
      description: meta.description || '',
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: 300,
    minHeight: 360,
    frame: false,
    backgroundColor: '#1e1e1e',
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('render-process-gone', (e, details) => {
    console.log('[render-process-gone]', details);
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const BASE_WIDTH = 380;
const SIDEBAR_WIDTH = 170;

ipcMain.handle('set-sidebar-open', (event, open) => {
  const [, height] = win.getSize();
  win.setSize(open ? BASE_WIDTH + SIDEBAR_WIDTH : BASE_WIDTH, height);
});

ipcMain.handle('toggle-pin', () => {
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next, 'floating');
  return next;
});

ipcMain.handle('minimize', () => win.minimize());
ipcMain.handle('close', () => win.close());

ipcMain.on('open-output-window', (event, { title, text }) => {
  const outWin = new BrowserWindow({
    width: 640,
    height: 520,
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  outWin.loadFile(path.join(__dirname, 'renderer', 'output-window.html'));
  outWin.webContents.once('did-finish-load', () => {
    outWin.webContents.executeJavaScript(
      `document.title = ${JSON.stringify(title || 'Output')}; document.getElementById('content').textContent = ${JSON.stringify(text || '')};`
    );
  });
});

ipcMain.on('answer-question', (event, { requestId, answers }) => {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve({
    behavior: 'allow',
    updatedInput: { questions: pending.input.questions, answers },
  });
});

ipcMain.on('answer-approval', (event, { requestId, allow }) => {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve(
    allow
      ? { behavior: 'allow', updatedInput: pending.input }
      : { behavior: 'deny', message: 'The user denied this action from the floating widget.' }
  );
});

// Each conversation carries its own resumeSessionId (explicit, passed by the
// renderer) instead of a single shared "current session" file — multiple
// conversations can be in flight at once, each resuming its own history,
// and none of them get cancelled just because the user switched away from
// that conversation's view.
ipcMain.handle('send-message', async (event, text, opts = {}) => {
  const { model, permissionMode, effort, conversationId, resumeSessionId } = opts;
  const { query } = await getSdk();

  const options = {
    cwd: PROJECT_DIR,
    canUseTool: async (toolName, input, callOpts) => {
      if (toolName === 'AskUserQuestion') {
        return askRendererQuestion(input, conversationId);
      }
      return askRendererApproval(
        toolName,
        input,
        {
          displayName: callOpts.displayName,
          title: callOpts.title,
          description: callOpts.description,
        },
        conversationId
      );
    },
  };
  if (resumeSessionId) options.resume = resumeSessionId;
  if (model) options.model = model;
  if (effort) options.effort = effort;
  if (permissionMode) {
    options.permissionMode = permissionMode;
    if (permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
  }

  let finalText = null;
  let newSessionId = resumeSessionId || null;
  let costUsd = null;
  let usedModel = null;
  const toolNames = new Map();
  const toolStartTimes = new Map();
  let lastEventTime = Date.now();

  function sendEvent(payload) {
    const now = Date.now();
    payload.elapsedMs = now - lastEventTime;
    payload.conversationId = conversationId;
    lastEventTime = now;
    win.webContents.send('agent-event', payload);
  }

  try {
    for await (const message of query({ prompt: text, options })) {
      if (message.type === 'assistant') {
        for (const block of getContentBlocks(message)) {
          if (block.type === 'text' && block.text) {
            sendEvent({ kind: 'text', text: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            sendEvent({ kind: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            toolNames.set(block.id, block.name);
            toolStartTimes.set(block.id, Date.now());
            sendEvent({
              kind: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
      } else if (message.type === 'user') {
        for (const block of getContentBlocks(message)) {
          if (block.type === 'tool_result') {
            const startedAt = toolStartTimes.get(block.tool_use_id);
            sendEvent({
              kind: 'tool_result',
              id: block.tool_use_id,
              name: toolNames.get(block.tool_use_id),
              text: toolResultText(block.content),
              isError: !!block.is_error,
              toolElapsedMs: startedAt != null ? Date.now() - startedAt : null,
            });
          }
        }
      } else if (message.type === 'result') {
        finalText = message.result;
        newSessionId = message.session_id || newSessionId;
        costUsd = message.total_cost_usd;
        if (message.modelUsage) {
          const models = Object.entries(message.modelUsage);
          if (models.length) {
            models.sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
            usedModel = models[0][1].canonicalModel || models[0][0];
          }
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  if (finalText == null) return { ok: false, error: 'No response received.' };
  return { ok: true, text: finalText, costUsd, sessionId: newSessionId, usedModel };
});

function getContentBlocks(message) {
  const content = message && message.message && message.message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function extractText(message) {
  const content = message && message.message && message.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

// The SDK's `dir` filter on these functions doesn't reliably match our
// PROJECT_DIR (returns nothing even for sessions that plainly have that
// cwd) — so sessions are fetched unfiltered and matched by cwd ourselves.
function sameProject(cwd) {
  return typeof cwd === 'string' && cwd.toLowerCase() === PROJECT_DIR.toLowerCase();
}

ipcMain.handle('list-sessions', async () => {
  const { listSessions } = await getSdk();
  // This app's own sessions are created via the SDK (a "programmatic"
  // entrypoint), so they must be included here — excluding them, as a
  // terminal /resume picker would, hid every conversation this app makes.
  const sessions = await listSessions({ includeProgrammatic: true });
  return sessions
    .filter((s) => sameProject(s.cwd))
    .sort((a, b) => b.lastModified - a.lastModified)
    .map((s) => ({
      sessionId: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || '(untitled)',
      lastModified: s.lastModified,
      archived: s.tag === 'archived',
    }));
});

// Returns the same event shape the live stream uses (see sendEvent above),
// so a reopened historical conversation shows its tool calls/output too,
// not just the plain text exchange.
ipcMain.handle('load-session', async (event, sessionId) => {
  const { getSessionMessages } = await getSdk();
  const messages = await getSessionMessages(sessionId);
  const events = [];
  const toolNames = new Map();

  for (const m of messages) {
    const blocks = getContentBlocks(m);
    if (m.type === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          events.push({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name);
          events.push({ kind: 'tool', id: block.id, name: block.name, input: block.input, result: null });
        }
      }
    } else if (m.type === 'user') {
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      if (toolResults.length) {
        for (const block of toolResults) {
          const result = {
            text: toolResultText(block.content),
            isError: !!block.is_error,
            toolElapsedMs: null,
          };
          const toolEv = [...events].reverse().find((e) => e.kind === 'tool' && e.id === block.tool_use_id);
          if (toolEv) {
            toolEv.result = result;
          } else {
            events.push({ kind: 'tool', id: block.tool_use_id, name: toolNames.get(block.tool_use_id) || 'Tool', input: null, result });
          }
        }
      } else {
        const text = extractText(m);
        if (text) events.push({ kind: 'user', text });
      }
    }
  }

  return events;
});

ipcMain.handle('archive-session', async (event, sessionId) => {
  const { tagSession } = await getSdk();
  await tagSession(sessionId, 'archived');
  return true;
});

ipcMain.handle('unarchive-session', async (event, sessionId) => {
  const { tagSession } = await getSdk();
  await tagSession(sessionId, null);
  return true;
});

ipcMain.handle('delete-session', async (event, sessionId) => {
  const { deleteSession } = await getSdk();
  await deleteSession(sessionId);
  return true;
});
