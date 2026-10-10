#!/usr/bin/env node
/**
 * 格物 · 爱发电订单对账与码池存量
 *
 * ---------------------------------------------------------------------------
 * 这个工具解决什么问题
 *
 *   爱发电的自动发货没有回调可靠性保证（官方原话：服务器异常时不保证及时推送），
 *   而格物的授权码是离线签名、App 内验签 —— 没有服务端，也就没有「谁激活了」的回抛。
 *   于是**唯一能把账对平的两个数**是：
 *       线上池子里还剩多少枚码   ×   线上已经卖出多少件
 *   池子见底还在卖 = 买家付了钱收不到码。这就是本工具存在的全部理由。
 *
 * ---------------------------------------------------------------------------
 * 用到的三个接口（POST https://ifdian.net，JSON 表单，签名见下）
 *
 *   /api/open/ping                 连通性 + 签名自检（第一次配置完先跑这个）
 *   /api/open/query-plan           读方案/商品：型号里的 reply_random_content **就是当前码池全文**
 *   /api/open/query-order          按页倒序拉订单：status=2 为交易成功，sku_detail[].count 为件数
 *   /api/open/query-random-reply   按订单号查「这单实际发出去的那枚码」（客服用）
 *   /api/open/update-plan-reply    追加码池（restock 用。★ 见下方红线）
 *
 *   签名：sign = md5(token + 'params' + <params原串> + 'ts' + <ts> + 'user_id' + <userId>)
 *         token 只参与签名，**不随请求发送**。params 必须是「发送出去的那一串」，
 *         所以本工具先 JSON.stringify 一次、签它、再原样发送，绝不让两处各序列化一遍。
 *   user_id / token 在 https://ifdian.net/dashboard/dev 生成。
 *
 * ---------------------------------------------------------------------------
 * 红线（这些不是建议，是硬约束）
 *
 *   ★★ `update_random_reply_type` 只允许 `append`。`overwrite` 会把整个码池换掉 ——
 *      池子里**尚未卖出**的码全部作废且不可恢复。本工具永远不会传 overwrite。
 *   ★★ restock 默认是演练（dry-run），必须显式加 `--yes` 才真写线上。
 *   ★★ append 之前先拉一次线上池子：若新签的码里已有任何一枚在池中，说明上一次追加
 *      其实成功了（只是响应丢了）—— 立刻停手，绝不重复追加。
 *   ★★ token 只从 `~/.gewu/afdian.json`（600 权限）或环境变量读，**任何输出里都不打印它**。
 *   ★★ 本机 `http_proxy/https_proxy` 环境变量指向的代理常常是死的（曾经 7586，现为 10808 SOCKS）。
 *      因此**刻意不自动采信环境变量**：要过代理请显式 `--proxy socks5://127.0.0.1:10808`
 *      或设 `GEWU_HTTPS_PROXY`。默认直连。
 *
 * ---------------------------------------------------------------------------
 * 子命令
 *   init --user-id U --token T --plan-id P --sku-id S [--price 36] [--channel afdian]
 *   init --show                             看一眼当前配置（token 打码）
 *   ping                                    连通性 + 签名自检
 *   status [--json] [--max-pages 50]        只读对账：池存量 × 已售 × 台账 × 批次清单
 *   who --order 20261010123456789           这单实际发出去的是哪枚码、属于哪个批次
 *   restock [--count 50] [--batch X] [--yes] 签一批新码并**追加**进线上码池
 *
 * 配置：~/.gewu/afdian.json（600）｜ 环境变量 AFDIAN_USER_ID / AFDIAN_TOKEN / AFDIAN_PLAN_ID / AFDIAN_SKU_ID 可覆盖
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

import {
  HOME_DIR,
  parseArgs,
  readKeyFile,
  readLedger,
  appendLedger,
  verifyCode,
  todayLocal,
} from './license.mjs';

import {
  BATCH_DIR,
  listManifests,
  planSubjects,
  buildBatchEntries,
  summarizeBatch,
  buildManifest,
  writeBatchFiles,
  validateNaming,
  batchKey,
  codesText,
  findGitRoot,
} from './license-batch.mjs';

export const AFDIAN_API = 'https://ifdian.net';
export const CONFIG_FILE = path.join(HOME_DIR, 'afdian.json');
export const CONFIG_VERSION = 1;

/** 订单状态：官方文档「status 2 为交易成功。目前仅会推送此类型」。 */
export const STATUS_PAID = 2;

/** 池子低于这个数就该补货了。 */
export const DEFAULT_LOW_WATER = 10;
export const DEFAULT_RESTOCK_SIZE = 50;

/* ==================== 纯函数（可测） ==================== */

/**
 * 官方给出的签名规则，原文：
 *   sign = md5({token}params{params}ts{ts}user_id{user_id})
 * 官方文档里的样例（token 123 / params {"a":333} / ts 1624339905 / user_id abc
 * → a4acc28b81598b7e5d84ebdc3e91710c）就是本函数的测试向量。
 */
export function afdianSign(token, paramsString, ts, userId) {
  const kv = `params${paramsString}ts${ts}user_id${userId}`;
  return crypto.createHash('md5').update(String(token) + kv, 'utf8').digest('hex');
}

/** 组请求体。params 串只在这里序列化一次，签名与发送用的是同一串字节。 */
export function signedBody({ token, userId, params, ts }) {
  const paramsString = JSON.stringify(params ?? {});
  return {
    user_id: userId,
    params: paramsString,
    ts,
    sign: afdianSign(token, paramsString, ts, userId),
  };
}

/** 拆响应信封。ec !== 200 一律当失败 —— 别把平台错误码当成「没有数据」。 */
export function readEnvelope(text) {
  let json;
  try {
    json = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, reason: 'not-json', sample: String(text ?? '').slice(0, 200) };
  }
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not-json', sample: String(text ?? '').slice(0, 200) };
  const ec = Number(json.ec);
  if (ec !== 200) return { ok: false, reason: 'ec', ec, em: String(json.em ?? ''), data: json.data };
  return { ok: true, data: json.data ?? {} };
}

export function explainEc(ec) {
  switch (Number(ec)) {
    case 400001:
      return 'params 不完整';
    case 400002:
      return 'ts 过期（本地时钟偏差超过 1 小时？对一下时间）';
    case 400003:
      return 'params 不是合法 JSON';
    case 400004:
      return '没有有效的 token（去 https://ifdian.net/dashboard/dev 生成）';
    case 400005:
      return '签名校验失败（token 抄错了？）';
    default:
      return '未知错误码';
  }
}

/**
 * 一枚码的「真身」：载荷段 base32 大小写是同一份数据，签名段 base64url 大小写敏感。
 * 去重、比对池内容一律走它 —— 直接用整串比会把同一个码的两行当成两枚。
 */
export function codeKeyOf(code) {
  const match = /^GW1-([A-Za-z2-7]+)\.([A-Za-z0-9_-]+)$/i.exec(String(code ?? '').trim());
  return match ? `${match[1].toUpperCase()}.${match[2]}` : String(code ?? '').trim();
}

/**
 * 解析码池全文 → 结构化。
 *   · 剥掉所有空白（粘进来常常带换行/空格）
 *   · 去重走 codeKeyOf（见上）
 *   · 形状不合的行进 malformed，不静默丢弃 —— 池子里有脏行是要报出来的
 */
export function parsePool(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const codes = [];
  const duplicates = [];
  const malformed = [];
  const seen = new Set();

  for (const line of lines) {
    const bare = line.replace(/\s+/g, '');
    if (!/^GW1-[A-Za-z2-7]+\.[A-Za-z0-9_-]+$/i.test(bare)) {
      malformed.push(line);
      continue;
    }
    const key = codeKeyOf(bare);
    if (seen.has(key)) {
      duplicates.push(bare);
      continue;
    }
    seen.add(key);
    codes.push(bare);
  }

  return { codes, duplicates, malformed, lines: lines.length };
}

/**
 * 这次要签的码里，有哪些已经在线上池子里了。
 * 用来拦「上一次追加其实成功了、只是响应丢了」的重复追加 —— 追加不能重放。
 */
export function overlapWithPool(entries, poolCodes) {
  const keys = new Set((poolCodes ?? []).map(codeKeyOf));
  return (entries ?? []).filter((entry) => keys.has(codeKeyOf(entry.code)));
}

/**
 * 池子里的码逐枚验签：哪些是本机私钥签出去的、哪些不是。
 * 池子里混进陌生码 = 买到那枚码的人**打不开**（公钥验不过），是硬伤，必须报出来。
 */
export function classifyPool(codes, publicKeyB64Url) {
  const valid = [];
  const foreign = [];
  for (const code of codes ?? []) {
    const result = publicKeyB64Url ? verifyCode(code, publicKeyB64Url) : { ok: false, reason: 'key' };
    if (result.ok) {
      valid.push({ code, serial: result.payload.n, subject: result.payload.e, date: result.payload.d });
    } else {
      foreign.push({ code, reason: result.reason });
    }
  }
  return { valid, foreign };
}

/**
 * 统计已售件数。status=2 才算成交；planId/skuId 都配了就以它们为准。
 * 分不出归属的订单单独计数，别混进总额里（宁可少算，也不要虚报库存消耗）。
 */
export function countSold(orders, { planId, skuId } = {}) {
  const out = {
    orderCount: 0,
    units: 0,
    skippedStatus: 0,
    skippedPlan: 0,
    skippedSku: 0,
    noSkuDetail: 0,
  };
  for (const order of orders ?? []) {
    if (!order || Number(order.status) !== STATUS_PAID) {
      out.skippedStatus++;
      continue;
    }
    if (planId && order.plan_id && order.plan_id !== planId) {
      out.skippedPlan++;
      continue;
    }
    const skus = Array.isArray(order.sku_detail) ? order.sku_detail : [];
    if (skuId) {
      const hit = skus.filter((sku) => sku && sku.sku_id === skuId);
      if (!hit.length) {
        if (!skus.length) out.noSkuDetail++;
        else out.skippedSku++;
        continue;
      }
      out.units += hit.reduce((acc, sku) => acc + Math.max(1, Number(sku.count) || 1), 0);
      out.orderCount++;
      continue;
    }
    if (!skus.length) {
      out.noSkuDetail++;
      continue;
    }
    out.units += skus.reduce((acc, sku) => acc + Math.max(1, Number(sku.count) || 1), 0);
    out.orderCount++;
  }
  return out;
}

/**
 * 对账核心（纯函数）。
 *
 *   池子里的码         = 还没卖出去、随时会被发出去的
 *   台账签发总数 − 池子 = 已经被发出去的（假设每一批都粘进了同一个池子）
 *   已售件数           = 平台说的卖了几件
 *
 *   前两者应当相等。不相等就是「有码不知去向」或「有单没拿到码」——
 *   这两种情况下都会有人付了钱打不开 App，所以必须报出来，不能自欺欺人地取个平均。
 */
export function reconcile({
  poolCodes = [],
  foreignCodes = [],
  poolMalformed = [],
  poolDuplicates = [],
  manifestCodes = [],
  ledgerEntries = [],
  sold = { units: 0, orderCount: 0 },
  lowWater = DEFAULT_LOW_WATER,
  restockSize = DEFAULT_RESTOCK_SIZE,
} = {}) {
  const poolSet = new Set(poolCodes);
  const manifestSet = new Set(manifestCodes);

  const missingFromPool = manifestCodes.filter((code) => !poolSet.has(code));
  const unexpectedInPool = poolCodes.filter((code) => !manifestSet.has(code));

  const issuedTotal = (ledgerEntries ?? []).length;
  const manifestTotal = (manifestCodes ?? []).length;
  const consumed = issuedTotal - poolCodes.length;
  // 只按「粘进来过的批次」算：台账里可能还有别的渠道/别批次的码，不该算到这个池子头上
  const expectedConsumed = manifestTotal - poolCodes.length;
  const drift = expectedConsumed - (sold.units ?? 0);

  const notes = [];
  let level = 'ok';

  if (foreignCodes.length) {
    level = 'alert';
    notes.push(`⚠ 池子里有 ${foreignCodes.length} 枚**不是本机私钥签发的码** —— 买到它们的人激活会失败，立刻删掉。`);
  }
  if (!poolCodes.length) {
    level = 'alert';
    notes.push('⚠ 池子是空的 —— 现在还在卖的话，买家付了钱收不到码。立刻补货。');
  }
  if (drift !== 0 && poolCodes.length) {
    if (level === 'ok') level = 'warn';
    notes.push(
      drift > 0
        ? `· 从池子里消失的码比卖出的件数多 ${drift} 枚 —— 有人手工删过池内容，或者有订单没成交（退款/未支付）却被算进去了。`
        : `· 卖出的件数比从池子里消失的码多 ${-drift} 枚 —— 有订单可能没拿到码，或池子被覆盖过（overwrite）。翻一下这批订单。`,
    );
  }
  if (unexpectedInPool.length && level === 'ok') {
    level = 'warn';
    notes.push(`· 池子里有 ${unexpectedInPool.length} 枚不在本机批次清单里 —— 手工加的？还是别的机器签的？（清单只在本机，换过机器就会出现这种差异）`);
  }
  if (poolMalformed.length && level === 'ok') {
    level = 'warn';
    notes.push(`· 池子里有 ${poolMalformed.length} 行看不懂的内容 —— 买家拿到这种行是没法激活的。`);
  }
  if (!notes.length && poolCodes.length > lowWater) {
    notes.push('没有异常。');
  }
  if (poolCodes.length && poolCodes.length <= lowWater) {
    if (level === 'ok') level = 'warn';
    notes.push(`· 池子只剩 ${poolCodes.length} 枚（水位 ${lowWater}）—— 建议补 ${restockSize} 枚。`);
  }

  return {
    poolCount: poolCodes.length,
    poolDuplicates: poolDuplicates.length,
    poolMalformed: poolMalformed.length,
    foreignCount: foreignCodes.length,
    issuedTotal,
    manifestTotal,
    soldOrders: sold.orderCount ?? 0,
    soldUnits: sold.units ?? 0,
    consumed,
    expectedConsumed,
    drift,
    missingFromPoolCount: missingFromPool.length,
    unexpectedInPoolCount: unexpectedInPool.length,
    missingFromPool,
    unexpectedInPool,
    lowWater,
    restockSize,
    level,
    notes,
  };
}

/** 把对账结果排版成给人看的一段。 */
export function formatReconcile(report, { batchLabel = '(本机全部批次)' } = {}) {
  const lines = [];
  lines.push('对账');
  lines.push(`  线上池存量\t\t${report.poolCount} 枚`);
  lines.push(`  线上已售\t\t${report.soldUnits} 件（${report.soldOrders} 笔订单）`);
  lines.push(`  台账签发\t\t${report.issuedTotal} 枚（全部渠道）`);
  lines.push(`  本机批次清单\t${report.manifestTotal} 枚  ${batchLabel}`);
  lines.push(`  本批已消耗\t\t${report.expectedConsumed} 枚（清单 − 池子）`);
  if (report.poolDuplicates) lines.push(`  池内重复行\t\t${report.poolDuplicates} 行（去重后计数）`);
  if (report.poolMalformed) lines.push(`  池内脏行\t\t${report.poolMalformed} 行`);
  if (report.foreignCount) lines.push(`  非本机签发的码\t${report.foreignCount} 枚  ⚠`);
  lines.push('');
  lines.push('结论');
  for (const note of report.notes) lines.push(`  ${note}`);
  return lines.join('\n');
}

/* ==================== 网络层（可选代理） ==================== */

/** 解析代理串。刻意不读 http_proxy/https_proxy —— 本机那两个环境变量指向的代理已经死了。 */
export function resolveProxy(flags) {
  if (typeof flags.proxy === 'string' && flags.proxy) {
    return flags.proxy === 'direct' ? null : flags.proxy;
  }
  if (process.env.GEWU_HTTPS_PROXY) return process.env.GEWU_HTTPS_PROXY;
  return null;
}

function splitProxy(proxyUrl) {
  const match = /^(?<scheme>[A-Za-z0-9+.-]+):\/\/(?:[^@/]*@)?(?<host>\[[^\]]+\]|[^:/?#]+)(?::(?<port>\d+))?/.exec(String(proxyUrl));
  if (!match) throw new Error(`看不懂的代理地址：${proxyUrl}（形如 http://127.0.0.1:7890 或 socks5://127.0.0.1:10808）`);
  const scheme = match.groups.scheme.toLowerCase();
  const host = match.groups.host.replace(/^\[|\]$/g, '');
  const port = match.groups.port ? Number(match.groups.port) : scheme.startsWith('socks') ? 1080 : 80;
  return { scheme, host, port };
}

/** HTTP 代理的 CONNECT 隧道。 */
function httpConnectTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const status = Number(buffer.slice(0, buffer.indexOf('\r\n')).split(' ')[1]);
      if (status !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 被拒：HTTP ${status}`));
        return;
      }
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/** SOCKS5 隧道（atyp=3，域名交给代理远端解析 —— 本机 DNS 不可信）。 */
function socks5Tunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    socket.once('error', reject);
    let stage = 0;
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) {
          socket.destroy();
          reject(new Error('SOCKS5 握手失败（代理不支持无认证）'));
          return;
        }
        buffer = buffer.subarray(2);
        stage = 1;
        const hostBytes = Buffer.from(host, 'utf8');
        socket.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, hostBytes.length]),
            hostBytes,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ]),
        );
        if (!buffer.length) return;
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0) {
          socket.destroy();
          reject(new Error(`SOCKS5 连接失败：rep=${buffer[1]}`));
          return;
        }
        const atyp = buffer[3];
        const need = atyp === 1 ? 10 : atyp === 4 ? 22 : 5 + buffer[4] + 2;
        if (buffer.length < need) return;
        socket.removeListener('data', onData);
        socket.removeListener('error', reject);
        const extra = buffer.subarray(need);
        if (extra.length) socket.unshift(extra);
        resolve(socket);
      }
    };

    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', onData);
  });
}

async function openTunnel(proxyUrl, host, port) {
  const proxy = splitProxy(proxyUrl);
  if (proxy.scheme.startsWith('socks')) return socks5Tunnel(proxy, host, port);
  return httpConnectTunnel(proxy, host, port);
}

/** POST 一段 JSON，返回响应正文。直连走 fetch；要过代理就自己建隧道。 */
export async function postJson(url, body, { proxy = null, timeout = 20000 } = {}) {
  const payload = JSON.stringify(body);
  const target = new URL(url);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'user-agent': 'gewu-afdian-stock/1.0',
  };

  if (!proxy) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal });
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const raw = await openTunnel(proxy, target.hostname, Number(target.port || 443));
  const secure = tls.connect({ socket: raw, servername: target.hostname });
  await once(secure, 'secureConnect');

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: target.hostname,
        port: Number(target.port || 443),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers,
        agent: new https.Agent({ keepAlive: false, createConnection: () => secure }),
        timeout,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => resolve(data));
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('请求超时（20s）')));
    request.end(payload);
  });
}

/**
 * 传输层接缝。测试把它换成一个假的，就能离线把 status / restock 整条链子跑穿 ——
 * 网络调用不该是「唯一没被测试覆盖的那段」。
 */
let transport = postJson;

export function setTransport(fn) {
  transport = fn ?? postJson;
}

async function callApi(pathname, params, config, options = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const body = signedBody({ token: config.token, userId: config.userId, params, ts });
  const text = await transport(`${AFDIAN_API}${pathname}`, body, options);
  const envelope = readEnvelope(text);
  if (!envelope.ok && envelope.reason === 'ec') {
    throw new Error(`${pathname} 失败：ec=${envelope.ec} ${envelope.em}（${explainEc(envelope.ec)}）`);
  }
  if (!envelope.ok) {
    throw new Error(`${pathname} 返回的不是 JSON：${envelope.sample}`);
  }
  return envelope.data;
}

/* ==================== 配置 ==================== */

export function loadConfig(explicitPath) {
  const file = explicitPath ? path.resolve(explicitPath) : CONFIG_FILE;
  let stored = {};
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
    } catch {
      stored = {};
    }
  }
  const config = {
    userId: process.env.AFDIAN_USER_ID || stored.userId || '',
    token: process.env.AFDIAN_TOKEN || stored.token || '',
    planId: process.env.AFDIAN_PLAN_ID || stored.planId || '',
    skuId: process.env.AFDIAN_SKU_ID || stored.skuId || '',
    channel: stored.channel || 'afdian',
    price: stored.price ?? '',
    lowWater: Number.isFinite(stored.lowWater) ? stored.lowWater : DEFAULT_LOW_WATER,
    restockSize: Number.isFinite(stored.restockSize) ? stored.restockSize : DEFAULT_RESTOCK_SIZE,
    file,
  };
  return config;
}

export function saveConfig(config) {
  const file = config.file || CONFIG_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = {
    v: CONFIG_VERSION,
    userId: config.userId,
    token: config.token,
    planId: config.planId,
    skuId: config.skuId,
    channel: config.channel || 'afdian',
    price: config.price ?? '',
    lowWater: config.lowWater,
    restockSize: config.restockSize,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** token 打码：前 3 后 3，中间一律星号。任何输出都走它。 */
export function maskToken(token) {
  const text = String(token ?? '');
  if (!text) return '(未配置)';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 3)}${'*'.repeat(Math.min(12, text.length - 6))}${text.slice(-3)}`;
}

export function requireCredentials(config) {
  if (!config.userId || !config.token) {
    console.error(`缺少 user_id / token。去 https://ifdian.net/dashboard/dev 生成，然后跑：`);
    console.error('  node tools/afdian-stock.mjs init --user-id U --token T --plan-id P --sku-id S');
    console.error(`（配置文件：${config.file}）`);
    return false;
  }
  return true;
}

/* ==================== 子命令 ==================== */

const HELP = `格物 · 爱发电订单对账与码池存量

  配置
    node tools/afdian-stock.mjs init --user-id U --token T --plan-id P --sku-id S [--price 36]
    node tools/afdian-stock.mjs init --show

  查
    node tools/afdian-stock.mjs ping                    连通性 + 签名自检
    node tools/afdian-stock.mjs status [--json]         只读对账（默认，什么都不会改）
    node tools/afdian-stock.mjs who --order <订单号>    这单实际发出去的是哪枚码

  补货（默认演练，加 --yes 才真写）
    node tools/afdian-stock.mjs restock --count 50
    node tools/afdian-stock.mjs restock --count 50 --yes

通用开关：--proxy socks5://127.0.0.1:10808 ｜ --proxy direct ｜ --config <路径> ｜ --max-pages 50`;

function cmdInit(flags) {
  const config = loadConfig(typeof flags.config === 'string' ? flags.config : undefined);

  if (flags.show) {
    console.log(`配置：${config.file}${fs.existsSync(config.file) ? '' : '（还没有这个文件）'}`);
    console.log(`  user_id\t${config.userId || '(未配置)'}`);
    console.log(`  token\t\t${maskToken(config.token)}`);
    console.log(`  plan_id\t${config.planId || '(未配置)'}`);
    console.log(`  sku_id\t${config.skuId || '(未配置)'}`);
    console.log(`  渠道\t\t${config.channel}`);
    console.log(`  售价\t\t${config.price || '(未配置)'}`);
    console.log(`  水位/补货\t${config.lowWater} / ${config.restockSize}`);
    return;
  }

  const next = { ...config };
  for (const [flag, key] of [
    ['user-id', 'userId'],
    ['token', 'token'],
    ['plan-id', 'planId'],
    ['sku-id', 'skuId'],
    ['channel', 'channel'],
  ]) {
    if (typeof flags[flag] === 'string') next[key] = flags[flag];
  }
  if (typeof flags.price === 'string') next.price = flags.price;
  if (flags['low-water'] !== undefined) next.lowWater = Number.parseInt(String(flags['low-water']), 10);
  if (flags['restock-size'] !== undefined) next.restockSize = Number.parseInt(String(flags['restock-size']), 10);

  const file = saveConfig(next);
  console.log(`已写入：${file}（权限 600）`);
  console.log(`  user_id\t${next.userId || '(未配置)'}`);
  console.log(`  token\t\t${maskToken(next.token)}`);
  console.log(`  plan_id\t${next.planId || '(未配置)'}`);
  console.log(`  sku_id\t${next.skuId || '(未配置)'}`);
  console.log('\n下一步：跑 `node tools/afdian-stock.mjs ping` 验签名与连通性。');
}

async function cmdPing(flags, config) {
  if (!requireCredentials(config)) {
    process.exitCode = 1;
    return;
  }
  const proxy = resolveProxy(flags);
  console.log(`目标\t${AFDIAN_API}/api/open/ping`);
  console.log(`代理\t${proxy ?? '直连'}`);
  try {
    // ★ 实测：ping 传空 params（`{}`）会被平台判成 400003「params was not valid json string」——
    //   它那边的判据像是「解析后为空即非法」。所以这里塞一个无害的键，别用 {}。
    const data = await callApi('/api/open/ping', { ping: 1 }, config, { proxy });
    console.log('签名通过 ✓');
    if (data?.uid) console.log(`uid\t${data.uid}`);
    if (config.userId && data?.uid && data.uid !== config.userId) {
      console.log(`★ 注意：返回的 uid 与配置里的 user_id 不一致 —— 配置可能抄错了。`);
    }
  } catch (error) {
    console.error(`失败：${error.message}`);
    console.error('\n排查顺序：');
    console.error('  ① 直连不通？试 `--proxy socks5://127.0.0.1:10808`（本机代理端口）');
    console.error('  ② ec=400005 → token 抄错了；ec=400004 → 还没在开发者后台生成 token');
    console.error('  ③ ec=400002 → 本机时钟偏差超过 1 小时，对一下时间');
    process.exitCode = 1;
  }
}

/** 拉全量订单（按页倒序）。maxPages 只是保险丝，不是分页上限。 */
async function fetchAllOrders(config, options) {
  const perPage = 100;
  const maxPages = Math.max(1, Number.parseInt(String(options.maxPages ?? 50), 10) || 50);
  const orders = [];
  let page = 1;
  let totalPages = 1;
  let totalCount = 0;

  while (page <= totalPages && page <= maxPages) {
    const data = await callApi('/api/open/query-order', { page, per_page: perPage }, config, options);
    const list = Array.isArray(data?.list) ? data.list : [];
    orders.push(...list);
    totalCount = Number(data?.total_count) || orders.length;
    totalPages = Number(data?.total_page) || 1;
    if (!list.length) break;
    page++;
  }

  return { orders, totalCount, totalPages, truncated: page > maxPages && maxPages < totalPages };
}

/** 读线上码池：走 query-plan，型号里的 reply_random_content 就是池子全文。 */
async function fetchPool(config, options) {
  const params = config.planId ? { plan_id: config.planId } : {};
  if (!config.planId) throw new Error('没配 plan_id，读不到线上码池。跑 init 补上。');
  const data = await callApi('/api/open/query-plan', params, config, options);
  const plan = data?.plan ?? {};
  const skus = Array.isArray(plan.skus) ? plan.skus : [];

  if (!config.skuId) {
    // 没有 sku_id 时退而求其次：只有一个型号就直接用它，多个型号必须点明是哪个，别猜。
    if (skus.length === 1) return { plan, sku: skus[0], poolText: skus[0]?.reply_random_content ?? '' };
    throw new Error(
      skus.length
        ? `这个方案下有 ${skus.length} 个型号，得用 --sku-id 指定（或用 init --sku-id 配好）：\n  ${skus
            .map((sku) => `${sku.sku_id}\t${sku.name}`)
            .join('\n  ')}`
        : '这个方案下没有型号（订阅方案没有码池，自动随机回复只在售卖商品的型号里）。',
    );
  }

  const sku = skus.find((item) => item && item.sku_id === config.skuId);
  if (!sku) {
    throw new Error(
      `sku_id 不匹配：配置里是 ${config.skuId}，方案里的型号有：\n  ${skus
        .map((item) => `${item.sku_id}\t${item.name}`)
        .join('\n  ')}`,
    );
  }
  return { plan, sku, poolText: sku.reply_random_content ?? '' };
}

async function cmdStatus(flags, config) {
  if (!requireCredentials(config)) {
    process.exitCode = 1;
    return;
  }
  const proxy = resolveProxy(flags);
  const options = { proxy, maxPages: flags['max-pages'] };

  const { plan, sku, poolText } = await fetchPool(config, options);
  const pool = parsePool(poolText);

  const keyFile = readKeyFile();
  const { valid, foreign } = classifyPool(pool.codes, keyFile?.publicKey ?? '');

  const { orders, totalCount, totalPages, truncated } = await fetchAllOrders(config, options);
  const sold = countSold(orders, { planId: config.planId, skuId: config.skuId });

  const channel = typeof flags.channel === 'string' ? flags.channel : config.channel;
  const manifests = listManifests(typeof flags.dir === 'string' ? path.resolve(flags.dir) : BATCH_DIR).filter(
    (manifest) => !channel || manifest.channel === channel,
  );
  const manifestCodes = manifests.flatMap((manifest) => manifest.codes);

  const report = reconcile({
    poolCodes: valid.map((item) => item.code),
    foreignCodes: foreign.map((item) => item.code),
    poolMalformed: pool.malformed,
    poolDuplicates: pool.duplicates,
    manifestCodes,
    ledgerEntries: readLedger(),
    sold,
    lowWater: config.lowWater,
    restockSize: config.restockSize,
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          missingFromPool: undefined,
          unexpectedInPool: undefined,
          context: {
            planId: config.planId,
            skuId: config.skuId,
            skuName: sku?.name ?? '',
            planName: plan?.name ?? '',
            ordersFetched: orders.length,
            totalCount,
            totalPages,
            truncated,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`方案\t\t${plan?.name ?? '(未取到名称)'}  ${config.planId}`);
  console.log(`型号\t\t${sku?.name ?? '(未取到名称)'}  ${sku?.sku_id ?? ''}`);
  console.log(`订单\t\t已拉取 ${orders.length} / ${totalCount} 笔（共 ${totalPages} 页）`);
  if (truncated) {
    console.log('★ 订单没拉全（--max-pages 截断）——下面的「已售」会偏小，对账结论不可信。加 --max-pages 再跑。');
  }
  console.log(`批次\t\t${manifests.length} 个${channel ? `（渠道前缀 ${channel}）` : ''}`);
  console.log('');
  console.log(formatReconcile(report, { batchLabel: channel ? `（渠道前缀 ${channel}）` : '(本机全部批次)' }));

  if (!keyFile) console.log('\n（没有 ~/.gewu/license_key.json，池子里的码没能逐枚验签）');
  if (sold.noSkuDetail) console.log(`\n★ 有 ${sold.noSkuDetail} 笔成交订单没有 sku_detail，没能归到型号上。`);
  if (report.missingFromPoolCount) {
    console.log(`\n从池子里消失的码 ${report.missingFromPoolCount} 枚 —— 正常情况下等于「已售件数」。`);
  }
}

async function cmdWho(flags, config) {
  if (!requireCredentials(config)) {
    process.exitCode = 1;
    return;
  }
  const orderNo = typeof flags.order === 'string' ? flags.order : null;
  if (!orderNo) {
    console.error('用法：node tools/afdian-stock.mjs who --order 20261010123456789');
    process.exitCode = 1;
    return;
  }

  const data = await callApi('/api/open/query-random-reply', { out_trade_no: orderNo }, config, {
    proxy: resolveProxy(flags),
  });
  const list = Array.isArray(data?.list) ? data.list : [];
  if (!list.length) {
    console.log(`平台没有这单的随机回复记录：${orderNo}`);
    console.log('（可能是订单号抄错了，或者这单不是走「自动随机回复」发的）');
    return;
  }

  const keyFile = readKeyFile();
  for (const item of list) {
    const pool = parsePool(item?.content ?? '');
    console.log(`订单\t${item?.out_trade_no ?? orderNo}`);
    console.log(`发出去的码 ${pool.codes.length} 枚${pool.malformed.length ? `（另有 ${pool.malformed.length} 行看不懂）` : ''}`);
    for (const code of pool.codes) {
      const result = keyFile ? verifyCode(code, keyFile.publicKey) : { ok: false, reason: 'key' };
      if (result.ok) {
        const match = /^([A-Za-z][A-Za-z0-9]*)-([A-Za-z0-9]+)-(\d+)$/.exec(String(result.payload.e));
        console.log(`  ${code}`);
        console.log(`    → 标识 ${result.payload.e}｜序号 #${result.payload.n}｜签发日 ${result.payload.d}`);
        if (match) console.log(`    → 渠道 ${match[1]}｜批次 ${match[2]}｜批内第 ${Number(match[3])} 枚`);
      } else {
        console.log(`  ${code}`);
        console.log(`    → ⚠ 验签失败（${result.reason}）——这枚不是本机私钥签的码；买家激活不了，得补发。`);
      }
    }
  }
}

async function cmdRestock(flags, config) {
  if (!requireCredentials(config)) {
    process.exitCode = 1;
    return;
  }
  if (!config.skuId) {
    console.error('补货要往型号里追加，必须配 sku_id。跑 init --sku-id <型号ID>（update-plan-reply 传 plan_id 会报错）。');
    process.exitCode = 1;
    return;
  }

  const channel = typeof flags.channel === 'string' ? flags.channel : config.channel;
  const batch = typeof flags.batch === 'string' ? flags.batch : todayLocal().replace(/-/g, '');
  const count = Number.parseInt(String(flags.count ?? config.restockSize ?? DEFAULT_RESTOCK_SIZE), 10);
  const date = todayLocal();

  const namingError = validateNaming(channel, batch);
  if (namingError) {
    console.error(namingError);
    process.exitCode = 1;
    return;
  }

  const outDir = typeof flags['out-dir'] === 'string' ? path.resolve(flags['out-dir']) : BATCH_DIR;
  const gitRoot = findGitRoot(outDir);
  if (gitRoot) {
    console.error(`拒绝把激活码写进 git 仓库：${outDir}（仓库根 ${gitRoot}）`);
    process.exitCode = 1;
    return;
  }

  const existing = listManifests(outDir).find((m) => m.channel === channel && m.batch === batch);
  if (existing) {
    console.error(`批次 ${batchKey(channel, batch)} 已经签过了：${existing.file}`);
    console.error('补货请换一个批次名（--batch 20261011）。');
    process.exitCode = 1;
    return;
  }

  const keyFile = readKeyFile();
  if (!keyFile) {
    console.error(`没有私钥。先跑 \`node tools/license.mjs keygen\`。（找的是 ${path.join(HOME_DIR, 'license_key.json')}）`);
    process.exitCode = 1;
    return;
  }

  const proxy = resolveProxy(flags);
  const options = { proxy };

  // 先读一次线上池子：既算存量，也用来防「上一次追加其实成功了」的重复追加。
  const { poolText } = await fetchPool(config, options);
  const pool = parsePool(poolText);

  const ledger = readLedger();
  const maxSeq = ledger.reduce((acc, e) => (Number.isFinite(e.n) && e.n > acc ? e.n : acc), 0);
  const entries = buildBatchEntries({
    subjects: planSubjects({ count, channel, batch, startIndex: 1 }),
    privateJwk: keyFile.privateJwk,
    startSerial: maxSeq + 1,
    date,
  });
  const summary = summarizeBatch(entries);

  const already = overlapWithPool(entries, pool.codes);
  if (already.length) {
    console.error(`停手：这次要签的码里有 ${already.length} 枚**已经在线上池子里**了。`);
    console.error(`  例：${already[0].code}`);
    console.error('  说明上一次追加其实成功了（只是响应丢了，或者你手工粘过）。');
    console.error('  换成新的批次名再签（--batch 换一个），绝不重复追加。');
    process.exitCode = 1;
    return;
  }

  console.log(`当前线上池存量\t${pool.codes.length} 枚${pool.codes.length <= config.lowWater ? '  ⚠ 已到水位' : ''}`);
  console.log(`将签发并追加\t${summary.count} 枚  批次 ${batchKey(channel, batch)}（序号 #${summary.fromSerial}–#${summary.toSerial}）`);
  console.log(`  首枚\t\t${entries[0].code}`);
  console.log(`  末枚\t\t${entries[entries.length - 1].code}`);
  console.log(`  追加后池存量\t${pool.codes.length + summary.count} 枚`);
  console.log(`  写入地址\t${AFDIAN_API}/api/open/update-plan-reply  sku_id=${config.skuId}  type=append`);
  console.log(`  本地产物\t${outDir}`);
  console.log('');

  if (!flags.yes) {
    console.log('这是演练（dry-run）。确认无误后加 `--yes` 真写线上。');
    return;
  }

  let pushed = null;
  try {
    await callApi(
      '/api/open/update-plan-reply',
      {
        sku_id: config.skuId,
        auto_random_reply: codesText(entries),
        update_random_reply_type: 'append',
      },
      config,
      options,
    );
    pushed = { at: new Date().toISOString(), mode: 'append', via: 'api' };
    console.log('已追加到线上码池 ✓');
  } catch (error) {
    console.error(`追加失败：${error.message}`);
    console.error('★ 码已经签好了，本地照样落盘 —— 可以手工粘进爱发电后台，不会白签。');
  }

  appendLedger(entries);
  const manifest = buildManifest({ channel, batch, entries, date, pushed });
  const paths = writeBatchFiles(outDir, manifest, entries);

  console.log(`  码文件\t\t${paths.codesFile}`);
  console.log(`  清单\t\t${paths.manifestFile}`);
  console.log(`  指纹\t\t${summary.fingerprint}`);
  console.log('\n收尾：跑一次 `status` 核对池存量是否变成预期值 —— 传输成功不等于内容正确。');
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const config = loadConfig(typeof flags.config === 'string' ? flags.config : undefined);

  try {
    switch (command) {
      case 'init':
        cmdInit(flags);
        break;
      case 'ping':
        await cmdPing(flags, config);
        break;
      case 'status':
        await cmdStatus(flags, config);
        break;
      case 'who':
        await cmdWho(flags, config);
        break;
      case 'restock':
        await cmdRestock(flags, config);
        break;
      default:
        console.log(HELP);
        if (command && command !== 'help') process.exitCode = 1;
    }
  } catch (error) {
    console.error(`出错了：${error.message}`);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|abort/i.test(String(error.message))) {
      console.error('★ 本机直连 443 可能不通。试 `--proxy socks5://127.0.0.1:10808`。');
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { main, cmdInit, cmdPing, cmdStatus, cmdWho, cmdRestock, fetchAllOrders, fetchPool };
