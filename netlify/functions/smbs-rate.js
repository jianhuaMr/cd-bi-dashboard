const http = require('http');
const https = require('https');
const { TextDecoder } = require('util');

const SMBS_URL = 'http://www.smbs.biz/ExRate/TodayExRate.jsp';
const SMBS_FLASH_URL = 'http://www.smbs.biz/Flash/TodayExRate_flash.jsp';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function fetchBuffer(url) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: {
        'user-agent': 'CD-BI/1.0 rate checker',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
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

function rowNear(html, currency) {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  return rows.find(r => new RegExp(currency, 'i').test(r)) || '';
}

function numbersFromRow(row) {
  const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
    .map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const nums = cells.map(cleanNum).filter(n => n !== null);
  return nums;
}

function parseRates(html) {
  const qpos = html.indexOf('?');
  if (qpos >= 0) {
    const qs = html.slice(qpos + 1).trim();
    const params = new URLSearchParams(qs);
    const usd = cleanNum(params.get('usd') || params.get('USD'));
    const cny = cleanNum(params.get('cny') || params.get('CNY') || params.get('cnh') || params.get('CNH'));
    if (usd && cny) {
      return { usd_to_krw: usd, cny_to_krw: cny, usd_to_cny: usd / cny };
    }
  }

  const usdRow = rowNear(html, 'USD|미국|달러|US Dollar');
  const cnyRow = rowNear(html, 'CNY|중국|위안|China');
  const usdNums = numbersFromRow(usdRow);
  const cnyNums = numbersFromRow(cnyRow);

  const pickRate = nums => {
    const plausible = nums.filter(n => n > 10 && n < 3000);
    if (!plausible.length) return null;
    return plausible.sort((a, b) => b - a)[0];
  };

  const usd_to_krw = pickRate(usdNums);
  const cny_to_krw = pickRate(cnyNums);
  if (!usd_to_krw || !cny_to_krw) {
    return null;
  }
  return {
    usd_to_krw,
    cny_to_krw,
    usd_to_cny: usd_to_krw / cny_to_krw,
  };
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });

  const date = event.queryStringParameters && event.queryStringParameters.date;
  const candidates = [
    `${SMBS_FLASH_URL}?tr_date=${encodeURIComponent(date || '')}`,
    `${SMBS_URL}?StrSchFull=${encodeURIComponent(String(date || '').replace(/-/g, '.'))}`,
    `${SMBS_URL}?StrSch_Year=${encodeURIComponent(String(date || '').slice(0, 4))}&StrSch_Month=${encodeURIComponent(String(date || '').slice(5, 7))}&StrSch_Day=${encodeURIComponent(String(date || '').slice(8, 10))}`,
    SMBS_URL,
  ];

  let lastError = null;
  for (const url of candidates) {
    try {
      const res = await fetchBuffer(url);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        lastError = `SMBS HTTP ${res.statusCode}`;
        continue;
      }
      const html = decodeHtml(res.buffer, res.headers);
      const parsed = parseRates(html);
      if (!parsed) {
        lastError = 'SMBS 页面格式未识别';
        continue;
      }
      return json(200, {
        ok: true,
        date,
        ...parsed,
        source_url: url,
        fetched_at: new Date().toISOString(),
      });
    } catch (err) {
      lastError = err.message;
    }
  }

  return json(502, {
    ok: false,
    message: lastError || 'SMBS 汇率获取失败',
    date,
    source_url: SMBS_URL,
  });
};
