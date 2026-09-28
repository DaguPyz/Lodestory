/* Apply the saved appearance before the application stylesheet and first render. */
(function () {
  var mode = "dark";
  try {
    var saved = window.localStorage.getItem("lodestory.theme-mode");
    if (saved === "dark" || saved === "light" || saved === "system") {
      mode = saved;
    }
  } catch (_) {
    // Unavailable settings must not prevent startup.
  }

  var theme = mode;
  if (mode === "system") {
    try {
      theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (_) {
      theme = "dark";
    }
  }

  var root = document.documentElement;
  root.dataset.uiTheme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = theme === "light" ? "#FFFFFF" : "#14181D";
})();

