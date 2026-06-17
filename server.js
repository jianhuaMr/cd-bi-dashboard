const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const SMBS_URL = 'http://www.smbs.biz/ExRate/TodayExRate.jsp';
const SMBS_FLASH_URL = 'http://www.smbs.biz/Flash/TodayExRate_flash.jsp';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, body) {
  send(res, statusCode, JSON.stringify(body), {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
}

function fetchBuffer(url) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: {
        'user-agent': 'CD-BI/1.0 rate checker',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, remoteRes => {
      const chunks = [];
      remoteRes.on('data', c => chunks.push(c));
      remoteRes.on('end', () => resolve({
        statusCode: remoteRes.statusCode,
        headers: remoteRes.headers,
        buffer: Buffer.concat(chunks),
        url,
      }));
    });
    req.setTimeout(12000, () => req.destroy(new Error('SMBS request timeout')));
    req.on('error', reject);
  });
}

function decodeHtml(buffer, headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  let charset = (ct.match(/charset=([^;]+)/) || [])[1] || 'utf-8';
  charset = charset.replace(/["']/g, '').trim();
  if (/euc-kr|ks_c_5601|ksc5601/i.test(charset)) charset = 'euc-kr';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (err) {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function cleanNum(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rowNear(html, currencyPattern) {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  return rows.find(r => new RegExp(currencyPattern, 'i').test(r)) || '';
}

function numbersFromRow(row) {
  return (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
    .map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .map(cleanNum)
    .filter(n => n !== null);
}

function parseRates(html) {
  const qpos = html.indexOf('?');
  if (qpos >= 0) {
    const qs = html.slice(qpos + 1).trim();
    const params = new URLSearchParams(qs);
    const usd = cleanNum(params.get('usd') || params.get('USD'));
    const cny = cleanNum(params.get('cny') || params.get('CNY') || params.get('cnh') || params.get('CNH'));
    if (usd && cny) return { usd_to_krw: usd, cny_to_krw: cny, usd_to_cny: usd / cny };
  }

  const usdNums = numbersFromRow(rowNear(html, 'USD|미국|달러|US Dollar'));
  const cnyNums = numbersFromRow(rowNear(html, 'CNY|CNH|중국|위안|China'));
  const pickRate = nums => {
    const plausible = nums.filter(n => n > 10 && n < 3000);
    return plausible.length ? plausible.sort((a, b) => b - a)[0] : null;
  };
  const usd_to_krw = pickRate(usdNums);
  const cny_to_krw = pickRate(cnyNums);
  if (!usd_to_krw || !cny_to_krw) return null;
  return { usd_to_krw, cny_to_krw, usd_to_cny: usd_to_krw / cny_to_krw };
}

async function handleSmbsRate(req, res, urlObj) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  const date = urlObj.searchParams.get('date') || '';
  const candidates = [
    `${SMBS_FLASH_URL}?tr_date=${encodeURIComponent(date)}`,
    `${SMBS_URL}?StrSchFull=${encodeURIComponent(String(date).replace(/-/g, '.'))}`,
    `${SMBS_URL}?StrSch_Year=${encodeURIComponent(String(date).slice(0, 4))}&StrSch_Month=${encodeURIComponent(String(date).slice(5, 7))}&StrSch_Day=${encodeURIComponent(String(date).slice(8, 10))}`,
    SMBS_URL,
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const remote = await fetchBuffer(candidate);
      if (remote.statusCode < 200 || remote.statusCode >= 300) {
        lastError = `SMBS HTTP ${remote.statusCode}`;
        continue;
      }
      const parsed = parseRates(decodeHtml(remote.buffer, remote.headers));
      if (!parsed) {
        lastError = 'SMBS page parsed, but USD/CNY rates were not found';
        continue;
      }
      return sendJson(res, 200, {
        ok: true,
        date,
        ...parsed,
        source_url: candidate,
        fetched_at: new Date().toISOString(),
      });
    } catch (err) {
      lastError = err.message;
    }
  }
  return sendJson(res, 502, {
    ok: false,
    message: lastError || 'SMBS rate fetch failed',
    date,
    source_url: SMBS_URL,
  });
}

function handleStatic(req, res, urlObj) {
  const pathname = decodeURIComponent(urlObj.pathname === '/' ? '/index.html' : urlObj.pathname);
  const fullPath = path.normalize(path.join(ROOT, pathname));
  if (!fullPath.startsWith(ROOT)) return send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });
  fs.readFile(fullPath, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    const ext = path.extname(fullPath).toLowerCase();
    send(res, 200, data, { 'content-type': MIME[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (urlObj.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (urlObj.pathname === '/api/smbs-rate') return handleSmbsRate(req, res, urlObj);
  return handleStatic(req, res, urlObj);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CD-BI server running at http://0.0.0.0:${PORT}`);
});
