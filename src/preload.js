// // Alias de webkitSpeechRecognition a SpeechRecognition
// (() => {
//   // Si SpeechRecognition no está definido, toma el prefijo webkit
//   if (!("SpeechRecognition" in window) && "webkitSpeechRecognition" in window) {
//     (window as any).SpeechRecognition = (window as any).webkitSpeechRecognition;
//   }
//   // Igual para SpeechGrammarList si ChatGPT lo usa
//   if (!("SpeechGrammarList" in window) && "webkitSpeechGrammarList" in window) {
//     (window as any).SpeechGrammarList = (window as any).webkitSpeechGrammarList;
//   }
// })();
// --- preload.js
// window.addEventListener("keydown", (e) => {
//   if (e.key === "Enter" && e.shiftKey) {
//     e.preventDefault();
//     const btn = document.getElementById("composer-submit-button");
//     if (btn) btn.click();
//   }
// });

const { ipcRenderer } = require("electron");

const DRAG_CHANNEL_START = "window-drag:start";
const DRAG_CHANNEL_MOVE = "window-drag:move";
const DRAG_CHANNEL_END = "window-drag:end";

function installWindowDragStrip() {
  if (document.getElementById("tray-chatgpt-window-drag-strip")) return;

  const dragStrip = document.createElement("div");
  dragStrip.id = "tray-chatgpt-window-drag-strip";
  dragStrip.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "height:14px",
    "z-index:2147483647",
    "cursor:move",
    "background:transparent",
    "user-select:none",
  ].join(";");

  let isDragging = false;
  let dragTimer;

  const stopDragging = () => {
    if (!isDragging) return;
    isDragging = false;
    clearInterval(dragTimer);
    dragTimer = undefined;
    ipcRenderer.send(DRAG_CHANNEL_END);
  };

  dragStrip.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;

    isDragging = true;
    event.preventDefault();
    ipcRenderer.send(DRAG_CHANNEL_START);
    dragTimer = setInterval(() => ipcRenderer.send(DRAG_CHANNEL_MOVE), 16);
  });

  window.addEventListener("mousemove", () => {
    if (!isDragging) return;
    ipcRenderer.send(DRAG_CHANNEL_MOVE);
  });
  window.addEventListener("mouseup", stopDragging);
  window.addEventListener("blur", stopDragging);

  document.body.appendChild(dragStrip);
}

// wait for the React app to mount & patch the warning text
window.addEventListener("DOMContentLoaded", () => {
  installWindowDragStrip();

  // patch style
  const style = document.createElement("style");
  style.textContent =
    "*:not(#tray-chatgpt-window-drag-strip){cursor:default!important}";
  document.head.appendChild(style);

  // if it isn’t there yet, watch for it
  const observer = new MutationObserver(() => {
    const node =
      document.querySelector(/* a more robust selector than your XPath */);
    if (node) {
      node.textContent = "…Press ⌘ + / for shortcuts";
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
