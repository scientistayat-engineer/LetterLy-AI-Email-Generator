(() => {
  "use strict";
  const form = document.getElementById("promptForm");
  const input = document.getElementById("promptInput");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    window.location.href = text ? `/app?prompt=${encodeURIComponent(text)}` : "/app";
  });
})();
