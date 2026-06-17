/* ===== CD-BI 主应用 ===== */
(function () {
  'use strict';
  const P = window.CDBI_PARSER, DB = window.CDBI_DB, META = P.STORE_META, FX = window.CDBI_FX;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const STORE_ORDER = ['deepte', 'ssf', 'cdbrown', 'jingya'];
  const DEFAULT_PASS = '1234';
  const LEGACY_PASS = 'CD2026';
  const CURRENCIES = [['ORIG', '原币 원화혼합'], ['KRW', '₩ KRW'], ['CNY', '¥ CNY'], ['USD', '$ USD']];

  if (new URLSearchParams(location.search).has('resetPass')) {
    localStorage.removeItem('cdbi_pass_hash');
    sessionStorage.removeItem('cdbi_auth');
  }

  // ---------- 状态 ----------
  const S = {
    summary: {}, detail: {}, kuaishou: {}, inventoryMonthly: {}, inventoryMovementMonthly: {}, monthlyCostAnalysis: {}, productMaster: {}, uploadRecords: {}, view: 'overview', charts: [],
    cur: localStorage.getItem('cdbi_cur') || 'ORIG', // 展示货币 (仅影响展示, 不改原始数据)
    fxConflicts: [],
  };

  // ---------- 工具 ----------
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const fU = v => nf0.format(Math.round(v || 0));
  const fU2 = v => nf2.format(v || 0);
  const fK = v => nf0.format(Math.round(v || 0));
  const fP = (v, d = 1) => ((v || 0) * 100).toFixed(d) + '%';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mLabel = m => m ? m.slice(2).replace('.', '/') : '—';
  const daysIn = m => { const [y, mm] = m.split('.').map(Number); return new Date(y, mm, 0).getDate(); };

  function deltaHtml(cur, pri, goodWhenUp = true, pp = false) {
    if (pri === null || pri === undefined || pri === 0 && !pp) return '<span class="delta flat">—</span>';
    const d = pp ? (cur - pri) : (cur - pri) / Math.abs(pri);
    if (!isFinite(d)) return '<span class="delta flat">—</span>';
    const up = d > 0.0005, down = d < -0.0005;
    const cls = !up && !down ? 'flat' : ((up === goodWhenUp) ? 'up' : 'down');
    const arrow = up ? '▲' : down ? '▼' : '◆';
    const txt = pp ? (d * 100).toFixed(1) + 'pp' : (Math.abs(d) >= 9.995 ? (d * 100).toFixed(0) : (d * 100).toFixed(1)) + '%';
    return `<span class="delta ${cls}">${arrow} ${d > 0 ? '+' : ''}${txt}</span>`;
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  async function sha256(s) {
    if (!crypto.subtle) return 'plain:' + s;
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------- 统一金额接口 (需求: formatMoney(amount, src, tgt, month)) ----------
  // 全站金额展示一律走 money(); 图表数值走 moneyVal(); 聚合走 sumMoney()。
  function money(v, src, month, storeRate) {
    return FX.fmtMoney(v, src, S.cur, { month, storeRate });
  }
  function moneyVal(v, src, month, storeRate) {
    return FX.convVal(v, src, S.cur, { month, storeRate });
  }
  // entries: [{value, src, month, storeRate}] → TTL: 各店按各自清算汇率换算后整数求和
  function sumMoney(entries) {
    const tgt = S.cur === 'ORIG' ? null : S.cur;
    if (!tgt) return null; // 原币模式下不做跨币种聚合
    const r = FX.sumConvert(entries, tgt);
    if (!r.ok) return `<span class="money missing" title="缺少汇率: ${r.missing.join(', ')}">—</span>`;
    const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: tgt === 'KRW' ? 0 : (Math.abs(r.value) >= 10000 ? 0 : 2) });
    return `<span class="money converted" title="聚合换算: 各笔按各自月份/店铺清算汇率换算为 ${tgt} 后整数求和 (${entries.length} 笔)">${FX.SYM[tgt]} ${nf.format(r.value)}</span>`;
  }
  // 当前展示货币符号 (图表轴/表头用)
  const curSym = () => S.cur === 'ORIG' ? '' : FX.SYM[S.cur];
  // 表头币种标签: 原币模式显示原币, 否则显示目标币
  const colCur = src => S.cur === 'ORIG' ? FX.SYM[src] : FX.SYM[S.cur];

  function renderTopbar() {
    const tb = $('#topbar');
    if (!tb) return;
    const chips = CURRENCIES.map(([k, label]) =>
      `<button class="chip ${S.cur === k ? 'on' : ''}" data-cur="${k}">${label}</button>`).join('');
    const missing = FX.getMissing();
    const warnMissing = missing.length
      ? `<span class="tb-warn" data-goto="data" title="点击前往汇率管理">⚠ 缺少汇率: ${missing.slice(0, 4).map(x => { const [m, p] = x.split('|'); return `${m}(${p})`; }).join(' · ')}${missing.length > 4 ? ` 等${missing.length}项` : ''}</span>` : '';
    const warnConflict = S.fxConflicts.length
      ? `<span class="tb-warn" data-goto="data" title="点击查看明细">⚠ ${S.fxConflicts.length} 项店铺清算汇率与全局汇率偏差>0.5%</span>` : '';
    const curLabel = { ORIG: '原币(各店原始)', KRW: '₩ KRW', CNY: '¥ CNY', USD: '$ USD' }[S.cur];
    tb.innerHTML = `<span class="tb-label">展示货币 통화:</span><div class="chips">${chips}</div>
      <span class="tb-curbadge" title="当前所有金额按此币种展示;仅换算展示,不改任何清算口径与原始数据">当前展示 ${curLabel} · 口径不变</span>
      <span class="tb-sep"></span>${warnMissing}${warnConflict}`;
    tb.onclick = e => {
      const c = e.target.dataset?.cur;
      if (c) { S.cur = c; localStorage.setItem('cdbi_cur', c); render(); return; }
      const g = e.target.closest('[data-goto]');
      if (g) setView(g.dataset.goto);
    };
  }

  // ---------- 数据访问 ----------
  function rowOf(store, month) { return S.summary[store + '|' + month] || null; }
  function allMonths() {
    const set = new Set(Object.keys(S.summary).map(k => k.split('|')[1]));
    return Array.from(set).sort();
  }
  function monthEndBusinessDate(month) {
    const [y, mm] = String(month || '').split('.').map(Number);
    if (!y || !mm) return '';
    const d = new Date(y, mm, 0);
    const dow = d.getDay();
    if (dow === 6) d.setDate(d.getDate() - 1);
    if (dow === 0) d.setDate(d.getDate() - 2);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const CONFIRMED_CNY_TO_KRW = {
    '2026.05': 222.18,
    '2026.04': 215.90,
    '2026.03': 218.70,
    '2026.02': 207.91,
    '2026.01': 205.46,
    '2025.12': 204.76,
    '2025.11': 207.05,
    '2025.10': 200.45,
    '2025.09': 196.82,
    '2025.08': 194.14,
    '2025.07': 192.68,
    '2025.05': 191.88,
    '2025.02': 197.58,
    '2025.01': 197.26,
    '2024.12': 201.27,
    '2024.11': 192.42,
    '2024.10': 193.56,
  };
  async function applyConfirmedCnyRates() {
    const rates = await DB.getAllRates();
    let changed = 0;
    for (const [month, cnyToKrw] of Object.entries(CONFIRMED_CNY_TO_KRW)) {
      const rec = rates[month];
      if (!rec || !(rec.usd_to_krw > 0)) continue;
      if (rec.cny_to_krw === cnyToKrw && rec.usd_to_cny > 0) continue;
      rec.cny_to_krw = cnyToKrw;
      rec.usd_to_cny = +(rec.usd_to_krw / cnyToKrw).toFixed(4);
      rec.source_note = `${rec.source_note || ''}${String(rec.source_note || '').includes('CNY→KRW按已确认表格补录') ? '' : '；CNY→KRW按已确认表格补录'}`;
      rec.confirmed_by = rec.confirmed_by || '手工确认';
      rec.updated_at = new Date().toISOString();
      await DB.putRate(rec);
      changed++;
    }
    return changed;
  }
  async function fetchSmbsRate(month) {
    const rateDate = monthEndBusinessDate(month);
    if (!rateDate) throw new Error('月份格式必须为 YYYY.MM');
    const urls = [
      `/api/smbs-rate?date=${encodeURIComponent(rateDate)}`,
      `/.netlify/functions/smbs-rate?date=${encodeURIComponent(rateDate)}`,
    ];
    let data = null;
    let lastError = '';
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        data = await res.json().catch(() => null);
        if (res.ok && data && data.ok) break;
        lastError = (data && data.message) || `HTTP ${res.status}`;
        data = null;
      } catch (err) {
        lastError = err.message || String(err);
      }
    }
    if (!data || !data.ok) throw new Error(`SMBS 汇率获取失败：${lastError}`);
    return {
      month,
      rate_date: rateDate,
      usd_to_krw: Number(data.usd_to_krw),
      cny_to_krw: Number(data.cny_to_krw),
      usd_to_cny: data.usd_to_cny ? Number(data.usd_to_cny) : null,
      source_url: data.source_url || 'http://www.smbs.biz/ExRate/TodayExRate.jsp',
      source_note: `SMBS 每月最后工作日(${rateDate})自动获取`,
      confirmed_by: 'SMBS自动',
      confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  function storesIn(month) { return STORE_ORDER.filter(st => rowOf(st, month)); }
  function monthsOf(store) {
    return Object.keys(S.summary).filter(k => k.startsWith(store + '|')).map(k => k.split('|')[1]).sort();
  }
  function priorMonth(month, store) {
    const ms = (store ? monthsOf(store) : allMonths()).filter(m => m < month);
    return ms.length ? ms[ms.length - 1] : null;
  }
  function detailMonths(store) {
    return Object.keys(S.detail).filter(k => k.startsWith(store + '|')).map(k => k.split('|')[1]).sort();
  }
  function skuKey(v) {
    return String(v ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .trim()
      .replace(/[‐‑‒–—―－]/g, '-')
      .replace(/\s+/g, '')
      .replace(/\.0$/, '')
      .toUpperCase();
  }
  const BRAND_MAP = {
    DT: 'Deepte',
    SS: 'Soonsoo Food',
    GM: 'GNM',
    NG: 'Nature Garden',
    OA: 'Origin Aminade',
    TZ: 'Teazen',
    GH: 'Geohae',
    HP: 'Healthy Picker',
  };
  function isStockLedgerRow(row) {
    return row && (row.source_type === 'stockLedger' || /수불부|재고금액/.test(row.source_file || ''));
  }
  function rawInvRows() { return Object.values(S.inventoryMonthly || {}); }
  function movementRows() { return Object.values(S.inventoryMovementMonthly || {}).filter(isStockLedgerRow); }
  let _invCacheSig = '', _invCacheRows = null, _invCacheVersion = 0;
  let _invIndexSig = '', _invIndex = null;
  let _invViewSig = '', _invView = null;
  function invalidateInvCache() {
    _invCacheVersion++;
    _invCacheRows = null;
    _invIndex = null;
    _invIndexSig = '';
    _invView = null;
    _invViewSig = '';
  }
  function canonicalInvRows() {
    return rawInvRows().filter(isStockLedgerRow);
  }
  function invRows() { return canonicalInvRows(); }
  function invMonths() { return Array.from(new Set(invRows().map(r => r.month).filter(Boolean))).sort(); }
  function invWarehouses() { return Array.from(new Set(invRows().map(r => r.warehouse || '未指定').filter(Boolean))).sort(); }
  function invIndex() {
    const rows = invRows();
    const movs = movementRows();
    const sig = [
      Object.keys(S.inventoryMonthly || {}).length,
      Object.keys(S.inventoryMovementMonthly || {}).length,
      Object.keys(S.productMaster || {}).length,
      _invCacheVersion,
    ].join('|');
    if (_invIndex && _invIndexSig === sig) return _invIndex;
    const months = Array.from(new Set(rows.map(r => r.month).filter(Boolean))).sort();
    const prevMonth = {};
    months.forEach((m, i) => { prevMonth[m] = i > 0 ? months[i - 1] : null; });
    const qty = new Map();
    const moveExact = new Map();
    const moveSku = new Map();
    const add = (map, key, row) => {
      const cur = map.get(key) || { inbound_qty: 0, inbound_value_krw: 0, outbound_qty: 0, outbound_value_krw: 0, opening_qty: 0, opening_value_krw: 0 };
      cur.inbound_qty += Number(row.inbound_qty) || 0;
      cur.inbound_qty += Number(row.transfer_in_qty) || 0;
      cur.inbound_value_krw += Number(row.inbound_value_krw) || 0;
      cur.inbound_value_krw += Number(row.transfer_in_value_krw) || 0;
      cur.outbound_qty += Number(row.outbound_qty) || 0;
      cur.outbound_qty += Number(row.transfer_out_qty) || 0;
      cur.outbound_value_krw += Number(row.outbound_value_krw) || 0;
      cur.outbound_value_krw += Number(row.transfer_out_value_krw) || 0;
      cur.opening_qty += Number(row.opening_qty) || 0;
      cur.opening_value_krw += Number(row.opening_value_krw) || 0;
      map.set(key, cur);
    };
    for (const r of rows) {
      const key = `${r.month}|${r.warehouse || '未指定'}|${skuKey(r.sku_code)}`;
      qty.set(key, (qty.get(key) || 0) + (Number(r.ending_qty) || 0));
    }
    for (const m of movs) {
      const sku = skuKey(m.sku_code);
      add(moveExact, `${m.month}|${m.warehouse || '未指定'}|${sku}`, m);
      add(moveSku, `${m.month}|${sku}`, m);
    }
    _invIndexSig = sig;
    _invIndex = { months, prevMonth, qty, moveExact, moveSku, outboundSkuMonth: null };
    return _invIndex;
  }
  function invSkuPrefix(sku) {
    const m = String(sku || '').match(/^[A-Za-z]+/);
    return m ? m[0].toUpperCase() : '其他';
  }
  function brandNameForSku(sku) {
    const p = invSkuPrefix(sku);
    return BRAND_MAP[p] || p;
  }
  function movementOf(row) {
    const key = skuKey(row.sku_code);
    const idx = invIndex();
    const exact = idx.moveExact.get(`${row.month}|${row.warehouse || '未指定'}|${key}`);
    return exact || idx.moveSku.get(`${row.month}|${key}`) || null;
  }
  function productOf(sku) {
    const key = skuKey(sku);
    const pm = S.productMaster || {};
    if (pm[key]) return pm[key];
    const hit = Object.values(pm).find(p => skuKey(p.sku_code) === key);
    if (hit) pm[key] = hit;
    if (hit) return hit;
    if (/-FOC$/i.test(key)) {
      const baseKey = key.replace(/-FOC$/i, '');
      const base = pm[baseKey] || Object.values(pm).find(p => skuKey(p.sku_code) === baseKey);
      if (base) return base;
    }
    return null;
  }
  function productCost(p) {
    if (!p) return null;
    const purchase = Number(p.purchase_price_krw);
    const standard = Number(p.standard_cost_krw);
    if (Number.isFinite(purchase) && purchase > 0) return purchase;
    if (Number.isFinite(standard) && standard > 0) return standard;
    // Imported/manual product master rows with explicit 0 cost (for example FOC SKUs)
    // are known-zero cost, not missing-cost rows.
    if ((p.source || p.source_type) && (p.source || p.source_type) !== 'auto') return 0;
    return null;
  }
  // 基础 품번: 去掉末尾后缀变体 (如 SS009-FOC→SS009, DT005-2→DT005), 用于成本继承
  function baseSkuOf(sku) {
    const k = skuKey(sku);
    const base = k.replace(/-[^-]+$/, '');
    return base && base !== k && base.length >= 2 ? base : null;
  }
  function inventoryUnitCost(row) {
    // 库存管理唯一标准: 수불부&재고금액。采购单价/库存金额只采用该表自身的 재고금액÷재고수량 或表内单价。
    const rowUnit = Number(row.unit_cost_krw);
    if (rowUnit > 0) return { value: rowUnit, source: row.unit_cost_source || 'stockLedger' };
    if (rowUnit === 0) return { value: 0, source: 'stockLedger-zero' };
    const sourceValue = Number(row.source_ending_value_krw);
    const endingQty = Number(row.ending_qty);
    if (sourceValue > 0 && endingQty > 0) return { value: sourceValue / endingQty, source: 'stockLedgerValue' };
    return { value: null, source: '' };
  }
  // ===== 产品登记(产品主数据) — 以 품번 为唯一键, 全站显示名/品牌从此取数 =====
  const PRODUCT_FIELDS = ['sku_code', 'name_kr', 'name_cn', 'barcode', 'brand', 'spec', 'stock_unit', 'management_unit', 'conversion_factor', 'standard_cost_krw', 'purchase_price_krw', 'category', 'status', 'memo', 'source', 'updated_at'];
  // 规范化: 兼容旧导入记录(product_name/barcode_or_spec), 补齐新字段
  function normProduct(rec) {
    if (!rec) return null;
    return {
      sku_code: skuKey(rec.sku_code),
      name_kr: rec.name_kr || rec.product_name || '',
      name_cn: rec.name_cn || '',
      barcode: rec.barcode || rec.barcode_or_spec || '',
      brand: rec.brand || '',
      spec: rec.spec || '',
      stock_unit: rec.stock_unit || '',
      management_unit: rec.management_unit || '',
      conversion_factor: rec.conversion_factor || 1,
      standard_cost_krw: Number(rec.standard_cost_krw) || 0,
      purchase_price_krw: Number(rec.purchase_price_krw) || 0,
      category: rec.category || '',
      status: rec.status || 'active',
      memo: rec.memo || '',
      source: rec.source || rec.source_type || 'import',
      updated_at: rec.updated_at || rec.uploaded_at || '',
    };
  }
  function productInfo(sku) { return normProduct(productOf(sku)); }
  // 显示名: 中文界面优先中文名, 缺则韩文名, 再缺则回退
  function displayName(sku, fallback) {
    const p = productInfo(sku);
    return (p && (p.name_cn || p.name_kr)) || fallback || '';
  }
  // 品牌: 登记表优先, 缺则按 품번 前缀映射
  function brandOf(sku) {
    const p = productInfo(sku);
    return (p && p.brand) || brandNameForSku(sku);
  }
  // 汇集全数据源中出现过的 품번 及其可推断信息(用于自动补全 & 覆盖率)
  function collectSkuSources() {
    const map = {}; // sku -> {name_kr,name_cn,barcode,brand,stock_unit,std,purchase, seenInSales, seenInInv}
    const touch = sku => (map[sku] = map[sku] || { name_kr: '', name_cn: '', barcode: '', brand: '', stock_unit: '', standard_cost_krw: 0, purchase_price_krw: 0, seenInSales: false, seenInInv: false });
    const fill = (o, k, v) => { if (!o[k] && v) o[k] = v; };
    // 月末库存(PMP)
    for (const r of rawInvRows()) {
      const sku = skuKey(r.sku_code); if (!sku) continue;
      const o = touch(sku); o.seenInInv = true;
      fill(o, 'name_kr', r.product_name); fill(o, 'barcode', r.barcode_or_spec); fill(o, 'stock_unit', r.unit);
    }
    // 结算库存明细(含中文名/品牌/条码)
    for (const d of Object.values(S.detail || {})) {
      for (const it of (d.inventory || [])) {
        const sku = skuKey(it.sku_code); if (!sku) continue;
        const o = touch(sku); o.seenInInv = true;
        fill(o, 'name_kr', it.name_kr); fill(o, 'name_cn', it.name_cn); fill(o, 'brand', it.brand); fill(o, 'barcode', it.barcode);
      }
      // 结算 SKU 透视(pivot 名称, 部分店铺为中文)
      for (const s of (d.skus || [])) {
        const sku = skuKey(s.sku_code); if (!sku) continue;
        const o = touch(sku); o.seenInSales = true;
        if (s.name && /[一-鿿]/.test(s.name)) fill(o, 'name_cn', s.name);
        else fill(o, 'name_kr', s.name);
      }
    }
    return map;
  }
  function enrichInvRow(row) {
    const sku = skuKey(row.sku_code);
    const cost = inventoryUnitCost(row);
    const unitCost = cost.value;
    const endingValue = unitCost !== null ? (Number(row.ending_qty) || 0) * unitCost : null;
    const sourceVal = row.source_ending_value_krw;
    const reconDiff = sourceVal !== null && sourceVal !== undefined && endingValue !== null ? endingValue - Number(sourceVal || 0) : null;
    return {
      ...row,
      sku_code: sku,
      product_name: row.product_name || '',
      barcode_or_spec: row.barcode_or_spec || '',
      brand_name: brandNameForSku(sku),
      movement: movementOf(row),
      unit_cost_krw: unitCost,
      unit_cost_source: cost.source,
      ending_value_krw: endingValue,
      cost_missing: unitCost === null,
      reconciliation_diff_krw: reconDiff,
    };
  }
  function filterInvRows(filters = {}) {
    const sig = [
      Object.keys(S.inventoryMonthly || {}).length,
      Object.keys(S.inventoryMovementMonthly || {}).length,
      Object.keys(S.productMaster || {}).length,
      _invCacheVersion,
    ].join('|');
    if (_invCacheSig !== sig || !_invCacheRows) {
      _invCacheSig = sig;
      _invCacheRows = invRows().map(enrichInvRow);
    }
    return _invCacheRows.filter(r => {
      if (filters.month && r.month !== filters.month) return false;
      if (filters.warehouse && filters.warehouse !== 'all' && (r.warehouse || '未指定') !== filters.warehouse) return false;
      if (filters.prefix && filters.prefix !== 'all' && brandNameForSku(r.sku_code) !== filters.prefix) return false;
      if (filters.sku && !(String(r.sku_code).toLowerCase() + String(r.product_name).toLowerCase()).includes(filters.sku.toLowerCase())) return false;
      return true;
    });
  }
  function invDataSig() {
    return [
      Object.keys(S.inventoryMonthly || {}).length,
      Object.keys(S.inventoryMovementMonthly || {}).length,
      Object.keys(S.productMaster || {}).length,
      _invCacheVersion,
    ].join('|');
  }
  function inventoryViewModel() {
    const sig = invDataSig();
    if (_invView && _invViewSig === sig) return _invView;
    const rows = filterInvRows();
    const months = Array.from(new Set(rows.map(r => r.month).filter(Boolean))).sort();
    const byMonth = new Map();
    for (const r of rows) {
      const monthKey = r.month || '';
      if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
      byMonth.get(monthKey).push(r);
    }
    _invViewSig = sig;
    _invView = { rows, months, byMonth };
    return _invView;
  }
  function skuMonthlyOutbound(sku, month) {
    const key = skuKey(sku);
    return invOutboundIndex().get(`${month}|${key}`) || 0;
  }
  function priorInvMonth(month) {
    return invIndex().prevMonth[month] || null;
  }
  function prevEndingQty(row) {
    const pm = invIndex().prevMonth[row.month];
    if (!pm) return null;
    const key = skuKey(row.sku_code);
    const wh = row.warehouse || '未指定';
    const idxKey = `${pm}|${wh}|${key}`;
    return invIndex().qty.has(idxKey) ? invIndex().qty.get(idxKey) : null;
  }
  function monthEndMovement(row) {
    const prev = prevEndingQty(row);
    if (prev === null) return null;
    const ending = Number(row.ending_qty) || 0;
    const delta = ending - prev;
    return {
      opening_qty: prev,
      inbound_qty: delta > 0 ? delta : 0,
      outbound_qty: delta < 0 ? -delta : 0,
      estimated: true,
    };
  }
  function openingQtyOf(row) {
    const d = monthEndMovement(row);
    return d ? d.opening_qty : ((row.movement && row.movement.opening_qty) || row.opening_qty || 0);
  }
  function inboundQtyOf(row) {
    const d = monthEndMovement(row);
    return d ? d.inbound_qty : ((row.movement && row.movement.inbound_qty) || 0);
  }
  function outboundQtyOf(row) {
    const d = monthEndMovement(row);
    return d ? d.outbound_qty : ((row.movement && row.movement.outbound_qty) || 0);
  }
  function avgOutbound3(sku, month) {
    const ms = invIndex().months.filter(m => m <= month).slice(-3);
    if (!ms.length) return 0;
    return ms.reduce((a, m) => a + skuMonthlyOutbound(sku, m), 0) / ms.length;
  }
  function invOutboundIndex() {
    const idx = invIndex();
    if (idx.outboundSkuMonth) return idx.outboundSkuMonth;
    const out = new Map();
    for (const r of filterInvRows()) {
      const key = `${r.month}|${skuKey(r.sku_code)}`;
      out.set(key, (out.get(key) || 0) + outboundQtyOf(r));
    }
    idx.outboundSkuMonth = out;
    return out;
  }
  // 低销量阈值(近3月平均月出库件数), 低于此值周转天数不可估, 默认10可配置
  function turnoverMinSales() { return Number(localStorage.getItem('cdbi_turnover_min')) || 10; }
  function invRisk(row) {
    const TH = turnoverMinSales();
    const avgOut = avgOutbound3(row.sku_code, row.month);
    const lowSales = avgOut > 0 && avgOut < TH; // 有少量出库但低于阈值
    let monthsCover = null, turnoverDays = null, level = 'health', label = '健康';
    if (avgOut <= 0) {
      // 完全无出库: 滞销(有库存)或健康(无库存); 周转不可估
      if (row.ending_qty > 0) { level = 'slow'; label = '滞销无出库'; }
    } else if (lowSales) {
      // 销量过低: 周转天数分母趋零会严重失真, 不估算/不参与极值排序, 仅以绝对库存预警
      level = row.ending_qty > 0 ? 'slow' : 'health';
      label = row.ending_qty > 0 ? '销量过低·不可估' : '健康';
    } else {
      monthsCover = row.ending_qty / avgOut;
      turnoverDays = monthsCover * 30;
      if (monthsCover < 0.5) { level = 'stockout'; label = '断货风险<0.5月'; }
      else if (turnoverDays > 365) { level = 'urgent'; label = '高库存>365天'; }
      else if (turnoverDays > 180) { level = 'focus'; label = '高库存>180天'; }
    }
    return { avgOut, monthsCover, turnoverDays, level, label, lowSales };
  }
  function salesQtyBySku(month) {
    const out = {};
    for (const [k, d] of Object.entries(S.detail || {})) {
      if (k.split('|')[1] !== month) continue;
      for (const s of (d.skus || [])) {
        const key = skuKey(s.sku_code);
        out[key] = (out[key] || 0) + (Number(s.qty) || 0);
      }
    }
    return out;
  }
  function invBySkuMonth(month) {
    const out = {};
    for (const r of invRows().filter(x => x.month === month).map(enrichInvRow)) {
      const cur = out[r.sku_code] || { ending_qty: 0, ending_value_krw: 0, outbound_qty: 0, cost_missing: false, warehouses: new Set() };
      cur.ending_qty += Number(r.ending_qty) || 0;
      cur.outbound_qty += outboundQtyOf(r);
      if (r.ending_value_krw !== null) cur.ending_value_krw += r.ending_value_krw || 0;
      cur.cost_missing = cur.cost_missing || !!r.cost_missing;
      cur.warehouses.add(r.warehouse || '未指定');
      out[r.sku_code] = cur;
    }
    for (const v of Object.values(out)) v.warehouses = Array.from(v.warehouses);
    return out;
  }
  // ===== SSOT 数据层: 每店每月规范化(KRW整数won, USD/CNY保留文件精度), 全站唯一取数口径 =====
  // 同一指标只在此处取整一次, 下游所有展示位直接读取, 禁止各组件再 round/再聚合浮点。
  function canon(store, month) {
    const r = rowOf(store, month);
    if (!r) return null;
    const feeC = FX.convert(r.fee_usd || 0, 'USD', 'KRW', { month, storeRate: r.rate });
    const fee_krw = feeC.ok ? Math.round(feeC.value) : Math.round((r.fee_usd || 0) * (r.rate || 0));
    return {
      store, month, rate: r.rate,
      // USD 原生(GMV/退款/费用以平台USD为准)
      gmv_usd: r.gmv_usd || 0, net_usd: r.net_usd || 0, refund_usd: r.refund_usd || 0, fee_usd: r.fee_usd || 0,
      // KRW 原生, 整数won
      net_krw: Math.round(r.net_krw || 0),
      cogs_krw: Math.round(r.cogs_krw || 0),
      fee_krw,
      profit_krw: Math.round(r.profit_krw || 0),
      ending_inventory_krw: Math.round(r.ending_inventory_krw || 0),
      // P&L 闭合自检: 净销售 - 出库原价 + 费用KRW(费用为负,已含广告/技术/CS/其他收入净额)
      _profit_recalc: Math.round(r.net_krw || 0) - Math.round(r.cogs_krw || 0) + fee_krw,
    };
  }
  // P&L 闭合校验: 文件利润 vs 重算利润 (容差 2 won 吸收换算尾差); 超差返回差额供 UI 红字报警
  function plCheck(c) {
    if (!c) return { ok: true, diff: 0 };
    const diff = c.profit_krw - c._profit_recalc;
    return { ok: Math.abs(diff) <= 2, diff };
  }
  function groupAgg(month) {
    const cs = storesIn(month).map(st => canon(st, month)).filter(Boolean);
    if (!cs.length) return null;
    const sum = k => cs.reduce((a, c) => a + (c[k] || 0), 0); // KRW为整数→整数和; USD为文件值→浮点和(展示再格式化)
    const g = { gmv_usd: sum('gmv_usd'), refund_usd: sum('refund_usd'), net_usd: sum('net_usd'), fee_usd: sum('fee_usd'), net_krw: sum('net_krw'), cogs_krw: sum('cogs_krw'), fee_krw: sum('fee_krw'), profit_krw: sum('profit_krw'), ending_inventory_krw: sum('ending_inventory_krw') };
    g.margin = g.net_krw ? g.profit_krw / g.net_krw : 0;
    g.refund_rate = g.gmv_usd ? Math.abs(g.refund_usd) / g.gmv_usd : 0;
    g.fee_rate = g.net_usd ? Math.abs(g.fee_usd) / g.net_usd : 0;
    return g;
  }
  const refundRate = r => r.gmv_usd ? Math.abs(r.refund_usd) / r.gmv_usd : 0;
  const feeRate = r => r.net_usd ? Math.abs(r.fee_usd) / r.net_usd : 0;

  // ===== 全渠道层 (含表外快手 + B2B清潭淘宝) =====
  // 月度权威源 = 「매출대비 원가분석」表(全渠道 매출/매입/이익); 清算表提供各店明细
  const CHANNEL_DEFS = [
    { key: 'cdbrown', re: /씨디브라운|CD ?BROWN|브라운/i, store: 'cdbrown', name: 'PDD-CD BROWN', color: '#F59E0B' },
    { key: 'ssf', re: /SSF/i, store: 'ssf', name: 'PDD-SSF', color: '#1E40AF' },
    { key: 'deepte', re: /deepte|딥트/i, store: 'deepte', name: 'PDD-Deepte', color: '#3B82F6' },
    { key: 'jingya', re: /징야|鲸芽|jingya|대련 플랫폼/i, store: 'jingya', name: '鲸芽-CD大连', color: '#10B981' },
    { key: 'kuaishou', re: /콰이쇼우|호카밤|快手|hokabomb/i, store: 'kuaishou', name: '快手-HOKABOMB', color: '#8B5CF6' },
    { key: 'chungdam', re: /chungdam|청담|清潭|타오바오|taobao|global trade|dalian/i, store: null, name: '清潭进口店(淘宝B2B)', color: '#EC4899' },
  ];
  function channelDefByName(name) {
    return CHANNEL_DEFS.find(c => c.re.test(String(name || ''))) || null;
  }
  function costRowsForMonth(month) {
    return Object.values(S.monthlyCostAnalysis || {}).filter(r => r.month === month && !/합계|소계|total/i.test(r.channel_or_customer || ''));
  }
  function costAnalysisMonths() {
    return Array.from(new Set(Object.values(S.monthlyCostAnalysis || {}).map(r => r.month).filter(Boolean)));
  }
  // 月度全渠道清单: 成本分析表优先(权威, 含全渠道); 缺则回退清算表4店(+已结算快手)
  function monthChannels(month) {
    const crows = costRowsForMonth(month);
    if (crows.length) {
      return crows.map(cr => {
        const def = channelDefByName(cr.channel_or_customer);
        const store = def && def.store;
        const c = store ? canon(store, month) : null; // 清算明细(若有)
        const net_krw = Math.round(cr.sales_krw || 0);
        const profit_krw = Math.round(cr.profit_krw || 0);
        return {
          key: def ? def.key : 'ext:' + cr.channel_or_customer,
          name: def ? def.name : cr.channel_or_customer,
          color: def ? def.color : '#94A3B8',
          store, source: 'costAnalysis', hasClearing: !!c,
          net_krw, cogs_krw: Math.round(cr.purchase_cost_krw || 0), profit_krw,
          margin: cr.sales_krw ? cr.profit_krw / cr.sales_krw : 0,
          // GMV/退款/费用/库存: 有清算明细则用清算, 否则用成本分析(B2B无退款概念)
          gmv_usd: c ? c.gmv_usd : (cr.sales_usd || 0),
          net_usd: c ? c.net_usd : (cr.sales_usd || 0),
          refund_usd: c ? c.refund_usd : 0,
          fee_usd: c ? c.fee_usd : 0,
          ending_inventory_krw: c ? c.ending_inventory_krw : 0,
          rate: c ? c.rate : (cr.sales_rate || 0),
          note: cr.note || '',
        };
      });
    }
    // 回退: 清算表4店 + 已结算快手(其清算表上传过)
    const out = storesIn(month).map(st => {
      const c = canon(st, month);
      return { ...c, key: st, name: META[st].name, color: META[st].color, store: st, source: 'clearing', hasClearing: true, margin: c.net_krw ? c.profit_krw / c.net_krw : 0 };
    });
    const kw = S.kuaishou && S.kuaishou[month];
    if (kw && kw.settle) {
      const se = kw.settle;
      out.push({
        key: 'kuaishou', name: META.kuaishou.name, color: META.kuaishou.color, store: 'kuaishou', source: 'kuaishou', hasClearing: true,
        net_krw: Math.round(se.sales_krw || 0), cogs_krw: Math.round(se.cogs_krw || 0), profit_krw: Math.round(se.profit_krw || 0),
        margin: se.sales_krw ? se.profit_krw / se.sales_krw : 0,
        gmv_usd: 0, net_usd: 0, refund_usd: 0, fee_usd: 0, ending_inventory_krw: 0, rate: (kw.history && kw.history.length ? kw.history[kw.history.length - 1].rate : 0),
      });
    }
    return out;
  }
  // 全渠道月度合计 (整数求和)
  function groupAll(month) {
    const chs = monthChannels(month);
    if (!chs.length) return null;
    const sum = k => chs.reduce((a, c) => a + (c[k] || 0), 0);
    const g = { net_krw: sum('net_krw'), cogs_krw: sum('cogs_krw'), profit_krw: sum('profit_krw'), gmv_usd: sum('gmv_usd'), net_usd: sum('net_usd'), refund_usd: sum('refund_usd'), fee_usd: sum('fee_usd'), ending_inventory_krw: sum('ending_inventory_krw') };
    g.margin = g.net_krw ? g.profit_krw / g.net_krw : 0;
    g.refund_rate = g.gmv_usd ? Math.abs(g.refund_usd) / g.gmv_usd : 0;
    g.fee_rate = g.net_usd ? Math.abs(g.fee_usd) / g.net_usd : 0;
    g._channels = chs.length;
    g._fromCostAnalysis = !!costRowsForMonth(month).length;
    return g;
  }

  // ---------- 图表管理 ----------
  // ===== Internal standard reconciliation =====
  const STD_TOL_KRW = 2;
  function stdLedgerInvRows(month) {
    return rawInvRows().filter(r => r.month === month && r.source_type === 'stockLedger');
  }
  function stdLedgerMovRows(month) {
    return movementRows().filter(r => r.month === month && r.source_type === 'stockLedger');
  }
  function stdCostRows(month) {
    const rows = costRowsForMonth(month);
    const matched = rows.filter(r => {
      const def = channelDefByName(r.channel_or_customer || r.sales_type || '');
      return def && def.key === 'cdbrown';
    });
    return matched.length ? matched : rows;
  }
  function sumStd(rows, field) {
    return Math.round(rows.reduce((a, r) => a + (Number(r[field]) || 0), 0));
  }
  function pushStdCheck(out, label, clearing, standard, source) {
    const c = Math.round(Number(clearing) || 0);
    const s = Math.round(Number(standard) || 0);
    const diff = c - s;
    out.push({ label, clearing: c, standard: s, diff, ok: Math.abs(diff) <= STD_TOL_KRW, source });
  }
  // 内部核对: 以「成本分析表」为标准答案, 逐店比对清算表的 净销售 与 出库原价(口径一致应相等)。
  // 不比营业利润(成本分析이익=毛利, 清算营业利润还要扣平台费, 定义不同); 不比库存账(口径不同)。
  function standardVerification(month) {
    const checks = [];
    const costRows = stdCostRows(month);
    if (!costRows.length) return { month, status: 'pending', checks, hasCost: false };
    const tol = v => Math.max(100, Math.abs(v) * 0.005);
    for (const cr of costRows) {
      const def = channelDefByName(cr.channel_or_customer);
      if (!def || !def.store) continue;
      const cc = canon(def.store, month);
      if (!cc) continue;
      const dNet = Math.round(cc.net_krw) - Math.round(cr.sales_krw || 0);
      checks.push({ label: def.name + ' 净销售', clearing: Math.round(cc.net_krw), standard: Math.round(cr.sales_krw || 0), diff: dNet, ok: Math.abs(dNet) <= tol(cr.sales_krw) });
      if (cr.purchase_cost_krw) {
        const dCog = Math.round(cc.cogs_krw) - Math.round(cr.purchase_cost_krw);
        checks.push({ label: def.name + ' 出库原价', clearing: Math.round(cc.cogs_krw), standard: Math.round(cr.purchase_cost_krw), diff: dCog, ok: Math.abs(dCog) <= tol(cr.purchase_cost_krw) });
      }
    }
    if (!checks.length) return { month, status: 'pending', checks, hasCost: true };
    const bad = checks.some(x => !x.ok);
    return { month, status: bad ? 'mismatch' : 'verified', checks, hasCost: true };
  }

  function stdVerifyBadge(month, opts = {}) {
    const v = standardVerification(month);
    const cls = v.status === 'verified' ? 'verify-ok' : v.status === 'mismatch' ? 'verify-bad' : 'verify-warn';
    const text = v.status === 'verified' ? '已核对' : v.status === 'mismatch' ? '核对不一致' : '待核对';
    const miss = [];
    if (!v.hasCost) miss.push('成本分析表');
    const bad = v.checks.filter(x => !x.missing && !x.ok).map(x => `${x.label} 差异 ${fK(x.diff)}`);
    const title = v.status === 'verified'
      ? `${month} 内部标准表已核对一致`
      : (miss.length ? `缺少: ${miss.join(', ')}` : bad.join(' / '));
    return `<span class="badge ${cls}" title="${esc(title)}">${opts.short ? text : `内部标准: ${text}`}</span>`;
  }
  function standardVerificationPanel(month) {
    const v = standardVerification(month);
    const rows = v.checks.filter(x => x.missing || !x.ok);
    if (v.status === 'verified') {
      return `<div class="verify-panel ok">${stdVerifyBadge(month)} <span>当月 CD BROWN 清算数据已通过内部标准表核对。</span></div>`;
    }
    return `<div class="verify-panel ${v.status === 'mismatch' ? 'bad' : 'warn'}">
      ${stdVerifyBadge(month)}
      <span>${v.status === 'pending' ? '必须同时上传 매출대비원가분석 与 수불부&재고금액，才算当月核对完毕。' : '内部标准表与清算表不一致，当月不能标记为正确。'}</span>
      ${rows.length ? `<ul>${rows.slice(0, 6).map(x => x.missing
        ? `<li>${esc(x.label)} 未上传/未识别</li>`
        : `<li>${esc(x.source)} · ${esc(x.label)}：清算 ${fK(x.clearing)} / 标准 ${fK(x.standard)} / 差异 ${fK(x.diff)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }
  function standardLogHtml(months) {
    return (months || []).map(m => `<br>${m} ${stdVerifyBadge(m)}`).join('');
  }

  function uploadTypeLabel(type) {
    return { pdd: '清算表', stockLedgerWorkbook: '수불부&재고금액', costAnalysisWorkbook: '成本分析表', productMaster: '产品信息表', inventoryMonthly: '月末库存表', kuaishou: '快手快照' }[type] || type || '文件';
  }
  function uploadRecordsList() {
    return Object.values(S.uploadRecords || {}).sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));
  }
  async function saveUploadRecord(rec) {
    if (!S.uploadRecords) S.uploadRecords = {};
    S.uploadRecords[rec.id] = rec;
    await DB.put('uploadRecords', rec.id, rec);
  }
  function uploadRecordsHtml() {
    const rows = uploadRecordsList();
    if (!rows.length) return '<p class="note">暂无文件上传记录。新上传的文件会在这里显示，可编辑备注或按文件撤回。</p>';
    return `<table class="tbl upload-records"><thead><tr><th>文件</th><th>类型</th><th>月份</th><th>行数</th><th>上传时间</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows.map(r => `<tr>
      <td class="name-cell" title="${esc(r.filename)}">${esc(r.filename)}</td>
      <td>${uploadTypeLabel(r.type)}</td>
      <td>${(r.months || []).join(', ') || r.month || ''}</td>
      <td>${r.rows ?? ''}</td>
      <td>${String(r.uploaded_at || '').slice(0, 19).replace('T', ' ')}</td>
      <td>${esc(r.note || '')}</td>
      <td><button class="btn btn-sm" data-editupload="${r.id}">编辑</button> <button class="btn btn-sm btn-danger" data-delupload="${r.id}">删除</button></td>
    </tr>`).join('')}</tbody></table><p class="note">删除文件记录会撤回该文件写入的数据；若该月份后来又上传了新文件，新文件的数据不会被旧记录误删。</p>`;
  }
  function uploadMatches(row, rec) {
    if (!row || !rec) return false;
    if (row.upload_id && row.upload_id === rec.id) return true;
    if (row._uploadId && row._uploadId === rec.id) return true;
    const src = row.source_file || row.src || row._src || '';
    const at = row.uploaded_at || row.uploadedAt || row._uploadedAt || '';
    return !!rec.filename && src === rec.filename && (!rec.uploaded_at || at === rec.uploaded_at);
  }
  async function deleteUploadRecord(id) {
    const rec = S.uploadRecords[id];
    if (!rec) return;
    for (const store of ['summary', 'detail', 'kuaishou', 'inventoryMonthly', 'inventoryMovementMonthly', 'monthlyCostAnalysis', 'productMaster']) {
      const bucket = S[store] || {};
      for (const [k, row] of Object.entries(bucket)) {
        if (uploadMatches(row, rec)) {
          await DB.del(store, k);
          delete bucket[k];
        }
      }
    }
    await DB.del('uploadRecords', id);
    delete S.uploadRecords[id];
    invalidateInvCache();
  }

  function mkChart(el, option) {
    if (!el) return null;
    const prev = echarts.getInstanceByDom(el); // 守卫: 销毁同一DOM上的孤儿实例, 杜绝双层渲染/tooltip重叠
    if (prev) prev.dispose();
    const c = echarts.init(el, null, { renderer: 'canvas' });
    c.setOption(option);
    S.charts.push(c);
    return c;
  }
  function disposeCharts() { S.charts.forEach(c => { try { c.dispose(); } catch (e) {} }); S.charts = []; }
  // 退化图表: 当最大分类占比 >70%, 饼图信息量趋零 → 改横向条形图 (item2)
  // data: [{name,value,color}]; 返回 ECharts option (饼 或 横条)
  function pieOrBar(data, sym) {
    const arr = data.filter(d => d.value > 0);
    const tot = arr.reduce((a, b) => a + b.value, 0);
    const top = arr.slice().sort((a, b) => b.value - a.value)[0];
    const degenerate = top && tot && top.value / tot > 0.7;
    if (!degenerate) {
      return {
        tooltip: { trigger: 'item', confine: true, valueFormatter: v => (sym || '') + ' ' + fK(v) },
        legend: { top: 0, type: 'scroll', textStyle: { color: '#475569' } },
        series: [{ type: 'pie', radius: ['42%', '68%'], center: ['50%', '56%'], label: { formatter: '{b}\n{d}%', color: '#475569' }, data: arr.map(d => ({ name: d.name, value: d.value, itemStyle: { color: d.color } })) }],
      };
    }
    // 退化 → 横向条形图(按值降序), 顶部标注主导分类占比
    const sorted = arr.slice().sort((a, b) => a.value - b.value);
    return {
      _degenerate: true, _topName: top.name, _topShare: top.value / tot,
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' }, valueFormatter: v => (sym || '') + ' ' + fK(v) },
      grid: { left: 10, right: 60, top: 30, bottom: 8, containLabel: true },
      xAxis: { type: 'value', axisLabel: { color: '#475569', formatter: v => fK(v) }, splitLine: { lineStyle: { color: '#EEF2F7' } } },
      yAxis: { type: 'category', data: sorted.map(d => d.name), axisLabel: { color: '#475569' }, axisLine: { lineStyle: { color: '#CBD5E1' } } },
      series: [{ type: 'bar', barWidth: 16, data: sorted.map(d => ({ value: d.value, itemStyle: { color: d.color, borderRadius: [0, 4, 4, 0] } })), label: { show: true, position: 'right', color: '#475569', fontSize: 11, formatter: p => `${fK(p.value)} (${(p.value / tot * 100).toFixed(0)}%)` } }],
    };
  }
  window.addEventListener('resize', () => S.charts.forEach(c => c.resize()));
  const GRID = { left: 10, right: 16, top: 38, bottom: 8, containLabel: true };
  const baseAxis = { axisLine: { lineStyle: { color: '#CBD5E1' } }, axisLabel: { color: '#475569' } };

  // ---------- 视图框架 ----------
  function setView(v) {
    if (v === 'sku') v = 'store';
    if (v === 'kuaishou') v = 'overview';
    S.view = v;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    render();
  }
  function render() {
    disposeCharts();
    FX.resetMissing(); // 每轮渲染重新收集缺失汇率
    const root = $('#viewRoot');
    const hasData = Object.keys(S.summary).length > 0;
    const hasInventory = Object.keys(S.inventoryMonthly || {}).length > 0;
    const hasProducts = Object.keys(S.productMaster || {}).length > 0;
    $('#emptyHint').classList.toggle('hidden', hasData || hasInventory || S.view === 'data' || S.view === 'products');
    root.innerHTML = '';
    if (hasData || hasInventory || S.view === 'data' || S.view === 'products') {
      ({ overview: vOverview, trends: vTrends, store: vStore, inventory: vInventory, products: vProducts, data: vData }[S.view] || vOverview)(root);
    }
    renderTopbar(); // 视图渲染后再画顶栏, 才能拿到本轮缺失汇率
    updateStatus();
  }
  function updateStatus() {
    const ms = allMonths();
    const ims = invMonths();
    const stN = new Set(Object.keys(S.summary).map(k => k.split('|')[0])).size;
    $('#dataStatus').innerHTML = ms.length || ims.length
      ? `${stN} 店 · 清算${ms.length}月 · 库存${ims.length}月<br>最新: ${ms[ms.length - 1] || '—'} / 库存 ${ims[ims.length - 1] || '—'}`
      : '未加载数据 · 데이터 없음';
  }

  // ========== 视图: 总览 TTL ==========
  // 全渠道月份 = 清算月份 ∪ 成本分析月份 (后者含快手/清潭等表外渠道)
  function overviewMonths() {
    return Array.from(new Set([...allMonths(), ...costAnalysisMonths()])).sort();
  }
  function vOverview(root) {
    const months = overviewMonths();
    if (!months.length) return;
    const m = S.ovMonth && months.includes(S.ovMonth) ? S.ovMonth : months[months.length - 1];
    S.ovMonth = m;
    const pmAll = months.filter(x => x < m); const pm = pmAll.length ? pmAll[pmAll.length - 1] : null;
    const g = groupAll(m), pg = pm ? groupAll(pm) : null;
    if (!g) return;
    const channels = monthChannels(m);
    const fromCA = g._fromCostAnalysis;

    // TTL 金额: 原币模式按原样合计展示; 切换货币时 = 各渠道按各自汇率换算后整数求和
    const gm = (field, src) => {
      if (S.cur === 'ORIG') return money(g[field], src, m);
      return sumMoney(channels.map(c => ({ value: c[field] || 0, src, month: m, storeRate: c.rate })));
    };
    // P&L 闭合: 仅对有清算明细的店校验
    const plBad = storesIn(m).map(st => ({ st, chk: plCheck(canon(st, m)) })).filter(x => !x.chk.ok);

    root.innerHTML = `
      <div class="view-head">
        <h2>总览 TTL<span class="ko">전체 경영현황</span></h2>
        <div class="spacer"></div>
        <span class="badge ${fromCA ? 'g-health' : 'neutral'}" title="${fromCA ? '本月以「매출대비 원가분석」表为全渠道权威源,含快手/清潭等全部渠道' : '本月无成本分析表,按清算表4店(+已结算快手)合计'}">${fromCA ? '全渠道(成本分析源)' : '清算表源'} · ${g._channels} 渠道</span>
        <label style="font-size:12px;color:var(--muted)">月份 월:</label>
        ${stdVerifyBadge(m)}
        <select class="ctl" id="ovMonth">${months.slice().reverse().map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </div>
      ${standardVerificationPanel(m)}
      <div class="grid kpis">
        ${kpiCard('GMV', '총매출', gm('gmv_usd', 'USD'), pg ? deltaHtml(g.gmv_usd, pg.gmv_usd) : '', `净销售 ${gm('net_krw', 'KRW')}`)}
        ${kpiCard('净销售额', '매출액', gm('net_krw', 'KRW'), pg ? deltaHtml(g.net_krw, pg.net_krw) : '', `${g._channels} 渠道合计`)}
        ${kpiCard('营业利润', '영업이익', gm('profit_krw', 'KRW'), pg ? deltaHtml(g.profit_krw, pg.profit_krw) : '', `上月 ${pg ? money(pg.profit_krw, 'KRW', pm) : '—'}`)}
        ${kpiCard('利润率', '이익율', fP(g.margin), pg ? deltaHtml(g.margin, pg.margin, true, true) : '', `= 营业利润 ÷ 净销售KRW`)}
        ${kpiCard('退款率', '환불율', g.gmv_usd ? fP(g.refund_rate) : '—', pg && pg.gmv_usd ? deltaHtml(g.refund_rate, pg.refund_rate, false, true) : '', `= |退款| ÷ GMV(仅含清算店)`)}
        ${kpiCard('期末库存', '기말재고', gm('ending_inventory_krw', 'KRW'), pg ? deltaHtml(g.ending_inventory_krw, pg.ending_inventory_krw, false) : '', `约 ${g.cogs_krw ? (g.ending_inventory_krw / g.cogs_krw).toFixed(1) : '—'} 个月周转`)}
      </div>
      <div class="grid two-col" style="margin-bottom:14px">
        <div class="card"><h3>渠道贡献 · 净销售/利润 <span class="ko">채널별 기여도</span></h3><div class="chart" id="chContrib"></div></div>
        <div class="card"><h3>净销售KRW 占比 <span class="ko">매출 구성비</span></h3><div class="chart" id="chDonut"></div></div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <h3>渠道对比明细 <span class="ko">채널 비교</span><span class="spacer"></span><span class="note">环比对象: ${pm || '无上月数据'}${fromCA ? ' · 含快手/清潭等全渠道' : ''}</span></h3>
        ${plBad.length ? `<p class="note" style="color:var(--bad);font-weight:600">⛔ P&L 闭合校验未通过: ${plBad.map(x => `${META[x.st].name} 利润差 ${x.chk.diff} won`).join(' · ')} — 请核对原始清算表</p>` : ''}
        <div class="tbl-wrap">${channelTable(m, pm)}</div>
      </div>
      <div class="card"><h3>智能诊断 · 可执行待办 <span class="ko">실행 가능한 진단</span><span class="spacer"></span>
        <span class="chips" id="diagFilter"></span></h3>
        <ul class="diag" id="diagList"></ul></div>`;

    $('#ovMonth').onchange = e => { S.ovMonth = e.target.value; render(); };

    // 智能诊断渲染 (排序/筛选/下钻)
    const allDiag = diagnose(m, pm);
    const types = ['全部', ...Array.from(new Set(allDiag.map(d => d.type)))];
    const renderDiag = () => {
      const dFilter = S.diagFilter && types.includes(S.diagFilter) ? S.diagFilter : '全部'; // 实时读取
      $('#diagFilter').innerHTML = types.map(t => `<button class="chip ${t === dFilter ? 'on' : ''}" data-dtype="${t}">${t}${t === '全部' ? '' : ' ' + allDiag.filter(d => d.type === t).length}</button>`).join('');
      const list = (dFilter === '全部' ? allDiag : allDiag.filter(d => d.type === dFilter));
      $('#diagList').innerHTML = list.map((d, i) => `<li class="diag-item" data-drill="${i}" title="点击下钻到 ${d.drill.view === 'sku' ? 'SKU分析' : '店铺明细'}">
        <span class="tag ${d.lv}">${d.type}</span>
        <span class="diag-score" title="严重度分数">${d.score}</span>
        <span class="diag-txt">${d.txt}</span>
        <span class="diag-impact" title="影响金额(估算)">₩${fK(d.impactKrw)}</span>
        <span class="diag-arrow">›</span></li>`).join('') || '<li>暂无显著异常信号</li>';
      $('#diagList')._items = list;
    };
    renderDiag();
    // 渠道行点击 → 下钻(快手→快照, 其他→店铺明细)
    root.querySelectorAll('[data-ch-store]').forEach(el => el.addEventListener('click', () => {
      const st = el.dataset.chStore;
      if (st === 'kuaishou') setView('overview');
      else { S.stStore = st; S.stMonth = m; setView('store'); }
    }));
    $('#diagFilter').onclick = e => { const t = e.target.dataset?.dtype; if (t) { S.diagFilter = t; renderDiag(); } };
    $('#diagList').onclick = e => {
      const li = e.target.closest('[data-drill]'); if (!li) return;
      const d = $('#diagList')._items[+li.dataset.drill]; if (!d) return;
      if (d.drill.view === 'sku') { S.skStore = d.drill.store; S.skMonth = m; if (d.drill.sku) S.skSearchPreset = d.drill.sku; }
      else { S.stStore = d.drill.store; S.stMonth = m; }
      setView(d.drill.view);
    };

    const names = channels.map(c => c.name);
    const chartSym = S.cur === 'ORIG' ? '₩' : FX.SYM[S.cur];
    // Math.round 仅用于图表最终展示, 换算本身在 FX 内整数完成
    const chVal = (c, field) => {
      const v = moneyVal(c[field], 'KRW', m, c.rate);
      return v === null ? null : Math.round(v);
    };
    mkChart($('#chContrib'), {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: v => v == null ? '缺汇率' : chartSym + ' ' + fK(v) },
      legend: { top: 0, textStyle: { color: '#475569' } },
      grid: { ...GRID, bottom: 20 },
      xAxis: { type: 'category', data: names, ...baseAxis, axisLabel: { color: '#475569', interval: 0, rotate: names.length > 4 ? 20 : 0, fontSize: 10 } },
      yAxis: [{ type: 'value', name: chartSym, ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } } }],
      series: [
        { name: '净销售', type: 'bar', barWidth: 22, itemStyle: { color: '#3B82F6', borderRadius: [4, 4, 0, 0] }, data: channels.map(c => chVal(c, 'net_krw')) },
        { name: '营业利润', type: 'bar', barWidth: 22, itemStyle: { color: '#F59E0B', borderRadius: [4, 4, 0, 0] }, data: channels.map(c => chVal(c, 'profit_krw')) },
      ],
    });
    const donutOpt = pieOrBar(channels.map(c => ({ name: c.name, value: chVal(c, 'net_krw'), color: c.color })).filter(x => x.value !== null && x.value > 0), chartSym);
    mkChart($('#chDonut'), donutOpt);
    if (donutOpt._degenerate) $('#chDonut').insertAdjacentHTML('afterend',
      `<p class="note">「${donutOpt._topName}」占 ${(donutOpt._topShare * 100).toFixed(0)}% — 单店主导,已自动改用条形图。</p>`);
  }

  // opts: { muted:bool 弱化空状态, reason:'无投放'|'未上线'|'数据缺失', primary:bool 主指标放大 }
  function kpiCard(label, ko, val, delta, sub, opts = {}) {
    const cls = 'card kpi' + (opts.muted ? ' kpi-empty' : '') + (opts.primary ? ' kpi-primary' : '');
    const valHtml = opts.muted
      ? `<div class="k-val k-empty">${val}</div><div class="k-sub"><span class="empty-reason ${opts.reason === '数据缺失' ? 'er-missing' : opts.reason === '未上线' ? 'er-offline' : 'er-none'}">${opts.reason || '—'}</span>${sub ? ' · ' + sub : ''}</div>`
      : `<div class="k-val">${val}</div><div class="k-sub">${delta || ''} ${sub ? '· ' + sub : ''}</div>`;
    return `<div class="${cls}"><div class="k-label"><span>${label}</span><i>${ko}</i></div>${valHtml}</div>`;
  }

  // 渠道对比明细: 全渠道(成本分析源含快手/清潭), 每渠道按其原生币种统一展示
  function channelTable(m, pm) {
    const chs = monthChannels(m);
    const prevChs = pm ? monthChannels(pm) : [];
    const prevBy = {}; for (const c of prevChs) prevBy[c.key] = c;
    const rfTip = '退款率 = |退款额 USD| ÷ GMV USD (仅含拼多多/鲸芽清算店;B2B/快手无退款概念)。';
    let html = `<table class="tbl"><thead><tr>
      <th>渠道 채널</th><th>净销售 ${colCur('KRW')}</th><th>环比</th>
      <th title="${rfTip}">退款率*</th>
      <th>出库原价 ${colCur('KRW')}</th><th>营业利润 ${colCur('KRW')}</th><th>环比</th><th>利润率</th><th>期末库存 ${colCur('KRW')}</th></tr></thead><tbody>`;
    const maxNet = Math.max(1, ...chs.map(c => Math.abs(c.net_krw)));
    const maxProfit = Math.max(1, ...chs.map(c => Math.abs(c.profit_krw)));
    const barCell = (inner, val, max, cls) =>
      `<td class="bar-cell ${cls || ''}"><span class="bar-fill" style="width:${Math.max(0, Math.min(100, Math.abs(val) / max * 100)).toFixed(1)}%"></span><span class="bar-val">${inner}</span></td>`;
    for (const c of chs) {
      const pc = prevBy[c.key];
      const rr = c.gmv_usd ? Math.abs(c.refund_usd) / c.gmv_usd : null;
      const srcBadge = c.source === 'costAnalysis' ? '' : c.source === 'kuaishou' ? ' <span class="badge neutral" title="来自快手清算表">清算</span>' : '';
      const b2b = !c.hasClearing && c.store == null ? ' <span class="badge neutral" title="B2B转售(采购价+3%),来自成本分析表">B2B</span>' : '';
      const verify = c.key === 'cdbrown' ? ' ' + stdVerifyBadge(m, { short: true }) : '';
      html += `<tr ${c.store ? `class="ch-click" data-ch-store="${c.store}"` : ''} style="${c.store ? 'cursor:pointer' : ''}">
        <td><span class="badge store" style="background:${c.color}22;color:${c.color}">${esc(c.name)}</span>${verify}${b2b}${srcBadge}</td>
        ${barCell(money(c.net_krw, 'KRW', m, c.rate), c.net_krw, maxNet)}
        <td>${pc ? deltaHtml(c.net_krw, pc.net_krw) : '—'}</td>
        <td class="${rr > 0.15 ? 'neg' : ''}" title="${rfTip}">${rr === null ? '—' : fP(rr)}</td>
        <td>${money(c.cogs_krw, 'KRW', m, c.rate)}</td>
        ${barCell(money(c.profit_krw, 'KRW', m, c.rate), c.profit_krw, maxProfit, 'profit')}
        <td>${pc ? deltaHtml(c.profit_krw, pc.profit_krw) : '—'}</td>
        <td>${fP(c.margin)}</td>
        <td>${c.ending_inventory_krw ? money(c.ending_inventory_krw, 'KRW', m, c.rate) : '—'}</td></tr>`;
    }
    const g = groupAll(m), pg = pm ? groupAll(pm) : null;
    const ttl = (field, src) => {
      if (S.cur === 'ORIG') return money(g[field], src, m);
      return sumMoney(chs.map(c => ({ value: c[field] || 0, src, month: m, storeRate: c.rate })));
    };
    html += `<tr class="ttl"><td>TTL (全渠道 ${chs.length})</td>
      <td>${ttl('net_krw', 'KRW')}</td><td>${pg ? deltaHtml(g.net_krw, pg.net_krw) : '—'}</td>
      <td title="${rfTip}">${g.gmv_usd ? fP(g.refund_rate) : '—'}</td>
      <td>${ttl('cogs_krw', 'KRW')}</td>
      <td>${ttl('profit_krw', 'KRW')}</td><td>${pg ? deltaHtml(g.profit_krw, pg.profit_krw) : '—'}</td>
      <td>${fP(g.margin)}</td><td>${ttl('ending_inventory_krw', 'KRW')}</td></tr>`;
    html += `</tbody></table>
      <p class="note">净销售/利润/原价为整数won,全站同源。${g._fromCostAnalysis ? '本月以「成本分析表」为全渠道权威源,含快手/清潭等全部渠道,TTL与会计月合计一致。' : '本月无成本分析表,按清算表4店+已结算快手合计;上传成本分析表后将含全渠道。'} 点击有清算明细的渠道行可下钻店铺明细。</p>`;
    return html;
  }
  // GMV 环比突变(>200%)或上月无数据 → 数据未稳定
  function isVolatile(store, month) {
    const c = canon(store, month); if (!c) return false;
    const pm = priorMonth(month, store);
    const pc = pm ? canon(store, pm) : null;
    if (!pc || !pc.gmv_usd) return true;
    return Math.abs(c.gmv_usd - pc.gmv_usd) / Math.abs(pc.gmv_usd) > 2;
  }

  // 诊断条目: {type, lv, score(0-100), impactKrw, txt, drill:{view,store?,sku?}}
  // 说明: impactKrw / score 仅为"严重度排序与影响量级"辅助估算, 不进入任何对账金额; 用 canon 取数。
  function diagnose(m, pm) {
    const out = [];
    const lvBase = { risk: 60, warn: 40, good: 18 };
    // 影响量级加权: impact 相对该店净销售的占比, 映射到 0~40 分
    const mag = (impact, base) => Math.min(40, base > 0 ? (Math.abs(impact) / base) * 40 : 0);
    for (const st of storesIn(m)) {
      const c = canon(st, m), pc = pm ? canon(st, pm) : null;
      const nm = META[st].name;
      const krw = usd => Math.round((usd || 0) * (c.rate || 0)); // 仅用于影响量级估算
      const push = (type, lv, impactKrw, txt, drill) =>
        out.push({ type, lv, impactKrw: Math.abs(Math.round(impactKrw)), score: Math.round(lvBase[lv] + mag(impactKrw, c.net_krw)), txt, drill: drill || { view: 'store', store: st } });

      const rr = refundRate(c);
      if (rr > 0.15) push('退款', 'risk', krw(Math.abs(c.refund_usd)), `${nm} 退款率 ${fP(rr)}${pc ? ` (环比 ${((rr - refundRate(pc)) * 100).toFixed(1)}pp)` : ''},退款额 ₩${fK(krw(Math.abs(c.refund_usd)))},需逐单排查`, { view: 'store', store: st });
      const fr = feeRate(c);
      if (fr > 0.4) push('费用', 'risk', krw(Math.abs(c.fee_usd)), `${nm} 费用率 ${fP(fr)} 异常偏高,费用 ₩${fK(c.fee_krw && Math.abs(c.fee_krw))},建议与平台对账`, { view: 'store', store: st });
      if (pc && pc.profit_krw > 0 && (c.profit_krw - pc.profit_krw) / pc.profit_krw < -0.3)
        push('利润', 'warn', pc.profit_krw - c.profit_krw, `${nm} 营业利润环比 ${fP((c.profit_krw - pc.profit_krw) / Math.abs(pc.profit_krw))},减少 ₩${fK(pc.profit_krw - c.profit_krw)}`, { view: 'store', store: st });
      if (pc && pc.gmv_usd > 0 && (c.gmv_usd - pc.gmv_usd) / pc.gmv_usd > 0.5)
        push('增长', 'good', krw(c.gmv_usd - pc.gmv_usd), `${nm} GMV 环比 +${fP((c.gmv_usd - pc.gmv_usd) / pc.gmv_usd)},注意供应链承接与退款质量`, { view: 'store', store: st });
      // 连续3个月下滑
      const ms = monthsOf(st).filter(x => x <= m);
      if (ms.length >= 4) {
        const last4 = ms.slice(-4).map(x => canon(st, x).gmv_usd);
        if (last4[1] < last4[0] && last4[2] < last4[1] && last4[3] < last4[2])
          push('趋势', 'risk', krw(last4[0] - last4[3]), `${nm} GMV 连续 3 月下滑 (${last4.map(v => fU(v)).join('→')} USD),累计 −₩${fK(krw(last4[0] - last4[3]))},需流量/选品复盘`, { view: 'store', store: st });
      }
      if (c.cogs_krw > 0 && c.ending_inventory_krw / c.cogs_krw > 12)
        push('库存', 'warn', c.ending_inventory_krw, `${nm} 期末库存 ₩${fK(c.ending_inventory_krw)},约 ${(c.ending_inventory_krw / c.cogs_krw).toFixed(0)} 个月周转,建议清库`, { view: 'sku', store: st });
      // 断货风险 (settlement detail)
      const d = S.detail[st + '|' + m];
      if (d && d.inventory) {
        const risk = d.inventory.filter(i => i.sales_qty > 0 && i.ending_qty < i.sales_qty * 0.5);
        if (risk.length) {
          const top = risk.sort((a, b) => b.sales_qty - a.sales_qty)[0];
          const impact = krw((top.sales_qty - top.ending_qty) * (top.unit_cost || 0) / (c.rate || 1)); // 估算缺口价值
          push('断货', 'risk', (top.sales_qty - top.ending_qty) * (top.unit_cost || 0), `${nm} ${risk.length} 个SKU断货风险,最急 ${esc(top.sku_code)} 月销 ${top.sales_qty}/仅剩 ${top.ending_qty} → 紧急补货`, { view: 'sku', store: st, sku: top.sku_code });
        }
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // ========== 视图: 历史趋势 ==========
  // cur: 指标原始币种 (null = 比率类不换算)
  const METRICS = {
    gmv_usd: { label: 'GMV (USD)', ko: '총매출', f: r => r.gmv_usd, fmt: fU, cur: 'USD' },
    net_usd: { label: '净销售 (USD)', ko: '순매출', f: r => r.net_usd, fmt: fU, cur: 'USD' },
    net_krw: { label: '净销售 (KRW)', ko: '매출액', f: r => r.net_krw, fmt: fK, cur: 'KRW' },
    profit_krw: { label: '营业利润 (KRW)', ko: '영업이익', f: r => r.profit_krw, fmt: fK, cur: 'KRW' },
    margin: { label: '利润率', ko: '이익율', f: r => r.margin, fmt: fP, pct: true, cur: null },
    refund_rate: { label: '退款率', ko: '환불율', f: refundRate, fmt: fP, pct: true, cur: null },
    fee_rate: { label: '费用率', ko: '비용율', f: feeRate, fmt: fP, pct: true, cur: null },
    ending_inventory_krw: { label: '期末库存 (KRW)', ko: '기말재고', f: r => r.ending_inventory_krw, fmt: fK, cur: 'KRW' },
  };

  function vTrends(root) {
    const mt = S.trMetric || 'net_krw'; S.trMetric = mt;
    if (!S.trStores) S.trStores = new Set(STORE_ORDER.filter(st => monthsOf(st).length));
    const months = allMonths();
    const M = METRICS[mt];

    root.innerHTML = `
      <div class="view-head">
        <h2>历史趋势<span class="ko">월별 추세</span></h2>
        <div class="spacer"></div>
        <select class="ctl" id="trMetric">${Object.entries(METRICS).map(([k, v]) => `<option value="${k}" ${k === mt ? 'selected' : ''}>${v.label} ${v.ko}</option>`).join('')}</select>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="chips" id="trChips" style="margin-bottom:12px">
          ${STORE_ORDER.filter(st => monthsOf(st).length).map(st => `<button class="chip ${S.trStores.has(st) ? 'on' : ''}" data-st="${st}">${META[st].name}</button>`).join('')}
          <button class="chip ${S.trStores.has('_ttl') ? 'on' : ''}" data-st="_ttl">TTL</button>
        </div>
        <div class="chart tall" id="chTrend"></div>
        <p class="note">提示: 图下方滑块可缩放月份范围;点击图例可隐藏/显示店铺。各店清算起始月不同,早期月份可能为空。</p>
      </div>
      <div class="card"><h3>明细数据 <span class="ko">상세</span></h3><div class="tbl-wrap">${trendTable(months.slice().reverse(), M)}</div></div>`;

    $('#trMetric').onchange = e => { S.trMetric = e.target.value; render(); };
    $('#trChips').onclick = e => {
      const st = e.target.dataset?.st; if (!st) return;
      S.trStores.has(st) ? S.trStores.delete(st) : S.trStores.add(st);
      render();
    };

    // 金额类指标随展示货币换算 (每店每月用各自清算汇率); 比率类不换算
    const trVal = (st, m) => {
      const r = rowOf(st, m);
      if (!r) return null;
      let v = M.f(r);
      if (M.cur && S.cur !== 'ORIG') { v = moneyVal(v, M.cur, m, r.rate); if (v === null) return null; }
      return +v.toFixed(M.pct ? 4 : 0);
    };
    const trTtl = (m) => {
      const g = groupAgg(m);
      if (!g) return null;
      if (M.pct) { const v = mt === 'refund_rate' ? g.refund_rate : mt === 'fee_rate' ? g.fee_rate : g.margin; return v === undefined ? null : +v.toFixed(4); }
      if (M.cur && S.cur !== 'ORIG') {
        const r = FX.sumConvert(storesIn(m).map(st => { const row = rowOf(st, m); return { value: M.f(row) || 0, src: M.cur, month: m, storeRate: row.rate }; }), S.cur);
        return r.ok ? Math.round(r.value) : null;
      }
      return g[mt] === undefined ? null : Math.round(g[mt]);
    };
    const series = [];
    for (const st of STORE_ORDER) {
      if (!S.trStores.has(st) || !monthsOf(st).length) continue;
      series.push({
        name: META[st].name, type: 'line', smooth: true, symbolSize: 7,
        lineStyle: { width: 2.5 }, itemStyle: { color: META[st].color }, connectNulls: false,
        data: months.map(m => trVal(st, m)),
      });
    }
    if (S.trStores.has('_ttl')) {
      series.push({
        name: 'TTL', type: 'line', smooth: true, symbolSize: 7,
        lineStyle: { width: 3, type: 'dashed' }, itemStyle: { color: '#0F172A' },
        data: months.map(m => trTtl(m)),
      });
    }
    const trSym = M.cur && S.cur !== 'ORIG' ? FX.SYM[S.cur] + ' ' : '';
    mkChart($('#chTrend'), {
      tooltip: { trigger: 'axis', confine: true, valueFormatter: v => v == null ? '— (缺数据/汇率)' : trSym + M.fmt(v) },
      legend: { top: 0, type: 'scroll', itemGap: 18, textStyle: { color: '#475569' } },
      grid: { ...GRID, bottom: 48, top: 46 },
      dataZoom: [{ type: 'slider', height: 18, bottom: 8 }],
      xAxis: { type: 'category', data: months.map(mLabel), ...baseAxis },
      yAxis: { type: 'value', ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } }, axisLabel: { color: '#475569', formatter: v => M.pct ? (v * 100).toFixed(0) + '%' : (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v) } },
      series,
    });
  }

  function trendTable(months, M) {
    const sts = STORE_ORDER.filter(st => monthsOf(st).length);
    const cell = (st, m) => {
      const r = rowOf(st, m);
      if (!r) return '—';
      if (M.cur) return money(M.f(r), M.cur, m, r.rate); // 金额: 含tooltip的统一格式
      return M.fmt(M.f(r));
    };
    let html = `<table class="tbl"><thead><tr><th>店铺</th>${months.map(m => `<th>${mLabel(m)}</th>`).join('')}</tr></thead><tbody>`;
    for (const st of sts) {
      html += `<tr><td>${META[st].name}</td>${months.map(m => `<td>${cell(st, m)}</td>`).join('')}</tr>`;
    }
    html += `<tr class="ttl"><td>TTL</td>${months.map(m => {
      const g = groupAgg(m);
      if (!g) return '<td>—</td>';
      if (M.pct) { const v = S.trMetric === 'refund_rate' ? g.refund_rate : S.trMetric === 'fee_rate' ? g.fee_rate : g.margin; return `<td>${v === undefined ? '—' : M.fmt(v)}</td>`; }
      if (M.cur && S.cur !== 'ORIG') {
        return `<td>${sumMoney(storesIn(m).map(st => { const r = rowOf(st, m); return { value: M.f(r) || 0, src: M.cur, month: m, storeRate: r.rate }; }))}</td>`;
      }
      return `<td>${money(g[S.trMetric], M.cur, m)}</td>`;
    }).join('')}</tr>`;
    return html + '</tbody></table>';
  }

  // ========== 视图: 店铺明细 ==========
  // ========== View: 历史趋势矩阵版 ==========
  const TREND_METRICS = {
    net_krw: { label: '净销售额 (KRW)', short: '净销售', ko: '매출액', f: r => r.net_krw, fmt: fK, cur: 'KRW', goodUp: true },
    profit_krw: { label: '营业利润 (KRW)', short: '营业利润', ko: '영업이익', f: r => r.profit_krw, fmt: fK, cur: 'KRW', goodUp: true },
    margin: { label: '平均利润率', short: '利润率', ko: '이익률', f: r => r.margin, fmt: fP, pct: true, cur: null, goodUp: true },
    refund_rate: { label: '退款率', short: '退款率', ko: '환불률', f: r => r.refund_rate ?? refundRate(r), fmt: fP, pct: true, cur: null, goodUp: false },
    fee_rate: { label: '费用率', short: '费用率', ko: '비용률', f: r => r.fee_rate ?? feeRate(r), fmt: fP, pct: true, cur: null, goodUp: false },
    ending_inventory_krw: { label: '期末库存 (KRW)', short: '库存金额', ko: '기말재고', f: r => r.ending_inventory_krw, fmt: fK, cur: 'KRW', goodUp: false },
    gmv_usd: { label: 'GMV (USD)', short: 'GMV', ko: '총매출', f: r => r.gmv_usd, fmt: fU, cur: 'USD', goodUp: true },
  };
  const TREND_RANGES = [6, 12, 18];
  const TREND_CHANNEL_ORDER = ['cdbrown', 'ssf', 'deepte', 'jingya', 'chungdam', 'kuaishou'];

  function trendAllMonths() {
    return Array.from(new Set([...overviewMonths(), ...costAnalysisMonths()])).sort();
  }
  function trendMonths(range) {
    const months = trendAllMonths();
    const n = Number(range) || 6;
    return months.slice(Math.max(0, months.length - n));
  }
  function trendRowsByMonth(month) {
    return monthChannels(month).filter(c => c && c.key);
  }
  function trendChannelDefs(months) {
    const map = new Map();
    for (const m of months) {
      for (const c of trendRowsByMonth(m)) {
        if (!map.has(c.key)) map.set(c.key, { key: c.key, name: c.name, color: c.color || '#64748B' });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const ia = TREND_CHANNEL_ORDER.indexOf(a.key);
      const ib = TREND_CHANNEL_ORDER.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
  }
  function trendRowMap(month) {
    const out = {};
    for (const c of trendRowsByMonth(month)) out[c.key] = c;
    return out;
  }
  function trendValue(row, metricKey, month) {
    if (!row) return null;
    const M = TREND_METRICS[metricKey] || TREND_METRICS.net_krw;
    let v = Number(M.f(row));
    if (!isFinite(v)) return null;
    if (M.cur && S.cur !== 'ORIG') {
      v = moneyVal(v, M.cur, month, row.rate);
      if (v === null || !isFinite(v)) return null;
    }
    return M.pct ? +v.toFixed(4) : Math.round(v);
  }
  function trendTtlValue(month, metricKey) {
    const g = groupAll(month);
    if (!g) return null;
    if (metricKey === 'margin') return g.net_krw ? +(g.profit_krw / g.net_krw).toFixed(4) : 0;
    if (metricKey === 'refund_rate') return g.gmv_usd ? +(Math.abs(g.refund_usd) / g.gmv_usd).toFixed(4) : 0;
    if (metricKey === 'fee_rate') return g.net_usd ? +(Math.abs(g.fee_usd) / g.net_usd).toFixed(4) : 0;
    const M = TREND_METRICS[metricKey] || TREND_METRICS.net_krw;
    if (M.cur && S.cur !== 'ORIG') {
      const converted = FX.sumConvert(trendRowsByMonth(month).map(c => ({ value: M.f(c) || 0, src: M.cur, month, storeRate: c.rate })), S.cur);
      return converted.ok ? Math.round(converted.value) : null;
    }
    return Math.round(Number(g[metricKey]) || 0);
  }
  function trendFormat(value, metricKey) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    const M = TREND_METRICS[metricKey] || TREND_METRICS.net_krw;
    if (M.pct) return M.fmt(value);
    const sym = M.cur && S.cur !== 'ORIG' ? FX.SYM[S.cur] : (M.cur ? FX.SYM[M.cur] : '');
    return `${sym ? sym + ' ' : ''}${M.fmt(value)}`;
  }
  function trendDeltaHtml(cur, prev, metricKey) {
    const M = TREND_METRICS[metricKey] || TREND_METRICS.net_krw;
    if (cur === null || cur === undefined || prev === null || prev === undefined) return '<span class="delta flat">—</span>';
    return deltaHtml(cur, prev, M.goodUp !== false, !!M.pct);
  }
  function verificationShort(month) {
    const v = standardVerification(month);
    return v.status === 'verified' ? '已核对' : v.status === 'mismatch' ? '核对不一致' : '待核对';
  }
  function trendModel(months, metricKey) {
    const channels = trendChannelDefs(months);
    const rowsByMonth = {};
    for (const m of months) rowsByMonth[m] = trendRowMap(m);
    return { months, channels, metricKey, rowsByMonth };
  }
  function validateTrendModel(model) {
    const issues = [];
    const warn = (level, month, label, message) => issues.push({ level, month, label, message });
    for (const m of model.months) {
      const rows = Object.values(model.rowsByMonth[m] || {});
      const g = groupAll(m);
      if (!g && rows.length) warn('critical', m, 'TTL缺失', '渠道有数据但TTL无法汇总');
      if (g) {
        const sumNet = rows.reduce((a, r) => a + (Number(r.net_krw) || 0), 0);
        if (Math.abs(Math.round(sumNet) - Math.round(g.net_krw || 0)) > 2) warn('critical', m, 'TTL不平', `渠道净销售合计 ${fK(sumNet)} 与TTL ${fK(g.net_krw)} 不一致`);
      }
      if (rows.some(r => !isFinite(Number(r.net_krw)))) warn('critical', m, '数值异常', '存在非数字净销售');
      for (const r of rows) {
        if ((Number(r.net_krw) || 0) < 0) warn('major', m, r.name, '净销售为负，请确认退款/跨期归属');
        if (Math.abs(Number(r.margin) || 0) > 2) warn('major', m, r.name, '利润率超过200%，请确认成本或销售额');
      }
      const ver = standardVerification(m);
      if (ver.status !== 'verified') warn(ver.status === 'mismatch' ? 'major' : 'minor', m, '内部标准核对', verificationShort(m));
    }
    for (const ch of model.channels) {
      let prev = null;
      for (const m of model.months) {
        const val = trendValue(model.rowsByMonth[m]?.[ch.key], model.metricKey, m);
        if (prev !== null && val !== null && Math.abs(prev) > 0) {
          const d = (val - prev) / Math.abs(prev);
          if (Math.abs(d) >= 1) warn('minor', m, ch.name, `环比波动 ${(d * 100).toFixed(1)}%`);
        }
        if (val !== null) prev = val;
      }
    }
    return { ok: !issues.some(x => x.level === 'critical'), issues };
  }
  window.CDBI_RUN_TREND_VALIDATION = function () {
    const metric = S.trMetric || 'net_krw';
    const months = trendMonths(S.trRange || 6);
    return validateTrendModel(trendModel(months, metric));
  };

  function vTrends(root) {
    const mt = S.trMetric || 'net_krw'; S.trMetric = mt;
    const range = Number(S.trRange) || 6; S.trRange = range;
    const months = trendMonths(range);
    const metric = TREND_METRICS[mt] || TREND_METRICS.net_krw;
    const model = trendModel(months, mt);
    if (!S.trChannels || !(S.trChannels instanceof Set)) S.trChannels = new Set(model.channels.map(c => c.key));
    const validKeys = new Set(model.channels.map(c => c.key));
    S.trChannels = new Set(Array.from(S.trChannels).filter(k => validKeys.has(k)));
    if (!S.trChannels.size) S.trChannels = new Set(model.channels.map(c => c.key));
    const activeChannels = model.channels.filter(c => S.trChannels.has(c.key));
    const latest = months[months.length - 1];
    const prev = months.length > 1 ? months[months.length - 2] : null;
    const latestTotal = latest ? trendTtlValue(latest, mt) : null;
    const prevTotal = prev ? trendTtlValue(prev, mt) : null;
    const profit = latest ? trendTtlValue(latest, 'profit_krw') : null;
    const margin = latest ? trendTtlValue(latest, 'margin') : null;
    const refund = latest ? trendTtlValue(latest, 'refund_rate') : null;
    const inv = latest ? trendTtlValue(latest, 'ending_inventory_krw') : null;
    const verifiedN = months.filter(m => standardVerification(m).status === 'verified').length;
    const qa = validateTrendModel(model);

    root.innerHTML = `
      <div class="view-head trend-head">
        <h2>历史趋势<span class="ko">店铺矩阵趋势墙</span></h2>
        <div class="spacer"></div>
        <span class="trend-updated">更新日期：${new Date().toISOString().slice(0, 10)}</span>
        <button class="btn btn-sm" id="trExport">导出</button>
      </div>
      <div class="trend-toolbar card">
        <label>指标选择<select class="ctl" id="trMetric">${Object.entries(TREND_METRICS).map(([k, v]) => `<option value="${k}" ${k === mt ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label>时间范围<div class="chips">${TREND_RANGES.map(n => `<button class="chip ${range === n ? 'on' : ''}" data-range="${n}">近 ${n} 个月</button>`).join('')}</div></label>
        <label>渠道筛选<select class="ctl" id="trChannelPreset"><option value="all">全部渠道 (${model.channels.length})</option><option value="verified">只看已核对</option><option value="risk">只看异常</option></select></label>
        <div class="chips trend-channel-chips" id="trChips">${model.channels.map(c => `<button class="chip ${S.trChannels.has(c.key) ? 'on' : ''}" data-st="${c.key}">${esc(c.name)}</button>`).join('')}</div>
      </div>
      <div class="grid trend-kpis">
        ${kpiCard(`TTL ${metric.short}`, metric.ko, trendFormat(latestTotal, mt), prev ? trendDeltaHtml(latestTotal, prevTotal, mt) : '', prev ? `环比 ${prev}` : '')}
        ${kpiCard('TTL 营业利润', '영업이익', trendFormat(profit, 'profit_krw'), prev ? trendDeltaHtml(profit, trendTtlValue(prev, 'profit_krw'), 'profit_krw') : '', '')}
        ${kpiCard('平均利润率', '평균 이익률', trendFormat(margin, 'margin'), prev ? trendDeltaHtml(margin, trendTtlValue(prev, 'margin'), 'margin') : '', '')}
        ${kpiCard('退款率', '환불률', trendFormat(refund, 'refund_rate'), prev ? trendDeltaHtml(refund, trendTtlValue(prev, 'refund_rate'), 'refund_rate') : '', '')}
        ${kpiCard('期末库存', '기말재고', trendFormat(inv, 'ending_inventory_krw'), prev ? trendDeltaHtml(inv, trendTtlValue(prev, 'ending_inventory_krw'), 'ending_inventory_krw') : '', '')}
        ${kpiCard('已核对月份', '검증 완료', `${verifiedN} / ${months.length}`, '', months.length ? `${months[0]} ~ ${latest}` : '')}
      </div>
      ${trendValidationPanel(qa)}
      <div class="trend-card-grid">${activeChannels.map((ch, i) => trendChannelCard(ch, model, i + 1)).join('') || '<div class="card">暂无可展示渠道，请先上传清算表或成本分析表。</div>'}</div>
      <div class="grid trend-bottom">
        <div class="card"><h3>渠道月度环比表现热力图 <span class="ko">월별 MoM 성장률 히트맵</span></h3>${trendHeatmap(model)}</div>
        <div class="card"><h3>异常月份 TOP <span class="ko">이상 월 TOP</span></h3>${trendAnomalyList(model)}</div>
      </div>
      <div class="card trend-table-card">
        <h3>明细数据 <span class="ko">상세</span></h3>
        <div class="tbl-wrap">${trendTableV2(months.slice().reverse(), model)}</div>
      </div>`;

    $('#trMetric').onchange = e => { S.trMetric = e.target.value; render(); };
    $$('.trend-toolbar [data-range]').forEach(b => b.onclick = () => { S.trRange = Number(b.dataset.range); render(); });
    $('#trChips').onclick = e => {
      const st = e.target.dataset?.st; if (!st) return;
      S.trChannels.has(st) ? S.trChannels.delete(st) : S.trChannels.add(st);
      render();
    };
    $('#trChannelPreset').onchange = e => {
      const val = e.target.value;
      if (val === 'all') S.trChannels = new Set(model.channels.map(c => c.key));
      if (val === 'verified') S.trChannels = new Set(model.channels.filter(c => months.some(m => standardVerification(m).status === 'verified' && model.rowsByMonth[m]?.[c.key])).map(c => c.key));
      if (val === 'risk') {
        const riskNames = new Set(qa.issues.map(x => x.label));
        const riskKeys = model.channels.filter(c => riskNames.has(c.name)).map(c => c.key);
        S.trChannels = new Set(riskKeys.length ? riskKeys : model.channels.map(c => c.key));
      }
      render();
    };
    $('#trExport').onclick = () => exportTrendCsv(model);
    activeChannels.forEach((ch, idx) => renderTrendMiniChart(ch, model, idx + 1));
  }

  function trendValidationPanel(qa) {
    const critical = qa.issues.filter(x => x.level === 'critical').length;
    const major = qa.issues.filter(x => x.level === 'major').length;
    const minor = qa.issues.filter(x => x.level === 'minor').length;
    const cls = critical ? 'bad' : major ? 'warn' : 'ok';
    const title = critical ? '结果验证未通过' : major ? '结果验证有风险' : '结果验证通过';
    const rows = qa.issues.slice(0, 5).map(x => `<li><b>${esc(x.month || '')}</b> ${esc(x.label)}：${esc(x.message)}</li>`).join('');
    return `<div class="verify-panel ${cls} trend-qa">
      <span class="badge ${critical ? 'verify-bad' : major ? 'verify-warn' : 'verify-ok'}">${title}</span>
      <span>Critical ${critical} / Major ${major} / Minor ${minor}。页面已执行 TTL 平衡、异常数值、核对状态和环比波动检查。</span>
      ${rows ? `<ul>${rows}</ul>` : ''}
    </div>`;
  }
  function trendValidationPanel(qa) {
    const critical = qa.issues.filter(x => x.level === 'critical').length;
    const major = qa.issues.filter(x => x.level === 'major').length;
    const minor = qa.issues.filter(x => x.level === 'minor').length;
    const cls = critical ? 'bad' : major ? 'warn' : 'ok';
    const title = critical ? '结果验证未通过' : major ? '结果验证有风险' : '结果验证通过';
    const badgeCls = critical ? 'verify-bad' : major ? 'verify-warn' : 'verify-ok';
    const rows = qa.issues.slice(0, 12).map(x => `<li><b>${esc(x.month || '')}</b> ${esc(x.label)}：${esc(x.message)}</li>`).join('');
    const action = critical
      ? '处理：先暂停对外汇报，优先核对该月份清算表、内部标准表和TTL汇总口径。'
      : major
        ? '处理：需要人工确认标准表是否已上传、跨期退款/费用是否属于业务事实。'
        : '处理：仅保留监控，Minor 多为环比波动提醒，不一定代表数据错误。';
    return `<details class="verify-panel ${cls} trend-qa trend-qa-collapsed">
      <summary>
        <span class="badge ${badgeCls}">${title}</span>
        <span>Critical ${critical} / Major ${major} / Minor ${minor}</span>
        <small>已检查 TTL 平衡、异常数值、内部标准核对和环比波动</small>
      </summary>
      <div class="verify-help">${action}</div>
      ${rows ? `<ul>${rows}</ul>` : '<div class="verify-help">当前未发现需要处理的异常。</div>'}
    </details>`;
  }

  function trendChannelCard(ch, model, rank) {
    const months = model.months;
    const latest = months[months.length - 1];
    const prev = months.length > 1 ? months[months.length - 2] : null;
    const row = model.rowsByMonth[latest]?.[ch.key];
    const prow = prev ? model.rowsByMonth[prev]?.[ch.key] : null;
    const value = trendValue(row, model.metricKey, latest);
    const pvalue = trendValue(prow, model.metricKey, prev);
    const margin = trendValue(row, 'margin', latest);
    const net = trendValue(row, 'net_krw', latest);
    const ver = standardVerification(latest).status;
    const verCls = ver === 'verified' ? 'verify-ok' : ver === 'mismatch' ? 'verify-bad' : 'verify-warn';
    return `<div class="trend-store-card card">
      <div class="trend-store-meta"><span class="rank" style="background:${ch.color}">${rank}</span><b>${esc(ch.name)}</b><span class="badge ${verCls}">${verificationShort(latest)}</span></div>
      <div class="trend-store-body">
        <div class="trend-store-stats">
          <span>${TREND_METRICS[model.metricKey].short}</span><strong>${trendFormat(value, model.metricKey)}</strong><small>环比 ${trendDeltaHtml(value, pvalue, model.metricKey)}</small>
          <span>利润率</span><strong>${trendFormat(margin, 'margin')}</strong><small>净销售 ${trendFormat(net, 'net_krw')}</small>
        </div>
        <div class="chart trend-mini-chart" id="trMini${rank}"></div>
      </div>
    </div>`;
  }
  function renderTrendMiniChart(ch, model, rank) {
    const M = TREND_METRICS[model.metricKey] || TREND_METRICS.net_krw;
    const data = model.months.map(m => trendValue(model.rowsByMonth[m]?.[ch.key], model.metricKey, m));
    mkChart($(`#trMini${rank}`), {
      animation: false,
      tooltip: { trigger: 'axis', confine: true, valueFormatter: v => trendFormat(v, model.metricKey) },
      grid: { left: 8, right: 8, top: 14, bottom: 18, containLabel: true },
      xAxis: { type: 'category', data: model.months.map(mLabel), axisTick: { show: false }, axisLabel: { color: '#64748B', fontSize: 10 }, axisLine: { lineStyle: { color: '#CBD5E1' } } },
      yAxis: { type: 'value', axisLabel: { color: '#64748B', fontSize: 10, formatter: v => M.pct ? (v * 100).toFixed(0) + '%' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v }, splitLine: { lineStyle: { color: '#EEF2F7' } } },
      series: [{ name: ch.name, type: 'line', smooth: true, symbolSize: 5, connectNulls: false, lineStyle: { width: 2.2, color: ch.color }, itemStyle: { color: ch.color }, areaStyle: { color: ch.color, opacity: 0.05 }, data }],
    });
  }
  function trendHeatmap(model) {
    const months = model.months;
    const cell = (ch, m, i) => {
      const cur = trendValue(model.rowsByMonth[m]?.[ch.key], model.metricKey, m);
      const prev = i ? trendValue(model.rowsByMonth[months[i - 1]]?.[ch.key], model.metricKey, months[i - 1]) : null;
      if (cur === null || prev === null || !prev) return '<td class="hm miss">—</td>';
      const d = (cur - prev) / Math.abs(prev);
      const cls = d >= 0.1 ? 'up2' : d >= 0 ? 'up1' : d <= -0.1 ? 'down2' : 'down1';
      return `<td class="hm ${cls}">${d > 0 ? '▲' : '▼'} ${(Math.abs(d) * 100).toFixed(1)}%</td>`;
    };
    return `<div class="tbl-wrap"><table class="tbl trend-heatmap"><thead><tr><th>渠道 / 月份</th>${months.map(m => `<th>${mLabel(m)}</th>`).join('')}</tr></thead><tbody>
      ${model.channels.map(ch => `<tr><td><span class="rank sm" style="background:${ch.color}"></span>${esc(ch.name)}</td>${months.map((m, i) => cell(ch, m, i)).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  }
  function trendAnomalyList(model) {
    const items = [];
    for (const ch of model.channels) {
      for (let i = 1; i < model.months.length; i++) {
        const m = model.months[i], pm = model.months[i - 1];
        const cur = trendValue(model.rowsByMonth[m]?.[ch.key], model.metricKey, m);
        const prev = trendValue(model.rowsByMonth[pm]?.[ch.key], model.metricKey, pm);
        if (cur === null || prev === null || !prev) continue;
        const d = (cur - prev) / Math.abs(prev);
        if (Math.abs(d) >= 0.1) items.push({ ch, m, d, type: d > 0 ? '环比异常增长' : '环比大幅下降', status: verificationShort(m) });
      }
    }
    const top = items.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
    if (!top.length) return '<p class="note">当前范围内没有超过 10% 的异常波动。</p>';
    return `<table class="tbl trend-anomaly"><thead><tr><th>渠道</th><th>月份</th><th>环比变化</th><th>异常类型</th><th>状态</th></tr></thead><tbody>
      ${top.map((x, i) => `<tr><td><span class="rank sm" style="background:${x.ch.color}">${i + 1}</span>${esc(x.ch.name)}</td><td>${mLabel(x.m)}</td><td>${x.d > 0 ? '<span class="delta up">▲ +' : '<span class="delta down">▼ '}${(x.d * 100).toFixed(1)}%</span></td><td>${x.type}</td><td>${x.status}</td></tr>`).join('')}
    </tbody></table>`;
  }
  function trendTableV2(months, model) {
    let html = `<table class="tbl"><thead><tr><th>渠道</th>${months.map(m => `<th>${mLabel(m)}</th>`).join('')}</tr></thead><tbody>`;
    for (const ch of model.channels) {
      html += `<tr><td>${esc(ch.name)}</td>${months.map(m => `<td>${trendFormat(trendValue(model.rowsByMonth[m]?.[ch.key], model.metricKey, m), model.metricKey)}</td>`).join('')}</tr>`;
    }
    html += `<tr class="ttl"><td>TTL</td>${months.map(m => `<td>${trendFormat(trendTtlValue(m, model.metricKey), model.metricKey)}</td>`).join('')}</tr>`;
    return html + '</tbody></table>';
  }
  function exportTrendCsv(model) {
    const rows = [['month', 'channel', 'metric', 'value', 'verification_status']];
    for (const m of model.months) {
      for (const ch of model.channels) rows.push([m, ch.name, model.metricKey, trendValue(model.rowsByMonth[m]?.[ch.key], model.metricKey, m) ?? '', verificationShort(m)]);
    }
    const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `CD-BI_trends_${model.months[0] || ''}_${model.months[model.months.length - 1] || ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function vStore(root) {
    const avail = STORE_ORDER.filter(st => monthsOf(st).length);
    if (!avail.length) return;
    const st = S.stStore && avail.includes(S.stStore) ? S.stStore : avail[0];
    S.stStore = st;
    const months = monthsOf(st);
    const m = S.stMonth && months.includes(S.stMonth) ? S.stMonth : months[months.length - 1];
    S.stMonth = m;
    const pm = priorMonth(m, st);
    const r = rowOf(st, m), p = pm ? rowOf(st, pm) : null;
    const roi = r.ad_usd ? r.net_usd / Math.abs(r.ad_usd) : null;

    root.innerHTML = `
      <div class="view-head">
        <h2>店铺明细<span class="ko">스토어 상세</span></h2>
        <div class="spacer"></div>
        <div class="chips">${avail.map(x => `<button class="chip ${x === st ? 'on' : ''}" data-st="${x}">${META[x].name}</button>`).join('')}</div>
        <select class="ctl" id="stMonth">${months.slice().reverse().map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </div>
      <div class="grid kpis kpis-primary">
        ${kpiCard('净销售', '매출액', money(r.net_krw, 'KRW', m, r.rate), p ? deltaHtml(r.net_krw, p.net_krw) : '', money(r.net_usd, 'USD', m, r.rate), { primary: true })}
        ${kpiCard('营业利润', '영업이익', money(r.profit_krw, 'KRW', m, r.rate), p ? deltaHtml(r.profit_krw, p.profit_krw) : '', '', { primary: true })}
        ${kpiCard('利润率', '이익율', fP(r.margin), p ? deltaHtml(r.margin, p.margin, true, true) : '', '', { primary: true })}
      </div>
      <div class="grid kpis kpis-secondary">
        ${kpiCard('GMV', '총매출', money(r.gmv_usd, 'USD', m, r.rate), p ? deltaHtml(r.gmv_usd, p.gmv_usd) : '', '')}
        ${kpiCard('退款率', '환불율', fP(refundRate(r)), p ? deltaHtml(refundRate(r), refundRate(p), false, true) : '', money(Math.abs(r.refund_usd), 'USD', m, r.rate))}
        ${kpiCard('费用率', '비용율', fP(feeRate(r)), p ? deltaHtml(feeRate(r), feeRate(p), false, true) : '', money(Math.abs(r.fee_usd), 'USD', m, r.rate))}
        ${roi ? kpiCard('广告ROI', '광고 ROI', roi.toFixed(1) + 'x', '', `广告 ${money(Math.abs(r.ad_usd), 'USD', m, r.rate)}`)
          : kpiCard('广告ROI', '광고 ROI', '—', '', '本月广告费为 0', { muted: true, reason: '无投放' })}
        ${kpiCard('期末库存', '기말재고', money(r.ending_inventory_krw, 'KRW', m, r.rate), p ? deltaHtml(r.ending_inventory_krw, p.ending_inventory_krw, false) : '', r.cogs_krw ? `≈ ${(r.ending_inventory_krw / r.cogs_krw).toFixed(1)} 个月` : '')}
      </div>
      <div class="grid two-col" style="margin-bottom:14px">
        <div class="card"><h3>净销售 & 利润率 走势 <span class="ko">매출·이익율 추이</span></h3><div class="chart" id="chStTrend"></div></div>
        <div class="card"><h3>利润结构 · ${m} <span class="ko">손익 구조</span></h3><div class="chart" id="chWater"></div></div>
      </div>
      <div class="grid two-col">
        <div class="card"><h3>费用构成 · ${m} <span class="ko">비용 내역</span></h3>${feeTable(r, m)}</div>
        <div class="card"><h3>Top SKU · ${m} <span class="ko">상위 상품</span></h3><div id="topSku">${topSkuMini(st, m)}</div></div>
      </div>`;

    root.querySelector('.chips').onclick = e => { const x = e.target.dataset?.st; if (x) { S.stStore = x; S.stMonth = null; render(); } };
    $('#stMonth').onchange = e => { S.stMonth = e.target.value; render(); };

    const stSym = S.cur === 'ORIG' ? '₩' : FX.SYM[S.cur];
    mkChart($('#chStTrend'), {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { color: '#475569' } },
      grid: GRID,
      xAxis: { type: 'category', data: months.map(mLabel), ...baseAxis },
      yAxis: [
        { type: 'value', name: stSym, ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } }, axisLabel: { color: '#475569', formatter: v => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v } },
        { type: 'value', name: '%', ...baseAxis, splitLine: { show: false }, axisLabel: { color: '#475569', formatter: v => (v * 100).toFixed(0) + '%' }, max: v => Math.max(0.8, v.max) },
      ],
      series: [
        { name: '净销售', type: 'bar', barWidth: 18, itemStyle: { color: META[st].color, borderRadius: [4, 4, 0, 0] }, data: months.map(x => { const row = rowOf(st, x); const v = moneyVal(row.net_krw, 'KRW', x, row.rate); return v === null ? null : Math.round(v); }), valueFormatter: v => stSym + fK(v) },
        { name: '利润率', type: 'line', yAxisIndex: 1, smooth: true, itemStyle: { color: '#DC2626' }, lineStyle: { width: 2.5 }, data: months.map(x => +rowOf(st, x).margin.toFixed(4)) },
      ],
    });

    // 用 SSOT canon 整数值, 与卡片/表格同源; 费用KRW = fee_usd×汇率(整数, 含广告/技术/CS/其他收入净额)
    const cc = canon(st, m);
    const feeKrw = cc.fee_krw;
    const items = [['净销售', cc.net_krw], ['出库原价', -cc.cogs_krw], ['平台费用', feeKrw], ['营业利润', cc.profit_krw]];
    const plc = plCheck(cc); // 闭合: 净销售-原价+费用KRW 是否=文件利润
    // 瀑布图随展示货币换算; 任一项缺汇率则整图回退原币KRW(不画0)
    let itemsC = items, waterSym = '₩';
    if (S.cur !== 'ORIG' && S.cur !== 'KRW') {
      const conv = items.map(([n, v]) => [n, moneyVal(v, 'KRW', m, r.rate)]);
      if (conv.every(x => x[1] !== null)) { itemsC = conv; waterSym = FX.SYM[S.cur]; }
    }
    let base = 0;
    const inv = [], val = [];
    itemsC.forEach(([n, v], i) => {
      if (i === itemsC.length - 1) { inv.push(0); val.push(Math.round(v)); }
      else if (i === 0) { inv.push(0); val.push(Math.round(v)); base = v; }
      else { base += v; inv.push(Math.round(base)); val.push(Math.round(-Math.abs(v))); }
    });
    mkChart($('#chWater'), {
      tooltip: { trigger: 'axis', valueFormatter: v => waterSym + ' ' + fK(Math.abs(v)) },
      grid: GRID,
      xAxis: { type: 'category', data: items.map(x => x[0]), ...baseAxis },
      yAxis: { type: 'value', ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } }, axisLabel: { color: '#475569', formatter: v => (v / 1e6).toFixed(0) + 'M' } },
      series: [
        { type: 'bar', stack: 'w', itemStyle: { color: 'transparent' }, tooltip: { show: false }, data: inv },
        { type: 'bar', stack: 'w', barWidth: 42, data: val.map((v, i) => ({ value: Math.abs(v), itemStyle: { color: i === 0 ? '#3B82F6' : i === items.length - 1 ? (cc.profit_krw >= 0 ? '#16A34A' : '#DC2626') : '#F59E0B', borderRadius: 4 } })),
          label: { show: true, position: 'top', color: '#475569', fontSize: 11,
            // 带正负号增量: 首末为绝对值, 中间段标注 -增量
            formatter: pp => (pp.dataIndex === 0 || pp.dataIndex === items.length - 1) ? fK(pp.value) : '−' + fK(pp.value) } },
      ],
    });
    // 强制闭合断言: 净销售 − 出库原价 − |平台费用| = 营业利润; 不等则红字报警
    const closeTxt = `净销售 ${fK(cc.net_krw)} − 出库原价 ${fK(cc.cogs_krw)} ${feeKrw < 0 ? '−' : '+'} 费用 ${fK(Math.abs(feeKrw))} = ${fK(cc._profit_recalc)}　|　文件利润 ${fK(cc.profit_krw)}`;
    $('#chWater').insertAdjacentHTML('afterend', plc.ok
      ? `<p class="note" style="color:var(--good)">✓ P&L 闭合: ${closeTxt}（差 ${plc.diff} won,在换算尾差容差内）</p>`
      : `<p class="note" style="color:var(--bad);font-weight:600">⛔ P&L 不闭合: ${closeTxt} → 差 ${plc.diff} won,请核对原始清算表!</p>`);
  }

  function feeTable(r, m) {
    const rows = [
      ['平台总费用 수수료', r.fee_usd, true],
      ['└ 技术服务费 기술서비스', r.tech_fee_usd],
      ['└ 售后/CS费 CS비용', r.cs_fee_usd],
      ['└ 广告费 광고비', r.ad_usd],
      ['└ 其他收入(申诉补回)', r.other_income_usd],
    ];
    let html = `<table class="tbl"><thead><tr><th>项目</th><th>${colCur('USD')}</th><th>占净销售</th></tr></thead><tbody>`;
    for (const [n, v, bold] of rows) {
      if (!v && !bold) continue;
      html += `<tr><td${bold ? ' style="font-weight:700"' : ''}>${n}</td><td>${money(v, 'USD', m, r.rate)}</td><td>${r.net_usd ? fP(Math.abs(v) / r.net_usd) : '—'}</td></tr>`;
    }
    html += '</tbody></table><p class="note">注: 总费用已含广告/技术/CS等明细项;明细各项为0或店铺无该字段时不展示。</p>';
    return html;
  }

  function topSkuMini(st, m) {
    const d = S.detail[st + '|' + m];
    if (!d || !d.skus.length) return '<p class="note">该月无SKU明细 (仅汇总数据)。上传该月清算表原件可获得SKU明细。</p>';
    const invNames = {};
    for (const it of (d.inventory || [])) invNames[it.sku_code] = it.name_kr;
    const top = d.skus.slice().sort((a, b) => b.sales_cny - a.sales_cny).slice(0, 6)
      .map(s => ({ ...s, name: s.name || invNames[s.sku_code] || '' }));
    const tot = d.skus.reduce((a, b) => a + b.sales_cny, 0);
    const r0 = rowOf(st, m);
    let html = `<table class="tbl"><thead><tr><th>품번</th><th class="name-cell">商品</th><th>件数</th><th>销售 ${colCur('CNY')}</th><th>占比</th><th>毛利率</th></tr></thead><tbody>`;
    for (const s of top) {
      html += `<tr><td>${esc(s.sku_code)}</td><td class="name-cell">${esc(s.name || '—')}</td><td>${fK(s.qty)}</td><td>${money(s.sales_cny, 'CNY', m, r0 && r0.rate)}</td><td>${tot ? fP(s.sales_cny / tot) : '—'}</td><td class="${s.margin < 0.2 ? 'neg' : ''}">${fP(s.margin)}</td></tr>`;
    }
    return html + '</tbody></table>';
  }

  // ========== 视图: SKU·ABC ==========
  function vSku(root) {
    const avail = STORE_ORDER.filter(st => detailMonths(st).length);
    if (!avail.length) { root.innerHTML = '<div class="card"><p class="note">暂无SKU明细数据。请在数据中心上传清算表原件。</p></div>'; return; }
    const st = S.skStore && avail.includes(S.skStore) ? S.skStore : avail[0];
    S.skStore = st;
    const months = detailMonths(st);
    const m = S.skMonth && months.includes(S.skMonth) ? S.skMonth : months[months.length - 1];
    S.skMonth = m;
    const d = S.detail[st + '|' + m];
    const invNames = {};
    for (const it of (d.inventory || [])) invNames[it.sku_code] = it.name_kr;
    const skus = d.skus.slice().sort((a, b) => b.sales_cny - a.sales_cny);
    const tot = skus.reduce((a, b) => a + b.sales_cny, 0);
    let cum = 0;
    const rows = skus.map((s, i) => {
      const share = tot ? s.sales_cny / tot : 0;
      const prev = cum; // 标准帕累托: 按进入本行前的累计占比定级, 头部单品恒为A
      cum += share;
      return { ...s, i: i + 1, share, cum, name: s.name || invNames[s.sku_code] || '', abc: prev < 0.7 ? 'A' : prev < 0.9 ? 'B' : 'C' };
    });
    const top1 = rows[0], top3 = rows.slice(0, 3).reduce((a, b) => a + b.share, 0);
    const cntA = rows.filter(x => x.abc === 'A').length, cntB = rows.filter(x => x.abc === 'B').length;
    const skRate = (rowOf(st, m) || {}).rate; // 店铺清算汇率上下文
    const invMap = invBySkuMonth(m);
    const qaDiffs = rows.map(x => {
      const inv = invMap[x.sku_code];
      if (!inv) return null;
      const diff = (Number(inv.outbound_qty) || 0) - (Number(x.qty) || 0);
      return { sku: x.sku_code, diff, sales: x.qty, outbound: inv.outbound_qty };
    }).filter(Boolean).filter(x => Math.abs(x.diff) > Math.max(3, Math.abs(x.sales) * 0.1));

    root.innerHTML = `
      <div class="view-head">
        <h2>SKU·ABC 分析<span class="ko">상품 파레토 분석</span></h2>
        <div class="spacer"></div>
        <div class="chips">${avail.map(x => `<button class="chip ${x === st ? 'on' : ''}" data-st="${x}">${META[x].name}</button>`).join('')}</div>
        <select class="ctl" id="skMonth">${months.slice().reverse().map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </div>
      <div class="grid kpis">
        ${kpiCard('动销 SKU', '판매 SKU', rows.length + ' 款', '', `A类 ${cntA} / B类 ${cntB} / C类 ${rows.length - cntA - cntB}`)}
        ${kpiCard('Top1 集中度', '집중도', top1 ? fP(top1.share) : '—', '', top1 ? esc(top1.sku_code) : '')}
        ${kpiCard('Top3 集中度', '', fP(top3), '', top3 > 0.85 ? '⚠ 高度依赖头部' : '')}
        ${kpiCard('销售合计', '판매합계', money(tot, 'CNY', m, skRate), '', money(skus.reduce((a, b) => a + b.usd_total, 0), 'USD', m, skRate))}
        ${kpiCard('库存QA差异', '재고 QA', qaDiffs.length + ' SKU', '', '销售数量 vs 库存表 출고')}
      </div>
      <div class="card" style="margin-bottom:14px"><h3>SKU 贡献结构 <span class="ko">상품 기여도</span></h3><div class="chart tall" id="chPareto"></div>
      <p class="note">柱=单SKU销售额，线=累计销售贡献。用于判断销售是否过度集中、腰部SKU是否不足；ABC只是辅助标签，不再作为唯一判断。</p></div>
      <div class="card"><h3>SKU 明细 <span class="ko">상세</span><span class="spacer"></span><input class="searchbox" id="skSearch" placeholder="搜索 품번/商品名"></h3>
      <div class="tbl-wrap" id="skTbl"></div></div>`;

    root.querySelector('.chips').onclick = e => { const x = e.target.dataset?.st; if (x) { S.skStore = x; S.skMonth = null; render(); } };
    $('#skMonth').onchange = e => { S.skMonth = e.target.value; render(); };

    const renderTbl = (filter) => {
      const fr = filter ? rows.filter(x => (x.sku_code + x.name).toLowerCase().includes(filter.toLowerCase())) : rows;
      let html = `<table class="tbl"><thead><tr><th>#</th><th>품번</th><th class="name-cell">商品名</th><th>本月销售</th><th>库存출고</th><th>期末库存</th><th>可售月数</th><th>销售 ${colCur('CNY')}</th><th>占比</th><th>累计</th><th>合计 ${colCur('USD')}</th><th>原价 ${colCur('KRW')}/件</th><th>毛利率</th><th>ABC</th></tr></thead><tbody>`;
      for (const x of fr) {
        const inv = invMap[x.sku_code];
        const cover = inv && x.qty > 0 ? inv.ending_qty / x.qty : (inv && inv.ending_qty > 0 ? 9999 : null);
        const diff = inv ? inv.outbound_qty - x.qty : null;
        html += `<tr><td>${x.i}</td><td>${esc(x.sku_code)}</td><td class="name-cell">${esc(x.name || '—')}</td>
          <td>${fK(x.qty)}</td><td class="${diff !== null && Math.abs(diff) > Math.max(3, Math.abs(x.qty) * 0.1) ? 'neg' : ''}">${inv ? fK(inv.outbound_qty) : '—'}</td>
          <td>${inv ? fK(inv.ending_qty) : '—'}</td><td>${cover === null ? '—' : cover >= 9999 ? '∞' : fU2(cover)}</td>
          <td>${money(x.sales_cny, 'CNY', m, skRate)}</td><td>${fP(x.share)}</td><td>${fP(x.cum)}</td>
          <td>${money(x.usd_total, 'USD', m, skRate)}</td><td>${money(x.cost_krw_per, 'KRW', m, skRate)}</td>
          <td class="${x.margin < 0.2 ? 'neg' : x.margin > 0.5 ? 'pos' : ''}">${fP(x.margin)}</td>
          <td><span class="badge ${x.abc}">${x.abc}</span></td></tr>`;
      }
      $('#skTbl').innerHTML = html + '</tbody></table>' +
        (qaDiffs.length ? `<p class="note" style="color:#B45309">⚠ 库存QA: ${qaDiffs.slice(0, 8).map(x => `${esc(x.sku)} 销售${fK(x.sales)} vs 출고${fK(x.outbound)}`).join(' · ')}${qaDiffs.length > 8 ? ` 等${qaDiffs.length}项` : ''}</p>` : '<p class="note">库存QA: 当前月销售SKU与库存出库未发现显著差异。</p>');
    };
    // 来自诊断下钻的 SKU 预设搜索
    const preset = S.skSearchPreset; S.skSearchPreset = null;
    if (preset) { $('#skSearch').value = preset; renderTbl(preset); } else renderTbl('');
    $('#skSearch').oninput = e => renderTbl(e.target.value.trim());

    mkChart($('#chPareto'), {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { color: '#475569' } },
      grid: { ...GRID, top: 42 },
      xAxis: { type: 'category', data: rows.map(x => x.sku_code), ...baseAxis, axisLabel: { color: '#475569', rotate: rows.length > 12 ? 38 : 0, fontSize: 10 } },
      yAxis: [
        { type: 'value', name: S.cur === 'ORIG' ? 'CNY' : S.cur, ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } } },
        { type: 'value', max: 1, ...baseAxis, splitLine: { show: false }, axisLabel: { color: '#475569', formatter: v => (v * 100) + '%' } },
      ],
      series: [
        { name: '销售额', type: 'bar', barMaxWidth: 30, itemStyle: { color: '#3B82F6', borderRadius: [3, 3, 0, 0] }, data: rows.map(x => { const v = moneyVal(x.sales_cny, 'CNY', m, skRate); return v === null ? null : Math.round(v); }) },
        { name: '累计占比', type: 'line', yAxisIndex: 1, smooth: true, itemStyle: { color: '#F59E0B' }, lineStyle: { width: 2.5 }, data: rows.map(x => +x.cum.toFixed(4)),
          markLine: { silent: true, symbol: 'none', label: { formatter: p => p.value === 0.7 ? 'A|B 70%' : 'B|C 90%', color: '#94A3B8' }, lineStyle: { type: 'dashed' }, data: [{ yAxis: 0.7, lineStyle: { color: '#DC2626' } }, { yAxis: 0.9, lineStyle: { color: '#F59E0B' } }] } },
      ],
    });
  }

  // ========== 视图: 库存预警 ==========
  const GRADES = [
    ['stockout', '断货', '库存 < 0.5×月销', '紧急补货'],
    ['urgent', '紧急', '周转>365天 且 金额>50万', '清仓/促销/捆绑'],
    ['focus', '重点', '>180天 或 (>90天且>30万)', '减缓采购+促销'],
    ['watch', '观察', '60~90天', '持续监控'],
    ['health', '健康', '<60天', '保持节奏'],
  ];
  function gradeOf(it, days) {
    const t = it.sales_qty > 0 ? it.ending_qty / (it.sales_qty / days) : 9999;
    let g;
    if (it.sales_qty > 0 && it.ending_qty < it.sales_qty * 0.5) g = 'stockout';
    else if (t > 365 && it.ending_value_krw > 500000) g = 'urgent';
    else if (t > 180 || (t > 90 && it.ending_value_krw > 300000)) g = 'focus';
    else if (t >= 60 && t <= 90) g = 'watch';
    else g = 'health';
    return { g, t: Math.min(t, 9999) };
  }

  function vInventory(root) {
    const invModel = inventoryViewModel();
    const months = invModel.months;
    if (!months.length) { root.innerHTML = '<div class="card"><p class="note">暂无库存标准账数据。请在数据中心上传 ▶수불부&재고금액 工作簿;库存管理只采用该表的 수불부 与 재고금액 数据。</p></div>'; return; }
    const m = S.invMonth && months.includes(S.invMonth) ? S.invMonth : months[months.length - 1];
    S.invMonth = m;
    let wh = S.invWh || 'all';
    const monthRows = invModel.byMonth.get(m) || [];
    const whs = Array.from(new Set(monthRows.map(r => r.warehouse || '???'))).sort();
    if (wh !== 'all' && !whs.includes(wh)) wh = 'all';
    const warehouseRows = wh === 'all' ? monthRows : monthRows.filter(r => (r.warehouse || '???') === wh);
    const prefixes = Array.from(new Set(warehouseRows.map(r => brandNameForSku(r.sku_code)))).sort();
    const pf = S.invPrefix || 'all';
    const q = S.invSearch || '';
    const matchesInvFilters = r => {
      if (wh !== 'all' && (r.warehouse || '???') !== wh) return false;
      if (pf !== 'all' && brandNameForSku(r.sku_code) !== pf) return false;
      if (q && !(String(r.sku_code).toLowerCase() + String(r.product_name).toLowerCase()).includes(q.toLowerCase())) return false;
      return true;
    };
    const curRows = warehouseRows.filter(matchesInvFilters).map(r => ({ ...r, risk: invRisk(r) }));
    const trendRows = invModel.rows.filter(matchesInvFilters);
    const costed = curRows.filter(r => !r.cost_missing);
    const missing = curRows.filter(r => r.cost_missing);
    const totalValue = costed.reduce((a, b) => a + (b.ending_value_krw || 0), 0);
    const totalQty = curRows.reduce((a, b) => a + (b.ending_qty || 0), 0);
    const inboundOf = inboundQtyOf;
    const outboundOf = outboundQtyOf;
    const openingOf = openingQtyOf;
    const totalInbound = curRows.reduce((a, b) => a + inboundOf(b), 0);
    const totalOutbound = curRows.reduce((a, b) => a + outboundOf(b), 0);
    const totalOutboundValue = curRows.reduce((a, b) => a + outboundOf(b) * (Number(b.unit_cost_krw) || 0), 0);
    const high = curRows.filter(r => r.risk.level === 'urgent' || r.risk.level === 'focus');
    const slow = curRows.filter(r => r.risk.level === 'slow' || (r.risk.avgOut < 1 && r.ending_qty > 0 && r.risk.level !== 'stockout'));
    const stockout = curRows.filter(r => r.risk.level === 'stockout');
    // 账簿闭合 QA: 仅使用 수불부&재고금액 内部数据。
    const qaPairs = curRows.map(r => {
      const expectedEnding = openingQtyOf(r) + inboundQtyOf(r) - outboundQtyOf(r);
      const diff = (Number(r.ending_qty) || 0) - expectedEnding;
      return { sku: r.sku_code, name: r.product_name || '', ending: Number(r.ending_qty) || 0, expectedEnding, diff, warehouse: r.warehouse || '未指定' };
    });
    const qaMismatch = qaPairs.filter(x => Math.abs(x.diff) >= 1).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const qaMatched = qaPairs.length - qaMismatch.length;
    const skuOptions = Array.from(new Set(curRows.map(r => r.sku_code))).sort();
    const focusSku = S.invSkuTrend && skuOptions.includes(S.invSkuTrend) ? S.invSkuTrend : (curRows.slice().sort((a, b) => (b.ending_value_krw || 0) - (a.ending_value_krw || 0))[0]?.sku_code || skuOptions[0] || '');
    S.invSkuTrend = focusSku;
    const skuLabel = sku => {
      const r = trendRows.find(x => x.sku_code === sku) || curRows.find(x => x.sku_code === sku);
      const name = r ? r.product_name : '';
      return `${sku}${name ? ' · ' + name : ''}`;
    };

    const trendMap = new Map();
    const fkey = skuKey(focusSku);
    const skuTrendMap = new Map();
    for (const r of trendRows) {
      const mo = r.month || '';
      const cur = trendMap.get(mo) || { value: 0, qty: 0 };
      if (!r.cost_missing) cur.value += r.ending_value_krw || 0;
      cur.qty += r.ending_qty || 0;
      trendMap.set(mo, cur);
      if (skuKey(r.sku_code) === fkey) {
        const skuCur = skuTrendMap.get(mo) || { qty: 0, outbound: 0 };
        skuCur.qty += r.ending_qty || 0;
        skuCur.outbound += outboundQtyOf(r);
        skuTrendMap.set(mo, skuCur);
      }
    }
    const trend = months.map(mo => ({ month: mo, value: trendMap.get(mo)?.value || 0, qty: trendMap.get(mo)?.qty || 0 }));
    const skuTrend = months.map(mo => ({ month: mo, qty: skuTrendMap.get(mo)?.qty || 0, outbound: skuTrendMap.get(mo)?.outbound || 0 }));

    root.innerHTML = `
      <div class="view-head">
        <h2>库存管理<span class="ko">재고 관리</span></h2>
        <div class="spacer"></div>
        <select class="ctl" id="invMonth">${months.slice().reverse().map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="filter-grid">
          <label>仓库<select class="ctl" id="invWh"><option value="all">全部仓库</option>${whs.map(x => `<option value="${esc(x)}" ${x === wh ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <label>品牌/前缀<select class="ctl" id="invPrefix"><option value="all">全部前缀</option>${prefixes.map(x => `<option value="${esc(x)}" ${x === pf ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <label>SKU / 商品<input class="searchbox" id="invSearch" value="${esc(q)}" placeholder="搜索 품번/商品名"></label>
          <label>SKU趋势<select class="ctl" id="invSkuTrend">${skuOptions.map(x => `<option value="${esc(x)}" ${x === focusSku ? 'selected' : ''}>${esc(skuLabel(x))}</option>`).join('')}</select></label>
        </div>
      </div>
      <div class="grid kpis">
        ${kpiCard('期末库存金额', '월말 재고금액', money(totalValue, 'KRW', m), '', missing.length ? `${missing.length} SKU 在 재고금액 中金额缺失,未计入` : '直接采用 재고금액 标准账')}
        ${kpiCard('期末库存数量', '월말 수량', fK(totalQty), '', `${curRows.length} SKU · ${wh === 'all' ? '全部仓库' : esc(wh)}`)}
        ${kpiCard('本月入库/出库', '입출고', `${fK(totalInbound)} / ${fK(totalOutbound)}`, '', `按 수불부 收发账 · 出库金额 ${money(totalOutboundValue, 'KRW', m)}`)}
        ${kpiCard('断货风险', '품절위험', stockout.length + ' SKU', '', '月末库存 / 近3月均出 < 0.5个月')}
        ${kpiCard('高库存风险', '과다재고', high.length + ' SKU', '', '周转天数 > 180 / 365')}
        ${kpiCard('滞销库存', '저회전', slow.length + ' SKU', '', '近N月低出库但仍有库存')}
      </div>
      <div class="grid two-col" style="margin-bottom:14px">
        <div class="card"><h3>月末库存金额趋势 <span class="ko">월말 재고금액</span></h3><div class="chart" id="chInvValueTrend"></div></div>
        <div class="card"><h3>SKU库存数量趋势 <span class="ko">${esc(skuLabel(focusSku))}</span></h3><div class="chart" id="chInvSkuTrend"></div></div>
      </div>
      <div class="grid two-col" style="margin-bottom:14px">
        <div class="card"><h3>入库 / 出库 / 月末库存桥图 <span class="ko">입출고 브릿지</span></h3><div class="chart" id="chInvBridge"></div></div>
        <div class="card"><h3>风险结构 <span class="ko">위험 구성</span></h3><div class="chart" id="chInvRisk"></div></div>
      </div>
      <div class="card" style="margin-bottom:14px"><h3>账簿闭合 QA · 수불부 vs 재고금액 <span class="ko">재고 대조</span><span class="spacer"></span>
        <span class="note">${m} · 匹配 ${qaMatched} · 差异 ${qaMismatch.length}</span></h3>
        <p class="note" style="margin-top:0">只用 수불부&재고금액 内部数据校验: 期初 + 入库 + 대체입고 - 出库 - 대체출고 应等于 재고금액 的期末数量。</p>
        ${qaMismatch.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>仓库</th><th>품번</th><th class="name-cell">商品名</th><th>账簿推导期末</th><th>재고금액期末</th><th>差异</th><th>提示</th></tr></thead><tbody>
          ${qaMismatch.slice(0, 30).map(x => `<tr><td>${esc(x.warehouse)}</td><td>${esc(x.sku)}</td><td class="name-cell">${esc(x.name || '—')}</td><td>${fK(x.expectedEnding)}</td><td>${fK(x.ending)}</td><td class="${x.diff >= 0 ? '' : 'neg'}">${x.diff > 0 ? '+' : ''}${fK(x.diff)}</td><td>请核对同一 품번 在 수불부 与 재고금액 是否月份/仓库一致</td></tr>`).join('')}
        </tbody></table></div>${qaMismatch.length > 30 ? `<p class="note">仅显示差异最大的 30 项,共 ${qaMismatch.length} 项。</p>` : ''}`
        : '<p class="note" style="color:var(--good)">✓ 수불부 与 재고금액 期末数量闭合。</p>'}
      </div>
      <div class="card"><h3>SKU 明细 <span class="ko">상세</span><span class="spacer"></span><span class="note">${m} · 默认显示前50行</span></h3>
        <div class="btn-row" style="margin-top:0;margin-bottom:10px">
          <button class="chip ${S.invRiskFilter === 'all' || !S.invRiskFilter ? 'on' : ''}" data-invrisk="all">全部</button>
          <button class="chip ${S.invRiskFilter === 'stockout' ? 'on' : ''}" data-invrisk="stockout">断货</button>
          <button class="chip ${S.invRiskFilter === 'high' ? 'on' : ''}" data-invrisk="high">高库存</button>
          <button class="chip ${S.invRiskFilter === 'slow' ? 'on' : ''}" data-invrisk="slow">滞销</button>
          <button class="chip ${S.invRiskFilter === 'missingCost' ? 'on' : ''}" data-invrisk="missingCost">缺成本</button>
          <button class="chip ${S.invLimit === 'all' ? 'on' : ''}" data-invlimit="all">显示全部</button>
        </div>
        <div class="tbl-wrap" id="invTbl"></div></div>`;

    $('#invMonth').onchange = e => { S.invMonth = e.target.value; render(); };
    $('#invWh').onchange = e => { S.invWh = e.target.value; render(); };
    $('#invPrefix').onchange = e => { S.invPrefix = e.target.value; render(); };
    $('#invSearch').onchange = e => { S.invSearch = e.target.value.trim(); render(); };
    $('#invSkuTrend').onchange = e => { S.invSkuTrend = e.target.value; render(); };
    root.onclick = e => {
      const rf = e.target.dataset?.invrisk;
      const lim = e.target.dataset?.invlimit;
      if (rf) { S.invRiskFilter = rf; render(); }
      if (lim) { S.invLimit = lim; render(); }
    };

    let list = curRows.slice();
    const riskFilter = S.invRiskFilter || 'all';
    if (riskFilter === 'stockout') list = list.filter(x => x.risk.level === 'stockout');
    if (riskFilter === 'high') list = list.filter(x => x.risk.level === 'urgent' || x.risk.level === 'focus');
    if (riskFilter === 'slow') list = list.filter(x => x.risk.level === 'slow');
    if (riskFilter === 'missingCost') list = list.filter(x => x.cost_missing);
    list = list.sort((a, b) => (b.ending_value_krw || -1) - (a.ending_value_krw || -1));
    const totalListN = list.length;
    if (S.invLimit !== 'all') list = list.slice(0, 50);
    let html = `<table class="tbl"><thead><tr><th>仓库</th><th>품번</th><th class="name-cell">商品名</th><th>规格/条码</th><th>单位</th><th>期初</th><th>入库</th><th>出库</th><th>期末</th><th>单价</th><th>库存金额</th><th>可售月数</th><th>周转天数</th><th>风险</th></tr></thead><tbody>`;
    for (const x of list) {
      const risk = x.risk;
      const inferred = !!monthEndMovement(x);
      html += `<tr><td>${esc(x.warehouse || '—')}</td><td>${esc(x.sku_code)}</td><td class="name-cell">${esc(x.product_name || '—')}</td><td>${esc(x.barcode_or_spec || '—')}</td><td>${esc(x.unit || '—')}</td>
        <td>${fK(openingOf(x))}</td><td>${fK(inboundOf(x))}${inferred ? ' <span class="badge neutral">推导</span>' : ''}</td>
        <td>${fK(outboundOf(x))}${inferred ? ' <span class="badge neutral">推导</span>' : ''}</td>
        <td>${fK(x.ending_qty)}</td>
        <td>${x.cost_missing ? '<span class="neg">账簿金额缺失</span>' : money(x.unit_cost_krw, 'KRW', m)}</td>
        <td>${x.cost_missing ? '<span class="neg">未计入</span>' : money(x.ending_value_krw, 'KRW', m)}</td>
        <td>${risk.lowSales || risk.monthsCover === null ? '<span class="note" title="近3月月均出库 < ' + turnoverMinSales() + ' 件,周转不可估">销量过低</span>' : (risk.monthsCover >= 9999 ? '∞' : fU2(risk.monthsCover))}</td>
        <td>${risk.lowSales || risk.turnoverDays === null ? '<span class="note">不可估</span>' : (risk.turnoverDays >= 9999 ? '∞' : fK(risk.turnoverDays))}</td>
        <td><span class="badge g-${risk.level}">${risk.label}</span></td></tr>`;
    }
    $('#invTbl').innerHTML = html + '</tbody></table>' +
      (totalListN > list.length ? `<p class="note">已显示 ${list.length} / ${totalListN} 行。点击“显示全部”查看完整明细。</p>` : '');

    const invSym = S.cur === 'ORIG' ? '₩' : FX.SYM[S.cur];
    const valForChart = v => { const x = moneyVal(v, 'KRW', m); return x === null ? null : Math.round(x); };
    mkChart($('#chInvValueTrend'), {
      tooltip: { trigger: 'axis', valueFormatter: v => invSym + ' ' + fK(v) },
      grid: GRID,
      xAxis: { type: 'category', data: trend.map(x => x.month), ...baseAxis },
      yAxis: { type: 'value', name: invSym, ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } } },
      series: [{ name: '期末库存金额', type: 'line', smooth: true, areaStyle: { opacity: 0.12 }, itemStyle: { color: '#2563EB' }, data: trend.map(x => valForChart(x.value)) }],
    });
    mkChart($('#chInvSkuTrend'), {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { color: '#475569' } },
      grid: GRID,
      xAxis: { type: 'category', data: skuTrend.map(x => x.month), ...baseAxis },
      yAxis: { type: 'value', name: 'EA', ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } } },
      series: [
        { name: '期末库存', type: 'line', smooth: true, itemStyle: { color: '#10B981' }, data: skuTrend.map(x => x.qty) },
        { name: '出库', type: 'bar', barWidth: 24, itemStyle: { color: '#94A3B8', borderRadius: [4, 4, 0, 0] }, data: skuTrend.map(x => x.outbound) },
      ],
    });
    mkChart($('#chInvBridge'), {
      tooltip: { trigger: 'axis' },
      grid: GRID,
      xAxis: { type: 'category', data: ['期初', '入库', '出库', '期末'], ...baseAxis },
      yAxis: { type: 'value', name: 'EA', ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } } },
      series: [{ name: '数量', type: 'bar', barWidth: 34, itemStyle: { color: p => ['#64748B', '#2563EB', '#EF4444', '#10B981'][p.dataIndex], borderRadius: [4, 4, 0, 0] }, data: [
        curRows.reduce((a, b) => a + openingOf(b), 0), totalInbound, -totalOutbound, totalQty,
      ] }],
    });
    // 风险结构: 占比>70%自动退化为横向条形图 (item2)
    const riskOpt = pieOrBar([
      { name: '断货', value: stockout.length, color: '#1E293B' },
      { name: '高库存', value: high.length, color: '#F97316' },
      { name: '滞销', value: slow.length, color: '#8B5CF6' },
      { name: '健康', value: Math.max(curRows.length - high.length - slow.length - stockout.length, 0), color: '#16A34A' },
    ], 'SKU');
    mkChart($('#chInvRisk'), riskOpt);
    if (riskOpt._degenerate) $('#chInvRisk').insertAdjacentHTML('afterend',
      `<p class="note">「${riskOpt._topName}」占 ${(riskOpt._topShare * 100).toFixed(0)}% — 单一分类主导,已自动改用条形图呈现。</p>`);
  }

  // ========== 视图: 快手店快照 ==========
  function vKuaishou(root) {
    const recs = Object.values(S.kuaishou).sort((a, b) => (a.month || '').localeCompare(b.month || ''));
    if (!recs.length) {
      root.innerHTML = `<div class="card"><h3>快手-HOKABOMB <span class="ko">콰이쇼우 호카밤</span></h3><p class="note">尚未上传快手店清算表。该店结算周期不规律(非自然月),上传后此处显示历次清算明细与最新P&L。</p></div>`;
      return;
    }
    const latest = recs[recs.length - 1];
    const hist = latest.history || [];
    const se = latest.settle;
    const kwRate = hist.length ? hist[hist.length - 1].rate : undefined; // 最近一次清算汇率作为快照换算上下文
    const kwMonth = latest.month;
    root.innerHTML = `
      <div class="view-head"><h2>快手-HOKABOMB 快照<span class="ko">콰이쇼우 스냅샷</span></h2>
      <div class="spacer"></div><span class="badge neutral">最新清算: ${latest.month || '—'}</span></div>
      <div class="card" style="margin-bottom:14px;border-left:4px solid var(--accent)">
        <p style="font-size:13px;color:var(--muted)">⚠ 该店为快手分销模式,结算周期不规律(覆盖多个销售月),不并入 TTL 月度对比。达人佣金为最大费用项。</p>
      </div>
      ${se ? `<div class="grid kpis">
        ${kpiCard('卖出额', '매출액', money(se.sales_krw, 'KRW', kwMonth, kwRate), '', `清算数量 ${fK(se.qty)} 件`)}
        ${kpiCard('出库原价', '출고원가', money(se.cogs_krw, 'KRW', kwMonth, kwRate), '', `原价率 ${fP(se.cost_rate)}`)}
        ${kpiCard('支出合计', '지출합계', money(se.expense_krw, 'KRW', kwMonth, kwRate), '', '')}
        ${kpiCard('营业利润', '영업이익', money(se.profit_krw, 'KRW', kwMonth, kwRate), '', `利润率 ${fP(se.margin)}`)}
      </div>` : ''}
      <div class="grid two-col">
        <div class="card"><h3>历次清算金额 <span class="ko">정산 이력</span></h3><div class="chart" id="chKw"></div></div>
        <div class="card"><h3>清算明细 <span class="ko">상세</span></h3><div class="tbl-wrap">
          <table class="tbl"><thead><tr><th>清算月</th><th>卖出 ${colCur('CNY')}</th><th>卖出 ${colCur('USD')}</th><th>费用 ${colCur('USD')}</th><th>入金 ${colCur('USD')}</th><th>汇率</th><th>卖出 ${colCur('KRW')}</th><th>入金 ${colCur('KRW')}</th><th>收款日</th></tr></thead><tbody>
          ${hist.map(h => `<tr><td>${h.month}</td><td>${money(h.cny, 'CNY', h.month, h.rate)}</td><td>${money(h.usd, 'USD', h.month, h.rate)}</td><td>${money(h.fee_usd, 'USD', h.month, h.rate)}</td><td>${money(h.final_usd, 'USD', h.month, h.rate)}</td><td>${h.rate ? h.rate.toFixed(1) : '—'}</td><td>${money(h.krw, 'KRW', h.month, h.rate)}</td><td>${money(h.final_krw, 'KRW', h.month, h.rate)}</td><td>${esc(h.date)}</td></tr>`).join('')}
          <tr class="ttl"><td>TTL</td>
          <td>${S.cur === 'ORIG' ? '¥ ' + fU(hist.reduce((a, b) => a + b.cny, 0)) : sumMoney(hist.map(h => ({ value: h.cny, src: 'CNY', month: h.month, storeRate: h.rate })))}</td>
          <td>${S.cur === 'ORIG' ? '$ ' + fU2(hist.reduce((a, b) => a + b.usd, 0)) : sumMoney(hist.map(h => ({ value: h.usd, src: 'USD', month: h.month, storeRate: h.rate })))}</td>
          <td>${S.cur === 'ORIG' ? '$ ' + fU2(hist.reduce((a, b) => a + b.fee_usd, 0)) : sumMoney(hist.map(h => ({ value: h.fee_usd, src: 'USD', month: h.month, storeRate: h.rate })))}</td>
          <td>${S.cur === 'ORIG' ? '$ ' + fU2(hist.reduce((a, b) => a + b.final_usd, 0)) : sumMoney(hist.map(h => ({ value: h.final_usd, src: 'USD', month: h.month, storeRate: h.rate })))}</td>
          <td>—</td>
          <td>${S.cur === 'ORIG' ? '₩ ' + fK(hist.reduce((a, b) => a + b.krw, 0)) : sumMoney(hist.map(h => ({ value: h.krw, src: 'KRW', month: h.month, storeRate: h.rate })))}</td>
          <td>${S.cur === 'ORIG' ? '₩ ' + fK(hist.reduce((a, b) => a + b.final_krw, 0)) : sumMoney(hist.map(h => ({ value: h.final_krw, src: 'KRW', month: h.month, storeRate: h.rate })))}</td>
          <td>—</td></tr>
          </tbody></table></div></div>
      </div>`;
    const kwSym = S.cur === 'ORIG' ? '₩' : FX.SYM[S.cur];
    const kwVal = (h, field) => { const v = moneyVal(h[field], 'KRW', h.month, h.rate); return v === null ? null : Math.round(v); };
    mkChart($('#chKw'), {
      tooltip: { trigger: 'axis', valueFormatter: v => v == null ? '缺汇率' : kwSym + ' ' + fK(v) },
      legend: { top: 0, textStyle: { color: '#475569' } },
      grid: GRID,
      xAxis: { type: 'category', data: hist.map(h => h.month), ...baseAxis },
      yAxis: { type: 'value', name: kwSym, ...baseAxis, splitLine: { lineStyle: { color: '#EEF2F7' } }, axisLabel: { color: '#475569', formatter: v => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v } },
      series: [
        { name: '卖出', type: 'bar', barWidth: 24, itemStyle: { color: '#8B5CF6', borderRadius: [4, 4, 0, 0] }, data: hist.map(h => kwVal(h, 'krw')) },
        { name: '最终入金', type: 'bar', barWidth: 24, itemStyle: { color: '#C4B5FD', borderRadius: [4, 4, 0, 0] }, data: hist.map(h => kwVal(h, 'final_krw')) },
      ],
    });
  }

  // ========== 视图: 产品登记(产品主数据) ==========
  function vProducts(root) {
    const all = Object.values(S.productMaster || {}).map(normProduct).sort((a, b) => a.sku_code.localeCompare(b.sku_code));
    const sources = collectSkuSources();
    const allSkus = new Set([...all.map(p => p.sku_code), ...Object.keys(sources)]);
    const registered = new Set(all.map(p => p.sku_code));
    const missingReg = Array.from(allSkus).filter(s => !registered.has(s)); // 销售/库存出现但未登记
    const missingCn = all.filter(p => !p.name_cn).length;
    const missingBrand = all.filter(p => !p.brand).length;
    const brands = Array.from(new Set(all.map(p => p.brand).filter(Boolean))).sort();

    const q = S.prodSearch || '';
    const bf = S.prodBrand || 'all';
    const sf = S.prodStatus || 'all';
    let list = all.filter(p => {
      if (q && !(p.sku_code + p.name_kr + p.name_cn + p.barcode + p.brand).toLowerCase().includes(q.toLowerCase())) return false;
      if (bf !== 'all' && p.brand !== bf) return false;
      if (sf !== 'all' && p.status !== sf) return false;
      return true;
    });

    const ed = S.prodEditing; // null | 'new' | sku
    const editRec = ed && ed !== 'new' ? (all.find(p => p.sku_code === ed) || normProduct({ sku_code: ed })) : (ed === 'new' ? normProduct({ sku_code: '' }) : null);
    const formField = (k, label, val, attrs = '') => `<div><label>${label}</label><input id="pf_${k}" value="${esc(val ?? '')}" ${attrs}></div>`;

    root.innerHTML = `
      <div class="view-head"><h2>产品登记<span class="ko">제품 등록</span></h2>
        <div class="spacer"></div>
        <button class="btn btn-primary btn-sm" id="prodNew">+ 新增产品</button>
        <button class="btn btn-sm" id="prodAuto" title="从销售/库存数据按 품번 自动补全未登记产品及缺失的中文名/品牌/条码">⚡ 自动补全</button>
        <button class="btn btn-sm" id="prodExport">导出CSV</button>
      </div>
      <div class="grid kpis">
        ${kpiCard('已登记产品', '등록 제품', all.length + ' 个', '', '以 품번 为唯一键')}
        ${missingReg.length ? kpiCard('未登记 품번', '미등록', missingReg.length + ' 个', '', '销售/库存出现但无登记', { muted: true, reason: '数据缺失' }) : kpiCard('未登记 품번', '미등록', '0', '', '覆盖完整')}
        ${kpiCard('缺中文名', '중문명 누락', missingCn + ' 个', '', missingCn ? '可自动补全或手填' : '已齐全')}
        ${kpiCard('缺品牌', '브랜드 누락', missingBrand + ' 个', '', missingBrand ? '可自动补全或手填' : '已齐全')}
      </div>
      ${ed ? `<div class="card prod-form" style="margin-bottom:14px">
        <h3>${ed === 'new' ? '新增产品' : '编辑产品 · ' + esc(ed)} <span class="ko">제품 정보</span></h3>
        <div class="fx-form">
          ${formField('sku_code', '품번 *(唯一键)', editRec.sku_code, ed === 'new' ? '' : 'readonly')}
          ${formField('name_kr', '韩文名 한국어', editRec.name_kr)}
          ${formField('name_cn', '中文名', editRec.name_cn)}
          ${formField('barcode', '条形码 바코드', editRec.barcode)}
          ${formField('brand', '品牌', editRec.brand)}
          ${formField('spec', '规格', editRec.spec)}
          ${formField('stock_unit', '库存单位', editRec.stock_unit)}
          ${formField('management_unit', '管理单位', editRec.management_unit)}
          ${formField('conversion_factor', '换算系数', editRec.conversion_factor, 'type="number" step="any"')}
          ${formField('standard_cost_krw', '标准成本 KRW', editRec.standard_cost_krw, 'type="number" step="any"')}
          ${formField('purchase_price_krw', '采购单价 KRW', editRec.purchase_price_krw, 'type="number" step="any"')}
          ${formField('category', '分类/效能', editRec.category)}
          <div><label>状态</label><select id="pf_status" class="ctl" style="width:100%"><option value="active" ${editRec.status === 'active' ? 'selected' : ''}>在售</option><option value="discontinued" ${editRec.status === 'discontinued' ? 'selected' : ''}>停售</option></select></div>
          ${formField('memo', '备注', editRec.memo)}
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-primary" id="prodSave">保存</button>
          <button class="btn" id="prodCancel">取消</button>
          ${ed !== 'new' ? `<button class="btn btn-danger" id="prodDelete">删除该产品</button>` : ''}
        </div>
      </div>` : ''}
      <div class="card">
        <h3>产品清单 <span class="ko">제품 목록</span><span class="spacer"></span>
          <input class="searchbox" id="prodSearch" value="${esc(q)}" placeholder="搜索 품번/名称/条码/品牌">
          <select class="ctl" id="prodBrandF" style="margin-left:6px"><option value="all">全部品牌</option>${brands.map(b => `<option value="${esc(b)}" ${b === bf ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <select class="ctl" id="prodStatusF" style="margin-left:6px"><option value="all" ${sf === 'all' ? 'selected' : ''}>全部状态</option><option value="active" ${sf === 'active' ? 'selected' : ''}>在售</option><option value="discontinued" ${sf === 'discontinued' ? 'selected' : ''}>停售</option></select>
        </h3>
        <div class="tbl-wrap">
          <table class="tbl"><thead><tr><th>품번</th><th class="name-cell">韩文名</th><th class="name-cell">中文名</th><th>条形码</th><th>品牌</th><th>库存单位</th><th>标准成本</th><th>采购单价</th><th>状态</th><th>来源</th><th>操作</th></tr></thead><tbody>
          ${list.map(p => `<tr>
            <td>${esc(p.sku_code)}</td>
            <td class="name-cell">${esc(p.name_kr) || '<span class="note">—</span>'}</td>
            <td class="name-cell">${esc(p.name_cn) || '<span class="note">缺</span>'}</td>
            <td>${esc(p.barcode) || '—'}</td>
            <td>${esc(p.brand) || '<span class="note">缺</span>'}</td>
            <td>${esc(p.stock_unit) || '—'}</td>
            <td>${p.standard_cost_krw ? fK(p.standard_cost_krw) : '—'}</td>
            <td>${p.purchase_price_krw ? fK(p.purchase_price_krw) : '—'}</td>
            <td>${p.status === 'discontinued' ? '<span class="badge neutral">停售</span>' : '<span class="badge g-health">在售</span>'}</td>
            <td><span class="note">${esc(p.source)}</span></td>
            <td><button class="btn btn-sm" data-pedit="${esc(p.sku_code)}">编辑</button></td></tr>`).join('') || '<tr><td colspan="11" class="note" style="text-align:center">暂无登记产品,点击「自动补全」或「新增产品」</td></tr>'}
          </tbody></table>
        </div>
        <p class="note">显示 ${list.length} / ${all.length} 个产品。全站(库存/SKU/趋势)的商品名与品牌均以本表为准,中文名优先显示。</p>
        ${missingReg.length ? `<p class="note" style="color:#B45309">⚠ 有 ${missingReg.length} 个 품번 在销售/库存中出现但未登记: ${missingReg.slice(0, 12).map(esc).join(', ')}${missingReg.length > 12 ? ` 等` : ''} — 点「自动补全」一键登记。</p>` : ''}
      </div>`;

    // 事件
    $('#prodSearch').onchange = e => { S.prodSearch = e.target.value.trim(); render(); };
    $('#prodSearch').oninput = e => { S.prodSearch = e.target.value.trim(); /* 即时过滤无需整页重渲,延迟到change */ };
    $('#prodBrandF').onchange = e => { S.prodBrand = e.target.value; render(); };
    $('#prodStatusF').onchange = e => { S.prodStatus = e.target.value; render(); };
    $('#prodNew').onclick = () => { S.prodEditing = 'new'; render(); };
    $('#prodExport').onclick = () => exportProductsCSV(all);
    $('#prodAuto').onclick = () => autoFillProducts();
    root.querySelectorAll('[data-pedit]').forEach(b => b.onclick = () => { S.prodEditing = b.dataset.pedit; render(); });
    if (ed) {
      $('#prodCancel').onclick = () => { S.prodEditing = null; render(); };
      $('#prodSave').onclick = () => saveProductForm(ed);
      const del = $('#prodDelete'); if (del) del.onclick = () => deleteProduct(ed);
    }
  }

  async function saveProductForm(ed) {
    const g = k => { const el = $('#pf_' + k); return el ? el.value.trim() : ''; };
    const sku = skuKey(g('sku_code'));
    if (!sku) { toast('품번 必填'); return; }
    if (ed === 'new' && S.productMaster[sku]) { toast('该 품번 已存在,请用编辑'); return; }
    const rec = {
      sku_code: sku, name_kr: g('name_kr'), name_cn: g('name_cn'), barcode: g('barcode'),
      brand: g('brand'), spec: g('spec'), stock_unit: g('stock_unit'), management_unit: g('management_unit'),
      conversion_factor: Number(g('conversion_factor')) || 1,
      standard_cost_krw: Number(g('standard_cost_krw')) || 0, purchase_price_krw: Number(g('purchase_price_krw')) || 0,
      category: g('category'), status: $('#pf_status') ? $('#pf_status').value : 'active', memo: g('memo'),
      source: ed === 'new' ? 'manual' : (productInfo(sku)?.source || 'manual'), updated_at: new Date().toISOString(),
    };
    S.productMaster[sku] = rec;
    await DB.put('productMaster', sku, rec);
    await refreshInventoryCosts(); invalidateInvCache();
    S.prodEditing = null;
    toast(`已保存 ${sku}`); render();
  }
  async function deleteProduct(sku) {
    if (!confirm(`删除产品 ${sku}? (不影响已上传的销售/库存数据)`)) return;
    await DB.del('productMaster', skuKey(sku)); delete S.productMaster[skuKey(sku)];
    invalidateInvCache(); S.prodEditing = null; toast('已删除'); render();
  }
  async function autoFillProducts() {
    const sources = collectSkuSources();
    let added = 0, filled = 0;
    for (const [sku, src] of Object.entries(sources)) {
      const existing = S.productMaster[sku] ? normProduct(S.productMaster[sku]) : null;
      if (!existing) {
        S.productMaster[sku] = {
          sku_code: sku, name_kr: src.name_kr || '', name_cn: src.name_cn || '', barcode: src.barcode || '',
          brand: src.brand || brandNameForSku(sku), spec: '', stock_unit: src.stock_unit || '', management_unit: '',
          conversion_factor: 1, standard_cost_krw: src.standard_cost_krw || 0, purchase_price_krw: src.purchase_price_krw || 0,
          category: '', status: 'active', memo: '', source: 'auto', updated_at: new Date().toISOString(),
        };
        await DB.put('productMaster', sku, S.productMaster[sku]); added++;
      } else {
        // 仅补空字段, 不覆盖已有人工值; 品牌缺失时回退 품번前缀映射
        let changed = false;
        const merged = { ...existing };
        for (const [k, v] of [['name_kr', src.name_kr], ['name_cn', src.name_cn], ['barcode', src.barcode], ['brand', src.brand || brandNameForSku(sku)], ['stock_unit', src.stock_unit]]) {
          if (!merged[k] && v) { merged[k] = v; changed = true; }
        }
        if (changed) { merged.updated_at = new Date().toISOString(); S.productMaster[sku] = merged; await DB.put('productMaster', sku, merged); filled++; }
      }
    }
    await refreshInventoryCosts(); invalidateInvCache();
    toast(`自动补全: 新增 ${added} 个, 补全 ${filled} 个`);
    render();
  }
  function exportProductsCSV(list) {
    const cols = ['sku_code', 'name_kr', 'name_cn', 'barcode', 'brand', 'spec', 'stock_unit', 'management_unit', 'conversion_factor', 'standard_cost_krw', 'purchase_price_krw', 'category', 'status', 'memo', 'source'];
    const head = ['품번', '韩文名', '中文名', '条形码', '品牌', '规格', '库存单位', '管理单位', '换算系数', '标准成本KRW', '采购单价KRW', '分类', '状态', '备注', '来源'];
    const esc2 = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = list.map(p => cols.map(c => esc2(p[c])).join(','));
    const csv = '﻿' + head.join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `产品登记_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    toast('已导出产品登记 CSV');
  }

  // ========== 视图: 数据中心 ==========
  function vData(root) {
    const months = allMonths();
    const inventoryMonths = invMonths();
    const standardMonths = Array.from(new Set([
      ...costAnalysisMonths(),
      ...rawInvRows().filter(r => r.source_type === 'stockLedger').map(r => r.month),
      ...movementRows().filter(r => r.source_type === 'stockLedger').map(r => r.month),
    ].filter(Boolean))).sort();
    const sts = ['deepte', 'ssf', 'cdbrown', 'jingya', 'kuaishou'];
    let matrix = '';
    if (months.length || Object.keys(S.kuaishou).length || inventoryMonths.length || standardMonths.length) {
      const kwMonths = Object.keys(S.kuaishou).sort();
      const allM = Array.from(new Set([...months, ...kwMonths, ...inventoryMonths, ...standardMonths])).sort().reverse();
      matrix = `<table class="tbl month-grid"><thead><tr><th>店铺 \\ 月份</th>${allM.map(m => `<th>${mLabel(m)}</th>`).join('')}<th>操作</th></tr></thead><tbody>`;
      for (const st of sts) {
        const has = st === 'kuaishou' ? kwMonths.length : monthsOf(st).length;
        if (!has) continue;
        matrix += `<tr><td style="text-align:left">${META[st].name}</td>`;
        for (const m of allM) {
          if (st === 'kuaishou') matrix += `<td>${S.kuaishou[m] ? `<button class="dot full" data-delmonth="${st}|${m}" title="删除 ${META[st].name} ${m}">快照 ×</button>` : ''}</td>`;
          else {
            const hasS = !!rowOf(st, m), hasD = !!S.detail[st + '|' + m];
            matrix += `<td>${hasD ? `<button class="dot full" data-delmonth="${st}|${m}" title="删除 ${META[st].name} ${m}">汇总+明细 ×</button>` : hasS ? `<button class="dot" data-delmonth="${st}|${m}" title="删除 ${META[st].name} ${m}">汇总 ×</button>` : ''}</td>`;
          }
        }
        matrix += `<td><button class="btn btn-sm btn-danger" data-delstore="${st}">删除该店</button></td></tr>`;
      }
      if (inventoryMonths.length) {
        matrix += `<tr><td style="text-align:left">库存标准账<br><span class="ko">수불부&재고금액</span></td>`;
        for (const m of allM) matrix += `<td>${inventoryMonths.includes(m) ? `<button class="dot full" data-delinvmonth="${m}" title="删除库存标准账 ${m}">库存账 ×</button>` : ''}</td>`;
        matrix += `<td><button class="btn btn-sm btn-danger" data-clearinv="1">删除库存账</button></td></tr>`;
      }
      const caMonths = costAnalysisMonths().sort();
      if (caMonths.length) {
        matrix += `<tr><td style="text-align:left">成本分析(全渠道源)</td>`;
        for (const m of allM) matrix += `<td>${caMonths.includes(m) ? `<button class="dot full" data-delca="${m}" title="删除成本分析 ${m} (删后总览回退清算表)">成本表 ×</button>` : ''}</td>`;
        matrix += `<td><button class="btn btn-sm btn-danger" data-clearca="1">删除全部成本表</button></td></tr>`;
      }
      if (standardMonths.length) {
        matrix += `<tr><td style="text-align:left">内部标准核对</td>`;
        for (const m of allM) matrix += `<td>${standardMonths.includes(m) || rowOf('cdbrown', m) ? stdVerifyBadge(m, { short: true }) : ''}</td>`;
        matrix += '<td></td></tr>';
      }
      matrix += '</tbody></table><p class="note">「汇总」= 来自其他月份文件 summary 中的历史行;「汇总+明细」= 该月清算表原件已上传,含SKU与库存明细。点 ×可删除对应上传;成本分析重传会自动按月覆盖。</p>';
    }

    root.innerHTML = `
      <div class="view-head"><h2>数据中心<span class="ko">데이터 관리</span></h2></div>
      <div class="card" style="margin-bottom:14px">
        <div class="dropzone" id="drop">
          <p style="font-size:15px;margin-bottom:6px"><b>拖入或点击上传 Excel 原件</b></p>
          <p>支持清算表、<b>매출대비 원가분석(成本分析·月度全渠道权威源)</b>、产品信息表(SYC1110)、<b>수불부&재고금액(库存管理唯一标准源)</b></p>
          <p class="ko">재고 관리는 수불부&재고금액 파일만 표준으로 사용합니다.</p>
          <input type="file" id="fileInput" accept=".xlsx,.xls" multiple class="hidden">
        </div>
        <div class="upload-log" id="upLog"></div>
      </div>
      ${matrix ? `<div class="card" style="margin-bottom:14px"><h3>数据覆盖情况 <span class="ko">데이터 현황</span></h3><div class="tbl-wrap">${matrix}</div></div>` : ''}
      <div class="card" style="margin-bottom:14px">
        <h3>汇率管理 <span class="ko">환율 관리</span><span class="spacer"></span><button class="btn btn-sm" id="btnFxTest">运行换算自检</button></h3>
        <p class="note" style="margin-top:0">官方来源固定为 SMBS: http://www.smbs.biz/ExRate/TodayExRate.jsp。系统按每月最后一个工作日取数;若月末为周六/周日, 自动回退到当月最后一个周五。SMBS 2016 年后人民币公布字段为 CNH, 系统用于 CNY 展示换算。店铺自身 USD↔KRW 仍优先采用清算表内汇率, 两者偏差&gt;0.5%会标黄提示。</p>
        <div class="fx-form">
          <div><label>月份 *</label><input type="month" id="fxMonth"></div>
          <div><label>USD→KRW *</label><input type="number" step="0.01" min="0" id="fxUsdKrw" placeholder="如 1505.80"></div>
          <div><label>CNY→KRW *</label><input type="number" step="0.01" min="0" id="fxCnyKrw" placeholder="如 207.50"></div>
          <div><label>USD→CNY (可选,不填则推导)</label><input type="number" step="0.0001" min="0" id="fxUsdCny" placeholder="自动 = USD→KRW ÷ CNY→KRW"></div>
          <div><label>来源网址</label><input type="text" id="fxUrl" placeholder="https://..."></div>
          <div><label>来源备注</label><input type="text" id="fxNote" placeholder="如 서울외국환중개 고시"></div>
          <div><label>确认人</label><input type="text" id="fxBy" placeholder="姓名"></div>
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-primary" id="btnFxSave">保存汇率</button>
          <button class="btn" id="btnFxAuto" title="按该月最后工作日从 SMBS 自动获取 USD→KRW 与 CNY→KRW">从 SMBS 自动获取本月</button>
          <button class="btn" id="btnFxFill" title="将该月各店清算表USD→KRW汇率均值带入表单">从清算表带入 USD→KRW</button>
          <button class="btn" id="btnFxAutoMissing" title="为所有已有清算月份补齐缺失的 SMBS 官方汇率; 不覆盖已录入记录">SMBS 补齐缺失月份</button>
          <button class="btn" id="btnFxBackfill" title="为所有有清算数据但缺官方价的月份, 一键把官方USD→KRW填为清算成交汇率(可再手工微调); 仅补缺, 不覆盖已录入的">⚡ 一键回填所有月官方价(=清算成交汇率)</button>
        </div>
        <div class="tbl-wrap" style="margin-top:14px" id="fxTable">${fxTableHtml()}</div>
        <div class="selftest-result" id="fxTestOut"></div>
      </div>
      <div class="grid two-col">
        <div class="card"><h3>备份与恢复 <span class="ko">백업/복원</span></h3>
          <p class="note" style="margin-top:0">数据仅保存在当前浏览器(IndexedDB)。换电脑/浏览器或给同事共享数据时,请导出备份文件并在对方设备导入。</p>
          <div class="btn-row">
            <button class="btn btn-primary" id="btnExport">导出备份 JSON</button>
            <button class="btn" id="btnImport">导入备份</button>
            <button class="btn btn-danger" id="btnClear">清空全部数据</button>
            <input type="file" id="importInput" accept=".json" class="hidden">
          </div></div>
        <div class="card"><h3>访问密码 <span class="ko">비밀번호 변경</span></h3>
          <p class="note" style="margin-top:0">修改本浏览器的访问密码(仅对本设备生效;静态站点的密码门为基础防护,请勿外传网址)。</p>
          <div class="btn-row">
            <input type="password" class="inline" id="newPass" placeholder="新密码 (至少4位)">
            <button class="btn" id="btnPass">保存新密码</button>
          </div></div>
      </div>`;

    const drop = $('#drop'), fi = $('#fileInput');
    drop.onclick = () => fi.click();
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondragleave = () => drop.classList.remove('drag');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('drag'); handleFiles(e.dataTransfer.files); };
    fi.onchange = () => { handleFiles(fi.files); fi.value = ''; };

    root.onclick = async e => {
      const ds = e.target.dataset?.delstore;
      const dm = e.target.dataset?.delmonth;
      const dim = e.target.dataset?.delinvmonth;
      const clearInv = e.target.dataset?.clearinv;
      if (dm) {
        const [st, mo] = dm.split('|');
        if (confirm(`确认删除 ${META[st].name} ${mo} 的上传数据?`)) {
          if (st === 'kuaishou') { await DB.del('kuaishou', mo); delete S.kuaishou[mo]; }
          else {
            await DB.del('summary', st + '|' + mo); delete S.summary[st + '|' + mo];
            await DB.del('detail', st + '|' + mo); delete S.detail[st + '|' + mo];
          }
          toast('已删除该月数据'); render();
        }
      }
      if (dim && confirm(`确认删除 ${dim} 的库存数据?`)) {
        for (const [k, row] of Object.entries(S.inventoryMonthly || {})) if (row.month === dim) { await DB.del('inventoryMonthly', k); delete S.inventoryMonthly[k]; }
        for (const [k, row] of Object.entries(S.inventoryMovementMonthly || {})) if (row.month === dim) { await DB.del('inventoryMovementMonthly', k); delete S.inventoryMovementMonthly[k]; }
        invalidateInvCache();
        toast('已删除该月库存'); render();
      }
      if (ds && confirm(`确认删除 ${META[ds].name} 的全部数据?`)) {
        for (const k of Object.keys(S.summary)) if (k.startsWith(ds + '|')) { await DB.del('summary', k); delete S.summary[k]; }
        for (const k of Object.keys(S.detail)) if (k.startsWith(ds + '|')) { await DB.del('detail', k); delete S.detail[k]; }
        if (ds === 'kuaishou') { for (const k of Object.keys(S.kuaishou)) { await DB.del('kuaishou', k); delete S.kuaishou[k]; } }
        toast('已删除'); render();
      }
      if (clearInv && confirm('确认删除全部库存数据? 产品主数据会保留。')) {
        for (const k of Object.keys(S.inventoryMonthly)) await DB.del('inventoryMonthly', k);
        for (const k of Object.keys(S.inventoryMovementMonthly || {})) await DB.del('inventoryMovementMonthly', k);
        S.inventoryMonthly = {}; S.inventoryMovementMonthly = {};
        invalidateInvCache();
        toast('库存数据已删除'); render();
      }
      const dca = e.target.dataset?.delca;
      if (dca && confirm(`确认删除 ${dca} 的成本分析(全渠道)数据? 删后该月总览回退到清算表4店。`)) {
        for (const [k, row] of Object.entries(S.monthlyCostAnalysis || {})) if (row.month === dca) { await DB.del('monthlyCostAnalysis', k); delete S.monthlyCostAnalysis[k]; }
        toast('已删除该月成本分析'); render();
      }
      if (e.target.dataset?.clearca && confirm('确认删除全部成本分析数据?')) {
        for (const k of Object.keys(S.monthlyCostAnalysis || {})) await DB.del('monthlyCostAnalysis', k);
        S.monthlyCostAnalysis = {};
        toast('已删除全部成本分析'); render();
      }
    };
    $('#btnExport').onclick = async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `CDBI备份_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      toast('备份已导出');
    };
    $('#btnImport').onclick = () => $('#importInput').click();
    $('#importInput').onchange = async e => {
      try {
        const txt = await e.target.files[0].text();
        await DB.importAll(JSON.parse(txt));
        await loadState();
        toast('导入成功'); render();
      } catch (err) { toast('导入失败: ' + err.message); }
    };
    $('#btnClear').onclick = async () => {
      if (confirm('确认清空全部数据?此操作不可撤销(建议先导出备份)。')) {
        await DB.clearAll(); await loadState(); toast('已清空'); render();
      }
    };
    $('#btnPass').onclick = async () => {
      const v = $('#newPass').value.trim();
      if (v.length < 4) { toast('密码至少4位'); return; }
      localStorage.setItem('cdbi_pass_hash', await sha256(v));
      $('#newPass').value = '';
      toast('密码已更新(本设备生效)');
    };

    // ---- 汇率管理事件 ----
    const fxMonthVal = () => ($('#fxMonth').value || '').replace('-', '.'); // 2026-05 -> 2026.05
    $('#btnFxSave').onclick = async () => {
      const month = fxMonthVal();
      const u2k = parseFloat($('#fxUsdKrw').value), c2k = parseFloat($('#fxCnyKrw').value);
      const u2c = parseFloat($('#fxUsdCny').value);
      if (!/^\d{4}\.\d{2}$/.test(month)) { toast('请选择月份'); return; }
      if (!(u2k > 0) || !(c2k > 0)) { toast('USD→KRW 与 CNY→KRW 必填且需大于0'); return; }
      const rec = {
        month, usd_to_krw: u2k, cny_to_krw: c2k,
        usd_to_cny: u2c > 0 ? u2c : null, // null = 展示时由两条KRW汇率推导
        rate_date: monthEndBusinessDate(month),
        source_url: $('#fxUrl').value.trim() || 'http://www.smbs.biz/ExRate/TodayExRate.jsp', source_note: $('#fxNote').value.trim(),
        confirmed_by: $('#fxBy').value.trim(),
        confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      await DB.putRate(rec);
      FX.setRates(await DB.getAllRates());
      S.fxConflicts = FX.findConflicts(S.summary, META);
      toast(`已保存 ${month} 汇率`);
      render();
    };
    $('#btnFxAuto').onclick = async () => {
      const month = fxMonthVal();
      if (!/^\d{4}\.\d{2}$/.test(month)) { toast('请先选择月份'); return; }
      try {
        toast(`正在从 SMBS 获取 ${monthEndBusinessDate(month)} 汇率...`);
        const rec = await fetchSmbsRate(month);
        $('#fxUsdKrw').value = rec.usd_to_krw || '';
        $('#fxCnyKrw').value = rec.cny_to_krw || '';
        $('#fxUsdCny').value = rec.usd_to_cny || '';
        $('#fxUrl').value = rec.source_url || '';
        $('#fxNote').value = rec.source_note || '';
        $('#fxBy').value = rec.confirmed_by || '';
        await DB.putRate(rec);
        FX.setRates(await DB.getAllRates());
        S.fxConflicts = FX.findConflicts(S.summary, META);
        toast(`已获取并保存 ${month} SMBS 汇率`);
        render();
      } catch (err) {
        toast('SMBS 自动获取失败: ' + err.message);
      }
    };
    $('#btnFxFill').onclick = () => {
      const month = fxMonthVal();
      if (!/^\d{4}\.\d{2}$/.test(month)) { toast('请先选择月份'); return; }
      const rs = STORE_ORDER.map(st => rowOf(st, month)).filter(r => r && r.rate > 0).map(r => r.rate);
      if (!rs.length) { toast(`${month} 无清算表汇率数据`); return; }
      const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
      $('#fxUsdKrw').value = avg.toFixed(2);
      $('#fxNote').value = $('#fxNote').value || `清算表带入(${rs.length}店均值)`;
      toast(`已带入 ${month} 清算汇率均值 ${avg.toFixed(2)}`);
    };
    $('#btnFxAutoMissing').onclick = async () => {
      const monthsAll = allMonths();
      let filled = 0, skipped = 0, failed = 0;
      for (const mo of monthsAll) {
        const existing = FX.getRate(mo);
        if (existing && existing.usd_to_krw > 0 && existing.cny_to_krw > 0) { skipped++; continue; }
        try {
          const rec = await fetchSmbsRate(mo);
          await DB.putRate(rec);
          filled++;
        } catch (err) {
          failed++;
        }
      }
      FX.setRates(await DB.getAllRates());
      S.fxConflicts = FX.findConflicts(S.summary, META);
      toast(`SMBS 补齐完成: 新增/更新 ${filled} 月, 跳过 ${skipped} 月${failed ? `, 失败 ${failed} 月` : ''}`);
      render();
    };
    $('#btnFxBackfill').onclick = async () => {
      const monthsAll = allMonths();
      let filled = 0, skipped = 0;
      for (const mo of monthsAll) {
        const sr = settledRate(mo);
        if (!sr.length) continue;
        const avg = sr.reduce((a, b) => a + b, 0) / sr.length;
        const existing = FX.getRate(mo);
        if (existing && existing.usd_to_krw > 0) { skipped++; continue; }
        const rec = {
          month: mo, usd_to_krw: +avg.toFixed(2),
          cny_to_krw: existing && existing.cny_to_krw > 0 ? existing.cny_to_krw : null,
          usd_to_cny: existing ? existing.usd_to_cny : null,
          source_url: existing ? existing.source_url : '', source_note: (existing && existing.source_note) || '清算成交汇率回填(可手工微调)',
          confirmed_by: existing ? existing.confirmed_by : '', confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        await DB.putRate(rec); filled++;
      }
      FX.setRates(await DB.getAllRates());
      S.fxConflicts = FX.findConflicts(S.summary, META);
      toast(`已回填 ${filled} 个月官方USD→KRW${skipped ? `,跳过 ${skipped} 个已录入` : ''}。CNY→KRW 仍需手工补录。`);
      render();
    };
    $('#fxTable').onclick = async e => {
      const del = e.target.dataset?.fxdel;
      const edit = e.target.dataset?.fxedit;
      if (del && confirm(`删除 ${del} 汇率记录?`)) {
        await DB.delRate(del);
        FX.setRates(await DB.getAllRates());
        S.fxConflicts = FX.findConflicts(S.summary, META);
        toast('已删除'); render();
      }
      if (edit) {
        const rec = FX.getRate(edit);
        if (rec) {
          $('#fxMonth').value = edit.replace('.', '-');
          $('#fxUsdKrw').value = rec.usd_to_krw || '';
          $('#fxCnyKrw').value = rec.cny_to_krw || '';
          $('#fxUsdCny').value = rec.usd_to_cny || '';
          $('#fxUrl').value = rec.source_url || '';
          $('#fxNote').value = rec.source_note || '';
          $('#fxBy').value = rec.confirmed_by || '';
          toast('已载入表单,修改后点保存覆盖');
        }
      }
    };
    $('#btnFxTest').onclick = () => {
      const rs = FX.selfTest();
      $('#fxTestOut').innerHTML = '<ul>' + rs.map(r =>
        `<li>${r.pass ? '✓' : '✗'} <span class="${r.pass ? 'pos' : 'neg'}">${esc(r.name)}</span>${r.pass ? '' : ' — got: ' + esc(r.detail)}</li>`).join('') +
        `</ul><p class="note">${rs.every(r => r.pass) ? '全部通过' : '存在失败项,请截图反馈'} · FX引擎 v${FX.VERSION} · 解析器 v${P.PARSER_VERSION}</p>`;
    };
  }

  // 从清算文件金额隐含解析的店铺成交汇率 (net_krw/net_usd), 独立于"录入官方汇率"
  function settledRate(month) {
    const arr = [];
    for (const st of STORE_ORDER) {
      const r = rowOf(st, month);
      if (r && r.net_usd) arr.push(r.net_krw / r.net_usd);
      else if (r && r.rate > 0) arr.push(r.rate);
    }
    return arr;
  }
  // 汇率台账: 清算成交汇率(解析) vs 官方汇率(录入) 真实对照 + 环比突变检测
  function fxTableHtml() {
    const rates = FX.getRates();
    const monthsAsc = Array.from(new Set([...Object.keys(rates), ...allMonths()])).sort();
    const months = monthsAsc.slice().reverse();
    if (!months.length) return '<p class="note">暂无月份数据。</p>';
    let html = `<table class="tbl"><thead><tr><th>月份</th>
      <th title="从清算文件 净销售KRW÷净销售USD 隐含解析">清算成交汇率</th>
      <th title="从汇率网站确认后手工录入">官方 USD→KRW</th>
      <th title="清算成交 vs 官方, >0.5%标黄">偏差/校验</th>
      <th title="官方汇率环比, 单月>3%高亮待复核">环比突变</th>
      <th>CNY→KRW</th><th>USD→CNY</th><th>取数日</th><th style="text-align:left">来源/确认</th><th>操作</th></tr></thead><tbody>`;
    for (const mo of months) {
      const rec = rates[mo];
      const sr = settledRate(mo);
      const srMin = sr.length ? Math.min(...sr) : null, srMax = sr.length ? Math.max(...sr) : null;
      const srTxt = sr.length ? (Math.abs(srMax - srMin) < 0.05 ? srMin.toFixed(2) : `${srMin.toFixed(1)}~${srMax.toFixed(1)}`) : '<span class="note">无清算</span>';
      // 偏差: 成交 vs 官方; 官方缺 → 校验未生效
      let devTxt, rowCls = '';
      if (!rec || !(rec.usd_to_krw > 0)) devTxt = '<span class="neg">缺官方价·校验未生效</span>';
      else if (!sr.length) devTxt = '<span class="note">无清算数据</span>';
      else {
        const dev = Math.max(...sr.map(r => Math.abs(r - rec.usd_to_krw) / rec.usd_to_krw));
        const bad = dev > 0.005;
        if (bad) rowCls = 'conflict';
        devTxt = `<span class="${bad ? 'neg' : 'pos'}">${(dev * 100).toFixed(2)}%</span>${dev < 1e-6 ? ' <span class="note" title="成交=官方, 可能为同源带入, 非独立校验">⚠同源?</span>' : ''}`;
      }
      // 环比突变: 官方 USD→KRW vs 上月官方
      const idx = monthsAsc.indexOf(mo);
      const prevRec = idx > 0 ? rates[monthsAsc[idx - 1]] : null;
      let momTxt = '—';
      if (rec && rec.usd_to_krw > 0 && prevRec && prevRec.usd_to_krw > 0) {
        const mom = (rec.usd_to_krw - prevRec.usd_to_krw) / prevRec.usd_to_krw;
        const jump = Math.abs(mom) > 0.03;
        momTxt = `<span class="${jump ? 'neg' : ''}" ${jump ? 'title="单月波动>3%, 请复核是否录错"' : ''}>${mom > 0 ? '+' : ''}${(mom * 100).toFixed(2)}%${jump ? ' ⚠' : ''}</span>`;
      }
      const u2c = rec ? (rec.usd_to_cny > 0 ? rec.usd_to_cny.toFixed(4) : (rec.usd_to_krw > 0 && rec.cny_to_krw > 0 ? (rec.usd_to_krw / rec.cny_to_krw).toFixed(4) + ' <span class="note">推导</span>' : '—')) : '—';
      const rateDate = rec && (rec.rate_date || rec.settlement_date) ? (rec.rate_date || rec.settlement_date) : monthEndBusinessDate(mo);
      const srcTxt = rec ? `${esc(rec.source_note || '')}${rec.source_url ? ` <a href="${esc(rec.source_url)}" target="_blank" rel="noopener">链接</a>` : ''}${rec.confirmed_by ? ` · ${esc(rec.confirmed_by)}` : ''}${rec.confirmed_at ? ` · ${rec.confirmed_at.slice(0, 10)}` : ''}` : '<span class="neg">未录入</span>';
      html += `<tr class="${rowCls}">
        <td>${mo}</td><td>${srTxt}</td>
        <td>${rec && rec.usd_to_krw > 0 ? rec.usd_to_krw.toFixed(2) : '<span class="neg">缺</span>'}</td>
        <td>${devTxt}</td><td>${momTxt}</td>
        <td>${rec && rec.cny_to_krw > 0 ? rec.cny_to_krw.toFixed(2) : '<span class="neg">缺</span>'}</td>
        <td>${u2c}</td>
        <td>${rateDate || '—'}</td>
        <td style="text-align:left">${srcTxt}</td>
        <td>${rec ? `<button class="btn btn-sm" data-fxedit="${mo}">编辑</button> <button class="btn btn-sm btn-danger" data-fxdel="${mo}">删除</button>` : '—'}</td></tr>`;
    }
    html += '</tbody></table><p class="note">「清算成交汇率」从清算文件金额(净销售KRW÷净销售USD)隐含反解,独立于手录官方汇率;两者偏差>0.5%标黄。若显示"⚠同源",说明录入值与清算汇率完全一致(可能直接带入),建议改录汇率网站的独立官方价以使校验有效。</p>';
    return html;
  }

  function askInventoryMonth(filename) {
    const guess = (new Date()).toISOString().slice(0, 7).replace('-', '.');
    const v = prompt(`请确认月末库存表月份 YYYY.MM\n${filename}`, S.invUploadMonth || guess);
    if (!v) throw new Error('已取消库存表上传');
    const month = v.trim().replace('-', '.');
    if (!/^\d{4}\.\d{2}$/.test(month)) throw new Error('库存月份格式必须为 YYYY.MM');
    S.invUploadMonth = month;
    return month;
  }

  async function saveProductMaster(res, stamp) {
    let n = 0;
    for (const row of res.rows) {
      const key = skuKey(row.sku_code);
      const rec = { ...row, sku_code: key, uploaded_at: stamp._uploadedAt, _parserVer: stamp._parserVer };
      S.productMaster[key] = rec;
      await DB.put('productMaster', key, rec);
      n++;
    }
    return n;
  }

  async function refreshInventoryCosts() {
    for (const [k, row] of Object.entries(S.inventoryMonthly || {})) {
      const enriched = enrichInvRow(row);
      S.inventoryMonthly[k] = enriched;
      await DB.put('inventoryMonthly', k, enriched);
    }
    invalidateInvCache();
  }

  async function saveInventoryMonthly(res, stamp) {
    return { n: 0, ignored: true, month: res.month };
  }

  async function saveStockLedgerWorkbook(res, stamp) {
    let invN = 0, movN = 0;
    const months = new Set([...(res.inventoryRows || []), ...(res.movements || [])].map(r => r.month));
    const isOldLedgerRow = row => {
      if (!months.has(row.month)) return false;
      if (row.source_type === 'stockLedger') return true;
      if (/수불부|재고금액/.test(row.source_file || '')) return true;
      return /(_\d{2}년\d{1,2}월|_\d{1,2}월|씨디브라운|블루닷스튜디오코리아)/.test(row.warehouse || '');
    };
    for (const [k, row] of Object.entries(S.inventoryMonthly || {})) {
      if (isOldLedgerRow(row)) {
        await DB.del('inventoryMonthly', k);
        delete S.inventoryMonthly[k];
      }
    }
    for (const [k, row] of Object.entries(S.inventoryMovementMonthly || {})) {
      if (isOldLedgerRow(row)) {
        await DB.del('inventoryMovementMonthly', k);
        delete S.inventoryMovementMonthly[k];
      }
    }
    for (const raw of res.inventoryRows || []) {
      const rec = enrichInvRow({ ...raw, sku_code: skuKey(raw.sku_code), uploaded_at: stamp._uploadedAt, _parserVer: stamp._parserVer });
      const key = `${rec.month}|${rec.warehouse || '未指定'}|${rec.sku_code}`;
      S.inventoryMonthly[key] = rec;
      await DB.put('inventoryMonthly', key, rec);
      invN++;
    }
    for (const raw of res.movements || []) {
      const rec = { ...raw, sku_code: skuKey(raw.sku_code), uploaded_at: stamp._uploadedAt, _parserVer: stamp._parserVer };
      const key = `${rec.month}|${rec.warehouse || '未指定'}|${rec.sku_code}`;
      S.inventoryMovementMonthly[key] = rec;
      await DB.put('inventoryMovementMonthly', key, rec);
      movN++;
    }
    invalidateInvCache();
    return { invN, movN, months: Array.from(months).sort() };
  }

  async function saveCostAnalysisWorkbook(res, stamp) {
    let n = 0;
    const months = Array.from(new Set((res.rows || []).map(r => r.month)));
    // 重传按月替换: 先清掉新文件涉及月份的旧记录, 避免叠加/重复污染
    for (const [k, row] of Object.entries(S.monthlyCostAnalysis || {})) {
      if (months.includes(row.month)) { await DB.del('monthlyCostAnalysis', k); delete S.monthlyCostAnalysis[k]; }
    }
    for (const raw of res.rows || []) {
      const rec = { ...raw, uploaded_at: stamp._uploadedAt, _parserVer: stamp._parserVer };
      const key = `${rec.month}|${rec.channel_or_customer || rec.sales_type || 'row'}|${rec.row_index}|${n}`;
      S.monthlyCostAnalysis[key] = rec;
      await DB.put('monthlyCostAnalysis', key, rec);
      n++;
    }
    return { n, months: months.slice().sort() };
  }

  async function handleFiles(files) {
    const log = $('#upLog');
    const tasks = [];
    for (const f of Array.from(files)) {
      const item = document.createElement('div');
      item.className = 'log-item';
      item.textContent = `解析中: ${f.name} ...`;
      log.prepend(item);
      try {
        const buf = await f.arrayBuffer();
        let res;
        try {
          res = P.parseFile(f.name, buf);
        } catch (err) {
          if (!String(err.message || '').includes('月末库存表必须先确认月份')) throw err;
          res = P.parseFile(f.name, buf, { month: askInventoryMonth(f.name) });
        }
        const stamp = { _src: f.name, _uploadedAt: new Date().toISOString(), _parserVer: P.PARSER_VERSION }; // 审计戳
        tasks.push({ f, item, res, stamp });
      } catch (err) {
        item.className = 'log-item err';
        item.innerHTML = `✗ <b>${esc(f.name)}</b> 解析失败: ${esc(err.message)}`;
      }
    }

    const priority = { productMaster: 0, stockLedgerWorkbook: 1, costAnalysisWorkbook: 1, inventoryMonthly: 2 };
    tasks.sort((a, b) => (priority[a.res.type] ?? 5) - (priority[b.res.type] ?? 5));
    for (const task of tasks) {
      const { f, item, res, stamp } = task;
      try {
        if (res.type === 'stockLedgerWorkbook') {
          const stat = await saveStockLedgerWorkbook(res, stamp);
          item.className = 'log-item ok';
          item.innerHTML = `✓ <b>${esc(f.name)}</b> → 수불부/재고금액 ${stat.months.join(', ')} ` +
            `(月末库存 ${stat.invN} 行 / 收发 ${stat.movN} 行)`;
          item.innerHTML += standardLogHtml(stat.months);
        } else if (res.type === 'costAnalysisWorkbook') {
          const stat = await saveCostAnalysisWorkbook(res, stamp);
          item.className = 'log-item ok';
          item.innerHTML = `✓ <b>${esc(f.name)}</b> → 매출대비원가분석 ${stat.months.join(', ')} ` +
            `(${stat.n} 行渠道/客户利润记录)`;
          item.innerHTML += standardLogHtml(stat.months);
        } else if (res.type === 'productMaster') {
          const n = await saveProductMaster(res, stamp);
          item.className = 'log-item ok';
          item.innerHTML = `✓ <b>${esc(f.name)}</b> → 产品主数据 upsert ${n} 个 품번`;
        } else if (res.type === 'inventoryMonthly') {
          const stat = await saveInventoryMonthly(res, stamp);
          item.className = 'log-item warn';
          item.innerHTML = `⚠ <b>${esc(f.name)}</b> → 已识别为 PMP/月末库存表,但库存管理标准已改为只采用 수불부&재고금액,本文件不写入库存板块。`;
        } else if (res.type === 'kuaishou') {
          Object.assign(res, stamp);
          S.kuaishou[res.month] = res;
          await DB.put('kuaishou', res.month, res);
          item.className = 'log-item ok';
          item.innerHTML = `✓ <b>${esc(f.name)}</b> → 快手店快照 (${res.month}), 历次清算 ${res.history.length} 条`;
        } else {
          for (const row of res.summaryRows) {
            const k = res.store + '|' + row.month;
            Object.assign(row, stamp);
            S.summary[k] = row;
            await DB.put('summary', k, row);
          }
          const dk = res.store + '|' + res.month;
          const detail = { store: res.store, month: res.month, skus: res.detail.skus, inventory: res.detail.inventory, src: f.name, upload_id: stamp._uploadId, uploadedAt: stamp._uploadedAt, parserVer: P.PARSER_VERSION };
          S.detail[dk] = detail;
          await DB.put('detail', dk, detail);
          const qaTxt = res.qa.length ? `<br>⚠ QA: ${res.qa.map(esc).join('; ')}` : ' · QA校验全部通过';
          item.className = 'log-item ' + (res.qa.length ? 'warn' : 'ok');
          item.innerHTML = `✓ <b>${esc(f.name)}</b> → ${META[res.store].name} ${res.month}` +
            ` (历史${res.summaryRows.length}个月 / SKU ${res.detail.skus.length} / 库存 ${res.detail.inventory.length}` +
            `${res.mapSource === 'fallback' ? ' / 列结构按预置映射' : ''})${qaTxt}`;
          if (res.store === 'cdbrown') item.innerHTML += standardLogHtml([res.month]);
        }
        updateStatus();
      } catch (err) {
        item.className = 'log-item err';
        item.innerHTML = `✗ <b>${esc(f.name)}</b> 保存失败: ${esc(err.message)}`;
      }
    }
    S.fxConflicts = FX.findConflicts(S.summary, META); // 上传后刷新汇率冲突检查
    toast('上传处理完成');
  }

  // ---------- 启动 ----------
  async function loadState() {
    S.summary = await DB.getAll('summary');
    S.detail = await DB.getAll('detail');
    S.kuaishou = await DB.getAll('kuaishou');
    S.inventoryMonthly = await DB.getAll('inventoryMonthly');
    S.inventoryMovementMonthly = await DB.getAll('inventoryMovementMonthly');
    S.monthlyCostAnalysis = await DB.getAll('monthlyCostAnalysis');
    S.productMaster = await DB.getAll('productMaster');
    S.uploadRecords = await DB.getAll('uploadRecords');
    await applyConfirmedCnyRates();
    FX.setRates(await DB.getAllRates());
    S.fxConflicts = FX.findConflicts(S.summary, META);
  }

  async function checkPass(input) {
    const emailEl = $('#gateEmail');
    const email = emailEl ? String(emailEl.value || '').trim() : '';
    if (email && DB.signIn) {
      await DB.signIn(email, input);
      return true;
    }
    const stored = localStorage.getItem('cdbi_pass_hash');
    const h = await sha256(String(input || '').trim());
    if (stored && h === stored) return true;
    return h === await sha256(DEFAULT_PASS) || h === await sha256(LEGACY_PASS);
  }

  function showApp() {
    $('#gate').classList.add('hidden');
    $('#app').classList.remove('hidden');
    render();
  }

  async function init() {
    await loadState();
    if (!$('#gateEmail')) {
      const passLabel = document.querySelector('label[for="gatePass"]');
      if (passLabel) {
        const emailLabel = document.createElement('label');
        emailLabel.setAttribute('for', 'gateEmail');
        emailLabel.textContent = '云端账号邮箱';
        const emailInput = document.createElement('input');
        emailInput.type = 'email';
        emailInput.id = 'gateEmail';
        emailInput.autocomplete = 'username';
        emailInput.placeholder = '请输入 Supabase 用户邮箱';
        passLabel.before(emailLabel, emailInput);
        passLabel.textContent = '云端账号密码 / 本机访问密码';
      }
    }
    $('#nav').onclick = e => { const b = e.target.closest('.nav-item'); if (b) setView(b.dataset.view); };
    $('#gotoData').onclick = () => setView('data');
    $('#lockBtn').onclick = () => { sessionStorage.removeItem('cdbi_auth'); if (DB.signOut) DB.signOut(); location.reload(); };
    $('#gateForm').onsubmit = async e => {
      e.preventDefault();
      try {
        if (await checkPass($('#gatePass').value)) {
        sessionStorage.setItem('cdbi_auth', '1');
        showApp();
      } else {
        $('#gateErr').classList.remove('hidden');
        $('#gatePass').value = ''; $('#gatePass').focus();
      }
      } catch (err) {
        $('#gateErr').textContent = '云端登录失败：' + (err.message || err);
        $('#gateErr').classList.remove('hidden');
      }
    };
    if (DB.onCloudChange) {
      DB.onCloudChange(async () => {
        await loadState();
        render();
        toast('云端数据已同步');
      });
    }
    if (sessionStorage.getItem('cdbi_auth') === '1') showApp();
    else { $('#gate').classList.remove('hidden'); $('#gatePass').focus(); }
  }

  init();
})();
