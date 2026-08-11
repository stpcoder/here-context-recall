import { contextBridge, ipcRenderer } from "electron";
import { ACTIVITY_IPC, DESKTOP_IPC, type HereDesktopApi } from "../shared/contracts";

const subscribe = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

const here: HereDesktopApi = {
  bootstrap: () => ipcRenderer.invoke(DESKTOP_IPC.bootstrap),
  getSettings: () => ipcRenderer.invoke(DESKTOP_IPC.getSettings),
  saveSettings: (input) => ipcRenderer.invoke(DESKTOP_IPC.saveSettings, input),
  testConnection: (input) => ipcRenderer.invoke(DESKTOP_IPC.testConnection, input),
  recall: (trigger) => ipcRenderer.invoke(DESKTOP_IPC.recall, trigger),
  getRecall: () => ipcRenderer.invoke(DESKTOP_IPC.getRecall),
  dismissRecall: () => ipcRenderer.invoke(DESKTOP_IPC.dismissRecall),
  openSettings: () => ipcRenderer.invoke(DESKTOP_IPC.openSettings),
  closeSettings: () => ipcRenderer.invoke(DESKTOP_IPC.closeSettings),
  clearHistory: () => ipcRenderer.invoke(DESKTOP_IPC.clearHistory),
  pauseCapture: () => ipcRenderer.invoke(DESKTOP_IPC.pauseCapture),
  resumeCapture: () => ipcRenderer.invoke(DESKTOP_IPC.resumeCapture),
  setBubbleExpanded: (expanded) => ipcRenderer.invoke(DESKTOP_IPC.setBubbleExpanded, expanded),
  onRecall: (listener) => subscribe(DESKTOP_IPC.recallChanged, listener),
  onSettings: (listener) => subscribe(DESKTOP_IPC.settingsChanged, listener),
  onActivity: (listener) => subscribe(ACTIVITY_IPC.event, listener),
};

contextBridge.exposeInMainWorld("here", here);
