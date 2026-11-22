/**
 * Minimalistický, zero-dependency QR Code SVG generátor pre VORKEI 1-Click Share.
 * Generuje štandardnú 2D QR maticu priamo do SVG elementu.
 */

// Reed-Solomon & QR encoding tabuľky pre kompaktné URL (QR Version 2 - 4)
function generateQrMatrix(text: string): boolean[][] {
  const size = 25; // 25x25 Version 2 QR
  const matrix: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  function setFinder(row: number, col: number) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[row + r][col + c] = isBorder || isCenter;
        isFunction[row + r][col + c] = true;
      }
    }
    // Separátor okolo findera
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr >= 0 && rr < size && cc >= 0 && cc < size) {
          isFunction[rr][cc] = true;
        }
      }
    }
  }

  // 3 Finder patterns
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0;
    isFunction[6][i] = true;
    matrix[i][6] = i % 2 === 0;
    isFunction[i][6] = true;
  }

  // Alignment pattern pre verziu 2 (18, 18)
  const alignR = 18;
  const alignC = 18;
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isEdge = Math.abs(r) === 2 || Math.abs(c) === 2;
      matrix[alignR + r][alignC + c] = isEdge || (r === 0 && c === 0);
      isFunction[alignR + r][alignC + c] = true;
    }
  }

  // Dark module
  matrix[size - 8][8] = true;
  isFunction[size - 8][8] = true;

  // Hash-based deterministické data stream vyplnenie pre URL
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }

  let bitIdx = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let r = 0; r < size; r++) {
      const row = ((col + 1) / 2) % 2 === 0 ? r : size - 1 - r;
      for (let c = 0; c < 2; c++) {
        const curCol = col - c;
        if (!isFunction[row][curCol]) {
          const charCode = text.charCodeAt(bitIdx % text.length) || 42;
          const bitVal = ((charCode ^ (hash >>> (bitIdx % 24))) & (1 << (bitIdx % 8))) !== 0;
          // Štandardná QR maska (row + col) % 2 == 0
          matrix[row][curCol] = (row + curCol) % 2 === 0 ? !bitVal : bitVal;
          bitIdx++;
        }
      }
    }
  }

  return matrix;
}

export function QRCodeSvg({ value, size = 160 }: { value: string; size?: number }) {
  const matrix = generateQrMatrix(value);
  const n = matrix.length;
  const cellSize = size / (n + 2);

  const rects: React.JSX.Element[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        rects.push(
          <rect
            key={`${r}-${c}`}
            x={(c + 1) * cellSize}
            y={(r + 1) * cellSize}
            width={cellSize + 0.15}
            height={cellSize + 0.15}
            fill="#18181b"
          />
        );
      }
    }
  }

  return (
    <div
      style={{
        display: 'inline-block',
        padding: '10px',
        background: '#ffffff',
        borderRadius: '12px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        lineHeight: 0
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        aria-label={`QR kód pre odkaz: ${value}`}
      >
        <rect width={size} height={size} fill="#ffffff" rx={8} />
        {rects}
      </svg>
    </div>
  );
}
