// Offline tests for the checking engine: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BrandDB, parseLine, createEngine } from "../engine.js";

const brands = new BrandDB();
brands.addCSV(fs.readFileSync(new URL("../data/brands-in.csv", import.meta.url), "utf8"));
const offline = async () => ({ ok:false, status:503, statusText:"offline" });
const engine = createEngine({ brands, fetchImpl: offline });
const find = line => { const p = parseLine(line); return brands.find(p.query) || brands.find(p.bare); };
const med = (raw, ings, perDay = 1, extra = {}) => ({ raw, units:1, perDay, ings, ...extra });
const check = (meds, P) => engine.analyze(meds, { conds:{}, ...P }, { labels:false });

test("hyphenated brands match without the hyphen", () => {
  assert.deepEqual(find("Zerodol P BD").ings.map(i => i.name).sort(), ["aceclofenac", "acetaminophen"]);
  assert.deepEqual(find("Pan D OD").ings.map(i => i.name).sort(), ["domperidone", "pantoprazole"]);
});

test("brand without strength leaves mg blank instead of guessing", () => {
  const b = find("Dolo 1-0-1");
  assert.equal(b.ings[0].mg, null);
  assert.deepEqual(b.ings[0].choices, [500, 650]);
  assert.equal(find("Pan"), null); // Pan 40 vs Pan-D: different ingredients, don't pick one
});

test("doctor shorthand", () => {
  assert.equal(parseLine("Dolo 650 1-0-1").perDay, 2);
  assert.equal(parseLine("Dolo 650 1-0-½").perDay, 1.5);
  assert.equal(parseLine("Combiflam TDS").perDay, 3);
  assert.equal(parseLine("Dolo 650 ½ tab BD").units, 0.5);
  assert.equal(parseLine("Dolo 650 12-10-2026").guessedFreq, true); // a date is not a dose pattern
});

test("paracetamol over the limit across brands is danger", async () => {
  const r = await check([
    med("Dolo 650 1-0-1", [{name:"acetaminophen", mg:650}], 2),
    med("Combiflam TDS", [{name:"ibuprofen", mg:400}, {name:"acetaminophen", mg:325}], 3),
    med("Zerodol-P BD", [{name:"aceclofenac", mg:100}, {name:"acetaminophen", mg:325}], 2),
  ], { conds:{alcohol:true} });
  assert.equal(r.status, "danger");
  assert.ok(r.alerts.some(a => a.code === "over_limit" && a.ingredients[0] === "acetaminophen"));
});

test("child without weight gets no adult limit and is incomplete", async () => {
  const r = await check([med("Calpol 650", [{name:"acetaminophen", mg:650}], 4)], { age:6 });
  assert.equal(r.ingredients[0].reference_max_mg_per_day, null);
  assert.equal(r.status, "incomplete");
});

test("penicillin allergy catches amoxicillin", async () => {
  const r = await check([med("Augmentin 625", [{name:"amoxicillin", mg:500}, {name:"clavulanate", mg:125}], 2)], { allergies:"penicillin" });
  assert.equal(r.status, "danger");
});

test("missing data is never ok", async () => {
  const cases = [
    [med("Unknown syrup", [{name:"acetaminophen", mg:null}], 4)],
    [med("Xyzbrand 500", [])],
    [med("Dolo 650", [{name:"acetaminophen", mg:650}], 1, {guessedFreq:true})],
  ];
  for(const meds of cases) assert.equal((await check(meds)).status, "incomplete", meds[0].raw);
});

test("values that aren't positive numbers are never counted as 1", async () => {
  const cases = [
    [med("Calpol 650", [{name:"acetaminophen", mg:650}], "four")],
    [med("Calpol 650", [{name:"acetaminophen", mg:650}], 0)],
    [med("X", [{name:"acetaminophen", mg:"650mg"}], 6)],
    [med("Calpol 650", [{name:"acetaminophen", mg:650}], 4, {units:NaN})],
  ];
  for(const meds of cases) assert.equal((await check(meds)).status, "incomplete", JSON.stringify(meds));
  const r = await check([med("X", [{name:"acetaminophen", mg:"650"}], 6)], { conds:{liver:true} }); // numeric string is fine
  assert.equal(r.status, "danger");
});

test("clinical review: low-dose aspirin, statins in pregnancy, child doses, note lines", async () => {
  const aspirin75 = med("Ecosprin 75", [{name:"aspirin", mg:75}], 1);
  for(const c of ["heart", "kidney", "pregnant"]) assert.equal((await check([aspirin75], { conds:{[c]:true} })).status, "ok", c); // cardioprotective dose
  assert.equal((await check([med("Disprin", [{name:"aspirin", mg:350}], 3)], { conds:{kidney:true} })).status, "warning"); // anti-inflammatory dose
  assert.equal((await check([aspirin75], { conds:{thinners:true} })).status, "warning"); // bleeding risk at any dose
  assert.equal((await check([med("Atorva 10", [{name:"atorvastatin", mg:10}], 1)], { sex:"female", conds:{pregnant:true} })).status, "warning");
  assert.equal((await check([med("Cetzine", [{name:"cetirizine", mg:10}], 1)], { age:5, weight:18 })).status, "warning");
  const notes = [med("Dr. R. Sharma MBBS", []), med("Brufen 400 TDS", [{name:"ibuprofen", mg:400}], 3), med("Review after 5 days", [])];
  assert.equal((await check(notes)).status, "ok");
  assert.equal((await check([med("Xylofen 200 BD", [])])).status, "incomplete"); // an unknown medicine still is
});

test("offline drug-group lookup is reported, built-in groups still work", async () => {
  const r = await check([med("Combiflam", [{name:"ibuprofen", mg:400}], 3), med("Zerodol", [{name:"aceclofenac", mg:100}], 2)]);
  assert.equal(r.class_check_partial, true);
  assert.ok(r.alerts.some(a => a.code === "same_class"));
});
