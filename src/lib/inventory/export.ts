/**
 * 格物 · 财产清册 · 落地（唯一碰系统能力的文件）
 *
 * 三条边界：
 *   `model` / `paginate` / `html` / `styles` / `naming` / `failure` 是纯逻辑，能在 Node 里跑；
 *   只有这里 import expo-print / expo-sharing / expo-file-system。
 *   这样整本册子能在测试里生成并比对，不用开模拟器。
 *
 * ★★★ 页面尺寸必须显式传 `PRINT_SIZE`。安卓侧默认 `612 × 792` 是美国 Letter，
 *   漏传每页纵向少 17.6mm，最后一行被切掉且不报错（见 styles.ts 的注释）。
 * ★★ 页数不用 `printToFileAsync` 返回的 `numberOfPages`（那是估算），
 *   用我们自己算的；真实页数另外数一遍 PDF 做自检，不一致只记在结果里，不拦用户。
 *
 * ★★★ 这里**没有**「直接打印」：不调 `Print.printAsync`。
 *   两个出口都只是「把文件交出去」——发送 PDF 与发送 HTML。
 *   理由：走系统打印面板时，页边距交给打印机驱动决定，「A4 + 无边距」不一定选得到；
 *   驱动一加边距，我们按 296.5mm 算的每页行数就装不下，末行被切——而屏幕上完全看不出来。
 *   让用户用自己熟悉的工具（微信里发出去、浏览器里打开）去打印，那条路径看得见、
 *   能重来；App 里塞一条不可控的打印链路，等于把 §3 那套分页白做。
 *
 * ★★★ 改名一律用 `move(目标, { overwrite: true })`，**不许用 `rename(name)`**。
 *   踩过的坑（2026-10-17 真机）：`File.rename(newName)` 的原生实现是
 *     `val newFile = File(javaFile.parentFile, newName)` —— 它把新名字拼到**源文件所在目录**，
 *     不是我们以为的 `Paths.cache`。而 `printToFileAsync` 的产物在 `cache/Print/` 下，
 *     于是：
 *       ① 我们按 `cache/` 做的那次 `if (target.exists) target.delete()` 永远查不到东西，
 *          同一分钟生成第二次就撞名 → `FileAlreadyExistsException`（用户看到的那条报错）；
 *       ② 就算改名成功，`target.uri` 指的还是 `cache/格物-….pdf`（不存在），
 *          `shareAsync` 立刻失败 →「生成成功、发送失败」；
 *       ③ `target.size` 对不存在的文件返回 **0**（不是 null，`?? 0` 兜不住）→ 界面写「PDF 0 B」；
 *       ④ `target.arrayBuffer()` 抛错被 catch 掉 → 页数自检永远 0，静默失效。
 *   一个错误假设引出四种症状。现在目标文件由我们自己 `new File(...)` 构造，
 *   `move` 之后**同一个对象**的 `uri` 就地更新，四个值全部指向真文件。
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { strToU8 } from 'fflate';

import { listItems } from '../db/items';
import { InventoryFailure, toFailure } from './failure';
import { renderInventoryHtml } from './html';
import { buildInventory, type InventoryModel } from './model';
import { bookletBaseName, isBookletFile } from './naming';
import { PRINT_SIZE, type InventoryStyleKey } from './styles';
import { countPdfPages } from './verify';

export interface InventorySource {
  model: InventoryModel;
}

/**
 * 取数建册。
 *
 * ★ 用 `listItems()` 而不是 `listAllForExport()`：后者没有 `deleted_at` 过滤
 *   （备份包需要它保全回收站，CSV 导出用了它就混进了已删除条目）。
 *   清册必须是「在库的东西」，回收站一件都不能进。
 */
export async function loadInventory(): Promise<InventoryModel> {
  const items = await listItems({ sort: 'added' });
  return buildInventory(items);
}

export interface InventoryResult {
  /** PDF 的完整地址（已落在 `Paths.cache` 根下） */
  uri: string;
  /** 同一本册子的 HTML（单文件、零外链）地址 */
  htmlUri: string;
  fileName: string;
  htmlFileName: string;
  /** 我们自己算的页数（册子里印的就是它） */
  pages: number;
  /** 数 PDF 字节得到的真实页数；0 = 没数出来（不拦用户） */
  pagesActual: number;
  /** PDF 字节数 */
  bytes: number;
  /** HTML 字节数（一般只有 PDF 的十分之一） */
  htmlBytes: number;
  style: InventoryStyleKey;
  /** 生成时刻，界面上要显示「什么时候打的这份」 */
  generatedAt: Date;
}

/**
 * 清掉上一轮留下的清册文件。
 *
 * 只在**两个新文件都写成功之后**才调：中途失败时旧的还在，用户手上那份仍然发得出去。
 * `keep` 里是本轮刚写出的两个名字 —— 时间戳虽然精确到秒，但时钟被改过之类的意外
 * 仍可能让新旧同名，那种情况下不能把刚写好的删掉。
 */
function prunePrevious(keep: readonly string[]): void {
  let entries: (Directory | File)[];
  try {
    entries = new Directory(Paths.cache).list();
  } catch {
    return; // 列不出目录不影响生成
  }
  for (const entry of entries) {
    if (!(entry instanceof File) || !isBookletFile(entry.name) || keep.includes(entry.name)) {
      continue;
    }
    try {
      entry.delete();
    } catch {
      // 删不掉就算了：缓存目录本来就会被系统回收，删失败不该毁掉一次成功的生成
    }
  }
}

/**
 * 一次排版，两个文件。
 *
 * HTML 就是 `renderInventoryHtml` 吐出的那**一个**字符串：样式全在 `<style>` 里、
 * 没有图片也没有外链字体，所以它自己就是一个完整的册子，拷到任何机器上都能打开。
 * 顺手写掉是刻意的——它几乎不花时间（几十 KB），而「点了 HTML 才现写」会把
 * 失败点压到分享那一刻，报错时用户手上什么都没有。
 */
export async function generateInventory(
  model: InventoryModel,
  style: InventoryStyleKey,
): Promise<InventoryResult> {
  if (model.totals.count === 0) throw new InventoryFailure('empty');

  const now = new Date();
  const base = bookletBaseName(now);
  const rendered = renderInventoryHtml(model, style, { generatedAt: now });

  let tempUri: string;
  try {
    const printed = await Print.printToFileAsync({
      html: rendered.html,
      width: PRINT_SIZE.width,
      height: PRINT_SIZE.height,
    });
    tempUri = printed.uri;
  } catch (err) {
    throw toFailure('layout', err);
  }

  /* 目标由我们自己构造 —— 这样 move 之后 uri / size / arrayBuffer 全部指向真文件 */
  const pdf = new File(Paths.cache, `${base}.pdf`);
  const html = new File(Paths.cache, `${base}.html`);

  try {
    await new File(tempUri).move(pdf, { overwrite: true });
  } catch (err) {
    // expo-print 的临时文件别留在 cache/Print 里
    try {
      new File(tempUri).delete();
    } catch {
      // 删不掉不影响结论
    }
    throw toFailure('save', err);
  }

  try {
    html.create({ overwrite: true, intermediates: true });
    html.write(strToU8(rendered.html));
  } catch (err) {
    throw toFailure('save', err);
  }

  prunePrevious([pdf.name, html.name]);

  let pagesActual = 0;
  try {
    pagesActual = countPdfPages(new Uint8Array(await pdf.arrayBuffer()));
  } catch {
    // 读不出来不影响交付：页脚印的是我们算的页数
    pagesActual = 0;
  }

  return {
    uri: pdf.uri,
    htmlUri: html.uri,
    fileName: pdf.name,
    htmlFileName: html.name,
    pages: rendered.pages,
    pagesActual,
    bytes: pdf.size,
    htmlBytes: html.size,
    style,
    generatedAt: now,
  };
}

/**
 * 交付。★ 三件事按顺序做，顺序不能换：
 *   ① 文件还在不在 —— 缓存可能已被系统清掉，此时 shareAsync 报的是英文 ENOENT；
 *   ② 这台设备有没有分享通道；
 *   ③ 交出去。用户点「取消」时 shareAsync 是 resolve 的，不该报错。
 */
async function handOff(
  uri: string,
  mimeType: string,
  UTI: string,
  dialogTitle: string,
): Promise<void> {
  if (!new File(uri).exists) throw new InventoryFailure('missing');
  if (!(await Sharing.isAvailableAsync())) throw new InventoryFailure('noShare');

  try {
    await Sharing.shareAsync(uri, { mimeType, UTI, dialogTitle });
  } catch (err) {
    throw toFailure('share', err);
  }
}

export function shareInventoryPdf(result: InventoryResult): Promise<void> {
  return handOff(result.uri, 'application/pdf', 'com.adobe.pdf', '发送财产清册 PDF');
}

/**
 * 发送 HTML。`mimeType` 必须写 `text/html`：不写时安卓按扩展名猜，
 * 有些机型会退化成 `application/octet-stream`，收件方点开只看到一坨源码。
 */
export function shareInventoryHtml(result: InventoryResult): Promise<void> {
  return handOff(result.htmlUri, 'text/html', 'public.html', '发送财产清册 HTML');
}

/** 给日志用：把人话 + 原始异常分开打，界面上只出现人话 */
export function logFailure(where: string, err: unknown): void {
  if (err instanceof InventoryFailure) {
    console.warn(`[inventory] ${where} 失败（${err.code}）`, err.detail ?? '');
    return;
  }
  console.warn(`[inventory] ${where} 失败`, err);
}
