/** Fixed scripts shared by page reading, snapshots and interaction. Never accepts page instructions. */
export const browserDOM = `
const basicVisible = el => {
  const r = el.getBoundingClientRect(); const s = el.ownerDocument.defaultView.getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
};
const collectRoot = root => {
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    if (out.length >= 10000) break;
    out.push(el); if (el.shadowRoot) out.push(...collectRoot(el.shadowRoot));
  }
  return out;
};
const documents = []; const frames = []; let framesTruncated = false;
const visit = (doc, frame, shown) => {
  if (frames.length >= 32) { framesTruncated = true; return; }
  const nodes = collectRoot(doc);
  documents.push({doc, frame, visible:shown, nodes});
  frames.push({frame,url:doc.location.href,title:doc.title,accessible:true,visible:shown,readyState:doc.readyState});
  let index = 0;
  for (const el of nodes) if (el.localName === 'iframe' || el.localName === 'frame') {
    const path = frame+'/'+index++; const visible = shown && basicVisible(el);
    if (frames.length >= 32) { framesTruncated = true; break; }
    let child; try { child = el.contentDocument; if (child) void child.location.href; } catch { child = null; }
    if (child) visit(child, path, visible);
    else frames.push({frame:path,url:el.src || '',accessible:false,visible,reason:'Cross-origin, sandboxed, or not yet loaded; child content is unavailable'});
  }
};
visit(document, 'main', true);
const scope = frame => {
  const items = documents.filter(d => !frame || d.frame === frame);
  if (frame && !items.length) throw new Error('Frame is unavailable: '+frame+'; inspect snapshot.frames again');
  return items;
};
const matches = (selector, frame) => scope(frame).flatMap(d => {
  const roots = [d.doc,...d.nodes.filter(el=>el.shadowRoot).map(el=>el.shadowRoot)];
  return [...new Set(roots.flatMap(root=>Array.from(root.querySelectorAll(selector))))];
});
const current = el => el?.isConnected && documents.some(d=>d.doc === el.ownerDocument);
const visible = el => current(el) && documents.find(d=>d.doc === el.ownerDocument)?.visible && basicVisible(el);
const collect = () => documents.filter(d=>d.visible).flatMap(d=>d.nodes);
const frameOf = el => documents.find(d=>d.doc === el?.ownerDocument)?.frame;
const elementName = el => el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id=>el.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim() || Array.from(el.labels || []).map(label=>label.innerText).join(' ') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
const elementContext = el => {
  const container = el.closest('tr,[role="row"],li,[role="listitem"],[role="dialog"],dialog,fieldset,article,section') || el.parentElement;
  return (container?.innerText || '').replace(/\\s+/g,' ').trim().slice(0,800);
};
const pageText = () => documents.filter(d=>d.visible).map(d=> {
  const text = [d.doc.body?.innerText || '',...d.nodes.filter(el=>el.shadowRoot).map(el=>el.shadowRoot.textContent || '')].filter(Boolean).join('\\n');
  return d.frame === 'main' ? text : '[Frame '+d.frame+': '+d.doc.title+']\\n'+text;
}).join('\\n');
const resolve = (ref, selector, frame) => {
  let el;
  if (ref) {
    el = globalThis.__atBrowserRefs?.get(ref);
    if (frame && frameOf(el) !== frame) throw new Error('Ref belongs to a different frame; use its snapshot frame');
  } else {
    const found = matches(selector, frame).filter(visible);
    if (found.length !== 1) throw new Error('Selector must match exactly one visible element across accessible frames (matched '+found.length+'); call snapshot with this selector and frame, then choose a ref by context. Candidates: '+JSON.stringify(found.slice(0,10).map(el=>({frame:frameOf(el),name:elementName(el).slice(0,200),context:elementContext(el)}))));
    el = found[0];
  }
  if (!current(el)) throw new Error('Element ref is stale or missing; call snapshot again');
  if (!visible(el)) throw new Error('Element or its containing frame is hidden; inspect the page again');
  return el;
};
`
