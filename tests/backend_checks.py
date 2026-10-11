"""Backend checks for LetterLy.

Imports the real main.py with tiny stand-ins for fastapi, pydantic and groq, replaces the AI call with fixed JSON,
and calls the endpoint functions directly. Needs only the Python standard library plus python-docx (for the Word export).

Usage:
    python tests/backend_checks.py sqlite       # SQLite storage
    python tests/backend_checks.py firestore    # Firestore storage, on top of an in-memory imitation
"""
import asyncio, copy, json, os, sys, tempfile, types
from pathlib import Path
from types import SimpleNamespace

backend = sys.argv[1] if len(sys.argv) > 1 else "sqlite"
if backend not in ("sqlite", "firestore"):
    sys.exit("Usage: python tests/backend_checks.py sqlite|firestore")
tmp = tempfile.mkdtemp()
os.environ["DATABASE_PATH"] = os.path.join(tmp, "t.db")
for k in ("FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT_B64", "FIREBASE_SERVICE_ACCOUNT_FILE"): os.environ.pop(k, None)

def mod(name, **attrs):
    m = types.ModuleType(name); m.__dict__.update(attrs); sys.modules[name] = m; return m

# ---------- stand-ins ----------
class HTTPException(Exception):
    def __init__(self, status_code, detail=None): self.status_code, self.detail = status_code, detail
class Response:
    def __init__(self, content=None, status_code=200, media_type=None, headers=None):
        self.content, self.status_code, self.media_type, self.headers, self.cookies = content, status_code, media_type, headers or {}, {}
    def set_cookie(self, key, value, **kw): self.cookies[key] = (value, kw)
class FieldInfo:
    def __init__(self, default): self.default = default
def Field(default=None, **kw): return None if default is ... else default
class BaseModel:
    def __init__(self, **kw):
        names = {}
        for klass in reversed(type(self).__mro__):
            names.update(getattr(klass, "__annotations__", {}))
        for name in names:
            setattr(self, name, kw[name] if name in kw else getattr(type(self), name, None))
    def model_dump(self): return {k: getattr(self, k) for k in self._names()}
    def _names(self):
        n = {}
        for k in reversed(type(self).__mro__): n.update(getattr(k, "__annotations__", {}))
        return n
    def model_dump_json(self): return json.dumps(self.model_dump())
class App:
    def __init__(self, **kw): self.routes = {}
    def _reg(self, method):
        def deco(path, **kw):
            def wrap(fn): self.routes[(method, path)] = fn; return fn
            return wrap
        return deco
    def __getattr__(self, name):
        if name in ("get", "post", "put", "patch", "delete"): return self._reg(name)
        raise AttributeError(name)
    def mount(self, *a, **kw): pass
async def run_in_threadpool(fn, *a, **kw): return fn(*a, **kw)
class _Err(Exception):
    status_code = 500
mod("groq", AsyncGroq=object, RateLimitError=type("R", (_Err,), {}), AuthenticationError=type("A", (_Err,), {}), APIConnectionError=type("C", (_Err,), {}), APIStatusError=type("S", (_Err,), {}))
mod("dotenv", load_dotenv=lambda *a, **k: None)
mod("fastapi", FastAPI=App, Depends=lambda f: f, HTTPException=HTTPException, Query=lambda default=None, **k: default, Request=object, Response=Response)
mod("fastapi.concurrency", run_in_threadpool=run_in_threadpool)
mod("fastapi.responses", FileResponse=lambda p: ("file", str(p)))
mod("fastapi.staticfiles", StaticFiles=lambda **k: None)
mod("pydantic", BaseModel=BaseModel, Field=Field, field_validator=lambda *a, **k: (lambda f: f), model_validator=lambda *a, **k: (lambda f: f))

# ---------- fake Firestore ----------
if backend == "firestore":
    DOCS = {}
    class AlreadyExists(Exception): pass
    class NotFound(Exception): pass
    class Snap:
        def __init__(self, ref, data): self.reference, self.id, self._d, self.exists = ref, ref.path[-1], data, data is not None
        def to_dict(self): return copy.deepcopy(self._d)
    class DocRef:
        def __init__(self, path): self.path = path
        def collection(self, n): return ColRef(self.path + (n,))
        def get(self): return Snap(self, DOCS.get(self.path))
        def create(self, d):
            if self.path in DOCS: raise AlreadyExists()
            DOCS[self.path] = copy.deepcopy(d)
        def set(self, d): DOCS[self.path] = copy.deepcopy(d)
        def update(self, f):
            if self.path not in DOCS: raise NotFound()
            DOCS[self.path].update(copy.deepcopy(f))
        def delete(self): DOCS.pop(self.path, None)
    class ColRef:
        def __init__(self, path): self.path = path
        def document(self, i): return DocRef(self.path + (i,))
        def stream(self): return [Snap(DocRef(k), v) for k, v in list(DOCS.items()) if len(k) == len(self.path) + 1 and k[:len(self.path)] == self.path]
    class Batch:
        def __init__(self): self.refs = []
        def delete(self, r): self.refs.append(r)
        def commit(self):
            assert len(self.refs) <= 500
            for r in self.refs: r.delete()
    class Client:
        def __init__(self, project=None, credentials=None): self.project = project
        def collection(self, n): return ColRef((n,))
        def batch(self): return Batch()
    google = mod("google"); cloud = mod("google.cloud"); oauth = mod("google.oauth2"); core = mod("google.api_core")
    fs = mod("google.cloud.firestore", Client=Client); cloud.firestore = fs
    sa = mod("google.oauth2.service_account", Credentials=SimpleNamespace(from_service_account_info=lambda info: ("creds", info["client_email"]))); oauth.service_account = sa
    ex = mod("google.api_core.exceptions", AlreadyExists=AlreadyExists, NotFound=NotFound); core.exceptions = ex
    google.cloud, google.oauth2, google.api_core = cloud, oauth, core
    os.environ["FIREBASE_SERVICE_ACCOUNT"] = json.dumps({"project_id": "p", "client_email": "a@b.c", "private_key": "k"})

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main

async def fake_llm(system, user, temperature=0.7, max_tokens=1200):
    if "subject lines" in user: return json.dumps({"subjects": ["A", "B", "C"]})
    if "strict writing coach" in user: return json.dumps({"score": 82, "clarity": 88, "tone_match": 84, "completeness": 74, "verdict": "Clear.", "tips": ["t1", "t2"]})
    if "percentages" in user: return json.dumps({"tones": [{"name": "Professional", "percent": 60}, {"name": "Friendly", "percent": 20}, {"name": "Formal", "percent": 10}, {"name": "Confident", "percent": 10}], "summary": "ok"})
    if "Fix only spelling" in user: return json.dumps({"subject": "Fixed subject", "body": "Fixed body", "changes": ["typo"]})
    if "Summarise the email thread" in user: return json.dumps({"gist": "G", "questions": ["Q?"], "deadlines": ["Fri"], "reply_points": "P"})
    return json.dumps({"subject": "Hello subject", "body": "Dear X,\n\nBody text.\n\nBest,\nSender"})
main.call_llm = fake_llm

R = main.app.routes
res = []
def ck(n, c): res.append(bool(c)); print(("PASS " if c else "FAIL ") + n)
def req(cookie=None): return SimpleNamespace(cookies={main.COOKIE_NAME: cookie} if cookie else {}, headers={"x-forwarded-proto": "https"}, url=SimpleNamespace(scheme="http"))
async def as_user(uid, coro):
    main.current_user.set(uid); return await coro

async def run():
    print("storage:", main.store.name)
    # cookie binding
    r1 = Response(); await main.bind_user(req(), r1)
    uid = r1.cookies[main.COOKIE_NAME][0]
    ck("cookie issued (32 hex, httponly, secure)", len(uid) == 32 and r1.cookies[main.COOKIE_NAME][1]["httponly"] and r1.cookies[main.COOKIE_NAME][1]["secure"])
    r2 = Response(); await main.bind_user(req(uid), r2)
    ck("existing cookie reused", not r2.cookies and main.current_user.get() == uid)
    r3 = Response(); await main.bind_user(req("not-a-valid-id"), r3)
    ck("bad cookie replaced", main.COOKIE_NAME in r3.cookies)
    main.current_user.set(uid)

    ck("health reports storage", (await R[("get", "/api/health")]())["storage"] == main.store.name)
    # settings -> sender name used
    await R[("put", "/api/settings")](main.SettingsModel(sender_name="Anushay Ayat", default_tone="Formal", default_language="English", typing_animation=False, show_score=True))
    s = await R[("get", "/api/settings")]()
    ck("settings saved and read", s.sender_name == "Anushay Ayat" and s.typing_animation is False)
    e = await R[("post", "/api/generate")](main.GenerateRequest(recipient_name="Sir Ahmed", purpose="Request leave for two days", tone="Formal", length="Short", language="English"))
    ck("generate stores email with category", e["id"] and e["category"] == "Leave request" and e["pinned"] is False and e["tags"] == [] and e["quality"] is None)
    ck("saved sender name applied", main.build_generate_prompt(main.GenerateRequest(recipient_name="x", purpose="y z", tone="Formal", length="Short", language="English", sender_name="Anushay Ayat")).count("Anushay Ayat") == 1)
    r = await R[("post", "/api/reply")](main.ReplyRequest(received_email="Hello can you send the report by Friday?", recipient_name=None, purpose=None, tone="Friendly", length="Short", language="English", sender_name=None))
    ck("reply stored with defaults", r["kind"] == "reply" and r["recipient_name"] == "Sender" and r["category"] == "Replies" and r["source_text"].startswith("Hello"))
    # edit, meta
    await R[("put", "/api/emails/{email_id}")](e["id"], main.EditRequest(subject="  New subj ", body=" New body "))
    got = await main.fetch_email(e["id"]); ck("edit trims and saves", got["subject"] == "New subj" and got["body"] == "New body")
    m = await R[("patch", "/api/emails/{email_id}/meta")](e["id"], main.MetaRequest(pinned=True, tags=["Work Stuff", "urgent", "work stuff", "a,b"]))
    ck("pin + tags normalised", m["pinned"] is True and m["tags"] == ["work-stuff", "urgent", "a-b"])
    # list / filters
    allr = await R[("get", "/api/emails")]("", "", False); ck("list newest first, pinned on top", [x["id"] for x in allr][:2] == [e["id"], r["id"]] and len(allr) == 2)
    ck("tag filter", [x["id"] for x in await R[("get", "/api/emails")]("", "urgent", False)] == [e["id"]])
    ck("pinned filter", [x["id"] for x in await R[("get", "/api/emails")]("", "", True)] == [e["id"]])
    ck("search filter", [x["id"] for x in await R[("get", "/api/emails")]("report", "", False)] == [r["id"]])
    ck("tags endpoint", {t["tag"]: t["count"] for t in await R[("get", "/api/tags")]()} == {"work-stuff": 1, "urgent": 1, "a-b": 1})
    # AI helpers
    ref = await R[("post", "/api/emails/{email_id}/refine")](e["id"], main.RefineRequest(action="custom", instruction="more polite"))
    ck("refine updates body and language", ref["subject"] == "Hello subject" and ref["quality"] is None)
    ur = await R[("post", "/api/emails/{email_id}/refine")](e["id"], main.RefineRequest(action="urdu", instruction=None)); ck("urdu action sets language", ur["language"] == "Urdu")
    ck("subjects", (await R[("post", "/api/emails/{email_id}/subjects")](e["id"]))["subjects"] == ["A", "B", "C"])
    an = await R[("post", "/api/emails/{email_id}/analyze")](e["id"]); ck("analyze score saved to email", an.score == 82 and (await main.fetch_email(e["id"]))["quality"] == 82)
    tn = await R[("post", "/api/emails/{email_id}/tone")](e["id"]); ck("tone sums to 100", sum(t["percent"] for t in tn["tones"]) == 100)
    gr = await R[("post", "/api/emails/{email_id}/grammar")](e["id"]); ck("grammar updates email and clears quality", gr["email"]["body"] == "Fixed body" and gr["email"]["quality"] is None and gr["changes"] == ["typo"])
    sm = await R[("post", "/api/summarize")](main.SummarizeRequest(thread="x" * 30)); ck("summarize", sm["gist"] == "G" and sm["questions"] == ["Q?"])
    # stats
    st = await R[("get", "/api/stats")](); ck("stats", st["total"] == 2 and st["minutes_saved"] == 8 and len(st["week"]) == 7 and sum(w["count"] for w in st["week"]) == 2 and st["categories"] == {"Replies": 1, "Leave request": 1} or st["categories"] == {"Leave request": 1, "Replies": 1})
    # export
    dx = await R[("get", "/api/emails/{email_id}/export.docx")](e["id"]); ck("docx export bytes", dx.content[:2] == b"PK" and "attachment" in dx.headers["Content-Disposition"])
    # templates
    t = await R[("post", "/api/templates")](main.TemplateRequest(name="My tpl", purpose="Ask for a thing", tone="Formal", length="Short", language="English"))
    ck("template saved with u-id", t["id"].startswith("u") and t["builtin"] is False)
    tl = await R[("get", "/api/templates")](); ck("saved templates first, then built-ins", tl[0]["id"] == t["id"] and tl[-1]["builtin"] and len(tl) == 11)
    await R[("delete", "/api/templates/{template_id}")](t["id"]); ck("template deleted", len(await R[("get", "/api/templates")]()) == 10)
    try: await R[("delete", "/api/templates/{template_id}")]("b-leave"); ck("builtin delete rejected", False)
    except HTTPException as ex: ck("builtin delete rejected", ex.status_code == 400)
    # isolation between visitors (Firestore only: SQLite is single-user local)
    if backend == "firestore":
        other = "b" * 32; main.current_user.set(other)
        ck("other visitor sees nothing", await R[("get", "/api/emails")]("", "", False) == [] and (await R[("get", "/api/settings")]()).sender_name == "")
        main.current_user.set(uid)
    # delete + 404
    await R[("delete", "/api/emails/{email_id}")](r["id"]); ck("delete one", len(await R[("get", "/api/emails")]("", "", False)) == 1)
    try: await main.fetch_email(r["id"]); ck("deleted email gives 404", False)
    except HTTPException as ex: ck("deleted email gives 404", ex.status_code == 404)
    await R[("delete", "/api/emails")](); ck("clear all", await R[("get", "/api/emails")]("", "", False) == [])
    ck("stats on empty", (await R[("get", "/api/stats")]())["average_quality"] is None)
    # big clear (batch splitting)
    if backend == "firestore":
        for i in range(450): main.store.email_insert({"recipient_name": "x", "purpose": "p", "tone": "Formal", "length": "Short", "language": "English", "subject": "s", "body": "b", "created_at": "2026-01-01T00:00:00+00:00", "kind": "new", "source_text": ""})
        await R[("delete", "/api/emails")](); ck("clear 450 docs in batches", len(main.store.email_all()) == 0)
asyncio.run(run())
print(f"{sum(res)}/{len(res)} passed ({backend})"); sys.exit(0 if all(res) else 1)
