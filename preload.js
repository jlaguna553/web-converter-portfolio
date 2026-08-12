const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Folder selection
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectOutputFolder: () => ipcRenderer.invoke('select-output-folder'),

  // Project analysis
  analyzeProject: (projectPath) => ipcRenderer.invoke('analyze-project', projectPath),

  // Requirements check
  checkRequirements: (platform) => ipcRenderer.invoke('check-requirements', platform),

  // Conversion
  startConversion: (config) => ipcRenderer.invoke('start-conversion', config),
  cancelConversion: () => ipcRenderer.invoke('cancel-conversion'),

  // Utilities
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // Event listeners
  onConversionEvent: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('conversion-event', handler);
    return () => ipcRenderer.removeListener('conversion-event', handler);
  }
});
