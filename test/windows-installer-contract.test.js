import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Windows installer registers and verifies the Claude Code user-scope MCP', async () => {
  const installer = await fs.readFile(path.join(root, 'INSTALL.ps1'), 'utf8');
  assert.match(installer, /Register-ClaudeCodeMcp/);
  assert.match(installer, /'mcp', 'add'/);
  assert.match(installer, /'--scope', 'user'/);
  assert.match(installer, /Assert-ClaudeUserMcp/);
  assert.match(installer, /已恢复原用户配置/);
  assert.match(installer, /Move-DirectoryWithRetry/);
  assert.match(installer, /\[IO\.Directory\]::Move/);

  const uninstaller = await fs.readFile(path.join(root, 'UNINSTALL.ps1'), 'utf8');
  assert.match(uninstaller, /Remove-ClaudeCodeMcp/);
  assert.match(uninstaller, /'mcp', 'remove', 'database-mcp', '--scope', 'user'/);
});
