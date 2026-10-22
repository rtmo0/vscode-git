import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = readFileSync(join(root, 'src', 'extension.ts'), 'utf8');
const declared: string[] = manifest.contributes.commands.map((c: { command: string }) => c.command);
const views: string[] = Object.values(manifest.contributes.views as Record<string, { id: string }[]>).flat().map((v) => v.id);

test('every declared command is registered and every registered command is declared', () => {
  const registered = [...source.matchAll(/'(git-awesome\.[A-Za-z]+)':/g)].map((m) => m[1]);
  registered.push('git-awesome.showOutput');
  assert.deepEqual([...declared].sort(), [...new Set(registered)].sort());
});

test('menus and keybindings refer to declared commands or view focus commands', () => {
  const known = new Set([...declared, ...views.map((id) => `${id}.focus`)]);
  const menuCommands = Object.values(manifest.contributes.menus as Record<string, { command: string }[]>).flat().map((m) => m.command);
  const keyCommands = manifest.contributes.keybindings.map((k: { command: string }) => k.command);
  for (const command of [...menuCommands, ...keyCommands]) {
    assert.ok(known.has(command), `${command} is not declared`);
  }
});
