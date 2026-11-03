import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { patchMonacoSuggest } from '../scripts/monaco-suggest-patch.mjs'
const path = createRequire(import.meta.url).resolve(
  'monaco-editor/editor/contrib/suggest/browser/suggestModel.js'
)
const source = patchMonacoSuggest(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
it('applies idempotently and rejects a changed upstream target', () => {
  expect(patchMonacoSuggest(source)).toBe(source)
  expect(() => patchMonacoSuggest('changed')).toThrow(/target changed/)
})
it.each(['idle', 'loading'])(
  'cleans an inline completion wait resolving %s without adding to a disposed store',
  (status) => {
    const subscriptions: { dispose: ReturnType<typeof vi.fn> }[] = []
    let observe!: () => void
    const inlineModel = {
      state: { get: () => null, read: () => null },
      status: { read: () => status },
      stop: vi.fn()
    }
    let current: typeof inlineModel | null = inlineModel
    const editorModel = { getVersionId: () => 1 }
    const trigger = vi.fn()
    const start = source.indexOf(
      '\n    _waitForInlineCompletionsAndTrigger(initialModel, initialPosition)'
    )
    const end = source.indexOf('\n    _refilterCompletionItems()', start)
    const methods = runInNewContext('({' + source.slice(start, end) + '})', {
      getInlineCompletionsController: () => ({
        model: { get: () => current, read: () => current }
      }),
      DisposableStore: class {
        isDisposed = false
        items: { dispose: () => void }[] = []
        add(item: { dispose: () => void }): void {
          if (this.isDisposed) throw new Error('added after disposal')
          this.items.push(item)
        }
        dispose(): void {
          if (this.isDisposed) return
          this.isDisposed = true
          this.items.forEach((item) => item.dispose())
        }
      },
      disposableTimeout: (
        _fn: () => void,
        _delay: number,
        store: { add: (item: { dispose: () => void }) => void }
      ) => store.add({ dispose: vi.fn() }),
      autorun: (fn: () => void) => {
        observe = fn
        fn()
        const subscription = { dispose: vi.fn() }
        subscriptions.push(subscription)
        return subscription
      }
    })
    const target = Object.assign(methods, {
      trigger,
      _editor: {
        getModel: () => editorModel,
        getPosition: () => ({ equals: () => true }),
        hasWidgetFocus: () => true
      }
    })
    target._waitForInlineCompletionsAndTrigger(editorModel, {})
    if (status === 'loading') {
      current = null
      observe()
    }
    expect(subscriptions[0].dispose).toHaveBeenCalledOnce()
    expect(target._waitForInlineCompletions).toBeUndefined()
    expect(trigger).toHaveBeenCalledTimes(status === 'idle' ? 1 : 0)
  }
)
