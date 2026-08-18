import {
  app,
  clipboard,
  screen,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  ipcMain,
  Input,
  IpcMainInvokeEvent,
  Menu,
  nativeImage,
  nativeTheme,
  Tray,
  globalShortcut,
  shell,
  systemPreferences,
} from "electron";
import { execFile } from "child_process";
import * as path from "path";
import * as settings from "electron-settings";
import * as os from "os";
import ElectronGoogleOAuth2 from "@getstation/electron-google-oauth2";

const GOOGLE_SCOPES = ["openid", "profile", "email"];

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

const DEFAULT_HEIGHT = 800;
const DEFAULT_WIDTH = 400;
const DRAG_CHANNEL_START = "window-drag:start";
const DRAG_CHANNEL_MOVE = "window-drag:move";
const DRAG_CHANNEL_END = "window-drag:end";
const VISIBLE_ON_CURRENT_SPACE_OPTIONS = { visibleOnFullScreen: true };
const SETTINGS_CHANNEL_GET = "settings:get-shortcuts";
const SETTINGS_CHANNEL_SAVE = "settings:save-shortcuts";
const SETTINGS_CHANNEL_RESET = "settings:reset-shortcuts";
const SETTINGS_CHANNEL_SET_TRAY_ICON_HIDDEN =
  "settings:set-tray-icon-hidden";
const SETTINGS_CHANNEL_SAVE_PROMPT_TEMPLATES =
  "settings:save-prompt-templates";
const SETTINGS_CHANNEL_UPDATED = "settings:shortcuts-updated";
const SHORTCUT_SETTINGS_KEY = "shortcuts";
const TRAY_ICON_HIDDEN_SETTINGS_KEY = "trayIconHidden";
const PROMPT_TEMPLATES_SETTINGS_KEY = "promptTemplates";
const SETTINGS_WINDOW_SHORTCUT =
  process.platform === "darwin" ? "Command+," : "Ctrl+,";
const SETTINGS_WINDOW_SHORTCUT_LABEL =
  process.platform === "darwin" ? "⌘," : "Ctrl+,";
const SHORTCUT_DEFAULTS = {
  openApp: "Ctrl+Option+Command+C",
  temporaryChat: "CommandOrControl+T",
} as const;
const MODIFIER_ALIASES: Record<string, string> = {
  alt: "Alt",
  option: "Option",
  control: "Ctrl",
  ctrl: "Ctrl",
  command: "Command",
  cmd: "Command",
  meta: "Command",
  super: "Super",
  shift: "Shift",
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
};
const MODIFIER_ORDER = [
  "CommandOrControl",
  "Ctrl",
  "Control",
  "Option",
  "Alt",
  "Shift",
  "Command",
  "Super",
];

type ShortcutAction = keyof typeof SHORTCUT_DEFAULTS;
type ShortcutConfig = Record<ShortcutAction, string>;
type PromptTemplate = {
  id: string;
  text: string;
  shortcut: string;
};

let tray: Tray | undefined;
let mainWindow: BrowserWindow;
let settingsWindow: BrowserWindow | undefined;
let settingsWindowReady = false;
let settingsWindowShouldShow = false;
let shortcutConfig: ShortcutConfig = { ...SHORTCUT_DEFAULTS };
let promptTemplates: PromptTemplate[] = [];
const registeredPromptShortcuts = new Set<string>();
let promptShortcutRegistrationErrors = new Set<string>();
let trayIconHidden = false;
let settingsShortcutRegistered = false;
let isQuitting = false;
let toggleTemporaryChatHandler: (() => void | Promise<void>) | undefined;
let resetWorkspaceVisibilityTimer: ReturnType<typeof setTimeout> | undefined;
let resetSettingsWorkspaceVisibilityTimer:
  | ReturnType<typeof setTimeout>
  | undefined;
let dragState:
  | {
      cursorX: number;
      cursorY: number;
      windowX: number;
      windowY: number;
    }
  | undefined;

/* ──────────────────────────────────────────────
  1. CHROME PROFILE SHARED WITH ELECTRON
────────────────────────────────────────────── */

const CHROME_PROFILE_NAME = process.env.CHROME_PROFILE ?? "Default";

const chromeProfilePath =
  process.platform === "darwin"
    ? path.join(
        os.homedir(),
        "Library/Application Support/Google/Chrome",
        CHROME_PROFILE_NAME,
      )
    : process.platform === "win32"
      ? path.join(
          os.homedir(),
          "AppData/Local/Google/Chrome/User Data",
          CHROME_PROFILE_NAME,
        )
      : path.join(os.homedir(), ".config/google-chrome", CHROME_PROFILE_NAME);

app.setPath("userData", chromeProfilePath);

/* ──────────────────────────────────────────────
  2. (OPTIONAL) EXTERNAL GOOGLE LOGIN
  Useful only if the user is not yet logged into Chrome
────────────────────────────────────────────── */
const oauth = new ElectronGoogleOAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_SCOPES,
  {
    successRedirectURL: "https://oauth.pstmn.io/v1/browser-callback",
    refocusAfterSuccess: true,
  },
);

// async function ensureGoogleLogged() {
//   try {
//     await oauth.openAuthWindowAndGetTokens(); // abre navegador externo
//   } catch (err) {
//     console.error("Falha ao autenticar com Google:", err);
//   }
// }

/* ──────────────────────────────────────────────
  3. PERMISSION CHECKS (unchanged)
────────────────────────────────────────────── */
const checkMicrophonePermission = async () => {
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return;
  if (process.platform === "darwin") {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    if (!granted) {
      shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
    }
  } else if (process.platform === "win32") {
    shell.openExternal("ms-settings:privacy-microphone");
  }
};

function normalizeKeyName(key: string) {
  const namedKeys: Record<string, string> = {
    " ": "Space",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    arrowup: "Up",
    esc: "Escape",
    plus: "Plus",
    return: "Enter",
  };
  const normalized = namedKeys[key.toLowerCase()] ?? key;
  if (normalized.length === 1) return normalized.toUpperCase();
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function normalizeAccelerator(value: unknown) {
  if (typeof value !== "string") return undefined;

  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const modifiers = new Set<string>();
  let key: string | undefined;

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (key) return undefined;
    key = normalizeKeyName(part);
  }

  if (!key || modifiers.size === 0) return undefined;

  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  ].join("+");
}

function acceleratorIdentity(accelerator: string) {
  const commandOrControl = process.platform === "darwin" ? "Command" : "Ctrl";
  return accelerator.replace("CommandOrControl", commandOrControl);
}

function acceleratorsConflict(first: string, second: string) {
  return acceleratorIdentity(first) === acceleratorIdentity(second);
}

function normalizeShortcutConfig(value: unknown): ShortcutConfig | undefined {
  if (!value || typeof value !== "object") return undefined;

  const source = value as Partial<Record<ShortcutAction, unknown>>;
  const openApp = normalizeAccelerator(source.openApp);
  const temporaryChat = normalizeAccelerator(source.temporaryChat);
  if (
    !openApp ||
    !temporaryChat ||
    acceleratorsConflict(openApp, temporaryChat)
  ) {
    return undefined;
  }

  return { openApp, temporaryChat };
}

function conflictsWithSettingsShortcut(config: ShortcutConfig) {
  return Object.values(config).some(
    (accelerator) =>
      acceleratorIdentity(accelerator) === SETTINGS_WINDOW_SHORTCUT,
  );
}

function normalizePromptTemplates(value: unknown): PromptTemplate[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const ids = new Set<string>();
  const shortcuts = new Set<string>();
  const normalized: PromptTemplate[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;

    const source = item as Partial<Record<keyof PromptTemplate, unknown>>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const text = typeof source.text === "string" ? source.text : "";
    const shortcut = normalizeAccelerator(source.shortcut);
    if (!id || !text.trim() || !shortcut) return undefined;

    const shortcutIdentity = acceleratorIdentity(shortcut);
    if (ids.has(id) || shortcuts.has(shortcutIdentity)) return undefined;

    ids.add(id);
    shortcuts.add(shortcutIdentity);
    normalized.push({ id, text, shortcut });
  }

  return normalized;
}

function promptTemplateShortcutConflict(
  templates: PromptTemplate[],
  shortcuts: ShortcutConfig = shortcutConfig,
) {
  return templates.find((template) => {
    if (acceleratorsConflict(template.shortcut, SETTINGS_WINDOW_SHORTCUT)) {
      return true;
    }

    return Object.values(shortcuts).some((shortcut) =>
      acceleratorsConflict(template.shortcut, shortcut),
    );
  });
}

function shortcutConfigPromptConflict(config: ShortcutConfig) {
  return promptTemplates.find((template) =>
    Object.values(config).some((shortcut) =>
      acceleratorsConflict(template.shortcut, shortcut),
    ),
  );
}

async function loadShortcutConfig() {
  const saved = await settings.get(SHORTCUT_SETTINGS_KEY);
  const normalized = normalizeShortcutConfig(saved);
  shortcutConfig =
    normalized && !conflictsWithSettingsShortcut(normalized)
      ? normalized
      : { ...SHORTCUT_DEFAULTS };
  await settings.set(SHORTCUT_SETTINGS_KEY, shortcutConfig);
}

async function loadTrayIconSetting() {
  const saved = await settings.get(TRAY_ICON_HIDDEN_SETTINGS_KEY);
  trayIconHidden = typeof saved === "boolean" ? saved : false;
  await settings.set(TRAY_ICON_HIDDEN_SETTINGS_KEY, trayIconHidden);
}

async function loadPromptTemplates() {
  const saved = await settings.get(PROMPT_TEMPLATES_SETTINGS_KEY);
  const normalized = normalizePromptTemplates(saved) ?? [];
  promptTemplates = promptTemplateShortcutConflict(normalized) ? [] : normalized;
  await settings.set(PROMPT_TEMPLATES_SETTINGS_KEY, promptTemplates);
}

async function saveShortcutConfig(nextConfig: ShortcutConfig) {
  await settings.set(SHORTCUT_SETTINGS_KEY, nextConfig);
  shortcutConfig = nextConfig;
  updateSettingsWindowShortcuts();
}

function runPasteCommand(command: string, args: string[]) {
  execFile(command, args, (error) => {
    if (error) console.error("Unable to paste prompt template:", error);
  });
}

function pasteClipboardAtCursor() {
  if (process.platform === "darwin") {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true);
      return;
    }

    runPasteCommand("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
    return;
  }

  if (process.platform === "win32") {
    runPasteCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")',
    ]);
    return;
  }

  execFile(
    "xdotool",
    ["key", "--clearmodifiers", "ctrl+v"],
    (xdotoolError) => {
      if (!xdotoolError) return;
      execFile("wtype", ["-M", "ctrl", "v", "-m", "ctrl"], (wtypeError) => {
        if (wtypeError) {
          console.error(
            "Unable to paste prompt template. Install xdotool (X11) or wtype (Wayland).",
            wtypeError,
          );
        }
      });
    },
  );
}

function triggerPromptTemplate(text: string) {
  clipboard.writeText(text);
  setTimeout(pasteClipboardAtCursor, 60);
}

function unregisterPromptTemplateShortcuts() {
  for (const shortcut of registeredPromptShortcuts) {
    globalShortcut.unregister(shortcut);
  }
  registeredPromptShortcuts.clear();
}

function registerPromptTemplateShortcuts(templates: PromptTemplate[]) {
  unregisterPromptTemplateShortcuts();
  promptShortcutRegistrationErrors = new Set<string>();

  for (const template of templates) {
    const didRegister = globalShortcut.register(template.shortcut, () =>
      triggerPromptTemplate(template.text),
    );
    if (didRegister) {
      registeredPromptShortcuts.add(template.shortcut);
    } else {
      promptShortcutRegistrationErrors.add(template.id);
    }
  }
}

async function savePromptTemplates(nextTemplates: PromptTemplate[]) {
  const previousTemplates = promptTemplates;
  registerPromptTemplateShortcuts(nextTemplates);

  if (promptShortcutRegistrationErrors.size > 0) {
    const failedTemplate = nextTemplates.find((template) =>
      promptShortcutRegistrationErrors.has(template.id),
    );
    registerPromptTemplateShortcuts(previousTemplates);
    throw new Error(
      `${failedTemplate?.shortcut ?? "A shortcut"} could not be registered. It may already be used by the system or another app.`,
    );
  }

  try {
    await settings.set(PROMPT_TEMPLATES_SETTINGS_KEY, nextTemplates);
  } catch (error) {
    registerPromptTemplateShortcuts(previousTemplates);
    throw error;
  }

  promptTemplates = nextTemplates;
  updateSettingsWindowShortcuts();
}

function registerOpenAppShortcut(
  nextAccelerator: string,
  previousAccelerator = shortcutConfig.openApp,
) {
  if (globalShortcut.isRegistered(previousAccelerator)) {
    globalShortcut.unregister(previousAccelerator);
  }
  if (
    previousAccelerator !== nextAccelerator &&
    globalShortcut.isRegistered(nextAccelerator)
  ) {
    globalShortcut.unregister(nextAccelerator);
  }

  const didRegister = globalShortcut.register(nextAccelerator, toggleMainWindow);
  if (!didRegister) {
    globalShortcut.register(previousAccelerator, toggleMainWindow);
  }

  return didRegister;
}

function acceleratorMatchesInput(
  accelerator: string,
  input: Input,
) {
  if (input.type !== "keyDown") return false;

  const parts = normalizeAccelerator(accelerator)?.split("+");
  if (!parts) return false;

  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  const commandOrControlPressed = input.meta || input.control;

  if (modifiers.has("CommandOrControl") && !commandOrControlPressed) {
    return false;
  }
  if (!modifiers.has("CommandOrControl") && (input.meta || input.control)) {
    const expectedCommand = modifiers.has("Command");
    const expectedControl = modifiers.has("Ctrl") || modifiers.has("Control");
    if (input.meta !== expectedCommand || input.control !== expectedControl) {
      return false;
    }
  }
  if (modifiers.has("Command") && !input.meta) return false;
  if ((modifiers.has("Ctrl") || modifiers.has("Control")) && !input.control) {
    return false;
  }
  if ((modifiers.has("Alt") || modifiers.has("Option")) !== input.alt) {
    return false;
  }
  if (modifiers.has("Shift") !== input.shift) return false;

  return normalizeKeyName(input.key) === key;
}

function getShortcutSettingsPayload() {
  return {
    shortcuts: shortcutConfig,
    defaults: SHORTCUT_DEFAULTS,
    trayIconHidden,
    settingsShortcut: SETTINGS_WINDOW_SHORTCUT,
    settingsShortcutLabel: SETTINGS_WINDOW_SHORTCUT_LABEL,
    settingsShortcutRegistered,
    promptTemplates,
    promptShortcutRegistrationErrors: [
      ...promptShortcutRegistrationErrors,
    ],
    platform: process.platform,
  };
}

function updateSettingsWindowShortcuts() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsWindow.webContents.send(
    SETTINGS_CHANNEL_UPDATED,
    getShortcutSettingsPayload(),
  );
}

/* ──────────────────────────────────────────────
  4. TRAY AND WINDOW CREATION (unchanged)
────────────────────────────────────────────── */
function createTray() {
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, "images", "icon.png"),
  );
  const tray = new Tray(trayIcon);
  tray.on("click", toggleMainWindow);
  tray.on("right-click", showContextMenu);
  return tray;
}

function updateTrayIconVisibility() {
  if (trayIconHidden) {
    tray?.destroy();
    tray = undefined;
    return;
  }

  if (!tray || tray.isDestroyed()) {
    tray = createTray();
  }
}

async function saveTrayIconHidden(nextValue: boolean) {
  const previousValue = trayIconHidden;
  await settings.set(TRAY_ICON_HIDDEN_SETTINGS_KEY, nextValue);
  trayIconHidden = nextValue;

  try {
    updateTrayIconVisibility();
  } catch (error) {
    trayIconHidden = previousValue;
    await settings.set(TRAY_ICON_HIDDEN_SETTINGS_KEY, previousValue);
    updateTrayIconVisibility();
    throw error;
  }

  updateSettingsWindowShortcuts();
}

function createContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Open Tray ChatGPT",
      accelerator: shortcutConfig.openApp,
      click: () => showMainWindow(),
    },
    {
      label: "Settings",
      accelerator: SETTINGS_WINDOW_SHORTCUT,
      registerAccelerator: false,
      click: () => showSettingsWindow(),
    },
    { type: "separator" },
    {
      label: "Close Window",
      accelerator: "Esc",
      click: () => hideMainWindow(),
    },
    {
      label: "Reload",
      accelerator: "CmdOrCtrl+R",
      click: () => mainWindow.reload(),
    },
    {
      label: "Toggle Full Screen",
      accelerator: "Ctrl+CmdOrCtrl+F",
      click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()),
    },
    {
      label: "Reset Screen Size",
      accelerator: "Ctrl+CmdOrCtrl+R",
      click: () => resetMainWindowSize(),
    },
    { type: "separator" },
    { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ]);
}

function createMainWindow() {
  const win = new BrowserWindow({
    frame: false,
    resizable: true,
    transparent: false,
    show: false,
    movable: true,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
    },
  });

  win.on("blur", hideMainWindow);
  win.on("resize", handleWindowResize);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      hideMainWindow();
    }
  });
  nativeTheme.on("updated", updateMainWindowTheme);
  return win;
}

async function resetMainWindowSize() {
  const width = DEFAULT_WIDTH;
  const height = DEFAULT_HEIGHT;
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  mainWindow.setBounds({ x, y, width, height });
  await settings.set("width", width);
  await settings.set("height", height);
}
function handleWindowResize() {
  const [width, height] = mainWindow.getSize();
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  mainWindow.setPosition(x, y);
  settings.set("width", width);
  settings.set("height", height);
}
function toggleMainWindow() {
  mainWindow.isVisible() ? hideMainWindow() : showMainWindow();
}
async function showMainWindow() {
  const { width, height } = mainWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  });
  showMainWindowOnCurrentSpace();
}
function hideMainWindow() {
  dragState = undefined;
  clearWorkspaceVisibilityReset();
  if (process.platform === "darwin") {
    mainWindow.setVisibleOnAllWorkspaces(
      false,
      VISIBLE_ON_CURRENT_SPACE_OPTIONS,
    );
  }
  mainWindow.hide();
  if (
    process.platform === "darwin" &&
    (!settingsWindow || !settingsWindow.isVisible())
  ) {
    app.dock.hide();
  }
}
function clearWorkspaceVisibilityReset() {
  if (!resetWorkspaceVisibilityTimer) return;

  clearTimeout(resetWorkspaceVisibilityTimer);
  resetWorkspaceVisibilityTimer = undefined;
}
function showMainWindowOnCurrentSpace() {
  if (process.platform !== "darwin") {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  clearWorkspaceVisibilityReset();
  mainWindow.setVisibleOnAllWorkspaces(true, VISIBLE_ON_CURRENT_SPACE_OPTIONS);
  mainWindow.show();
  mainWindow.focus();

  resetWorkspaceVisibilityTimer = setTimeout(() => {
    resetWorkspaceVisibilityTimer = undefined;
    if (mainWindow.isDestroyed()) return;

    mainWindow.setVisibleOnAllWorkspaces(
      false,
      VISIBLE_ON_CURRENT_SPACE_OPTIONS,
    );
  }, 100);
}
function updateMainWindowTheme() {
  const background = nativeTheme.shouldUseDarkColors ? "#343541" : "#FFF";
  const text = nativeTheme.shouldUseDarkColors ? "#FFF" : "#000";
  mainWindow.webContents.insertCSS(
    `body { background-color: ${background}; color: ${text}; margin: 0; border-radius: 80px; -electron-corner-smoothing: system-ui; overflow: hidden; }`,
  );
}
function showContextMenu() {
  tray?.popUpContextMenu(createContextMenu());
}

function getSettingsWindowHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline';" />
  <title>Tray ChatGPT Settings</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
      --accent: #0a84ff;
      --accent-text: #ffffff;
    }

    * {
      box-sizing: border-box;
    }

    [hidden] {
      display: none !important;
    }

    html,
    body {
      margin: 0;
      height: 100%;
      background: Canvas;
      overflow: hidden;
    }

    button,
    input,
    textarea {
      font: inherit;
    }

    button {
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 7px;
      background: ButtonFace;
      color: ButtonText;
      font-size: 13px;
    }

    button:hover {
      background: color-mix(in srgb, ButtonFace 90%, CanvasText);
    }

    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }

    button.danger {
      color: #c53232;
    }

    button.icon-button {
      display: inline-flex;
      width: 34px;
      min-height: 34px;
      padding: 0;
      align-items: center;
      justify-content: center;
      justify-self: center;
      border-color: transparent;
      background: transparent;
      color: color-mix(in srgb, CanvasText 62%, transparent);
    }

    button.icon-button:hover {
      background: color-mix(in srgb, CanvasText 10%, transparent);
      color: CanvasText;
    }

    button.icon-button.danger:hover {
      background: color-mix(in srgb, #c53232 14%, transparent);
      color: #e54848;
    }

    button.icon-button svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .settings-shell {
      display: grid;
      grid-template-columns: 210px minmax(0, 1fr);
      height: 100vh;
    }

    .content {
      grid-column: 2;
      grid-row: 1;
      min-width: 0;
      padding: 30px 34px;
      overflow-y: auto;
    }

    .sidebar {
      grid-column: 1;
      grid-row: 1;
      padding: 26px 14px;
      border-right: 1px solid color-mix(in srgb, CanvasText 13%, transparent);
      background: color-mix(in srgb, Canvas 96%, CanvasText);
    }

    .sidebar-title {
      margin: 0 10px 20px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: color-mix(in srgb, CanvasText 56%, transparent);
    }

    .sidebar nav {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .nav-item {
      width: 100%;
      min-height: 38px;
      padding: 8px 11px;
      border-color: transparent;
      background: transparent;
      text-align: left;
      font-weight: 550;
    }

    .nav-item.active {
      border-color: color-mix(in srgb, var(--accent) 42%, transparent);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--accent);
    }

    .page {
      display: none;
      max-width: 610px;
      margin: 0 auto;
    }

    .page.active {
      display: block;
    }

    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 26px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      font-weight: 680;
    }

    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
    }

    .description,
    .hint {
      margin: 0;
      color: color-mix(in srgb, CanvasText 62%, transparent);
      font-size: 13px;
      line-height: 1.45;
    }

    .settings-group {
      margin-bottom: 24px;
      border: 1px solid color-mix(in srgb, CanvasText 13%, transparent);
      border-radius: 10px;
      overflow: hidden;
      background: color-mix(in srgb, Canvas 98%, CanvasText);
    }

    .group-heading {
      padding: 13px 16px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 11%, transparent);
    }

    .setting {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 220px 82px;
      align-items: center;
      gap: 12px;
      padding: 13px 16px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
    }

    .setting:last-child {
      border-bottom: 0;
    }

    label {
      font-size: 14px;
      font-weight: 600;
    }

    input[type="text"] {
      width: 100%;
      min-height: 36px;
      padding: 7px 10px;
      border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 7px;
      background: color-mix(in srgb, Canvas 94%, CanvasText);
      color: CanvasText;
      font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    input[type="text"].recording {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .shortcut-value {
      display: flex;
      min-width: 0;
      min-height: 36px;
      align-items: center;
    }

    .shortcut-display {
      display: flex;
      min-height: 36px;
      align-items: center;
      gap: 4px;
      color: color-mix(in srgb, CanvasText 82%, transparent);
    }

    .shortcut-display.empty {
      color: color-mix(in srgb, CanvasText 48%, transparent);
      font-size: 13px;
    }

    .shortcut-display kbd {
      display: inline-flex;
      min-width: 27px;
      height: 27px;
      padding: 0 7px;
      align-items: center;
      justify-content: center;
      border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, Canvas 92%, CanvasText);
      box-shadow: 0 1px 0 color-mix(in srgb, CanvasText 18%, transparent);
      font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap;
    }

    .toggle-setting {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      align-items: start;
      gap: 10px;
      padding: 15px 16px;
    }

    .toggle-setting input {
      width: 16px;
      height: 16px;
      margin: 2px 0 0;
      accent-color: var(--accent);
    }

    .toggle-setting .hint {
      margin: 5px 0 0;
    }

    .fixed-shortcut {
      color: color-mix(in srgb, CanvasText 56%, transparent);
      font-size: 12px;
      text-align: center;
    }

    .prompt-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .prompt-card {
      padding: 16px;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, Canvas 98%, CanvasText);
    }

    .prompt-card.unavailable {
      border-color: #c53232;
    }

    .prompt-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .prompt-number {
      font-size: 13px;
      font-weight: 650;
      color: color-mix(in srgb, CanvasText 65%, transparent);
    }

    textarea {
      display: block;
      width: 100%;
      min-height: 94px;
      margin-top: 7px;
      padding: 10px 11px;
      resize: vertical;
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 7px;
      background: color-mix(in srgb, Canvas 94%, CanvasText);
      color: CanvasText;
      font-size: 14px;
      font-weight: 400;
      line-height: 1.45;
    }

    textarea:focus,
    input:focus {
      outline: 2px solid color-mix(in srgb, var(--accent) 70%, transparent);
      outline-offset: 1px;
    }

    .prompt-shortcut-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 40px;
      align-items: end;
      gap: 10px;
      margin-top: 13px;
    }

    #templatePermissionHint {
      margin-bottom: 16px;
    }

    .prompt-shortcut-row label {
      grid-column: 1 / -1;
      margin-bottom: -4px;
    }

    .prompt-error {
      margin: 10px 0 0;
      color: #c53232;
      font-size: 12px;
    }

    .empty-state {
      padding: 54px 28px;
      border: 1px dashed color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 10px;
      color: color-mix(in srgb, CanvasText 58%, transparent);
      text-align: center;
      font-size: 14px;
    }

    .actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 16px;
    }

    .status {
      flex: 1;
      min-height: 20px;
      color: color-mix(in srgb, CanvasText 68%, transparent);
      font-size: 13px;
    }

    .status.error {
      color: #c53232;
    }

    @media (max-width: 760px) {
      .setting {
        grid-template-columns: 1fr 180px 76px;
        gap: 8px;
      }
    }
  </style>
</head>
<body>
  <div class="settings-shell">
    <main class="content">
      <section id="page-general" class="page active" data-page-panel="general">
        <header class="page-header">
          <div>
            <h1>General</h1>
            <p class="description">Manage the tray icon and app-wide keyboard shortcuts.</p>
          </div>
        </header>

        <div class="settings-group">
          <div class="group-heading"><h2>Tray icon</h2></div>
          <div class="toggle-setting">
            <input id="hideTrayIcon" type="checkbox" />
            <div>
              <label for="hideTrayIcon">Hide system tray icon</label>
              <p id="trayShortcutHint" class="hint">You can reopen Settings with Command+,.</p>
            </div>
          </div>
        </div>

        <div class="settings-group">
          <div class="group-heading"><h2>Keyboard shortcuts</h2></div>
          <div class="setting">
            <label for="openApp">Open app</label>
            <div class="shortcut-value">
              <span id="openAppDisplay" class="shortcut-display"></span>
              <input id="openApp" hidden readonly />
            </div>
            <button
              class="icon-button"
              data-record="openApp"
              aria-label="Edit Open app shortcut"
              title="Edit shortcut"
            ></button>
          </div>
          <div class="setting">
            <label for="temporaryChat">Temporary chat</label>
            <div class="shortcut-value">
              <span id="temporaryChatDisplay" class="shortcut-display"></span>
              <input id="temporaryChat" hidden readonly />
            </div>
            <button
              class="icon-button"
              data-record="temporaryChat"
              aria-label="Edit Temporary chat shortcut"
              title="Edit shortcut"
            ></button>
          </div>
          <div class="setting">
            <label>Open Settings</label>
            <span id="settingsShortcutDisplay" class="shortcut-display"></span>
            <span class="fixed-shortcut">Fixed</span>
          </div>
        </div>

        <div class="actions">
          <div id="generalStatus" class="status" role="status"></div>
          <button id="reset">Reset shortcuts</button>
          <button id="save" class="primary">Save shortcuts</button>
        </div>
      </section>

      <section id="page-prompt-templates" class="page" data-page-panel="prompt-templates">
        <header class="page-header">
          <div>
            <h1>Prompt Templates</h1>
            <p class="description">Paste reusable text into any app with a global shortcut.</p>
          </div>
          <button id="addPrompt" class="primary">Add prompt</button>
        </header>

        <p id="templatePermissionHint" class="hint"></p>
        <div id="templateList" class="prompt-list"></div>
        <div id="templateEmpty" class="empty-state">
          No prompt templates yet. Add one to create your first reusable prompt.
        </div>

        <div class="actions">
          <div id="templateStatus" class="status" role="status"></div>
          <button id="savePrompts" class="primary">Save templates</button>
        </div>
      </section>
    </main>

    <aside class="sidebar" aria-label="Settings sections">
      <div class="sidebar-title">Settings</div>
      <nav>
        <button class="nav-item active" data-page="general" aria-selected="true">General</button>
        <button class="nav-item" data-page="prompt-templates" aria-selected="false">Prompt Templates</button>
      </nav>
    </aside>
  </div>
  <script>
    const api = window.trayChatGPTSettings;
    const fields = {
      openApp: document.getElementById("openApp"),
      temporaryChat: document.getElementById("temporaryChat"),
    };
    const shortcutDisplays = {
      openApp: document.getElementById("openAppDisplay"),
      temporaryChat: document.getElementById("temporaryChatDisplay"),
    };
    const settingsShortcutDisplay = document.getElementById(
      "settingsShortcutDisplay",
    );
    const generalStatus = document.getElementById("generalStatus");
    const templateStatus = document.getElementById("templateStatus");
    const hideTrayIcon = document.getElementById("hideTrayIcon");
    const trayShortcutHint = document.getElementById("trayShortcutHint");
    const templatePermissionHint = document.getElementById("templatePermissionHint");
    const templateList = document.getElementById("templateList");
    const templateEmpty = document.getElementById("templateEmpty");
    let promptTemplates = [];
    let promptRegistrationErrors = new Set();
    let templatesDirty = false;
    let templateIdCounter = 0;
    let currentPlatform = "darwin";
    let activeField;

    function setStatus(target, message, isError = false) {
      target.textContent = message;
      target.classList.toggle("error", isError);
    }

    function setButtonIcon(button, icon, label) {
      const icons = {
        edit:
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
        remove:
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>',
      };
      button.innerHTML = icons[icon];
      button.setAttribute("aria-label", label);
      button.title = label;
    }

    function showPage(pageName) {
      for (const page of document.querySelectorAll("[data-page-panel]")) {
        page.classList.toggle("active", page.dataset.pagePanel === pageName);
      }
      for (const button of document.querySelectorAll("[data-page]")) {
        const active = button.dataset.page === pageName;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      }
    }

    function normalizeKey(key) {
      const map = {
        " ": "Space",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        ArrowUp: "Up",
        Esc: "Escape",
      };
      const value = map[key] || key;
      return value.length === 1 ? value.toUpperCase() : value;
    }

    function acceleratorFromEvent(event) {
      const key = normalizeKey(event.key);
      if (["Alt", "Control", "Meta", "Shift"].includes(key)) return "";

      const parts = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Option");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Command");
      parts.push(key);
      return parts.length > 1 ? parts.join("+") : "";
    }

    function shortcutPartLabel(part, platform) {
      if (platform === "darwin") {
        const macSymbols = {
          Alt: "⌥",
          Backspace: "⌫",
          Command: "⌘",
          CommandOrControl: "⌘",
          Control: "⌃",
          Ctrl: "⌃",
          Delete: "⌦",
          Down: "↓",
          End: "↘",
          Enter: "↩",
          Escape: "⎋",
          Home: "↖",
          Left: "←",
          Option: "⌥",
          Plus: "+",
          Right: "→",
          Shift: "⇧",
          Space: "␠",
          Tab: "⇥",
          Up: "↑",
        };
        return macSymbols[part] || part;
      }

      const labels = {
        Command: "Meta",
        CommandOrControl: "Ctrl",
        Control: "Ctrl",
        Option: "Alt",
        Super: "Meta",
      };
      return labels[part] || part;
    }

    function renderShortcut(target, accelerator, platform = currentPlatform) {
      target.replaceChildren();
      target.classList.toggle("empty", !accelerator);
      if (!accelerator) {
        target.textContent = "Not assigned";
        return;
      }

      for (const part of accelerator.split("+")) {
        const key = document.createElement("kbd");
        key.textContent = shortcutPartLabel(part, platform);
        target.appendChild(key);
      }
    }

    function cancelRecording() {
      if (!activeField) return;
      activeField.input.classList.remove("recording");
      activeField.input.hidden = true;
      activeField.display.hidden = false;
      activeField = undefined;
    }

    function beginRecording(input, display, onCommit, statusTarget) {
      cancelRecording();
      activeField = { input, display, onCommit, statusTarget };
      display.hidden = true;
      input.hidden = false;
      input.classList.add("recording");
      input.focus();
      input.select();
      setStatus(statusTarget, "Press a key combination. Press Escape to cancel.");
    }

    function createTemplateId() {
      templateIdCounter += 1;
      return "prompt-" + Date.now().toString(36) + "-" + templateIdCounter.toString(36);
    }

    function markTemplatesDirty() {
      templatesDirty = true;
      setStatus(templateStatus, "Unsaved changes.");
    }

    function renderTemplates() {
      cancelRecording();
      templateList.replaceChildren();
      templateEmpty.hidden = promptTemplates.length > 0;

      promptTemplates.forEach((template, index) => {
        const card = document.createElement("article");
        card.className = "prompt-card";
        if (promptRegistrationErrors.has(template.id)) {
          card.classList.add("unavailable");
        }

        const header = document.createElement("div");
        header.className = "prompt-card-header";
        const number = document.createElement("span");
        number.className = "prompt-number";
        number.textContent = "Prompt " + (index + 1);
        const remove = document.createElement("button");
        remove.className = "icon-button danger";
        setButtonIcon(remove, "remove", "Remove prompt " + (index + 1));
        remove.addEventListener("click", () => {
          promptTemplates = promptTemplates.filter((item) => item.id !== template.id);
          promptRegistrationErrors.delete(template.id);
          markTemplatesDirty();
          renderTemplates();
        });
        header.append(number, remove);

        const promptLabel = document.createElement("label");
        promptLabel.textContent = "Prompt text";
        const textarea = document.createElement("textarea");
        textarea.placeholder = "Example: Translate this into informal English";
        textarea.value = template.text;
        textarea.addEventListener("input", () => {
          template.text = textarea.value;
          markTemplatesDirty();
        });
        promptLabel.appendChild(textarea);

        const shortcutRow = document.createElement("div");
        shortcutRow.className = "prompt-shortcut-row";
        const shortcutLabel = document.createElement("label");
        shortcutLabel.textContent = "Global keyboard shortcut";
        const shortcutInput = document.createElement("input");
        shortcutInput.type = "text";
        shortcutInput.readOnly = true;
        shortcutInput.placeholder = "Not assigned";
        shortcutInput.value = template.shortcut;
        shortcutInput.hidden = true;
        const shortcutDisplay = document.createElement("span");
        shortcutDisplay.className = "shortcut-display";
        renderShortcut(shortcutDisplay, template.shortcut);
        const shortcutValue = document.createElement("div");
        shortcutValue.className = "shortcut-value";
        shortcutValue.append(shortcutDisplay, shortcutInput);
        const record = document.createElement("button");
        record.className = "icon-button";
        setButtonIcon(record, "edit", "Edit prompt shortcut");
        record.addEventListener("click", () => {
          beginRecording(
            shortcutInput,
            shortcutDisplay,
            (accelerator) => {
              template.shortcut = accelerator;
              markTemplatesDirty();
            },
            templateStatus,
          );
        });
        shortcutRow.append(shortcutLabel, shortcutValue, record);

        card.append(header, promptLabel, shortcutRow);
        if (promptRegistrationErrors.has(template.id)) {
          const error = document.createElement("p");
          error.className = "prompt-error";
          error.textContent =
            "This shortcut is unavailable. Record another shortcut and save again.";
          card.appendChild(error);
        }
        templateList.appendChild(card);
      });
    }

    function setSettings(payload, forceTemplates = false) {
      currentPlatform = payload.platform;
      fields.openApp.value = payload.shortcuts.openApp;
      fields.temporaryChat.value = payload.shortcuts.temporaryChat;
      renderShortcut(shortcutDisplays.openApp, payload.shortcuts.openApp);
      renderShortcut(
        shortcutDisplays.temporaryChat,
        payload.shortcuts.temporaryChat,
      );
      renderShortcut(settingsShortcutDisplay, payload.settingsShortcut);
      hideTrayIcon.checked = payload.trayIconHidden;
      hideTrayIcon.disabled = !payload.settingsShortcutRegistered;
      trayShortcutHint.textContent = payload.settingsShortcutRegistered
        ? "You can reopen Settings with " + payload.settingsShortcutLabel + "."
        : "The Settings shortcut is unavailable, so the tray icon must remain visible.";

      if (payload.platform === "darwin") {
        templatePermissionHint.textContent =
          "The first time you use a template, macOS may ask for Accessibility and Automation access so Tray ChatGPT can paste at the cursor.";
      } else if (payload.platform === "linux") {
        templatePermissionHint.textContent =
          "System-wide paste requires xdotool on X11 or wtype on Wayland.";
      } else {
        templatePermissionHint.textContent =
          "Shortcuts work globally and paste without bringing Tray ChatGPT to the front.";
      }

      promptRegistrationErrors = new Set(payload.promptShortcutRegistrationErrors || []);
      if (forceTemplates || !templatesDirty) {
        promptTemplates = (payload.promptTemplates || []).map((template) => ({
          id: template.id,
          text: template.text,
          shortcut: template.shortcut,
        }));
        templatesDirty = false;
        renderTemplates();
      }
    }

    for (const button of document.querySelectorAll("[data-record]")) {
      setButtonIcon(button, "edit", button.getAttribute("aria-label"));
      button.addEventListener("click", () => {
        const shortcutName = button.dataset.record;
        beginRecording(
          fields[shortcutName],
          shortcutDisplays[shortcutName],
          () => {},
          generalStatus,
        );
      });
    }

    for (const button of document.querySelectorAll("[data-page]")) {
      button.addEventListener("click", () => showPage(button.dataset.page));
    }

    window.addEventListener("keydown", (event) => {
      if (!activeField) return;
      event.preventDefault();
      event.stopPropagation();

      if (
        event.key === "Escape" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const statusTarget = activeField.statusTarget;
        cancelRecording();
        setStatus(statusTarget, "");
        return;
      }

      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;

      const recording = activeField;
      recording.input.value = accelerator;
      recording.input.classList.remove("recording");
      recording.input.hidden = true;
      recording.display.hidden = false;
      activeField = undefined;
      recording.onCommit(accelerator);
      renderShortcut(recording.display, accelerator);
      setStatus(recording.statusTarget, "");
    });

    document.getElementById("save").addEventListener("click", async () => {
      setStatus(generalStatus, "");
      const result = await api.saveShortcuts({
        openApp: fields.openApp.value,
        temporaryChat: fields.temporaryChat.value,
      });
      setStatus(generalStatus, result.ok ? "Saved." : result.error, !result.ok);
      if (result.ok) setSettings(result, false);
    });

    document.getElementById("reset").addEventListener("click", async () => {
      const result = await api.resetShortcuts();
      setStatus(
        generalStatus,
        result.ok ? "Defaults restored." : result.error,
        !result.ok,
      );
      if (result.ok) setSettings(result, false);
    });

    hideTrayIcon.addEventListener("change", async () => {
      setStatus(generalStatus, "");
      const result = await api.setTrayIconHidden(hideTrayIcon.checked);
      setSettings(result, false);
      if (!result.ok) {
        setStatus(generalStatus, result.error, true);
        return;
      }

      setStatus(
        generalStatus,
        result.trayIconHidden
          ? "Tray icon hidden. Use " + result.settingsShortcutLabel + " to reopen Settings."
          : "Tray icon shown.",
      );
    });

    document.getElementById("addPrompt").addEventListener("click", () => {
      const template = { id: createTemplateId(), text: "", shortcut: "" };
      promptTemplates.push(template);
      markTemplatesDirty();
      renderTemplates();
      const textareas = templateList.querySelectorAll("textarea");
      textareas[textareas.length - 1]?.focus();
    });

    document.getElementById("savePrompts").addEventListener("click", async () => {
      setStatus(templateStatus, "");
      const result = await api.savePromptTemplates(promptTemplates);
      if (!result.ok) {
        setStatus(templateStatus, result.error, true);
        return;
      }

      setSettings(result, true);
      setStatus(templateStatus, "Prompt templates saved.");
    });

    api.onShortcutsUpdated((payload) => setSettings(payload, false));
    api.getShortcuts().then((payload) => setSettings(payload, true));
  </script>
</body>
</html>`;
}

function createSettingsWindow() {
  const options: BrowserWindowConstructorOptions = {
    width: 900,
    height: 640,
    title: "Tray ChatGPT Settings",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      nodeIntegration: false,
      sandbox: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
    },
  };
  const win = new BrowserWindow(options);
  settingsWindowReady = false;
  win.once("ready-to-show", () => {
    if (isQuitting || settingsWindow !== win || win.isDestroyed()) return;

    settingsWindowReady = true;
    if (settingsWindowShouldShow) presentSettingsWindow(win);
  });
  win.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    settingsWindowShouldShow = false;
    clearSettingsWorkspaceVisibilityReset();
    if (process.platform === "darwin") {
      win.setVisibleOnAllWorkspaces(
        false,
        VISIBLE_ON_CURRENT_SPACE_OPTIONS,
      );
    }
    win.hide();
  });
  win.on("hide", () => {
    if (process.platform === "darwin" && !mainWindow.isVisible()) {
      app.dock.hide();
    }
  });
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(getSettingsWindowHtml())}`,
  );
  win.on("closed", () => {
    clearSettingsWorkspaceVisibilityReset();
    settingsWindow = undefined;
    settingsWindowReady = false;
    settingsWindowShouldShow = false;
    if (process.platform === "darwin" && !mainWindow.isVisible()) {
      app.dock.hide();
    }
  });
  return win;
}

function clearSettingsWorkspaceVisibilityReset() {
  if (!resetSettingsWorkspaceVisibilityTimer) return;

  clearTimeout(resetSettingsWorkspaceVisibilityTimer);
  resetSettingsWorkspaceVisibilityTimer = undefined;
}

function presentSettingsWindow(win: BrowserWindow) {
  if (process.platform === "darwin") {
    clearSettingsWorkspaceVisibilityReset();
    app.dock.show();
    win.setVisibleOnAllWorkspaces(true, VISIBLE_ON_CURRENT_SPACE_OPTIONS);
  }
  updateSettingsWindowShortcuts();
  win.show();
  win.focus();

  if (process.platform !== "darwin") return;

  resetSettingsWorkspaceVisibilityTimer = setTimeout(() => {
    resetSettingsWorkspaceVisibilityTimer = undefined;
    if (win.isDestroyed()) return;

    win.setVisibleOnAllWorkspaces(
      false,
      VISIBLE_ON_CURRENT_SPACE_OPTIONS,
    );
  }, 100);
}

function showSettingsWindow() {
  settingsWindowShouldShow = true;
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createSettingsWindow();
    return;
  }

  if (!settingsWindowReady) return;
  presentSettingsWindow(settingsWindow);
}

/* ──────────────────────────────────────────────
  5. APP LIFECYCLE
────────────────────────────────────────────── */
app.commandLine.appendSwitch("enable-features", "WebSpeechAPI");

app.whenReady().then(async () => {
  await checkMicrophonePermission();
  await Promise.all([loadShortcutConfig(), loadTrayIconSetting()]);
  await loadPromptTemplates();

  // (Optional) external Google login — can be commented out if not needed
  // await ensureGoogleLogged();

  mainWindow = createMainWindow();
  settingsShortcutRegistered = globalShortcut.register(
    SETTINGS_WINDOW_SHORTCUT,
    showSettingsWindow,
  );
  if (!settingsShortcutRegistered) {
    console.error(
      `Unable to register Settings shortcut: ${SETTINGS_WINDOW_SHORTCUT}`,
    );
    if (trayIconHidden) {
      trayIconHidden = false;
      try {
        await settings.set(TRAY_ICON_HIDDEN_SETTINGS_KEY, false);
      } catch (error) {
        console.error("Unable to restore the tray icon preference:", error);
      }
    }
  }
  updateTrayIconVisibility();
  if (!registerOpenAppShortcut(shortcutConfig.openApp)) {
    console.error(
      `Unable to register open-app shortcut: ${shortcutConfig.openApp}`,
    );
  }
  registerPromptTemplateShortcuts(promptTemplates);
  settingsWindow = createSettingsWindow();

  // after creating mainWindow:
  const CHROME_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/115.0.5790.170 Safari/537.36";

  const ORIGINAL_UA = mainWindow.webContents.getUserAgent();

  let isTemporaryChatEnabled = true;

  const toggleTemporaryChatButton = async () => {
    try {
      const clicked = await mainWindow.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const TIMEOUT = 10000;
          const INTERVAL = 250;
          const MAX_ATTEMPTS = Math.ceil(TIMEOUT / INTERVAL);
          let attempts = 0;

          const findToggleButton = () => {
            const exactMatch = document.querySelector(
              'button[aria-label="Turn on temporary chat"], button[aria-label="Turn off temporary chat"]',
            );
            if (exactMatch) return exactMatch;

            return Array.from(document.querySelectorAll("button")).find((btn) => {
              const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
              const text = (btn.textContent || "").toLowerCase();
              return aria.includes("temporary chat") || text.includes("temporary chat");
            });
          };

          const tryClick = () => {
            const btn = findToggleButton();
            if (!btn) return false;
            btn.click();
            return true;
          };

          if (tryClick()) {
            resolve(true);
            return;
          }

          const timer = setInterval(() => {
            attempts += 1;
            if (tryClick()) {
              clearInterval(timer);
              resolve(true);
              return;
            }
            if (attempts >= MAX_ATTEMPTS) {
              clearInterval(timer);
              resolve(false);
            }
          }, INTERVAL);
        });
      `);
      return Boolean(clicked);
    } catch (err) {
      console.error("Error toggling temp-chat button:", err);
      return false;
    }
  };

  // const triggerTemporaryChatButton = () => {
  //   mainWindow.webContents
  //     .executeJavaScript(
  //       `
  //       (function() {
  //         const SELECTOR = 'button[aria-label="Turn on temporary chat"]';
  //         const TIMEOUT = 30000;
  //         const INTERVAL = 250;
  //         const MAX_ATTEMPTS = Math.ceil(TIMEOUT / INTERVAL);
  //         let attempts = 0;
  //
  //         const clickIfNeeded = () => {
  //           const btn = document.querySelector(SELECTOR);
  //           if (!btn) return false;
  //           btn.click();
  //           return true;
  //         };
  //
  //         // If already rendered, click immediately.
  //         if (clickIfNeeded()) return;
  //
  //         // Poll while app shell/hydration is still rendering.
  //         const timer = setInterval(() => {
  //           attempts += 1;
  //           if (clickIfNeeded() || attempts >= MAX_ATTEMPTS) {
  //             clearInterval(timer);
  //           }
  //         }, INTERVAL);
  //       })();
  //     `,
  //     )
  //     .catch((err) => console.error("Error clicking temp-chat button:", err));
  // };

  // const applyTemporaryChatIfEnabled = () => {
  //   if (!isTemporaryChatEnabled) return;
  //   triggerTemporaryChatButton();
  // };

  const toggleTemporaryChat = async () => {
    const clicked = await toggleTemporaryChatButton();
    // if (!clicked) {
    //   console.warn("Temporary chat toggle button was not found in time.");
    // }
  };
  toggleTemporaryChatHandler = toggleTemporaryChat;

  /* Dynamic User-Agent switching (main frame only) */
  mainWindow.webContents.on(
    "did-start-navigation",
    (_event, url, _isInPlace, _isMainFrame, frameProcessId, frameRoutingId) => {
      // only switch in the main frame
      if (!_isMainFrame) return;

      if (url.startsWith("https://accounts.google.com/")) {
        // Google Sign‑in → original UA
        mainWindow.webContents.setUserAgent(ORIGINAL_UA);
      } else if (
        url.startsWith("https://chat.openai.com/") ||
        url.startsWith("https://chatgpt.com/")
      ) {
        // ChatGPT → UA Chrome spoof
        mainWindow.webContents.setUserAgent(CHROME_UA);
      }
    },
  );

  // Register before initial navigation so first app start is covered.
  // mainWindow.webContents.on("did-finish-load", applyTemporaryChatIfEnabled);
  // mainWindow.webContents.on("did-navigate-in-page", applyTemporaryChatIfEnabled);
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!acceleratorMatchesInput(shortcutConfig.temporaryChat, input)) return;

    event.preventDefault();
    toggleTemporaryChatHandler?.();
  });

  await mainWindow.loadURL("https://chatgpt.com/");
  showMainWindow();

  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      const headers = details.responseHeaders ?? {};
      delete headers["content-security-policy"];
      delete headers["Content-Security-Policy"];
      callback({ responseHeaders: headers });
    },
  );

});

ipcMain.handle(SETTINGS_CHANNEL_GET, () => getShortcutSettingsPayload());

ipcMain.handle(
  SETTINGS_CHANNEL_SAVE,
  async (_event: IpcMainInvokeEvent, value: unknown) => {
    const nextConfig = normalizeShortcutConfig(value);
    if (!nextConfig) {
      return {
        ok: false,
        error:
          "Each shortcut needs at least one modifier and one key, and both shortcuts must be different.",
        ...getShortcutSettingsPayload(),
      };
    }

    if (conflictsWithSettingsShortcut(nextConfig)) {
      return {
        ok: false,
        error: `${SETTINGS_WINDOW_SHORTCUT_LABEL} is reserved for opening Settings.`,
        ...getShortcutSettingsPayload(),
      };
    }

    const promptConflict = shortcutConfigPromptConflict(nextConfig);
    if (promptConflict) {
      return {
        ok: false,
        error: `${promptConflict.shortcut} is already assigned to a prompt template.`,
        ...getShortcutSettingsPayload(),
      };
    }

    const previousConfig = shortcutConfig;
    if (
      nextConfig.openApp !== previousConfig.openApp &&
      !registerOpenAppShortcut(nextConfig.openApp)
    ) {
      return {
        ok: false,
        error: `Could not register ${nextConfig.openApp}. It may already be used by macOS or another app.`,
        ...getShortcutSettingsPayload(),
      };
    }

    try {
      await saveShortcutConfig(nextConfig);
    } catch (error) {
      if (nextConfig.openApp !== previousConfig.openApp) {
        registerOpenAppShortcut(previousConfig.openApp, nextConfig.openApp);
      }
      shortcutConfig = previousConfig;
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not save shortcuts.",
        ...getShortcutSettingsPayload(),
      };
    }

    return { ok: true, ...getShortcutSettingsPayload() };
  },
);

ipcMain.handle(SETTINGS_CHANNEL_RESET, async () => {
  const previousConfig = shortcutConfig;
  const promptConflict = shortcutConfigPromptConflict({ ...SHORTCUT_DEFAULTS });
  if (promptConflict) {
    return {
      ok: false,
      error: `${promptConflict.shortcut} is already assigned to a prompt template.`,
      ...getShortcutSettingsPayload(),
    };
  }

  if (
    SHORTCUT_DEFAULTS.openApp !== previousConfig.openApp &&
    !registerOpenAppShortcut(SHORTCUT_DEFAULTS.openApp)
  ) {
    return {
      ok: false,
      error: `Could not register ${SHORTCUT_DEFAULTS.openApp}. It may already be used by macOS or another app.`,
      ...getShortcutSettingsPayload(),
    };
  }

  try {
    await saveShortcutConfig({ ...SHORTCUT_DEFAULTS });
  } catch (error) {
    registerOpenAppShortcut(previousConfig.openApp, SHORTCUT_DEFAULTS.openApp);
    shortcutConfig = previousConfig;
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not reset shortcuts.",
      ...getShortcutSettingsPayload(),
    };
  }

  return { ok: true, ...getShortcutSettingsPayload() };
});

ipcMain.handle(
  SETTINGS_CHANNEL_SET_TRAY_ICON_HIDDEN,
  async (_event: IpcMainInvokeEvent, value: unknown) => {
    if (typeof value !== "boolean") {
      return {
        ok: false,
        error: "Tray icon visibility must be a boolean value.",
        ...getShortcutSettingsPayload(),
      };
    }

    if (value && !settingsShortcutRegistered) {
      return {
        ok: false,
        error: `${SETTINGS_WINDOW_SHORTCUT_LABEL} is unavailable, so the tray icon cannot be hidden safely.`,
        ...getShortcutSettingsPayload(),
      };
    }

    try {
      await saveTrayIconHidden(value);
      return { ok: true, ...getShortcutSettingsPayload() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not update tray icon visibility.",
        ...getShortcutSettingsPayload(),
      };
    }
  },
);

ipcMain.handle(
  SETTINGS_CHANNEL_SAVE_PROMPT_TEMPLATES,
  async (_event: IpcMainInvokeEvent, value: unknown) => {
    const nextTemplates = normalizePromptTemplates(value);
    if (!nextTemplates) {
      return {
        ok: false,
        error:
          "Every prompt template needs text and a unique shortcut with at least one modifier.",
        ...getShortcutSettingsPayload(),
      };
    }

    const reservedConflict = promptTemplateShortcutConflict(nextTemplates);
    if (reservedConflict) {
      return {
        ok: false,
        error: `${reservedConflict.shortcut} is already used by an app shortcut.`,
        ...getShortcutSettingsPayload(),
      };
    }

    try {
      await savePromptTemplates(nextTemplates);
      if (process.platform === "darwin" && nextTemplates.length > 0) {
        systemPreferences.isTrustedAccessibilityClient(true);
      }
      return { ok: true, ...getShortcutSettingsPayload() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not save prompt templates.",
        ...getShortcutSettingsPayload(),
      };
    }
  },
);

ipcMain.on(DRAG_CHANNEL_START, () => {
  if (!mainWindow?.isVisible()) return;

  const { x: cursorX, y: cursorY } = screen.getCursorScreenPoint();
  const [windowX, windowY] = mainWindow.getPosition();
  dragState = { cursorX, cursorY, windowX, windowY };
});

ipcMain.on(DRAG_CHANNEL_MOVE, () => {
  if (!dragState || !mainWindow?.isVisible()) return;

  const { x, y } = screen.getCursorScreenPoint();
  mainWindow.setPosition(
    dragState.windowX + x - dragState.cursorX,
    dragState.windowY + y - dragState.cursorY,
  );
});

ipcMain.on(DRAG_CHANNEL_END, () => {
  dragState = undefined;
});

app.on("before-quit", () => {
  isQuitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
