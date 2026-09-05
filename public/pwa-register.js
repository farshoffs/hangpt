if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});
  });
}

window.addEventListener("online", () => document.documentElement.classList.remove("offline"));
window.addEventListener("offline", () => document.documentElement.classList.add("offline"));
if (!navigator.onLine) document.documentElement.classList.add("offline");
