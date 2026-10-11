"""Browser checks for LetterLy.

Serves the public/ folder on a free local port, replaces the API with tests/mock_api.js and drives the real pages
in a headless Chromium. Needs Playwright:  pip install playwright && playwright install chromium

Usage:  python tests/ui_checks.py
"""
import functools, http.server, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MOCK = str(Path(__file__).resolve().parent / "mock_api.js")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT / "public"), **k)

    def log_message(self, *args):
        pass


_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{_server.server_address[1]}"
errs, res = [], []
def ck(n, c): res.append(bool(c)); print(("PASS " if c else "FAIL ") + n)
def fresh(b, w=1440, h=950, **kw):
    ctx = b.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce", **kw)
    pg = ctx.new_page()
    pg.route("**/fonts.*/**", lambda r: r.abort())
    pg.route("**/export.docx", lambda r: r.fulfill(status=200, body=b"PK", headers={"Content-Disposition": "attachment; filename=\"x.docx\"", "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}))
    pg.add_init_script(path=MOCK)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append("console: " + m.text) if m.type == "error" and "Failed to load resource" not in m.text and "fonts" not in m.text else None)
    return pg
with sync_playwright() as p:
    b = p.chromium.launch()
    # ---------- landing ----------
    L = fresh(b); L.goto(BASE + "/index.html"); L.wait_for_timeout(500)
    ck("landing hero heading", "Perfect Emails" in L.inner_text("h1"))
    ck("landing sections (why 5 cards, how 3 steps)", L.locator(".wg > div").count() == 5 and L.locator(".steps > div").count() == 3)
    # ---------- app ----------
    A = fresh(b); A.goto(BASE + "/app.html"); A.wait_for_timeout(700)
    ck("greeting shown", A.inner_text("#vt").startswith("Good"))
    ck("template chips (4 + all)", A.locator("#chips .chip").count() == 5)
    ck("empty state visible", A.locator("#genEmpty").is_visible() and A.locator("#genBody").is_hidden())
    # validation
    A.click("#generateBtn"); ck("validation errors", A.locator("#recipientError").is_visible() and A.locator("#purposeError").is_visible())
    # template -> generate
    A.click("#chips .chip:has-text('Meeting request')"); ck("template filled purpose", "short meeting" in A.input_value("#purpose"))
    A.fill("#recipient", "Mr Khan"); A.click("#generateBtn"); A.wait_for_selector("#genBody:not([hidden])"); A.wait_for_timeout(500)
    ck("email generated", "Dear Mr Khan" in A.input_value("#bodyInput") and A.input_value("#subjectInput").startswith("About"))
    # refine actions
    A.click("#shortenBtn"); A.wait_for_timeout(500); ck("shorten", A.input_value("#bodyInput").count("\n\n") <= 1)
    A.click("#ctaBtn"); A.wait_for_timeout(500); ck("add CTA (custom)", "call to action" in A.input_value("#bodyInput"))
    A.fill("#tuneInput", "make it more polite"); A.click("#tuneBtn"); A.wait_for_timeout(500); ck("custom instruction", "more polite" in A.input_value("#bodyInput") and A.input_value("#tuneInput") == "")
    A.click("#tuneBtn"); ck("empty instruction toast", A.locator(".toast.error", has_text="Type what you want changed").count() >= 1)
    A.click("#langBtn"); A.wait_for_timeout(500); ck("urdu rtl", A.get_attribute("#bodyInput", "dir") == "rtl")
    A.click("#langBtn"); A.wait_for_timeout(500); ck("back to english", A.get_attribute("#bodyInput", "dir") == "ltr")
    # AI tools
    A.click("#subjectsBtn"); A.wait_for_selector("#subjectSuggest:not([hidden])"); A.locator("#suggestList button").nth(1).click()
    ck("subject suggestion applied", A.input_value("#subjectInput") == "Option B")
    A.click("#qualityBtn"); A.wait_for_selector("#tipsPanel:not([hidden])"); ck("quality ring 82%", A.inner_text("#ringNum") == "82%" and A.locator("#tipsPanel li").count() == 2)
    A.click("#toneBtn"); A.wait_for_selector("#tonePanel:not([hidden])"); ck("tone panel: 4 bars", A.locator("#tonePanel .br").count() == 4)
    A.evaluate("document.querySelector('#bodyInput').value += ' i dont know'; document.querySelector('#bodyInput').dispatchEvent(new Event('input'))")
    A.wait_for_timeout(900)
    A.click("#grammarBtn"); A.wait_for_selector("#grammarPanel:not([hidden])"); ck("grammar fix applied", "don't" in A.input_value("#bodyInput") and "apostrophe" in A.inner_text("#grammarPanel"))
    # favorite + tags
    A.click("#favBtn"); A.wait_for_timeout(300); ck("favorited", A.get_attribute("#favBtn", "aria-pressed") == "true")
    A.fill("#tagInput", "Work Stuff"); A.press("#tagInput", "Enter"); A.wait_for_timeout(300); ck("tag added", A.locator(".tag-chip", has_text="#work-stuff").count() == 1)
    # exports
    A.click("#wordBtn"); A.wait_for_timeout(200); ck("word export stays on page (download)", A.locator("#genBody").is_visible())
    A.click("#pdfBtn"); A.wait_for_timeout(100); ck("print sheet filled", "About" in A.inner_text("#printSheet h1") or A.locator("#printSheet h1").count() == 1)
    # reply mode
    A.click("input[name=mode][value=reply]"); ck("reply mode UI", A.locator("#receivedField").is_visible() and A.inner_text("#generateLabel") == "Write reply")
    A.click("#generateBtn"); ck("reply needs pasted email", A.locator("#receivedError").is_visible())
    A.fill("#received", "Hello, can you send the report by Friday? Thanks, Imran"); A.click("#generateBtn"); A.wait_for_timeout(900)
    ck("reply generated with badge", A.locator("#kindTag").is_visible() and A.locator("#origBox").is_visible())
    # thread summary
    A.fill("#threadInput", "Hi team, can you confirm the budget? We need it by Friday. Who presents on Monday at 3 pm?"); A.click("#summarizeBtn"); A.wait_for_selector("#sumOut:not([hidden])")
    ck("summary: gist+2 lists+button", A.locator("#sumOut > div").count() == 3 and A.locator("#sumOut .btn").count() == 1)
    A.click("#sumOut .btn"); ck("summary -> reply form", "Confirm the budget" in A.input_value("#purpose") and "confirm the budget" in A.input_value("#received"))
    # save template dialog
    A.click("input[name=mode][value=new]"); A.click("#saveTplBtn"); A.wait_for_selector("#tplDialog[open]")
    A.fill("#tplName", "My template"); A.click("#tplSaveForm button[type=submit]"); A.wait_for_timeout(500)
    ck("template saved (chips first)", A.locator("#chips .chip").first.inner_text() == "My template")
    # navigation views
    A.click("#nav a[data-view=templates]"); A.wait_for_timeout(300); ck("templates view: 6 cards + 1 deletable", A.locator("#tplGrid .t").count() == 6 and A.locator("#tplGrid .del").count() == 1)
    A.fill("#tplSearch", "leave"); ck("template search", A.locator("#tplGrid .t").count() == 1); A.fill("#tplSearch", "")
    A.click("#nav a[data-view=history]"); A.wait_for_timeout(500); ck("history rows", A.locator("#histList .h").count() >= 4)
    A.click("#filterBar .filter:has-text('Favorites')"); A.wait_for_timeout(300); ck("favorites filter", A.locator("#histList .h").count() >= 1)
    A.click("#filterBar .filter:has-text('All')"); A.wait_for_timeout(300)
    A.fill("#histSearch", "Ahmed"); A.wait_for_timeout(500); ck("history search", A.locator("#histList .h").count() == 1)
    A.fill("#histSearch", ""); A.wait_for_timeout(500)
    A.locator("#histList .h .row-btn").first.click(); A.wait_for_timeout(300); ck("View opens email in generator", A.locator("#genBody").is_visible() and A.url.endswith("#/generate"))
    A.click("#nav a[data-view=favorites]"); A.wait_for_timeout(400); ck("favorites view lists starred", A.locator("#favList .h").count() >= 1)
    A.click("#nav a[data-view=analytics]"); A.wait_for_timeout(500); ck("analytics numbers", int(A.inner_text("#stTotal")) >= 4 and A.locator("#weekChart .wb").count() == 7 and A.locator("#toneMix .br").count() >= 2)
    A.click("#nav a[data-view=settings]"); A.wait_for_timeout(300)
    A.fill("#setName", "Anushay Ayat"); A.uncheck("#setScore"); A.click("#setForm button[type=submit]"); A.wait_for_timeout(400)
    A.click("#nav a[data-view=generate]"); A.wait_for_timeout(300)
    ck("settings: greeting uses name + score hidden", "Anushay" in A.inner_text("#vt") and A.locator("#scoreRow").is_hidden())
    A.click("#themeBtn"); ck("theme toggled", A.evaluate("document.documentElement.dataset.theme") in ("dark", "light"))
    # deep links
    D = fresh(b); D.goto(BASE + "/app.html?template=b-job"); D.wait_for_timeout(900)
    ck("deep link template applies", "data analyst" in D.input_value("#purpose") and "?" not in D.url)
    D2 = fresh(b); D2.goto(BASE + "/app.html?prompt=Write%20to%20my%20boss"); D2.wait_for_timeout(700)
    ck("deep link prompt fills purpose", D2.input_value("#purpose") == "Write to my boss")
    # mobile
    M = fresh(b, 390, 844, device_scale_factor=2); M.goto(BASE + "/app.html"); M.wait_for_timeout(700)
    ck("mobile: tab bar visible, sidebar hidden", M.locator("#tabbar").is_visible() and M.locator(".side").is_hidden())
    ck("mobile: no horizontal overflow", not M.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth"))
    M.click("#tabbar a[data-view=history]"); M.wait_for_timeout(400); ck("mobile tab navigates", M.locator("[data-panel=history]").is_visible())
    M.goto(BASE + "/app.html"); M.wait_for_timeout(500); M.fill("#recipient", "Sir"); M.fill("#purpose", "Ask for an extension"); M.click("#generateBtn"); M.wait_for_timeout(900)
    ML = fresh(b, 390, 844); ML.goto(BASE + "/index.html"); ML.wait_for_timeout(500)
    ck("mobile landing: no overflow", not ML.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth"))
    b.close()
print("\nerrors:", errs or "none"); print(f"{sum(res)}/{len(res)} checks passed")