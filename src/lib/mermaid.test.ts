// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { sanitizeMermaidSvg, validateMermaid } from './mermaid'

describe('Mermaid math labels', () => {
  it.each([
    'mindmap\n  root((特征值与特征向量))\n    n["代数方程 $$Ax = \\lambda x$$"]\n    d["特征方程 $$\\det(\\lambda E-A)=0$$"]',
    'flowchart LR\n A["$$Ax = \\lambda x$$"] -->|"$$\\lambda \\ne 0$$"| B["$$\\frac{1}{\\lambda}$$"]',
  ])('accepts quoted formulas in actual Mermaid syntax: %s', async (source) => {
    expect((await validateMermaid(source)).source).toBe(source)
  })

  it('keeps mixed Chinese text and MathML in a standalone SVG after sanitization', () => {
    const math = katex.renderToString('Ax = \\lambda x + \\frac{1}{2}', { output: 'mathml' })
    const svg = sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="200" height="60"><div xmlns="http://www.w3.org/1999/xhtml"><span>代数方程 ${math}</span></div></foreignObject></svg>`)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('foreignObject div')?.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(doc.querySelector('math')?.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    expect(doc.querySelector('mfrac')).not.toBeNull()
    expect(doc.querySelector('mi')?.textContent).toBe('A')
    expect(doc.documentElement.textContent).toContain('代数方程')
    expect(doc.documentElement.textContent).toContain('λ')
  })

  it('still removes executable content, links and embedded media from labels', () => {
    const svg = sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><image href="https://example.com/image.png"/>
      <foreignObject width="200" height="60"><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">
        <iframe src="https://example.com"></iframe><img src="https://example.com/image.png" onerror="alert(1)"/>
        <a href="javascript:alert(1)">链接</a><span>安全文本</span>
        <math xmlns="http://www.w3.org/1998/Math/MathML"><mi href="https://example.com">x</mi></math>
      </div></foreignObject></svg>`)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('script, image, iframe, img, a')).toBeNull()
    expect(doc.querySelector('[href], [src], [onclick], [onload], [onerror]')).toBeNull()
    expect(doc.querySelector('foreignObject span')?.textContent).toBe('安全文本')
    expect(doc.querySelector('mi')?.textContent).toBe('x')
  })
})
