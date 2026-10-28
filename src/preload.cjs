// The renderer's only way to reach the main process: a fixed set of calls and
// events (see src/main/ipc.js for what each does).
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = ['changed', 'navigate', 'command'];

contextBridge.exposeInMainWorld('updeps', {
  context: invoke('app:context'),
  relocate: invoke('app:relocate'),
  readConfig: invoke('config:read'),
  checkConfig: invoke('config:check'),
  writeConfig: invoke('config:write'),
  editConfig: invoke('config:edit'),
  inspectRepo: invoke('repo:inspect'),
  pickFolder: invoke('dialog:folder'),
  confirm: invoke('dialog:confirm'),
  readStatus: invoke('status:read'),
  inspectService: invoke('service:inspect'),
  readHistory: invoke('history:read'),
  readRun: invoke('run:read'),
  readLog: invoke('log:read'),
  run: invoke('cli:run'),
  setAutostart: invoke('autostart:set'),
  reveal: invoke('shell:reveal'),
  /**
   * @param {'changed'|'navigate'|'command'} event
   * @param {(payload: any) => void} listener
   * @returns {() => void} unsubscribes
   */
  on(event, listener) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    const handler = (_e, payload) => listener(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  }
});
