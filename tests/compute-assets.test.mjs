import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/http.mjs';

test('计算 Worker 可以加载 WASM，普通页面保持禁止动态脚本求值', async () => {
  const server = await startServer({ port: 0 });
  try {
    for (const path of ['', 'overview.mjs', 'mechanic-files.mjs', 'force-simulation.mjs', 'force-geometry.mjs', 'hierarchical-layout.mjs', 'graph-compute-worker.js', 'domain/hover-details.mjs', 'vendor/webcola.js', 'vendor/libavoid/index.js', 'vendor/libavoid/libavoid.wasm']) {
      const response = await fetch(new URL(path, server.url));
      assert.equal(response.status, 200, path);
      const policy = response.headers.get('content-security-policy');
      assert.equal(policy.includes("'unsafe-eval'"), path === 'graph-compute-worker.js');
      assert.match(policy, /default-src 'self'; script-src 'self'/);
      if (/\.m?js$/.test(path)) assert.match(response.headers.get('content-type'), /^text\/javascript\b/, path);
      if (path.endsWith('.wasm')) {
        assert.equal(response.headers.get('content-type'), 'application/wasm');
        assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)], [0, 97, 115, 109]);
      }
    }
    const retired = await fetch(new URL('view-files.mjs', server.url));
    assert.equal(retired.status, 404, '网页不再加载旧视图保存模块');
  } finally { await server.close(); }
});
