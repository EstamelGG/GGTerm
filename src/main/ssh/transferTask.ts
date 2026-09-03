/** Each task owns its channels/streams; cancellation never closes the shared terminal connection. */
export class TransferTask {
  readonly controller = new AbortController()
  private readonly disposers = new Set<() => void>()

  get signal(): AbortSignal {
    return this.controller.signal
  }

  own(dispose: () => void): void {
    if (this.signal.aborted) dispose()
    else this.disposers.add(dispose)
  }

  cancel(): void {
    this.controller.abort()
    this.dispose()
  }

  dispose(): void {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        /* connection may already be closed */
      }
    }
    this.disposers.clear()
  }

  /** Handle channels which finish opening after cancellation as well as callbacks that never arrive. */
  async opening<T>(promise: Promise<T>, close: (resource: T) => void): Promise<T> {
    const owned = promise.then((resource) => {
      this.own(() => close(resource))
      return resource
    })
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(new Error('Transfer canceled'))
      this.signal.addEventListener('abort', abort, { once: true })
      owned.then(resolve, reject).finally(() => this.signal.removeEventListener('abort', abort))
      if (this.signal.aborted) abort()
    })
  }
}
