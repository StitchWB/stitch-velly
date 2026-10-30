import test from 'node:test';
import assert from 'node:assert/strict';
import { authDiagnostic, errorPreview } from '../stitch_velly/runtime/auth-diagnostics.mjs';

test('supplier OAuth failure does not recommend Velly sign-in', () => {
  const result = authDiagnostic(529, 'OAuth session expired and could not be refreshed', 200);
  assert.equal(result.source, 'upstream_session');
});
test('401 distinguishes token rejection from model route rejection and network failure', () => {
  assert.equal(authDiagnostic(401, '', 200).source, 'model_route');
  assert.equal(authDiagnostic(401, '', 401).source, 'velly_token');
  assert.equal(authDiagnostic(401, '', null).source, 'unknown');
  assert.equal(authDiagnostic(403, '', 200), null);
});
test('error preview is bounded and preserves original response', async () => {
  const response = new Response('x'.repeat(40000));
  assert.equal((await errorPreview(response)).length, 16384);
  assert.equal((await response.text()).length, 40000);
});
