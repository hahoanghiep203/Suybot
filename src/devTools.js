import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@google/genai';

const execAsync = promisify(exec);
const projectRoot = process.cwd();

// Tracked session state
const changedFiles = new Set();
const verificationResults = new Map();

export function clearSession() {
  changedFiles.clear();
  verificationResults.clear();
}

export function getChangedFiles() {
  return Array.from(changedFiles);
}

export function getVerificationResults() {
  return verificationResults;
}

export function isRestartRequired() {
  for (const file of changedFiles) {
    if (file.startsWith('src/') || file.startsWith('scripts/') || file === 'package.json') {
      return true;
    }
  }
  return false;
}

function resolveProjectPath(relativePath = '.') {
  const target = path.resolve(projectRoot, relativePath);
  const rootSep = `${projectRoot}${path.sep}`;
  if (target !== projectRoot && !target.startsWith(rootSep)) {
    throw new Error('Path is outside the project root.');
  }
  return target;
}

function verifyPathAccess(absolutePath) {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Access denied: Path is outside the project root.');
  }

  const normalized = relative.replace(/\\/g, '/');

  // Explicit block list
  const blockedPrefixes = ['.env', 'node_modules', 'data', 'agent_workspace', 'package-lock.json'];
  if (blockedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix + '/'))) {
    throw new Error(`Access denied to restricted path: ${relative}`);
  }

  // Explicit allowed list
  const allowedPrefixes = ['src', 'scripts', 'test', 'README.md', 'Workflow.md', 'package.json'];
  if (!allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix + '/'))) {
    throw new Error(`Access denied: Path is not in the allowed list: ${relative}`);
  }

  return normalized;
}

async function listWorkspaceDev(args) {
  const dir = resolveProjectPath(args.path || '.');
  verifyPathAccess(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
    .join('\n') || '(empty)';
}

async function readFileDev(args) {
  const file = resolveProjectPath(args.path);
  verifyPathAccess(file);
  return await fs.readFile(file, 'utf8');
}

async function writeFileDev(args) {
  const file = resolveProjectPath(args.path);
  const relPath = verifyPathAccess(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, args.content ?? '', 'utf8');
  changedFiles.add(relPath);
  return `Wrote ${relPath}`;
}

async function appendFileDev(args) {
  const file = resolveProjectPath(args.path);
  const relPath = verifyPathAccess(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, args.content ?? '', 'utf8');
  changedFiles.add(relPath);
  return `Appended ${relPath}`;
}

async function replaceInFileDev(args) {
  const file = resolveProjectPath(args.path);
  const relPath = verifyPathAccess(file);
  const content = await fs.readFile(file, 'utf8');
  const search = args.search ?? '';
  if (!search) throw new Error('search must not be empty.');
  if (!content.includes(search)) throw new Error('search text was not found.');
  const updated = content.replace(search, args.replacement ?? '');
  await fs.writeFile(file, updated, 'utf8');
  changedFiles.add(relPath);
  return `Updated ${relPath}`;
}

const ALLOWED_DEV_COMMANDS = new Set([
  'npm run check',
  'npm test',
  'npm run register',
  'npm audit',
  'docker compose build'
]);

async function runCommandDev(args) {
  const command = (args.command || '').trim();
  if (!ALLOWED_DEV_COMMANDS.has(command)) {
    throw new Error(`Command is not allowlisted: ${command}`);
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectRoot,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    verificationResults.set(command, 'passed');
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return output || '(command completed with no output)';
  } catch (error) {
    verificationResults.set(command, 'failed');
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || error.message);
  }
}

export const devToolDefinitions = [
  {
    name: 'list_workspace',
    description: 'List files and folders inside the bot project.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Project-relative directory path.' }
      }
    }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the bot project.',
    parameters: {
      type: Type.OBJECT,
      required: ['path'],
      properties: {
        path: { type: Type.STRING, description: 'Project-relative file path.' }
      }
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file inside the bot project.',
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
    description: 'Append text to a file inside the bot project.',
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
    description: 'Replace the first exact text match in a project file.',
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
    description: 'Run an allowlisted verification command in the bot project root. Allowlisted: npm run check, npm test, npm run register, npm audit, docker compose build.',
    parameters: {
      type: Type.OBJECT,
      required: ['command'],
      properties: {
        command: { type: Type.STRING, description: 'Command to run (exact string match required).' }
      }
    }
  }
];

const devHandlers = {
  list_workspace: listWorkspaceDev,
  read_file: readFileDev,
  write_file: writeFileDev,
  append_file: appendFileDev,
  replace_in_file: replaceInFileDev,
  run_command: runCommandDev
};

export async function executeDevTool(name, args) {
  const handler = devHandlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler(args ?? {});
}
