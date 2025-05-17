import {
  app,
  session,
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

const DEFAULT_HEIGHT = 800;
const DEFAULT_WIDTH = 400;

let tray: Tray;
let mainWindow: BrowserWindow;

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
      label: "Quit",
      accelerator: "Command+Q",
      click: () => app.quit(),
    },
    {
      label: "Close Window",
      accelerator: "Esc",
      click: () => mainWindow.hide(),
    },
    {
      label: "Reload",
      accelerator: "Command+R",
      click: () => mainWindow.reload(),
    },
    {
      label: "Toggle Full Screen",
      accelerator: "Ctrl+Command+F",
      click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()),
    },
    {
      label: "Reset Screen Size",
      accelerator: "Ctrl+Command+R",
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
      webSecurity: true, // dejá webSecurity activo
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: false,
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("blur", hideMainWindow);
  win.on("resize", handleWindowResize);
  nativeTheme.on("updated", updateMainWindowTheme);

  tray.on("right-click", () => {
    tray.popUpContextMenu(createContextMenu());
  });

  return win;
}

async function resetMainWindowSize() {
  const trayBounds = tray.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - DEFAULT_WIDTH / 2);
  const y = Math.round(trayBounds.y + trayBounds.height);
  mainWindow.setBounds({ x, y, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  await settings.set("width", DEFAULT_WIDTH);
  await settings.set("height", DEFAULT_HEIGHT);
}

function handleWindowResize() {
  const { width, height } = mainWindow.getBounds();
  const trayBounds = tray.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height);
  mainWindow.setBounds({ x, y, width, height });
  settings.set("width", width);
  settings.set("height", height);
}

function toggleMainWindow() {
  mainWindow.isVisible() ? hideMainWindow() : showMainWindow();
}

async function showMainWindow() {
  const trayBounds = tray.getBounds();
  const width = ((await settings.get("width")) as number) || DEFAULT_WIDTH;
  const height = ((await settings.get("height")) as number) || DEFAULT_HEIGHT;
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height);
  mainWindow.setBounds({ x, y, width, height });
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

app.commandLine.appendSwitch("enable-features", "WebSpeechAPI");
app.whenReady().then(async () => {
  // ‼️ Aprobar solicitudes de micrófono/cámara ‼️
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      //@ts-ignore
      if (permission === "wakeLock") {
        return callback(true);
      }
      if (
        permission === "clipboard-read" ||
        permission === "clipboard-sanitized-write"
      ) {
        return callback(true);
      }
      if (
        permission === "media" || // Electron < 24
        //@ts-ignore
        permission === "microphone" ||
        //@ts-ignore
        permission === "camera"
      ) {
        callback(true);
      } else {
        callback(false);
      }
    },
  );

  await checkMicrophonePermission();

  tray = createTray();
  mainWindow = createMainWindow(tray);
  mainWindow.webContents.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/114.0.0.0 Safari/537.36",
  );
  await mainWindow.loadURL("https://chatgpt.com/");
  mainWindow.focus();

  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      const headers = details.responseHeaders ?? {};
      delete headers["content-security-policy"]; // ⚠️ menos seguro
      callback({ responseHeaders: headers });
    },
  );

  globalShortcut.register("Ctrl+Option+Command+C", toggleMainWindow);
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
