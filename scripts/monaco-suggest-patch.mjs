// Monaco 0.56: autorun runs synchronously before store.add receives its disposable.
export function patchMonacoSuggest(source) {
  const before = `        store.add(autorun(reader => {
            const currentInlineModel = inlineController.model.read(reader);`
  const after = `        const subscription = autorun(reader => {
            const currentInlineModel = inlineController.model.read(reader);`
  const tail = `            triggerAndCleanUp(!currentState);
        }));`
  const fixedTail = `            triggerAndCleanUp(!currentState);
        });
        // GGTerm: the initial autorun can synchronously dispose the wait store.
        if (store.isDisposed) subscription.dispose();
        else store.add(subscription);`
  if (source.includes(after) && source.includes(fixedTail)) return source
  if (source.split(before).length !== 2 || source.split(tail).length !== 2)
    throw new Error('Monaco suggest patch target changed; review upstream before updating')
  return source.replace(before, after).replace(tail, fixedTail)
}
