/**
 * 让 Node 能解析工程里的「无扩展名 TS import」。
 *
 * 工程源码按 bundler 约定写 import（`from '../id'`），
 * 而 Node 的 ESM 解析要求显式扩展名，因此直接把源码 import 进测试会 ERR_MODULE_NOT_FOUND。
 * 用同步钩子补上 `.ts` / `/index.ts` 后缀，源码本身保持不动。
 *
 * 走 registerHooks（Node 22.15+，同线程同步）而不是 register（另起线程），
 * 这样它和 `mock.module` 的解析链在同一侧，不会有钩子顺序问题。
 */

import { registerHooks } from 'node:module';

const SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

const isRelative = (s) => s.startsWith('./') || s.startsWith('../') || s.startsWith('/');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isRelative(specifier)) return nextResolve(specifier, context);

    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
      for (const suffix of SUFFIXES) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          /* 试下一个后缀 */
        }
      }
      throw err;
    }
  },
});
