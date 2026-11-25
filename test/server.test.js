// Starts the real server on a free port and checks its security and validation rules: node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));

function start(env){
  const proc = spawn(process.execPath, [SERVER], { env:{ ...process.env, PORT:"0", CLIENT_API_KEYS:"", ANTHROPIC_API_KEY:"", OLLAMA_URL:"", ...env } });
  return new Promise((ok, fail) => {
    let out = "";
    proc.stderr.on("data", d => { out += d; });
    proc.stdout.on("data", d => { out += d; const m = out.match(/http:\/\/localhost:(\d+)/); if(m) ok({ proc, url:`http://127.0.0.1:${m[1]}` }); });
    proc.on("exit", code => fail(new Error(`server exited (${code}): ${out}`)));
  });
}
const post = (url, path, body, headers = {}) => fetch(url + path, { method:"POST", headers:{ "content-type":"application/json", ...headers }, body:typeof body === "string" ? body : JSON.stringify(body) });

let api, ai;
before(async () => {
  api = await start({ CLIENT_API_KEYS:"test-key" });
  ai = await start({ ANTHROPIC_API_KEY:"not-a-real-key", UI_AI_LIMIT_PER_HOUR:"1" }); // AI routes on; no request below reaches Anthropic
});
after(() => { api.proc.kill(); ai.proc.kill(); });

const KEY = { "x-api-key":"test-key" };
const patient = { age:40, weight_kg:60, conditions:["liver"] };

test("rejects requests without a valid client key", async () => {
  assert.equal((await post(api.url, "/v1/check", {})).status, 401);
  assert.equal((await post(api.url, "/v1/check", {}, { "x-api-key":"wrong" })).status, 401);
});

test("catches a paracetamol overdose", async () => {
  const r = await post(api.url, "/v1/check", { patient, medicines:[{ name:"Calpol 650", doses_per_day:6 }], include_labels:false }, KEY);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "danger");
  assert.equal(body.ingredients[0].mg_per_day, 3900);
});

test("rejects values that would silently skip safety checks", async () => {
  const bad = [
    { patient:{ ...patient, age:"six" }, medicines:[] },
    { patient:{ weight_kg:60 }, medicines:[] },                                          // age missing
    { patient:{ ...patient, conditions:["liver disease"] }, medicines:[] },
    { patient:{ ...patient, conditions:"liver" }, medicines:[] },
    { patient, medicines:[{ name:"Calpol 650", doses_per_day:"four" }] },
    { patient, medicines:[{ name:"X", ingredients:[{ name:"paracetamol", mg:"650mg" }], doses_per_day:6 }] },
    { patient, medicines:{ name:"Calpol 650" } },
    { patient, prescription_text:42 },
  ];
  for(const b of bad) assert.equal((await post(api.url, "/v1/check", b, KEY)).status, 400, JSON.stringify(b));
  assert.equal((await post(api.url, "/v1/check", "{oops", KEY)).status, 400);
});

test("rejects oversized requests with 413 and keeps serving", async () => {
  assert.equal((await post(api.url, "/v1/check", "a".repeat(15_100_000), KEY)).status, 413);
  assert.equal((await fetch(api.url + "/v1/config")).status, 200);
});

test("never serves secrets or server code", async () => {
  for(const p of ["/.env", "/.env.example", "/server.js", "/..%2f..%2fetc/passwd"]) assert.equal((await fetch(api.url + p)).status, 404, p);
});

test("server AI only answers its own page, and is rate-limited", async () => {
  assert.equal((await post(ai.url, "/v1/ai/parse", { text:"x" })).status, 403);                     // no Origin (curl, scripts)
  assert.equal((await post(ai.url, "/v1/ai/parse", { text:"x" }, { origin:"null" })).status, 403);
  assert.equal((await post(ai.url, "/v1/ai/parse", { text:"x" }, { origin:"https://evil.example" })).status, 403);
  const own = { origin:ai.url };
  assert.equal((await post(ai.url, "/v1/ai/review", { report:{} }, own)).status, 400); // 1st call: allowed, invalid report
  assert.equal((await post(ai.url, "/v1/ai/review", { report:{} }, own)).status, 429); // 2nd call: over the limit of 1
});
