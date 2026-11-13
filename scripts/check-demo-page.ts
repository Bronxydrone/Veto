/**
 * Drive the browser demo's own script against a tiny DOM stub.
 *
 * `scripts/check-demo.ts` proves the *engine* in the bundle is right. This proves the *page*
 * around it: that the presets fill the form, that pressing a preset produces a rendered
 * decision, and that Reset clears the feed. It is the closest thing to clicking the page that
 * can be done without a browser.
 *
 *   node scripts/check-demo-page.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');
const html = readFileSync(join(root, 'docs', 'demo', 'index.html'), 'utf8');

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
if (inlineScripts.length === 0) {
  console.error('index.html has no inline script');
  process.exit(1);
}
const pageScript = inlineScripts[inlineScripts.length - 1];

class StubElement {
  id: string;
  tag: string;
  value = '';
  textContent = '';
  innerHTML = '';
  className = '';
  inserted: string[] = [];
  children: StubElement[] = [];
  private listeners = new Map<string, (() => void)[]>();

  constructor(tag: string, id = '') {
    this.tag = tag;
    this.id = id;
  }

  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  click(): void {
    for (const handler of this.listeners.get('click') ?? []) handler();
  }

  appendChild(child: StubElement): StubElement {
    this.children.push(child);
    return child;
  }

  insertAdjacentHTML(_position: string, markup: string): void {
    this.inserted.push(markup);
  }
}

const registry = new Map<string, StubElement>();
const document = {
  getElementById(id: string): StubElement {
    if (!registry.has(id)) registry.set(id, new StubElement('div', id));
    return registry.get(id) as StubElement;
  },
  createElement(tag: string): StubElement {
    return new StubElement(tag);
  },
};

// The bundle installs `Veto` on the global object, exactly as it does in a browser.
vm.runInThisContext(readFileSync(join(root, 'docs', 'demo', 'veto.js'), 'utf8'), { filename: 'veto.js' });
const sandbox = { Veto: (globalThis as { Veto?: unknown }).Veto, document, console };
vm.createContext(sandbox);
vm.runInContext(pageScript, sandbox, { filename: 'index.html#inline' });

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

const presets = registry.get('presets') as StubElement | undefined;
check('the page built its preset buttons', (presets?.children.length ?? 0) >= 5, `${presets?.children.length ?? 0} buttons`);
check('the page rendered the policy header', (registry.get('policy')?.innerHTML ?? '').includes('argo-spending-policy'));
check('the page rendered a budget line', (registry.get('budget')?.innerHTML ?? '').includes('today USDC'));

const overCap = presets?.children.find((button) => button.textContent.includes('40 USDC'));
check('a preset for the over-cap payment exists', Boolean(overCap));
overCap?.click();

const feed = registry.get('feed') as StubElement;
const rendered = feed.inserted.join('\n');
check('clicking the preset rendered a decision', rendered.length > 0);
check('the rendered decision is a denial', rendered.includes('DENY'), rendered.includes('PER_TX_LIMIT') ? 'PER_TX_LIMIT' : 'no code');
check('the denial names the wall', rendered.includes('PER_TX_LIMIT'));
check('the card lists the checks with numbers', /=?\d+ checks/.test(rendered.replace(/<[^>]+>/g, ' ')));

const reset = document.getElementById('reset');
reset.click();
check('Reset clears the feed', (feed.innerHTML ?? '').includes('No decisions yet'));

const allowed = presets?.children.find((button) => button.textContent.includes('5 USDC'));
allowed?.click();
const afterAllow = feed.inserted.join('\n');
check('an allowed payment renders ALLOW', afterAllow.includes('ALLOW'));

console.log('');
console.log(failures === 0 ? 'the demo page works end to end against a DOM stub' : `${failures} page check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
