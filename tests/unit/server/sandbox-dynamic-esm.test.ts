// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildProject } from '../../../server/sandbox/builder';

describe('Dynamic NPM Package Resolver via ESM Import Maps', () => {
  it('resolves lucide-react and canvas-confetti dynamically without local npm install', async () => {
    const files = [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'confetti-app',
          private: true,
          dependencies: {
            'react': '^18.3.1',
            'react-dom': '^18.3.1',
            'lucide-react': '^0.460.0',
            'canvas-confetti': '^1.9.3',
          },
        }),
      },
      {
        path: 'src/main.tsx',
        content: `
          import { createRoot } from "react-dom/client";
          import App from "./App";
          createRoot(document.getElementById("root")!).render(<App />);
        `,
      },
      {
        path: 'src/App.tsx',
        content: `
          import React, { useEffect } from "react";
          import { Heart, Sparkles } from "lucide-react";
          import confetti from "canvas-confetti";

          export default function App() {
            useEffect(() => {
              confetti();
            }, []);

            return (
              <div className="card">
                <h1>Dynamic ESM Sandbox</h1>
                <Heart color="red" />
                <Sparkles color="gold" />
              </div>
            );
          }
        `,
      },
    ];

    const result = await buildProject(files);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.html).toBeTruthy();

    // Verify importmap is injected
    expect(result.html).toContain('<script type="importmap">');
    expect(result.html).toContain('"lucide-react"');
    expect(result.html).toContain('https://esm.sh/lucide-react@0.460.0');
    expect(result.html).toContain('"canvas-confetti"');
    expect(result.html).toContain('https://esm.sh/canvas-confetti@1.9.3');

    // Verify React runtime is mapped in importmap
    expect(result.html).toContain('"react": "https://esm.sh/react@18.3.1"');
    expect(result.html).toContain('"react-dom": "https://esm.sh/react-dom@18.3.1"');
    expect(result.html).toContain('"react-dom/client": "https://esm.sh/react-dom@18.3.1/client"');

    // Verify CSP allows esm.sh
    expect(result.html).toContain('https://esm.sh');
    expect(result.html).toContain("connect-src https://esm.sh");

    // Verify ES module script
    expect(result.html).toContain('<script type="module">');
    expect(result.html).toContain('forge-sandbox-error');
  });

  it('resolves framer-motion and recharts for animations and data charts', async () => {
    const files = [
      {
        path: 'src/main.tsx',
        content: `
          import { createRoot } from "react-dom/client";
          import App from "./App";
          createRoot(document.getElementById("root")!).render(<App />);
        `,
      },
      {
        path: 'src/App.tsx',
        content: `
          import React from "react";
          import { motion } from "framer-motion";
          import { LineChart, Line, ResponsiveContainer } from "recharts";

          export default function App() {
            return (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <ResponsiveContainer width={300} height={200}>
                  <LineChart data={[{ x: 1, y: 10 }, { x: 2, y: 20 }]}>
                    <Line dataKey="y" />
                  </LineChart>
                </ResponsiveContainer>
              </motion.div>
            );
          }
        `,
      },
    ];

    const result = await buildProject(files);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.html).toContain('"framer-motion"');
    expect(result.html).toContain('https://esm.sh/framer-motion@11.11.17');
    expect(result.html).toContain('"recharts"');
    expect(result.html).toContain('https://esm.sh/recharts@2.13.3');
  });

  it('resolves three.js dynamically for 3D graphics', async () => {
    const files = [
      {
        path: 'src/main.tsx',
        content: `
          import { createRoot } from "react-dom/client";
          import * as THREE from "three";

          const scene = new THREE.Scene();
          console.log(scene);
          createRoot(document.getElementById("root")!).render(<div>3D Ready</div>);
        `,
      },
    ];

    const result = await buildProject(files);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.html).toContain('"three"');
    expect(result.html).toContain('https://esm.sh/three@0.170.0');
  });

  it('preserves strict offline IIFE bundling when only standard React is used', async () => {
    const files = [
      {
        path: 'src/main.tsx',
        content: `
          import { createRoot } from "react-dom/client";
          createRoot(document.getElementById("root")!).render(<h1>Plain React</h1>);
        `,
      },
    ];

    const result = await buildProject(files);
    expect(result.ok).toBe(true);
    // When no dynamic packages are used, it stays 100% self-contained offline
    expect(result.html).toContain("connect-src 'none'");
    expect(result.html).not.toContain('<script type="importmap">');
  });

  it('rejects unapproved packages for security', async () => {
    const files = [
      {
        path: 'src/main.tsx',
        content: `
          import x from "unapproved-library";
          console.log(x);
        `,
      },
    ];

    const result = await buildProject(files);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.message.includes('nepovolený import: unapproved-library'))).toBe(true);
  });
});
