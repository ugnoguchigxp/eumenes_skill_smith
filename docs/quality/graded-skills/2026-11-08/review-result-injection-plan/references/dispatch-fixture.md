次は標準JavaScriptとNode.js組込みassertだけを使う、待機型の設計例である。対象orchestratorのAPIを再現したものではない。注入省略をundefinedとして扱い、選んだ関数を引数1個の独立した関数として呼べる契約を仮定する。実物への採用前に型・this依存・完了契約を照合する。未実行であり、対象システムの合格を示さない。

```js
import assert from 'node:assert/strict';

async function dispatch(result, injected, fallback) {
  const selected = injected === undefined ? fallback : injected;
  return await selected(result);
}

const result = Object.freeze({ reviewId: 'fixture', accepted: true });
const calls = [];
const injected = async value => {
  calls.push(['injected', value]);
  return 'injected-ok';
};
const fallback = async value => {
  calls.push(['default', value]);
  return 'default-ok';
};

assert.equal(await dispatch(result, injected, fallback), 'injected-ok');
assert.deepEqual(calls.map(([name]) => name), ['injected']);
assert.strictEqual(calls[0][1], result);

calls.length = 0;
assert.equal(await dispatch(result, undefined, fallback), 'default-ok');
assert.deepEqual(calls.map(([name]) => name), ['default']);
assert.strictEqual(calls[0][1], result);

for (const asyncFailure of [false, true]) {
  calls.length = 0;
  const failure = new Error('fixture failure');
  const fail = value => {
    calls.push(['injected', value]);
    if (asyncFailure) return Promise.reject(failure);
    throw failure;
  };
  await assert.rejects(dispatch(result, fail, fallback), e => e === failure);
  assert.deepEqual(calls.map(([name]) => name), ['injected']);
}

// 禁止する二重呼出を、同じ排他条件が検出する負例。
calls.length = 0;
await injected(result);
await fallback(result);
assert.throws(
  () => assert.deepEqual(calls.map(([name]) => name), ['injected']),
  { name: 'AssertionError' }
);
```

期待値は、正例の全assertが成立し、意図的な二重呼出だけがassert.throwsで検出されること。権限のある呼出側で実行した場合、未捕捉例外なしの終了をこの例の合格とし、assert失敗や実行環境不足ならそこで停止する。実物のretry動作、非待機型のエラー処理、実記録の成功は検証範囲外である。