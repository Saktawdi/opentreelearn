import DOMPurify from 'dompurify'

export const MERMAID_SOURCE_LIMIT = 20_000

/** Source is portable Markdown content; diagram configuration belongs to the app. */
export function normalizeMermaidSource(raw: string): string {
  let source = raw.replace(/\r\n?/g, '\n').trim()
  const fenced = /^(?:```|~~~)mermaid\s*\n([\s\S]*?)\n(?:```|~~~)$/.exec(source)
  if (fenced) source = fenced[1].trim()
  if (!source) throw new Error('Mermaid source is empty')
  if (source.length > MERMAID_SOURCE_LIMIT || source.split('\n').length > 500) {
    throw new Error('Diagram is too large; split it into smaller diagrams')
  }
  if (/^---(?:\s|$)/.test(source) || /%%\s*\{/.test(source)) {
    throw new Error('Diagram configuration is managed by the app; omit frontmatter and init directives')
  }
  return source
}

let engine: Promise<typeof import('mermaid')['default']> | undefined
let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

async function loadEngine() {
  engine ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: MERMAID_SOURCE_LIMIT,
      maxEdges: 300,
      theme: 'dark',
      look: 'classic',
      fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      themeVariables: {
        background: '#101317', primaryColor: '#33281a', primaryTextColor: '#e8ebef',
        primaryBorderColor: '#e0a768', lineColor: '#868f9d',
        git0: '#33281a', gitBranchLabel0: '#e8ebef',
        cScale0: '#28483f', cScale1: '#493454', cScale2: '#314956',
        cScaleLabel0: '#e8ebef', cScaleLabel1: '#e8ebef', cScaleLabel2: '#e8ebef',
      },
      // Circle labels use centered SVG text; rectangular mindmap labels use their own offset.
      themeCSS: '.mindmap-node circle ~ .label text { text-anchor: middle; }',
      flowchart: { curve: 'linear', minNodeWidth: 0 },
    })
    return mermaid
  })
  return engine
}

// Mermaid uses shared parser/configuration state. Serialize validation and rendering.
function withEngine<T>(run: (mermaid: Awaited<ReturnType<typeof loadEngine>>) => Promise<T>): Promise<T> {
  const result = queue.then(async () => run(await loadEngine()))
  queue = result.catch(() => undefined)
  return result
}

export async function validateMermaid(raw: string): Promise<{ source: string; diagramType: string }> {
  const source = normalizeMermaidSource(raw)
  return withEngine(async (mermaid) => {
    const result = await mermaid.parse(source)
    if (!result) throw new Error('Invalid Mermaid syntax')
    return { source, diagramType: result.diagramType }
  })
}

export async function renderMermaid(raw: string): Promise<string> {
  const source = normalizeMermaidSource(raw)
  return withEngine(async (mermaid) => {
    // Keep Mermaid's measurement and error elements outside the conversation DOM.
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
    host.setAttribute('aria-hidden', 'true')
    document.body.appendChild(host)
    try {
      const { svg } = await mermaid.render(`otl-diagram-${++nextId}`, source, host)
      return DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'script', 'image', 'a'],
        FORBID_ATTR: ['href', 'xlink:href'],
      })
    } finally {
      host.remove()
    }
  })
}

export function diagramMarkdown(title: string, source: string): string {
  // Prevent a title or code fence from breaking out into additional Markdown blocks.
  const label = title.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]<>]/g, '\\$&').trim()
  const fence = '`'.repeat(Math.max(3, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length + 1)))
  return `\n\n**${label}**\n\n${fence}mermaid\n${source}\n${fence}\n\n`
}
