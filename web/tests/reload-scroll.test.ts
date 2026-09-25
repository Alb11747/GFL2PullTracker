import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
const bootstrap = [...html.matchAll(/<script nonce="%sveltekit.nonce%">([\s\S]*?)<\/script>/g)][1][1];
test('reload reservation is scoped to fresh same-page reloads with valid dimensions', () => {
  const valid = {path:'/statistics', y:1800, height:4000, time:Date.now()};
  for (const [saved, type, hash, expected] of [
    [valid, 'reload', '', true], [valid, 'navigate', '', false],
    [valid, 'back_forward', '', false], [valid, 'reload', '#math', false],
    [{...valid,path:'/history'}, 'reload', '', false],
    [{...valid,time:0}, 'reload', '', false],
    [{...valid,height:1e12}, 'reload', '', false],
    [{...valid,y:0}, 'reload', '', false],
    [null, 'reload', '', false]
  ] as const) {
    const dataset: Record<string,string> = {};
    const styles: Record<string,string> = {};
    runInNewContext(bootstrap, {
      performance:{getEntriesByType:()=>[{type}]},
      sessionStorage:{getItem:()=>JSON.stringify(saved)},
      location:{pathname:'/statistics',search:'',hash},
      document:{documentElement:{dataset,style:{setProperty:(k:string,v:string)=>styles[k]=v}}}
    });
    assert.equal(Boolean(dataset.reloadScroll), expected);
    if (expected) assert.equal(styles['--reload-height'],'4000px');
  }
});
