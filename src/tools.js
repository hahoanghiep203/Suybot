import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@google/genai';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

function resolveWorkspacePath(relativePath = '.') {
  const target = path.resolve(config.paths.workspace, relativePath);
  const root = `${config.paths.workspace}${path.sep}`;
  if (target !== config.paths.workspace && !target.startsWith(root)) {
    throw new Error('Path is outside the agent workspace.');
  }
  return target;
}

async function listWorkspace(args) {
  const dir = resolveWorkspacePath(args.path || '.');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
    .join('\n') || '(empty)';
}

async function readFile(args) {
  const file = resolveWorkspacePath(args.path);
  return await fs.readFile(file, 'utf8');
}

async function writeFile(args) {
  const file = resolveWorkspacePath(args.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, args.content ?? '', 'utf8');
  return `Wrote ${path.relative(config.paths.workspace, file)}`;
}

async function appendFile(args) {
  const file = resolveWorkspacePath(args.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, args.content ?? '', 'utf8');
  return `Appended ${path.relative(config.paths.workspace, file)}`;
}

async function replaceInFile(args) {
  const file = resolveWorkspacePath(args.path);
  const content = await fs.readFile(file, 'utf8');
  const search = args.search ?? '';
  if (!search) throw new Error('search must not be empty.');
  if (!content.includes(search)) throw new Error('search text was not found.');
  const updated = content.replace(search, args.replacement ?? '');
  await fs.writeFile(file, updated, 'utf8');
  return `Updated ${path.relative(config.paths.workspace, file)}`;
}

function parseCommand(command) {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ''));
}

async function runCommand(args) {
  if (!config.tools.allowShell) {
    throw new Error('Shell tools are disabled. Set ALLOW_SHELL_TOOLS=true to enable.');
  }

  const parts = parseCommand(args.command || '');
  const [command, ...commandArgs] = parts;
  if (!command) throw new Error('command must not be empty.');
  if (!config.tools.allowedCommands.has(command)) {
    throw new Error(`Command is not allowlisted: ${command}`);
  }

  const result = await execFileAsync(command, commandArgs, {
    cwd: config.paths.workspace,
    timeout: config.tools.commandTimeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return output || '(command completed with no output)';
}

export const toolDefinitions = [
  {
    name: 'list_workspace',
    description: 'List files and folders inside the agent workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Workspace-relative directory path.' }
      }
    }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the agent workspace.',
    parameters: {
      type: Type.OBJECT,
      required: ['path'],
      properties: {
        path: { type: Type.STRING, description: 'Workspace-relative file path.' }
      }
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file inside the agent workspace.',
    parameters: {
      type: Type.OBJECT,
      required: ['path', 'content'],
      properties: {
        path: { type: Type.STRING },
        content: { type: Type.STRING }
      }
    }
  },
  {
    name: 'append_file',
    description: 'Append text to a file inside the agent workspace.',
    parameters: {
      type: Type.OBJECT,
      required: ['path', 'content'],
      properties: {
        path: { type: Type.STRING },
        content: { type: Type.STRING }
      }
    }
  },
  {
    name: 'replace_in_file',
    description: 'Replace the first exact text match in a workspace file.',
    parameters: {
      type: Type.OBJECT,
      required: ['path', 'search', 'replacement'],
      properties: {
        path: { type: Type.STRING },
        search: { type: Type.STRING },
        replacement: { type: Type.STRING }
      }
    }
  },
  {
    name: 'run_command',
    description: 'Run an allowlisted local command in the agent workspace. Disabled unless ALLOW_SHELL_TOOLS=true.',
    parameters: {
      type: Type.OBJECT,
      required: ['command'],
      properties: {
        command: { type: Type.STRING, description: 'Command and arguments, for example "npm test".' }
      }
    }
  }
];

const handlers = {
  list_workspace: listWorkspace,
  read_file: readFile,
  write_file: writeFile,
  append_file: appendFile,
  replace_in_file: replaceInFile,
  run_command: runCommand
};

export async function ensureWorkspace() {
  await fs.mkdir(config.paths.workspace, { recursive: true });
}

export async function executeTool(name, args) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler(args ?? {});
}
