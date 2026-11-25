// Rx Overlap Checker server: serves the web app and the B2B check API. Zero dependencies (Node 20+).
//   node server.js            (reads .env next to this file)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, BrandDB, parseLine, parseComposition, canon, aiParse, aiReview, CONDITIONS } from "./engine.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// --- config from .env (keys never reach the browser) ---
const envFile = path.join(ROOT, ".env");
if(fs.existsSync(envFile)) for(const line of fs.readFileSync(envFile, "utf8").split("\n")){
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if(m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const E = process.env;
const PORT = +(E.PORT || 8787);
const CLIENT_KEYS = new Set((E.CLIENT_API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean));
const ai = E.ANTHROPIC_API_KEY ? { provider:"claude", claudeKey:E.ANTHROPIC_API_KEY, claudeModel:E.CLAUDE_MODEL || "claude-opus-5-5" }
         : E.OLLAMA_URL ? { provider:"ollama", ollamaUrl:E.OLLAMA_URL, ollamaModel:E.OLLAMA_MODEL, ollamaVisionModel:E.OLLAMA_VISION_MODEL }
         : null;
const UI_AI_PROXY = E.UI_AI_PROXY !== "false";

const brands = new BrandDB();
for(const f of (E.BRANDS_CSV || "data/brands-in.csv").split(",").map(s => s.trim()).filter(Boolean)){
  try{ const n = brands.addCSV(fs.readFileSync(path.resolve(ROOT, f), "utf8")); console.log(`Loaded ${n} brands from ${f}`); }
  catch(e){ console.warn(`Could not load ${f}: ${e.message}`); }
}
const engine = createEngine({ brands, fdaKey:E.OPENFDA_API_KEY || "",
  custom: E.CUSTOM_SOURCE_URL ? { url:E.CUSTOM_SOURCE_URL, header:E.CUSTOM_SOURCE_HEADER, key:E.CUSTOM_SOURCE_KEY } : null });

// --- helpers ---
const send = (res, code, obj) => { res.writeHead(code, {"content-type":"application/json", "access-control-allow-origin":"*", "access-control-allow-headers":"content-type, x-api-key"}); res.end(JSON.stringify(obj)); };
const httpError = (status, msg) => Object.assign(new Error(msg), {status});
const readBody = req => new Promise((ok, fail) => {
  let b = "";
  req.on("data", c => { b += c; if(b.length > 15e6){ req.removeAllListeners("data"); req.pause(); b = ""; fail(httpError(413, "request too large")); } });
  req.on("end", () => { try{ ok(b ? JSON.parse(b) : {}); }catch{ fail(httpError(400, "invalid JSON")); } });
});
// With no client keys configured the API only answers this machine, so a deploy that forgets CLIENT_API_KEYS isn't open to the internet.
const isLocal = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const authorized = req => CLIENT_KEYS.size ? CLIENT_KEYS.has(req.headers["x-api-key"]) : isLocal(req);
// Browsers always send Origin on cross-site POSTs; a missing or "null" Origin is not proof of our own page.
const sameOrigin = req => { try{ return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; }catch{ return false; } };

// shortcut: per-process, in-memory AI rate limit; move to a shared store (e.g. Redis) when running more than one server process.
const AI_LIMIT = +(E.UI_AI_LIMIT_PER_HOUR || 30), aiHits = new Map();
function overAILimit(req){
  const ip = req.socket.remoteAddress, now = Date.now(), h = aiHits.get(ip);
  if(!h || now - h.start > 3600e3){ if(aiHits.size > 1e4) aiHits.clear(); aiHits.set(ip, {start:now, n:1}); return false; }
  return ++h.n > AI_LIMIT;
}

const VALID_CONDS = new Set(CONDITIONS.map(([k]) => k));
// Trust boundary: a value that isn't a plain number would silently switch off child and dose checks, so reject it.
function numberIn(v, name, min, max, required){
  if(v == null || v === ""){ if(required) throw httpError(400, `${name} is required`); return null; }
  if(typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw httpError(400, `${name} must be a number from ${min} to ${max}`);
  return v;
}
const SEXES = ["female", "male", "other", ""];
function toProfile(p = {}){
  if(typeof p !== "object" || Array.isArray(p)) throw httpError(400, "patient must be an object");
  const age = numberIn(p.age, "patient.age", 0, 120, true), weight = numberIn(p.weight_kg, "patient.weight_kg", 1, 300), height = numberIn(p.height_cm, "patient.height_cm", 30, 250);
  if(!SEXES.includes(p.sex ?? "")) throw httpError(400, `patient.sex must be one of: female, male, other`);
  if(p.conditions != null && !Array.isArray(p.conditions)) throw httpError(400, "patient.conditions must be an array");
  const conds = {}, unknown = [];
  for(const c of p.conditions || []){ const k = String(c).toLowerCase().trim(); if(VALID_CONDS.has(k)) conds[k] = true; else unknown.push(c); }
  if(unknown.length) throw httpError(400, `unknown conditions: ${unknown.join(", ")}. Valid: ${[...VALID_CONDS].join(", ")}`);
  return { age, sex:p.sex || "", weight, height, allergies:(p.allergies || []).join?.(",") ?? p.allergies ?? "", conds };
}

// Accepts free text, structured medicines, or both.
async function resolveMedicines(body){
  let meds = [];
  if(body.prescription_text != null && typeof body.prescription_text !== "string") throw httpError(400, "prescription_text must be a string");
  if(body.medicines != null && !Array.isArray(body.medicines)) throw httpError(400, "medicines must be an array");
  if(body.prescription_text){
    meds = ai && body.ai_parse ? await aiParse(ai, {text:body.prescription_text})
      : body.prescription_text.split(/\n+/).map(l => l.trim()).filter(l => /[a-z]/i.test(l)).map(parseLine);
  }
  for(const [n, m] of (body.medicines || []).entries()){
    const at = `medicines[${n}]`;
    if(typeof m?.name !== "string" || !m.name.trim()) throw httpError(400, `${at}.name is required`);
    const p = parseLine([m.name, m.strength].filter(Boolean).join(" "));
    const units = numberIn(m.units_per_dose, `${at}.units_per_dose`, 0.01, 100), perDay = numberIn(m.doses_per_day, `${at}.doses_per_day`, 0.01, 48);
    if(units) p.units = units;
    if(perDay){ p.perDay = perDay; p.guessedFreq = false; }
    if(m.frequency){ const f = parseLine("x " + m.frequency); if(!f.guessedFreq || f.prn){ p.perDay = f.perDay; p.prn = f.prn; p.guessedFreq = false; } }
    if(m.as_needed) p.prn = true;
    if(m.ingredients != null && !Array.isArray(m.ingredients)) throw httpError(400, `${at}.ingredients must be an array`);
    if(m.ingredients?.length) p.given = m.ingredients.map((i, k) => {
      if(typeof i?.name !== "string" || !i.name.trim()) throw httpError(400, `${at}.ingredients[${k}].name is required`);
      return { name:canon(i.name), mg:numberIn(i.mg ?? i.strength_mg, `${at}.ingredients[${k}].mg`, 0.001, 100000) };
    });
    else if(m.composition) p.given = parseComposition(m.composition);
    meds.push(p);
  }
  const unresolved = [];
  await Promise.all(meds.map(async (m, i) => {
    if(m.given){ meds[i] = { ...m, matched:m.query, source:"provided", ings:m.given }; return; }
    try{ meds[i] = { ...m, ...(await engine.lookup(m)) }; }
    catch(e){
      if(m.aiComposition){ meds[i] = { ...m, matched:m.aiComposition, source:"ai", ings:parseComposition(m.aiComposition) }; return; }
      unresolved.push({ as_written:m.raw, reason:e.message });
    }
  }));
  return { meds, unresolved };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try{
    if(req.method === "OPTIONS") return send(res, 204, {});

    if(url.pathname === "/v1/config") return send(res, 200, { ai: ai?.provider || null, ui_ai_proxy: !!(ai && UI_AI_PROXY), brands: brands.size,
      custom_source: !!E.CUSTOM_SOURCE_URL, openfda_key: !!E.OPENFDA_API_KEY });

    // B2B: run a full check. Call it before a prescription is signed/sent.
    if(url.pathname === "/v1/check" && req.method === "POST"){
      if(!authorized(req)) return send(res, 401, {error:"missing or invalid x-api-key"});
      const body = await readBody(req);
      const patient = toProfile(body.patient);
      const { meds, unresolved } = await resolveMedicines(body);
      const report = await engine.analyze(meds, patient, { labels: body.include_labels !== false });
      report.unresolved = unresolved;
      if(body.ai_review && ai){ try{ report.ai_review = await aiReview(ai, body.patient || {}, report); }catch(e){ report.ai_review = {error:e.message}; } }
      report.disclaimer = "Decision support only. Not a substitute for clinical judgement. Reference limits are typical adult maximums.";
      return send(res, 200, report);
    }

    // Brand lookup only.
    if(url.pathname === "/v1/lookup" && req.method === "GET"){
      if(!authorized(req)) return send(res, 401, {error:"missing or invalid x-api-key"});
      try{ return send(res, 200, await engine.lookup(parseLine(url.searchParams.get("q") || ""))); }
      catch(e){ return send(res, 404, {error:e.message}); }
    }

    // AI for this server's own web UI, so provider keys stay server-side. Only the app's two fixed tasks, rate-limited per IP.
    if((url.pathname === "/v1/ai/parse" || url.pathname === "/v1/ai/review") && req.method === "POST"){
      if(!ai || !UI_AI_PROXY) return send(res, 404, {error:"server AI not configured"});
      const client = CLIENT_KEYS.has(req.headers["x-api-key"]);
      if(!client && !sameOrigin(req)) return send(res, 403, {error:"forbidden"});
      if(!client && overAILimit(req)) return send(res, 429, {error:"too many AI requests, try again later"});
      const body = await readBody(req);
      if(url.pathname === "/v1/ai/parse"){
        if(String(body.text || "").length > 5000) return send(res, 413, {error:"prescription text too long"});
        return send(res, 200, { meds: await aiParse(ai, {text:body.text, image:body.image}) });
      }
      const r = body.report;
      if(![r?.medicines, r?.ingredients, r?.alerts].every(Array.isArray)) return send(res, 400, {error:"report must come from /v1/check or the web app"});
      return send(res, 200, await aiReview(ai, body.patient || {}, r));
    }

    // Static files (the web app).
    if(req.method === "GET"){
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.resolve(ROOT, rel);
      if(!file.startsWith(ROOT + path.sep) || /(^|\/)\.env|server\.js$/.test(rel) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, {error:"not found"});
      const type = {".html":"text/html", ".js":"text/javascript", ".csv":"text/csv", ".json":"application/json", ".md":"text/markdown"}[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, {"content-type": type + "; charset=utf-8"}); return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, {error:"not found"});
  }catch(e){
    if(!e.status) console.error(e);
    if(e.status === 413) res.on("finish", () => req.destroy()); // reply first, then drop the rest of the upload
    if(!res.headersSent) send(res, e.status || 500, {error:e.message});
  }
});
server.listen(PORT, () => {
  console.log(`Rx checker on http://localhost:${server.address().port}  ·  AI: ${ai?.provider || "off"}  ·  client keys: ${CLIENT_KEYS.size || "none (API answers this machine only)"}`);
});
