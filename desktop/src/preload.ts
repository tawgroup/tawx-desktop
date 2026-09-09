import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tawxDesktop', {
  onCommand(listener: (command: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, command: string) => listener(command);
    ipcRenderer.on('app-command', handler);
    return () => ipcRenderer.removeListener('app-command', handler);
  },
});
