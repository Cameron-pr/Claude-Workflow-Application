const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  sendMessage: (text, opts) => ipcRenderer.invoke('send-message', text, opts),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  setSidebarOpen: (open) => ipcRenderer.invoke('set-sidebar-open', open),
  minimize: () => ipcRenderer.invoke('minimize'),
  close: () => ipcRenderer.invoke('close'),

  onAskQuestion: (callback) => ipcRenderer.on('ask-question', (event, data) => callback(data)),
  answerQuestion: (requestId, answers) => ipcRenderer.send('answer-question', { requestId, answers }),

  onAskApproval: (callback) => ipcRenderer.on('ask-approval', (event, data) => callback(data)),
  onAgentEvent: (callback) => ipcRenderer.on('agent-event', (event, data) => callback(data)),
  openOutputWindow: (title, text) => ipcRenderer.send('open-output-window', { title, text }),
  answerApproval: (requestId, allow) => ipcRenderer.send('answer-approval', { requestId, allow }),

  listSessions: () => ipcRenderer.invoke('list-sessions'),
  loadSession: (sessionId) => ipcRenderer.invoke('load-session', sessionId),
  archiveSession: (sessionId) => ipcRenderer.invoke('archive-session', sessionId),
  unarchiveSession: (sessionId) => ipcRenderer.invoke('unarchive-session', sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke('delete-session', sessionId),
});
