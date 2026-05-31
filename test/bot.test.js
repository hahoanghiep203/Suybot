import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHelp, getCommandEntries } from '../src/help.js';
import { commands } from '../src/commands.js';

test('help system tests', async (t) => {
  await t.test('formatHelp() lists all commands', async () => {
    const helpText = await formatHelp();
    assert.match(helpText, /Command help/);
    assert.match(helpText, /!help/);
    assert.match(helpText, /\/agent/);
    assert.match(helpText, /\/agent-help/);
    assert.match(helpText, /\/dev-feature/);
  });

  await t.test('Unknown help searches return clear no commands found response', async () => {
    const helpText = await formatHelp('unknown_command_xyz_abc');
    assert.match(helpText, /No commands found for/);
  });
});

test('command registration matches help entries', async () => {
  const commandEntries = await getCommandEntries();
  // Extract all slash command names
  const registeredNames = commands.map((cmd) => cmd.name);

  // For every registered slash command, ensure there is a help entry that matches
  for (const name of registeredNames) {
    const found = commandEntries.some((entry) => {
      const entryName = entry.name.toLowerCase();
      const searchName = `/${name}`.toLowerCase();

      if (entryName === searchName) return true;
      if (entry.aliases.map((a) => a.toLowerCase()).includes(searchName)) return true;
      return false;
    });

    assert.ok(found, `Registered slash command "/${name}" must be documented in help entries.`);
  }
});
