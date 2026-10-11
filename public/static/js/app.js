(() => {
  "use strict";

  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const E = {};
  document.querySelectorAll("[id]").forEach((node) => (E[node.id] = node));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const VIEWS = ["generate", "templates", "history", "favorites", "analytics", "settings"];
  const TITLES = {
    templates: ["Templates", "Pick a starting point for your next email."],
    history: ["History", "Everything you've written, newest first."],
    favorites: ["Favorites", "Emails you starred for later."],
    analytics: ["Analytics", "See how you write."],
    settings: ["Settings", "Make LetterLy yours."],
  };
  const CAT_COLORS = {
    "Job application": "#6d5cff", "Follow up": "#8b5cf6", "Thank you": "#e0489b", "Meeting request": "#2f8cf0",
    Complaint: "#f08a2f", "Business inquiry": "#16a8a0", "Leave request": "#d4a017", Replies: "#16a34a", Other: "#6b6f8d",
  };
  const PALETTE = ["#6d5cff", "#16a8a0", "#8b5cf6", "#e0489b", "#2f8cf0", "#f08a2f"];

  const state = {
    view: "generate",
    mode: "new",
    current: null,
    templates: [],
    tags: [],
    filter: { tag: "", pinned: false },
    settings: { sender_name: "", default_tone: "Professional", default_language: "English", typing_animation: true, show_score: true },
    busy: false,
    typingId: 0,
    saveTimer: null,
    searchTimer: null,
  };

  /* ---------- helpers ---------- */
  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
    } catch (_) {
      throw new Error("Couldn't reach the server. Is it still running?");
    }
    if (res.status === 204) return null;
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* ignore */
    }
    if (!res.ok) throw new Error(errorMessage(data, res.status));
    return data;
  }

  function errorMessage(data, status) {
    if (data && typeof data.detail === "string") return data.detail;
    if (data && Array.isArray(data.detail) && data.detail.length) {
      const first = data.detail[0];
      const field = ((first.loc || []).slice(-1)[0] || "form").toString().replace(/_/g, " ");
      const msg = String(first.msg || "").replace(/^Value error, /, "");
      return field === "body" ? msg : `Check the ${field} field: ${msg}`;
    }
    return `Something went wrong (${status}). Try again.`;
  }

  function toast(message, type = "info") {
    const node = document.createElement("div");
    node.className = `toast ${type === "error" ? "error" : ""}`;
    node.textContent = message;
    E.toasts.appendChild(node);
    setTimeout(() => node.remove(), type === "error" ? 5200 : 2600);
  }

  const checked = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  function setRadio(name, value) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
  function autosize(el) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  }
  function icon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ico");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.appendChild(use);
    return svg;
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function showError(input, target, message) {
    input.setAttribute("aria-invalid", "true");
    target.textContent = message;
    target.hidden = false;
  }
  function clearError(input, target) {
    input.removeAttribute("aria-invalid");
    target.hidden = true;
  }
  function clearAllErrors() {
    clearError(E.received, E.receivedError);
    clearError(E.recipient, E.recipientError);
    clearError(E.purpose, E.purposeError);
  }
  const idleLabel = () => (state.mode === "reply" ? "Write reply" : "Generate Email");

  function setBusy(busy, label) {
    state.busy = busy;
    document.body.classList.toggle("busy", busy);
    E.generateBtn.disabled = busy;
    E.generateBtn.classList.toggle("is-loading", busy);
    E.generateLabel.textContent = busy ? label || "Working..." : idleLabel();
    E.summarizeBtn.disabled = busy;
    $$("#genBody button").forEach((button) => (button.disabled = busy));
  }

  /* ---------- theme ---------- */
  E.themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("letterly-theme", next);
    } catch (_) {
      /* ignore */
    }
  });

  /* ---------- routing ---------- */
  function greeting() {
    const hour = new Date().getHours();
    const base = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const first = state.settings.sender_name.trim().split(/\s+/)[0];
    return first ? `${base}, ${first}` : base;
  }

  function go(view) {
    if (location.hash !== `#/${view}`) location.hash = `#/${view}`;
    else show(view);
  }

  function show(view) {
    state.view = view;
    $$("[data-panel]").forEach((panel) => (panel.hidden = panel.dataset.panel !== view));
    $$("[data-view]").forEach((link) => link.classList.toggle("on", link.dataset.view === view));
    const [title, sub] = view === "generate" ? [greeting(), "Let's create something amazing today."] : TITLES[view];
    E.vt.textContent = title;
    E.vs.textContent = sub;
    document.title = `LetterLy - ${view === "generate" ? "Dashboard" : title}`;
    if (view === "history") loadHistory();
    if (view === "favorites") loadFavorites();
    if (view === "analytics") loadStats();
    if (view === "settings") fillSettings();
    if (view === "templates") renderTemplates();
    window.scrollTo(0, 0);
  }

  function route() {
    const match = location.hash.match(/^#\/(\w+)/);
    show(match && VIEWS.includes(match[1]) ? match[1] : "generate");
  }
  window.addEventListener("hashchange", route);

  /* ---------- form: modes + validation ---------- */
  function updatePurposeCount() {
    E.purposeCount.textContent = `${E.purpose.value.length} / 800`;
  }

  function setMode(mode) {
    state.mode = mode;
    setRadio("mode", mode);
    const reply = mode === "reply";
    E.receivedField.hidden = !reply;
    E.recipientLabel.textContent = reply ? "Reply to (name, optional)" : "Recipient name";
    E.recipient.placeholder = reply ? "Leave blank to use the name in the email" : "e.g. John Smith";
    E.purposeLabel.textContent = reply ? "What should the reply say? (optional)" : "Email purpose";
    E.purpose.placeholder = reply
      ? "Agree to the meeting on Thursday and ask for the agenda"
      : "Ask for a two-day extension on the data science assignment because of a family event";
    if (!state.busy) E.generateLabel.textContent = idleLabel();
    clearAllErrors();
  }
  $$('input[name="mode"]').forEach((radio) => radio.addEventListener("change", () => setMode(checked("mode"))));

  E.purpose.addEventListener("input", () => {
    updatePurposeCount();
    clearError(E.purpose, E.purposeError);
  });
  E.recipient.addEventListener("input", () => clearError(E.recipient, E.recipientError));
  E.received.addEventListener("input", () => clearError(E.received, E.receivedError));
  E.purpose.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      generate();
    }
  });

  function readForm() {
    const reply = state.mode === "reply";
    const recipient = E.recipient.value.trim();
    const purpose = E.purpose.value.trim();
    const received = E.received.value.trim();
    clearAllErrors();

    let firstBad = null;
    if (reply) {
      if (received.length < 10) {
        showError(E.received, E.receivedError, "Paste the email you want to reply to.");
        firstBad = E.received;
      }
    } else {
      if (!recipient) {
        showError(E.recipient, E.recipientError, "Enter who this email is for.");
        firstBad = E.recipient;
      }
      if (purpose.length < 3) {
        showError(E.purpose, E.purposeError, "Describe what the email should say.");
        firstBad = firstBad || E.purpose;
      }
    }
    if (firstBad) {
      firstBad.focus();
      return null;
    }
    const common = {
      tone: checked("tone"),
      length: checked("length"),
      language: checked("language"),
      sender_name: E.sender.value.trim() || null,
    };
    if (reply) {
      return {
        path: "/api/reply",
        payload: { ...common, received_email: received, recipient_name: recipient || null, purpose: purpose || null },
      };
    }
    return { path: "/api/generate", payload: { ...common, recipient_name: recipient, purpose } };
  }

  E.form.addEventListener("submit", (event) => {
    event.preventDefault();
    generate();
  });

  function fillForm(email) {
    setMode(email.kind === "reply" ? "reply" : "new");
    E.recipient.value = email.kind === "reply" && email.recipient_name === "Sender" ? "" : email.recipient_name;
    E.purpose.value = email.kind === "reply" && email.purpose === "Reply to received email" ? "" : email.purpose;
    E.received.value = email.source_text || "";
    setRadio("tone", email.tone);
    setRadio("length", email.length);
    setRadio("language", email.language);
    updatePurposeCount();
    clearAllErrors();
  }

  /* ---------- templates ---------- */
  async function loadTemplates() {
    try {
      state.templates = await api("/api/templates");
    } catch (error) {
      toast(error.message, "error");
    }
    renderChips();
    if (state.view === "templates") renderTemplates();
  }

  function applyTemplate(template) {
    setMode("new");
    E.purpose.value = template.purpose;
    setRadio("tone", template.tone);
    setRadio("length", template.length);
    setRadio("language", template.language);
    updatePurposeCount();
    clearAllErrors();
    go("generate");
    (E.recipient.value.trim() ? E.purpose : E.recipient).focus();
  }

  function renderChips() {
    E.chips.replaceChildren();
    state.templates.slice(0, 4).forEach((template) => {
      const chip = el("button", "chip", template.name);
      chip.type = "button";
      chip.addEventListener("click", () => applyTemplate(template));
      E.chips.appendChild(chip);
    });
    const more = el("button", "chip more", "All templates");
    more.type = "button";
    more.addEventListener("click", () => go("templates"));
    E.chips.appendChild(more);
  }

  function renderTemplates() {
    const query = E.tplSearch.value.trim().toLowerCase();
    const list = state.templates.filter((t) => !query || `${t.name} ${t.purpose}`.toLowerCase().includes(query));
    E.tplGrid.replaceChildren();
    if (!list.length) {
      E.tplGrid.appendChild(el("p", "empty", "No templates match your search."));
      return;
    }
    list.forEach((template, index) => {
      const card = el("div", "t");
      const main = el("button", "t-main");
      main.type = "button";
      const dot = el("div", "dot", template.name.charAt(0));
      dot.style.setProperty("--c", PALETTE[index % PALETTE.length]);
      const info = el("div");
      info.append(el("b", "", template.name), el("span", "tp", template.purpose));
      main.append(dot, info);
      main.addEventListener("click", () => applyTemplate(template));
      card.append(main, el("span", "tm", `${template.tone}, ${template.builtin ? "built in" : "yours"}`));
      if (!template.builtin) {
        const del = el("button", "del");
        del.type = "button";
        del.setAttribute("aria-label", `Delete template ${template.name}`);
        del.appendChild(icon("i-trash"));
        del.addEventListener("click", async () => {
          try {
            await api(`/api/templates/${template.id}`, { method: "DELETE" });
            await loadTemplates();
            toast("Template deleted");
          } catch (error) {
            toast(error.message, "error");
          }
        });
        card.appendChild(del);
      }
      E.tplGrid.appendChild(card);
    });
  }
  E.tplSearch.addEventListener("input", renderTemplates);

  E.saveTplBtn.addEventListener("click", () => {
    if (E.purpose.value.trim().length < 3) {
      showError(E.purpose, E.purposeError, "Write a purpose first, then save it as a template.");
      E.purpose.focus();
      return;
    }
    E.tplError.hidden = true;
    E.tplName.value = "";
    if (typeof E.tplDialog.showModal === "function") E.tplDialog.showModal();
    else E.tplDialog.setAttribute("open", "");
    E.tplName.focus();
  });
  E.tplClose.addEventListener("click", () => E.tplDialog.close());
  E.tplDialog.addEventListener("click", (event) => {
    if (event.target === E.tplDialog) E.tplDialog.close();
  });
  E.tplSaveForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = E.tplName.value.trim();
    if (!name) {
      E.tplError.textContent = "Give the template a name.";
      E.tplError.hidden = false;
      return;
    }
    try {
      await api("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          name,
          purpose: E.purpose.value.trim(),
          tone: checked("tone"),
          length: checked("length"),
          language: checked("language"),
        }),
      });
      E.tplDialog.close();
      await loadTemplates();
      toast("Template saved");
    } catch (error) {
      E.tplError.textContent = error.message;
      E.tplError.hidden = false;
    }
  });

  /* ---------- voice input ---------- */
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  function resetMic() {
    recognition = null;
    E.micBtn.classList.remove("on");
    E.micBtn.setAttribute("aria-pressed", "false");
    E.micLabel.textContent = "Speak";
  }
  if (SpeechRecognition) {
    E.micBtn.hidden = false;
    E.micBtn.addEventListener("click", () => {
      if (recognition) {
        recognition.stop();
        return;
      }
      const rec = new SpeechRecognition();
      rec.lang = checked("language") === "Urdu" ? "ur-PK" : "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      const base = E.purpose.value.trim();
      rec.onresult = (event) => {
        let text = "";
        for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
        E.purpose.value = `${base ? `${base} ` : ""}${text.trim()}`.slice(0, 800);
        updatePurposeCount();
        clearError(E.purpose, E.purposeError);
      };
      rec.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          toast("Allow microphone access in your browser to use voice input.", "error");
        } else if (event.error === "no-speech") {
          toast("Didn't catch anything. Try again.", "error");
        } else if (event.error !== "aborted") {
          toast(`Voice input stopped (${event.error}).`, "error");
        }
      };
      rec.onend = resetMic;
      try {
        rec.start();
        recognition = rec;
        E.micBtn.classList.add("on");
        E.micBtn.setAttribute("aria-pressed", "true");
        E.micLabel.textContent = "Listening, tap to stop";
      } catch (_) {
        resetMic();
      }
    });
  }

  /* ---------- showing the generated email ---------- */
  function updateCounts() {
    const text = E.bodyInput.value.trim();
    const words = text ? text.split(/\s+/).length : 0;
    E.counts.textContent = `${words} ${words === 1 ? "word" : "words"}, ${text.length} characters`;
  }

  function typeInto(target, text) {
    const id = ++state.typingId;
    if (reduceMotion || !state.settings.typing_animation || text.length < 2) {
      target.value = text;
      target.readOnly = false;
      autosize(target);
      updateCounts();
      return;
    }
    target.readOnly = true;
    target.value = "";
    const total = Math.min(2400, Math.max(700, text.length * 9));
    const start = performance.now();
    function frame(now) {
      if (id !== state.typingId) return;
      const progress = Math.min(1, (now - start) / total);
      target.value = text.slice(0, Math.floor(progress * text.length));
      autosize(target);
      updateCounts();
      if (progress < 1) {
        requestAnimationFrame(frame);
      } else {
        target.value = text;
        target.readOnly = false;
        autosize(target);
        updateCounts();
      }
    }
    requestAnimationFrame(frame);
  }

  function finishTyping() {
    if (E.bodyInput.readOnly && state.current) {
      state.typingId += 1;
      E.bodyInput.value = state.current.body;
      E.bodyInput.readOnly = false;
      autosize(E.bodyInput);
      updateCounts();
    }
  }
  E.bodyInput.addEventListener("pointerdown", finishTyping);

  function setRing(score) {
    if (score === null || score === undefined) {
      E.ring.style.setProperty("--p", 0);
      E.ringNum.textContent = "--";
      E.verdict.textContent = "Run a check to see how this email reads.";
      return;
    }
    const color = score >= 80 ? "#35e0c2" : score >= 60 ? "#f2b84b" : "#ff6b81";
    E.ring.style.setProperty("--p", score);
    E.ring.style.setProperty("--ring", color);
    E.ringNum.textContent = `${score}%`;
  }

  function hidePanels() {
    ["tonePanel", "grammarPanel", "tipsPanel", "subjectSuggest"].forEach((id) => (E[id].hidden = true));
  }

  function renderMeta() {
    const email = state.current;
    if (!email) return;
    E.favBtn.setAttribute("aria-pressed", String(email.pinned));
    E.favBtn.querySelector("span").textContent = email.pinned ? "Favorited" : "Favorite";
    E.tagList.replaceChildren();
    email.tags.forEach((tag) => {
      const chip = el("span", "tag-chip", `#${tag}`);
      const remove = el("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove tag ${tag}`);
      remove.appendChild(icon("i-x"));
      remove.addEventListener("click", () => patchMeta(email.id, { tags: email.tags.filter((t) => t !== tag) }));
      chip.appendChild(remove);
      E.tagList.appendChild(chip);
    });
  }

  function showEmail(email, { animate = false } = {}) {
    state.current = email;
    E.genEmpty.hidden = true;
    E.genBody.hidden = false;
    hidePanels();

    const isUrdu = email.language === "Urdu";
    E.gen.classList.toggle("is-urdu", isUrdu);
    E.subjectInput.dir = isUrdu ? "rtl" : "ltr";
    E.bodyInput.dir = isUrdu ? "rtl" : "ltr";
    E.subjectInput.value = email.subject;
    E.toneTag.textContent = `Tone: ${email.tone}`;
    E.kindTag.hidden = email.kind !== "reply";
    E.langLabel.textContent = isUrdu ? "Translate to English" : "Translate to Urdu";
    E.saveState.textContent = "Edits save automatically";
    E.origBox.hidden = !(email.kind === "reply" && email.source_text);
    E.origBox.open = false;
    E.origText.textContent = email.source_text || "";
    setRing(email.quality);
    renderMeta();

    if (animate) {
      typeInto(E.bodyInput, email.body);
    } else {
      state.typingId += 1;
      E.bodyInput.readOnly = false;
      E.bodyInput.value = email.body;
      autosize(E.bodyInput);
      updateCounts();
    }
  }

  function showEmpty() {
    state.current = null;
    state.typingId += 1;
    E.genBody.hidden = true;
    E.genEmpty.hidden = false;
  }

  /* ---------- generate, reply, refine ---------- */
  async function generate() {
    if (state.busy) return;
    const request = readForm();
    if (!request) return;
    await flushSave();
    setBusy(true, state.mode === "reply" ? "Writing your reply..." : "Writing your email...");
    try {
      const email = await api(request.path, { method: "POST", body: JSON.stringify(request.payload) });
      showEmail(email, { animate: true });
      E.gen.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }
  E.regenBtn.addEventListener("click", generate);

  async function refine(body, label) {
    if (state.busy || !state.current) return false;
    await flushSave();
    setBusy(true, label);
    try {
      const email = await api(`/api/emails/${state.current.id}/refine`, { method: "POST", body: JSON.stringify(body) });
      setRadio("language", email.language);
      showEmail(email, { animate: true });
      return true;
    } catch (error) {
      toast(error.message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const custom = (instruction) => refine({ action: "custom", instruction }, "Rewriting...");
  E.shortenBtn.addEventListener("click", () => refine({ action: "shorten" }, "Shortening..."));
  E.longerBtn.addEventListener("click", () => refine({ action: "longer" }, "Expanding..."));
  E.formalBtn.addEventListener("click", () => custom("Make it more formal and respectful"));
  E.friendlyBtn.addEventListener("click", () => custom("Make it more friendly and warm"));
  E.ctaBtn.addEventListener("click", () => custom("Add a clear, polite call to action at the end"));
  E.langBtn.addEventListener("click", () => {
    const toUrdu = state.current && state.current.language !== "Urdu";
    refine({ action: toUrdu ? "urdu" : "english" }, "Translating...");
  });
  E.tuneForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const instruction = E.tuneInput.value.trim();
    if (!instruction) {
      toast("Type what you want changed first.", "error");
      E.tuneInput.focus();
      return;
    }
    if (await custom(instruction)) E.tuneInput.value = "";
  });

  /* ---------- AI tools: subjects, quality, tone, grammar ---------- */
  async function runTool(label, task) {
    if (state.busy || !state.current) return;
    await flushSave();
    setBusy(true, label);
    try {
      await task(state.current.id);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  E.subjectsBtn.addEventListener("click", () =>
    runTool("Thinking...", async (id) => {
      const data = await api(`/api/emails/${id}/subjects`, { method: "POST" });
      E.suggestList.replaceChildren();
      data.subjects.forEach((subject) => {
        const option = el("button", "", subject);
        option.type = "button";
        option.dir = "auto";
        option.addEventListener("click", () => {
          E.subjectInput.value = subject;
          scheduleSave();
          E.subjectSuggest.hidden = true;
          toast("Subject updated");
        });
        E.suggestList.appendChild(option);
      });
      E.subjectSuggest.hidden = false;
    }),
  );
  E.suggestClose.addEventListener("click", () => (E.subjectSuggest.hidden = true));

  E.qualityBtn.addEventListener("click", () =>
    runTool("Reviewing...", async (id) => {
      const report = await api(`/api/emails/${id}/analyze`, { method: "POST" });
      state.current.quality = report.score;
      setRing(report.score);
      E.verdict.textContent = report.verdict;
      E.tipsPanel.replaceChildren(el("b", "", "How to improve"));
      const list = el("ul");
      report.tips.forEach((tip) => list.appendChild(el("li", "", tip)));
      E.tipsPanel.appendChild(list);
      E.tipsPanel.hidden = false;
      const subs = el("p", "", `Clarity ${report.clarity}, tone match ${report.tone_match}, completeness ${report.completeness}.`);
      E.tipsPanel.appendChild(subs);
    }),
  );

  function bar(label, percent) {
    const row = el("div", "br");
    const track = el("div");
    const fill = el("i");
    fill.style.width = `${percent}%`;
    track.appendChild(fill);
    row.append(el("span", "", label), track, el("b", "", `${percent}%`));
    return row;
  }

  E.toneBtn.addEventListener("click", () =>
    runTool("Reading tone...", async (id) => {
      const data = await api(`/api/emails/${id}/tone`, { method: "POST" });
      E.tonePanel.replaceChildren(el("b", "", "Detected tone"));
      [...data.tones].sort((a, b) => b.percent - a.percent).forEach((t) => E.tonePanel.appendChild(bar(t.name, t.percent)));
      if (data.summary) E.tonePanel.appendChild(el("p", "", data.summary));
      E.tonePanel.hidden = false;
    }),
  );

  E.grammarBtn.addEventListener("click", () =>
    runTool("Checking grammar...", async (id) => {
      const data = await api(`/api/emails/${id}/grammar`, { method: "POST" });
      showEmail(data.email);
      E.grammarPanel.replaceChildren(el("b", "", data.changes.length ? "Fixed" : "Grammar check"));
      if (data.changes.length) {
        const list = el("ul");
        data.changes.forEach((change) => list.appendChild(el("li", "", change)));
        E.grammarPanel.appendChild(list);
      } else {
        E.grammarPanel.appendChild(el("p", "", "No issues found. Your email reads well."));
      }
      E.grammarPanel.hidden = false;
    }),
  );

  /* ---------- thread summary ---------- */
  function sumSection(box, heading, items) {
    const wrap = el("div");
    wrap.appendChild(el("b", "", heading));
    const list = el("ul");
    (items.length ? items : ["None found"]).forEach((item) => list.appendChild(el("li", "", item)));
    wrap.appendChild(list);
    box.appendChild(wrap);
  }

  E.summarizeBtn.addEventListener("click", async () => {
    const thread = E.threadInput.value.trim();
    if (thread.length < 20) {
      toast("Paste an email thread first.", "error");
      E.threadInput.focus();
      return;
    }
    if (state.busy) return;
    setBusy(true, "Summarizing...");
    try {
      const data = await api("/api/summarize", { method: "POST", body: JSON.stringify({ thread }) });
      E.sumOut.replaceChildren();
      const gist = el("div");
      gist.append(el("b", "", "Gist"), el("p", "", data.gist));
      E.sumOut.appendChild(gist);
      sumSection(E.sumOut, "Questions to answer", data.questions);
      sumSection(E.sumOut, "Deadlines and times", data.deadlines);
      const reply = el("button", "btn", "Write a reply");
      reply.type = "button";
      reply.addEventListener("click", () => {
        setMode("reply");
        E.received.value = thread.slice(0, 6000);
        E.purpose.value = data.reply_points.slice(0, 800);
        updatePurposeCount();
        E.form.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        toast("Reply form filled. Press Write reply.");
      });
      E.sumOut.appendChild(reply);
      E.sumOut.hidden = false;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  });

  /* ---------- editing, autosave, favorites, tags ---------- */
  function scheduleSave() {
    if (!state.current) return;
    state.current.subject = E.subjectInput.value;
    state.current.body = E.bodyInput.value;
    E.saveState.textContent = "Saving...";
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 700);
  }

  async function flushSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const email = state.current;
    if (!email || !email.subject.trim() || !email.body.trim()) return;
    if (E.saveState.textContent !== "Saving...") return;
    try {
      await api(`/api/emails/${email.id}`, { method: "PUT", body: JSON.stringify({ subject: email.subject, body: email.body }) });
      E.saveState.textContent = "Saved";
    } catch (error) {
      E.saveState.textContent = "Couldn't save";
      toast(error.message, "error");
    }
  }
  E.subjectInput.addEventListener("input", scheduleSave);
  E.bodyInput.addEventListener("input", () => {
    autosize(E.bodyInput);
    updateCounts();
    scheduleSave();
  });
  window.addEventListener("resize", () => E.bodyInput && autosize(E.bodyInput));

  async function patchMeta(id, change) {
    try {
      const saved = await api(`/api/emails/${id}/meta`, { method: "PATCH", body: JSON.stringify(change) });
      if (state.current && state.current.id === id) {
        state.current.pinned = saved.pinned;
        state.current.tags = saved.tags;
        renderMeta();
      }
      refreshLists();
    } catch (error) {
      toast(error.message, "error");
    }
  }
  function refreshLists() {
    if (state.view === "history") loadHistory();
    if (state.view === "favorites") loadFavorites();
  }

  E.favBtn.addEventListener("click", () => {
    if (state.current) patchMeta(state.current.id, { pinned: !state.current.pinned });
  });

  function addTag(raw) {
    const email = state.current;
    const value = raw.trim().replace(/^#/, "");
    if (!email || !value) return;
    if (email.tags.length >= 5) {
      toast("You can add up to 5 tags per email.", "error");
      return;
    }
    patchMeta(email.id, { tags: [...email.tags, value] });
  }
  E.tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(E.tagInput.value);
      E.tagInput.value = "";
    }
  });
  E.tagInput.addEventListener("blur", () => {
    if (E.tagInput.value.trim()) {
      addTag(E.tagInput.value);
      E.tagInput.value = "";
    }
  });

  /* ---------- export: copy, text, word, pdf, mail ---------- */
  const emailText = () => `Subject: ${E.subjectInput.value.trim()}\n\n${E.bodyInput.value.trim()}\n`;

  function triggerDownload(href, filename) {
    const link = document.createElement("a");
    link.href = href;
    if (filename) link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  E.copyBtn.addEventListener("click", async () => {
    const text = emailText();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const temp = document.createElement("textarea");
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
    toast("Email copied");
  });

  E.txtBtn.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([emailText()], { type: "text/plain;charset=utf-8" }));
    const slug = E.subjectInput.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    triggerDownload(url, `${slug || "email"}.txt`);
    URL.revokeObjectURL(url);
    toast("Text file downloaded");
  });

  E.wordBtn.addEventListener("click", async () => {
    if (!state.current) return;
    finishTyping();
    await flushSave();
    triggerDownload(`/api/emails/${state.current.id}/export.docx`);
    toast("Word file downloading");
  });

  E.pdfBtn.addEventListener("click", () => {
    if (!state.current) return;
    finishTyping();
    E.printSheet.replaceChildren(el("h1", "", E.subjectInput.value), el("p", "", E.bodyInput.value));
    E.printSheet.dir = state.current.language === "Urdu" ? "rtl" : "ltr";
    E.printSheet.hidden = false;
    toast("In the print window, choose Save as PDF.");
    setTimeout(() => window.print(), 250);
  });

  E.mailBtn.addEventListener("click", () => {
    const subject = encodeURIComponent(E.subjectInput.value.trim());
    const body = encodeURIComponent(E.bodyInput.value.trim().replace(/\n/g, "\r\n"));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  });


  /* ---------- history + favorites ---------- */
  function renderRows(box, items, emptyText) {
    box.replaceChildren();
    if (!items.length) {
      box.appendChild(el("p", "empty", emptyText));
      return;
    }
    items.forEach((item) => {
      const row = el("div", "h");
      const dot = el("div", "dot", item.category.charAt(0));
      dot.style.setProperty("--c", CAT_COLORS[item.category] || CAT_COLORS.Other);

      const grow = el("div", "grow");
      const title = el("b", "", item.subject);
      title.dir = "auto";
      const tags = item.tags.length ? `, ${item.tags.map((t) => `#${t}`).join(" ")}` : "";
      grow.append(title, el("span", "", `${item.kind === "reply" ? "Reply to" : "To"} ${item.recipient_name}, ${fmtDate(item.created_at)}, ${item.tone}${tags}`));

      const star = el("button", "del star");
      star.type = "button";
      star.setAttribute("aria-label", item.pinned ? "Remove from favorites" : "Add to favorites");
      star.setAttribute("aria-pressed", String(item.pinned));
      star.appendChild(icon("i-star"));
      star.addEventListener("click", () => patchMeta(item.id, { pinned: !item.pinned }));

      const view = el("button", "row-btn", "View");
      view.type = "button";
      view.addEventListener("click", async () => {
        await flushSave();
        fillForm(item);
        showEmail(item);
        go("generate");
      });

      const del = el("button", "del");
      del.type = "button";
      del.setAttribute("aria-label", `Delete email to ${item.recipient_name}`);
      del.appendChild(icon("i-trash"));
      del.addEventListener("click", () => removeEmail(item));

      row.append(dot, grow, star, view, del);
      box.appendChild(row);
    });
  }

  async function loadHistory() {
    const params = new URLSearchParams();
    const query = E.histSearch.value.trim();
    if (query) params.set("q", query);
    if (state.filter.tag) params.set("tag", state.filter.tag);
    if (state.filter.pinned) params.set("pinned", "true");
    try {
      const [items, tags] = await Promise.all([api(`/api/emails?${params}`), api("/api/tags")]);
      state.tags = tags.map((row) => row.tag);
      if (state.filter.tag && !state.tags.includes(state.filter.tag)) state.filter.tag = "";
      renderFilters();
      const filtered = query || state.filter.tag || state.filter.pinned;
      renderRows(E.histList, items, filtered ? "No emails match this search or filter." : "Emails you generate show up here.");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function renderFilters() {
    E.filterBar.replaceChildren();
    const { tag, pinned } = state.filter;
    const make = (label, active, onClick) => {
      const button = el("button", `filter${active ? " active" : ""}`, label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", onClick);
      E.filterBar.appendChild(button);
    };
    const apply = (nextTag, nextPinned) => {
      state.filter = { tag: nextTag, pinned: nextPinned };
      loadHistory();
    };
    make("All", !tag && !pinned, () => apply("", false));
    make("Favorites", pinned, () => apply("", !pinned));
    state.tags.slice(0, 8).forEach((name) => make(`#${name}`, tag === name, () => apply(tag === name ? "" : name, false)));
  }

  async function loadFavorites() {
    try {
      const items = await api("/api/emails?pinned=true");
      renderRows(E.favList, items, "Tap the star on an email and it will show up here.");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function removeEmail(item) {
    try {
      await api(`/api/emails/${item.id}`, { method: "DELETE" });
      if (state.current && state.current.id === item.id) showEmpty();
      refreshLists();
      toast("Email deleted");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  E.histSearch.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadHistory, 250);
  });

  /* ---------- analytics ---------- */
  function barBlock(box, counts) {
    box.replaceChildren();
    const entries = Object.entries(counts);
    if (!entries.length) {
      box.appendChild(el("p", "empty", "Nothing here yet. Generate an email first."));
      return;
    }
    const max = Math.max(...entries.map(([, value]) => value));
    entries.forEach(([name, value]) => {
      const row = el("div", "br");
      const track = el("div");
      const fill = el("i");
      fill.style.width = `${(value / max) * 100}%`;
      track.appendChild(fill);
      row.append(el("span", "", name), track, el("b", "", String(value)));
      box.appendChild(row);
    });
  }

  async function loadStats() {
    try {
      const stats = await api("/api/stats");
      E.stTotal.textContent = stats.total;
      E.stQuality.textContent = stats.average_quality === null ? "n/a" : `${stats.average_quality}%`;
      E.stSaved.textContent = `${stats.minutes_saved} min`;
      E.stTone.textContent = stats.top_tone || "n/a";
      barBlock(E.toneMix, stats.tones);
      barBlock(E.catMix, stats.categories);
      E.weekChart.replaceChildren();
      const max = Math.max(1, ...stats.week.map((d) => d.count));
      stats.week.forEach((day) => {
        const col = el("div", "wb");
        const column = el("i");
        column.style.height = `${(day.count / max) * 100}%`;
        column.title = `${day.count} on ${day.day}`;
        col.append(column, el("span", "", day.day.charAt(0)));
        E.weekChart.appendChild(col);
      });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ---------- settings ---------- */
  function applySettings() {
    E.scoreRow.hidden = !state.settings.show_score;
  }

  function fillSettings() {
    const s = state.settings;
    E.setName.value = s.sender_name;
    E.setTone.value = s.default_tone;
    E.setLang.value = s.default_language;
    E.setAnim.checked = s.typing_animation;
    E.setScore.checked = s.show_score;
  }

  async function loadSettings() {
    try {
      state.settings = await api("/api/settings");
    } catch (_) {
      /* defaults are fine */
    }
    applySettings();
    setRadio("tone", state.settings.default_tone);
    setRadio("language", state.settings.default_language);
  }

  E.setForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      state.settings = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          sender_name: E.setName.value.trim(),
          default_tone: E.setTone.value,
          default_language: E.setLang.value,
          typing_animation: E.setAnim.checked,
          show_score: E.setScore.checked,
        }),
      });
      applySettings();
      setRadio("tone", state.settings.default_tone);
      setRadio("language", state.settings.default_language);
      toast("Settings saved");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  E.clearAllBtn.addEventListener("click", async () => {
    if (!window.confirm("Delete all saved emails? This can't be undone.")) return;
    try {
      await api("/api/emails", { method: "DELETE" });
      showEmpty();
      toast("All emails deleted");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  /* ---------- startup ---------- */
  async function init() {
    updatePurposeCount();
    setMode("new");
    try {
      const health = await api("/api/health");
      if (!health.api_key_configured) {
        E.notice.textContent = "GROQ_API_KEY isn't set. Copy .env.example to .env, add your key, and restart the server.";
        E.notice.hidden = false;
      }
    } catch (_) {
      /* the server hosts this page, so this rarely fails */
    }
    await Promise.all([loadSettings(), loadTemplates()]);
    route();

    const params = new URLSearchParams(location.search);
    if (params.has("template")) {
      const template = state.templates.find((t) => t.id === params.get("template"));
      if (template) applyTemplate(template);
    } else if (params.has("prompt")) {
      E.purpose.value = params.get("prompt").slice(0, 800);
      updatePurposeCount();
      E.recipient.focus();
    }
    if (location.search) history.replaceState(null, "", location.pathname + location.hash);
  }

  init();
})();
