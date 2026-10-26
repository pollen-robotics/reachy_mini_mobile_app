#!/usr/bin/env python3
"""Drive the Reachy Mini app on an Android phone over Chrome DevTools (CDP).

Works on release builds (WebView debugging is on). Taps go through CDP
touch events, not `adb shell input`, which some ROMs (MIUI) block.

    cdp.py text                     page text
    cdp.py eval '<js>'              evaluate JS in the page, print the result
    cdp.py shot out.png             WebView screenshot (not the system bars)
    cdp.py tap '<selector or text>' tap an element by CSS selector or exact text
    cdp.py click X Y                tap at CSS pixel coordinates
    cdp.py type 'text'              type into the focused field
    cdp.py logs [N]                 last N console lines (lost when the app reloads)
    cdp.py rpc '<js using r>'       run JS against the live SDK instance `r`,
                                    e.g. "r.rpcCall('apps.status')"
    cdp.py redial                   fire sessionReconnecting, then
                                    sessionReconnected, on the live SDK
                                    instance (exercises the app's
                                    re-dial UI without touching the network)
    cdp.py dcmon install|read       data-channel gap monitor (gaps > 1 s)

Env:
    ADB_SERIAL   device serial (needed when several devices are attached)
    ADB          adb binary (default: `adb` on PATH)
    APP_PACKAGE  default com.pollen_robotics.reachy_mini
    CDP_PORT     local forward port (default 9222)

Needs `pip install websocket-client`.
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

ADB = [os.environ.get("ADB", "adb")] + (
    ["-s", os.environ["ADB_SERIAL"]] if os.environ.get("ADB_SERIAL") else []
)
PKG = os.environ.get("APP_PACKAGE", "com.pollen_robotics.reachy_mini")
PORT = int(os.environ.get("CDP_PORT", "9222"))

# The app can hold several ReachyMini SDK instances (a stale one survives an
# auto-reconnect): always pick the one with an open data channel.
LIVE_INSTANCE = "this.find(x => x._dc && x._dc.readyState === 'open') || this[0]"


def _page_ws_url() -> str:
    run = subprocess.run(ADB + ["shell", "pidof", PKG], capture_output=True, text=True)
    pid = run.stdout.strip()
    if run.returncode != 0 or not pid:
        why = run.stderr.strip() or f"{PKG} is not running"
        raise SystemExit(f"cdp: {why} (check `adb devices`, ADB_SERIAL, and that the app is open)")
    subprocess.check_call(
        ADB + ["forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{pid}"]
    )
    for _ in range(20):
        try:
            pages = json.load(urllib.request.urlopen(f"http://localhost:{PORT}/json"))
            pages = [p for p in pages if p.get("type") == "page"]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except OSError:
            pass
        time.sleep(0.5)
    raise SystemExit("no debuggable page (is the screen on and the app in front?)")


class CDP:
    def __init__(self) -> None:
        # suppress_origin: Chromium rejects DevTools sockets that send an Origin.
        self.ws = websocket.create_connection(_page_ws_url(), suppress_origin=True)
        self.i = 0

    def call(self, method: str, **params):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.i:
                return m.get("result", m)

    def eval(self, js: str):
        r = self.call("Runtime.evaluate", expression=js, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            return {"error": r["exceptionDetails"].get("exception", {}).get("description")}
        return r.get("result", {}).get("value")

    def shot(self, path: str) -> None:
        r = self.call("Page.captureScreenshot", format="png")
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))

    def click(self, x: float, y: float) -> None:
        pts = [{"x": x, "y": y}]
        self.call("Input.dispatchTouchEvent", type="touchStart", touchPoints=pts)
        self.call("Input.dispatchTouchEvent", type="touchEnd", touchPoints=[])

    def tap(self, target: str):
        js = f"""(() => {{
          const t = {json.dumps(target)};
          let el = null;
          try {{ el = document.querySelector(t); }} catch (e) {{}}
          if (!el) {{
            const all = [...document.querySelectorAll('button,[role=button],a,li,div,span,p')];
            el = all.filter(e => e.children.length === 0 || e.matches('button,[role=button]'))
                    .find(e => (e.innerText || '').trim() === t)
              || all.find(e => (e.innerText || '').trim().startsWith(t));
          }}
          if (!el) return null;
          el.scrollIntoView({{block: 'center'}});
          const r = el.getBoundingClientRect();
          return {{x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height}};
        }})()"""
        p = self.eval(js)
        if not p:
            raise SystemExit(f"tap: {target!r} not found")
        if not p["w"] or not p["h"]:
            raise SystemExit(f"tap: {target!r} has no size (screen off? overlay?)")
        self.click(p["x"], p["y"])
        return p

    def logs(self, n: int = 60) -> list[str]:
        # Console.enable replays the console history since the page loaded.
        self.ws.settimeout(3)
        self.ws.send(json.dumps({"id": 10_000, "method": "Console.enable"}))
        out, end = [], time.time() + 4
        while time.time() < end:
            try:
                m = json.loads(self.ws.recv())
            except Exception:
                break
            if m.get("method") == "Console.messageAdded":
                msg = m["params"]["message"]
                out.append(f"{msg['level']} {msg['text'][:300]}")
        return out[-n:]

    def on_sdk(self, body: str, await_promise: bool = True):
        """Run `body` (a function body using `r`) against the live SDK instance."""
        proto = self.call("Runtime.evaluate", expression="window.ReachyMini && window.ReachyMini.prototype")
        if "objectId" not in proto.get("result", {}):
            raise SystemExit("no ReachyMini SDK in the page (not connected yet?)")
        objs = self.call("Runtime.queryObjects", prototypeObjectId=proto["result"]["objectId"])["objects"]
        fn = f"async function() {{ const r = {LIVE_INSTANCE}; {body} }}"
        r = self.call(
            "Runtime.callFunctionOn", objectId=objs["objectId"], functionDeclaration=fn,
            awaitPromise=await_promise, returnByValue=True,
        )
        return r.get("result", {}).get("value")


def _rpc(c: CDP, expr: str):
    return c.on_sdk(
        f"try {{ return await ({expr}); }} catch (e) {{ return {{error: e.message, reason: e.reason}}; }}"
    )


def _fire(c: CDP, event: str):
    return c.on_sdk(
        f"r.dispatchEvent(new CustomEvent({json.dumps(event)}, "
        "{detail: {attempt: 1, maxAttempts: 5, cause: 'agent test'}})); return true;"
    )


DCMON_INSTALL = """
  const m = window.__dcmon = { last: performance.now(), gaps: [], logs: [], dc: null, msgs: 0 };
  const onMsg = () => { const now = performance.now(), gap = now - m.last;
    if (gap > 1000) m.gaps.push({ at: new Date().toISOString().slice(11, 23), gapMs: Math.round(gap) });
    m.last = now; m.msgs++; };
  setInterval(() => { if (r._dc && r._dc !== m.dc) { m.dc = r._dc; m.dc.addEventListener('message', onMsg);
    m.logs.push(new Date().toISOString().slice(11, 23) + ' [dcmon] attached'); } }, 100);
  for (const lvl of ['info', 'log', 'warn', 'error']) { const orig = console[lvl].bind(console);
    console[lvl] = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
      if (/reconnect|silence|data-channel|redial|ICE|session-|transport/i.test(s))
        m.logs.push(new Date().toISOString().slice(11, 23) + ' ' + s.slice(0, 200));
      orig(...a); }; }
  return 'installed';
"""
DCMON_READ = """(() => { const m = window.__dcmon; if (!m) return 'not installed';
  const r = { msgs: m.msgs, gaps: m.gaps, logs: m.logs }; m.gaps = []; m.logs = []; m.msgs = 0; return r; })()"""


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    c = CDP()
    if cmd == "text":
        print(c.eval("document.body.innerText"))
    elif cmd == "eval":
        print(json.dumps(c.eval(args[0]), indent=1, ensure_ascii=False))
    elif cmd == "shot":
        c.shot(args[0])
        print("saved", args[0])
    elif cmd == "tap":
        print(c.tap(args[0]))
    elif cmd == "click":
        c.click(float(args[0]), float(args[1]))
    elif cmd == "type":
        c.call("Input.insertText", text=args[0])
    elif cmd == "logs":
        print("\n".join(c.logs(int(args[0]) if args else 60)))
    elif cmd == "rpc":
        print(json.dumps(_rpc(c, args[0]), ensure_ascii=False))
    elif cmd == "redial":
        print("sessionReconnecting:", _fire(c, "sessionReconnecting"))
        time.sleep(2)
        print("page while re-dialing:", c.eval("document.body.innerText.slice(0, 300)"))
        print("sessionReconnected:", _fire(c, "sessionReconnected"))
    elif cmd == "dcmon":
        if args and args[0] == "install":
            print(c.on_sdk(DCMON_INSTALL, await_promise=False))
        else:
            print(json.dumps(c.eval(DCMON_READ), indent=1))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
