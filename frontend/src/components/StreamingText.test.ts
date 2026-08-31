import { describe, expect, it } from 'vitest'
import { diffChunks, type FadeChunk } from './StreamingText'

describe('diffChunks', () => {
  it('appends a fresh chunk as text grows', () => {
    let chunks: FadeChunk[] = []
    chunks = diffChunks('', chunks, 'Hello', 1)
    chunks = diffChunks('Hello', chunks, 'Hello, wor', 2)
    chunks = diffChunks('Hello, wor', chunks, 'Hello, world', 3)
    expect(chunks.map((c) => c.text)).toEqual(['Hello', ', wor', 'ld'])
    expect(chunks.map((c) => c.id)).toEqual([1, 2, 3])
  })

  it('keeps chunks referentially stable when nothing changed', () => {
    const a = diffChunks('', [], 'abc', 1)
    expect(diffChunks('abc', a, 'abc', 2)).toBe(a)
  })

  it('resets to a single chunk when text is replaced (not appended)', () => {
    const a = diffChunks('', [], 'partial line', 1)
    const b = diffChunks('partial line', a, 'new start', 2)
    expect(b).toEqual([{ id: 2, text: 'new start' }])
  })

  it('handles newline flush (tail reset) as a replacement', () => {
    // Simulates StreamingText: tail "wor" committed at newline, next tail "A".
    const a = diffChunks('', [], 'wor', 1)
    const b = diffChunks('wor', a, 'A', 2)
    expect(b).toEqual([{ id: 2, text: 'A' }])
  })
})
