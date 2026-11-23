/**
 * Framework Icons 1:1 SVG components for high-DPI zero-network-latency rendering
 */

export function FrameworkIcon({ id, size = 32 }: { id: string; size?: number }) {
  const s = { width: size, height: size, display: 'inline-block', verticalAlign: 'middle' };

  if (id.includes('react')) {
    return (
      <svg style={s} viewBox="-11.5 -10.23174 23 20.46348">
        <circle cx="0" cy="0" r="2.05" fill="#61dafb"/>
        <g stroke="#61dafb" strokeWidth="1" fill="none">
          <ellipse rx="11" ry="4.2"/>
          <ellipse rx="11" ry="4.2" transform="rotate(60)"/>
          <ellipse rx="11" ry="4.2" transform="rotate(120)"/>
        </g>
      </svg>
    );
  }

  if (id.includes('next')) {
    return (
      <svg style={s} viewBox="0 0 180 180">
        <mask id={`mask_${id}`} maskUnits="userSpaceOnUse" x="0" y="0" width="180" height="180">
          <circle cx="90" cy="90" r="90" fill="black"/>
        </mask>
        <circle cx="90" cy="90" r="88" fill="#000" stroke="#333" strokeWidth="2"/>
        <path d="M149.5 157.5L69.1 54H54V126H66.1V69.4L140 164.8C143.3 162.6 146.5 160.2 149.5 157.5Z" fill="#fff"/>
        <rect x="115" y="54" width="12" height="72" fill="#fff"/>
      </svg>
    );
  }

  if (id.includes('angular')) {
    return (
      <svg style={s} viewBox="0 0 250 250">
        <defs>
          <linearGradient id="ang_grad_ui" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#E91E63"/>
            <stop offset="50%" stopColor="#BD10E0"/>
            <stop offset="100%" stopColor="#9C27B0"/>
          </linearGradient>
        </defs>
        <polygon points="125,18 226,54 209,190 125,236 41,190 24,54" fill="url(#ang_grad_ui)"/>
        <polygon points="125,48 190,180 162,180 148,148 102,148 88,180 60,180" fill="#ffffff"/>
        <polygon points="125,82 110,124 140,124" fill="url(#ang_grad_ui)"/>
      </svg>
    );
  }

  if (id.includes('astro')) {
    return (
      <svg style={s} viewBox="0 0 256 364">
        <defs>
          <linearGradient id="astro_grad_ui" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#BC52EE"/>
            <stop offset="100%" stopColor="#6D28D9"/>
          </linearGradient>
          <linearGradient id="astro_flame_ui" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FF5D01"/>
            <stop offset="100%" stopColor="#FFBD38"/>
          </linearGradient>
        </defs>
        <path d="M128 0C128 0 88 56 88 140C88 196 116 236 128 252C140 236 168 196 168 140C168 56 128 0 128 0Z" fill="url(#astro_grad_ui)"/>
        <path d="M128 252C118 274 100 300 80 320C110 324 140 310 152 290C140 278 132 264 128 252Z" fill="url(#astro_flame_ui)"/>
        <path d="M64 164C64 164 40 196 40 248C56 248 80 240 96 228C84 204 74 182 64 164Z" fill="url(#astro_grad_ui)"/>
        <path d="M192 164C192 164 216 196 216 248C200 248 176 240 160 228C172 204 182 182 192 164Z" fill="url(#astro_grad_ui)"/>
      </svg>
    );
  }

  // Vite fallback
  return (
    <svg style={s} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="vite_grad1_ui" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#41D1FF"/>
          <stop offset="100%" stopColor="#BD34FE"/>
        </linearGradient>
        <linearGradient id="vite_grad2_ui" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFEA83"/>
          <stop offset="100%" stopColor="#FFDD35"/>
        </linearGradient>
      </defs>
      <path d="M29.5 5.5L16.5 29.5L2.5 5.5L19 3L29.5 5.5Z" fill="url(#vite_grad1_ui)"/>
      <path d="M17.5 4L9 16.5H15.5L13.5 26L23 13.5H16.5L17.5 4Z" fill="url(#vite_grad2_ui)"/>
    </svg>
  );
}
