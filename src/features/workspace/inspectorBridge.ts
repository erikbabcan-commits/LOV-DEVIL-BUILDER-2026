/**
 * VORKEI Visual Click-to-Edit Inspector Bridge
 * Ľahký mostík injektovaný do preview iframe na interaktívne inšpekovanie a výber prvkov.
 */

export interface InspectedElement {
  tag: string;
  text: string;
  selector: string;
  outerHTML: string;
}

export const INSPECTOR_MESSAGE_TYPE = 'VORKEI_INSPECT_ELEMENT' as const;
export const INSPECTOR_SET_MODE_TYPE = 'VORKEI_SET_EDIT_MODE' as const;
export const INSPECTOR_CLEAR_TYPE = 'VORKEI_CLEAR_INSPECTION' as const;

export function getInspectorBridgeScript(initialEditMode = false): string {
  return `<script id="__vorkei_inspector_bridge">
(function() {
  if (window.__vorkei_inspector_installed) return;
  window.__vorkei_inspector_installed = true;

  var active = ${initialEditMode ? 'true' : 'false'};
  var selectedEl = null;
  var hoveredEl = null;

  var overlay = document.createElement('div');
  overlay.id = '__vorkei_inspector_overlay';
  overlay.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:2147483647;border:2px solid #4ADE80;background:rgba(74,222,128,0.12);box-shadow:0 0 12px rgba(74,222,128,0.35);border-radius:4px;transition:top 0.05s ease-out,left 0.05s ease-out,width 0.05s ease-out,height 0.05s ease-out;box-sizing:border-box;';

  var badge = document.createElement('span');
  badge.id = '__vorkei_inspector_badge';
  badge.style.cssText = 'position:absolute;bottom:100%;left:0;margin-bottom:4px;background:#171717;color:#4ADE80;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;border:1px solid #4ADE80;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5);pointer-events:none;display:inline-flex;align-items:center;gap:3px;line-height:16px;';

  overlay.appendChild(badge);

  function ensureAttached() {
    if (document.body && !document.body.contains(overlay)) {
      document.body.appendChild(overlay);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureAttached);
  } else {
    ensureAttached();
  }

  function getCssSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var path = [];
    var curr = el;
    while (curr && curr.nodeType === 1 && curr !== document.documentElement && curr !== document.body) {
      var sel = curr.tagName.toLowerCase();
      if (curr.id) {
        sel += '#' + curr.id;
        path.unshift(sel);
        break;
      }
      if (curr.className && typeof curr.className === 'string') {
        var parts = curr.className.trim().split(/\\s+/).filter(Boolean);
        if (parts.length) {
          sel += '.' + parts.slice(0, 2).join('.');
        }
      }
      var count = 1;
      var sib = curr.previousElementSibling;
      while (sib) {
        if (sib.tagName === curr.tagName) count++;
        sib = sib.previousElementSibling;
      }
      if (count > 1) sel += ':nth-of-type(' + count + ')';
      path.unshift(sel);
      curr = curr.parentElement;
    }
    return path.join(' > ') || el.tagName.toLowerCase();
  }

  function updateOverlay(el) {
    if (!el || !document.body.contains(el)) {
      overlay.style.display = 'none';
      return;
    }
    ensureAttached();
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      overlay.style.display = 'none';
      return;
    }
    overlay.style.top = Math.max(0, rect.top) + 'px';
    overlay.style.left = Math.max(0, rect.left) + 'px';
    overlay.style.width = Math.max(20, rect.width) + 'px';
    overlay.style.height = Math.max(20, rect.height) + 'px';
    overlay.style.display = 'block';

    var tag = el.tagName.toLowerCase();
    var cls = '';
    if (el.className && typeof el.className === 'string') {
      var parts = el.className.trim().split(/\\s+/).filter(Boolean);
      if (parts.length) cls = '.' + parts[0];
    }
    badge.textContent = '<' + tag + cls + '>';
    if (rect.top < 26) {
      badge.style.bottom = 'auto';
      badge.style.top = '100%';
      badge.style.marginTop = '4px';
      badge.style.marginBottom = '0';
    } else {
      badge.style.bottom = '100%';
      badge.style.top = 'auto';
      badge.style.marginTop = '0';
      badge.style.marginBottom = '4px';
    }
  }

  function onMouseMove(e) {
    if (!active) return;
    var target = e.target;
    if (!target || target === overlay || target === badge || target === document.documentElement || target === document.body) {
      if (!selectedEl) overlay.style.display = 'none';
      return;
    }
    hoveredEl = target;
    updateOverlay(hoveredEl);
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    var target = e.target;
    if (!target || target === overlay || target === badge || target === document.documentElement || target === document.body) return;

    selectedEl = target;
    updateOverlay(selectedEl);

    var tag = target.tagName.toLowerCase();
    var text = (target.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
    var selector = getCssSelector(target);
    var outerHTML = target.outerHTML ? target.outerHTML.slice(0, 600) : '';

    try {
      window.parent.postMessage({
        type: 'VORKEI_INSPECT_ELEMENT',
        tag: tag,
        text: text,
        selector: selector,
        outerHTML: outerHTML
      }, '*');
    } catch (err) {}
  }

  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('click', onClick, true);

  window.addEventListener('message', function(ev) {
    if (!ev.data) return;
    if (ev.data.type === 'VORKEI_SET_EDIT_MODE') {
      active = !!ev.data.enabled;
      if (!active) {
        selectedEl = null;
        hoveredEl = null;
        overlay.style.display = 'none';
        try { document.body.style.cursor = ''; } catch(e){}
      } else {
        try { document.body.style.cursor = 'crosshair'; } catch(e){}
      }
    }
    if (ev.data.type === 'VORKEI_CLEAR_INSPECTION') {
      selectedEl = null;
      hoveredEl = null;
      overlay.style.display = 'none';
    }
  });

  if (active) {
    try { document.body.style.cursor = 'crosshair'; } catch(e){}
  }
})();
</script>`;
}

export function injectInspectorBridge(html: string, initialEditMode = false): string {
  if (!html) return html;
  if (html.includes('id="__vorkei_inspector_bridge"')) return html;
  const script = getInspectorBridgeScript(initialEditMode);
  if (html.includes('</body>')) {
    return html.replace('</body>', script + '</body>');
  }
  return html + script;
}
