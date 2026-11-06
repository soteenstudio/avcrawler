'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');

// ============================================================
// KONFIGURASI
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const ARTICLES_PATH = path.join(DATA_DIR, 'articles.jsonl'); // 1 baris = 1 JSON record

const CONFIG = {
    // Cantumkan kontak asli supaya admin web bisa menghubungi kalau ada masalah
    userAgent: process.env.CRAWLER_UA || 'PoliteBot/2.0 (+https://github.com/username/repo; contact: you@example.com)',
    robotsToken: 'PoliteBot', // nama bot yang dicocokkan ke aturan robots.txt

    // Sedikit di bawah interval cron (6 jam). Kalau pas 6 jam, run berikutnya bisa
    // kena SKIP karena selisih waktunya beberapa menit kurang dari cooldown.
    seedCooldownHours: 5,
    articleCooldownHours: 23,

    baseDelayMs: 3000,        // jeda minimum antar request ke host yang sama
    maxDelayMs: 30000,        // batas atas jeda (crawl-delay / adaptive)
    jitterMs: 1000,           // acak 0..1000ms biar pola request tidak kaku

    timeoutMs: 10000,
    maxBytes: 5 * 1024 * 1024,
    maxRetries: 3,

    robotsTtlMs: 24 * 60 * 60 * 1000,
    robotsFailTtlMs: 60 * 60 * 1000,

    breakerThreshold: 3,              // gagal beruntun sebelum host di-"istirahatkan"
    breakerPauseMs: 30 * 60 * 1000,

    articlesPerDomain: Number(process.env.ARTICLES_PER_DOMAIN ?? 3), // 0 = hanya homepage
    maxLinksStored: 40
};

const SEEDS = [
    'https://www.kompas.com',
    'https://www.detik.com',
    'https://www.antaranews.com',
    'https://www.tempo.co',
    'https://www.republika.co.id'
];

const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|igshid|mc_cid|mc_eid|ref|source|campaign)$/i;

// ============================================================
// UTIL
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);

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

const hostKey = (url) => new URL(url).hostname.replace(/^www\./, '');

function parseRetryAfter(value) {
    if (!value) return null;
    const secs = Number(value);
    if (!Number.isNaN(secs)) return secs * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// ============================================================
// HISTORY (atomic write + format lama otomatis dimigrasi)
// ============================================================
function loadHistory() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(HISTORY_PATH)) return { urls: {}, domains: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
        if (raw.urls) return { urls: raw.urls, domains: raw.domains || {} };
        return { urls: raw, domains: {} }; // format v1: flat object berisi URL saja
    } catch (e) {
        const backup = `${HISTORY_PATH}.corrupt-${Date.now()}`;
        fs.renameSync(HISTORY_PATH, backup);
        log('WARN', `history.json rusak, dipindah ke ${path.basename(backup)}`);
        return { urls: {}, domains: {} };
    }
}

function saveHistory(history) {
    const tmp = `${HISTORY_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, HISTORY_PATH); // atomic: file tidak pernah setengah tertulis
}

// ============================================================
// POLITENESS: rate limiter per host + adaptive throttle
// ============================================================
const lastRequestAt = new Map();   // host -> timestamp
const hostDelay = new Map();       // host -> delay dasar (dari crawl-delay robots.txt)
const extraDelay = new Map();      // host -> penalti adaptif

function currentDelay(host) {
    const base = Math.max(CONFIG.baseDelayMs, hostDelay.get(host) || 0);
    return Math.min(CONFIG.maxDelayMs, base + (extraDelay.get(host) || 0));
}

async function waitForHost(host) {
    const jitter = Math.random() * CONFIG.jitterMs;
    const wait = (lastRequestAt.get(host) || 0) + currentDelay(host) + jitter - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
}

// Server lambat / 429 / 5xx -> pelan-pelan mundur. Server sehat -> penalti turun lagi.
function adaptThrottle(host, status, elapsedMs) {
    const extra = extraDelay.get(host) || 0;
    if (status === 429 || status >= 500 || status === 0 || elapsedMs > 3000) {
        extraDelay.set(host, Math.min(CONFIG.maxDelayMs, extra ? extra * 2 : 2000));
    } else if (extra > 0) {
        extraDelay.set(host, extra < 500 ? 0 : Math.floor(extra / 2));
    }
}

async function politeGet(url, extraHeaders = {}) {
    const host = hostKey(url);
    let lastErr;

    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
        if (stopping) {
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
                    Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
                    'Accept-Language': 'id,en;q=0.8',
                    ...extraHeaders
                },
                timeout: CONFIG.timeoutMs,
                maxRedirects: 5,
                maxContentLength: CONFIG.maxBytes,
                maxBodyLength: CONFIG.maxBytes,
                responseType: 'text',
                transformResponse: [(d) => d],
                validateStatus: () => true // status ditangani manual
            });
            res.elapsedMs = Date.now() - started;
            adaptThrottle(host, res.status, res.elapsedMs);

            const retryable = res.status === 429 || res.status >= 500;
            if (retryable && attempt < CONFIG.maxRetries) {
                const retryAfter = parseRetryAfter(res.headers['retry-after']);
                const backoff = retryAfter ?? Math.min(60000, 2000 * 2 ** attempt);
                log('RETRY', `${url} -> HTTP ${res.status}, coba lagi ${Math.round(backoff / 1000)}s (percobaan ${attempt + 1})`);
                await sleep(Math.min(backoff, 60000));
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
// ROBOTS.TXT (cache per origin, patuhi crawl-delay, aturan 4xx/5xx ala Google)
// ============================================================
const robotsCache = new Map(); // origin -> { fetchedAt, ttl, mode, robots, sitemaps }

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
            entry = { mode: 'allow_all', sitemaps: [], ttl: CONFIG.robotsTtlMs }; // tidak ada robots.txt
        } else {
            entry = { mode: 'disallow_all', sitemaps: [], ttl: CONFIG.robotsFailTtlMs }; // 5xx: jangan nekat
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
// CIRCUIT BREAKER per host
// ============================================================
function breakerOpen(history, host) {
    const d = history.domains[host];
    return d && d.blockedUntil && Date.now() < d.blockedUntil;
}

function recordHostResult(history, host, ok) {
    const d = (history.domains[host] ||= { failures: 0, blockedUntil: 0 });
    if (ok) {
        d.failures = 0;
        d.blockedUntil = 0;
    } else if (++d.failures >= CONFIG.breakerThreshold) {
        d.blockedUntil = Date.now() + CONFIG.breakerPauseMs;
        log('BREAKER', `${host} gagal ${d.failures}x beruntun, diistirahatkan ${CONFIG.breakerPauseMs / 60000} menit`);
    }
}

// ============================================================
// EKSTRAKSI DATA
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
    const root = hostKey(baseUrl);
    const seen = new Set();
    const out = [];
    $('a[href]').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text.length < 25) return; // anchor pendek biasanya menu/navigasi, bukan judul berita
        if (/nofollow/i.test($(el).attr('rel') || '')) return;
        let u;
        try { u = new URL($(el).attr('href'), baseUrl); } catch (_) { return; }
        if (!/^https?:$/.test(u.protocol)) return;
        const h = u.hostname.replace(/^www\./, '');
        if (h !== root && !h.endsWith(`.${root}`)) return; // hanya domain yang sama
        if (u.pathname === '/') return;
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
            h2: $('h2').slice(0, 10).map((_, e) => $(e).text().replace(/\s+/g, ' ').trim()).get()
        },
        wordCount: text ? text.split(' ').length : 0,
        textPreview: text.slice(0, 500),
        feeds,
        contentHash: sha256(text.slice(0, 200000)),
        links: kind === 'seed' ? extractLinks($, url) : undefined
    };
}

// ============================================================
// PIPELINE SATU URL
// ============================================================
async function processUrl(history, url, kind) {
    const host = hostKey(url);
    const now = Date.now();
    const prev = history.urls[url] || {};

    // 1. Cooldown (error -> backoff eksponensial, sukses -> sesuai jenis URL)
    const baseCooldownH = kind === 'seed' ? CONFIG.seedCooldownHours : CONFIG.articleCooldownHours;
    const cooldownH = prev.status === 'error'
        ? Math.min(24, 2 ** (prev.consecutiveErrors || 1))
        : baseCooldownH;
    if (prev.timestamp) {
        const hours = (now - prev.timestamp) / 3600000;
        if (hours < cooldownH) {
            log('SKIP', `${url} (${hours.toFixed(1)}j lalu, cooldown ${cooldownH}j)`);
            return null;
        }
    }

    // 2. Circuit breaker
    if (breakerOpen(history, host)) {
        log('SKIP', `${url} (host ${host} sedang diistirahatkan)`);
        return null;
    }

    // 3. robots.txt
    if (!(await isAllowed(url))) {
        log('BLOCKED', url);
        history.urls[url] = { ...prev, timestamp: now, status: 'blocked_by_robots' };
        return null;
    }

    // 4. Fetch dengan conditional GET (hemat bandwidth server target)
    const cond = {};
    if (prev.etag) cond['If-None-Match'] = prev.etag;
    if (prev.lastModified) cond['If-Modified-Since'] = prev.lastModified;

    log('CRAWL', url);
    try {
        const res = await politeGet(url, cond);

        if (res.status === 304) {
            log('304', `${url} tidak berubah`);
            history.urls[url] = { ...prev, timestamp: now, status: 'not_modified', consecutiveErrors: 0 };
            recordHostResult(history, host, true);
            return null;
        }
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);

        const ctype = String(res.headers['content-type'] || '');
        if (!/html|xml/i.test(ctype)) throw new Error(`Content-Type tidak didukung: ${ctype || 'kosong'}`);

        const xRobots = String(res.headers['x-robots-tag'] || '');
        const $ = cheerio.load(res.data);
        const metaRobots = String($('meta[name="robots"]').attr('content') || '');
        if (/noindex|none/i.test(xRobots + ',' + metaRobots)) {
            log('NOINDEX', `${url} minta tidak diindeks, data tidak disimpan`);
            history.urls[url] = { ...prev, timestamp: now, status: 'noindex', consecutiveErrors: 0 };
            recordHostResult(history, host, true);
            return null;
        }

        const record = extractPage($, url, kind);
        const changed = prev.contentHash !== record.contentHash;
        record.fetch = {
            fetchedAt: new Date(now).toISOString(),
            httpStatus: res.status,
            elapsedMs: res.elapsedMs,
            bytes: Buffer.byteLength(String(res.data)),
            contentType: ctype,
            finalUrl: (res.request && res.request.res && res.request.res.responseUrl) || url,
            etag: res.headers.etag || null,
            lastModified: res.headers['last-modified'] || null,
            changedSinceLastCrawl: prev.contentHash ? changed : null
        };
        record.noarchive = /noarchive/i.test(xRobots + ',' + metaRobots) || undefined;

        // Simpan hanya kalau konten baru / berubah (hindari duplikat di dataset)
        if (changed) fs.appendFileSync(ARTICLES_PATH, JSON.stringify(record) + '\n');

        history.urls[url] = {
            timestamp: now,
            status: 'success',
            httpStatus: res.status,
            title: record.title,
            etag: record.fetch.etag,
            lastModified: record.fetch.lastModified,
            contentHash: record.contentHash,
            changeCount: (prev.changeCount || 0) + (changed && prev.contentHash ? 1 : 0),
            consecutiveErrors: 0
        };
        recordHostResult(history, host, true);
        log('OK', `${record.title || '(tanpa judul)'} | ${record.wordCount} kata | ${changed ? 'BARU/BERUBAH' : 'sama'}`);
        return record;
    } catch (error) {
        if (error.code === 'SHUTDOWN') {
            log('STOP', `${url} dibatalkan (shutdown), tidak dicatat sebagai error`);
            return null;
        }
        log('ERROR', `${url}: ${error.message}`);
        history.urls[url] = {
            ...prev,
            timestamp: now,
            status: 'error',
            message: error.message,
            consecutiveErrors: (prev.consecutiveErrors || 0) + 1
        };
        recordHostResult(history, host, false);
        return null;
    }
}

// ============================================================
// MAIN
// ============================================================
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        if (stopping) process.exit(1);
        stopping = true;
        log('STOP', 'Sinyal diterima, menyelesaikan request yang berjalan lalu berhenti...');
    });
}

// Deadline halus: setelah MAX_RUNTIME_MIN menit crawler berhenti sendiri dengan rapi
// (request yang berjalan diselesaikan, history disimpan). 0 / kosong = tanpa batas.
const MAX_RUNTIME_MIN = Number(process.env.MAX_RUNTIME_MIN || 0);
if (MAX_RUNTIME_MIN > 0) {
    setTimeout(() => {
        stopping = true;
        log('DEADLINE', `Batas waktu ${MAX_RUNTIME_MIN} menit tercapai, berhenti dengan rapi...`);
    }, MAX_RUNTIME_MIN * 60 * 1000).unref();
}

async function crawl() {
    const history = loadHistory();
    const stats = { seeds: 0, articles: 0 };
    const articleQueue = [];

    for (const seed of SEEDS) {
        if (stopping) break;
        const rec = await processUrl(history, seed, 'seed');
        saveHistory(history);
        if (rec) {
            stats.seeds++;
            if (rec.links) {
                articleQueue.push(...rec.links.slice(0, CONFIG.articlesPerDomain).map((l) => l.url));
            }
        }
    }

    for (const url of articleQueue) {
        if (stopping) break;
        const rec = await processUrl(history, url, 'article');
        saveHistory(history);
        if (rec) stats.articles++;
    }

    saveHistory(history);
    log('DONE', `${stats.seeds} halaman utama, ${stats.articles} artikel diproses. Data: ${path.relative(__dirname, ARTICLES_PATH)}`);
}

crawl().catch((e) => {
    console.error(e);
    process.exit(1);
});