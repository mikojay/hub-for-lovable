// Bridge between the Hub UI and the main process. Only these calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  projects: () => ipcRenderer.invoke('projects'),
  focus: (id, bounds) => ipcRenderer.invoke('focus', { id, bounds }),
  setBounds: bounds => ipcRenderer.send('bounds', bounds),
  hide: capture => ipcRenderer.invoke('hide', { capture }),
  show: () => ipcRenderer.send('show'),
  focusView: () => ipcRenderer.send('focus-view'),
  send: (id, text, mode) => ipcRenderer.invoke('send', { id, text, mode }),
  reload: () => ipcRenderer.send('reload'),
  openExternal: url => ipcRenderer.send('open-external', url),
  addProject: (id, name) => ipcRenderer.invoke('add-project', { id, name }),
  rename: (id, name) => ipcRenderer.send('rename', { id, name }),
  warm: id => ipcRenderer.send('warm', id),
  workspaceMenu: (x, y) => ipcRenderer.send('workspace-menu', { x, y }),
  on: (channel, fn) => {
    const allowed = ['status', 'snapshot', 'key', 'title', 'login', 'live', 'projects'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
