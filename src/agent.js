import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { config } from './config.js';
import { appendHistory, loadHistory } from './memory.js';
import { executeTool, toolDefinitions } from './tools.js';
import { executeDevTool, devToolDefinitions } from './devTools.js';

const ai = new GoogleGenAI({ apiKey: config.ai.apiKey });

const systemPrompt = `You are a pragmatic Discord agent.
You help users plan, write, and maintain small projects.
You can use tools to inspect and edit files, but only inside the configured workspace.
Be concise in Discord. Ask for clarification only when required.
Before changing files, state what you intend to change.
Do not claim that you performed actions unless tool results confirm them.
When a user asks for a Discord bot command or bot feature, do not create a standalone script that needs manual token or channel configuration.
Prefer an integrated bot command design that uses the running bot context, then tell the user that code changes and command registration must be done in the project before the feature is available.
If you cannot edit the bot source from your current tool sandbox, say that directly instead of pretending the feature is installed.
Always include the verification step that should be run, such as npm run check, npm run register, and a command-specific smoke test.`;

const devSystemPrompt = `You are an elite Discord agent specialized in extending the functionality of this Discord bot.
You are running with full developer permissions in the bot's own project root.
Your goal is to safely build, test, and register new features based on the user's prompt.

You have access to tools that let you read and write files in the following allowed directories/files:
- src/
- scripts/
- test/
- README.md
- Workflow.md
- package.json

You must adhere to these strict rules:
1. NEVER attempt to read or modify .env, package-lock.json, or folders like node_modules, data, or agent_workspace.
2. When implementing a new bot feature, design it as an independent self-contained feature module file under "src/features/" (e.g. "src/features/myFeature.js").
   Do NOT touch "src/commands.js", "src/commandProcess.js", or "src/help.js". They automatically load features dynamically at boot time.
   Each feature module MUST export a constant object named "feature" with the following structure:
   - "data": A SlashCommandBuilder instance (or JSON object) representing the command metadata.
   - "execute(interaction)": An async function executing the slash command interaction.
   - "executePrefix(message, args)": (Optional) An async function executing the command when triggered via message prefix.
   - "help": An object documenting the command for the "!help" system, containing:
     - "name": String (e.g., "/myfeature")
     - "aliases": Array of strings
     - "usage": String
     - "description": String
     - "examples": Array of strings
3. Write automated tests for the feature under the test/ directory. Ensure you follow standard Node built-in test runner patterns (using node:test and node:assert). CRITICAL: This project is an ES Module project ("type": "module" in package.json). You MUST use ES module "import" syntax (e.g., "import test from 'node:test';" and "import { feature } from '../src/features/xxx.js';") in all files you write. NEVER use CommonJS "require()" statements as they will crash the test suite!
4. Run the allowlisted verification commands in this order to fully check and register your work:
   a. "npm run check" (verifies syntax correctness)
   b. "npm test" (runs unit tests)
   c. "npm run register" (registers any slash commands with Discord)
5. Explain clearly what changes you have made and the test results. Be professional, direct, and concise.`;

const thinkingLevels = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH
};

function toContent(message) {
  const role = message.role === 'assistant' || message.role === 'model' ? 'model' : 'user';
  return {
    role,
    parts: [{ text: message.content }]
  };
}

function supportsUrlContext() {
  return /^gemini-(2\.5|3)/i.test(config.ai.model);
}

function wantsWebTools(prompt) {
  return /\bhttps?:\/\/|\bsearch\b|\bgoogle\b|\blatest\b|\btoday\b|\bweather\b|\bcommute\b|\bnews\b/i.test(prompt);
}

function buildTools(toolOptions) {
  const tools = [];
  if (toolOptions.isDev) {
    tools.push({ functionDeclarations: devToolDefinitions });
  } else {
    if (toolOptions.mode === 'local') {
      tools.push({ functionDeclarations: toolDefinitions });
    }
    if (toolOptions.mode === 'web' && toolOptions.includeSearch) {
      tools.push({ googleSearch: {} });
    }
    if (toolOptions.mode === 'web' && toolOptions.includeUrlContext && supportsUrlContext()) {
      tools.push({ urlContext: {} });
    }
  }
  return tools;
}

function generationConfig(toolOptions) {
  const configForRequest = {
    temperature: config.ai.temperature,
    systemInstruction: toolOptions.isDev ? devSystemPrompt : systemPrompt
  };

  const tools = buildTools(toolOptions);
  if (tools.length) configForRequest.tools = tools;

  if (config.ai.thinkingLevel) {
    configForRequest.thinkingConfig = {
      thinkingLevel: thinkingLevels[config.ai.thinkingLevel.toLowerCase()] ?? config.ai.thinkingLevel
    };
  }

  return configForRequest;
}

async function generateContent(contents, toolOptions) {
  try {
    return await ai.models.generateContent({
      model: config.ai.model,
      contents,
      config: generationConfig(toolOptions)
    });
  } catch (error) {
    const message = String(error.message || error);
    if (toolOptions.includeUrlContext) {
      return await generateContent(contents, { ...toolOptions, includeUrlContext: false });
    }
    if (toolOptions.includeSearch) {
      return await generateContent(contents, { ...toolOptions, includeSearch: false });
    }
    if (toolOptions.mode !== 'plain' && /internal|tool|function|search|url|context/i.test(message)) {
      return await generateContent(contents, { mode: 'plain' });
    }
    throw error;
  }
}

async function runFunctionCalls(functionCalls, isDev = false) {
  const parts = [];
  for (const call of functionCalls ?? []) {
    try {
      const result = isDev
        ? await executeDevTool(call.name, call.args)
        : await executeTool(call.name, call.args);
      parts.push({
        functionResponse: {
          name: call.name,
          id: call.id,
          response: { result: String(result).slice(0, 12000) }
        }
      });
    } catch (error) {
      parts.push({
        functionResponse: {
          name: call.name,
          id: call.id,
          response: { error: error.message }
        }
      });
    }
  }
  return { role: 'user', parts };
}

function sourceLines(response) {
  if (!config.ai.includeSources) return [];

  const sources = new Map();
  const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  for (const chunk of groundingChunks) {
    if (chunk.web?.uri) {
      sources.set(chunk.web.uri, chunk.web.title || chunk.web.uri);
    }
  }

  const urlMetadata = response.candidates?.[0]?.urlContextMetadata?.urlMetadata ?? [];
  for (const item of urlMetadata) {
    const url = item.retrievedUrl || item.url;
    if (url) sources.set(url, item.title || url);
  }

  return [...sources.entries()]
    .slice(0, 5)
    .map(([url, title]) => `- ${title}: ${url}`);
}

function finalText(response) {
  const text = response.text?.trim() || 'Done.';
  const sources = sourceLines(response);
  return sources.length ? `${text}\n\nSources:\n${sources.join('\n')}` : text;
}

export async function respond(scopeId, userName, prompt, options = {}) {
  const history = await loadHistory(scopeId);
  const userMessage = {
    role: 'user',
    content: `${userName}: ${prompt}`
  };

  const contents = [...history, userMessage].map(toContent);
  const toolOptions = {
    isDev: !!options.isDev,
    mode: options.isDev ? 'local' : (wantsWebTools(prompt) ? 'web' : 'local'),
    includeSearch: !options.isDev && config.ai.enableSearch,
    includeUrlContext: !options.isDev && config.ai.enableUrlContext
  };

  let response = null;
  let answer = 'Done.';

  const maxRounds = options.isDev ? 15 : config.agent.maxToolRounds;
  for (let round = 0; round <= maxRounds; round += 1) {
    response = await generateContent(contents, toolOptions);
    const functionCalls = response.functionCalls ?? [];

    if (!functionCalls.length) {
      answer = finalText(response);
      break;
    }

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);
    contents.push(await runFunctionCalls(functionCalls, options.isDev));
  }

  await appendHistory(scopeId, [
    userMessage,
    { role: 'model', content: answer }
  ]);

  return answer;
}
