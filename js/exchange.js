/* ===== CDBI_FX 货币换算引擎 =====
 * 审计口径:
 * - 内部全部用整数最小单位运算: KRW=1won, USD/CNY=1/10000 (万分位)
 * - 汇率按 ×1e6 整数化, 乘除用 BigInt 精确计算, 仅在最终展示时落到小数
 * - Excel 读入的金额在入引擎边界做一次 1/10000 精度取整(摄入口径, 有记录)
 * - 换算只影响展示, 不改任何原始清算数据
 * 汇率优先级:
 * - USD↔KRW 直换: 优先店铺清算汇率(ctx.storeRate, 来自清算表 rate 列)
 * - 跨币种(含CNY)及无店铺rate: 用全局月度汇率表(exchangeRates)
 * - usd_to_cny 未录入时由 usd_to_krw / cny_to_krw 推导
 */
(function (global) {
  'use strict';

  const VERSION = '1.0.0';
  const SCALE = { KRW: 1n, USD: 10000n, CNY: 10000n };
  const SCALE_N = { KRW: 1, USD: 10000, CNY: 10000 };
  const RS = 1000000n; // 汇率整数化倍率 1e6
  const SYM = { KRW: '₩', USD: '$', CNY: '¥' };
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let rates = {};           // month -> rate record
  const missing = new Set(); // 本轮渲染收集到的缺失汇率 `${month}|${src}→${tgt}`

  function setRates(map) { rates = map || {}; }
  function getRates() { return rates; }
  function getRate(month) { return rates[month] || null; }
  function resetMissing() { missing.clear(); }
  function getMissing() { return Array.from(missing).sort(); }

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fnum(v, cur) {
    if (cur === 'KRW') return nf0.format(Math.round(v));
    return Math.abs(v) >= 10000 ? nf0.format(Math.round(v)) : nf2.format(v);
  }

  // ---- 金额 <-> 最小单位 ----
  function toMinor(value, cur) {
    // 摄入边界: Excel float -> 最小单位整数 (USD/CNY 万分位, KRW 整won)
    return BigInt(Math.round((value || 0) * SCALE_N[cur]));
  }
  function fromMinor(minor, cur) { return Number(minor) / SCALE_N[cur]; }

  // ---- 汇率解析 ----
  function rUsdKrw(month, storeRate, directLeg) {
    if (directLeg && storeRate > 0) return { r: storeRate, label: '店铺清算汇率' };
    const rec = rates[month];
    if (rec && rec.usd_to_krw > 0) return { r: rec.usd_to_krw, label: '月度清算汇率' };
    return null;
  }
  function rCnyKrw(month) {
    const rec = rates[month];
    return (rec && rec.cny_to_krw > 0) ? { r: rec.cny_to_krw, label: '月度清算汇率' } : null;
  }
  function rUsdCny(month) {
    const rec = rates[month];
    if (rec && rec.usd_to_cny > 0) return { r: rec.usd_to_cny, label: '月度清算汇率' };
    if (rec && rec.usd_to_krw > 0 && rec.cny_to_krw > 0)
      return { r: rec.usd_to_krw / rec.cny_to_krw, label: '推导: USD→KRW ÷ CNY→KRW' };
    return null;
  }

  /**
   * 核心换算 convert(value, src, tgt, ctx)
   * ctx: { month: 'YYYY.MM', storeRate: 店铺清算USD→KRW汇率(可选) }
   * 返回 { ok, value, rate, rateLabel, rateTxt, formula } 或 { ok:false, missing:true, month, pair }
   */
  function convert(value, src, tgt, ctx = {}) {
    if (value === null || value === undefined || !isFinite(value)) return { ok: false, reason: 'invalid' };
    if (src === tgt) return { ok: true, value, same: true };
    const month = ctx.month || null;

    let got = null, inverse = false;
    if (src === 'USD' && tgt === 'KRW') got = rUsdKrw(month, ctx.storeRate, true);
    else if (src === 'KRW' && tgt === 'USD') { got = rUsdKrw(month, ctx.storeRate, true); inverse = true; }
    else if (src === 'CNY' && tgt === 'KRW') got = rCnyKrw(month);
    else if (src === 'KRW' && tgt === 'CNY') { got = rCnyKrw(month); inverse = true; }
    else if (src === 'USD' && tgt === 'CNY') got = rUsdCny(month);
    else if (src === 'CNY' && tgt === 'USD') { got = rUsdCny(month); inverse = true; }

    if (!got) {
      const pair = src + '→' + tgt;
      if (month) missing.add(month + '|' + pair);
      return { ok: false, missing: true, month, pair };
    }
    const rate = got.r;
    const R = BigInt(Math.round(rate * 1e6));
    if (R <= 0n) return { ok: false, reason: 'bad-rate' };
    const mS = toMinor(value, src);
    let mT;
    if (!inverse) mT = (mS * R * SCALE[tgt]) / (SCALE[src] * RS);
    else mT = (mS * RS * SCALE[tgt]) / (SCALE[src] * R);
    const out = fromMinor(mT, tgt);
    const rateTxt = inverse ? `1 ${tgt} = ${rate.toFixed(4).replace(/\.?0+$/, '')} ${src}` : `1 ${src} = ${rate.toFixed(4).replace(/\.?0+$/, '')} ${tgt}`;
    return {
      ok: true, value: out, rate, rateLabel: got.label, rateTxt,
      formula: `${fnum(value, src)} ${src} ${inverse ? '÷' : '×'} ${rate.toFixed(4).replace(/\.?0+$/, '')} = ${fnum(out, tgt)} ${tgt}`,
    };
  }

  /**
   * 多笔金额(可不同来源汇率)换算后精确求和 — 用于 TTL 等聚合
   * entries: [{ value, src, month, storeRate }]
   * 返回 { ok, value, missing:[...] }
   */
  function sumConvert(entries, tgt) {
    let acc = 0n;
    const miss = [];
    for (const e of entries) {
      if (e.src === tgt) { acc += toMinor(e.value, tgt); continue; }
      const c = convert(e.value, e.src, tgt, { month: e.month, storeRate: e.storeRate });
      if (!c.ok) { miss.push((e.month || '?') + '|' + e.src + '→' + tgt); continue; }
      acc += toMinor(c.value, tgt);
    }
    if (miss.length) return { ok: false, missing: miss };
    return { ok: true, value: fromMinor(acc, tgt) };
  }

  /**
   * 统一金额展示 formatMoney(amount, sourceCurrency, targetCurrency, ctx)
   * ctx: { month, storeRate }
   * 返回带 tooltip 的 HTML; 缺汇率显示 "—" 并登记警告, 绝不显示 0
   */
  function fmtMoney(value, src, tgt, ctx = {}) {
    if (value === null || value === undefined || !isFinite(value)) return '<span class="money">—</span>';
    if (!tgt || tgt === 'ORIG' || src === tgt) {
      return `<span class="money" title="原始币种: ${src}${ctx.month ? ' · ' + ctx.month : ''}">${SYM[src]} ${fnum(value, src)}</span>`;
    }
    const c = convert(value, src, tgt, ctx);
    if (!c.ok) {
      const tip = `缺少 ${ctx.month || '?'} 汇率 (${src}→${tgt}), 请在 数据中心→汇率管理 录入`;
      return `<span class="money missing" title="${esc(tip)}">—</span>`;
    }
    const tip = `原始: ${SYM[src]} ${fnum(value, src)} ${src}&#10;汇率(${ctx.month || '?'}): ${c.rateTxt} [${c.rateLabel}]&#10;换算: ${c.formula}`;
    return `<span class="money converted" title="${tip}">${SYM[tgt]} ${fnum(c.value, tgt)}</span>`;
  }

  /** 图表用数值换算: 成功返回 number, 缺汇率返回 null (图上留空, 不画0) */
  function convVal(value, src, tgt, ctx = {}) {
    if (!tgt || tgt === 'ORIG' || src === tgt) return value;
    const c = convert(value, src, tgt, ctx);
    return c.ok ? c.value : null;
  }

  /**
   * 汇率冲突检查: 全局 usd_to_krw vs 各店清算表 rate, 偏差>0.5% 标黄
   * summaryMap: { 'store|month': row }
   */
  function findConflicts(summaryMap, storeMeta) {
    const out = [];
    for (const [k, row] of Object.entries(summaryMap)) {
      const [store, month] = k.split('|');
      const rec = rates[month];
      if (!rec || !(rec.usd_to_krw > 0) || !(row.rate > 0)) continue;
      const dev = Math.abs(row.rate - rec.usd_to_krw) / rec.usd_to_krw;
      if (dev > 0.005) out.push({
        month, store, storeName: (storeMeta && storeMeta[store]) ? storeMeta[store].name : store,
        storeRate: row.rate, globalRate: rec.usd_to_krw, devPct: dev,
      });
    }
    return out.sort((a, b) => b.devPct - a.devPct);
  }

  // ---- 自测 ----
  function selfTest() {
    const saved = rates;
    const results = [];
    const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
    try {
      rates = { '2099.01': { month: '2099.01', usd_to_krw: 1400, cny_to_krw: 200 } };
      const c1 = convert(100, 'USD', 'KRW', { month: '2099.01' });
      t('100 USD → KRW @1400 = 140,000', c1.ok && c1.value === 140000, JSON.stringify(c1.value));
      const c2 = convert(140000, 'KRW', 'USD', { month: '2099.01' });
      t('140,000 KRW → USD @1400 = 100', c2.ok && c2.value === 100, JSON.stringify(c2.value));
      const c3 = convert(100, 'USD', 'CNY', { month: '2099.01' });
      t('100 USD → CNY (推导 1400/200=7) = 700', c3.ok && c3.value === 700, JSON.stringify(c3.value));
      const c4 = convert(100, 'USD', 'KRW', { month: '2099.02' });
      t('缺汇率月份: ok=false 且不返回0', c4.ok === false && c4.missing === true && c4.value === undefined, JSON.stringify(c4));
      const h4 = fmtMoney(100, 'USD', 'KRW', { month: '2099.02' });
      t('缺汇率展示为 — 而非 0', h4.includes('missing') && h4.includes('—') && !h4.includes('>0<'), h4.slice(0, 60));
      const c5 = convert(100, 'USD', 'KRW', { month: '2099.01', storeRate: 1500 });
      t('店铺清算汇率优先 (1500): 150,000', c5.ok && c5.value === 150000 && c5.rateLabel === '店铺清算汇率', JSON.stringify(c5.value));
      const s1 = sumConvert([
        { value: 100, src: 'USD', month: '2099.01', storeRate: 1500 },
        { value: 100, src: 'USD', month: '2099.01' },
        { value: 10000, src: 'KRW' },
      ], 'KRW');
      t('聚合: 150,000+140,000+10,000 = 300,000', s1.ok && s1.value === 300000, JSON.stringify(s1));
      // 精度: 0.1+0.2 类浮点陷阱
      const s2 = sumConvert([{ value: 0.1, src: 'USD' }, { value: 0.2, src: 'USD' }], 'USD');
      t('整数最小单位求和: 0.1+0.2 = 0.3 精确', s2.ok && s2.value === 0.3, JSON.stringify(s2.value));
    } finally { rates = saved; }
    return results;
  }

  global.CDBI_FX = {
    VERSION, SYM, setRates, getRates, getRate, convert, convVal, fmtMoney, sumConvert,
    findConflicts, resetMissing, getMissing, selfTest, toMinor, fromMinor,
  };
})(window);
