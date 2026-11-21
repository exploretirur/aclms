const { contextBridge, ipcRenderer } = require('electron');

// The only things the website can use from the desktop app.
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  tally: (xml) => ipcRenderer.invoke('tally', xml),
  launchTally: () => ipcRenderer.invoke('launchTally')
});
