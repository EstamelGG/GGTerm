/** Runs only in an isolated browser world. No app bridge is exposed to websites. */
export const cancelPickerScript = 'globalThis.__atPickerCancel?.()'
export function pickerScript(accent: string): string {
  return `(() => {
    globalThis.__atPickerCancel?.();
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid;box-sizing:border-box;display:none;';
      overlay.style.borderColor = ${JSON.stringify(accent)};
      document.documentElement.append(overlay);
      let timer;
      const cleanup = () => {
        clearTimeout(timer); overlay.remove();
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
        delete globalThis.__atPickerCancel;
      };
      const finish = value => { cleanup(); resolve(value); };
      globalThis.__atPickerCancel = () => finish(null);
      const move = event => {
        const element = event.composedPath().find(node => node instanceof Element);
        if (!element) return;
        const rect = element.getBoundingClientRect();
        Object.assign(overlay.style, {display:'block',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
      };
      const click = event => {
        event.preventDefault(); event.stopImmediatePropagation();
        const element = event.composedPath().find(node => node instanceof Element);
        if (!element) return;
        const parts = []; let node = element;
        while (node && node.nodeType === 1) {
          const tag = node.localName;
          if (node.id && document.querySelectorAll('#'+CSS.escape(node.id)).length === 1) { parts.unshift('#'+CSS.escape(node.id)); break; }
          const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(child => child.localName === tag) : [];
          parts.unshift(tag+(siblings.length > 1 ? ':nth-of-type('+(siblings.indexOf(node)+1)+')' : ''));
          node = node.parentElement;
        }
        const clone = element.cloneNode(true);
        clone.querySelectorAll('script,style').forEach(node => node.remove());
        [clone, ...clone.querySelectorAll('*')].forEach(node => {
          for (const attr of Array.from(node.attributes)) if (/^on/i.test(attr.name) || attr.name === 'value') node.removeAttribute(attr.name);
        });
        finish({url:location.href,title:document.title,element:{selector:parts.join(' > ').slice(0,2000),tagName:element.tagName.toLowerCase(),text:(element.innerText || element.textContent || '').slice(0,12000),html:clone.outerHTML.slice(0,8000)}});
      };
      const key = event => { if (event.key === 'Escape') {event.preventDefault();event.stopImmediatePropagation();finish(null);} };
      document.addEventListener('pointermove', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
      timer = setTimeout(() => finish(null), 120000);
    });
  })()`
}
