/* ===== CD-BI 清算表解析器 =====
 * 策略: 表头关键词动态定位列(适配各店列结构差异及未来变动) + 静态映射兜底 + 4项完整性校验
 * 口径: 总费用(fee)已含广告/技术服务/CS费; 利润 = 净销售KRW - 出库原价 + 费用USD×汇率
 */
(function (global) {
  'use strict';

  const PARSER_VERSION = '2.1.0'; // 审计: 解析逻辑版本, 随入库记录

  const STORE_META = {
    deepte:   { name: 'PDD-Deepte',     full: 'PDD-Deepte海外旗舰店',    ko: '딥트',      platform: '拼多多', color: '#3B82F6' },
    ssf:      { name: 'PDD-SSF',        full: 'PDD-SSF海外专营店',       ko: 'SSF',      platform: '拼多多', color: '#1E40AF' },
    cdbrown:  { name: 'PDD-CD BROWN',   full: 'PDD-CD BROWN海外专营店',  ko: 'CD브라운',  platform: '拼多多', color: '#F59E0B' },
    jingya:   { name: '鲸芽-CD大连',     full: '鲸芽(징야)-CD大连店',      ko: '징야',      platform: '鲸芽',   color: '#10B981' },
    kuaishou: { name: '快手-HOKABOMB',   full: '快手-HOKABOMB海外旗舰店', ko: '호카밤',    platform: '快手',   color: '#8B5CF6' },
  };

  // ---- 静态兜底列映射 (2026.04/05 批次实测) ----
  const SUM_FALLBACK = {
    deepte:  { gmv_cny:3, gmv_usd:4, refund_cny:5, refund_usd:6, net_cny:7, net_usd:8, fee_cny:10, fee_usd:11, tech_fee_usd:12, cs_fee_usd:13, other_income_usd:14, ad_usd:15, rate:21, net_krw:22, cogs_krw:23, cost_rate:24, profit_krw:25, margin:26, ending_inventory_krw:27 },
    ssf:     null, // 同 deepte
    cdbrown: { gmv_cny:3, gmv_usd:4, refund_cny:5, refund_usd:6, net_cny:7, net_usd:8, fee_cny:10, fee_usd:11, tech_fee_usd:12, cs_fee_usd:13, other_income_usd:14, ad_usd:15, rate:20, net_krw:21, cogs_krw:22, cost_rate:23, profit_krw:24, margin:25, ending_inventory_krw:26 },
    jingya:  { gmv_cny:3, gmv_usd:4, refund_cny:5, refund_usd:6, net_cny:7, net_usd:8, fee_cny:10, fee_usd:11, tech_fee_usd:0, cs_fee_usd:0, other_income_usd:0, ad_usd:0, rate:16, net_krw:17, cogs_krw:18, cost_rate:19, profit_krw:20, margin:21, ending_inventory_krw:22 },
  };
  SUM_FALLBACK.ssf = SUM_FALLBACK.deepte;

  // ---- 工具 ----
  function cv(ws, r, c) { // 1-indexed
    if (!c || c < 1) return 0;
    const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })];
    if (!cell || cell.v === undefined || cell.v === null) return 0;
    return cell.v;
  }
  function cs(ws, r, c) { const v = cv(ws, r, c); return v === 0 ? '' : String(v); }
  function ct(ws, r, c) {
    if (!c || c < 1) return '';
    const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })];
    if (!cell || cell.v === undefined || cell.v === null) return '';
    return String(cell.w ?? cell.v);
  }
  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    const s = String(v ?? '').replace(/[₩$¥,\s]/g, '').replace(/[^\d.-]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
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
  function clean(s) { return String(s ?? '').replace(/\s+/g, '').trim(); }
  function sheetRange(ws) { return ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { e: { r: 0, c: 0 } }; }
  function maxRow(ws) { return sheetRange(ws).e.r + 1; }
  function maxCol(ws) { return sheetRange(ws).e.c + 1; }

  function findSheet(wb, patterns) {
    for (const name of wb.SheetNames) {
      for (const p of patterns) {
        if (p instanceof RegExp) { if (p.test(name)) return name; }
        else if (name.toLowerCase().includes(p.toLowerCase())) return name;
      }
    }
    return null;
  }

  function parseMonthText(s) {
    const t = String(s || '').trim();
    let m = t.match(/(\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
    if (m) return '20' + m[1] + '.' + String(+m[2]).padStart(2, '0');
    m = t.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
    if (m) return m[1] + '.' + String(+m[2]).padStart(2, '0');
    m = t.match(/(\d{2})년\s*(\d{1,2})월/);
    if (m) return '20' + m[1] + '.' + String(+m[2]).padStart(2, '0');
    return null;
  }

  function monthFromSheet(ws, sheetName) {
    for (let r = 1; r <= Math.min(3, maxRow(ws)); r++) {
      for (let c = 1; c <= Math.min(maxCol(ws), 25); c++) {
        const m = parseMonthText(ct(ws, r, c));
        if (m) return m;
      }
    }
    return parseMonthText(sheetName);
  }

  function isLedgerWorkbook(wb) {
    return wb.SheetNames.some(n => /수불부/.test(n)) && wb.SheetNames.some(n => /재고금액/.test(n));
  }

  function findHeaderCols(ws, headerRow, names) {
    const cols = {};
    for (let c = 1; c <= Math.min(maxCol(ws), 40); c++) {
      const t = clean(ct(ws, headerRow, c));
      for (const [key, re] of Object.entries(names)) {
        if (!cols[key] && re.test(t)) cols[key] = c;
      }
    }
    return cols;
  }

  function parseStockLedgerWorkbook(wb, filename) {
    if (!isLedgerWorkbook(wb)) return null;
    const movements = [];
    const monthly = [];
    const source = filename;

    for (const sn of wb.SheetNames) {
      const ws = wb.Sheets[sn];
      const month = monthFromSheet(ws, sn);
      if (!month) continue;
      const warehouse = sn
        .replace(/\(.+\)/g, '')
        .replace(/_\d{1,2}월.*/g, '')
        .replace(/_\d{2}년\d{1,2}월.*/g, '')
        .replace(/씨디브라운/g, 'BlueDot Studio Korea')
        .replace(/블루닷스튜디오코리아/g, 'BlueDot Studio Korea')
        .trim() || 'BlueDot Studio Korea';

      if (/수불부/.test(sn)) {
        const cols = findHeaderCols(ws, 2, {
          sku: /^품번$/, name: /^품명$/, spec: /^규격$/, unit: /^단위$/,
          openingQty: /^기초수량$/, openingValue: /^기초금액$/,
          inboundQty: /^입고수량$/, inboundValue: /^입고금액$/,
          transferInQty: /^대체입고수량$/, transferInValue: /^대체입고금액$/,
          outboundQty: /^출고수량$/, outboundUnitCost: /^출고단가$/, outboundValue: /^출고금액$/,
          transferOutQty: /^대체출고수량$/, transferOutValue: /^대체출고금액$/,
        });
        if (!cols.sku || !cols.outboundQty) continue;
        for (let r = 3; r <= maxRow(ws); r++) {
          const sku = skuKey(cs(ws, r, cols.sku));
          if (!sku || /합계|total|ttl/i.test(sku)) continue;
          movements.push({
            month, warehouse,
            sku_code: sku,
            product_name: cs(ws, r, cols.name).trim(),
            barcode_or_spec: cs(ws, r, cols.spec).trim(),
            unit: cs(ws, r, cols.unit).trim(),
            opening_qty: num(cv(ws, r, cols.openingQty)),
            opening_value_krw: num(cv(ws, r, cols.openingValue)),
            inbound_qty: num(cv(ws, r, cols.inboundQty)),
            inbound_value_krw: num(cv(ws, r, cols.inboundValue)),
            transfer_in_qty: num(cv(ws, r, cols.transferInQty)),
            transfer_in_value_krw: num(cv(ws, r, cols.transferInValue)),
            outbound_qty: num(cv(ws, r, cols.outboundQty)),
            outbound_unit_cost_krw: num(cv(ws, r, cols.outboundUnitCost)),
            outbound_value_krw: num(cv(ws, r, cols.outboundValue)),
            transfer_out_qty: num(cv(ws, r, cols.transferOutQty)),
            transfer_out_value_krw: num(cv(ws, r, cols.transferOutValue)),
            source_file: source,
            source_type: 'stockLedger',
          });
        }
      }

      if (/재고금액/.test(sn)) {
        const cols = findHeaderCols(ws, 2, {
          sku: /^품번$/, name: /^품명$/, endingQty: /^재고수량$/, endingValue: /^재고금액$/,
        });
        if (!cols.sku || !cols.endingQty) continue;
        for (let r = 3; r <= maxRow(ws); r++) {
          const sku = skuKey(cs(ws, r, cols.sku));
          if (!sku || /합계|total|ttl/i.test(sku)) continue;
          const endingQty = num(cv(ws, r, cols.endingQty));
          const endingValue = num(cv(ws, r, cols.endingValue));
          monthly.push({
            month, warehouse,
            sku_code: sku,
            product_name: cs(ws, r, cols.name).trim(),
            barcode_or_spec: '',
            unit: 'EA',
            opening_qty: null,
            inbound_qty_daily: 0,
            inbound_qty_cum: 0,
            outbound_qty_daily: 0,
            outbound_qty_cum: 0,
            ending_qty: endingQty,
            unit_cost_krw: endingQty ? endingValue / endingQty : null,
            ending_value_krw: endingValue,
            source_ending_value_krw: endingValue,
            cost_missing: endingQty > 0 && !endingValue,
            estimated_inbound: false,
            estimated_outbound: false,
            source_file: source,
            source_type: 'stockLedger',
          });
        }
      }
    }
    return { type: 'stockLedgerWorkbook', movements, inventoryRows: monthly, src: filename };
  }

  function isCostAnalysisSheet(ws) {
    const txt = Array.from({ length: Math.min(maxCol(ws), 20) }, (_, i) => clean(ct(ws, 3, i + 1))).join('|');
    return /매출유형/.test(txt) && /매출액/.test(txt) && /매입액/.test(txt) && /이익금/.test(txt);
  }

  function parseCostAnalysisWorkbook(wb, filename) {
    const rows = [];
    for (const sn of wb.SheetNames) {
      if (/샘플|폐기/.test(sn)) continue;
      const ws = wb.Sheets[sn];
      if (!isCostAnalysisSheet(ws)) continue;
      const month = monthFromSheet(ws, sn);
      if (!month) continue;
      // 稳健列识别: 扫描表头逐列分类, 区分 $列 与 KRW列(含 ₩/\/원/() 变体), 不再盲目按固定位置兜底
      const cols = {};
      const set = (k, c) => { if (!cols[k]) cols[k] = c; };
      const mc = Math.min(maxCol(ws), 40);
      for (let c = 1; c <= mc; c++) {
        const t = clean(ct(ws, 3, c));
        if (!t) continue;
        const isUsd = /\$|달러|USD/i.test(t);
        if (/^매출유형/.test(t)) set('salesType', c);
        else if (/^부서명/.test(t)) set('department', c);
        else if (/^담당자/.test(t)) set('owner', c);
        else if (/^날짜/.test(t)) set('date', c);
        else if (/매출환율/.test(t)) set('salesRate', c);
        else if (/매입환율/.test(t)) set('purchaseRate', c);
        else if (/매출액/.test(t)) set(isUsd ? 'salesUsd' : 'salesKrw', c);
        else if (/매입액/.test(t)) set(isUsd ? 'purchaseUsd' : 'purchaseKrw', c);
        else if (/이익금/.test(t)) set('profitKrw', c);
        else if (/이익[율률]/.test(t)) set('margin', c);
        else if (/비고/.test(t)) set('note', c);
        else if (/거래처|채널|店铺|점포|상호/.test(t)) set('channel', c);
      }
      // 渠道列: 优先表头匹配, 否则取"날짜"右侧一列, 再否则第5列
      const channelCol = cols.channel || (cols.date ? cols.date + 1 : 5);
      // 必备KRW列缺失 → 明确报错(避免静默取错列导致净销售=0)
      if (!cols.salesKrw || !cols.profitKrw) {
        const seen = [];
        for (let c = 1; c <= mc; c++) { const t = clean(ct(ws, 3, c)); if (t) seen.push(c + ':' + t); }
        throw new Error('매출대비원가분석: 未能识别 매출액(₩)/이익금(₩) 列。实际表头: ' + seen.join(' | '));
      }
      for (let r = 4; r <= maxRow(ws); r++) {
        const channel = cs(ws, r, channelCol).trim();
        const type = cs(ws, r, cols.salesType).trim();
        const salesKrw = num(cv(ws, r, cols.salesKrw));
        const purchaseKrw = num(cv(ws, r, cols.purchaseKrw));
        const profitKrw = num(cv(ws, r, cols.profitKrw));
        const label = (type + channel + cs(ws, r, 1)).trim();
        if (!label || /합계/.test(label)) continue;
        if (!channel && !salesKrw && !purchaseKrw && !profitKrw) continue;
        rows.push({
          month,
          sales_type: type,
          department: cs(ws, r, cols.department).trim(),
          owner: cs(ws, r, cols.owner).trim(),
          date: ct(ws, r, cols.date).trim(),
          channel_or_customer: channel,
          sales_usd: num(cv(ws, r, cols.salesUsd)),
          sales_rate: num(cv(ws, r, cols.salesRate)),
          purchase_usd: num(cv(ws, r, cols.purchaseUsd)),
          purchase_rate: num(cv(ws, r, cols.purchaseRate)),
          sales_krw: salesKrw,
          purchase_cost_krw: purchaseKrw,
          profit_krw: profitKrw,
          margin: num(cv(ws, r, cols.margin)),
          note: cs(ws, r, cols.note).trim(),
          source_file: filename,
          row_index: r,
        });
      }
    }
    return rows.length ? { type: 'costAnalysisWorkbook', rows, src: filename } : null;
  }

  function headerText(ws, row, col) {
    return clean(cs(ws, row, col));
  }

  function detectProductMaster(ws) {
    const labels = {};
    for (let c = 1; c <= Math.min(maxCol(ws), 30); c++) labels[c] = headerText(ws, 1, c);
    const vals = Object.values(labels).join('|');
    if (!/품번/.test(vals) || !/구매단가/.test(vals) || !/환산표준원가/.test(vals)) return null;
    const cols = {};
    for (const [c, t] of Object.entries(labels)) {
      const ci = +c;
      if (t === '품번') cols.sku = ci;
      else if (t === '품명') cols.name = ci;
      else if (t === '규격') cols.spec = ci;
      else if (t === '재고단위') cols.stockUnit = ci;
      else if (t === '관리단위') cols.mgmtUnit = ci;
      else if (t === '환산계수') cols.factor = ci;
      else if (t === '환산표준원가') cols.stdCost = ci;
      else if (t === '구매단가') cols.purchase = ci;
    }
    return cols.sku && cols.name ? cols : null;
  }

  function parseProductMaster(wb, filename) {
    for (const sn of wb.SheetNames) {
      const ws = wb.Sheets[sn];
      const cols = detectProductMaster(ws);
      if (!cols) continue;
      const rows = [];
      for (let r = 2; r <= maxRow(ws); r++) {
        const sku = cs(ws, r, cols.sku).trim();
        if (!sku) continue;
        rows.push({
          sku_code: skuKey(sku),
          product_name: cs(ws, r, cols.name).trim(),
          barcode_or_spec: cs(ws, r, cols.spec).trim(),
          stock_unit: cs(ws, r, cols.stockUnit).trim(),
          management_unit: cs(ws, r, cols.mgmtUnit).trim(),
          conversion_factor: num(cv(ws, r, cols.factor)),
          standard_cost_krw: num(cv(ws, r, cols.stdCost)),
          purchase_price_krw: num(cv(ws, r, cols.purchase)),
          source_file: filename,
          source_type: 'pmp',
        });
      }
      return { type: 'productMaster', rows, src: filename };
    }
    return null;
  }

  function detectInventoryMonthly(ws) {
    const labels = {};
    for (let c = 1; c <= Math.min(maxCol(ws), 40); c++) {
      const top = headerText(ws, 1, c);
      const sub = headerText(ws, 2, c);
      labels[c] = top + (sub && sub !== top ? '/' + sub : '');
    }
    const txt = Object.values(labels).join('|');
    if (!/창고/.test(txt) || !/품번/.test(txt) || !/기말재고/.test(txt)) return null;
    const cols = {};
    for (const [c, t] of Object.entries(labels)) {
      const ci = +c;
      if (/^창고/.test(t)) cols.warehouse = ci;
      else if (/^품번/.test(t)) cols.sku = ci;
      else if (/^품명/.test(t)) cols.name = ci;
      else if (/^규격/.test(t)) cols.spec = ci;
      else if (/단위.*재고|재고단위/.test(t)) cols.unit = ci;
      else if (/기초재고/.test(t)) cols.opening = ci;
      else if (/입고.*일계/.test(t)) cols.inDaily = ci;
      else if (/입고.*누계/.test(t)) cols.inCum = ci;
      else if (/출고.*일계/.test(t)) cols.outDaily = ci;
      else if (/출고.*누계/.test(t)) cols.outCum = ci;
      else if (/기말재고/.test(t) && !/금액|금액/.test(t)) cols.ending = ci;
      else if (/기말.*금액|재고.*금액|금액/.test(t)) cols.endingValue = ci;
    }
    return cols.warehouse && cols.sku && cols.ending ? cols : null;
  }

  function parseInventoryMonthly(wb, filename, opts = {}) {
    for (const sn of wb.SheetNames) {
      const ws = wb.Sheets[sn];
      const cols = detectInventoryMonthly(ws);
      if (!cols) continue;
      const month = opts.month;
      if (!/^\d{4}\.\d{2}$/.test(month || '')) throw new Error('月末库存表必须先确认月份 YYYY.MM');
      const rows = [];
      for (let r = 3; r <= maxRow(ws); r++) {
        const sku = skuKey(cs(ws, r, cols.sku));
        if (!sku || sku === '품번' || /합계|total|ttl/i.test(sku)) continue;
        const ending = num(cv(ws, r, cols.ending));
        const sourceEndingValue = cols.endingValue ? num(cv(ws, r, cols.endingValue)) : null;
        rows.push({
          month,
          warehouse: cs(ws, r, cols.warehouse).trim(),
          sku_code: skuKey(sku),
          product_name: cs(ws, r, cols.name).trim(),
          barcode_or_spec: cs(ws, r, cols.spec).trim(),
          unit: cs(ws, r, cols.unit).trim(),
          opening_qty: num(cv(ws, r, cols.opening)),
          inbound_qty_daily: num(cv(ws, r, cols.inDaily)),
          inbound_qty_cum: num(cv(ws, r, cols.inCum)),
          outbound_qty_daily: num(cv(ws, r, cols.outDaily)),
          outbound_qty_cum: num(cv(ws, r, cols.outCum)),
          ending_qty: ending,
          unit_cost_krw: null,
          ending_value_krw: null,
          source_ending_value_krw: sourceEndingValue,
          cost_missing: true,
          estimated_inbound: false,
          estimated_outbound: false,
          source_file: filename,
        });
      }
      return { type: 'inventoryMonthly', month, rows, src: filename };
    }
    return null;
  }

  // ---- 店铺识别: 文件名优先, 其次 summary 表头内容 ----
  function detectStore(filename, wb) {
    const f = filename.toLowerCase();
    if (/콰이쇼우|호카밤|hokabomb|kuaishou|快手/.test(f)) return 'kuaishou';
    if (/징야|jingya|鲸芽/.test(f)) return 'jingya';
    if (/brown/.test(f)) return 'cdbrown';
    if (/deepte/.test(f)) return 'deepte';
    if (/ssf/.test(f)) return 'ssf';
    const sn = findSheet(wb, ['summary', 'TTL']);
    if (sn) {
      const ws = wb.Sheets[sn];
      const head = (cs(ws, 2, 2) + ' ' + cs(ws, 3, 2) + ' ' + cs(ws, 3, 4)).toLowerCase();
      if (/콰이서우|快手|hokabomb/.test(head)) return 'kuaishou';
      if (/징야|鲸芽|淘分销/.test(head)) return 'jingya';
      if (/brown/.test(head)) return 'cdbrown';
      if (/deepte|딥트/.test(head)) return 'deepte';
      if (/ssf/.test(head)) return 'ssf';
    }
    return null;
  }

  // ---- 文件月份识别 (支持单位数月份 "26년4월") ----
  function detectMonth(filename) {
    let m = filename.match(/(\d{2})년\s*(\d{1,2})월/);
    if (m) return '20' + m[1] + '.' + String(m[2]).padStart(2, '0');
    m = filename.match(/(20\d{2})[.\-年]\s*(\d{1,2})月?/);
    if (m) return m[1] + '.' + String(m[2]).padStart(2, '0');
    return null;
  }

  // ---- summary 表头动态定位 ----
  function detectSummaryMap(ws) {
    // 表头行: 在 1..8 行中找包含 "시간" 或 "GMV" 的行
    let hr = 0;
    for (let r = 1; r <= 8; r++) {
      let rowTxt = '';
      for (let c = 1; c <= 30; c++) rowTxt += cs(ws, r, c) + '|';
      if (/시간|GMV/.test(rowTxt)) { hr = r; break; }
    }
    if (!hr) return null;
    const map = {};
    const mc = Math.min(maxCol(ws), 40);
    for (let c = 1; c <= mc; c++) {
      const t = cs(ws, hr, c);
      if (!t) continue;
      if (/^GMV/.test(t) && !map.gmv_cny) { map.gmv_cny = c; map.gmv_usd = c + 1; }
      else if (/Refund|退款/.test(t) && !map.refund_cny) { map.refund_cny = c; map.refund_usd = c + 1; }
      else if (/매출실적|实际销售/.test(t) && !map.net_cny) { map.net_cny = c; map.net_usd = c + 1; }
      else if (/^Fee|수수료\b/.test(t) && !map.fee_cny && !/세부/.test(t)) { map.fee_cny = c; map.fee_usd = c + 1; }
      else if (/技术服务费|기술서비스/.test(t) && !map.tech_fee_usd) map.tech_fee_usd = c;
      else if (/售后费用|CS비용/.test(t) && !map.cs_fee_usd) map.cs_fee_usd = c;
      else if (/其他收入|기타수/.test(t) && !map.other_income_usd) map.other_income_usd = c;
      else if (/转账-广告|광고비/.test(t) && !map.ad_usd) map.ad_usd = c;
      else if (/적용환율|汇率/.test(t) && !map.rate) map.rate = c;
      else if (/매출액/.test(t) && !map.net_krw) map.net_krw = c;
      else if (/출고원가|成本原价/.test(t) && !map.cogs_krw) map.cogs_krw = c;
      else if (/영업이익|利润$|利润\//.test(t) && !map.profit_krw) map.profit_krw = c;
      else if (/이익율|利润率/.test(t) && !map.margin) map.margin = c;
      else if (/기말재고|期末库存/.test(t) && !map.ending_inventory_krw) map.ending_inventory_krw = c;
    }
    // 原价率通常在 cogs 与 profit 之间
    if (map.cogs_krw && !map.cost_rate) map.cost_rate = map.cogs_krw + 1;
    // 必备字段校验
    const need = ['gmv_cny', 'refund_cny', 'net_cny', 'rate', 'net_krw', 'cogs_krw', 'profit_krw', 'margin'];
    if (need.every(k => map[k])) return map;
    return null;
  }

  // ---- 提取 summary 历史 ----
  function extractHistory(ws, map, negateFee) {
    const rows = [];
    const mr = maxRow(ws);
    for (let r = 5; r <= mr; r++) {
      const label = cs(ws, r, 2);
      if (!label) continue;
      const m = label.match(/(20\d{2})[.\-\/년]\s*(\d{1,2})/);
      if (!m) continue;
      const key = m[1] + '.' + String(parseInt(m[2], 10)).padStart(2, '0');
      const row = { month: key };
      for (const k of Object.keys(SUM_FALLBACK.deepte)) row[k] = num(cv(ws, r, map[k] || 0));
      if (negateFee) { row.fee_cny = -Math.abs(row.fee_cny); row.fee_usd = -Math.abs(row.fee_usd); }
      rows.push(row);
    }
    return rows;
  }

  // ---- 피벗 (SKU) 动态解析 ----
  function extractPivot(wb) {
    const sn = findSheet(wb, [/피벗/, 'pivot']);
    if (!sn) return [];
    const ws = wb.Sheets[sn];
    // 表头行: 含 "품번" 且含 "수량|실매출" 的行
    let hr = 0, cols = {};
    for (let r = 1; r <= 10 && !hr; r++) {
      const labels = {};
      for (let c = 1; c <= 20; c++) { const t = cs(ws, r, c); if (t) labels[c] = t; }
      const txt = Object.values(labels).join('|');
      if (/품번/.test(txt) && /정산수량|실매출/.test(txt)) {
        hr = r;
        for (const [c, t] of Object.entries(labels)) {
          const ci = +c;
          if (/정산수량/.test(t) && !cols.qty) cols.qty = ci;
          else if (/실매출/.test(t) && !cols.sales_cny) cols.sales_cny = ci;
          else if (/^비율$/.test(t) && !cols.ratio) cols.ratio = ci;
          else if (/^품번$/.test(t) && !cols.sku) cols.sku = ci;
          else if (/usd\s*총/i.test(t) && !cols.usd_total) cols.usd_total = ci;
          else if (/usd\s*단가/i.test(t) && !cols.usd_unit) cols.usd_unit = ci;
          else if (/^원가$/.test(t) && !cols.cost) cols.cost = ci;
          else if (/수익율/.test(t) && !cols.margin) cols.margin = ci;
          else if (/^수익$/.test(t) && !cols.profit) cols.profit = ci;
          else if (/제품명|^이름$/.test(t) && !cols.name) cols.name = ci;
          else if (/^1[0-9]{3}(\.\d+)?$/.test(t) && !cols.krw) cols.krw = ci; // 表头是汇率数字的列 = KRW合计
        }
      }
    }
    if (!hr || !cols.sku || !cols.qty) return [];
    const out = [];
    const mr = maxRow(ws);
    for (let r = hr + 1; r <= mr; r++) {
      const first = cs(ws, r, 1);
      if (first && first.includes('总')) break;
      const sku = skuKey(cs(ws, r, cols.sku));
      const qty = num(cv(ws, r, cols.qty));
      if (!sku || !qty) continue;
      out.push({
        sku_code: sku,
        name: cols.name ? cs(ws, r, cols.name).trim() : '',
        qty, sales_cny: num(cv(ws, r, cols.sales_cny)),
        ratio: num(cv(ws, r, cols.ratio)),
        usd_total: num(cv(ws, r, cols.usd_total)),
        usd_unit: num(cv(ws, r, cols.usd_unit)),
        cost_krw_per: num(cv(ws, r, cols.cost)),
        krw_total: num(cv(ws, r, cols.krw)),
        profit_krw: num(cv(ws, r, cols.profit)),
        margin: num(cv(ws, r, cols.margin)),
      });
    }
    return out;
  }

  // ---- 재고현황 (库存) 动态解析 ----
  function extractInventory(wb) {
    const sn = findSheet(wb, ['재고현황', '库存']);
    if (!sn) return [];
    const ws = wb.Sheets[sn];
    // 表头行 = 3 (实测稳定); 动态定位各列
    const hr = 3, cols = {};
    const mc = Math.min(maxCol(ws), 32);
    const labels = {};
    // 表头标签内含换行符, 统一替换为 / 再做关键词匹配
    for (let c = 1; c <= mc; c++) { const t = cs(ws, hr, c).replace(/\n/g, '/').trim(); if (t) labels[c] = t; }
    for (const [c, t] of Object.entries(labels)) {
      const ci = +c;
      if (/^품번$/.test(t) && !cols.sku) cols.sku = ci;
      else if (/^단가$/.test(t) && !cols.cost) cols.cost = ci;
      else if (/\(한\)|（한）/.test(t) && !cols.name) cols.name = ci;            // 韩文名
      else if (/货品名称\(중\)|货品名称（중）|货品名称\(中\)/.test(t) && !cols.name_cn) cols.name_cn = ci; // 中文名(明确중/中)
      else if (/货品名称/.test(t) && !cols.name_fb) cols.name_fb = ci;          // 通用货品名称(兜底)
      else if (/品牌|브랜드/.test(t) && !cols.brand) cols.brand = ci;            // 品牌
      else if (/货品编码|바코드|条形?码|条码/.test(t) && !cols.barcode) cols.barcode = ci; // 条形码
      else if (/더존|기초\//.test(t) && !cols.opening) cols.opening = ci;
      else if (/정산수량/.test(t) && !cols.sales) cols.sales = ci;
    }
    // 期末件数: 标签含 기말재고/期末库存 且列号 > sales 列的第一个
    for (const [c, t] of Object.entries(labels)) {
      const ci = +c;
      if (/기말재고\/期末库存/.test(t) && ci > (cols.sales || 0) && !cols.ending) cols.ending = ci;
    }
    // 期末金额: 含 期末库存金额 且列号 > ending 列的第一个; 没有则现算
    for (const [c, t] of Object.entries(labels)) {
      const ci = +c;
      if (/期末库存金额/.test(t) && ci > (cols.ending || 0) && !cols.endingVal) cols.endingVal = ci;
    }
    if (!cols.sku || !cols.ending) return [];
    const out = [];
    const mr = Math.min(maxRow(ws), 320);
    for (let r = hr + 1; r <= mr; r++) {
      const code = cv(ws, r, cols.sku);
      if (typeof code !== 'string') continue;
      const sku = code.trim();
      if (!sku || ['품번', '합계', '总计'].includes(sku)) continue;
      const cost = num(cv(ws, r, cols.cost));
      const opening = num(cv(ws, r, cols.opening));
      const sales = num(cv(ws, r, cols.sales));
      const ending = num(cv(ws, r, cols.ending));
      if (!opening && !sales && !ending) continue;
      const endingVal = cols.endingVal ? num(cv(ws, r, cols.endingVal)) : ending * cost;
      const nameKr = (cs(ws, r, cols.name) || '').trim();
      const nameCn = (cs(ws, r, cols.name_cn) || cs(ws, r, cols.name_fb) || '').trim();
      const nm = nameKr || nameCn || sku;
      out.push({
        sku_code: skuKey(sku), name_kr: nm.slice(0, 40),
        name_cn: nameCn.slice(0, 40), brand: (cs(ws, r, cols.brand) || '').trim(),
        barcode: (cs(ws, r, cols.barcode) || '').trim(),
        unit_cost: cost, opening_qty: opening, sales_qty: sales, ending_qty: ending, ending_value_krw: endingVal,
      });
    }
    return out;
  }

  // ---- 콰이쇼우 (快手) 专用解析 ----
  function parseKuaishou(wb, filename) {
    const tn = wb.SheetNames.find(n => n.trim() === 'TTL');
    const history = [];
    if (tn) {
      const ws = wb.Sheets[tn];
      const mr = maxRow(ws);
      for (let r = 5; r <= mr; r++) {
        const m = cs(ws, r, 2).trim();
        if (!/^\d{2}\.\d{2}$/.test(m)) continue;
        history.push({
          month: '20' + m, cny: num(cv(ws, r, 3)), usd: num(cv(ws, r, 4)),
          fee_usd: num(cv(ws, r, 6)), final_usd: num(cv(ws, r, 7)),
          rate: num(cv(ws, r, 12)), krw: num(cv(ws, r, 13)), final_krw: num(cv(ws, r, 14)),
          date: cs(ws, r, 10),
        });
      }
    }
    // summary P&L 块: 找 "매출액/实际卖出" 行, 数据在 +2 行
    let settle = null;
    const sn = findSheet(wb, ['summary']);
    if (sn) {
      const ws = wb.Sheets[sn];
      const mr = maxRow(ws);
      for (let r = 1; r <= mr; r++) {
        if (/매출액/.test(cs(ws, r, 2)) && /실际卖出|实际卖出/.test(cs(ws, r, 2))) {
          settle = {
            sales_krw: num(cv(ws, r + 2, 2)), cogs_krw: num(cv(ws, r + 2, 3)),
            cost_rate: num(cv(ws, r + 2, 4)), expense_krw: num(cv(ws, r + 2, 5)),
            profit_krw: num(cv(ws, r + 2, 6)), margin: num(cv(ws, r + 2, 7)),
            qty: num(cv(ws, r + 2, 8)),
          };
          break;
        }
      }
    }
    const month = detectMonth(filename) || (history.length ? history[history.length - 1].month : null);
    return { store: 'kuaishou', type: 'kuaishou', month, history, settle, src: filename };
  }

  // ---- QA 完整性校验 ----
  function runQA(row, skus, inventory) {
    const issues = [];
    if (!row) return ['未找到本文件对应月份的 summary 行'];
    if (row.net_usd && row.rate && row.net_krw) {
      const dev = Math.abs(row.net_usd * row.rate - row.net_krw) / Math.abs(row.net_krw);
      if (dev > 0.01) issues.push(`净销售KRW换算偏差 ${(dev * 100).toFixed(1)}%`);
    }
    if (row.net_krw && row.profit_krw) {
      const calc = row.net_krw - row.cogs_krw + row.fee_usd * row.rate;
      const dev = Math.abs(calc - row.profit_krw) / Math.max(Math.abs(row.profit_krw), 1);
      if (dev > 0.01) issues.push(`利润公式回算偏差 ${(dev * 100).toFixed(1)}% (列映射可能有变,请人工复核)`);
    }
    if (skus.length && row.net_usd) {
      const s = skus.reduce((a, b) => a + b.usd_total, 0);
      const dev = Math.abs(s - row.net_usd) / Math.abs(row.net_usd);
      if (dev > 0.03) issues.push(`SKU加总(${s.toFixed(0)} USD) vs 净销售(${row.net_usd.toFixed(0)}) 偏差 ${(dev * 100).toFixed(1)}%`);
    }
    if (inventory.length && row.ending_inventory_krw) {
      const s = inventory.reduce((a, b) => a + b.ending_value_krw, 0);
      const dev = Math.abs(s - row.ending_inventory_krw) / Math.abs(row.ending_inventory_krw);
      if (dev > 0.03) issues.push(`库存明细加总 vs 期末库存 偏差 ${(dev * 100).toFixed(1)}%`);
    }
    return issues;
  }

  // ---- 主入口: 解析单个文件 ----
  // 返回 { store, month, summaryRows:[…全部历史月], detail:{skus,inventory}, qa:[], kuaishou? }
  function parseFile(filename, arrayBuffer, opts = {}) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const ledger = parseStockLedgerWorkbook(wb, filename);
    if (ledger) return ledger;
    const ca = parseCostAnalysisWorkbook(wb, filename);
    if (ca) return ca;
    const pm = parseProductMaster(wb, filename);
    if (pm) return pm;
    const im = parseInventoryMonthly(wb, filename, opts);
    if (im) return im;
    const store = detectStore(filename, wb);
    if (!store) throw new Error('无法识别店铺(文件名/表头均不匹配): ' + filename);
    if (store === 'kuaishou') return parseKuaishou(wb, filename);

    const sn = findSheet(wb, ['summary', 'TTL']);
    if (!sn) throw new Error('未找到 summary/TTL sheet');
    const ws = wb.Sheets[sn];
    let map = detectSummaryMap(ws);
    let mapSource = 'dynamic';
    if (!map) { map = SUM_FALLBACK[store]; mapSource = 'fallback'; }
    if (!map) throw new Error('summary 列结构无法识别');

    const negateFee = store === 'jingya';
    const summaryRows = extractHistory(ws, map, negateFee);
    if (!summaryRows.length) throw new Error('summary 中未解析到任何月份行');

    let month = detectMonth(filename);
    if (!month) month = summaryRows[summaryRows.length - 1].month;

    const skus = extractPivot(wb);
    const inventory = extractInventory(wb);
    const own = summaryRows.find(r => r.month === month) || null;
    const qa = runQA(own, skus, inventory);

    return { store, month, summaryRows, detail: { skus, inventory }, qa, mapSource, src: filename, type: 'pdd' };
  }

  global.CDBI_PARSER = { parseFile, STORE_META, detectStore, detectMonth, PARSER_VERSION };
})(window);
