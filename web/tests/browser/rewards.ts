import { mount, unmount, tick } from 'svelte';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '../../src/app.css';
import RewardFixture from './RewardFixture.svelte';
import LoadingFixture from './LoadingFixture.svelte';
import type { Pull } from '../../src/lib/api';
import { REWARD_RARITIES_KEY } from '../../src/lib/reward-history';

const fixture = document.querySelector<HTMLElement>('#fixture')!;
const summary = document.querySelector<HTMLElement>('#summary')!;
const results = document.querySelector<HTMLElement>('#results')!;
const run = document.querySelector<HTMLButtonElement>('#run')!;
const keys = ['Elite', 'Standard', 'Retired', 'Unknown'];
const labels = ['5★', '4★', '3★', 'Unknown'];
const fixtureItems = [
  { item_id: 1039, name: 'Synthetic Suomi', kind: 'doll', rarity: 'Elite' },
  { item_id: 10132, name: 'Synthetic UMP9', kind: 'weapon', rarity: 'Standard' },
  { item_id: 10131, name: 'Synthetic Retired UMP9', kind: 'weapon', rarity: 'Retired' },
  { item_id: 999999, name: 'Unresolved reward', kind: 'unknown', rarity: 'Unknown' }
];
const eliteItems = [
  fixtureItems[0],
  { item_id: 1013, name: 'Synthetic Lenna', kind: 'doll', rarity: 'Elite' },
  { item_id: 10133, name: 'Synthetic Löwenjunges', kind: 'weapon', rarity: 'Elite' },
  { item_id: 10233, name: 'Synthetic Eulogistic Verse', kind: 'weapon', rarity: 'Elite' }
];
const rows: Pull[] = Array.from({ length: 34 }, (_, index) => {
  const item = index < 4 ? fixtureItems[index] : eliteItems[index % eliteItems.length];
  return {
    id: index + 1,
    ...item,
    name: `${item.name} ${index + 1}`,
    region: null,
    type_id: index === 33 ? 1 : 3,
    pool_id: 301,
    timestamp:
      index < 4 ? '2026-09-20T12:00:00Z' : new Date(Date.UTC(2026, 8, 20 - index)).toISOString(),
    timestamp_order: index < 4 ? [2, 0, 1, 3][index] : 0,
    pity: index + 1,
    pity_uncertain: index < 4,
    gap_before: index === 3,
    quantity: 1,
    source_page: 1,
    estimated_group_size: 1
  };
});
let mounted:
  | {
      changeProfile: () => void;
      replaceRows: (next: Pull[]) => void;
      deferQueries: (value?: boolean) => void;
      pendingCount: () => number;
      finishQuery: (index?: number, error?: string) => void;
      requests: { profileId: string; offset: number; limit: number }[];
    }
  | undefined;
let observing = false;
const runtimeErrors: string[] = [];
function runtimeError(reason: unknown) {
  if (!observing) return;
  runtimeErrors.push(String(reason));
  summary.textContent = 'FAIL: uncaught browser runtime error';
  results.textContent += `RUNTIME ERROR ${String(reason)}\n`;
}
window.addEventListener('error', (event) => runtimeError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => runtimeError(event.reason));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function settle() {
  await tick();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  await tick();
  assert(!runtimeErrors.length, runtimeErrors.join('\n'));
}
async function reload(seed = rows) {
  if (mounted) await unmount(mounted);
  mounted = mount(RewardFixture, { target: fixture, props: { rows: seed } });
  await settle();
}
const cards = () => [
  ...fixture.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')
];
function previousDataIsHidden() {
  return [
    ...fixture.querySelectorAll(
      '.current-pity, .portrait-grid, .history-pagination, .metrics, .rarity-breakdown, .section-heading h2'
    )
  ].every((node) => getComputedStyle(node).visibility === 'hidden');
}
const dialog = () => fixture.querySelector<HTMLDialogElement>('dialog')!;
function checkboxes() {
  return [...fixture.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}
function button(text: string) {
  const element = [...fixture.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === text
  );
  assert(element, `Missing button: ${text}`);
  return element;
}
async function choose(mask: number) {
  for (const [index, input] of checkboxes().entries()) {
    if (input.checked !== Boolean(mask & (1 << index))) {
      input.click();
      await settle();
    }
  }
}
async function expand() {
  while (
    [...fixture.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Show more')
  ) {
    button('Show more').click();
    await settle();
  }
}
function statistics() {
  return ['.current-pity', '.metrics', '.rarity-breakdown']
    .map((selector) => fixture.querySelector(selector)?.textContent)
    .join('|');
}
async function test(name: string, work: () => Promise<void>) {
  await work();
  await settle();
  results.textContent += `PASS ${name}\n`;
}

run.onclick = async () => {
  assert(location.origin === 'http://127.0.0.1:14194', 'Use the isolated browser-test origin.');
  run.disabled = true;
  observing = true;
  runtimeErrors.length = 0;
  results.textContent = '';
  summary.textContent = 'Running…';
  try {
    await test('Loading regions reserve the larger of previous content and multiline status', async () => {
      const target = document.createElement('div');
      fixture.append(target);
      const loadingFixture = mount(LoadingFixture, { target });
      const region = () => target.querySelector<HTMLElement>('.loading-region')!;
      const height = () => region().getBoundingClientRect().height;
      try {
        await settle();
        const oldHeight = height();
        const buttonWidth = target.querySelector('button')!.getBoundingClientRect().width;
        loadingFixture.setState({ busy: true, height: 0, text: '', label: 'Retry' });
        await settle();
        assert(Math.abs(height() - oldHeight) <= 1, 'Tall previous content collapsed');
        assert(
          Math.abs(target.querySelector('button')!.getBoundingClientRect().width - buttonWidth) <=
            1,
          'Loading label changed button width'
        );
        assert(
          target.querySelector('[inert][aria-hidden="true"]'),
          'Stale content remains interactive'
        );
        loadingFixture.setState({ message: 'A newer request is still loading…' });
        await settle();
        assert(Math.abs(height() - oldHeight) <= 1, 'Overlapping requests lost the settled height');
        loadingFixture.setState({ busy: false, height: 24, text: 'No matching results.' });
        await settle();
        assert(height() < oldHeight, 'Settled empty result retained the old height');
        assert(
          target.querySelector('button')!.getBoundingClientRect().width < buttonWidth,
          'Settled label retained a previous longer action width'
        );
        loadingFixture.setState({
          busy: true,
          message: 'Loading the selected history and its recruitment summary. '.repeat(12)
        });
        await settle();
        const messageHeight = target
          .querySelector('.region-message')!
          .getBoundingClientRect().height;
        assert(
          Math.abs(height() - Math.max(24, messageHeight)) <= 1,
          'Long status clipped or collapsed'
        );
        loadingFixture.setState({ width: 240 });
        await settle();
        const narrowMessage = target.querySelector('.region-message')!;
        assert(
          Math.abs(height() - narrowMessage.getBoundingClientRect().height) <= 1,
          'Narrow status clipped'
        );
        assert(
          narrowMessage.scrollWidth <= narrowMessage.clientWidth + 1,
          'Status overflowed horizontally'
        );
        loadingFixture.setState({ busy: false, text: 'Load failed. Retry.', height: 24 });
        await settle();
        assert(height() < messageHeight, 'Settled error retained the loading height');
        loadingFixture.setState({
          width: 500,
          height: 0,
          text: 'A saved recruitment result that wraps onto several lines. '.repeat(8),
          message: 'Loading…'
        });
        await settle();
        loadingFixture.setState({ busy: true });
        await settle();
        loadingFixture.setState({ width: 240 });
        await settle();
        const contentHeight = target
          .querySelector('.fixture-content')!
          .getBoundingClientRect().height;
        const statusHeight = target
          .querySelector('.region-message')!
          .getBoundingClientRect().height;
        assert(
          Math.abs(height() - Math.max(contentHeight, statusHeight)) <= 1,
          'Retained content did not reflow at narrow widths'
        );
        target.style.fontSize = '200%';
        await settle();
        assert(
          height() + 1 >= target.querySelector('.fixture-content')!.getBoundingClientRect().height,
          'Enlarged text was clipped while loading'
        );
      } finally {
        await unmount(loadingFixture);
        target.remove();
      }
    });
    await test('Loading resize preserves the initial floor after content replacement and overlapping requests', async () => {
      const target = document.createElement('div');
      fixture.append(target);
      const loadingFixture = mount(LoadingFixture, { target });
      const region = () => target.querySelector<HTMLElement>('.loading-region')!;
      const height = () => region().getBoundingClientRect().height;
      const assertFloor = () => {
        const messageHeight = target
          .querySelector('.region-message')!
          .getBoundingClientRect().height;
        assert(
          Math.abs(height() - Math.max(200, messageHeight)) <= 1,
          'A loading resize or overlap discarded the original 200px height floor'
        );
      };
      try {
        loadingFixture.setState({ height: 200, width: 500, text: 'Previous results' });
        await settle();
        assert(Math.abs(height() - 200) <= 1, 'Previous content must establish a 200px baseline');
        loadingFixture.setState({
          busy: true,
          height: 24,
          text: 'Placeholder',
          message: 'Loading…'
        });
        await settle();
        assertFloor();
        loadingFixture.setState({ width: 240 });
        await settle();
        assertFloor();
        loadingFixture.setState({ width: 210, message: 'A newer request is loading…' });
        await settle();
        assertFloor();
        loadingFixture.setState({
          message: 'Loading the requested archive and its recruitment summary. '.repeat(10)
        });
        await settle();
        assertFloor();
        assert(height() > 200, 'A taller loading message must still grow naturally');
        loadingFixture.setState({ width: 500, message: 'Loading…' });
        await settle();
        assertFloor();
        loadingFixture.setState({ busy: false, text: 'Ready' });
        await settle();
        assert(Math.abs(height() - 24) <= 1, 'Settling must release the old baseline');
        loadingFixture.setState({ busy: true });
        await settle();
        const nextMessageHeight = target
          .querySelector('.region-message')!
          .getBoundingClientRect().height;
        assert(
          Math.abs(height() - Math.max(24, nextMessageHeight)) <= 1,
          'A later loading sequence reused the old 200px baseline'
        );
      } finally {
        await unmount(loadingFixture);
        target.remove();
      }
    });
    localStorage.removeItem(REWARD_RARITIES_KEY);
    await reload();
    await test('Default 5★, two-row preview and incremental expansion', async () => {
      assert(
        checkboxes()
          .map((node) => node.checked)
          .join() === 'true,false,false,false',
        'Default is 5★ only'
      );
      assert(
        checkboxes().every(
          (node, index) => node.parentElement?.textContent?.trim() === labels[index]
        ),
        'Accessible rarity labels'
      );
      const columns = getComputedStyle(
        fixture.querySelector('.portrait-grid')!
      ).gridTemplateColumns.split(/\s+/).length;
      const initial = cards().length;
      assert(initial === columns * 2, 'Preview must contain two rows');
      assert(
        mounted!.requests.length === 1,
        `Initial preview dispatched a correction query: ${JSON.stringify(mounted!.requests)}`
      );
      assert(
        mounted!.requests[0].limit === columns * 2,
        'First query used an unmeasured preview limit'
      );
      assert(
        cards().every((card) => !card.querySelector('img[loading="lazy"]')),
        'Visible preview artwork is lazy'
      );
      button('Show more').click();
      await settle();
      assert(cards().length === Math.min(initial * 2, 30), 'Show more adds two rows');
      assert(
        cards()
          .slice(initial)
          .every((card) => !card.querySelector('img[loading="eager"]')),
        'Expanded artwork is eager'
      );
      button('Show fewer').click();
      await settle();
      assert(cards().length === initial, 'Show fewer restores two rows');
    });
    await test('All 16 rarity combinations preserve statistics, counts and recorded order', async () => {
      const invariant = statistics();
      const ordered = [rows[1], rows[2], rows[0], rows[3], ...rows.slice(4, 33)];
      for (let mask = 0; mask < 16; mask++) {
        await choose(mask);
        await expand();
        const expected = ordered.filter((row) => Boolean(mask & (1 << keys.indexOf(row.rarity))));
        assert(
          cards()
            .map((card) => card.querySelector('.pull-name')?.textContent)
            .join('|') === expected.map((row) => row.name).join('|'),
          `Ordering/filter mismatch for mask ${mask}`
        );
        assert(
          fixture
            .querySelector('.section-heading')
            ?.textContent?.includes(`${expected.length} rewards`),
          `Count mismatch for mask ${mask}`
        );
        assert(statistics() === invariant, `Statistics changed for mask ${mask}`);
        if (!mask)
          assert(
            fixture.textContent?.includes('Select a rarity to show rewards.'),
            'Empty selection guidance'
          );
      }
    });
    await test('All toggles all available rarities and none, with persistent selection', async () => {
      await choose(1);
      button('All').click();
      await settle();
      assert(
        checkboxes().every((input) => input.checked),
        'All selects every available rarity'
      );
      assert(button('All').getAttribute('aria-pressed') === 'true', 'All selected state');
      await reload();
      assert(
        checkboxes().every((input) => input.checked),
        'All preference persists'
      );
      button('All').click();
      await settle();
      assert(
        checkboxes().every((input) => !input.checked),
        'All clears every rarity'
      );
      assert(button('All').getAttribute('aria-pressed') === 'false', 'All cleared state');
      assert(cards().length === 0, 'Clearing all empties history');
      await reload();
      assert(
        checkboxes().every((input) => !input.checked),
        'Cleared preference persists'
      );
    });
    await test('Selection persists, including none; corrupt or unavailable storage falls back to 5★', async () => {
      await choose(6);
      await reload();
      assert(
        checkboxes()
          .map((input) => input.checked)
          .join() === 'false,true,true,false',
        'Mixed preference did not persist'
      );
      await choose(0);
      await reload();
      assert(
        checkboxes().every((input) => !input.checked),
        'Empty preference did not persist'
      );
      localStorage.setItem(REWARD_RARITIES_KEY, '{broken');
      await reload();
      assert(checkboxes()[0].checked && cards().length > 0, 'Malformed storage fallback');
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (key === REWARD_RARITIES_KEY)
          throw new DOMException('Synthetic storage denial', 'SecurityError');
        return original.call(this, key);
      };
      try {
        await reload();
        assert(checkboxes()[0].checked && cards().length > 0, 'Unavailable storage fallback');
      } finally {
        Storage.prototype.getItem = original;
      }
    });
    await test('Native details dialog shows facts, uncertainty, missing art and returns focus', async () => {
      await choose(8);
      const trigger = cards()[0];
      trigger.focus();
      trigger.click();
      await settle();
      assert(dialog().open, 'Dialog not open');
      assert(dialog().contains(document.activeElement), 'Focus not inside dialog');
      for (const text of [
        'Unresolved reward 4',
        '5★ pity at this pull',
        'Quantity',
        'Pool ID',
        '301',
        'Item ID',
        '999999',
        'No image available',
        'History is missing before this pull.',
        'pity count is uncertain'
      ]) {
        assert(dialog().textContent?.includes(text), `Missing detail: ${text}`);
      }
      button('Close').click();
      await settle();
      assert(
        !dialog().open && document.activeElement === trigger,
        'Close must return focus to trigger'
      );
    });
    await test('Image load failure switches both card and dialog to explicit fallback', async () => {
      await choose(2);
      const image = cards()[0].querySelector('img');
      assert(image, 'Expected known image');
      image.dispatchEvent(new Event('error'));
      await settle();
      assert(cards()[0].textContent?.includes('No image'), 'Card failure fallback missing');
      cards()[0].click();
      await settle();
      assert(
        dialog().textContent?.includes('No image available'),
        'Dialog failure fallback missing'
      );
      button('Close').click();
      await settle();
    });
    await test('Profile and recruitment transitions dismiss stale details; no-match state is scoped', async () => {
      await choose(1);
      cards()[0].click();
      await settle();
      mounted!.changeProfile();
      await settle();
      assert(!dialog().open, 'Profile change left stale dialog open');
      cards()[0].click();
      await settle();
      const select = fixture.querySelector('select')!;
      select.selectedIndex = 0;
      select.dispatchEvent(new Event('change'));
      await settle();
      assert(
        !dialog().open && cards().length === 1,
        'Recruitment change left stale detail or wrong rewards'
      );
      await choose(2);
      assert(
        fixture.textContent?.includes('No rewards match the selected rarities'),
        'No-match message missing'
      );
      assert(checkboxes().length === 3, 'Unknown should be hidden without unresolved rewards');
      select.selectedIndex = 1;
      select.dispatchEvent(new Event('change'));
      await settle();
      await choose(8);
      select.selectedIndex = 0;
      select.dispatchEvent(new Event('change'));
      await settle();
      assert(
        checkboxes().length === 4 && checkboxes()[3].checked,
        'Selected Unknown must remain removable in another recruitment'
      );
      await reload(rows.filter((row) => row.type_id === 1));
      assert(
        checkboxes().length === 4 && checkboxes()[3].checked,
        'Persisted Unknown must remain removable without unresolved rewards'
      );
      checkboxes()[3].click();
      await settle();
      assert(
        checkboxes().length === 3,
        'Unselected Unknown should disappear when no unresolved rewards exist'
      );
    });
    await test('Removing the selected record closes its details', async () => {
      await choose(1);
      await reload();
      cards()[0].click();
      await settle();
      mounted!.replaceRows(rows.filter((row) => row.id !== 1));
      await settle();
      assert(!dialog().open, 'Removed record left stale dialog');
    });
    await test('Large histories support bounded paging, Show all, and collapse', async () => {
      localStorage.setItem(REWARD_RARITIES_KEY, JSON.stringify(['Elite']));
      const large = Array.from({ length: 601 }, (_, index) => ({
        ...rows[0],
        id: index + 1,
        name: `Large reward ${index + 1}`,
        timestamp_order: index
      }));
      await reload(large);
      await expand();
      assert(cards().length === 200, 'Expansion must stop at 200 cards');
      assert(
        cards()[0].textContent?.includes('Large reward 1'),
        'First window starts at first reward'
      );
      button('Next rewards').click();
      await settle();
      assert(cards().length === 200, 'Next window must be bounded');
      assert(
        document.activeElement === fixture.querySelector('.section-heading h2'),
        'Window navigation must focus the history heading'
      );
      assert(
        cards()[0].textContent?.includes('Large reward 201'),
        'Next window repeats or skips rewards'
      );
      button('Next rewards').click();
      await settle();
      button('Next rewards').click();
      await settle();
      assert(
        cards().length === 1 && cards()[0].textContent?.includes('Large reward 601'),
        'Last window must contain the remainder'
      );
      button('Previous rewards').click();
      await settle();
      assert(
        cards().length === 200 && cards()[0].textContent?.includes('Large reward 401'),
        'Previous window failed'
      );
      const summaryBefore = statistics();
      button('Show all').click();
      await settle();
      assert(cards().length === 601, 'Show all must include every reward beyond the page limit');
      assert(
        cards()[0].textContent?.includes('Large reward 1') &&
          cards()[600].textContent?.includes('Large reward 601'),
        'Show all must start at the beginning and retain recorded order'
      );
      assert(statistics() === summaryBefore, 'Show all must not change recruitment statistics');
      cards()[600].click();
      await settle();
      assert(
        dialog().open && dialog().textContent?.includes('Large reward 601'),
        'Last reward details unavailable'
      );
      dialog().close();
      button('Show fewer').click();
      await settle();
      assert(
        cards().length < 200 && cards()[0].textContent?.includes('Large reward 1'),
        'Collapse returns to preview'
      );
      assert(
        mounted!.requests.every((request) => request.limit <= 200),
        'Query exceeded bounded payload'
      );
    });
    await test('Show fewer cancels an in-flight Show all expansion', async () => {
      const large = Array.from({ length: 601 }, (_, index) => ({
        ...rows[0],
        id: index + 1,
        name: `Cancel reward ${index + 1}`,
        timestamp_order: index
      }));
      await reload(large);
      const previewCount = cards().length;
      mounted!.deferQueries();
      button('Show all').click();
      await settle();
      mounted!.finishQuery();
      await settle();
      assert(mounted!.pendingCount() === 1, 'Expected a pending second page');
      button('Show fewer').click();
      await settle();
      mounted!.finishQuery(1);
      await settle();
      const requestCount = mounted!.requests.length;
      mounted!.finishQuery();
      await settle();
      assert(cards().length === previewCount, 'A stale Show all page replaced the preview');
      assert(mounted!.requests.length === requestCount, 'Cancelled expansion kept fetching pages');
    });
    await test('Loading selections preserve layout without exposing stale rewards', async () => {
      for (const selection of ['rarity', 'recruitment', 'profile', 'expanded rarity']) {
        localStorage.setItem(REWARD_RARITIES_KEY, JSON.stringify(keys));
        await reload();
        if (selection === 'expanded rarity') {
          button('Show all').click();
          await settle();
        }
        const geometry = () =>
          [
            ...fixture.querySelectorAll(
              '.elite-overview, .overview-toolbar, .section-heading, .portrait-grid, .history-pagination, .metrics, .rarity-breakdown'
            )
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            return [rect.top, rect.left, rect.width, rect.height];
          });
        const before = geometry();
        const summaryBefore = statistics();
        mounted!.deferQueries();
        if (selection.includes('rarity')) checkboxes()[0].click();
        else if (selection === 'recruitment') {
          const select = fixture.querySelector('select')!;
          select.value = '1';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        } else mounted!.changeProfile();
        await settle();
        const after = geometry();
        assert(
          before.length === after.length &&
            before.every((rect, i) =>
              rect.every((value, j) => Math.abs(value - after[i][j]) < 0.5)
            ),
          `${selection} loading moved the recruitment layout`
        );
        if (selection.includes('rarity')) {
          assert(statistics() === summaryBefore, 'Rarity loading changed recruitment statistics');
          for (const selector of ['.current-pity', '.metrics', '.rarity-breakdown']) {
            const node = fixture.querySelector(selector)!;
            assert(
              getComputedStyle(node).visibility === 'visible',
              `${selector} disappeared during rarity loading`
            );
          }
          assert(
            getComputedStyle(fixture.querySelector('.portrait-grid')!).visibility === 'hidden',
            'Pending rarity filter exposed old rewards'
          );
        } else assert(previousDataIsHidden(), `${selection} loading exposed stale data`);
        assert(
          fixture.querySelector('.elite-overview[aria-busy="true"]'),
          'Pending query is not marked busy'
        );
        assert(
          [...fixture.querySelectorAll('[role="status"]')].some(
            (node) =>
              node.textContent?.includes('Loading rewards') &&
              getComputedStyle(node).visibility === 'visible'
          ),
          'Pending rewards have no visible loading message'
        );
        assert(
          !fixture.querySelector('.spinner, .loading-state, .loading-slot'),
          'Transient spinner returned'
        );
        mounted!.finishQuery();
        await settle();
        assert(
          !fixture.querySelector('.elite-overview[aria-busy="true"]'),
          'Busy state remained after completion'
        );
      }
      localStorage.setItem(REWARD_RARITIES_KEY, JSON.stringify(keys));
    });
    await test('Late async results cannot replace a newer profile revision', async () => {
      await reload();
      mounted!.deferQueries();
      mounted!.changeProfile();
      await settle();
      assert(previousDataIsHidden(), 'Pending profile exposed previous rewards or summary');
      mounted!.replaceRows([{ ...rows[0], name: 'Newest revision reward' }]);
      await settle();
      assert(mounted!.pendingCount() === 2, 'Expected one request per changed context');
      mounted!.finishQuery(1);
      await settle();
      assert(
        cards().length === 1 && cards()[0].textContent?.includes('Newest revision reward'),
        'New result did not render'
      );
      mounted!.finishQuery(0);
      await settle();
      assert(
        cards().length === 1 && cards()[0].textContent?.includes('Newest revision reward'),
        'Late result overwrote the latest revision'
      );
    });
    await test('Failed profile queries clear previous data, retain controls and can be retried', async () => {
      const previousName = cards()[0].querySelector('.pull-name')!.textContent!;
      const select = fixture.querySelector('select')!;
      const grid = fixture.querySelector('.portrait-grid');
      const inputs = checkboxes();
      mounted!.changeProfile();
      await settle();
      assert(previousDataIsHidden(), 'Pending profile exposed previous rewards or summary');
      assert(
        fixture.querySelector('select') === select &&
          !select.disabled &&
          checkboxes().every((input, index) => input === inputs[index] && !input.disabled) &&
          fixture.querySelector('.portrait-grid') === grid,
        'Query controls must remain available during loading'
      );
      assert(mounted!.pendingCount() === 1, 'Clearing old rewards must not restart the query');
      mounted!.finishQuery(0, 'Synthetic query failure');
      await settle();
      assert(
        fixture.querySelector('[role="alert"]')?.textContent?.includes('Synthetic query failure'),
        'Query failure was not announced'
      );
      assert(
        cards().length === 0 &&
          !fixture.textContent?.includes(previousName) &&
          !fixture.querySelector(
            '.current-pity, .metrics, .rarity-breakdown, .section-heading h2 span'
          ),
        'Failed profile query exposed previous rewards or summary'
      );
      assert(fixture.querySelector('select') === select, 'Failure removed the query controls');
      mounted!.deferQueries(false);
      button('Retry recruitment history').click();
      await settle();
      assert(
        !fixture.querySelector('[role="alert"]') && cards().length === 1,
        'Retry did not recover'
      );
    });
    localStorage.setItem(REWARD_RARITIES_KEY, JSON.stringify(keys));
    await reload();
    summary.textContent = 'PASS: 15 reward-history and loading browser regression groups';
    results.textContent +=
      'Manual check: activate a reward using Enter/Space, cycle Tab/Shift+Tab inside the modal, press Escape, and verify focus returns. Synthetic key events do not invoke native browser default actions.\n';
  } catch (error) {
    summary.textContent = 'FAIL: reward-history browser regressions';
    results.textContent += `${error instanceof Error ? error.stack : String(error)}\n`;
  } finally {
    run.disabled = false;
  }
};
document.querySelector<HTMLButtonElement>('#reload')!.onclick = () => void reload();
document.querySelector<HTMLButtonElement>('#profile')!.onclick = () => mounted?.changeProfile();
void reload().then(() => {
  // A reproducible held request for desktop/mobile visual loading-state review.
  if (new URLSearchParams(location.search).get('loading') === '1') {
    mounted!.deferQueries();
    checkboxes()[0].click();
  }
});
