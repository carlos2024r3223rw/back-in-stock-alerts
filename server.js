import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "./data";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(`${DATA_DIR}/alerts.db`);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    sku TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','processing','notified','failed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notified_at TEXT,
    last_error TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_request
    ON requests(lower(email), upper(sku)) WHERE status IN ('open','processing');
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const json = (res, code, body) => {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
};
const html = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors *; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  res.end(body);
};
const readJson = async (req) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error("Payload too large"), { status: 413 });
  }
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
};
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const emailOk = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const skuOk = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(value);

async function sendNotification(request) {
  const base = process.env.RESEND_BASE_URL;
  const key = process.env.RESEND_API_KEY;
  if (!base || !key) throw new Error("Email service is not configured");
  const subject = `${request.sku} is back in stock`;
  const body = `<!doctype html><html><body style="margin:0;background:#f2f5f4;font-family:Arial,sans-serif;color:#17332b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 14px"><table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:18px;overflow:hidden"><tr><td style="background:#143d34;padding:28px;color:white"><b style="font-size:14px;letter-spacing:1px">RESTOCK</b><h1 style="margin:12px 0 0;font-size:30px">Good news — it’s back.</h1></td></tr><tr><td style="padding:30px"><p style="font-size:17px;line-height:1.6;margin-top:0">The item you asked about is available again.</p><div style="background:#eff8f4;border-radius:12px;padding:18px;margin:22px 0"><span style="color:#56736b;font-size:13px">SKU</span><div style="font-size:22px;font-weight:bold;margin-top:4px">${esc(request.sku)}</div></div><p style="color:#56736b;font-size:14px;line-height:1.5">Stock can move quickly, so take another look when you’re ready.</p></td></tr></table></td></tr></table></body></html>`;
  const response = await fetch(`${base.replace(/\/$/, "")}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": `restock-${request.id}` },
    body: JSON.stringify({ from: "Stock Alerts <alerts@example.com>", to: [request.email], subject, html: body })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

async function handleStockEvent(event) {
  if (!event.event_id || !skuOk(event.sku) || !Number.isFinite(Number(event.quantity))) {
    throw Object.assign(new Error("event_id, sku and quantity are required"), { status: 400 });
  }
  if (Number(event.quantity) <= 0) return { duplicate: false, notified: 0 };
  try { db.prepare("INSERT INTO webhook_events(event_id, sku) VALUES (?, ?)").run(String(event.event_id), event.sku.toUpperCase()); }
  catch (error) {
    if (String(error).includes("UNIQUE")) return { duplicate: true, notified: 0 };
    throw error;
  }
  const stockBase = process.env.STOCK_API_URL;
  const stockKey = process.env.STOCK_API_KEY;
  if (!stockBase || !stockKey) {
    db.prepare("DELETE FROM webhook_events WHERE event_id=?").run(String(event.event_id));
    throw Object.assign(new Error("Stock API is not configured"), { status: 503 });
  }
  let verified;
  try {
    const stockResponse = await fetch(`${stockBase.replace(/\/$/, "")}/${encodeURIComponent(event.sku)}`, {
      headers: { authorization: `Bearer ${stockKey}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!stockResponse.ok) throw new Error(`Stock API returned ${stockResponse.status}`);
    verified = await stockResponse.json();
  } catch (error) {
    // Network uncertainty must remain retryable: release the event id so the sender can try again.
    db.prepare("DELETE FROM webhook_events WHERE event_id=?").run(String(event.event_id));
    throw Object.assign(new Error(`Unable to verify stock: ${error.message}`), { status: 503 });
  }
  if (!verified.in_stock && Number(verified.quantity || 0) <= 0) {
    return { duplicate: false, notified: 0, stock_verified: false };
  }
  const pending = db.prepare("SELECT * FROM requests WHERE upper(sku)=upper(?) AND status='open' ORDER BY id").all(event.sku);
  let notified = 0;
  for (const request of pending) {
    const claimed = db.prepare("UPDATE requests SET status='processing' WHERE id=? AND status='open'").run(request.id);
    if (!claimed.changes) continue;
    try {
      await sendNotification(request);
      db.prepare("UPDATE requests SET status='notified', notified_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?").run(request.id);
      notified++;
    } catch (error) {
      db.prepare("UPDATE requests SET status='open', last_error=? WHERE id=?").run(String(error.message).slice(0, 500), request.id);
    }
  }
  return { duplicate: false, notified };
}

const page = (content, title = "Stock Alert") => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#edf7f2,#f8faf9);font:16px/1.5 system-ui;color:#18352d}.shell{max-width:720px;margin:7vh auto;padding:24px}.card{background:#fff;border:1px solid #dce9e4;border-radius:22px;padding:32px;box-shadow:0 18px 50px #173d3020}h1{font-size:clamp(30px,6vw,48px);line-height:1.05;margin:8px 0 14px}.eyebrow{color:#187453;font-weight:750;letter-spacing:.12em;font-size:12px}p{color:#587068}form{display:grid;gap:14px;margin-top:26px}label{font-weight:650}input{width:100%;padding:14px;border:1px solid #b9cbc5;border-radius:11px;font:inherit}button{border:0;border-radius:11px;padding:14px 18px;background:#173d34;color:white;font-weight:750;font-size:16px;cursor:pointer}.msg{padding:12px 14px;border-radius:10px;background:#e7f7ef;color:#126443}.error{background:#fff0ee;color:#9c3327}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e7eeeb;vertical-align:top}.pill{padding:4px 8px;border-radius:999px;background:#eef5f2;display:inline-block}</style></head><body><main class="shell"><section class="card">${content}</section></main></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/embed")) {
      return html(res, 200, page(`<div class="eyebrow">BACK-IN-STOCK ALERTS</div><h1>Don’t miss the restock.</h1><p>Tell us what you’re waiting for. We’ll send one email when it becomes available.</p><form id="alert"><label>Email<input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label><label>Product SKU<input name="sku" required maxlength="80" pattern="[A-Za-z0-9._-]+" placeholder="SKU-123"></label><button>Notify me</button><div id="result" aria-live="polite"></div></form><script>document.querySelector('#alert').addEventListener('submit',async e=>{e.preventDefault();let r=document.querySelector('#result');r.textContent='Saving…';r.className='msg';try{let x=await fetch('/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});let j=await x.json();r.textContent=x.ok?'You’re on the list. We’ll email you once.':j.error;r.className=x.ok?'msg':'msg error';if(x.ok)e.target.reset()}catch{r.textContent='Network error. Please try again.';r.className='msg error'}})</script>`));
    }
    if (req.method === "POST" && url.pathname === "/api/requests") {
      const body = await readJson(req); const email = body.email?.trim().toLowerCase(); const sku = body.sku?.trim().toUpperCase();
      if (!emailOk(email) || !skuOk(sku)) return json(res, 400, { error: "Enter a valid email and SKU." });
      try {
        const result = db.prepare("INSERT INTO requests(email, sku) VALUES (?, ?)").run(email, sku);
        return json(res, 201, { id: Number(result.lastInsertRowid), status: "open" });
      } catch (error) {
        if (String(error).includes("UNIQUE")) return json(res, 200, { status: "already_subscribed" });
        throw error;
      }
    }
    if (req.method === "POST" && url.pathname === "/webhooks/stock") {
      if (!WEBHOOK_SECRET || !safeEqual(req.headers["x-webhook-secret"] || "", WEBHOOK_SECRET)) return json(res, 401, { error: "Invalid webhook signature" });
      const result = await handleStockEvent(await readJson(req));
      return json(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/admin") {
      const auth = req.headers.authorization || ""; const expected = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString("base64")}`;
      if (!safeEqual(auth, expected)) { res.writeHead(401, { "www-authenticate": "Basic realm=\"Stock alerts\"" }); return res.end("Authentication required"); }
      const rows = db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 250").all();
      const table = rows.map(r => `<tr><td>${r.id}</td><td>${esc(r.email)}</td><td><b>${esc(r.sku)}</b></td><td><span class="pill">${esc(r.status)}</span></td><td>${esc(r.created_at)}</td><td>${esc(r.notified_at || '—')}</td></tr>`).join("");
      return html(res, 200, page(`<div class="eyebrow">OPERATIONS</div><h1>Alert requests</h1><p>${rows.length} most recent requests</p><div style="overflow:auto"><table><thead><tr><th>ID</th><th>Email</th><th>SKU</th><th>Status</th><th>Created</th><th>Notified</th></tr></thead><tbody>${table || '<tr><td colspan="6">No requests yet.</td></tr>'}</tbody></table></div>`, "Admin · Stock Alerts"));
    }
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error); json(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Stock alerts listening on ${PORT}`));
