(() => {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
  const rules = [["Thank you", ["thank"]], ["Follow up", ["follow up"]], ["Job application", ["job", "position", "apply"]], ["Meeting request", ["meeting"]], ["Leave request", ["leave"]], ["Complaint", ["complain", "delay"]], ["Business inquiry", ["pricing", "inquiry"]]];
  const cat = (p, k) => { if (k === "reply") return "Replies"; const t = p.toLowerCase(); for (const [n, w] of rules) if (w.some((x) => t.includes(x))) return n; return "Other"; };
  let nextId = 1;
  const mk = (o) => { const e = { id: nextId++, kind: "new", source_text: "", pinned: false, tags: [], quality: null, length: "Medium", language: "English", ...o }; e.category = cat(e.purpose, e.kind); return e; };
  let db = [
    mk({ recipient_name: "Sir Ahmed", purpose: "Request leave for two days", tone: "Formal", subject: "Leave request", body: "Respected Sir Ahmed,\n\nI request leave for two days.\n\nYours sincerely,\nAnushay", created_at: iso(3), quality: 88 }),
    mk({ recipient_name: "Ms Sana", purpose: "Follow up after interview", tone: "Friendly", subject: "Following up", body: "Hi Ms Sana,\n\nThanks again for the interview.\n\nBest,\nAnushay", created_at: iso(1), pinned: true, tags: ["jobs"] }),
  ];
  let templates = [];
  let tid = 1;
  const B = (id, name, purpose, tone, length) => ({ id: "b-" + id, name, purpose, tone, length: length || "Medium", language: "English", builtin: true });
  const BUILTIN = [B("leave", "Leave request", "Request leave for two days because of a family event", "Professional", "Short"), B("job", "Job application", "Apply for a junior data analyst position", "Professional"), B("followup", "Interview follow-up", "Follow up after an interview last week", "Friendly"), B("meeting", "Meeting request", "Request a short meeting", "Professional", "Short"), B("thanks", "Thank you note", "Thank the recipient for their time", "Friendly", "Short")];
  let settings = { sender_name: "", default_tone: "Professional", default_language: "English", typing_animation: true, show_score: true };
  const calls = []; window.__calls = calls;
  const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const urdu = "محترم صاحب،\n\nآپ کا شکریہ۔\n\nخیر اندیش";

  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const u = new URL(url, location.origin); const path = u.pathname;
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push(method + " " + path);
    await wait(60);
    if (path === "/api/health") return json({ status: "ok", model: "m", api_key_configured: true });
    if (path === "/api/settings") { if (method === "PUT") settings = body; return json(settings); }
    if (path === "/api/templates" && method === "GET") return json([...templates.slice().reverse(), ...BUILTIN]);
    if (path === "/api/templates" && method === "POST") { const t = { id: "u" + tid++, ...body, builtin: false }; templates.push(t); return json(t, 201); }
    const tm = path.match(/^\/api\/templates\/(u\d+)$/);
    if (tm) { templates = templates.filter((t) => t.id !== tm[1]); return new Response(null, { status: 204 }); }
    if (path === "/api/tags") { const c = {}; db.forEach((e) => e.tags.forEach((t) => (c[t] = (c[t] || 0) + 1))); return json(Object.entries(c).map(([tag, count]) => ({ tag, count }))); }
    if (path === "/api/stats") {
      const tones = {}, cats = {}; db.forEach((e) => { tones[e.tone] = (tones[e.tone] || 0) + 1; cats[e.category] = (cats[e.category] || 0) + 1; });
      const q = db.filter((e) => e.quality !== null).map((e) => e.quality);
      const week = [...Array(7)].map((_, i) => { const d = new Date(now - (6 - i) * 86400000); return { day: d.toLocaleDateString("en", { weekday: "short" }), date: d.toISOString().slice(0, 10), count: db.filter((e) => e.created_at.slice(0, 10) === d.toISOString().slice(0, 10)).length }; });
      return json({ total: db.length, average_quality: q.length ? Math.round(q.reduce((a, b) => a + b) / q.length) : null, minutes_saved: db.length * 4, top_tone: Object.keys(tones).sort((a, b) => tones[b] - tones[a])[0] || null, tones, categories: cats, week });
    }
    if (path === "/api/summarize") return json({ gist: "The team wants the budget confirmed.", questions: ["Can you confirm the budget?", "Who presents on Monday?"], deadlines: ["by Friday", "Monday at 3 pm"], reply_points: "Confirm the budget and name the presenter." });
    if (path === "/api/generate" || path === "/api/reply") {
      await wait(300);
      const reply = path === "/api/reply";
      const e = mk(reply ? { kind: "reply", recipient_name: body.recipient_name || "Sender", purpose: body.purpose || "Reply to received email", source_text: body.received_email, tone: body.tone, length: body.length, language: body.language, subject: "Re: your email", body: "Dear friend,\n\nThank you for your email.\n\nBest regards,\n" + (body.sender_name || settings.sender_name || "[Your Name]"), created_at: new Date().toISOString() }
        : { recipient_name: body.recipient_name, purpose: body.purpose, tone: body.tone, length: body.length, language: body.language, subject: "About " + body.purpose.slice(0, 30), body: "Dear " + body.recipient_name + ",\n\n" + body.purpose + ".\n\nBest regards,\n" + (body.sender_name || settings.sender_name || "[Your Name]"), created_at: new Date().toISOString() });
      if (body.language === "Urdu") e.body = urdu;
      db.unshift(e); return json(e);
    }
    if (path === "/api/emails" && method === "GET") {
      const q = (u.searchParams.get("q") || "").toLowerCase(), tag = u.searchParams.get("tag"), pinned = u.searchParams.get("pinned") === "true";
      return json(db.filter((e) => (!q || (e.subject + e.body + e.recipient_name).toLowerCase().includes(q)) && (!tag || e.tags.includes(tag)) && (!pinned || e.pinned)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id));
    }
    if (path === "/api/emails" && method === "DELETE") { db = []; return new Response(null, { status: 204 }); }
    const m = path.match(/^\/api\/emails\/(\d+)(?:\/(refine|subjects|analyze|tone|grammar|meta))?$/);
    if (m) {
      const e = db.find((x) => x.id === +m[1]); if (!e) return json({ detail: "That email no longer exists." }, 404);
      const act = m[2]; await wait(120);
      if (act === "refine") {
        if (body.action === "shorten") e.body = e.body.split("\n\n").slice(0, 2).join("\n\n");
        if (body.action === "longer") e.body += "\n\nExtra courtesy sentence.";
        if (body.action === "custom") e.body += "\n\n[" + body.instruction + "]";
        if (body.action === "urdu") { e.body = urdu; e.language = "Urdu"; }
        if (body.action === "english") { e.body = "Dear friend,\n\nBack in English.\n\nBest"; e.language = "English"; }
        e.quality = null; return json(e);
      }
      if (act === "subjects") return json({ subjects: ["Option A", "Option B", "Option C"] });
      if (act === "analyze") { e.quality = 82; return json({ score: 82, clarity: 88, tone_match: 84, completeness: 74, verdict: "Clear but the ask could be sharper.", tips: ["State the deadline.", "End with one clear ask."] }); }
      if (act === "tone") return json({ tones: [{ name: "Professional", percent: 50 }, { name: "Friendly", percent: 20 }, { name: "Formal", percent: 20 }, { name: "Confident", percent: 10 }], summary: "Mostly professional." });
      if (act === "grammar") { const had = /dont/.test(e.body); e.body = e.body.replace(/dont/g, "don't"); return json({ email: e, changes: had ? ["Added an apostrophe"] : [] }); }
      if (act === "meta") { if (typeof body.pinned === "boolean") e.pinned = body.pinned; if (body.tags) e.tags = body.tags.map((t) => t.toLowerCase().replace(/\s+/g, "-")).slice(0, 5); return json(e); }
      if (method === "PUT") { e.subject = body.subject; e.body = body.body; return json(e); }
      if (method === "DELETE") { db = db.filter((x) => x.id !== e.id); return new Response(null, { status: 204 }); }
    }
    return json({ detail: "Not found" }, 404);
  };
})();
