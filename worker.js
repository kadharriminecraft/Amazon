/* =====================================================================
   AMAZON RELAY - Cloudflare Worker (single file)
   ---------------------------------------------------------------------
   Paste this entire file into a Cloudflare Worker and deploy it.

   What it does:
     Turns Amazon's server-rendered pages into a small JSON API and
     proxies product images, so a single local HTML file can browse
     amazon.com without iframes and WITHOUT the phone ever contacting
     Amazon directly. The phone only ever talks to this worker.

   Endpoints (all GET, CORS: *):
     /health                                -> { ok: true, profile }
                                            profile = "full" or "filtered"
     /api/search?q=...&i=INDEX              -> FIRST PAGE of results only, in
                                              JSON (the worker never digs
                                              deeper pages anymore). In
                                              Normal Mode the request is
                                              denied outright ({ blocked:
                                              true, results: [] }) when the
                                              query matches the filter OR
                                              when most of page 1 gets
                                              filtered away (see
                                              SEARCH_DENY_RATIO below)
     /api/product/ASIN                      -> product details (JSON: gallery,
                                              bullets, description, detail
                                              table, A+ manufacturer content,
                                              related items; in Safe Mode an
                                              unsuitable item answers
                                              { blocked: true })
     /api/browse?type=bestsellers|new|movers&cat=SLUG   -> charts (JSON)
     /img?u=<encoded amazon image URL>      -> image bytes

   Filter monitor & key manager (for you, the owner):
     GET  /admin/stats          -> JSON log of everything the filter caught
                                   (blocked searches, products removed from
                                   results and charts, refused product
                                   pages - each with the reason and the
                                   access key that was used) PLUS every
                                   clean search too: each search event says
                                   who ran it and how it ended (shown /
                                   blocked / denied / flagged)
     POST /admin/stats/reset    -> clear the whole log
     POST /admin/events/delete  -> remove ONE entry    {id}
     GET  /admin/keys           -> the live access-key list
     POST /admin/keys           -> add or edit a key  {id?, key, label, profile}
     POST /admin/keys/delete    -> revoke a key      {id}
     All need the admin password (ADMIN_PASSWORD below) as the header
     "x-admin-key" (or ?adminKey=). Pair this with amazon-admin.html - a
     single-file dashboard that asks for the password, shows the log
     (with per-person filtering and an X button on every entry),
     and has a Keys tab where you add, rename, re-mode or revoke access
     keys. profile "filtered" = Normal mode (the filter is enforced),
     "full" = Unrestricted. In Unrestricted mode nothing is hidden - but
     anything the filter WOULD have caught is still logged, flagged as
     "shown", so you can see who searched what either way.
     Storage: in worker memory by default (kept while the worker stays
     warm; cleared by a redeploy or an idle restart - if the dashboard
     "sometimes forgets" the log, that is why). For permanent storage,
     create a KV namespace in the Cloudflare dashboard and bind it to
     this worker under the name FILTER_STATS - the binding is detected
     automatically and the log AND the key list survive restarts.
     (Bind KV before managing keys; without it, key edits stick only to
     the isolate that saved them.)

   Access control - TWO profiles, NO preset keys:
     There are NO built-in access keys anymore. Keys are created in the
     Filter Monitor's Keys tab (see above) and live in the FILTER_STATS
     KV namespace - until you add one there, every request is rejected
     with 401. Bind the KV namespace BEFORE handing out keys; without
     it, key edits stick only to the worker instance that saved them.
     profile "filtered" = Normal mode. Searches, results,
                             charts and product pages containing adult
                             or sexual content are blocked here in the
                             worker -
                             the app cannot bypass it. The word list is
                             BLOCKED_TERMS further down; edit freely.
                             Generic words (underwear, pajamas, swimsuit,
                             ...) are NOT blocked: searching "underwear"
                             still works, men's and kids' items show, and
                             women's items are discarded because their
                             titles say "Women's" / "Ladies" / "Girls".
                             Misspellings do NOT slip through: queries and
                             text are additionally matched against a
                             one-edit typo guard (see "typo guard" below).
     Requests must carry a key as the header "x-access-key"
     (or ?key=<key>). The static ACCESS_KEYS map below stays empty -
     it only exists so the code keeps compiling if you ever hand-edit
     a copy; the live KV list always wins.

   Cache wipe (for clean Safe Mode testing):
     GET /api/cache-wipe  -> drops every cached product page, search
     and chart at the edge, so the next request fetches fresh from
     Amazon. The app calls this automatically whenever the access
     key changes, so switching between profiles never shows stale
     results from the other profile. Needs any valid access key.

   Notes:
     - Amazon throttles datacenter IPs with bot-check pages: a 503
       captcha page, or a ~2 KB Akamai challenge shell (bm-verify) that
       returns HTTP 200 and contains no products. The worker detects
       both, retries up to five times with browser-profile rotation,
       session cookies and a homepage warm-up between attempts, and
       only then returns { "error": "blocked" } - the app shows a
       Retry button. A page that cannot be read NEVER comes back as
       an empty "no results" answer.
     - Responses are cached at the Cloudflare edge (search 10 min,
       product 1 h, charts 15 min) to make repeat browsing instant and
       to reduce the chance of hitting the bot check. The edge cache
       holds the RAW extraction and Safe Mode filtering re-runs on
       every request, and all client responses are marked no-store,
       so switching access keys always shows the right items.
===================================================================== */

const AMAZON = 'https://www.amazon.com';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* Access keys are managed LIVE from the Filter Monitor's Keys tab -
 * there are NO preset keys in this file anymore. Every key has to be
 * added in the monitor; until then the gate rejects everything.
 * Keys are matched EXACTLY (after trimming spaces), capitals included. */
const ACCESS_KEYS = {};

/* Password for the /admin/stats filter monitor (used by amazon-admin.html).
 * CHANGE THIS to your own secret. The monitor answers only to this
 * password, separate from the access keys above. Empty string ''
 * disables the monitor endpoints entirely. */
const ADMIN_PASSWORD = 'letmein';

const FETCH_TIMEOUT_MS = 20000;

const TTL = { search: 600, product: 3600, browse: 900 }; // seconds

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

const BLOCK_MARKERS = [
  'api-services-support@amazon.com',
  '/errors/validate_captcha',
  'To discuss automated access',
];

/* Akamai interstitial challenge shell (HTTP 200/202, ~2 KB, no products).
 * If this slips through, searches silently return zero results. */
const SHELL_MARKERS = ['bm-verify', '/_sec/verify', 'triggerInterstitial'];

/* Amazon's genuine "we found nothing" wording. A zero-tile page WITHOUT
 * any of these phrases was not a real search answer - it was a wall. */
const EMPTY_SEARCH_RE = /did not match any products|no results (?:were found )?for/i;

const BROWSE_TYPES = {
  bestsellers: 'bestsellers',
  new: 'new-releases',
  movers: 'movers-and-shakers',
};

class BlockedError extends Error {}
class NotFoundError extends Error {}

/* ================================================================== */
/* Access profiles                                                     */
/* ================================================================== */

function getAccessProfile(key) {
  /* the static map is empty by design (no preset keys): everything is
   * denied here and only the LIVE list from the Keys tab grants access */
  const k = String(key == null ? '' : key).trim();
  if (!Object.prototype.hasOwnProperty.call(ACCESS_KEYS, k)) return null;
  return ACCESS_KEYS[k] === 'filtered' ? 'filtered' : 'full';
}

/* ================================================================== */
/* Live access keys (managed from the Filter Monitor's Keys tab)       */
/*                                                                     */
/* The editable list lives in the FILTER_STATS KV namespace under      */
/* 'access-keys-v1' as [{id, key, label, profile, createdAt}]. The      */
/* static map is EMPTY on purpose (preset keys were removed), so the    */
/* saved list is the only authority: add keys in the monitor's Keys     */
/* tab and they work immediately; revoke them and access stops.         */
/*                                                                     */
/* HOW THE LIST STAYS SAFE (the "keys randomly disappear" fix):        */
/*  - the per-isolate cache re-reads KV every KEYS_TTL_MS instead of   */
/*    once forever, and admin routes + every mutation force a fresh    */
/*    read, so a booted-before-the-save isolate can never answer (or   */
/*    write!) an empty list over keys that exist;                      */
/*  - mutations always start from that fresh read (never the static    */
/*    fallback) and the write is awaited, so adding a key can no       */
/*    longer wipe the others;                                          */
/*  - revokes leave id tombstones ('keys-deleted-v1'), so a slower     */
/*    isolate cannot write a revoked key back;                         */
/*  - an emptied list is SAVED as [] (not deleted), so "locked         */
/*    everyone out on purpose" is never confused with "never           */
/*    saved" and the static map never comes back.                      */
/* Without a KV binding the list lives in worker memory only (see the   */
/* monitor's storage note) - bind FILTER_STATS before handing out keys. */
/* ================================================================== */

const KEYS_KV_KEY = 'access-keys-v1';
/* ids of revoked keys: a slower isolate that still holds an old copy of
 * the list must never write a revoked key back (same tombstone idea the
 * event log uses for its per-entry deletes) */
const KEYS_DELETED_KV_KEY = 'keys-deleted-v1';
const MAX_KEY_TOMBSTONES = 2000;
/* how long an isolate may serve its cached copy of the key list before
 * it re-reads KV. Revoking a key therefore takes hold everywhere within
 * this window (plus KV's own cross-datacenter propagation). Admin
 * routes always force a fresh read and never use the cache. */
const KEYS_TTL_MS = 15000;

let dynKeys = null; /* the SAVED list (array; [] = deliberately empty) */
let dynKeysSaved = false; /* true once a list exists (KV read or a save) */
let dynKeysAt = 0; /* when the cache above was filled */
let dynKeysPromise = null; /* in-flight (re)load */
let keysDeletedIds = new Set(); /* revoked key ids - the tombstones */

function seedKeysFromStatic() {
  return Object.keys(ACCESS_KEYS).map((k) => ({
    id: 'static:' + k,
    key: k,
    label: k,
    profile: ACCESS_KEYS[k] === 'filtered' ? 'filtered' : 'full',
    createdAt: 0,
  }));
}

function normalizeKeyList(arr) {
  const seen = new Set();
  const out = [];
  for (const e of arr || []) {
    if (!e || typeof e.key !== 'string') continue;
    const key = e.key.trim();
    if (!key || key.length > 64 || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: String(e.id || 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)),
      key,
      label: String(e.label || key).slice(0, 40),
      profile: e.profile === 'filtered' ? 'filtered' : 'full',
      createdAt: e.createdAt || 0,
      updatedAt: e.updatedAt || e.createdAt || 0,
    });
  }
  /* stable order: oldest first, same as the monitor displays them */
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return out;
}

/* raw KV read of the saved list + the revoke tombstones. Never throws:
 * { kv:false } = no binding at all; { kv:true, list:null } = reachable
 * but nothing saved (or the read failed - keep the previous cache then) */
async function readKeysFromKV(env) {
  if (!(env && env.FILTER_STATS && typeof env.FILTER_STATS.get === 'function')) {
    return { kv: false };
  }
  try {
    const raw = await env.FILTER_STATS.get(KEYS_KV_KEY);
    const delRaw = await env.FILTER_STATS.get(KEYS_DELETED_KV_KEY);
    if (delRaw) {
      try {
        const d = JSON.parse(delRaw);
        if (Array.isArray(d)) {
          for (const id of d) keysDeletedIds.add(String(id));
          if (keysDeletedIds.size > MAX_KEY_TOMBSTONES) {
            keysDeletedIds = new Set(Array.from(keysDeletedIds).sort().slice(-MAX_KEY_TOMBSTONES));
          }
        }
      } catch (e) {}
    }
    if (raw == null) return { kv: true, list: null };
    let arr = null;
    try {
      arr = JSON.parse(raw);
    } catch (e) {}
    return { kv: true, list: Array.isArray(arr) ? arr : [] };
  } catch (e) {
    return { kv: true, list: null, err: true };
  }
}

/* Fill the isolate's cache from KV. `force` bypasses the TTL (admin
 * routes and every mutation use it, so the monitor always sees the
 * truth and saves always start from the freshest list). A failed re-read
 * keeps the previous cache instead of falling back to the empty static
 * map - that fallback was why keys used to "randomly disappear". */
function loadDynKeys(env, force) {
  if (dynKeysPromise && !force && Date.now() - dynKeysAt < KEYS_TTL_MS) return dynKeysPromise;
  const p = (async () => {
    const r = await readKeysFromKV(env);
    if (r.list != null) {
      /* a saved list is authoritative - even when it is empty */
      dynKeys = normalizeKeyList(r.list).filter((k) => !keysDeletedIds.has(k.id));
      dynKeysSaved = true;
    } else if (!r.err && !dynKeysSaved) {
      /* KV reachable and truly nothing saved yet, and this isolate has
       * never saved anything either: the static map still rules */
      dynKeys = null;
    }
    /* r.err (transient read failure) or already-saved: keep the cache */
    dynKeysAt = Date.now();
  })();
  dynKeysPromise = p;
  return p;
}

/* the list that rules right now: the SAVED list once one exists (even
 * an empty one - the static map never comes back after the first save),
 * otherwise the static seed (read-only legacy) */
async function effectiveKeys(env, force) {
  await loadDynKeys(env, force);
  if (dynKeysSaved) return dynKeys;
  return seedKeysFromStatic();
}

/* the list a mutation starts from: NEVER the static fallback, so the
 * first add cannot resurrect preset keys, and always freshly read */
async function savedKeyList(env) {
  await loadDynKeys(env, true);
  return dynKeysSaved ? dynKeys.slice() : [];
}

/* write a mutated list: tombstones first (a revoke can never be undone
 * by a slower isolate), then the list itself - always stored, even when
 * empty, so "saved empty" stays distinct from "never saved". The write
 * is awaited: when the admin page hears "ok" the change is durable. */
async function commitKeyList(env, ctx, list, removedId) {
  if (removedId) keysDeletedIds.add(String(removedId));
  if (keysDeletedIds.size > MAX_KEY_TOMBSTONES) {
    keysDeletedIds = new Set(Array.from(keysDeletedIds).sort().slice(-MAX_KEY_TOMBSTONES));
  }
  const norm = normalizeKeyList(list).filter((k) => !keysDeletedIds.has(k.id));
  dynKeys = norm;
  dynKeysSaved = true;
  dynKeysAt = Date.now();
  try {
    if (env && env.FILTER_STATS && typeof env.FILTER_STATS.put === 'function') {
      await env.FILTER_STATS.put(KEYS_DELETED_KV_KEY, JSON.stringify(Array.from(keysDeletedIds))).catch(() => {});
      await env.FILTER_STATS.put(KEYS_KV_KEY, JSON.stringify(norm)).catch(() => {});
    }
  } catch (e) {}
  return norm;
}

/* Access check for real requests: the live list when one exists, the
 * static map otherwise. Returns { profile, key } or null (401). The
 * returned key string rides along into the filter log so the monitor
 * can show WHO searched what. Uses the TTL cache - phone traffic never
 * pays a KV read per request. */
async function resolveAccess(keyStr, env) {
  await loadDynKeys(env);
  const k = String(keyStr == null ? '' : keyStr).trim();
  const list = dynKeysSaved ? dynKeys : seedKeysFromStatic();
  const e = list.find((x) => x.key === k);
  if (!e) return null;
  return { profile: e.profile === 'filtered' ? 'filtered' : 'full', key: e.key };
}

/* ================================================================== */
/* Safe Mode content filter                                            */
/*                                                                     */
/* Active for requests whose key maps to the 'filtered' profile.       */
/* Matching is:                                                        */
/*   - whole words, plurals included via light stemming                */
/*       ("bra" catches "bras" but NOT "bracelet" / "library")          */
/*   - multi-word phrases ("g string", "mini skirt")                    */
/*   - prefixes, written with a trailing * ("porn*" -> porno, ...)      */
/*                                                                     */
/* The list intentionally OVER-blocks - "no way to see anything         */
/* whatsoever inappropriate" was the brief. That means "adult" also     */
/* hides adult coloring books, "girl" hides girls' toys, "butt" hides   */
/* diaper cream, "teen" hides teen novels. Every entry is one line in   */
/* the array: delete anything you decide is harmless.                  */
/*                                                                     */
/* EXCEPTION (user-requested): generic garment words - underwear,       */
/* briefs, pajamas, nightgown, swimsuit, swim trunks, sleepwear,        */
/* loungewear - are deliberately NOT listed. Searching "underwear"      */
/* still works: men's and kids' items show, while the women's items     */
/* in those results are discarded anyway because their titles carry    */
/* the gendered words (women's, ladies, girls, ...). Only styles that   */
/* are inherently women's-and-intimate (bra, bikini, lingerie,         */
/* thong, ...) are listed directly.                                    */
/* ================================================================== */

const BLOCKED_TERMS = [
  'adult', 'ahegao', 'anal', 'anus', 'areola', 'arse', 'ass', 'bdsm', 'bimbo',
  'bodystocking', 'bondage', 'boob', 'boobies', 'boobs', 'booty', 'boudoir', 'burlesque',
  'cialis', 'cleavage', 'cock', 'condom', 'crotch', 'crotchless', 'cupless',
  'dildo', 'dominatrix', 'ecchi', 'erotic*', 'fetish', 'fleshlight', 'genital',
  'handcuff', 'hant*', 'hardcore', 'hena*', 'hent*', 'horny', 'hustler', 'kegel', 'kink',
  'kinky', 'lap dance', 'libido', 'love doll', 'lovedoll', 'lube', 'lubricant',
  'masturb*', 'milf', 'naughty', 'naked', 'nipple', 'nsfw', 'nude', 'nudes',
  'onlyfans', 'onahole', 'orgasm', 'penis', 'penthouse', 'playboy', 'porn*',
  'prostitut*', 'racy', 'risque', 'seductive', 'sensual', 'sex', 'sexual',
  'sexy', 'sexting', 'sextoy', 'sextoys', 'slut', 'smut', 'striptease',
  'stroker', 'submissive', 'threesome', 'tit', 'tits', 'titty', 'topless',
  'twerk', 'vagina', 'vibrator', 'viagra', 'whore', 'xrated', 'xxx', 'yaoi',
  'yuri',

  /* expanded set ("skirt and much more"): more adult/sexual terms.
   * Deliberately-misspelled-safe notes: 'creampie' is one word (the
   * two-word "cream pie" dessert is a different spelling), 'doggy'
   * alone stays allowed (pet toys), 'exotic' alone stays allowed
   * (skincare, cars), 'pussy'/'dick'/'twat' are exact-word matches so
   * Dickies work pants and 'dickens' are untouched. */
  'aphrodisiac', 'aroused', 'barely legal', 'blow job', 'blowjob',
  'bukkake', 'busty', 'call girl', 'camel toe', 'cameltoe', 'climax',
  'clit', 'clitoral', 'creampie', 'cuckold', 'cunnilingus', 'curvy',
  'dick', 'doggy style', 'domme', 'downblouse', 'exotic dancer',
  'fellatio', 'gang bang', 'gangbang', 'hand job', 'handjob', 'hooters',
  'hotwife', 'jailbait', 'jav', 'labia', 'lewd', 'nudity', 'open bust',
  'open cup', 'orgy', 'pocket pussy', 'provocative', 'pussy',
  'reverse cowgirl', 'rimjob', 'rule 34', 'schlong', 'seduce', 'spank',
  'spanking', 'thicc', 'twat', 'uncensored', 'upskirt', 'voluptuous',
  'vulva', 'yiff',

  'bakini', 'bandeau', 'bikini', 'bra', 'bralette', 'brassiere', 'bustier',
  'cami', 'camisole', 'chemise', 'corset', 'fishnet', 'g string', 'garter',
  'gstring', 'hosiery', 'intimate', 'intimates', 'jegging', 'knicker',
  'lingerie', 'microkini', 'monokini', 'negligee', 'panties', 'panty',
  'pantyhose', 'peignoir', 'shapewear', 'tanga', 'tankini', 'thigh high',
  'thighhigh', 'thong',

  /* expanded set: inherently women's / intimate garment words. "skirt"
   * was the explicit request - it also catches skirts / skater skirts
   * via the stemmer (bed skirts are accepted collateral). 'stocking'
   * stays OFF on purpose ("stocking stuffers" at Christmas); fishnet,
   * pantyhose and thigh high cover the intimate versions. */
  'backless', 'blouse', 'catsuit', 'culotte', 'frilly', 'girdle', 'lacy',
  'nightie', 'palazzo', 'skirt', 'skort', 'strapless',

  'babydoll',

  'bodycon', 'butt', 'butt lifter', 'butt lift', 'cheeky', 'crop top',
  'daisy duke', 'deep v', 'halter top', 'halterneck', 'hot pant', 'legging',
  'low cut', 'micro mini', 'micro skirt', 'mini skirt', 'off shoulder',
  'sarong', 'short short', 'stiletto', 'tube top', 'waist trainer',
  'yoga pant',

  /* expanded set: revealing / women's style words. "dress" alone stays
   * OFF (dress shirts, dress socks, dressing up) - the specific styles
   * are listed instead. */
  'athleisure', 'high heel', 'mini dress', 'minidress', 'one shoulder',
  'spaghetti strap', 'sun dress', 'sundress',

  'female', 'feminine', 'girl', 'girlie', 'girly', 'ladies', 'lady', 'missy',
  'teen', 'teenage', 'teens', 'woman', 'women',

  'ball gag', 'dance pole', 'flirty', 'pole dance', 'pole dancing',
  'school girl', 'see thru', 'see through', 'sideboob', 'stripper pole',
  'underboob',
];

/* Amazon search departments (the i= parameter) blocked in Safe Mode */
const BLOCKED_DEPTS = ['apparel', 'fashion', 'novelty', 'lingerie', 'intimates', 'sexual-wellness'];

function normText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stemWord(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/* --- typo guard ----------------------------------------------------
 * A plain word list is sidestepped by misspelling it ("leggingd" was
 * searched and results leaked through). Beyond exact matching, every
 * word (after leet-style normalization) is also matched when it is ONE
 * EDIT away from a blocked stem of length >= 7:
 *   - one letter inserted or deleted (any letter) -> match
 *   - two adjacent letters swapped             -> match
 *   - one letter substituted   -> match only when the two letters sit
 *     next to each other on a QWERTY keyboard (real typos; "legging"
 *     -> "kegging" yes, "legging" -> "logging" no)
 * Real words that happen to sit one edit away are exempted in
 * NEAR_EXEMPT below so innocent shopping keeps working; short blocked
 * words are excluded by the length rule: pants (not panty), things
 * (not thong), woven (not women), brand/bracelet (not bra).            */

const LEET_MAP = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's' };
function leetify(w) {
  return w.replace(/[0134578@$]/g, (c) => LEET_MAP[c] || c);
}
/* '1' doubles for both l and i in leetspeak ("l1nger1e" -> "lingerie"):
 * when a word contains a 1, both readings are tried */
function leetOne(w, one) {
  return w.replace(/[0134578@$]/g, (c) => (c === '1' ? one : LEET_MAP[c] || c));
}
function leetVariants(w) {
  if (w.indexOf('1') < 0) return [leetify(w)];
  const a = leetOne(w, 'l');
  const b = leetOne(w, 'i');
  return a === b ? [a] : [a, b];
}

/* QWERTY neighbor pairs (both orders precomputed below) */
const QWERTY_ADJ_SRC = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj', i: 'uojk',
  o: 'ipkl', p: 'ol', a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv',
  h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop', z: 'asx', x: 'zsdc', c: 'xdfv',
  v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
};
const QWERTY_ADJ = new Set();
for (const k of Object.keys(QWERTY_ADJ_SRC)) {
  for (const n of QWERTY_ADJ_SRC[k]) {
    QWERTY_ADJ.add(k + n);
    QWERTY_ADJ.add(n + k);
  }
}

/* is word a one-edit typo of cand? (both already stemmed+leeted) */
function nearWord(word, cand) {
  const lw = word.length;
  const lc = cand.length;
  if (Math.abs(lw - lc) > 1) return false;
  if (lw === lc) {
    const diffs = [];
    for (let i = 0; i < lw; i++) {
      if (word[i] !== cand[i]) diffs.push(i);
      if (diffs.length > 2) return false;
    }
    if (diffs.length === 1) {
      const i = diffs[0];
      return QWERTY_ADJ.has(word[i] + cand[i]);
    }
    if (diffs.length === 2) {
      const i = diffs[0];
      const j = diffs[1];
      return j === i + 1 && word[i] === cand[j] && word[j] === cand[i];
    }
    return false;
  }
  /* one insertion/deletion */
  const longer = lw > lc ? word : cand;
  const shorter = lw > lc ? cand : word;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < longer.length && j < shorter.length) {
    if (longer[i] === shorter[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    i++;
  }
  return true;
}

const SAFE_WORDS = new Set();
const SAFE_PHRASES = [];
const SAFE_PREFIXES = [];
const SAFE_JOINED = new Set(); /* multi-word terms with spaces removed */
const FUZZY_WORDS = []; /* blocked stems of length >= 7, for the typo guard */
const FUZZY_BY_LEN = new Map(); /* length -> [stems] (distance 1 needs +/-1) */
for (const term of BLOCKED_TERMS) {
  const raw = String(term).trim().toLowerCase();
  if (!raw) continue;
  if (raw.endsWith('*')) {
    const p = raw.slice(0, -1);
    if (/^[a-z]+$/.test(p)) SAFE_PREFIXES.push(p);
    continue;
  }
  const t = normText(raw);
  if (!t) continue;
  if (t.indexOf(' ') >= 0) {
    SAFE_PHRASES.push(t.split(' ').map(stemWord).join(' '));
    SAFE_JOINED.add(t.replace(/ /g, ''));
    continue;
  }
  const stem = stemWord(t);
  SAFE_WORDS.add(stem);
  if (stem.length >= 7 && /^[a-z]+$/.test(stem)) {
    FUZZY_WORDS.push(stem);
    if (!FUZZY_BY_LEN.has(stem.length)) FUZZY_BY_LEN.set(stem.length, []);
    FUZZY_BY_LEN.get(stem.length).push(stem);
    /* index the plural form too: "leggingsd" is one edit from
     * "leggings" but two from the stem "legging" */
    if (!/(s|x|z)$/.test(stem)) {
      const pl = stem + 's';
      if (!FUZZY_BY_LEN.has(pl.length)) FUZZY_BY_LEN.set(pl.length, []);
      FUZZY_BY_LEN.get(pl.length).push(pl);
    }
  }
}

/* Real words that happen to sit one edit from a blocked stem. They are
 * exempted from the typo guard so ordinary shopping keeps working; if
 * someone really is hunting that blocked term with this exact spelling,
 * the exact/prefix/phrase layers and the item-level filter still apply. */
const NEAR_EXEMPT = new Set([
  'logging', 'chemist', 'gaiter', 'gaiters', 'condor', 'cortex', 'hardware',
  'wedding', 'weddings', 'buster', 'vibrato', 'hustle', 'hardcode', 'kicker',
  'arouse', /* one deletion from 'aroused' - book titles say "arouse curiosity" */
]);

/* exact + fuzzy check of ONE already-normalized word */
function wordBlocked(w) {
  if (SAFE_WORDS.has(w)) return w;
  for (const lw of leetVariants(w)) {
    const sw = stemWord(lw);
    if (SAFE_WORDS.has(sw)) return sw;
    for (const p of SAFE_PREFIXES) {
      if (lw.startsWith(p)) return p;
      if (sw.startsWith(p)) return p;
    }
    /* typo guard: one edit away from a long blocked stem. Both the raw
     * and the stemmed form are compared ("pantyhos" stems to "pantyho",
     * which is two edits from "pantyhose" - the raw form is one). */
    if (NEAR_EXEMPT.has(sw) || NEAR_EXEMPT.has(lw)) continue;
    for (const cand of fuzzyCandidates(lw, sw)) {
      if (nearWord(lw, cand) || nearWord(sw, cand)) return cand;
    }
  }
  return null;
}

/* length-bucketed fuzzy candidates for a word (distance 1 -> +/-1) */
function fuzzyCandidates(lw, sw) {
  const seen = new Set();
  const out = [];
  for (const form of [lw, sw]) {
    for (let n = form.length - 1; n <= form.length + 1; n++) {
      const bucket = FUZZY_BY_LEN.get(n);
      if (!bucket) continue;
      for (const cand of bucket) {
        if (!seen.has(cand)) {
          seen.add(cand);
          out.push(cand);
        }
      }
    }
  }
  return out;
}

/* Returns the matched (stemmed) term, or null when the text is allowed. */
function findBlockedTerm(text) {
  const t = normText(text);
  if (!t) return null;
  const words = t.split(' ');
  const stemmed = [];
  for (const w of words) {
    const hit = wordBlocked(w);
    if (hit) return hit;
    stemmed.push(stemWord(w));
  }
  const flat = ' ' + stemmed.join(' ') + ' ';
  for (const ph of SAFE_PHRASES) {
    if (flat.indexOf(' ' + ph + ' ') >= 0) return ph;
  }
  /* leet-normalized phrase pass ("b1k1n1 t0p" style) */
  const flatLeet = ' ' + words.map((w) => stemWord(leetify(w))).join(' ') + ' ';
  if (flatLeet !== flat) {
    for (const ph of SAFE_PHRASES) {
      if (flatLeet.indexOf(' ' + ph + ' ') >= 0) return ph;
    }
  }
  return null;
}

/* Query-level check: everything findBlockedTerm does, plus a
 * collapsed pass that joins the words back together, so a blocked
 * word typed with a space in it ("leg gings", "bik ini") still hits. */
function queryBlockedTerm(q) {
  const direct = findBlockedTerm(q);
  if (direct) return direct;
  const words = normText(q).split(' ');
  if (words.length > 1) {
    const joined = words.join('');
    if (joined.length >= 4) {
      const hit = wordBlocked(joined);
      if (hit) return hit;
      const j = leetify(joined);
      if (SAFE_JOINED.has(j) || SAFE_JOINED.has(stemWord(j))) return j;
    }
    const leet = leetify(joined);
    if (leet !== joined) {
      const hit2 = wordBlocked(leet);
      if (hit2) return hit2;
    }
  }
  return null;
}

/* the matched (stemmed) term, or null when the tile is allowed */
function tileBlockedTerm(t) {
  return t && t.title ? findBlockedTerm(t.title) : null;
}
function tileBlocked(t) {
  return !!tileBlockedTerm(t);
}

function productBlockedTerm(p) {
  const text = [
    p.title || '',
    p.brand || '',
    (p.crumbs || []).join(' '),
    (p.bullets || []).join(' '),
  ].join(' ');
  return findBlockedTerm(text);
}
function productBlocked(p) {
  return !!productBlockedTerm(p);
}

function sanitizeProduct(p, related) {
  return {
    ...p,
    description: (p.description || []).filter((x) => !findBlockedTerm(x)),
    details: (p.details || []).filter((kv) => !findBlockedTerm(kv[0] + ' ' + kv[1])),
    aplus: {
      images: (p.aplus && p.aplus.images) || [],
      text: ((p.aplus && p.aplus.text) || []).filter((x) => !findBlockedTerm(x)),
    },
    related: (related || []).filter((t) => !tileBlocked(t)),
  };
}

/* ================================================================== */
/* Filter activity log (the /admin/stats monitor)                      */
/*                                                                     */
/* Everything the filter catches is recorded here so amazon-admin.html */
/* can show what happened, why, and with which access key:             */
/*   { type:'search',  q, reason, via:'word'|'category', key,          */
/*     flagged? }                                                      */
/*   { type:'results', source:'search'|'browse', q, page?, removed:[{  */
/*                       title, asin, reason }], count, shown, key,    */
/*     flagged? }                                                      */
/*   { type:'product', asin, title, reason, key, flagged? }            */
/* flagged:true = the request ran with an UNRESTRICTED key: nothing    */
/* was hidden, the event only notes that the filter WOULD have caught  */
/* it (the admin page marks those "not blocked - flagged, shown").     */
/*                                                                     */
/* Persistence (when a KV namespace is bound as FILTER_STATS): every   */
/* write is a read-merge-write that unions events by id, so several    */
/* worker isolates logging at the same time never erase each other's    */
/* events. /admin/stats/reset leaves a tombstone timestamp; late       */
/* writes from isolates that booted before the reset drop anything     */
/* older, so cleared events cannot come back.                          */
/* ================================================================== */

const STATS_KV_KEY = 'filter-stats-v1';
const STATS_CLEARED_KV_KEY = 'filter-stats-cleared-v1';
const STATS_DELETED_KV_KEY = 'stats-deleted-v1';
const CACHE_GEN_KV_KEY = 'cache-generation-v1';
/* every search is logged now (shown / blocked / denied / flagged), so
 * the cap is higher than it used to be */
const MAX_STATS_EVENTS = 1000;
/* tombstones for events removed one-by-one from the monitor (the X
 * button): without them a stale isolate that still holds the event
 * would resurrect it on its next read-merge-write */
const MAX_DELETED_IDS = 2000;

function zeroTotals() {
  return {
    searches: 0,
    deniedSearches: 0,
    blockedSearches: 0,
    removedTiles: 0,
    blockedProducts: 0,
    flaggedSearches: 0,
    flaggedTiles: 0,
    flaggedProducts: 0,
  };
}

const stats = {
  since: 0, /* when tracking started */
  events: [], /* oldest first, capped at MAX_STATS_EVENTS */
};

/* EVERY number the dashboard shows is derived from the surviving event
 * list right here - the events ARE the single source of truth. There
 * are no cumulative counters anymore: deleting an entry (the monitor's
 * X) or clearing the log makes every card, per-person counter and
 * top-query chip update as if the thing never happened, which is
 * exactly what the admin page expects. */
function deriveStats(events) {
  const totals = zeroTotals();
  const queryCounts = {};
  const keyTotals = {};
  for (const ev of events || []) {
    if (!ev) continue;
    const n = ev.type === 'results' ? ev.count || (ev.removed || []).length : 0;
    if (ev.type === 'search') {
      totals.searches++;
      if (ev.outcome === 'denied') totals.deniedSearches++;
      else if (ev.flagged) totals.flaggedSearches++;
      else if (ev.outcome !== 'shown') {
        totals.blockedSearches++;
        const k = normText(ev.q) || String(ev.q || '');
        if (k) queryCounts[k] = (queryCounts[k] || 0) + 1;
      }
    } else if (ev.type === 'results') {
      if (ev.flagged) totals.flaggedTiles += n;
      else totals.removedTiles += n;
    } else if (ev.type === 'product') {
      if (ev.flagged) totals.flaggedProducts++;
      else totals.blockedProducts++;
    }
    /* per-person counters (the access key string is the index) */
    if (ev.key) {
      const kt = keyTotals[ev.key] || (keyTotals[ev.key] = zeroTotals());
      if (ev.type === 'search') {
        kt.searches++;
        if (ev.outcome === 'denied') kt.deniedSearches++;
        else if (ev.flagged) kt.flaggedSearches++;
        else if (ev.outcome !== 'shown') kt.blockedSearches++;
      } else if (ev.type === 'results') {
        if (ev.flagged) kt.flaggedTiles += n;
        else kt.removedTiles += n;
      } else if (ev.type === 'product') {
        if (ev.flagged) kt.flaggedProducts++;
        else kt.blockedProducts++;
      }
    }
  }
  return { totals, queryCounts, keyTotals };
}

/* events at or before this timestamp were cleared by /admin/stats/reset */
let clearedTs = 0;

/* ids of events deleted one-by-one from the monitor; they double as
 * tombstones so concurrent isolates cannot write them back (same idea
 * as clearedTs, but per-event). ids sort chronologically because they
 * start with Date.now().toString(36). */
let deletedIds = new Set();

function pruneDeletedIds() {
  if (deletedIds.size <= MAX_DELETED_IDS) return;
  const keep = Array.from(deletedIds).sort().slice(deletedIds.size - MAX_DELETED_IDS);
  deletedIds = new Set(keep);
}

let statsLoadPromise = null;

/* Cache generation: bumped by /api/cache-wipe. Every edge-cache key
 * embeds it, so a bump instantly orphans all cached products, searches
 * and charts (they expire on their own). Persisted in the FILTER_STATS
 * KV namespace when one is bound, so the wipe survives isolate
 * restarts; without KV it applies to the current isolate only. */
let cacheGen = 0;

/* one-time per isolate: pull the saved log + cache generation from KV
 * when a namespace is bound */
function loadStats(env) {
  if (!statsLoadPromise) {
    statsLoadPromise = (async () => {
      stats.since = Date.now();
      try {
        if (env && env.FILTER_STATS && typeof env.FILTER_STATS.get === 'function') {
          const raw = await env.FILTER_STATS.get(STATS_KV_KEY);
          if (raw) {
            const s = JSON.parse(raw);
            if (s && Array.isArray(s.events)) {
              stats.since = s.since || Date.now();
              stats.events = s.events.slice(-MAX_STATS_EVENTS);
              /* totals / queryCounts / keyTotals in the blob are IGNORED:
               * they are always re-derived from the events (see
               * deriveStats), so a delete can never leave stale numbers */
            }
          }
          /* the reset tombstone: anything at or before it was cleared */
          const t = await env.FILTER_STATS.get(STATS_CLEARED_KV_KEY);
          const tn = parseInt(t || '', 10);
          if (!isNaN(tn) && tn > 0) {
            clearedTs = tn;
            stats.events = stats.events.filter((ev) => (ev.ts || 0) > clearedTs);
          }
          /* per-event deletion tombstones (the monitor's X button) */
          const del = await env.FILTER_STATS.get(STATS_DELETED_KV_KEY);
          if (del) {
            try {
              const arr = JSON.parse(del);
              if (Array.isArray(arr)) {
                deletedIds = new Set(arr.slice(-MAX_DELETED_IDS));
                stats.events = stats.events.filter((ev) => ev && !deletedIds.has(ev.id));
              }
            } catch (e) {}
          }
          const g = await env.FILTER_STATS.get(CACHE_GEN_KV_KEY);
          const n = parseInt(g || '', 10);
          if (!isNaN(n) && n > 0) cacheGen = n;
        }
      } catch (e) {}
    })();
  }
  return statsLoadPromise;
}

async function persistStats(env, ctx, awaitWrite) {
  try {
    if (env && env.FILTER_STATS && typeof env.FILTER_STATS.put === 'function') {
      /* read-merge-write: the KV copy is re-read first and unioned with
       * this isolate's events BY ID, so a snapshot held by another
       * isolate can never erase events it has not seen. The deletion
       * tombstones are re-read fresh too, so an event removed via the
       * monitor's X button stays removed no matter who writes next. */
      const job = (async () => {
        let kv = null;
        let delRaw = null;
        try {
          const raw = await env.FILTER_STATS.get(STATS_KV_KEY);
          if (raw) kv = JSON.parse(raw);
          delRaw = await env.FILTER_STATS.get(STATS_DELETED_KV_KEY);
        } catch (e) {}
        const delSet = new Set(deletedIds);
        if (delRaw) {
          try {
            const d = JSON.parse(delRaw);
            if (Array.isArray(d)) {
              for (const id of d) delSet.add(id);
            }
          } catch (e) {}
        }
        deletedIds = delSet;
        pruneDeletedIds();
        const delJson = JSON.stringify(Array.from(deletedIds));
        /* write the tombstone list back only when it changed (keeps the
         * steady-state at one KV write per logged event) */
        if (delJson !== (delRaw == null ? '[]' : delRaw)) {
          await env.FILTER_STATS.put(STATS_DELETED_KV_KEY, delJson).catch(() => {});
        }
        await env.FILTER_STATS.put(STATS_KV_KEY, JSON.stringify(mergeStats(kv, stats, deletedIds)));
      })().catch(() => {});
      if (awaitWrite) await job;
      else if (ctx && ctx.waitUntil) ctx.waitUntil(job);
    }
  } catch (e) {}
}

/* union of two log snapshots: events merge by id (newest survive the
 * MAX cap), the reset tombstone drops anything /admin/stats/reset
 * cleared, and delSet drops events the monitor deleted one-by-one.
 * All counters are DERIVED from the surviving events - never merged
 * or remembered - so what you see is exactly what is in the log. */
function mergeStats(kv, local, delSet) {
  const keep = (ev) => {
    if (!ev || !ev.id) return false;
    if (delSet && delSet.has(ev.id)) return false;
    if (clearedTs && (ev.ts || 0) <= clearedTs) return false;
    return true;
  };
  const byId = new Map();
  for (const ev of (kv && kv.events) || []) {
    if (keep(ev)) byId.set(ev.id, ev);
  }
  for (const ev of (local && local.events) || []) {
    if (keep(ev)) byId.set(ev.id, ev);
  }
  const events = Array.from(byId.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (events.length > MAX_STATS_EVENTS) events.splice(0, events.length - MAX_STATS_EVENTS);

  const since = Math.min((kv && kv.since) || Infinity, (local && local.since) || Infinity);
  return Object.assign({ since: since === Infinity ? 0 : since, events }, deriveStats(events));
}

/* what /admin/stats answers: the freshest KV state merged with this
 * isolate's own events - the dashboard always reflects every isolate */
async function adminStatsView(env) {
  if (env && env.FILTER_STATS && typeof env.FILTER_STATS.get === 'function') {
    let kv = null;
    let delSet = null;
    try {
      const raw = await env.FILTER_STATS.get(STATS_KV_KEY);
      if (raw) kv = JSON.parse(raw);
      const t = await env.FILTER_STATS.get(STATS_CLEARED_KV_KEY);
      const tn = parseInt(t || '', 10);
      if (!isNaN(tn) && tn > clearedTs) clearedTs = tn;
      const del = await env.FILTER_STATS.get(STATS_DELETED_KV_KEY);
      if (del) {
        const d = JSON.parse(del);
        if (Array.isArray(d)) {
          delSet = new Set(d);
          /* learn tombstones written by other isolates */
          for (const id of d) deletedIds.add(id);
          pruneDeletedIds();
        }
      }
    } catch (e) {}
    return mergeStats(kv, stats, deletedIds);
  }
  /* memory mode: derive straight from this isolate's events */
  return Object.assign({ since: stats.since, events: stats.events }, deriveStats(stats.events));
}

function logStats(env, ctx, ev) {
  ev.id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  ev.ts = Date.now();
  stats.events.push(ev);
  if (stats.events.length > MAX_STATS_EVENTS) {
    stats.events.splice(0, stats.events.length - MAX_STATS_EVENTS);
  }
  /* no counters to maintain: every number is derived from the events
   * (see deriveStats), so deletes and clears can never leave the
   * dashboard showing ghosts */
  persistStats(env, ctx);
}

/* ================================================================== */
/* Router                                                              */
/* ================================================================== */

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const p = (url.pathname || '/').replace(/\/+$/, '') || '/';

    /* filter monitor + key manager: own password, independent of the
     * access keys */
    if (
      p === '/admin/stats' ||
      p === '/admin/stats/reset' ||
      p === '/admin/events/delete' ||
      p === '/admin/keys' ||
      p === '/admin/keys/delete'
    ) {
      return handleAdmin(request, url, p, env, ctx);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'bad_request', message: 'GET only' }, 405);
    }

    /* pulls the saved log from KV once per isolate (no-op without one) */
    await loadStats(env);

    const access = await resolveAccess(
      request.headers.get('x-access-key') || url.searchParams.get('key') || '',
      env
    );
    if (!access) {
      return jsonResponse({ error: 'unauthorized', message: 'Bad or missing access key' }, 401);
    }
    const profile = access.profile;
    const akey = access.key; /* rides into the filter log: who did it */

    try {
      if (p === '/' || p === '/health') {
        return jsonResponse({ ok: true, service: 'amazon-relay', profile, ts: Date.now() });
      }
      if (p === '/img') {
        return await proxyImage(ctx, url.searchParams.get('u') || '');
      }
      if (p === '/api/cache-wipe') return handleCacheWipe(url, ctx, env);
      if (p === '/api/search') return await handleSearch(url, ctx, profile, env, akey);
      if (p.startsWith('/api/product/')) return await handleProduct(url, ctx, profile, env, akey);
      if (p === '/api/browse') return await handleBrowse(url, ctx, profile, env, akey);

      return jsonResponse({ error: 'not_found', message: 'Unknown route: ' + p }, 404);
    } catch (e) {
      console.log('[relay] error:', e && e.message);
      if (e instanceof BlockedError) {
        return jsonResponse(
          { error: 'blocked', message: 'Amazon is throttling requests from the worker right now. Wait a few seconds and retry.' },
          503
        );
      }
      if (e instanceof NotFoundError) {
        return jsonResponse({ error: 'not_found', message: 'Amazon returned 404 for that page.' }, 404);
      }
      return jsonResponse({ error: 'upstream', message: (e && e.message) || 'Unexpected worker error' }, 502);
    }
  },
};

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* no-store: the phone's browser must never replay a response that
       * was filtered for a DIFFERENT access key after the user switched
       * keys. Caching happens inside the worker (cachedData), which
       * re-runs the Safe Mode filter on every request anyway. */
      'cache-control': 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

function attr(el, name) {
  try {
    if (typeof el.getAttribute === 'function') {
      const v = el.getAttribute(name);
      if (v != null) return v;
    }
  } catch (e) {}
  const attrs = el.attributes;
  if (!attrs) return null;
  for (const a of attrs) {
    if (a.name === name) return a.value;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== */
/* Fetch layer (bot-check detection + UA rotation + session cookies)  */
/* ================================================================== */

/* Amazon edge session cookies (anonymous session-id / ubid / i18n
 * prefs). Harvested from every Amazon response, kept per isolate,
 * replayed on later fetches, and refreshed by the homepage warm-up.
 * Live-tested to raise the pass rate against the bot wall a lot. */
let cookieState = { cookies: '', ts: 0 };
const COOKIE_TTL_MS = 30 * 60 * 1000;

function harvestCookies(res) {
  let raw = [];
  try {
    if (typeof res.headers.getAll === 'function') raw = res.headers.getAll('set-cookie');
  } catch (e) {}
  if (!raw || !raw.length) {
    try {
      if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
    } catch (e) {}
  }
  if (!raw || !raw.length) {
    const single = res.headers.get('set-cookie');
    if (single) raw = [single];
  }
  const pairs = {};
  for (const line of raw) {
    const m = /^\s*([^=;\s]+=[^;]*)/.exec(String(line));
    if (m) pairs[m[1].split('=')[0].trim()] = m[1];
  }
  const keys = Object.keys(pairs);
  if (keys.length) {
    cookieState.cookies = keys.map((k) => pairs[k]).join('; ');
    cookieState.ts = Date.now();
  }
}

async function fetchAmazon(target, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const jarFresh = cookieState.cookies && Date.now() - cookieState.ts < COOKIE_TTL_MS;
    const res = await fetch(AMAZON + target, {
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        referer: AMAZON + '/',
        'upgrade-insecure-requests': '1',
        ...(jarFresh ? { cookie: cookieState.cookies } : {}),
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    harvestCookies(res);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* Touching the homepage before a retry measurably raises the pass rate
 * of the request that follows (live-tested against the wall). It also
 * refreshes the cookie jar when Amazon answers with a real page. */
async function touchAmazonHome(ua) {
  try {
    const res = await fetchAmazon('/', ua);
    await res.text(); // drain
  } catch (e) {}
}

async function getAmazonHTML(target) {
  /* Desktop profile first: live-verified to expose the richest markup
   * (full image gallery, breadcrumbs, review counts). Mobile mixed in
   * as a fallback. Amazon fronts datacenter traffic with (a) a 503
   * captcha page, (b) a 202/200 Akamai challenge shell of ~2 KB with
   * no products, or (c) occasionally a real page. Retry with profile
   * rotation + homepage warm-ups until a real page comes through. */
  const attempts = [DESKTOP_UA, DESKTOP_UA, MOBILE_UA, DESKTOP_UA, MOBILE_UA];
  let saw404 = false;

  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await touchAmazonHome(attempts[i]);

    let res;
    try {
      res = await fetchAmazon(target, attempts[i]);
    } catch (e) {
      await sleep(300);
      continue; // timeout / network hiccup -> try next profile
    }

    if (res.status === 404) {
      saw404 = true;
      continue;
    }

    const finalUrl = res.url || '';
    let hardBlocked =
      res.status === 503 ||
      res.status === 202 ||
      finalUrl.includes('/errors/') ||
      finalUrl.includes('validate_captcha') ||
      !(res.headers.get('content-type') || '').includes('text/html');

    let html = '';
    try {
      html = await res.text();
    } catch (e) {
      hardBlocked = true;
    }

    /* challenge shells are tiny and contain no product tiles and no
     * "no results" wording; a real search/product/chart page is 100 KB+ */
    const tinyShell =
      html.length > 0 && html.length < 8192 && !/data-asin=|no results for|did not match/i.test(html);

    if (
      !hardBlocked &&
      !tinyShell &&
      !BLOCK_MARKERS.some((m) => html.includes(m)) &&
      !SHELL_MARKERS.some((m) => html.includes(m))
    ) {
      return html;
    }

    /* the wall won: drop the cookies so the warm-up re-harvests fresh */
    cookieState.cookies = '';

    await sleep(350 + Math.floor(Math.random() * 750));
  }

  if (saw404) throw new NotFoundError('Amazon returned 404');
  throw new BlockedError('Amazon served a bot-check page');
}

/* ================================================================== */
/* Edge cache (Cache API, TTL enforced in a wrapper object)            */
/* ================================================================== */

/* Caches the producer's data at the edge under a key and returns the
 * DATA (not a Response) - callers still run their per-request logic
 * (Safe Mode filtering + activity logging) on cache hits. The cached
 * payload is worker-internal: it holds the RAW unfiltered extraction
 * and is never sent anywhere until the caller has filtered it.
 * The key embeds the cache generation, so /api/cache-wipe (which bumps
 * it) makes every old entry unreachable at once. */
async function cachedData(ctx, key, ttlSec, producer) {
  const cache = caches.default;
  const req = new Request('https://jsoncache.relay/' + cacheGen + '/' + encodeURIComponent(key));

  let hit = null;
  try {
    hit = await cache.match(req);
  } catch (e) {}

  if (hit) {
    try {
      const wrap = JSON.parse(await hit.text());
      if (wrap && wrap.t && Date.now() - wrap.t < ttlSec * 1000 && wrap.d) {
        return wrap.d;
      }
    } catch (e) {}
  }

  const data = await producer();
  const body = JSON.stringify({ t: Date.now(), d: data });

  try {
    const toStore = new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + ttlSec },
    });
    const put = cache.put(req, toStore).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    else await put;
  } catch (e) {}

  return data;
}

/* ================================================================== */
/* Image proxy                                                         */
/* ================================================================== */

function cleanImageUrl(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  const okHost = ['media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com'].some(
    (d) => h === d || h.endsWith('.' + d)
  );
  if (!okHost) return null;
  if (!/^\/images\/I\//i.test(u.pathname)) return null;
  return u.toString();
}

async function proxyImage(ctx, raw) {
  const clean = cleanImageUrl(raw);
  if (!clean) return jsonResponse({ error: 'bad_request', message: 'Invalid image URL' }, 400);

  const cache = caches.default;
  const key = new Request('https://imgcache.relay/' + encodeURIComponent(clean));

  let hit = null;
  try {
    hit = await cache.match(key);
  } catch (e) {}
  if (hit) {
    return new Response(hit.body, {
      headers: { 'content-type': hit.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=604800, immutable', ...CORS },
    });
  }

  let res;
  try {
    res = await fetch(clean, {
      headers: {
        'user-agent': MOBILE_UA,
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        referer: AMAZON + '/',
      },
    });
  } catch (e) {
    return jsonResponse({ error: 'upstream', message: 'Image fetch failed' }, 502);
  }

  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.startsWith('image/')) {
    return jsonResponse({ error: 'upstream', message: 'Image not available' }, 502);
  }

  const out = new Response(res.body, {
    headers: { 'content-type': ct, 'cache-control': 'public, max-age=604800, immutable', ...CORS },
  });

  try {
    const put = cache.put(key, out.clone()).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  } catch (e) {}

  return out;
}

/* ================================================================== */
/* Extraction engine (HTMLRewriter)                                    */
/*                                                                     */
/* One generic "tile machine" harvests product tiles from any page     */
/* that contains div[data-asin] grids: search results, best-seller    */
/* charts and the related-product carousels on product pages.         */
/* Text is accumulated per matched element and attributed to the tile  */
/* that was open when the element started (see makeCollector).        */
/* ================================================================== */

const IMG_PATH_RE = /\/images\/I\//;

/* Amazon pages carry 0.5-1 MB of inline JavaScript. That JS (a) slows
 * the rewriter down and (b) used to LEAK into collected text - metrics
 * scripts like P.when('A','ready').execute(...) were showing up as
 * product description / detail rows. Drop script/style/noscript bodies
 * and HTML comments before parsing; nothing the extractors read lives
 * there (all data comes from real elements and attributes). */
function stripInert(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?(?:<\/noscript\s*>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
}

/* belt and suspenders: any text chunk that still looks like inline JS
 * is dropped by every collector */
const CODE_JUNK_RE =
  /P\.when\s*\(|A\.declarative\s*\(|dp[A-Z][A-Za-z]*Click|triggerInterstitial|bm-verify|XMLHttpRequest|\.execute\s*\(\s*function/;

function looksLikeCode(t) {
  return CODE_JUNK_RE.test(t);
}

/* --- HTML entity decoding ---------------------------------------- */
/* Cloudflare's HTMLRewriter hands text chunks and attribute values
 * through RAW - "Men&#39;s" stays "Men&#39;s". Amazon escapes apostrophes
 * (&#39;), inch marks (&quot;) and ampersands (&amp;) in titles, bullets,
 * descriptions and detail tables, and DOUBLE-escapes img alt / aria
 * attributes ("&amp;#39;"). Every piece of display text therefore goes
 * through decodeEntities(), and attribute text through attrText()
 * (two passes, because of the double escaping). */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '\u2026', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0',
  plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', frac12: '\u00bd', frac14: '\u00bc',
  frac34: '\u00be', cent: '\u00a2', pound: '\u00a3', euro: '\u20ac', yen: '\u00a5',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', bull: '\u2022', dagger: '\u2020',
  sect: '\u00a7', para: '\u00b6', middot: '\u00b7', larr: '\u2190', rarr: '\u2192',
   szlig: '\u00df', agrave: '\u00e0', aacute: '\u00e1', egrave: '\u00e8', eacute: '\u00e9',
  euml: '\u00eb', ugrave: '\u00f9', uacute: '\u00fa', uuml: '\u00fc', ccedil: '\u00e7',
  ntilde: '\u00f1', ocirc: '\u00f4', oacute: '\u00f3', auml: '\u00e4', iexcl: '\u00a1',
};

function decodeEntities(s) {
  if (!s || String(s).indexOf('&') < 0) return s == null ? '' : s;
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      /* reject nonsense code points, keep the raw text otherwise */
      if (!(code > 0) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      try {
        return String.fromCodePoint(code);
      } catch (err) {
        return m;
      }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/* attribute values Amazon double-escapes: decode up to two passes */
function attrText(v) {
  let s = decodeEntities(v);
  if (/&#|&[a-zA-Z][a-zA-Z0-9]*;/.test(s)) s = decodeEntities(s);
  return s;
}

/* after decoding, double-escaped markup can surface as literal tags
 * ("&lt;br&gt;" -> "<br>"); strip such remnants from display text */
const TAG_REMNANT_RE = /<\/?[a-zA-Z][a-zA-Z0-9]{0,11}(?:\s[^<>]{0,80})?>/g;

function cleanText(s) {
  return decodeEntities(s).replace(TAG_REMNANT_RE, ' ').replace(/\s+/g, ' ').trim();
}

function fullSize(u) {
  // "https://.../I/41kN1._AC_US40_.jpg" -> "https://.../I/41kN1.jpg"
  return String(u).replace(/\._[^./?]+(?=\.(?:jpg|jpeg|png|webp|gif))/i, '');
}

function parseDynamicImages(jsonStr) {
  try {
    const o = JSON.parse(jsonStr);
    const arr = Object.keys(o).map((u) => [u, Array.isArray(o[u]) ? o[u][0] || 0 : 0]);
    arr.sort((a, b) => b[1] - a[1]); // widest first
    return arr.map((x) => x[0]).filter((u) => /^https:\/\//.test(u));
  } catch (e) {
    return [];
  }
}

function parseRating(text) {
  const m = String(text).match(/(\d+(?:\.\d+)?)\s+out of\s+5/i);
  return m ? parseFloat(m[1]) : null;
}

function priceNum(s) {
  const m = String(s == null ? '' : s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

async function runExtractor(rawHtml, mode, asin) {
  const html = stripInert(rawHtml);
  const tiles = [];
  let cur = null;
  const flushers = [];

  /* --- browse charts: category sections --- */
  /* Chart pages stack category carousels, each introduced by a heading
   * like "New Releases in Kitchen & Dining". Headings are collected
   * with the same collector machinery; every tile remembers the section
   * that was open when it STARTED, so a heading between two tiles can
   * never steal the earlier tile (HTMLRewriter has no end tags). */
  const sections = [];
  let curSection = null;
  const openSection = (title) => {
    curSection = { title: title || '', tiles: [] };
    sections.push(curSection);
    return curSection;
  };

  /* Text of an element often only flushes when the NEXT element matching
   * the same selector opens (HTMLRewriter has no end-tag callbacks). That
   * next element usually sits in the FOLLOWING tile - so before a tile is
   * finalized we must flush all pending buffers, which are attributed to
   * the tile/product captured when their element opened. */
  const flushAll = () => {
    for (const f of flushers) f.flush();
  };

  /* --- collector factory: accumulates the text of each matched     --- */
  /* --- element and attributes it to the context captured at start  --- */
  function makeCollector(onText, onElement) {
    let buf = '';
    let tgt = null;
    const h = {
      element(el) {
        h.flush();
        tgt = onElement ? onElement(el) : null;
      },
      text(t) {
        buf += t.text;
      },
      flush() {
        const v = cleanText(buf);
        buf = '';
        if (v && !looksLikeCode(v) && onText) onText(v, tgt);
      },
    };
    flushers.push(h);
    return h;
  }

  function finalizeTile() {
    const t = cur;
    cur = null;
    if (!t || !t.asin) return;

    const struck = (t.struck || []).filter(Boolean);
    let pool = (t.prices || []).filter((p) => p && !struck.includes(p));
    if (!pool.length && struck.length) pool = [struck[0]];

    let price = pool[0] || null;
    let listPrice = struck.find((s) => s !== price) || null;
    /* unit prices and odd markup can land in the strike pool - only
     * keep a list price that is actually higher than the current price */
    if (price && listPrice && !(priceNum(listPrice) > priceNum(price))) listPrice = null;

    let title = t.title || t.imgAlt || '';
    if (title) title = cleanText(title).slice(0, 300);

    if (t.img) {
      const tile = {
        asin: t.asin,
        title,
        img: t.img,
        price,
        listPrice,
        rating: t.rating == null ? null : t.rating,
        reviews: t.reviews || null,
        sponsored: !!t.sponsored,
        rank: t.rank || null,
      };
      tiles.push(tile);
      const sec = t.sec || curSection || openSection('');
      sec.tiles.push(tile);
    }
  }

  /* --- generic product-tile machine (div[data-asin]) --- */
  const tileOpen = {
    element(el) {
      const a = attr(el, 'data-asin') || '';
      if (!/^[A-Z0-9]{10}$/i.test(a)) return; // skip wrappers/ads slots
      flushAll(); // attribute pending text to the tile being closed
      finalizeTile();
      cur = {
        asin: a.toUpperCase(),
        title: '',
        imgAlt: '',
        img: null,
        prices: [],
        struck: [],
        rating: null,
        reviews: '',
        sponsored: false,
        rank: '',
        sec: curSection, /* section this tile belongs to (browse mode) */
      };
    },
  };

  const tileCtx = () => cur;

  /* Title hygiene: search tiles contain many /dp/ links that are NOT
   * the title - color-swatch links whose whole text is "+3 other
   * colors/patterns" (the "+30" / "+26" junk titles), image links,
   * review links. On apparel tiles the swatches can sit ABOVE the
   * title, so the first link text must not blindly win. A candidate
   * must look like a real product name to be accepted. */
  const SWATCH_JUNK_RE = /^\+\d+\b/; // "+3", "+30 other colors/patterns"
  function titleish(s) {
    if (!s || s.length < 4 || s.length > 400) return false;
    if (SWATCH_JUNK_RE.test(s)) return false;
    if (/^sponsored\b/i.test(s)) return false;
    return /[\u00c0-\u02af\u0370-\uffff]|[a-z]/i.test(s); // has a letter
  }

  /* link → tile context for title collection; null means "never use
   * this link's text as a title" (swatches, buttons, non-product links) */
  const titleCtxOf = (el) => {
    const t = cur;
    if (!t) return null;
    const cls = (attr(el, 'class') || '') + ' ' + (attr(el, 'aria-label') || '');
    if (/swatch/i.test(cls)) return null;
    const al = attr(el, 'aria-label') || '';
    if (SWATCH_JUNK_RE.test(al)) return null;
    if (/^\+?\d+\s*(other\s+)?(colors?|colours?|patterns?|options?)/i.test(al)) return null;
    const href = attr(el, 'href') || '';
    if (/sspa/i.test(href)) t.sponsored = true;
    return t;
  };

  const titleA = makeCollector(
    (text, t) => {
      if (t && !t.title && titleish(text)) t.title = text;
    },
    titleCtxOf
  );

  /* Sponsored tiles route their title link through /sspa/click?...
   * with the /dp/ URL-ENCODED, so a[href*="/dp/"] never matches them
   * (their titles fell back to img alt text). The title anchor's
   * class a-text-normal is stable across organic and sponsored tiles. */
  const titleClassA = makeCollector(
    (text, t) => {
      if (t && !t.title && titleish(text)) t.title = text;
    },
    (el) => {
      const t = cur;
      if (!t) return null;
      const href = attr(el, 'href') || '';
      if (/sspa/i.test(href)) t.sponsored = true;
      return t;
    }
  );

  const titleH2 = makeCollector(
    (text, t) => {
      if (t && !t.title && titleish(text)) t.title = text;
    },
    (el) => {
      const t = cur;
      if (t) {
        const href = attr(el, 'href') || '';
        if (/sspa|\/gp\/sl\//i.test(href)) t.sponsored = true;
      }
      return t;
    }
  );

  const priceT = makeCollector((text, t) => {
    if (t) t.prices.push(text);
  }, tileCtx);

  const struckT = makeCollector((text, t) => {
    if (t) t.struck.push(text);
  }, tileCtx);

  const ratingT = makeCollector((text, t) => {
    if (t && t.rating == null) t.rating = parseRating(text);
  }, tileCtx);

  const reviewsT = makeCollector((text, t) => {
    if (t && !t.reviews && /\d/.test(text)) {
      const v = text
        .replace(/global\s+ratings?/i, '')
        .replace(/ratings?/i, '')
        .replace(/stars?/i, '')
        .replace(/out of 5/i, '')
        .replace(/[()]/g, '')
        .trim();
      if (v && /^[\d.,]+[KkMm+]?[+?]?$/.test(v)) t.reviews = v.slice(0, 12);
    }
  }, tileCtx);

  /* Mobile ZG tiles: <span aria-label="32,000 ratings">32,000</span> */
  const reviewsAltT = {
    element(el) {
      if (!cur || cur.reviews) return;
      const al = attr(el, 'aria-label') || '';
      if (!/\d/.test(al) || !/ratings?/i.test(al)) return;
      const v = al.replace(/ratings?/i, '').replace(/[()]/g, '').trim();
      if (v && /^[\d.,]+[KkMm+]?[+?]?$/.test(v)) cur.reviews = v.slice(0, 12);
    },
  };

  const rankT = makeCollector((text, t) => {
    if (t && !t.rank) t.rank = text.slice(0, 6);
  }, tileCtx);

  const imgT = {
    element(el) {
      if (!cur || cur.img) return;
      const cands = [];
      for (const a of ['src', 'data-src', 'data-old-hires', 'data-a-hi-res', 'data-a-hi-res-src']) {
        const v = attr(el, a);
        if (v) cands.push(v);
      }
      const ss = attr(el, 'srcset');
      if (ss) cands.push(ss.split(',').pop().trim().split(/\s+/)[0]);
      const good = cands.find(
        (u) => /^https:\/\//.test(u) && IMG_PATH_RE.test(u) && !/transparent-pixel|spacer|loading-/i.test(u)
      );
      if (good) {
        cur.img = good;
        /* alt text is double-escaped by Amazon ("&amp;#39;") and often
         * starts with "Sponsored Ad - " on ad tiles; it is the LAST
         * resort title fallback, so clean it before storing */
        const alt = attrText(attr(el, 'alt') || '');
        if (alt) cur.imgAlt = alt.replace(/^sponsored\s+ad\s*[-–—:]?\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 300);
      }
    },
  };

  let rw = new HTMLRewriter()
    .on('div[data-asin]', tileOpen)
    .on('div[data-asin] a.a-text-normal', titleClassA)
    .on('div[data-asin] a[href*="/dp/"]', titleA)
    .on('div[data-asin] h2 a', titleH2)
    .on('div[data-asin] .a-price .a-offscreen', priceT)
    .on('div[data-asin] span.a-price.a-text-price .a-offscreen', struckT)
    .on('div[data-asin] span[class*="p13n-sc-price"]', priceT)
    .on('div[data-asin] span.a-icon-alt', ratingT)
    .on('div[data-asin] a[href*="customerReviews"]', reviewsT)
    .on('div[data-asin] a[href*="product-reviews"]', reviewsT)
    .on('div[data-asin] span[aria-label*="ratings"]', reviewsAltT)
    .on('div[data-asin] span[aria-label*="Ratings"]', reviewsAltT)
    .on('div[data-asin] span.zg-bdg-text', rankT)
    .on('div[data-asin] img', imgT);

  /* browse charts only: the carousel headings ("New Releases in ...")
   * that label each category section. The heading's text flushes when
   * the first tile after it opens (flushAll inside tileOpen) or when
   * the next heading opens - both attribute it to the section object
   * captured when the heading element STARTED. */
  if (mode === 'browse') {
    rw = rw.on(
      '.a-carousel-heading',
      makeCollector(
        (text, tgt) => {
          if (tgt) tgt.title = text;
        },
        () => openSection('')
      )
    );
  }

  /* --- product-page fields --- */
  let product = null;

  if (mode === 'product') {
    product = {
      asin: (asin || '').toUpperCase(),
      title: '',
      brand: '',
      pricePool: [],
      struckPool: [],
      buyboxPrice: '',
      aodPrice: '',
      rating: null,
      reviews: '',
      availability: '',
      bullets: [],
      descParas: [],
      detailPairs: [],
      aplusImgs: [],
      aplusParas: [],
      _dk: null,
      mainImg: '',
      mainImgCandidates: [],
      thumbSrcs: [],
      crumbs: [],
      ogTitle: '',
      ogImage: '',
      ogDesc: '',
    };

    const pc = () => product;

    const metaOg = (prop) => ({
      element(el) {
        const c = attrText(attr(el, 'content') || '');
        if (c && !product[prop]) product[prop] = c.trim();
      },
    });

    const ratingP = makeCollector((text) => {
      if (product.rating == null) product.rating = parseRating(text);
    }, pc);

    const brandClean = (t) =>
      t
        .replace(/visit the (brand\s*)?store/ig, '')
        .replace(/^(visit the|brand:)\s*/i, '')
        .replace(/\s*store\s*$/i, '')
        .replace(/[,|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);

    /* Mobile-layout main image: img#main-image carries data-a-hires;
     * #landing-image-wrapper img carries src + data-midres-replacement. */
    const imgMainM = {
      element(el) {
        const hires = attr(el, 'data-a-hires') || attr(el, 'data-midres-replacement') || '';
        const src = attr(el, 'src') || '';
        if (hires && /^https:\/\//.test(hires) && IMG_PATH_RE.test(hires)) {
          product.mainImg = hires;
          return;
        }
        if (!product.mainImg && src && /^https:\/\//.test(src) && IMG_PATH_RE.test(src)) {
          product.mainImg = src;
        }
      },
    };

    /* Mobile-layout review count: <span aria-label="75,874 Reviews"> */
    const reviewsM = {
      element(el) {
        if (product.reviews) return;
        const al = attr(el, 'aria-label') || '';
        if (!/[\d]/.test(al)) return;
        const m = al.match(/([\d.,]+\s*[KkMm]?)\s*(reviews?|ratings?)/i) || al.match(/([\d.,]+)/);
        if (m) product.reviews = m[1].trim().slice(0, 12);
      },
    };

    const buyboxP = makeCollector((text) => {
      if (!product.buyboxPrice) product.buyboxPrice = text;
    }, pc);

    const imgMain = {
      element(el) {
        if (product.mainImg) return;
        const dyn = attr(el, 'data-a-dynamic-image');
        if (dyn) {
          const urls = parseDynamicImages(dyn);
          if (urls.length) {
            product.mainImgCandidates = urls;
            product.mainImg = urls[0];
            return;
          }
        }
        for (const a of ['data-old-hires', 'data-a-hi-res', 'src']) {
          const v = attr(el, a);
          if (v && /^https:\/\//.test(v) && IMG_PATH_RE.test(v)) {
            product.mainImg = v;
            return;
          }
        }
      },
    };

    const imgThumb = {
      element(el) {
        if (product.thumbSrcs.length >= 30) return;
        const s = attr(el, 'data-old-hires') || attr(el, 'data-a-hires') || attr(el, 'src') || attr(el, 'data-src') || '';
        if (!/^https:\/\//.test(s) || !IMG_PATH_RE.test(s)) return;
        if (/play|video|sprite|transparent|placeholder/i.test(s + ' ' + (attr(el, 'alt') || ''))) return;
        product.thumbSrcs.push(s);
      },
    };

    /* --- "Product description" paragraphs --- */
    const descP = makeCollector((t) => {
      if (product.descParas.length < 20 && t.length > 2) product.descParas.push(t.slice(0, 2000));
    }, pc);

    /* --- "Product details" / tech-spec tables: th + td pair up row by row.
     * Separate buffers: a td's text flushes when the next th opens, by which
     * time that th's text has already flushed and stored its key. --- */
    const detailTh = makeCollector((t) => {
      const k = t.replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
      if (k && k.length <= 80) product._dk = k;
    }, pc);
    const detailTd = makeCollector((t) => {
      const k = product._dk;
      product._dk = null;
      if (!k || product.detailPairs.length >= 30) return;
      const v = t.replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 250);
      if (v) product.detailPairs.push([k, v]);
    }, pc);

    /* --- detail bullets ("ASIN : B0...", "Best Sellers Rank: #1 in...") --- */
    const detailLi = makeCollector((t) => {
      if (product.detailPairs.length >= 30) return;
      const s = t.replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
      const c = s.indexOf(':');
      if (c < 2 || c > 60) return;
      const k = s.slice(0, c).trim();
      const v = s.slice(c + 1).trim().slice(0, 250);
      if (k && v) product.detailPairs.push([k, v]);
    }, pc);

    /* --- A+ "From the manufacturer" images + text --- */
    const aplusImg = {
      element(el) {
        if (product.aplusImgs.length >= 12) return;
        const cands = [attr(el, 'data-old-hires'), attr(el, 'data-a-hi-res'), attr(el, 'data-src'), attr(el, 'src')];
        const u = cands.find(
          (x) => x && /^https:\/\//.test(x) && IMG_PATH_RE.test(x) && !/sprite|spacer|transparent|icon|1x1|play|video|logo/i.test(x)
        );
        if (u) product.aplusImgs.push(u);
      },
    };
    const aplusP = makeCollector((t) => {
      if (product.aplusParas.length < 16 && t.length > 3) product.aplusParas.push(t.slice(0, 1200));
    }, pc);

    /* "New & Used (37) from $199.49" - some page variants leave the
     * corePrice buybox empty (JS-rendered) and only this static offers
     * block carries a price; it is a labeled last-resort fallback. */
    const aodP = makeCollector((t) => {
      if (!product.aodPrice) product.aodPrice = t;
    }, pc);

    rw = rw
      .on('meta[property="og:title"]', metaOg('ogTitle'))
      .on('meta[property="og:image"]', metaOg('ogImage'))
      .on('meta[property="og:description"]', metaOg('ogDesc'))
      .on('#productTitle', makeCollector((t) => { if (!product.title) product.title = t; }, pc))
      .on('span#title', makeCollector((t) => { if (!product.title) product.title = t; }, pc))
      .on('#bylineInfo', makeCollector((t) => {
        if (!product.brand) product.brand = brandClean(t);
      }, pc))
      .on('#amznStoresBylineLogoTextContainer', makeCollector((t) => {
        if (!product.brand) product.brand = brandClean(t);
      }, pc))
      .on('div[id^="corePrice"] .a-price .a-offscreen', makeCollector((t) => product.pricePool.push(t), pc))
      .on('div[id^="apex"] .a-price .a-offscreen', makeCollector((t) => product.pricePool.push(t), pc))
      .on('span[id*="price_block_total_price"] .a-offscreen', makeCollector((t) => product.pricePool.push(t), pc))
      .on('div[id^="corePrice"] span.a-price.a-text-price .a-offscreen', makeCollector((t) => product.struckPool.push(t), pc))
      .on('div[id^="apex"] span.a-price.a-text-price .a-offscreen', makeCollector((t) => product.struckPool.push(t), pc))
      .on('#price_inside_buybox', buyboxP)
      .on('#priceblock_ourprice', buyboxP)
      .on('#priceblock_dealprice', buyboxP)
      .on('#dynamic-aod-ingress-box span.a-price .a-offscreen', aodP)
      .on('#acrPopover .a-icon-alt', ratingP)
      .on('#averageCustomerReviews .a-icon-alt', ratingP)
      .on('#acrCustomerReviewLink .a-icon-alt', ratingP)
      .on('span[data-hook="rating-out-of-text"]', ratingP)
      .on('#acrCustomerReviewText', makeCollector((t) => {
        if (!product.reviews) product.reviews = t.replace(/global\s+/i, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
      }, pc))
      .on('#acrCustomerReviewLink span[aria-label]', reviewsM)
      .on('#availability', makeCollector((t) => {
        if (!product.availability) {
          const v = t.split('{')[0].replace(/\s+/g, ' ').trim();
          if (v) product.availability = v.slice(0, 60);
        }
      }, pc))
      .on('#feature-bullets li .a-list-item', makeCollector((t) => {
        if (product.bullets.length < 12 && t.length > 1) product.bullets.push(t.slice(0, 500));
      }, pc))
      .on('#imgTagWrapperId img', imgMain)
      .on('img#main-image', imgMainM)
      .on('#landing-image-wrapper img', imgMainM)
      .on('#altImages img', imgThumb)
      .on('#wayfinding-breadcrumbs_feature_div a', makeCollector((t) => {
        if (product.crumbs.length < 6 && t.length > 1 && !/^back to results$/i.test(t)) product.crumbs.push(t.slice(0, 40));
      }, pc))
      .on('#productDescription p', descP)
      .on('#prodDetails th', detailTh)
      .on('#prodDetails td', detailTd)
      .on('table[id^="productDetails_techSpec"] th', detailTh)
      .on('table[id^="productDetails_techSpec"] td', detailTd)
      .on('table[id^="productDetails_detailBullets"] th', detailTh)
      .on('table[id^="productDetails_detailBullets"] td', detailTd)
      .on('#detailBullets_feature_div li', detailLi)
      .on('#aplus img', aplusImg)
      .on('#aplus_feature_div img', aplusImg)
      .on('#aplus p', aplusP)
      .on('#aplus_feature_div p', aplusP);
  }

  /* --- run the pipeline --- */
  await rw.transform(new Response(html)).text();

  flushAll();
  finalizeTile();

  /* --- dedupe by ASIN (noscript fallbacks can double-render) --- */
  const seen = new Set();
  const outTiles = [];
  for (const t of tiles) {
    if (!seen.has(t.asin)) {
      seen.add(t.asin);
      outTiles.push(t);
    }
  }

  if (mode === 'product') {
    const selfAsin = (asin || '').toUpperCase();
    return { product: assembleProduct(product), related: outTiles.filter((t) => t.asin !== selfAsin).slice(0, 16) };
  }

  /* sections follow the same dedupe: a tile repeated in a later
   * carousel stays in the first section that carried it */
  const seenSec = new Set();
  const outSections = [];
  for (const sec of sections) {
    const st = [];
    for (const t of sec.tiles) {
      if (seenSec.has(t.asin)) continue;
      seenSec.add(t.asin);
      st.push(t);
    }
    if (st.length) outSections.push({ title: sec.title, tiles: st.slice(0, 12) });
  }
  return { tiles: outTiles.slice(0, 72), sections: outSections.slice(0, 12) };
}

/* ================================================================== */
/* Product assembly                                                    */
/* ================================================================== */

function poolMode(pool) {
  /* the current price is usually the one repeated across buybox variants;
   * compare numerically so spacing/currency variants unify */
  if (!pool.length) return null;
  const counts = new Map();
  let best = pool[0];
  let bestN = 0;
  for (const p of pool) {
    const k = priceNum(p);
    const key = isNaN(k) ? p : Math.round(k * 100) / 100;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestN) {
      bestN = n;
      best = p;
    }
  }
  return best;
}

function assembleProduct(p) {
  const images = [];
  const seenIds = new Set();

  const imgId = (u) => {
    const m = String(u).match(/\/I\/([A-Za-z0-9_-]+)\./);
    return m ? m[1] : null;
  };
  const add = (u) => {
    if (!u || images.length >= 12) return;
    const big = fullSize(u);
    const id = imgId(big);
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    images.push(big);
  };

  if (p.mainImgCandidates.length) add(p.mainImgCandidates[0]);
  add(p.mainImg);
  for (const t of p.thumbSrcs) add(t);
  if (!images.length && p.ogImage) add(p.ogImage);

  const nonStruck = p.pricePool.filter((x) => !p.struckPool.includes(x));
  let price = poolMode(nonStruck) || p.struckPool[0] || p.buyboxPrice || null;
  /* JS-rendered buybox variant: fall back to the static offers price */
  if (!price && p.aodPrice && /^\$\d/.test(p.aodPrice)) price = 'from ' + p.aodPrice;
  let listPrice = p.struckPool.find((x) => x !== price) || null;
  if (price && listPrice && !(priceNum(listPrice) > priceNum(price))) listPrice = null;

  const bullets = p.bullets.length ? p.bullets : p.ogDesc ? [p.ogDesc] : [];

  /* --- detail key/value pairs (tables + bullet lists), deduped by key --- */
  const details = [];
  const seenKeys = new Set();
  for (const pair of p.detailPairs) {
    const k = String(pair[0] || '').replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
    const v = String(pair[1] || '').replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
    if (!k || !v) continue;
    const kl = k.toLowerCase();
    if (seenKeys.has(kl)) continue;
    seenKeys.add(kl);
    details.push([k.slice(0, 60), v.slice(0, 250)]);
  }

  /* --- A+ "from the manufacturer": deduped images + text --- */
  const aplusImgIds = new Set();
  const aplusImages = [];
  for (const u of p.aplusImgs) {
    if (aplusImages.length >= 10) break;
    const big = fullSize(u);
    const id = imgId(big);
    if (!id || aplusImgIds.has(id)) continue;
    aplusImgIds.add(id);
    aplusImages.push(big);
  }
  const aplus = { images: aplusImages, text: (p.aplusParas || []).slice(0, 14) };

  /* brand fallback: the byline is JS-rendered on some variants, but the
   * tech-spec table still carries "Brand Name : ..." */
  let brand = p.brand || '';
  if (!brand) {
    for (const kv of details) {
      if (/^\s*brand(\s+name)?\s*$/i.test(kv[0])) {
        brand = kv[1].slice(0, 60);
        break;
      }
    }
  }

  return {
    asin: p.asin,
    title: p.title || p.ogTitle || '',
    brand,
    price,
    listPrice,
    rating: p.rating,
    reviews: p.reviews || null,
    availability: p.availability || '',
    images,
    bullets,
    description: p.descParas.slice(0, 20),
    details,
    aplus,
    crumbs: p.crumbs,
  };
}

/* ================================================================== */
/* Endpoints                                                           */
/* ================================================================== */

/* ---------- filter monitor (amazon-admin.html) ---------- */

function safeEqual(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function handleAdmin(request, url, p, env, ctx) {
  const NO_STORE = { 'cache-control': 'no-store' };

  if (!ADMIN_PASSWORD) {
    return jsonResponse(
      { error: 'forbidden', message: 'The admin monitor is disabled (ADMIN_PASSWORD is empty).' },
      403,
      NO_STORE
    );
  }

  const key = request.headers.get('x-admin-key') || url.searchParams.get('adminKey') || '';
  if (!safeEqual(key, ADMIN_PASSWORD)) {
    return jsonResponse({ error: 'unauthorized', message: 'Bad or missing admin key' }, 401, NO_STORE);
  }

  await loadStats(env);

  const kvBound = !!(env && env.FILTER_STATS && typeof env.FILTER_STATS.get === 'function');

  /* ---------- live access keys (the monitor's Keys tab) ---------- */
  if (p === '/admin/keys' || p === '/admin/keys/delete') {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      return jsonResponse({ error: 'bad_request', message: 'GET or POST only' }, 405, NO_STORE);
    }

    if (p === '/admin/keys' && (request.method === 'GET' || request.method === 'HEAD')) {
      return jsonResponse(
        /* force=true: the monitor always sees the freshest KV list,
         * never this isolate's TTL cache */
        { ok: true, storage: kvBound ? 'kv' : 'memory', keys: await effectiveKeys(env, true) },
        200,
        NO_STORE
      );
    }

    let body = null;
    try {
      body = await request.json();
    } catch (e) {}
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'bad_request', message: 'JSON body required' }, 400, NO_STORE);
    }

    /* mutations start from a FRESH KV read (never the static fallback)
     * - this is what stops an add from wiping keys saved moments ago
     * from another isolate */
    const list = await savedKeyList(env);

    if (p === '/admin/keys/delete') {
      const id = String(body.id || '');
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return jsonResponse({ error: 'not_found', message: 'No key with that id' }, 404, NO_STORE);
      list.splice(i, 1);
      const saved = await commitKeyList(env, ctx, list, id);
      return jsonResponse({ ok: true, revoked: id, keys: saved }, 200, NO_STORE);
    }

    /* add or edit */
    const keyStr = String(body.key || '').trim();
    const label = String(body.label || '').trim().slice(0, 40);
    const profile = body.profile === 'filtered' ? 'filtered' : 'full';
    if (!keyStr || keyStr.length > 64) {
      return jsonResponse({ error: 'bad_request', message: 'Key must be 1-64 characters.' }, 400, NO_STORE);
    }

    let entry;
    if (body.id) {
      entry = list.find((x) => x.id === String(body.id));
      if (!entry) {
        return jsonResponse({ error: 'not_found', message: 'No key with that id' }, 404, NO_STORE);
      }
      if (list.some((x) => x !== entry && x.key === keyStr)) {
        return jsonResponse({ error: 'conflict', message: 'Another key already uses that text.' }, 409, NO_STORE);
      }
      entry.key = keyStr;
      entry.label = label || keyStr;
      entry.profile = profile;
      entry.updatedAt = Date.now();
    } else {
      if (list.some((x) => x.key === keyStr)) {
        return jsonResponse({ error: 'conflict', message: 'That key already exists.' }, 409, NO_STORE);
      }
      entry = {
        id: 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        key: keyStr,
        label: label || keyStr,
        profile,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      list.push(entry);
    }
    const saved = await commitKeyList(env, ctx, list);
    return jsonResponse({ ok: true, keys: saved }, 200, NO_STORE);
  }

  if (p === '/admin/events/delete') {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return jsonResponse({ error: 'bad_request', message: 'POST (or GET) only' }, 405, NO_STORE);
    }
    let body = null;
    try {
      body = await request.json();
    } catch (e) {}
    const id = String((body && body.id) || url.searchParams.get('id') || '');
    if (!id || id.length > 64) {
      return jsonResponse({ error: 'bad_request', message: 'Missing event id' }, 400, NO_STORE);
    }
    const had = stats.events.some((ev) => ev && ev.id === id);
    stats.events = stats.events.filter((ev) => ev && ev.id !== id);
    /* tombstone: isolates that still hold this event must not write it
     * back on their next read-merge-write */
    deletedIds.add(id);
    pruneDeletedIds();
    await persistStats(env, ctx, true);
    return jsonResponse(
      { ok: true, deleted: id, removed: had ? 1 : 0, storage: kvBound ? 'kv' : 'memory' },
      200,
      NO_STORE
    );
  }

  if (p === '/admin/stats') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'bad_request', message: 'GET only' }, 405, NO_STORE);
    }
    const view = await adminStatsView(env);
    const events = view.events.slice().reverse(); /* newest first */
    const topQueries = Object.keys(view.queryCounts)
      .map((k) => [k, view.queryCounts[k]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    return jsonResponse(
      {
        ok: true,
        storage: kvBound ? 'kv' : 'memory',
        since: view.since,
        now: Date.now(),
        totals: view.totals,
        topQueries,
        keyTotals: view.keyTotals,
        keys: await effectiveKeys(env, true), /* fresh: the monitor sees the truth */
        events,
      },
      200,
      NO_STORE
    );
  }

  if (p === '/admin/stats/reset') {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return jsonResponse({ error: 'bad_request', message: 'POST (or GET) only' }, 405, NO_STORE);
    }
    stats.since = Date.now();
    stats.events = [];
    /* no counters to zero - every number is derived from the events */
    clearedTs = Date.now();
    try {
      if (env && env.FILTER_STATS && typeof env.FILTER_STATS.put === 'function') {
        /* tombstone first: late writers from other isolates drop
         * anything older than this instead of resurrecting it */
        await env.FILTER_STATS.put(STATS_CLEARED_KV_KEY, String(clearedTs));
        if (typeof env.FILTER_STATS.delete === 'function') {
          const d = env.FILTER_STATS.delete(STATS_KV_KEY).catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(d);
          else await d;
        }
      }
    } catch (e) {}
    return jsonResponse({ ok: true, cleared: true }, 200, NO_STORE);
  }

  return jsonResponse({ error: 'not_found', message: 'Unknown admin route' }, 404, NO_STORE);
}

/* ---------- search ---------- */

/* FIRST PAGE ONLY. The worker used to let the app paginate (and the app
 * auto-pulled up to 5 pages hunting for clean leftovers whenever Normal
 * Mode emptied a page). Not anymore: one page is fetched, and when the
 * filter removes most of it the WHOLE request is denied instead of
 * digging for the few nitpick products whose titles happen to be
 * worded cleanly. Deny when more results were blocked than allowed,
 * or when at least this share of the page was blocked (the user's
 * "like 60%"): */
const SEARCH_DENY_RATIO = 0.6;

async function handleSearch(url, ctx, profile, env, akey) {
  const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const i = url.searchParams.get('i') || '';
  if (!q) return jsonResponse({ error: 'bad_request', message: 'Missing q parameter' }, 400);

  /* the worker only ever loads the first page now - a page parameter
   * from an old app session is ignored (the response always says
   * hasMore:false, so current apps never ask for a second one) */
  const page = 1;

  const idx = /^[a-z0-9-]{2,32}$/.test(i) ? i : '';

  const wordHit = queryBlockedTerm(q);
  const deptHit = idx && BLOCKED_DEPTS.indexOf(idx) >= 0 ? idx : null;
  let queryCaught = false; /* a caught query logs exactly ONE search event */
  if (wordHit || deptHit) {
    queryCaught = true;
    const reason = wordHit || deptHit;
    const via = wordHit ? 'word' : 'category';
    if (profile === 'filtered') {
      logStats(env, ctx, { type: 'search', q, reason, via, outcome: 'blocked', key: akey });
      return jsonResponse(
        { q, i: idx, page, blocked: true, results: [], hasMore: false, message: 'The worker denied this search.' },
        200,
        { 'cache-control': 'no-store' }
      );
    }
    /* Unrestricted key: nothing is hidden, but the would-be catch is
     * logged as flagged so the monitor shows who searched it */
    logStats(env, ctx, { type: 'search', q, reason, via, outcome: 'flagged', flagged: true, key: akey });
  }

  const target = '/s?k=' + encodeURIComponent(q) + (idx ? '&i=' + idx : '') + '&page=' + page;

  /* the RAW tile list is cached (one entry serves both profiles); Safe
   * Mode filtering + logging run on every request so each attempt is
   * recorded, cache hit or not */
  const data = await cachedData(ctx, 'search|' + q.toLowerCase() + '|' + idx + '|' + page, TTL.search, async () => {
    const html = await getAmazonHTML(target);
    const { tiles } = await runExtractor(html, 'search', null);
    /* A page the relay could not read must NEVER look like "no results":
     * only Amazon's genuine empty page is an empty answer. Anything
     * else zero-tile was a bot wall we did not recognize - say so. */
    if (!tiles.length && !EMPTY_SEARCH_RE.test(html)) {
      throw new BlockedError('Search page was not readable');
    }
    return { tiles };
  });

  let results = data.tiles;
  if (profile === 'filtered') {
    const kept = [];
    const removed = [];
    for (const t of data.tiles) {
      const term = tileBlockedTerm(t);
      if (term) removed.push({ title: String(t.title || '').slice(0, 140), asin: t.asin, reason: term });
      else kept.push(t);
    }
    const total = data.tiles.length;
    const blockedN = removed.length;
    const keptN = kept.length;
    /* the whole-request deny: mostly-blocked page (or more blocked than
     * allowed) means the search is clearly after something the filter
     * refuses to serve - no digging through deeper pages for leftovers */
    if (total && (blockedN > keptN || blockedN >= Math.ceil(SEARCH_DENY_RATIO * total))) {
      logStats(env, ctx, {
        type: 'search',
        q,
        reason: 'page',
        via: 'ratio',
        outcome: 'denied',
        blocked: blockedN,
        shown: keptN,
        total,
        key: akey,
      });
      return jsonResponse(
        { q, i: idx, page, blocked: true, results: [], hasMore: false, message: 'The worker denied this search.' },
        200,
        { 'cache-control': 'no-store' }
      );
    }
    results = kept;
    if (removed.length) {
      logStats(env, ctx, {
        type: 'results',
        source: 'search',
        q,
        page,
        removed: removed.slice(0, 25),
        count: removed.length,
        shown: kept.length,
        key: akey,
      });
    }
    /* clean searches are logged too - who searched what, and that it
     * went through (this is the bypass-hunting record) */
    logStats(env, ctx, { type: 'search', q, outcome: 'shown', shown: keptN, key: akey });
  } else {
    /* Unrestricted key: every tile is shown, but the ones the filter
     * WOULD remove are logged as flagged ("not blocked, shown") */
    const flagged = [];
    for (const t of data.tiles) {
      const term = tileBlockedTerm(t);
      if (term) flagged.push({ title: String(t.title || '').slice(0, 140), asin: t.asin, reason: term });
    }
    if (flagged.length) {
      logStats(env, ctx, {
        type: 'results',
        source: 'search',
        q,
        page,
        removed: flagged.slice(0, 25),
        count: flagged.length,
        shown: data.tiles.length,
        flagged: true,
        key: akey,
      });
    }
    /* a caught query already logged its flagged event above - a clean
     * run is the only case that logs "shown" */
    if (!queryCaught) {
      logStats(env, ctx, { type: 'search', q, outcome: 'shown', shown: data.tiles.length, key: akey });
    }
  }
  /* first page only: there is never a second page to pull */
  return jsonResponse({ q, i: idx, page, results, hasMore: false });
}

/* ---------- product ---------- */

async function handleProduct(url, ctx, profile, env, akey) {
  const m = url.pathname.match(/^\/api\/product\/([A-Z0-9]{10})$/i);
  if (!m) return jsonResponse({ error: 'bad_request', message: 'Bad ASIN' }, 400);
  const asin = m[1].toUpperCase();

  /* the RAW product is cached (shared by both profiles); the filter
   * verdict, sanitize and logging run on every request */
  const data = await cachedData(ctx, 'product|' + asin, TTL.product, async () => {
    const html = await getAmazonHTML('/dp/' + asin);
    const { product, related } = await runExtractor(html, 'product', asin);
    if (!product.title && !product.images.length && !related.length) {
      throw new NotFoundError('Product not found or page not parseable');
    }
    return { product, related };
  });

  const term = productBlockedTerm(data.product);
  if (profile === 'filtered') {
    if (term) {
      logStats(env, ctx, {
        type: 'product',
        asin,
        title: String(data.product.title || '').slice(0, 140),
        reason: term,
        key: akey,
      });
      return jsonResponse(
        { asin, blocked: true, message: 'The worker denied this item.' },
        200,
        { 'cache-control': 'no-store' }
      );
    }
    return jsonResponse(sanitizeProduct(data.product, data.related));
  }
  /* Unrestricted key: the item is shown anyway, but noted as flagged */
  if (term) {
    logStats(env, ctx, {
      type: 'product',
      asin,
      title: String(data.product.title || '').slice(0, 140),
      reason: term,
      flagged: true,
      key: akey,
    });
  }
  return jsonResponse({ ...data.product, related: data.related });
}

/* ---------- cache wipe ---------- */

/* Bumps the cache generation: every cached search, product and chart
 * becomes unreachable and the next request re-fetches from Amazon.
 * Any valid access key may call it (the app does so automatically when
 * the key changes, so switching between Safe Mode and full access
 * always gives accurate results). */
function handleCacheWipe(url, ctx, env) {
  cacheGen++;
  try {
    if (env && env.FILTER_STATS && typeof env.FILTER_STATS.put === 'function') {
      const put = env.FILTER_STATS.put(CACHE_GEN_KV_KEY, String(cacheGen)).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    }
  } catch (e) {}
  return jsonResponse({ ok: true, wiped: true, generation: cacheGen }, 200, {
    'cache-control': 'no-store',
  });
}

/* ---------- charts ---------- */

/* Chart pages (bestsellers / new releases / movers) are stacks of
 * category carousels: "New Releases in Kitchen & Dining", "... in
 * Clothing, Shoes & Jewelry", ... Strip the chart-type prefix so the
 * app can show a small, clean label above each group. */
function cleanSectionTitle(t) {
  return String(t || '')
    .replace(
      /^(?:amazon\s+)?(?:new releases|best sellers|movers\s*(?:&|and)?\s*shakers|most\s*wished\s*for|most\s*gifted)\s+in\s+/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

async function handleBrowse(url, ctx, profile, env, akey) {
  const typeRaw = url.searchParams.get('type') || 'bestsellers';
  const type = BROWSE_TYPES[typeRaw] || 'bestsellers';
  const cat = (url.searchParams.get('cat') || '').toLowerCase();
  const catOk = /^[a-z0-9-]{2,40}$/.test(cat) ? cat : '';
  const target = '/gp/' + type + (catOk ? '/' + catOk : '');

  const data = await cachedData(ctx, 'browse|' + type + '|' + catOk, TTL.browse, async () => {
    const html = await getAmazonHTML(target);
    const { tiles, sections } = await runExtractor(html, 'browse', null);
    /* charts always contain tiles; zero means we were walled */
    if (!tiles.length) throw new BlockedError('Chart page was not readable');
    return { tiles, sections };
  });

  /* split the raw tiles into labeled sections (falling back to one
   * flat list when the page had no headings we recognized) */
  const rawSections =
    data.sections && data.sections.length
      ? data.sections
      : [{ title: '', tiles: data.tiles }];

  let sections = rawSections.map((s) => ({
    title: cleanSectionTitle(s.title),
    items: s.tiles,
  }));

  let items = data.tiles;
  if (profile === 'filtered') {
    const keptAll = [];
    const removed = [];
    sections = sections
      .map((s) => {
        const kept = [];
        for (const t of s.items || []) {
          const term = tileBlockedTerm(t);
          if (term) removed.push({ title: String(t.title || '').slice(0, 140), asin: t.asin, reason: term });
          else kept.push(t);
        }
        keptAll.push(...kept);
        return { title: s.title, items: kept };
      })
      /* sections whose every item was filtered away disappear */
      .filter((s) => s.items.length);
    items = keptAll;
    if (removed.length) {
      logStats(env, ctx, {
        type: 'results',
        source: 'browse',
        q: type + (catOk ? ' - ' + catOk : ''),
        removed: removed.slice(0, 25),
        count: removed.length,
        shown: keptAll.length,
        key: akey,
      });
    }
  } else {
    /* Unrestricted key: nothing is dropped from the chart, but items
     * the filter WOULD remove are logged as flagged */
    const flagged = [];
    for (const s of sections) {
      for (const t of s.items || []) {
        const term = tileBlockedTerm(t);
        if (term) flagged.push({ title: String(t.title || '').slice(0, 140), asin: t.asin, reason: term });
      }
    }
    if (flagged.length) {
      logStats(env, ctx, {
        type: 'results',
        source: 'browse',
        q: type + (catOk ? ' - ' + catOk : ''),
        removed: flagged.slice(0, 25),
        count: flagged.length,
        shown: items.length,
        flagged: true,
        key: akey,
      });
    }
  }
  return jsonResponse({ type, cat: catOk, items, sections });
}
