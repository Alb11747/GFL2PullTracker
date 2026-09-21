import { mount, unmount, tick } from 'svelte';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '../../src/app.css';
import RewardFixture from './RewardFixture.svelte';
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
let mounted: { changeProfile: () => void; replaceRows: (next: Pull[]) => void } | undefined;
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
      button('Show more').click();
      await settle();
      assert(cards().length === Math.min(initial * 2, 30), 'Show more adds two rows');
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
    localStorage.setItem(REWARD_RARITIES_KEY, JSON.stringify(keys));
    await reload();
    summary.textContent = 'PASS: 7 reward-history browser regression groups';
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
void reload();
