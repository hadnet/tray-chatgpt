const { contextBridge, ipcRenderer } = require("electron");

const SETTINGS_CHANNEL_GET = "settings:get-shortcuts";
const SETTINGS_CHANNEL_SAVE = "settings:save-shortcuts";
const SETTINGS_CHANNEL_RESET = "settings:reset-shortcuts";
const SETTINGS_CHANNEL_SET_TRAY_ICON_HIDDEN =
  "settings:set-tray-icon-hidden";
const SETTINGS_CHANNEL_SAVE_PROMPT_TEMPLATES =
  "settings:save-prompt-templates";
const SETTINGS_CHANNEL_UPDATED = "settings:shortcuts-updated";

contextBridge.exposeInMainWorld("trayChatGPTSettings", {
  getShortcuts: () => ipcRenderer.invoke(SETTINGS_CHANNEL_GET),
  saveShortcuts: (shortcuts) =>
    ipcRenderer.invoke(SETTINGS_CHANNEL_SAVE, shortcuts),
  resetShortcuts: () => ipcRenderer.invoke(SETTINGS_CHANNEL_RESET),
  setTrayIconHidden: (hidden) =>
    ipcRenderer.invoke(SETTINGS_CHANNEL_SET_TRAY_ICON_HIDDEN, hidden),
  savePromptTemplates: (templates) =>
    ipcRenderer.invoke(SETTINGS_CHANNEL_SAVE_PROMPT_TEMPLATES, templates),
  onShortcutsUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(SETTINGS_CHANNEL_UPDATED, listener);
    return () => ipcRenderer.removeListener(SETTINGS_CHANNEL_UPDATED, listener);
  },
});
