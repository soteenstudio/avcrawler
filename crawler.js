'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const axios = require('axios');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');

// ============================================================
// KONFIGURASI (semua bisa dioverride lewat environment variable)
// ============================================================
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles'); // 1 file per hari: YYYY-MM-DD.jsonl

const CONFIG = {
    // Cantumkan kontak asli supaya admin web bisa menghubungi kamu kalau ada masalah
    userAgent: process.env.CRAWLER_UA || 'PoliteBot/3.0 (+https://github.com/username/repo; contact: you@example.com)',
    robotsToken: 'PoliteBot',

    // --- Kesopanan ---
    baseDelayMs: num(process.env.CRAWL_DELAY_MS, 4000), // jeda minimum antar request KE HOST YANG SAMA
    maxDelayMs: 30000,
    jitterMs: 1000,
    timeoutMs: 10000,
    maxBytes: 5 * 1024 * 1024,
    sitemapMaxBytes: 20 * 1024 * 1024,
    maxRetries: 3,
    robotsTtlMs: 24 * 60 * 60 * 1000,
    robotsFailTtlMs: 60 * 60 * 1000,
    breakerThreshold: 3,
    breakerPauseMs: 30 * 60 * 1000,

    // --- Volume (inilah "tuas" untuk naik/turun skala) ---
    maxPagesPerHost: num(process.env.MAX_PAGES_PER_HOST, 120),        // batas halaman per host per run
    dailyBudgetPerHost: num(process.env.DAILY_BUDGET_PER_HOST, 600),  // batas keras per host per hari
    lookbackHours: num(process.env.LOOKBACK_HOURS, 48),               // hanya ambil URL baru dari sitemap/RSS
    maxDiscoveryFetches: num(process.env.MAX_DISCOVERY_FETCHES, 8),   // batas request sitemap/RSS per host per run (sitemap bisa besar!)
    maxSitemapsPerIndex: 4,

    // --- Cooldown & data ---
    seedCooldownHours: 5, // sedikit di bawah interval cron (6 jam)
    historyRetentionDays: 14,
    maxLinksStored: 40,
    textPreviewChars: 400,
    flushIntervalMs: 15000
};

// Satu entri per situs. Opsional: "sitemaps": [...], "feeds": [...] kalau kamu tahu URL-nya.
// Kalau kosong, sitemap diambil dari robots.txt dan RSS dari <link rel="alternate"> di homepage.
const DEFAULT_SITES = [
    { seed: 'https://www.kompas.com' },
    { seed: 'https://www.detik.com' },
    { seed: 'https://www.antaranews.com' },
    { seed: 'https://www.tempo.co' },
    { seed: 'https://www.republika.co.id' }
];
const SITES = process.env.SITES_JSON ? JSON.parse(process.env.SITES_JSON) : DEFAULT_SITES;

const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|igshid|mc_cid|mc_eid|ref|source|campaign)$/i;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|mp4|mp3|zip|rar|xml|json)(\?|$)/i;

// ============================================================
// STATE GLOBAL
// ============================================================
const state = {
    history: null,
    buffer: [],   // record yang menunggu ditulis ke file harian
    dirty: false,
    stopping: false,
    stats: { attempted: 0, saved: 0, unchanged: 0, notModified: 0, errors: 0, blocked: 0, bytes: 0 }
};

// ============================================================
// UTIL
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
const todayUtc = () => new Date().toISOString().slice(0, 10);

const hostKey = (url) => new URL(url).hostname.replace(/^www\./, '');

function normalizeUrl(href) {
    const u = new URL(href);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    let out = u.toString();
    if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    return out;
}

function isSameSite(url, siteSeed) {
    try {
        const h = hostKey(url);
        const root = hostKey(siteSeed);
        return h === root || h.endsWith(`.${root}`);
    } catch (_) {
        return false;
    }
}

function parseRetryAfter(value) {
    if (!value) return null;
    const secs = Number(value);
    if (!Number.isNaN(secs)) return secs * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function parseDate(s) {
    if (!s) return null;
    const t = Date.parse(String(s).trim());
    return Number.isNaN(t) ? null : t;
}

const withinLookback = (ts) => ts === null || ts >= Date.now() - CONFIG.lookbackHours * 3600000;

// ============================================================
// HISTORY + PENULISAN DATA (atomic, dengan flush berkala)
// ============================================================
function loadHistory() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(HISTORY_PATH)) return { urls: {}, domains: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
        if (raw.urls) return { urls: raw.urls, domains: raw.domains || {} };
        return { urls: raw, domains: {} }; // format v1
    } catch (e) {
        const backup = `${HISTORY_PATH}.corrupt-${Date.now()}`;
        fs.renameSync(HISTORY_PATH, backup);
        log('WARN', `history.json rusak, dipindah ke ${path.basename(backup)}`);
        return { urls: {}, domains: {} };
    }
}

function saveHistory(history) {
    const tmp = `${HISTORY_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 1));
    fs.renameSync(tmp, HISTORY_PATH); // atomic: file tidak pernah setengah tertulis
}

// Buang entri lama supaya history.json tidak membengkak (seed selalu dipertahankan)
function pruneHistory(history) {
    const cutoff = Date.now() - CONFIG.historyRetentionDays * 86400000;
    const seeds = new Set(SITES.map((s) => s.seed));
    let removed = 0;
    for (const [url, entry] of Object.entries(history.urls)) {
        if (!seeds.has(url) && (entry.timestamp || 0) < cutoff) {
            delete history.urls[url];
            removed++;
        }
    }
    if (removed) {
        state.dirty = true;
        log('PRUNE', `${removed} entri history lama (> ${CONFIG.historyRetentionDays} hari) dibuang`);
    }
}

// Tulis record yang tertahan di buffer, LALU history. Urutan ini disengaja:
// kalau proses mati di antaranya, risikonya duplikat (aman), bukan data hilang.
function flush() {
    if (state.buffer.length) {
        fs.mkdirSync(ARTICLES_DIR, { recursive: true });
        const file = path.join(ARTICLES_DIR, `${todayUtc()}.jsonl`);
        fs.appendFileSync(file, state.buffer.join('\n') + '\n');
        state.buffer = [];
    }
    if (state.dirty) {
        saveHistory(state.history);
        state.dirty = false;
    }
}

// ============================================================
// POLITENESS: rate limiter per host (antrean serial) + adaptive throttle
// ============================================================
const lastRequestAt = new Map();
const hostDelay = new Map();   // dari crawl-delay robots.txt
const extraDelay = new Map();  // penalti adaptif
const hostLocks = new Map();   // antrean promise per host: mustahil 2 request ke host sama "menyalip" jeda

function currentDelay(host) {
    const base = Math.max(CONFIG.baseDelayMs, hostDelay.get(host) || 0);
    return Math.min(CONFIG.maxDelayMs, base + (extraDelay.get(host) || 0));
}

function waitForHost(host) {
    const prev = hostLocks.get(host) || Promise.resolve();
    const next = prev.then(async () => {
        const jitter = Math.random() * CONFIG.jitterMs;
        const wait = (lastRequestAt.get(host) || 0) + currentDelay(host) + jitter - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt.set(host, Date.now());
    });
    hostLocks.set(host, next.catch(() => {}));
    return next;
}

function adaptThrottle(host, status, elapsedMs) {
    const extra = extraDelay.get(host) || 0;
    if (status === 429 || status >= 500 || status === 0 || elapsedMs > 3000) {
        extraDelay.set(host, Math.min(CONFIG.maxDelayMs, extra ? extra * 2 : 2000));
    } else if (extra > 0) {
        extraDelay.set(host, extra < 500 ? 0 : Math.floor(extra / 2));
    }
}

async function politeGet(url, extraHeaders = {}, opts = {}) {
    const host = hostKey(url);
    const maxBytes = opts.maxBytes || CONFIG.maxBytes;
    let lastErr;

    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
        if (state.stopping) {
            const err = new Error('Dihentikan karena shutdown');
            err.code = 'SHUTDOWN';
            throw err;
        }
        await waitForHost(host);
        const started = Date.now();
        try {
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': CONFIG.userAgent,
                    Accept: opts.binary
                        ? 'application/xml,text/xml,application/rss+xml,application/atom+xml,application/gzip,*/*;q=0.5'
                        : 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
                    'Accept-Language': 'id,en;q=0.8',
                    ...extraHeaders
                },
                timeout: CONFIG.timeoutMs,
                maxRedirects: 5,
                maxContentLength: maxBytes,
                maxBodyLength: maxBytes,
                responseType: opts.binary ? 'arraybuffer' : 'text',
                transformResponse: [(d) => d],
                validateStatus: () => true
            });
            res.elapsedMs = Date.now() - started;
            // Ukuran setelah didekompres (data di kabel biasanya 3-5x lebih kecil karena gzip)
            state.stats.bytes += res.data ? (typeof res.data === 'string' ? Buffer.byteLength(res.data) : res.data.length) : 0;
            adaptThrottle(host, res.status, res.elapsedMs);

            const retryable = res.status === 429 || res.status >= 500;
            if (retryable && attempt < CONFIG.maxRetries) {
                const retryAfter = parseRetryAfter(res.headers['retry-after']);
                const backoff = Math.min(60000, retryAfter ?? 2000 * 2 ** attempt);
                log('RETRY', `${url} -> HTTP ${res.status}, coba lagi ${Math.round(backoff / 1000)}s (percobaan ${attempt + 1})`);
                await sleep(backoff);
                continue;
            }
            return res;
        } catch (e) {
            lastErr = e;
            adaptThrottle(host, 0, 0);
            if (/maxContentLength|maxBodyLength/i.test(e.message)) throw new Error('Respons terlalu besar');
            if (attempt < CONFIG.maxRetries) {
                const backoff = Math.min(30000, 2000 * 2 ** attempt) + Math.random() * 500;
                log('RETRY', `${url} -> ${e.message}, coba lagi ${Math.round(backoff / 1000)}s`);
                await sleep(backoff);
            }
        }
    }
    throw lastErr || new Error('Gagal setelah beberapa percobaan');
}

// ============================================================
// ROBOTS.TXT
// ============================================================
const robotsCache = new Map();

async function getRobots(url) {
    const origin = new URL(url).origin;
    const cached = robotsCache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < cached.ttl) return cached;

    const robotsUrl = `${origin}/robots.txt`;
    let entry;
    try {
        const res = await politeGet(robotsUrl);
        if (res.status === 200) {
            const robots = robotsParser(robotsUrl, String(res.data));
            const delay = robots.getCrawlDelay(CONFIG.robotsToken);
            if (delay) hostDelay.set(hostKey(url), Math.min(CONFIG.maxDelayMs, delay * 1000));
            entry = { mode: 'rules', robots, sitemaps: robots.getSitemaps(), ttl: CONFIG.robotsTtlMs };
        } else if (res.status >= 400 && res.status < 500) {
            entry = { mode: 'allow_all', sitemaps: [], ttl: CONFIG.robotsTtlMs };
        } else {
            entry = { mode: 'disallow_all', sitemaps: [], ttl: CONFIG.robotsFailTtlMs };
        }
    } catch (e) {
        entry = { mode: 'disallow_all', sitemaps: [], ttl: CONFIG.robotsFailTtlMs };
    }
    entry.fetchedAt = Date.now();
    robotsCache.set(origin, entry);
    return entry;
}

async function isAllowed(url) {
    const entry = await getRobots(url);
    if (entry.mode === 'allow_all') return true;
    if (entry.mode === 'disallow_all') return false;
    return entry.robots.isAllowed(url, CONFIG.robotsToken) !== false;
}

// ============================================================
// CIRCUIT BREAKER + BUDGET HARIAN per host
// ============================================================
const hostState = (history, host) => (history.domains[host] ||= { failures: 0, blockedUntil: 0 });

function breakerOpen(history, host) {
    const d = history.domains[host];
    return d && d.blockedUntil && Date.now() < d.blockedUntil;
}

function recordHostResult(history, host, ok) {
    const d = hostState(history, host);
    if (ok) {
        d.failures = 0;
        d.blockedUntil = 0;
    } else if (++d.failures >= CONFIG.breakerThreshold) {
        d.blockedUntil = Date.now() + CONFIG.breakerPauseMs;
        log('BREAKER', `${host} gagal ${d.failures}x beruntun, diistirahatkan ${CONFIG.breakerPauseMs / 60000} menit`);
    }
    state.dirty = true;
}

function budgetLeft(history, host) {
    const d = hostState(history, host);
    if (!d.daily || d.daily.date !== todayUtc()) d.daily = { date: todayUtc(), count: 0 };
    return CONFIG.dailyBudgetPerHost - d.daily.count;
}

function spendBudget(history, host) {
    budgetLeft(history, host); // pastikan counter hari ini ada
    history.domains[host].daily.count++;
    state.dirty = true;
}

// ============================================================
// EKSTRAKSI HALAMAN
// ============================================================
const meta = ($, ...names) => {
    for (const n of names) {
        const v = $(`meta[property="${n}"], meta[name="${n}"]`).first().attr('content');
        if (v && v.trim()) return v.trim();
    }
    return null;
};

function extractJsonLd($) {
    const items = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).html());
            const arr = Array.isArray(data) ? data : data['@graph'] || [data];
            arr.forEach((x) => x && typeof x === 'object' && items.push(x));
        } catch (_) { /* JSON-LD rusak, abaikan */ }
    });
    return items;
}

const personName = (a) => {
    if (!a) return null;
    if (Array.isArray(a)) return a.map(personName).filter(Boolean).join(', ') || null;
    return typeof a === 'string' ? a : a.name || null;
};

function extractMainText($) {
    const $c = $.root().clone();
    $c.find('script,style,noscript,nav,footer,header,aside,form,iframe,svg').remove();
    const pick = ['article', 'main', 'body'].map((s) => $c.find(s).first()).find((n) => n.length);
    return (pick ? pick.text() : '').replace(/\s+/g, ' ').trim();
}

function extractLinks($, baseUrl) {
    const seen = new Set();
    const out = [];
    $('a[href]').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text.length < 25) return;
        if (/nofollow/i.test($(el).attr('rel') || '')) return;
        let u;
        try { u = new URL($(el).attr('href'), baseUrl); } catch (_) { return; }
        if (!/^https?:$/.test(u.protocol)) return;
        if (!isSameSite(u.href, baseUrl)) return;
        if (u.pathname === '/' || SKIP_EXT.test(u.pathname)) return;
        const n = normalizeUrl(u.href);
        if (seen.has(n)) return;
        seen.add(n);
        out.push({ url: n, text: text.slice(0, 200) });
    });
    return out.slice(0, CONFIG.maxLinksStored);
}

function extractPage($, url, kind) {
    const jsonld = extractJsonLd($);
    const article = jsonld.find((i) => [].concat(i['@type'] || []).some((t) => /Article|BlogPosting|Report/i.test(t)));
    const text = extractMainText($);
    const feeds = [];
    $('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]').each((_, el) => {
        try { feeds.push(new URL($(el).attr('href'), url).href); } catch (_) {}
    });

    return {
        url,
        kind,
        title: ($('title').first().text() || '').trim() || null,
        description: meta($, 'description', 'og:description'),
        canonical: $('link[rel="canonical"]').attr('href') || null,
        lang: $('html').attr('lang') || null,
        og: {
            title: meta($, 'og:title'),
            type: meta($, 'og:type'),
            image: meta($, 'og:image'),
            siteName: meta($, 'og:site_name')
        },
        author: personName(article && article.author) || meta($, 'author', 'article:author'),
        publishedAt: (article && article.datePublished) || meta($, 'article:published_time', 'pubdate', 'date'),
        modifiedAt: (article && article.dateModified) || meta($, 'article:modified_time'),
        section: (article && article.articleSection) || meta($, 'article:section'),
        keywords: meta($, 'keywords', 'news_keywords'),
        schemaTypes: [...new Set(jsonld.flatMap((i) => [].concat(i['@type'] || [])))],
        headings: {
            h1: $('h1').slice(0, 3).map((_, e) => $(e).text().trim()).get(),
            h2: kind === 'seed' ? $('h2').slice(0, 10).map((_, e) => $(e).text().replace(/\s+/g, ' ').trim()).get() : undefined
        },
        wordCount: text ? text.split(' ').length : 0,
        textPreview: text.slice(0, CONFIG.textPreviewChars),
        feeds,
        contentHash: sha256(text.slice(0, 200000)),
        links: kind === 'seed' ? extractLinks($, url) : undefined
    };
}

// ============================================================
// DISCOVERY: sitemap (termasuk news sitemap & index), RSS, Atom
// ============================================================
async function fetchXml(url) {
    if (!(await isAllowed(url))) {
        log('BLOCKED', `${url} (discovery)`);
        return null;
    }
    const res = await politeGet(url, {}, { binary: true, maxBytes: CONFIG.sitemapMaxBytes });
    if (res.status !== 200) {
        log('DISCOVERY', `${url} -> HTTP ${res.status}`);
        return null;
    }
    let buf = Buffer.from(res.data);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: 50 * 1024 * 1024 });
    return buf.toString('utf8');
}

function parseDiscoveryDoc(xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    const out = { sitemaps: [], entries: [] };

    // <sitemapindex>
    $('sitemapindex > sitemap').each((_, el) => {
        const loc = $(el).find('loc').first().text().trim();
        if (loc) out.sitemaps.push({ url: loc, lastmod: parseDate($(el).find('lastmod').first().text()) });
    });

    // <urlset> (termasuk ekstensi Google News)
    $('urlset > url').each((_, el) => {
        const loc = $(el).find('loc').first().text().trim();
        if (!loc) return;
        const newsDate = $(el).find('news\\:publication_date').first().text();
        out.entries.push({
            url: loc,
            date: parseDate(newsDate) ?? parseDate($(el).find('lastmod').first().text()),
            title: $(el).find('news\\:title').first().text().trim() || null,
            keywords: $(el).find('news\\:keywords').first().text().trim() || null
        });
    });

    // RSS 2.0
    $('rss channel item').each((_, el) => {
        const loc = $(el).find('link').first().text().trim();
        if (!loc) return;
        out.entries.push({
            url: loc,
            date: parseDate($(el).find('pubDate').first().text()),
            title: $(el).find('title').first().text().trim() || null,
            keywords: $(el).find('category').map((_, c) => $(c).text().trim()).get().join(', ') || null
        });
    });

    // Atom
    $('feed > entry').each((_, el) => {
        const link = $(el).find('link[rel="alternate"]').first().attr('href') || $(el).find('link').first().attr('href');
        if (!link) return;
        out.entries.push({
            url: link,
            date: parseDate($(el).find('published').first().text()) ?? parseDate($(el).find('updated').first().text()),
            title: $(el).find('title').first().text().trim() || null,
            keywords: null
        });
    });

    return out;
}

// Kumpulkan kandidat URL artikel untuk satu situs: homepage -> sitemap/RSS (terbaru dulu)
async function discoverHost(site, history, seedRecord) {
    const found = new Map(); // url -> hint
    const add = (rawUrl, hint) => {
        let url;
        try { url = normalizeUrl(rawUrl); } catch (_) { return; }
        if (!isSameSite(url, site.seed) || SKIP_EXT.test(new URL(url).pathname)) return;
        if (url === site.seed || found.has(url)) return;
        const h = history.urls[url];
        if (h && h.status !== 'error') return; // artikel yang sudah pernah diproses tidak dicrawl ulang
        found.set(url, hint);
    };

    // 1. Link headline dari homepage (prioritas tertinggi)
    for (const l of (seedRecord && seedRecord.links) || []) add(l.url, { source: 'homepage', anchorText: l.text });

    // 2. Sitemap + feed
    const robots = await getRobots(site.seed);
    const queue = [
        ...new Set([...(site.sitemaps || []), ...robots.sitemaps]),
        ...new Set([...(site.feeds || []), ...((seedRecord && seedRecord.feeds) || [])])
    ];
    if (!queue.length) queue.push(`${new URL(site.seed).origin}/sitemap.xml`); // tebakan terakhir

    const visited = new Set();
    let fetches = 0;
    while (queue.length && fetches < CONFIG.maxDiscoveryFetches && !state.stopping) {
        const docUrl = queue.shift();
        if (visited.has(docUrl) || !isSameSite(docUrl, site.seed)) continue;
        visited.add(docUrl);
        fetches++;

        let xml;
        try {
            xml = await fetchXml(docUrl);
        } catch (e) {
            if (e.code === 'SHUTDOWN') break;
            log('DISCOVERY', `${docUrl}: ${e.message}`);
            continue;
        }
        if (!xml) continue;

        let parsed;
        try { parsed = parseDiscoveryDoc(xml); } catch (e) { log('DISCOVERY', `${docUrl}: gagal parse (${e.message})`); continue; }

        // sitemap index: pilih anak yang baru / bernama "news", urutkan terbaru dulu
        const children = parsed.sitemaps
            .filter((s) => withinLookback(s.lastmod))
            .sort((a, b) => (/news|berita|latest/i.test(b.url) - /news|berita|latest/i.test(a.url)) || (b.lastmod || 0) - (a.lastmod || 0))
            .slice(0, CONFIG.maxSitemapsPerIndex);
        queue.unshift(...children.map((s) => s.url));

        for (const e of parsed.entries) {
            if (!withinLookback(e.date)) continue;
            add(e.url, {
                source: path.basename(docUrl).replace(/\?.*/, ''),
                lastmod: e.date ? new Date(e.date).toISOString() : null,
                listedTitle: e.title,
                listedKeywords: e.keywords
            });
        }
    }

    // Homepage tetap di depan; sisanya terbaru dulu (tanpa tanggal di belakang)
    const all = [...found.entries()].map(([url, hint]) => ({ url, hint }));
    const front = all.filter((c) => c.hint.source === 'homepage');
    const rest = all
        .filter((c) => c.hint.source !== 'homepage')
        .sort((a, b) => (Date.parse(b.hint.lastmod) || 0) - (Date.parse(a.hint.lastmod) || 0));
    log('DISCOVERY', `${hostKey(site.seed)}: ${front.length} dari homepage + ${rest.length} dari sitemap/RSS (${fetches} request)`);
    return [...front, ...rest];
}

// ============================================================
// PIPELINE SATU URL
// Mengembalikan { attempted, record, stop }
// ============================================================
async function processUrl(history, url, kind, hint) {
    const host = hostKey(url);
    const now = Date.now();
    const prev = history.urls[url] || {};
    const skip = { attempted: false, record: null };

    // 1. Cooldown (khusus seed & URL yang pernah error; artikel sukses sudah disaring di discovery)
    let cooldownH = null;
    if (prev.status === 'error') cooldownH = Math.min(24, 2 ** (prev.consecutiveErrors || 1));
    else if (kind === 'seed') cooldownH = CONFIG.seedCooldownHours;
    if (cooldownH !== null && prev.timestamp && (now - prev.timestamp) / 3600000 < cooldownH) {
        log('SKIP', `${url} (cooldown ${cooldownH}j)`);
        return skip;
    }

    // 2. Circuit breaker & budget harian
    if (breakerOpen(history, host)) {
        log('SKIP', `${url} (host ${host} sedang diistirahatkan)`);
        return { ...skip, stop: true };
    }
    if (budgetLeft(history, host) <= 0) {
        log('BUDGET', `${host} sudah mencapai batas ${CONFIG.dailyBudgetPerHost} halaman hari ini`);
        return { ...skip, stop: true };
    }

    // 3. robots.txt
    if (!(await isAllowed(url))) {
        log('BLOCKED', url);
        state.stats.blocked++;
        history.urls[url] = { timestamp: now, status: 'blocked_by_robots' };
        state.dirty = true;
        return skip;
    }

    // 4. Fetch (conditional GET hanya untuk seed; artikel tidak dicrawl ulang)
    const cond = {};
    if (kind === 'seed' && prev.etag) cond['If-None-Match'] = prev.etag;
    if (kind === 'seed' && prev.lastModified) cond['If-Modified-Since'] = prev.lastModified;

    spendBudget(history, host);
    state.stats.attempted++;
    log('CRAWL', url);

    try {
        const res = await politeGet(url, cond);

        if (res.status === 304) {
            state.stats.notModified++;
            history.urls[url] = { ...prev, timestamp: now, status: 'not_modified', consecutiveErrors: 0 };
            recordHostResult(history, host, true);
            return { attempted: true, record: null };
        }
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);

        const ctype = String(res.headers['content-type'] || '');
        if (!/html|xml/i.test(ctype)) throw new Error(`Content-Type tidak didukung: ${ctype || 'kosong'}`);

        const xRobots = String(res.headers['x-robots-tag'] || '');
        const $ = cheerio.load(res.data);
        const metaRobots = String($('meta[name="robots"]').attr('content') || '');
        if (/noindex|none/i.test(`${xRobots},${metaRobots}`)) {
            log('NOINDEX', `${url} minta tidak diindeks, data tidak disimpan`);
            history.urls[url] = { timestamp: now, status: 'noindex' };
            recordHostResult(history, host, true);
            return { attempted: true, record: null };
        }

        const record = extractPage($, url, kind);
        const changed = prev.contentHash !== record.contentHash;
        record.discovery = hint || undefined;
        record.fetch = {
            fetchedAt: new Date(now).toISOString(),
            httpStatus: res.status,
            elapsedMs: res.elapsedMs,
            bytes: Buffer.byteLength(String(res.data)),
            contentType: ctype,
            finalUrl: (res.request && res.request.res && res.request.res.responseUrl) || url,
            changedSinceLastCrawl: prev.contentHash ? changed : null
        };

        if (changed) {
            state.buffer.push(JSON.stringify(record));
            state.stats.saved++;
        } else {
            state.stats.unchanged++;
        }

        // History dibuat ramping: artikel cukup tahu "sudah pernah diambil"
        history.urls[url] = {
            timestamp: now,
            status: 'success',
            contentHash: record.contentHash.slice(0, 16),
            consecutiveErrors: 0,
            ...(kind === 'seed' ? {
                etag: res.headers.etag || null,
                lastModified: res.headers['last-modified'] || null,
                changeCount: (prev.changeCount || 0) + (changed && prev.contentHash ? 1 : 0)
            } : {})
        };
        state.dirty = true;
        recordHostResult(history, host, true);
        log('OK', `${(record.title || '(tanpa judul)').slice(0, 80)} | ${record.wordCount} kata`);
        return { attempted: true, record };
    } catch (error) {
        if (error.code === 'SHUTDOWN') {
            state.stats.attempted--;
            log('STOP', `${url} dibatalkan (shutdown), tidak dicatat sebagai error`);
            return { attempted: false, record: null, stop: true };
        }
        state.stats.errors++;
        log('ERROR', `${url}: ${error.message}`);
        history.urls[url] = {
            ...prev,
            timestamp: now,
            status: 'error',
            message: error.message.slice(0, 200),
            consecutiveErrors: (prev.consecutiveErrors || 0) + 1
        };
        state.dirty = true;
        recordHostResult(history, host, false);
        return { attempted: true, record: null };
    }
}

// ============================================================
// WORKER PER HOST (host berbeda jalan paralel, satu host selalu serial & berjeda)
// ============================================================
async function hostWorker(site) {
    const history = state.history;
    const name = hostKey(site.seed);

    const seed = await processUrl(history, site.seed, 'seed', { source: 'seed' });
    if (state.stopping) return;

    let candidates = [];
    try {
        candidates = await discoverHost(site, history, seed.record);
    } catch (e) {
        if (e.code !== 'SHUTDOWN') log('DISCOVERY', `${name}: ${e.message}`);
    }

    let attempts = 0;
    for (const c of candidates) {
        if (state.stopping || attempts >= CONFIG.maxPagesPerHost) break;
        const res = await processUrl(history, c.url, 'article', c.hint);
        if (res.attempted) attempts++;
        if (res.stop) break;
    }
    log('HOST', `${name}: selesai, ${attempts} halaman diambil dari ${candidates.length} kandidat`);
}

// ============================================================
// MAIN
// ============================================================
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        if (state.stopping) {
            try { flush(); } catch (_) {}
            process.exit(1);
        }
        state.stopping = true;
        log('STOP', 'Sinyal diterima, menyelesaikan request yang berjalan lalu berhenti...');
    });
}

// Deadline halus: setelah MAX_RUNTIME_MIN menit crawler berhenti sendiri dengan rapi.
const MAX_RUNTIME_MIN = num(process.env.MAX_RUNTIME_MIN, 0);
if (MAX_RUNTIME_MIN > 0) {
    setTimeout(() => {
        state.stopping = true;
        log('DEADLINE', `Batas waktu ${MAX_RUNTIME_MIN} menit tercapai, berhenti dengan rapi...`);
    }, MAX_RUNTIME_MIN * 60 * 1000).unref();
}

async function crawl() {
    state.history = loadHistory();
    pruneHistory(state.history);
    fs.mkdirSync(ARTICLES_DIR, { recursive: true });

    const timer = setInterval(() => {
        try { flush(); } catch (e) { log('ERROR', `flush gagal: ${e.message}`); }
    }, CONFIG.flushIntervalMs);
    timer.unref();

    await Promise.all(
        SITES.map((site) =>
            hostWorker(site).catch((e) => log('FATAL', `${site.seed}: ${e.stack || e.message}`))
        )
    );

    clearInterval(timer);
    flush();
    const s = state.stats;
    log('DONE', `${s.attempted} request halaman | ${s.saved} record disimpan | ${s.unchanged} sama | ${s.notModified} 304 | ${s.blocked} diblok robots | ${s.errors} error`);
    log('BANDWIDTH', `~${(s.bytes / 1048576).toFixed(1)} MB diunduh (setelah dekompres; di kabel kira-kira 3-5x lebih kecil)`);
}

crawl().catch((e) => {
    console.error(e);
    try { flush(); } catch (_) {}
    process.exit(1);
});