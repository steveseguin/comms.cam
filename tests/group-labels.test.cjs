const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Execute the production renderer and escaping helper with a small inert DOM.
// These tests check the generated HTML and identifiers, not browser execution.
const html = fs.readFileSync(process.env.COMMS_SOURCE || path.join(__dirname, '..', 'comms.html'), 'utf8');
const source = html.slice(html.indexOf('function sanitize(string)'), html.indexOf('function decodeHTML(value)')) +
  html.slice(html.indexOf('function drawGroup(groupID)'), html.indexOf('function pullUp(event)'));
const escapeText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.innerHTML = '';
    this.classes = new Set();
  }
  set textContent(value) { this.innerHTML = escapeText(value ?? ''); }
  get classList() {
    return {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name)
    };
  }
  set classList(value) { this.classes = new Set(value.split(' ')); }
  appendChild(child) { child.parentNode = this; this.children.push(child); }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.classes.has(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function setup({ aliases = {}, activeGroups = [], activeViewGroups = [] } = {}) {
  const menu = new Element('div');
  const sent = [];
  let saved = 0;
  let reply = null;
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag), getElementById: () => menu },
    savedSession: { aliases, activeGroups, activeViewGroups },
    remoteActivate() {},
    saveSession() { saved++; },
    prompt() { return reply; },
    console: { log() {} },
    iframe: { contentWindow: { postMessage(value) { sent.push(JSON.parse(JSON.stringify(value))); } } }
  });
  vm.runInContext(source, context);
  return {
    render(id) {
      const container = context.drawGroup(id);
      const group = container.children[0];
      return { container, group, name: group.children[0], view: group.children[2] };
    },
    rename(name, value, modifier = 'ctrlKey') {
      reply = value;
      name.onclick.call(name, { [modifier]: true });
    },
    get saved() { return saved; },
    sent
  };
}

const markup = '<img src=x onerror="window.groupMarker=1">';

test('ordinary group text and its routing identifier are unchanged', () => {
  const { group, name } = setup().render('backstage');
  assert.equal(name.innerHTML, 'group: backstage');
  assert.equal(group.dataset.group, 'backstage');
});

test('URL-supplied group markup is escaped', () => {
  const { group, name } = setup().render(markup);
  assert.equal(name.innerHTML, 'group: ' + escapeText(markup));
  assert.equal(group.dataset.group, markup);
});

test('literal entities, quotes and Unicode remain text', () => {
  const id = 'Café <crew> &amp; "mix"';
  assert.equal(setup().render(id).name.innerHTML, 'group: ' + escapeText(id));
});

test('restored alias markup is escaped while preserving the subtitle', () => {
  const { name } = setup({ aliases: { backstage: markup } }).render('backstage');
  assert.equal(name.innerHTML, escapeText(markup) + '<br /><small>group: backstage</small>');
});

test('restored group identifiers are also escaped in alias subtitles', () => {
  const { name } = setup({ aliases: { [markup]: 'Crew' } }).render(markup);
  assert.equal(name.innerHTML, 'Crew<br /><small>group: ' + escapeText(markup) + '</small>');
});

test('renaming escapes the alias and group subtitle, preserving the saved value', () => {
  const state = setup();
  const { group, name } = state.render(markup);
  state.rename(name, '<svg onload="window.aliasMarker=1">');
  assert.equal(name.innerHTML, '&lt;svg onload="window.aliasMarker=1"&gt;<br /><small>group: ' + escapeText(markup) + '</small>');
  assert.equal(group.dataset.alias, '<svg onload="window.aliasMarker=1">');
  assert.equal(state.saved, 1);
});

test('resetting an alias to the original group name keeps markup escaped', () => {
  const state = setup();
  const { group, name } = state.render(markup);
  state.rename(name, 'Crew');
  state.rename(name, markup);
  assert.equal(name.innerHTML, 'group: ' + escapeText(markup));
  assert.equal(group.dataset.alias, undefined);
  assert.equal(state.saved, 2);
});

test('meta-key rename and cancelled rename preserve ordinary labels', () => {
  const state = setup();
  const { name } = state.render('backstage');
  state.rename(name, 'Camera Crew', 'metaKey');
  const expected = 'Camera Crew<br /><small>group: backstage</small>';
  assert.equal(name.innerHTML, expected);
  state.rename(name, null);
  assert.equal(name.innerHTML, expected);
});

test('active flags and view-only routing retain the original group identifier', () => {
  const state = setup({ activeGroups: [markup], activeViewGroups: [markup] });
  const { container, group, view } = state.render(markup);
  assert.ok(container.classList.contains('pressed'));
  assert.ok(group.classList.contains('view'));
  const event = { preventDefault() {}, stopPropagation() {} };
  view.onclick.call(view, event);
  assert.deepEqual(state.sent.at(-1), { groupView: [] });
  view.onclick.call(view, event);
  assert.deepEqual(state.sent.at(-1), { groupView: [markup] });
});
