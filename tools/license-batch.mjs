#!/usr/bin/env node
/**
 * 格物 · 爱发电码池批量签发（完全离线，零第三方依赖）
 *
 * ---------------------------------------------------------------------------
 * 为什么是「批量签发 + 码池」而不是「一单签一个码」
 *
 *   爱发电的自动发货机制是「自动随机回复」：把一批码一行一个粘进商品的型号高级选项里，
 *   平台每卖出一件，就从里面**取一行**私信发给买家。它是一个**码池**，不是回调接口。
 *   而格物的授权码是离线私钥签名、App 内公钥验签，**没有任何服务端** ——
 *   于是发码端唯一要做的事就是：预先签一批、粘进码池、卖完再补一批。
 *   本工具负责「签 + 落两个文件」，粘的动作在爱发电后台（或用 afdian-stock.mjs restock 走 API 追加）。
 *
 * ---------------------------------------------------------------------------
 * 标识命名约定  <渠道>-<批次>-<序号>    例：afdian-20261010-001
 *
 *   · 渠道前缀（afdian / xhs / taobao …）—— license-audit 的 audit 会按渠道统计，
 *     码泄漏时「走的哪个渠道出去的」只有这个前缀能回答。零成本，只在发码时换个写法。
 *   · 批次（默认当天 YYYYMMDD）—— 一个批次 = 一次粘进码池的动作。补货就开新批次，
 *     于是「哪一批还剩多少」永远查得清（afdian-stock.mjs 的 status 靠它分组）。
 *   · 逐码序号（零填充）—— 关键：每枚码一个独立标识，台账里 50 枚码就是 50 条记录，
 *     而不是一条「某人买了 50 个」（后者会被 audit 判成「转卖嫌疑」的可疑形态）。
 *
 * ---------------------------------------------------------------------------
 * 产物（两份文件，都在 ~/.gewu/batches/ 下）
 *
 *   codes-<渠道>-<批次>.txt    一行一个，**整份**粘进爱发电「自动随机回复」
 *   batch-<渠道>-<批次>.json   粘贴凭据：序号范围 / 数量 / 指纹 / 码清单
 *                              （afdian-stock.mjs 的 status 用它比对「期望池内容 vs 线上实际池内容」）
 *
 *   ★★ 码就是钱：默认落在 ~/.gewu/batches/，**绝不默认写进仓库**（本仓库会推 GitHub）。
 *      --out-dir 指到 git 仓库里时会给红字警告并拒绝，除非再加 --force。
 *
 * ---------------------------------------------------------------------------
 * 子命令
 *   issue --count 50 [--batch 20261010] [--channel afdian] [--out-dir DIR] [--dry-run] [--force]
 *   list  [--dir DIR]            列出本机已签发的批次
 *   show  --batch 20261010       打印某批次的清单（含码）
 *   help
 *
 * 与 license.mjs 的关系：码的构造、签名、台账格式全部复用，不另起一套。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  HOME_DIR,
  ensureHomeDir,
  readKeyFile,
  readLedger,
  appendLedger,
  parseArgs,
  encodePayload,
  buildCode,
  todayLocal,
} from './license.mjs';

/** 批次文件与清单的默认落盘目录。跟着密钥走，不进仓库。 */
export const BATCH_DIR = path.join(HOME_DIR, 'batches');

export const MANIFEST_VERSION = 1;

/** 序号零填充宽度：至少 3 位（`001`），批次大到 1000 枚以上时自然加宽。 */
export function indexWidth(count) {
  return Math.max(3, String(Math.max(1, Number(count) || 1)).length);
}

/** 组一个标识。channel / batch 由调用方保证已过校验。 */
export function formatSubject({ channel, batch, index, width }) {
  return `${channel}-${batch}-${String(index).padStart(width, '0')}`;
}

/** 拆一个标识。不符合约定的返回 null（老写法 `afdian-8871` 也返回 null，不硬凑）。 */
export function parseSubject(subject) {
  const match = /^([A-Za-z][A-Za-z0-9]*)-([A-Za-z0-9]+)-(\d+)$/.exec(String(subject ?? ''));
  if (!match) return null;
  return {
    channel: match[1].toLowerCase(),
    batch: match[2],
    index: Number.parseInt(match[3], 10),
    padded: match[3],
  };
}

/** 批次的短名，用于文件名与分组：`afdian-20261010`。 */
export function batchKey(channel, batch) {
  return `${channel}-${batch}`;
}

/** channel / batch 的字符集校验。写进码里的东西，先挡住非法字符。 */
export function validateNaming(channel, batch) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(String(channel ?? ''))) {
    return `渠道名不合法：「${channel}」—— 只能字母开头、字母数字组成（例 afdian / xhs / taobao）`;
  }
  if (!/^[A-Za-z0-9]+$/.test(String(batch ?? ''))) {
    return `批次名不合法：「${batch}」—— 只能字母数字组成（例 20261010）`;
  }
  return null;
}

/** 按批次规划标识列表（纯函数，不碰磁盘）。 */
export function planSubjects({ count, channel, batch, startIndex = 1, width }) {
  const n = Math.max(1, Number.parseInt(String(count), 10) || 1);
  const w = Number.isFinite(width) ? width : indexWidth(n);
  return Array.from({ length: n }, (_, i) =>
    formatSubject({ channel, batch, index: startIndex + i, width: w }),
  );
}

/**
 * 把标识列表签成台账条目（纯函数：私钥由调用方传入）。
 * 序号从 startSerial 起连续递增 —— 与 license.mjs 的 issue 同一条规则。
 */
export function buildBatchEntries({ subjects, privateJwk, startSerial, date }) {
  return subjects.map((subject, i) => {
    const seq = startSerial + i;
    const payloadJson = encodePayload({ subject, date, seq });
    return {
      n: seq,
      e: subject,
      d: date,
      issuedAt: new Date().toISOString(),
      code: buildCode(payloadJson, privateJwk),
    };
  });
}

/** 批次的统计摘要 + 码串指纹（判据只能是它：传输成功不等于内容正确）。 */
export function summarizeBatch(entries) {
  const list = entries ?? [];
  const codes = list.map((e) => e.code);
  const body = codes.join('\n') + '\n';
  return {
    count: list.length,
    fromSerial: list.length ? list[0].n : 0,
    toSerial: list.length ? list[list.length - 1].n : 0,
    startIndex: list.length ? parseSubject(list[0].e)?.index ?? 1 : 1,
    firstCode: codes[0] ?? '',
    lastCode: codes[codes.length - 1] ?? '',
    fingerprint: crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8),
  };
}

/** codes 文本 → 行数组。统一 LF 收尾，粘贴进爱发电时不会有半行。 */
export function codesText(entries) {
  return (entries ?? []).map((e) => e.code).join('\n') + '\n';
}

export function batchPaths(dir, channel, batch) {
  const key = batchKey(channel, batch);
  return {
    dir,
    codesFile: path.join(dir, `codes-${key}.txt`),
    manifestFile: path.join(dir, `batch-${key}.json`),
  };
}

export function buildManifest({ channel, batch, entries, date, pushed = null }) {
  const summary = summarizeBatch(entries);
  return {
    v: MANIFEST_VERSION,
    channel,
    batch,
    date,
    count: summary.count,
    fromSerial: summary.fromSerial,
    toSerial: summary.toSerial,
    startIndex: summary.startIndex,
    width: indexWidth(summary.count),
    createdAt: new Date().toISOString(),
    fingerprint: summary.fingerprint,
    codes: (entries ?? []).map((e) => e.code),
    ...(pushed ? { pushed } : {}),
  };
}

/** 写两个文件。返回路径与指纹，供命令层打印。 */
export function writeBatchFiles(dir, manifest, entries) {
  ensureHomeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = batchPaths(dir, manifest.channel, manifest.batch);
  fs.writeFileSync(paths.codesFile, codesText(entries), { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(paths.manifestFile, JSON.stringify(manifest, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  return paths;
}

/** 扫盘列出本机批次清单（坏的 JSON 直接跳过 —— 别让一个坏文件把 list 弄挂）。 */
export function listManifests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('batch-') && name.endsWith('.json'))
    .map((name) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.codes)) return null;
        return { ...manifest, file: path.join(dir, name) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * 向上找 .git，用来拦住「把码写进仓库」。
 * 只走 6 层 —— 够用，且不会因为某个奇怪的盘根目录把栈翻一遍。
 */
export function findGitRoot(dir) {
  let current = path.resolve(dir);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/* ==================== 子命令 ==================== */

const HELP = `格物 · 爱发电码池批量签发（离线）

  node tools/license-batch.mjs issue --count 50            签发 50 枚，批次默认当天
  node tools/license-batch.mjs issue --count 50 --batch 20261010 --channel afdian
  node tools/license-batch.mjs issue --count 50 --out-dir D:\\gewu-codes
  node tools/license-batch.mjs issue --count 50 --dry-run  只打印将要签的序号范围，不落盘
  node tools/license-batch.mjs list                        列出本机已签发的批次
  node tools/license-batch.mjs show --batch 20261010       打印某批次清单（含码）

产物（默认 ~/.gewu/batches/，与私钥同目录，不进仓库）：
  codes-<渠道>-<批次>.txt    一行一个，整份粘进爱发电「自动随机回复」
  batch-<渠道>-<批次>.json   粘贴凭据（序号范围 / 数量 / 指纹 / 码清单）

下一步：爱发电后台 → 售卖商品 → 型号 → 高级选项 → 勾「自动随机回复」→ 粘贴 codes 文件全文。`;

function cmdIssue(flags) {
  const channel = typeof flags.channel === 'string' ? flags.channel : 'afdian';
  const batch = typeof flags.batch === 'string' ? flags.batch : todayLocal().replace(/-/g, '');
  const date = typeof flags.date === 'string' ? flags.date : todayLocal();
  const count = Number.parseInt(String(flags.count ?? ''), 10);

  const namingError = validateNaming(channel, batch);
  if (namingError) {
    console.error(namingError);
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(count) || count < 1) {
    console.error('要指定数量：--count 50');
    process.exitCode = 1;
    return;
  }

  const dir = typeof flags['out-dir'] === 'string' ? path.resolve(flags['out-dir']) : BATCH_DIR;

  // 同名批次只能签一次：同批次既已存在，说明上次的码已经粘进池子了，
  // 再签一批会让「哪一批还剩多少」失去意义（而且旧清单文件会被覆盖）。
  const existing = listManifests(dir).find((m) => m.channel === channel && m.batch === batch);
  if (existing && !flags.force) {
    console.error(`批次 ${batchKey(channel, batch)} 已经签过了：${existing.file}`);
    console.error(`  共 ${existing.count} 枚（序号 #${existing.fromSerial}–#${existing.toSerial}），指纹 ${existing.fingerprint}`);
    console.error('补货请换一个批次名（--batch 20261011）。确实要重签同一批才加 --force。');
    process.exitCode = 1;
    return;
  }

  const gitRoot = findGitRoot(dir);
  if (gitRoot && !flags.force) {
    console.error(`拒绝把激活码写进 git 仓库：${dir}（仓库根 ${gitRoot}）`);
    console.error('码就是钱，一旦提交就永久留在历史里。换个目录（默认 ~/.gewu/batches/），确实要写才加 --force。');
    process.exitCode = 1;
    return;
  }

  const ledger = readLedger();
  const maxSeq = ledger.reduce((acc, e) => (Number.isFinite(e.n) && e.n > acc ? e.n : acc), 0);
  const subjects = planSubjects({ count, channel, batch, startIndex: 1 });

  if (flags['dry-run']) {
    console.log(`将签发 ${count} 枚，批次 ${batchKey(channel, batch)}`);
    console.log(`  标识\t${subjects[0]}  …  ${subjects[subjects.length - 1]}`);
    console.log(`  序号\t#${maxSeq + 1} – #${maxSeq + count}（接着现有台账往下排）`);
    console.log(`  目录\t${dir}`);
    console.log('（--dry-run：没有落盘，也没有写台账）');
    return;
  }

  const keyFile = readKeyFile();
  if (!keyFile) {
    console.error(`没有私钥。先跑 \`node tools/license.mjs keygen\`。（找的是 ${path.join(HOME_DIR, 'license_key.json')}）`);
    process.exitCode = 1;
    return;
  }

  const entries = buildBatchEntries({
    subjects,
    privateJwk: keyFile.privateJwk,
    startSerial: maxSeq + 1,
    date,
  });

  appendLedger(entries);
  const manifest = buildManifest({ channel, batch, entries, date });
  const paths = writeBatchFiles(dir, manifest, entries);

  const summary = summarizeBatch(entries);
  console.log(`已签发 ${summary.count} 枚`);
  console.log(`  批次\t\t${batchKey(channel, batch)}`);
  console.log(`  序号\t\t#${summary.fromSerial} – #${summary.toSerial}`);
  console.log(`  标识\t\t${entries[0].e}  …  ${entries[entries.length - 1].e}`);
  console.log(`  指纹\t\t${summary.fingerprint}  (sha256 前 8 位)`);
  console.log(`  码文件\t\t${paths.codesFile}`);
  console.log(`  清单\t\t${paths.manifestFile}`);
  console.log(`  台账\t\t${path.join(HOME_DIR, 'license_ledger.jsonl')}`);
  console.log(`
下一步三条（顺序别换）：
  ① 打开 ${paths.codesFile}，**整份**粘进爱发电 → 售卖商品 → 型号 → 高级选项 → 勾「自动随机回复」
  ② 粘完回来看一眼：线上池子里的行数应等于 ${summary.count}（afdian-stock.mjs status 能替你数）
  ③ 补货就换个批次名再签一批（--batch ...），别重签同一批`);
}

function cmdList(flags) {
  const dir = typeof flags.dir === 'string' ? path.resolve(flags.dir) : BATCH_DIR;
  const manifests = listManifests(dir);
  if (!manifests.length) {
    console.log(`还没有批次。目录：${dir}`);
    return;
  }
  console.log(`目录：${dir}\n`);
  console.log('批次\t\t\t数量\t序号\t\t签发时间\t\t指纹');
  for (const m of manifests) {
    console.log(
      `${batchKey(m.channel, m.batch)}\t${m.count}\t#${m.fromSerial}–#${m.toSerial}\t${String(m.createdAt).slice(0, 16).replace('T', ' ')}\t${m.fingerprint}` +
        (m.pushed ? `\t已推送 ${String(m.pushed.at).slice(0, 16).replace('T', ' ')}` : ''),
    );
  }
  console.log(`\n共 ${manifests.length} 个批次。`);
}

function cmdShow(flags) {
  const dir = typeof flags.dir === 'string' ? path.resolve(flags.dir) : BATCH_DIR;
  const channel = typeof flags.channel === 'string' ? flags.channel : 'afdian';
  const batch = typeof flags.batch === 'string' ? flags.batch : null;
  if (!batch) {
    console.error('用法：node tools/license-batch.mjs show --batch 20261010 [--channel afdian]');
    process.exitCode = 1;
    return;
  }
  const manifest = listManifests(dir).find((m) => m.channel === channel && m.batch === batch);
  if (!manifest) {
    console.error(`没找到批次 ${batchKey(channel, batch)}（目录 ${dir}）`);
    process.exitCode = 1;
    return;
  }
  console.log(`批次\t\t${batchKey(manifest.channel, manifest.batch)}`);
  console.log(`数量\t\t${manifest.count}`);
  console.log(`序号\t\t#${manifest.fromSerial} – #${manifest.toSerial}`);
  console.log(`签发时间\t${manifest.createdAt}`);
  console.log(`指纹\t\t${manifest.fingerprint}`);
  console.log(`码文件\t\t${batchPaths(dir, manifest.channel, manifest.batch).codesFile}`);
  console.log('\n序号\t标识\t\t码');
  // 清单里只存码（它必须和粘进爱发电的那份一模一样），标识/序号回台账里查 —— 查不到就照打码，不编。
  const byCode = new Map(readLedger().map((entry) => [entry.code, entry]));
  for (const code of manifest.codes) {
    const entry = byCode.get(code);
    console.log(entry ? `#${entry.n}\t${entry.e}\t${code}` : `#?\t(台账里没有)\t${code}`);
  }
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  switch (positional[0]) {
    case 'issue':
      cmdIssue(flags);
      break;
    case 'list':
      cmdList(flags);
      break;
    case 'show':
      cmdShow(flags);
      break;
    default:
      console.log(HELP);
      if (positional[0] && positional[0] !== 'help') process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

// 命令函数导出给测试用。理由同 license-audit.mjs：Windows 下 spawn 同目录 node.exe 会 EBUSY。
export { cmdIssue, cmdList, cmdShow };
