import { useStore } from '../stores/useAppStore';

/* Mobile tab rail — port 1:1 (chat/canvas prepínanie + viewport segment). */
export function MobileTabs() {
  const mview = useStore(s => s.mview);
  const viewport = useStore(s => s.viewport);
  const setMview = useStore(s => s.setMview);
  const setViewport = useStore(s => s.setViewport);
  const mode = useStore(s => s.mode);

  if (mode === 'home') return null;

  return (
    <div className="mtabs">
      <button className={'tab-btn' + (mview === 'chat' ? ' active' : '')} data-view="chat" onClick={() => setMview('chat')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></svg>
        Chat
      </button>
      <button className={'tab-btn' + (mview === 'canvas' ? ' active' : '')} data-view="canvas" onClick={() => setMview('canvas')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        Preview
      </button>
      <div className="mvp" id="mvpSeg">
        <button data-vp="desktop" className={viewport === 'desktop' ? 'active' : ''} title="Desktop" onClick={() => setViewport('desktop')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        </button>
        <button data-vp="tablet" className={viewport === 'tablet' ? 'active' : ''} title="Tablet" onClick={() => setViewport('tablet')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/></svg>
        </button>
        <button data-vp="mobile" className={viewport === 'mobile' ? 'active' : ''} title="Mobile" onClick={() => setViewport('mobile')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/></svg>
        </button>
      </div>
    </div>
  );
}
