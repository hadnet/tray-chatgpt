import {
  app,
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
const SHORTCUT_SETTINGS_KEY = "shortcuts";
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

let tray: Tray;
let mainWindow: BrowserWindow;
let settingsWindow: BrowserWindow | undefined;
let shortcutConfig: ShortcutConfig = { ...SHORTCUT_DEFAULTS };
let toggleTemporaryChatHandler: (() => void | Promise<void>) | undefined;
let resetWorkspaceVisibilityTimer: ReturnType<typeof setTimeout> | undefined;
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

function normalizeShortcutConfig(value: unknown): ShortcutConfig | undefined {
  if (!value || typeof value !== "object") return undefined;

  const source = value as Partial<Record<ShortcutAction, unknown>>;
  const openApp = normalizeAccelerator(source.openApp);
  const temporaryChat = normalizeAccelerator(source.temporaryChat);
  if (!openApp || !temporaryChat || openApp === temporaryChat) {
    return undefined;
  }

  return { openApp, temporaryChat };
}

async function loadShortcutConfig() {
  const saved = await settings.get(SHORTCUT_SETTINGS_KEY);
  shortcutConfig = normalizeShortcutConfig(saved) ?? { ...SHORTCUT_DEFAULTS };
  await settings.set(SHORTCUT_SETTINGS_KEY, shortcutConfig);
}

async function saveShortcutConfig(nextConfig: ShortcutConfig) {
  await settings.set(SHORTCUT_SETTINGS_KEY, nextConfig);
  shortcutConfig = nextConfig;
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
  };
}

function updateSettingsWindowShortcuts() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsWindow.webContents.send(
    "settings:shortcuts-updated",
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

function createContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Open Tray ChatGPT",
      accelerator: shortcutConfig.openApp,
      click: () => showMainWindow(),
    },
    {
      label: "Settings",
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

function createMainWindow(tray: Tray) {
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
  if (process.platform === "darwin") app.dock.hide();
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
  tray.popUpContextMenu(createContextMenu());
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
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      padding: 24px;
      background: Canvas;
    }

    main {
      display: flex;
      flex-direction: column;
      gap: 18px;
      max-width: 560px;
      margin: 0 auto;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .setting {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(180px, 220px) 88px;
      align-items: center;
      gap: 12px;
      padding: 14px 0;
      border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
    }

    label {
      font-size: 14px;
      font-weight: 600;
    }

    input {
      width: 100%;
      min-height: 36px;
      padding: 7px 10px;
      border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, Canvas 94%, CanvasText);
      color: CanvasText;
      font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    input.recording {
      outline: 2px solid AccentColor;
      outline-offset: 2px;
    }

    button {
      min-height: 34px;
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 6px;
      background: ButtonFace;
      color: ButtonText;
      font: inherit;
      font-size: 13px;
    }

    button.primary {
      background: AccentColor;
      border-color: AccentColor;
      color: AccentColorText;
      font-weight: 600;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding-top: 4px;
    }

    #status {
      min-height: 20px;
      color: color-mix(in srgb, CanvasText 68%, transparent);
      font-size: 13px;
    }

    #status.error {
      color: #c53232;
    }

    @media (max-width: 560px) {
      body {
        padding: 18px;
      }

      .setting {
        grid-template-columns: 1fr;
        gap: 8px;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Settings</h1>
    <section>
      <div class="setting">
        <label for="openApp">Open app</label>
        <input id="openApp" readonly />
        <button data-record="openApp">Record</button>
      </div>
      <div class="setting">
        <label for="temporaryChat">Temporary chat</label>
        <input id="temporaryChat" readonly />
        <button data-record="temporaryChat">Record</button>
      </div>
    </section>
    <div id="status" role="status"></div>
    <div class="actions">
      <button id="reset">Reset</button>
      <button id="save" class="primary">Save</button>
    </div>
  </main>
  <script>
    const api = window.trayChatGPTSettings;
    const fields = {
      openApp: document.getElementById("openApp"),
      temporaryChat: document.getElementById("temporaryChat"),
    };
    const status = document.getElementById("status");
    let activeField;

    function setStatus(message, isError = false) {
      status.textContent = message;
      status.classList.toggle("error", isError);
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

    function setShortcuts(payload) {
      fields.openApp.value = payload.shortcuts.openApp;
      fields.temporaryChat.value = payload.shortcuts.temporaryChat;
    }

    for (const button of document.querySelectorAll("[data-record]")) {
      button.addEventListener("click", () => {
        activeField = fields[button.dataset.record];
        for (const field of Object.values(fields)) field.classList.remove("recording");
        activeField.classList.add("recording");
        activeField.focus();
        setStatus("Press a key combination.");
      });
    }

    window.addEventListener("keydown", (event) => {
      if (!activeField) return;
      event.preventDefault();
      event.stopPropagation();

      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;

      activeField.value = accelerator;
      activeField.classList.remove("recording");
      activeField = undefined;
      setStatus("");
    });

    document.getElementById("save").addEventListener("click", async () => {
      setStatus("");
      const result = await api.saveShortcuts({
        openApp: fields.openApp.value,
        temporaryChat: fields.temporaryChat.value,
      });
      setStatus(result.ok ? "Saved." : result.error, !result.ok);
      if (result.ok) setShortcuts(result);
    });

    document.getElementById("reset").addEventListener("click", async () => {
      const result = await api.resetShortcuts();
      setStatus(result.ok ? "Defaults restored." : result.error, !result.ok);
      if (result.ok) setShortcuts(result);
    });

    api.onShortcutsUpdated(setShortcuts);
    api.getShortcuts().then(setShortcuts);
  </script>
</body>
</html>`;
}

function createSettingsWindow() {
  const options: BrowserWindowConstructorOptions = {
    width: 620,
    height: 390,
    title: "Tray ChatGPT Settings",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      nodeIntegration: false,
      sandbox: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
    },
  };
  const win = new BrowserWindow(options);
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(getSettingsWindowHtml())}`,
  );
  win.on("closed", () => {
    settingsWindow = undefined;
    if (process.platform === "darwin" && !mainWindow.isVisible()) {
      app.dock.hide();
    }
  });
  return win;
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createSettingsWindow();
  }

  if (process.platform === "darwin") app.dock.show();
  settingsWindow.show();
  settingsWindow.focus();
  updateSettingsWindowShortcuts();
}

/* ──────────────────────────────────────────────
  5. APP LIFECYCLE
────────────────────────────────────────────── */
app.commandLine.appendSwitch("enable-features", "WebSpeechAPI");

app.whenReady().then(async () => {
  await checkMicrophonePermission();
  await loadShortcutConfig();

  // (Optional) external Google login — can be commented out if not needed
  // await ensureGoogleLogged();

  tray = createTray();
  mainWindow = createMainWindow(tray);

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

  if (!registerOpenAppShortcut(shortcutConfig.openApp)) {
    console.error(
      `Unable to register open-app shortcut: ${shortcutConfig.openApp}`,
    );
  }
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

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
