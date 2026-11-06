'use strict';

// Kompres file data harian yang sudah "tutup" (tanggal UTC sebelum hari ini) menjadi .jsonl.gz
// supaya repo tidak membengkak. File hari ini dibiarkan plain karena masih akan ditambah.
// Jalankan SETELAH validate-data.js.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ARTICLES_DIR = path.resolve(process.env.DATA_DIR || 'data', 'articles');
const today = new Date().toISOString().slice(0, 10);

if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('[compact] belum ada data/articles, lewati');
    process.exit(0);
}

let done = 0;
for (const f of fs.readdirSync(ARTICLES_DIR).sort()) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m || m[1] >= today) continue;

    const src = path.join(ARTICLES_DIR, f);
    const dst = `${src}.gz`;
    const tmp = `${dst}.tmp`;
    const raw = fs.readFileSync(src);
    // Kalau .gz untuk hari itu sudah ada (run sebelumnya), gabungkan: gzip mendukung member berurutan
    const parts = fs.existsSync(dst) ? [fs.readFileSync(dst), zlib.gzipSync(raw, { level: 9 })] : [zlib.gzipSync(raw, { level: 9 })];
    fs.writeFileSync(tmp, Buffer.concat(parts));
    fs.renameSync(tmp, dst); // atomic
    fs.rmSync(src);
    done++;
    console.log(`[compact] ${f}: ${(raw.length / 1024).toFixed(0)} KB -> ${(fs.statSync(dst).size / 1024).toFixed(0)} KB`);
}
console.log(done ? `[compact] ${done} file dikompres` : '[compact] tidak ada file yang perlu dikompres');