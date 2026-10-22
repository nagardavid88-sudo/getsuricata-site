#!/usr/bin/env node
// check-sync · the site describes the app as it is today, and nothing more.
//
// Reads, from the app (read only):
//   src/constants/features.js          the feature flags
//   src/components/DataSourcesCard.jsx "מאיפה הנתונים" (ROWS and the intro)
//   src/data/academyContent.json       the academy tracks and lessons
// and fails (exit 1) when:
//   1. the site mentions a capability whose flag is off;
//   2. the site's sources table differs from ROWS, row by row;
//   3. the site's academy tracks or lesson counts differ from the app's;
//   4. a flag is off and this script has no terms for it yet · a new flag
//      must be mapped here, never passed over in silence.
//
// Usage:  node scripts/check-sync.mjs [path-to-smartinvest]
//         (default: $SMARTINVEST, else ~/smartinvest)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.resolve(process.argv[2] || process.env.SMARTINVEST || path.join(os.homedir(), "smartinvest"));
const read = p => fs.readFileSync(path.join(APP, p), "utf8");

const problems = [];
const fail = msg => problems.push(msg);

// ── the app ─────────────────────────────────────────────────────────────────
const flags = Object.fromEntries(
  [...read("src/constants/features.js").matchAll(/export const (\w+)\s*=\s*(true|false)\s*;/g)].map(m => [m[1], m[2] === "true"]));
if (!Object.keys(flags).length) fail("features.js: no flags found · has the format changed?");

const card = read("src/components/DataSourcesCard.jsx");
const rowsSrc = card.slice(card.indexOf("const ROWS = ["), card.indexOf("];", card.indexOf("const ROWS = [")));
const unq = s => s.replace(/\\"/g, '"');
const appRows = [...rowsSrc.matchAll(/kind:\s*"((?:[^"\\]|\\.)*)",\s*provider:\s*"((?:[^"\\]|\\.)*)",\s*freq:\s*"((?:[^"\\]|\\.)*)"/g)]
  .map(m => [unq(m[1]), unq(m[2]), unq(m[3])]);
if (appRows.length !== (rowsSrc.match(/kind:/g) || []).length) fail("DataSourcesCard.jsx: a row could not be parsed · has the format changed?");
const appIntro = (card.match(/he:\s*\{\s*title:\s*"מאיפה הנתונים",\s*intro:\s*"([^"]+)"/) || [])[1];

const academy = JSON.parse(read("src/data/academyContent.json"));
const hiddenLessons = new Set(flags.LESSON_6_2_ENABLED === false ? ["6.2"] : []);
const appTracks = academy.tracks.map(t => [String(t.n), t.title, t.lessons.filter(l => !hiddenLessons.has(l.id)).length]);

// ── the site ────────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const decode = s => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = s => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// What describes the app: the whole page, less the code, the site's own
// calculators page (a site tool, not an app claim) and the legal paragraph
// (legal text is David's, and it covers the site's tools too).
function cutBlock(src, startRe, endMarker) {
  const m = src.match(startRe);
  if (!m) return src;
  const i = m.index, j = src.indexOf(endMarker, i + m[0].length);
  return src.slice(0, i) + src.slice(j < 0 ? src.length : j);
}
let body = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
body = cutBlock(body, /<div class="page" id="pg-calculators">/, '<div class="page" id="pg-faq">');
body = cutBlock(body, /<div class="legal">/, "</footer>");
const plain = text(body);

// ── 1 + 4 · flags that are off, and what the site must not say ─────────────
// Each term is a regex over the plain text. Keep them narrow: a word that is
// also ordinary Hebrew belongs in a phrase, not alone.
const TERMS = {
  INVESTOR_PROFILE_ENABLED: [/שאלון/, /הפרופיל שלי/, /פרופיל משקיע/, /שמרן|אגרסיבי/, /סדר התצוגה/],
  CALCULATORS_ENABLED: [/מסך "?מחשבונים"?/, /מחשבונ\S*[^.]{0,60}(?:באפליקציה|בתוך האפליקציה)/, /(?:באפליקציה|בתוך האפליקציה)[^.]{0,60}מחשבונ/],
  FINNHUB_VALUATION_ENABLED: [/מכפיל/, /P\/E/, /\bEPS\b/, /תשואת (?:ה)?דיבידנד/, /קונסנזוס/, /אנליסט/, /שווי שוק/, /\bBeta\b/i, /דיבידנד (?:שנתי )?משוער/],
  LESSON_6_2_ENABLED: [/מידע, שיווק וייעוץ/],
  ACADEMY_ENABLED: [/אקדמי/],
  PRICE_ALERTS_ENABLED: [/התראו?ת מחיר/],
};
for (const [flag, on] of Object.entries(flags)) {
  if (on) continue;
  const terms = TERMS[flag];
  if (!terms) { fail(`${flag} is off and check-sync has no terms for it · add them to TERMS`); continue; }
  for (const re of terms) {
    const m = plain.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    if (m) {
      const at = plain.search(re);
      fail(`${flag} is off, and the site says "${m[0]}" · …${plain.slice(Math.max(0, at - 50), at + 60)}…`);
    }
  }
}
// Removed providers stay removed: any provider the site's table names must be in ROWS (checked below),
// and Google Translate in particular left the app on 28/09/2026.
if (/Google Translate/.test(plain) && !appRows.some(r => r[1] === "Google Translate")) fail('the site mentions "Google Translate", which is not a source in the app');

// ── 2 · the sources table ───────────────────────────────────────────────────
const tblStart = html.indexOf("data-sources>");
if (tblStart < 0) fail("index.html: no [data-sources] table");
else {
  const tbl = html.slice(tblStart, html.indexOf("\n      </div>", tblStart));
  const siteRows = [...tbl.matchAll(/<div class="src-row"><span class="sk">([\s\S]*?)<\/span><span class="sp[^"]*">([\s\S]*?)<\/span><span class="sf">([\s\S]*?)<\/span><\/div>/g)]
    .map(m => [text(m[1]), text(m[2]), text(m[3])]);
  const n = Math.max(siteRows.length, appRows.length);
  for (let i = 0; i < n; i++) {
    const a = appRows[i], s = siteRows[i];
    if (!a) fail(`sources row ${i + 1}: on the site, not in the app · ${s.join(" | ")}`);
    else if (!s) fail(`sources row ${i + 1}: in the app, missing on the site · ${a.join(" | ")}`);
    else if (a.join("|") !== s.join("|")) fail(`sources row ${i + 1} differs\n      app:  ${a.join(" | ")}\n      site: ${s.join(" | ")}`);
  }
  if (appIntro && !plain.includes(appIntro)) fail(`the intro above the table is not the card's: "${appIntro}"`);
}

// ── 3 · the academy ─────────────────────────────────────────────────────────
const acStart = html.indexOf("data-academy");
if (flags.ACADEMY_ENABLED !== false) {
  if (acStart < 0) fail("index.html: no [data-academy] list");
  else {
    const list = html.slice(acStart, html.indexOf("</ol>", acStart));
    const siteTracks = [...list.matchAll(/<span class="tn[^"]*">(\d+)<\/span><span class="tt">([\s\S]*?)<\/span><span class="tc"><span class="ltr-num">(\d+)<\/span>/g)]
      .map(m => [m[1], text(m[2]), Number(m[3])]);
    if (JSON.stringify(siteTracks) !== JSON.stringify(appTracks))
      fail(`academy differs\n      app:  ${appTracks.map(t => t.join(" ")).join(" · ")}\n      site: ${siteTracks.map(t => t.join(" ")).join(" · ")}`);
    const total = appTracks.reduce((a, t) => a + t[2], 0);
    const declared = Number((list.match(/data-total="(\d+)"/) || [])[1]);
    if (declared !== total) fail(`academy total: the site says ${declared}, the app has ${total}`);
    for (const m of plain.matchAll(/(\d+) שיעורים/g)) if (Number(m[1]) !== total && !appTracks.some(t => t[2] === Number(m[1])))
      fail(`"${m[0]}" on the site · the app has ${total} lessons`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const off = Object.entries(flags).filter(([, v]) => !v).map(([k]) => k);
console.log(`check-sync · app: ${APP}`);
console.log(`  flags off: ${off.join(", ") || "none"}`);
console.log(`  sources: ${appRows.length} rows in the app · academy: ${appTracks.length} tracks, ${appTracks.reduce((a, t) => a + t[2], 0)} lessons`);
if (problems.length) {
  console.error(`\n✗ ${problems.length} problem${problems.length > 1 ? "s" : ""}:`);
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}
console.log("\n✓ the site matches the app");
