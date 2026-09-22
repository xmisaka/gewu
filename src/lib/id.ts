/**
 * 格物 · UUID 生成
 *
 * 前提一：主键必须 UUID，不能自增（导入支持「追加合并」，自增必然撞车）。
 * 优先用 expo-crypto 的 randomUUID；若模块缺席（例如纯 Web 预览）
 * 退回手写 v4 —— 单机场景下不需要密码学强度。
 */

let uuidImpl: (() => string) | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('expo-crypto') as typeof import('expo-crypto');
  if (typeof crypto.randomUUID === 'function') {
    uuidImpl = () => crypto.randomUUID();
  }
} catch {
  uuidImpl = null;
}

function fallbackUUID(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      // 变体位：8 ~ b
      out += hex[((Math.random() * 4) | 0) + 8];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}

export function uuid(): string {
  return uuidImpl ? uuidImpl() : fallbackUUID();
}

/** 带类型前缀的 ID，调试时可读（仅用于日志/导出，不作为主键） */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}
