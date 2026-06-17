const SMBS_URL = 'http://www.smbs.biz/ExRate/TodayExRate.jsp';
const SMBS_FLASH_URL = 'http://www.smbs.biz/Flash/TodayExRate_flash.jsp';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

function cleanNum(value) {
  if (!value) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numbersNear(text, keyword) {
  const idx = text.toUpperCase().indexOf(keyword);
  if (idx < 0) return [];
  const chunk = text.slice(Math.max(0, idx - 500), idx + 1200);
  return (chunk.match(/\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?/g) || [])
    .map(cleanNum)
    .filter(n => n !== null);
}

function pickRate(nums, min, max) {
  const plausible = nums.filter(n => n >= min && n <= max);
  if (!plausible.length) return null;
  return plausible.sort((a, b) => b - a)[0];
}

function parseQueryLike(text) {
  const qpos = text.indexOf('?');
  const query = qpos >= 0 ? text.slice(qpos + 1) : text;
  try {
    const params = new URLSearchParams(query.trim());
    const usd = cleanNum(params.get('usd') || params.get('USD'));
    const cny = cleanNum(params.get('cny') || params.get('CNY') || params.get('cnh') || params.get('CNH'));
    if (usd && cny) return { usd_to_krw: usd, cny_to_krw: cny, usd_to_cny: usd / cny };
  } catch (_) {}
  return null;
}

function parseRates(text) {
  const queryParsed = parseQueryLike(text);
  if (queryParsed) return queryParsed;

  const usdNums = [
    ...numbersNear(text, 'USD'),
    ...numbersNear(text, 'US DOLLAR'),
  ];
  const cnyNums = [
    ...numbersNear(text, 'CNY'),
    ...numbersNear(text, 'CNH'),
    ...numbersNear(text, 'CHINA'),
  ];

  const usd_to_krw = pickRate(usdNums, 500, 3000);
  const cny_to_krw = pickRate(cnyNums, 50, 500);
  if (!usd_to_krw || !cny_to_krw) return null;
  return { usd_to_krw, cny_to_krw, usd_to_cny: usd_to_krw / cny_to_krw };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'CD-BI/1.0 rate checker',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`SMBS HTTP ${res.status}`);
  return await res.text();
}

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestGet(context) {
  const date = context.request.url ? new URL(context.request.url).searchParams.get('date') : '';
  const normalized = String(date || '');
  const candidates = [
    `${SMBS_FLASH_URL}?tr_date=${encodeURIComponent(normalized)}`,
    `${SMBS_URL}?StrSchFull=${encodeURIComponent(normalized.replace(/-/g, '.'))}`,
    `${SMBS_URL}?StrSch_Year=${encodeURIComponent(normalized.slice(0, 4))}&StrSch_Month=${encodeURIComponent(normalized.slice(5, 7))}&StrSch_Day=${encodeURIComponent(normalized.slice(8, 10))}`,
    SMBS_URL,
  ];

  let lastError = '';
  for (const sourceUrl of candidates) {
    try {
      const text = await fetchText(sourceUrl);
      const parsed = parseRates(text);
      if (!parsed) {
        lastError = 'SMBS 页面已返回，但未识别到 USD/CNY 汇率';
        continue;
      }
      return json({
        ok: true,
        date: normalized,
        ...parsed,
        source_url: sourceUrl,
        fetched_at: new Date().toISOString(),
      });
    } catch (err) {
      lastError = err.message || String(err);
    }
  }

  return json({
    ok: false,
    message: lastError || 'SMBS 汇率获取失败',
    date: normalized,
    source_url: SMBS_URL,
  }, 502);
}
