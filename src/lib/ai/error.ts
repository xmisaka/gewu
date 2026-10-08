/**
 * 格物 · AI 层的错误类型与用户可见文案（纯类型，零原生依赖）
 *
 * 单独成一个文件，是因为**两个模块同时需要它**：网络层（`client.ts`）与图片处理层（`upload.ts`）。
 * 让它们为了共用一个错误类而互相 import，会把依赖方向搞乱。
 *
 * ★ 这个类**刻意不写构造器参数属性**（`constructor(readonly kind: …)`）——
 *   那是少数几种 `--experimental-strip-types` 剥不掉的 TS 语法，一旦用了，
 *   任何 import 它的模块都再也进不了 `node:test`，整层逻辑等于没有测试兜着。
 */

export type AiErrorKind =
  /** 还没配 Key */
  | 'no-key'
  /** 连不上、DNS 失败 */
  | 'network'
  /**
   * 超时。与 network 分开，因为用户能做的事不同：
   * 网络不通要去查网络，而超时只是「这次回得慢」，重试往往就好了。
   */
  | 'timeout'
  /** 服务端回了非 2xx 或响应体不是预期形状 */
  | 'api';

export class AiError extends Error {
  readonly kind: AiErrorKind;

  constructor(message: string, kind: AiErrorKind) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
  }
}

/**
 * 失败态的用户可见文案。集中一处 —— 同一句话只该有一个措辞。
 * 几种失败对用户的动作**完全不同**（去填 Key / 检查网络 / 稍后重试），所以必须分开说。
 */
export function describeAiError(err: unknown): string {
  if (err instanceof AiError) {
    switch (err.kind) {
      case 'no-key':
        return '还没配置 API Key，先到「我的 → AI 助手」填一个';
      case 'network':
        return '联网失败了，检查一下网络后重试';
      case 'timeout':
        return '这次太慢了，多半是网络。换个信号好点的地方再试';
      default:
        return err.message;
    }
  }
  return 'AI 暂时用不了，稍后再试';
}
