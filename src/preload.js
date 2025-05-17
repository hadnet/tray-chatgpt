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
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    const btn = document.getElementById("composer-submit-button");
    if (btn) btn.click();
  }
});

// wait for the React app to mount & patch the warning text
window.addEventListener("DOMContentLoaded", () => {
  // patch style
  const style = document.createElement("style");
  style.textContent = "*{cursor:default!important}";
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
