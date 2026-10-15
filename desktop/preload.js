const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['toggle-record', 'now-playing', 'connection', 'config', 'notice', 'chat'];

contextBridge.exposeInMainWorld('jarvis', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  disconnect: () => ipcRenderer.invoke('config:disconnect'),
  runActions: (actions) => ipcRenderer.invoke('actions:run', actions),
  musicControl: (action) => ipcRenderer.invoke('music:control', action),
  showPlayer: () => ipcRenderer.invoke('music:show'),
  on: (channel, callback) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_e, payload) => callback(payload));
  },
});
