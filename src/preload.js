const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bocApp', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getCurrencyOptions: () => ipcRenderer.invoke('currency:list'),
  pickOutputDirectory: () => ipcRenderer.invoke('dialog:pick-output-directory'),
  openOutputDirectory: (directory) => ipcRenderer.invoke('shell:open-output-directory', { directory }),
  startCapture: (payload) => ipcRenderer.invoke('job:start-capture', payload),
  submitCaptcha: (code) => ipcRenderer.invoke('captcha:submit', { code }),
  refreshCaptcha: () => ipcRenderer.invoke('captcha:refresh'),
  cancelCaptcha: () => ipcRenderer.invoke('captcha:cancel'),
  onProgress: (listener) => ipcRenderer.on('job:progress', (_event, payload) => listener(payload)),
  onFinished: (listener) => ipcRenderer.on('job:finished', (_event, payload) => listener(payload)),
  onError: (listener) => ipcRenderer.on('job:error', (_event, payload) => listener(payload)),
  onCaptchaRequired: (listener) =>
    ipcRenderer.on('captcha:required', (_event, payload) => listener(payload))
});
