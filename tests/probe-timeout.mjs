import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { probeProxy } from '../proxy-probe.mjs';

test('configured probe timeout ends a stalled proxy request', async () => {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = performance.now();
  try {
    await assert.rejects(
      probeProxy({ protocol: 'http', server: '127.0.0.1', port: server.address().port }, null, 'ip', 1000),
      /两个出口 IP 服务均未返回有效结果/
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1700 && elapsed < 6000, `unexpected timeout duration: ${elapsed}ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
