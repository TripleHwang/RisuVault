import "./ts/polyfill";
import "core-js/actual"
import "./ts/log-capture"
import "./ts/storage/database.svelte"
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { initHotkey } from "./ts/hotkey";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";
import { applyEarlyLanguage } from "./lang";

window.addEventListener('vite:preloadError', (event) => {
    console.error("Chunk load error detected:", event);
    alert("The server has been updated or the network connection has been lost. Please refresh the page.");
});

preLoadCheck()
applyEarlyLanguage()
let app = mount(App, {
    target: document.getElementById("app"),
});
loadData()
initHotkey()

// The static preloader in index.html stays up until this module has run, so
// the gap between the first paint and the app's own loading screen shows the
// same version line and spinner rather than a blank page. There is no
// startup image any more: it was 13 KB decoded synchronously on the critical
// path for a wordmark, and the app's screen carries the version on its own.
function removeStartupPreloader() {
    document.getElementById('preloading')?.remove()
}

removeStartupPreloader()

export default app;
