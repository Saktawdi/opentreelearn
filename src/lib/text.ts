export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

export function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? ''
  return truncate(line.trim(), max)
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}