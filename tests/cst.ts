import { CST, Parser } from 'yaml'
import { source } from './_utils.ts'

function cstDoc(src: string) {
  const tokens = Array.from(new Parser().parse(src))
  expect(tokens).toHaveLength(1)
  expect(tokens[0].type).toBe('document')
  return tokens[0] as CST.Document
}

describe('CST.visit', () => {
  test('Visit paths in order', () => {
    const doc = cstDoc(source`
      foo:
        - baz
        - [ bar: 42 ]
      ? { fuzz, ball }
      : fii
    `)
    const paths: CST.VisitPath[] = []
    CST.visit(doc, (_item, path) => {
      paths.push(path)
    })
    expect(paths).toMatchObject([
      [],
      [['value', 0]],
      [
        ['value', 0],
        ['value', 0]
      ],
      [
        ['value', 0],
        ['value', 1]
      ],
      [
        ['value', 0],
        ['value', 1],
        ['value', 0]
      ],
      [['value', 1]],
      [
        ['value', 1],
        ['key', 0]
      ],
      [
        ['value', 1],
        ['key', 1]
      ]
    ])
  })

  test('break visit', () => {
    const doc = cstDoc(source`
      - " foo"
      - "foo"
      - "bar"
    `)
    let visits = 0
    CST.visit(doc, item => {
      visits += 1
      const scalar = CST.resolveAsScalar(item.value)
      if (scalar?.value === 'foo') return CST.visit.BREAK
    })
    expect(visits).toBe(3)
  })

  test('remove item', () => {
    const doc = cstDoc(source`
      -  " foo"
      - "foo"
      - "bar"
    `)
    let visits = 0
    CST.visit(doc, item => {
      visits += 1
      const scalar = CST.resolveAsScalar(item.value)
      if (scalar?.value === 'foo') return CST.visit.REMOVE
    })
    expect(visits).toBe(4)
    expect(CST.stringify(doc)).toBe(source`
      -  " foo"
      - "bar"
    `)
  })

  test('replace value with block scalar in seq', () => {
    const doc = cstDoc(source`
      -  " foo"
      - "foo"
      - "bar"
    `)
    let visits = 0
    CST.visit(doc, item => {
      visits += 1
      if (item.value) {
        const scalar = CST.resolveAsScalar(item.value)
        if (scalar?.value === 'foo')
          CST.setScalarValue(item.value, 'foo', { type: 'BLOCK_LITERAL' })
      }
    })
    expect(visits).toBe(4)
    expect(CST.stringify(doc)).toBe(source`
      -  " foo"
      - |-
        foo
      - "bar"
    `)
  })

  test('add item', () => {
    const doc = cstDoc(source`
      -  " foo"
      - "foo"
      - "bar"
    `)
    let visits = 0
    CST.visit(doc, (item, path) => {
      visits += 1
      if (CST.isScalar(item.value)) {
        const scalar = CST.resolveAsScalar(item.value)
        if (scalar?.value === 'foo') {
          const parent = CST.visit.parentCollection(doc, path)
          const idx = path[path.length - 1][1]
          const { indent } = item.value
          parent.items.splice(idx, 0, {
            start: item.start.slice(),
            value: CST.createScalarToken('hip', { indent })
          })
          return idx + 2
        }
      }
    })
    expect(visits).toBe(4)
    expect(CST.stringify(doc)).toBe(source`
      -  " foo"
      - hip
      - "foo"
      - "bar"
    `)
  })

  test('replace value with flow scalar in map', () => {
    const doc = cstDoc(source`
      - a:  A
        b: B\t#comment
        c: C
    `)
    let visits = 0
    CST.visit(doc, item => {
      visits += 1
      if (item.value) {
        const scalar = CST.resolveAsScalar(item.value)
        if (scalar?.value === 'B') {
          CST.setScalarValue(item.value, 'foo\n\nbar', { afterKey: !!item.key })
        }
      }
    })
    expect(visits).toBe(5)
    expect(CST.stringify(doc)).toBe(source`
      - a:  A
        b: foo


          bar\t#comment
        c: C
    `)
  })

  test('skip children', () => {
    const doc = cstDoc(source`
      - " foo"
      - [ foo, 13, 42 ]
      - "bar"
    `)
    let visits = 0
    CST.visit(doc, item => {
      visits += 1
      if (item.value?.type === 'flow-collection') return CST.visit.SKIP
    })
    expect(visits).toBe(4)
  })

  test('set next index', () => {
    const doc = cstDoc(source`
      - "foo"
      - [ foo, 13, 42 ]
      - "bar"
    `)
    let visits = 0
    CST.visit(doc, item => {
      visits += 1
      const scalar = CST.resolveAsScalar(item.value)
      if (scalar?.value === 'foo') return 2
    })
    expect(visits).toBe(3)
  })
})

test('Line comment before unindented block-seq in block-map (#525)', () => {
  const src = 'a:\n#\n- b'
  const [doc] = Array.from(new Parser().parse(src))
  expect(CST.stringify(doc)).toBe(src)
})

test('Blank line after empty tagged map value in seq (#717)', () => {
  const src = '- x: !!null\n\n- y\n'
  const [doc] = Array.from(new Parser().parse(src)) as [CST.Document]
  const seq = doc.value as CST.BlockSequence
  const map = seq.items[0].value as CST.BlockMap
  const pair = map.items[0]

  expect(pair.sep?.map(token => token.type)).toEqual([
    'map-value-ind',
    'space',
    'tag',
    'newline'
  ])
  expect(seq.items[1].start.map(token => token.type)).toEqual([
    'newline',
    'seq-item-ind',
    'space'
  ])
})

test.each([
  ['indented comment', '- x: !!null\n\n    # c\n- y\n'],
  ['multiple blank lines', '- x: !!null\n\n\n- y\n'],
  ['CRLF', '- x: !!null\r\n\r\n- y\r\n'],
  ['nested map', '- a:\n    x: !!null\n\n- y\n'],
  ['nested anchored map', '- a:\n    x: &a\n\n- y\n']
])('preserves source layout for #717 %s', (_name, src) => {
  const [doc] = Array.from(new Parser().parse(src))
  expect(CST.stringify(doc)).toBe(src)
})

test('does not move a blank line after an untagged empty map value', () => {
  const src = '- x:\n\n- y\n'
  const [doc] = Array.from(new Parser().parse(src)) as [CST.Document]
  const seq = doc.value as CST.BlockSequence
  const map = seq.items[0].value as CST.BlockMap
  const pair = map.items[0]

  expect(pair.sep?.map(token => token.type)).toEqual([
    'map-value-ind',
    'newline',
    'newline'
  ])
  expect(seq.items[1].start.map(token => token.type)).toEqual([
    'seq-item-ind',
    'space'
  ])
})
