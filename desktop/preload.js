const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['toggle-record', 'now-playing', 'connection', 'config', 'notice', 'chat', 'local-music', 'ui-state', 'ui-refresh', 'mini-focus', 'reminder'];

contextBridge.exposeInMainWorld('jarvis', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  disconnect: () => ipcRenderer.invoke('config:disconnect'),
  runActions: (actions) => ipcRenderer.invoke('actions:run', actions),
  musicControl: (action) => ipcRenderer.invoke('music:control', action),
  duckMusic: (on) => ipcRenderer.invoke('music:duck', on),
  showPlayer: () => ipcRenderer.invoke('music:show'),
  // Modo compacto: a janela principal publica o estado; a compacta mostra e manda comandos.
  uiState: (state) => ipcRenderer.send('ui:state', state),
  showMini: () => ipcRenderer.invoke('mini:show'),
  miniInfo: () => ipcRenderer.invoke('mini:info'),
  miniCommand: (cmd) => ipcRenderer.invoke('mini:command', cmd),
  on: (channel, callback) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_e, payload) => callback(payload));
  },
});
