(() => {
  if (window !== top) return;
  const ids = new WeakMap(); let seq = 0;
  const id = n => { if (!ids.has(n)) ids.set(n, ++seq); return ids.get(n); };
  const label = n => n.nodeType === 1 ? n.localName + (n.classList.length ? '.' + [...n.classList].join('.') : '') : '#' + n.nodeName;
  const region = n => { const e = n.nodeType === 1 ? n : n.parentElement; return e?.closest('.chat-thread') ? 'thread' : e?.closest('openclaw-chat-pane') ? 'pane' : null; };
  const row = n => (n.nodeType === 1 ? n : n.parentElement)?.closest('[data-virtual-row-key]');
  const records = [], operations = [], rowEvents = [];
  let firstRow = null;
  const observer = new MutationObserver(rs => {
    const at = performance.now();
    if (at > 3200) { observer.disconnect(); return; }
    for (const r of rs) {
      const rg = region(r.target); if (!rg) continue;
      const rr = row(r.target);
      records.push({t: at, region: rg, target: label(r.target), id: id(r.target), row: rr?.getAttribute('data-virtual-row-key'), rowId: rr ? id(rr) : null, type: r.type, attr: r.attributeName, old: r.oldValue, value: r.type === 'attributes' ? r.target.getAttribute(r.attributeName) : r.type === 'characterData' ? r.target.nodeValue : null, added: [...r.addedNodes].map(n => ({id:id(n), label:label(n)})), removed: [...r.removedNodes].map(n => ({id:id(n), label:label(n)}))});
      for (const [kind, nodes] of [['add', r.addedNodes], ['remove', r.removedNodes]]) {
        for (const n of nodes) {
          if (n.nodeType !== 1) continue;
          const rows = [...(n.matches('[data-virtual-row-key]') ? [n] : []), ...n.querySelectorAll('[data-virtual-row-key]')];
          for (const e of rows) {
            if (firstRow === null && kind === 'add') firstRow = at;
            rowEvents.push({ t:at, kind, key:e.getAttribute('data-virtual-row-key'), id:id(e) });
          }
        }
      }
    }
  });
  observer.observe(document, {subtree:true, childList:true, attributes:true, characterData:true, attributeOldValue:true, characterDataOldValue:true});
  if (new URL(location.href).searchParams.has('l64stacks')) {
    for (const [proto, names] of [[Node.prototype, ['insertBefore','appendChild','removeChild','replaceChild']], [Element.prototype,['setAttribute','removeAttribute','replaceChildren']]]) {
      for (const name of names) {
        const original = proto[name];
        proto[name] = function(...args) {
          if (performance.now() < 3200 && region(this)) operations.push({t:performance.now(), op:name, target:label(this), id:id(this), attr:name.includes('Attribute') ? args[0] : null, stack:new Error().stack});
          return original.apply(this,args);
        };
      }
    }
    for (const [proto, names] of [[Node.prototype,['textContent','nodeValue']], [Element.prototype,['innerHTML','className']]]) {
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(proto,name);
        if (!descriptor?.set) continue;
        Object.defineProperty(proto,name,{...descriptor,set(value){
          if(performance.now()<3200 && region(this)) operations.push({t:performance.now(),op:name,target:label(this),id:id(this),stack:new Error().stack});
          return descriptor.set.call(this,value);
        }});
      }
    }
  }
  window.__l64 = {read:()=>({records,operations,rowEvents,firstRow, rows:[...document.querySelectorAll('[data-virtual-row-key]')].map(e=>({key:e.getAttribute('data-virtual-row-key'),id:id(e)}))})};
})();
