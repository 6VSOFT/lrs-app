import type { Rand } from './engine/types.ts';

/**
 * 由种子确定性生成的随机数（sfc32）。
 * 种子是后端写入每条日志时生成的 128 位密码学随机数，因此所有重放结果一致，而结果对玩家不可预测。
 */
export function seededRand(seedHex: string): Rand {
  const p = (i: number) => parseInt(seedHex.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 16) >>> 0;
  let a = p(0), b = p(1), c = p(2), d = p(3);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  return (n) => {
    const max = Math.floor(0x100000000 / n) * n; // 拒绝采样，无模偏差
    let x: number;
    do { x = next(); } while (x >= max);
    return x % n;
  };
}
