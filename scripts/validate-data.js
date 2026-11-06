'use strict';

// Validasi data crawler sebelum di-commit.
// - history.json rusak  -> dipulihkan dari commit terakhir (atau dihapus kalau belum pernah di-commit)
// - articles.jsonl      -> baris setengah-tertulis (karena kill paksa) dibuang
// - file *.tmp sisa     -> dihapus
// Selalu exit 0 supaya langkah commit tetap jalan; masalah dilaporkan sebagai warning.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const HISTORY = path.join(DATA_DIR, 'history.json');
const ARTICLES = path.join(DATA_DIR, 'articles.jsonl');

const warn = (msg) => console.log(`::warning::${msg}`);
const info = (msg) => console.log(`[validate] ${msg}`);

function writeAtomic(file, content) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
}

// 1. Sisa file sementara dari proses yang di-kill
if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.endsWith('.tmp')) {
            fs.rmSync(path.join(DATA_DIR, f), { force: true });
            info(`hapus file sementara: ${f}`);
        }
    }
}

// 2. history.json
function historyIsValid() {
    try {
        const obj = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        if (obj.urls !== undefined && (typeof obj.urls !== 'object' || obj.urls === null)) return false;
        return true;
    } catch (_) {
        return false;
    }
}

if (fs.existsSync(HISTORY)) {
    if (historyIsValid()) {
        info('history.json valid');
    } else {
        warn('history.json RUSAK, memulihkan dari commit terakhir');
        try {
            execFileSync('git', ['checkout', '--', HISTORY], { stdio: 'pipe' });
            info(historyIsValid() ? 'history.json berhasil dipulihkan' : 'hasil pemulihan masih tidak valid');
            if (!historyIsValid()) fs.rmSync(HISTORY, { force: true });
        } catch (_) {
            fs.rmSync(HISTORY, { force: true }); // belum pernah di-commit: lebih baik mulai bersih
            warn('tidak ada versi commit sebelumnya, history.json dihapus (crawl berikutnya mulai bersih)');
        }
    }
} else {
    info('history.json belum ada (run pertama?)');
}

// 3. articles.jsonl
if (fs.existsSync(ARTICLES)) {
    const raw = fs.readFileSync(ARTICLES, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const good = lines.filter((l) => {
        try { JSON.parse(l); return true; } catch (_) { return false; }
    });
    const dropped = lines.length - good.length;
    const needsNewline = raw.length > 0 && !raw.endsWith('\n');

    if (dropped > 0 || needsNewline) {
        writeAtomic(ARTICLES, good.length ? good.join('\n') + '\n' : '');
        warn(`articles.jsonl dirapikan: ${dropped} baris rusak dibuang`);
    } else {
        info(`articles.jsonl valid (${good.length} record)`);
    }
}