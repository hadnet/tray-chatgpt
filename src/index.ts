import {
  app,
  screen,
  BrowserWindow,
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

let tray: Tray;
let mainWindow: BrowserWindow;

/* ──────────────────────────────────────────────
   1. PERFIL DO CHROME COMPARTILHADO COM ELECTRON
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
   2. (Opcional) Login Google externo – útil apenas
      se o usuário ainda não estiver logado no Chrome
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
   3. CHECKS DE PERMISSÃO (inalterados)
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

/* ──────────────────────────────────────────────
   4. CRIAÇÃO DE TRAY E JANELA (inalterados)
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
    { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
    {
      label: "Close Window",
      accelerator: "Esc",
      click: () => mainWindow.hide(),
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
  ]);
}

function createMainWindow(tray: Tray) {
  const win = new BrowserWindow({
    frame: false,
    resizable: true,
    transparent: false,
    show: false,
    movable: false,
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
      devTools: false,
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("blur", hideMainWindow);
  win.on("resize", handleWindowResize);
  nativeTheme.on("updated", updateMainWindowTheme);
  tray.on("right-click", () => tray.popUpContextMenu(createContextMenu()));
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
    y: Math.round(workArea.y + 50),
    width,
    height,
  });
  mainWindow.show();
  mainWindow.focus();
}
function hideMainWindow() {
  mainWindow.hide();
  if (process.platform === "darwin") app.dock.hide();
}
function updateMainWindowTheme() {
  const background = nativeTheme.shouldUseDarkColors ? "#343541" : "#FFF";
  const text = nativeTheme.shouldUseDarkColors ? "#FFF" : "#000";
  mainWindow.webContents.insertCSS(
    `body { background-color: ${background}; color: ${text}; }`,
  );
}
function showContextMenu() {
  tray.popUpContextMenu(createContextMenu());
}

/* ──────────────────────────────────────────────
   5. APP LIFECYCLE
   ────────────────────────────────────────────── */
app.commandLine.appendSwitch("enable-features", "WebSpeechAPI");

app.whenReady().then(async () => {
  await checkMicrophonePermission();

  // (Opcional) login Google externo — pode comentar se não precisar
  // await ensureGoogleLogged();

  tray = createTray();
  mainWindow = createMainWindow(tray);

  // depois de criar mainWindow:
  const CHROME_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/115.0.5790.170 Safari/537.36";

  const ORIGINAL_UA = mainWindow.webContents.getUserAgent();

  /* troca dinâmica de User‑Agent (somente no main frame) */
  mainWindow.webContents.on(
    "did-start-navigation",
    (_event, url, _isInPlace, _isMainFrame, frameProcessId, frameRoutingId) => {
      // só troca no frame principal
      if (!_isMainFrame) return;

      if (url.startsWith("https://accounts.google.com/")) {
        // Google Sign‑in → UA original
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

  globalShortcut.register("Ctrl+Option+Command+C", toggleMainWindow);
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
