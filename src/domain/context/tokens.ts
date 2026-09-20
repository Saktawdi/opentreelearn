const CJK_PATTERN =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u31c0-\u31ef\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

export function estimateTokens(text: string): number {
  if (!text) return 0

  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_PATTERN.test(char)) {
      cjk += 1
    } else {
      other += 1
    }
  }

  return Math.ceil(cjk * 1.05 + other / 3.6)
}