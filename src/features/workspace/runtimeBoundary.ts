/**
 * VORKEI AI Self-Healing Error Boundary Bridge
 * Automatická detekcia runtime chýb (React / JS / Unhandled Rejection) v preview iframe
 * a prepojenie na 1-click opravný stream cez AI (Mistral).
 */

export const RUNTIME_CRASH_MESSAGE_TYPE = 'VORKEI_RUNTIME_CRASH_REPAIR' as const;
export const RUNTIME_ERROR_DETECTED_TYPE = 'VORKEI_RUNTIME_ERROR_DETECTED' as const;

export interface RuntimeCrashPayload {
  message: string;
  stack?: string;
  component?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  timestamp?: number;
}

export function getRuntimeBoundaryScript(): string {
  return `<script id="__vorkei_runtime_boundary">
(function() {
  if (window.__vorkei_boundary_installed) return;
  window.__vorkei_boundary_installed = true;

  var lastReportedError = '';
  var lastReportedTime = 0;

  function extractComponentName(stack, msg) {
    if (!stack && !msg) return '';
    var text = (stack || '') + ' ' + (msg || '');
    var match = text.match(/The above error occurred in the <([A-Za-z0-9_]+)>/i)
      || text.match(/in\\s+<([A-Za-z0-9_]+)>/i)
      || text.match(/at\\s+([A-Z][A-Za-z0-9_]+)\\s+\\(/);
    return match && match[1] ? match[1] : '';
  }

  function renderCrashOverlay(payload) {
    var existing = document.getElementById('__vorkei_crash_overlay');
    if (existing) {
      existing.remove();
    }

    var overlay = document.createElement('div');
    overlay.id = '__vorkei_crash_overlay';
    overlay.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 2147483646',
      'background: rgba(10, 11, 14, 0.94)',
      'backdrop-filter: blur(8px)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'padding: 16px',
      'box-sizing: border-box',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'color: #f4f4f5'
    ].join(';') + ';';

    var card = document.createElement('div');
    card.id = '__vorkei_crash_card';
    card.style.cssText = [
      'max-width: 580px',
      'width: 100%',
      'background: #18181b',
      'border: 1px solid rgba(244, 63, 94, 0.45)',
      'box-shadow: 0 20px 40px rgba(0,0,0,0.7), 0 0 25px rgba(244, 63, 94, 0.2)',
      'border-radius: 12px',
      'padding: 22px',
      'display: flex',
      'flex-direction: column',
      'gap: 16px',
      'box-sizing: border-box'
    ].join(';') + ';';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;';

    var titleBox = document.createElement('div');
    titleBox.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

    var badgeRow = document.createElement('div');
    badgeRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

    var badge = document.createElement('span');
    badge.style.cssText = 'background:rgba(244,63,94,0.18);color:#fb7185;border:1px solid rgba(244,63,94,0.35);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;display:inline-flex;align-items:center;gap:4px;';
    badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#fb7185;display:inline-block;"></span> Runtime Crash';

    if (payload.component) {
      var compBadge = document.createElement('code');
      compBadge.style.cssText = 'background:#27272a;color:#a1a1aa;padding:2px 6px;border-radius:4px;font-size:11px;font-family:monospace;';
      compBadge.textContent = '<' + payload.component + '>';
      badgeRow.appendChild(badge);
      badgeRow.appendChild(compBadge);
    } else {
      badgeRow.appendChild(badge);
    }

    var title = document.createElement('h3');
    title.style.cssText = 'margin:4px 0 0 0;font-size:16px;font-weight:700;color:#ffffff;line-height:1.3;';
    title.textContent = 'Aplikácia narazila na runtime chybu';

    var subtitle = document.createElement('p');
    subtitle.style.cssText = 'margin:0;font-size:12px;color:#a1a1aa;line-height:1.4;';
    subtitle.textContent = 'Preview nezostalo biele. Môžeš chybu ihneď opraviť jediným klikom cez AI (Mistral).';

    titleBox.appendChild(badgeRow);
    titleBox.appendChild(title);
    titleBox.appendChild(subtitle);
    header.appendChild(titleBox);

    // Error details container
    var errBox = document.createElement('div');
    errBox.style.cssText = 'background:#121214;border:1px solid #27272a;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;';

    var errMsg = document.createElement('div');
    errMsg.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#fca5a5;font-weight:600;word-break:break-word;line-height:1.4;';
    errMsg.textContent = payload.message || 'Neznáma chyba behu programu.';
    errBox.appendChild(errMsg);

    if (payload.stack) {
      var stackEl = document.createElement('pre');
      stackEl.style.cssText = 'margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;color:#71717a;white-space:pre-wrap;word-break:break-all;line-height:1.4;border-top:1px solid #27272a;padding-top:6px;';
      stackEl.textContent = payload.stack;
      errBox.appendChild(stackEl);
    }

    // Action buttons
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;';

    var dismissBtn = document.createElement('button');
    dismissBtn.id = '__vorkei_dismiss_btn';
    dismissBtn.type = 'button';
    dismissBtn.style.cssText = 'background:transparent;border:1px solid #3f3f46;color:#a1a1aa;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s ease;';
    dismissBtn.textContent = 'Ignorovať';
    dismissBtn.onclick = function() {
      overlay.style.display = 'none';
    };

    var reloadBtn = document.createElement('button');
    reloadBtn.id = '__vorkei_reload_btn';
    reloadBtn.type = 'button';
    reloadBtn.style.cssText = 'background:#27272a;border:1px solid #3f3f46;color:#e4e4e7;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s ease;';
    reloadBtn.textContent = '🔄 Obnoviť náhľad';
    reloadBtn.onclick = function() {
      window.location.reload();
    };

    var repairBtn = document.createElement('button');
    repairBtn.id = '__vorkei_repair_btn';
    repairBtn.type = 'button';
    repairBtn.style.cssText = 'background:linear-gradient(135deg, #f43f5e 0%, #e11d48 100%);border:none;color:#ffffff;padding:7px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 12px rgba(244,63,94,0.35);transition:all 0.15s ease;display:inline-flex;align-items:center;gap:6px;';
    repairBtn.innerHTML = '⚡ Opraviť cez AI (Mistral)';
    repairBtn.onclick = function() {
      repairBtn.disabled = true;
      repairBtn.style.opacity = '0.7';
      repairBtn.style.cursor = 'not-allowed';
      repairBtn.textContent = '⏳ Spúšťam AI opravu...';
      try {
        window.parent.postMessage({
          type: 'VORKEI_RUNTIME_CRASH_REPAIR',
          message: payload.message,
          stack: payload.stack,
          component: payload.component,
          filename: payload.filename,
          lineno: payload.lineno,
          colno: payload.colno
        }, '*');
      } catch (err) {}
    };

    actions.appendChild(dismissBtn);
    actions.appendChild(reloadBtn);
    actions.appendChild(repairBtn);

    card.appendChild(header);
    card.appendChild(errBox);
    card.appendChild(actions);
    overlay.appendChild(card);

    if (document.body) {
      document.body.appendChild(overlay);
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        document.body.appendChild(overlay);
      });
    }
  }

  function handleCrash(msg, stack, comp, filename, lineno, colno) {
    var rawMsg = String(msg || 'Unknown runtime error');
    var now = Date.now();
    // Ochrana pred spamovaním chybovými správami v render loop
    if (rawMsg === lastReportedError && (now - lastReportedTime) < 1500) {
      return;
    }
    lastReportedError = rawMsg;
    lastReportedTime = now;

    var detectedComp = comp || extractComponentName(stack, rawMsg);
    var payload = {
      message: rawMsg,
      stack: stack || '',
      component: detectedComp,
      filename: filename || '',
      lineno: lineno || 0,
      colno: colno || 0,
      timestamp: now
    };

    renderCrashOverlay(payload);

    try {
      window.parent.postMessage({
        type: 'VORKEI_RUNTIME_ERROR_DETECTED',
        message: payload.message,
        stack: payload.stack,
        component: payload.component,
        filename: payload.filename,
        lineno: payload.lineno,
        colno: payload.colno
      }, '*');
    } catch (e) {}
  }

  // 1. window.onerror
  window.onerror = function(message, source, lineno, colno, error) {
    var strMsg = typeof message === 'string' ? message : (error && error.message) || 'Script error';
    var stack = error && error.stack ? error.stack : '';
    handleCrash(strMsg, stack, '', source, lineno, colno);
    return false; // dovoliť bežné spracovanie v konzole
  };

  // 2. unhandledrejection (async / promises)
  window.addEventListener('unhandledrejection', function(event) {
    var reason = event.reason;
    var message = reason instanceof Error ? reason.message : String(reason || 'Unhandled Promise Rejection');
    var stack = reason instanceof Error && reason.stack ? reason.stack : '';
    handleCrash(message, stack, '', '', 0, 0);
  });

  // 3. React error boundary interceptor cez console.error
  var originalConsoleError = console.error;
  console.error = function() {
    var args = Array.prototype.slice.call(arguments);
    var fullText = args.map(function(a) {
      if (a instanceof Error) return a.message + '\\n' + (a.stack || '');
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }
      return String(a);
    }).join(' ');

    if (fullText.indexOf('The above error occurred in the <') !== -1 || fullText.indexOf('React will try to recreate this component tree') !== -1) {
      var comp = extractComponentName(fullText, '');
      var firstArg = args[0];
      var msg = firstArg instanceof Error ? firstArg.message : (typeof firstArg === 'string' ? firstArg : 'React Component Crash');
      var stack = (firstArg instanceof Error && firstArg.stack) ? firstArg.stack : fullText;
      handleCrash(msg, stack, comp);
    }

    if (originalConsoleError) {
      originalConsoleError.apply(console, args);
    }
  };

  // 4. Globálny hook pre vlastné React Error Boundary v sandboxe
  window.__VORKEI_REPORT_REACT_ERROR__ = function(error, errorInfo) {
    var msg = (error && error.message) || 'React Error Boundary Triggered';
    var stack = (error && error.stack) || '';
    var comp = errorInfo && errorInfo.componentStack ? extractComponentName(errorInfo.componentStack, msg) : '';
    handleCrash(msg, stack + (errorInfo && errorInfo.componentStack ? '\\n' + errorInfo.componentStack : ''), comp);
  };
})();
</script>`;
}

export function injectRuntimeBoundary(html: string): string {
  if (!html) return html;
  if (html.includes('id="__vorkei_runtime_boundary"')) return html;
  const script = getRuntimeBoundaryScript();

  // Preferujeme injekciu do <head>, aby bol listener aktívny pred spustením klientského JS
  if (html.includes('<head>')) {
    return html.replace('<head>', '<head>' + script);
  }
  if (html.includes('<head ')) {
    return html.replace(/<head[^>]*>/, match => match + script);
  }
  if (html.includes('<body>')) {
    return html.replace('<body>', '<body>' + script);
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', script + '</body>');
  }
  return script + html;
}
