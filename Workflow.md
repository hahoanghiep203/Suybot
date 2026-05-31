# Discord-Driven Feature Workflow & Architecture

This document describes the parent-child multi-process architecture, dynamic hot-reloading pipeline, and developer sandbox rules for the Discord Agent Bot. It serves as an authoritative guide on how processes, code modules, and live environments coordinate.

---

## 1. Sequence Diagram: Dual-Process & Dev-Feature Workflow

This sequence diagram illustrates the lifecycle of bot commands, detailing how conversational queries, unrecognized prefix errors, and administrative developer prompts are routed via the Coordinator and hot-reloaded dynamically upon verification.

```mermaid
sequenceDiagram
    autonumber
    actor User as Discord User / Admin
    participant CP as Command Process<br/>(commandProcess.js)
    participant CO as Coordinator<br/>(index.js)
    participant AP as Agent Process<br/>(agentProcess.js)
    participant Agent as Agent AI Runner<br/>(agent.js)
    participant Sandbox as Sandbox Tools<br/>(devTools.js / tools.js)

    %% Flow 1: Conversational Prompts
    Note over User, AP: Flow A: Interactive AI Commands (/agent)
    User->>CP: Runs "/agent prompt: summarize project"
    CP->>CP: Defers interaction response
    CP->>CO: IPC: COGNITIVE_PROMPT
    CO->>AP: Routes IPC: COGNITIVE_PROMPT
    AP->>Agent: Runs respond(prompt)
    Agent-->>AP: Returns summary output
    AP->>CO: IPC: INTERACTION_UPDATE
    CO->>CP: Routes IPC: INTERACTION_UPDATE
    CP->>User: Edits deferred reply with response

    %% Flow 2: Prefix Command Redirection
    Note over User, AP: Flow B: Unrecognized/Syntax Errors on Prefix Commands
    User->>CP: Sends prefix command "!ping" (deprecated/invalid)
    CP->>CP: Catches unrecognized or invalid syntax
    CP->>CO: IPC: DELEGATE_TO_AGENT
    CO->>AP: Routes IPC: DELEGATE_TO_AGENT
    AP->>Agent: Runs respond(explanationPrompt)
    Agent-->>AP: Returns friendly explanation & bot help guide
    AP->>User: Replies in-channel to guide the user

    %% Flow 3: Dev Feature Hot-Reload pipeline
    Note over User, Sandbox: Flow C: Administrative Feature Development (/dev-feature)
    User->>CP: Admin runs "/dev-feature prompt: add /hello command"
    CP->>CP: Defers interaction reply (acknowledged)
    CP->>CO: IPC: COGNITIVE_PROMPT
    CO->>AP: Routes IPC: COGNITIVE_PROMPT
    AP->>AP: Clears developer session metadata
    AP->>Agent: Runs respond(prompt) with Dev Sandbox mode active

    rect rgb(240, 248, 255)
        Note over Agent, Sandbox: Development & Local Verification Loop
        Agent->>Sandbox: write_file() 'src/features/hello.js'
        Agent->>Sandbox: write_file() 'test/bot.test.js' update
        Agent->>Sandbox: run_command() "npm run check"
        Sandbox-->>Agent: Syntax check status (passed)
        Agent->>Sandbox: run_command() "npm test"
        Sandbox-->>Agent: Unit tests status (passed)
        Agent->>Sandbox: run_command() "npm run register"
        Sandbox-->>Agent: Discord API registration status (passed)
    end

    alt DEV_AUTO_RESTART=true, channel is approved, and all verifications passed
        AP->>User: Sends detailed verification checklist to Live Test Channel
        AP->>CO: IPC: RESTART_COMMANDS
        CO->>CP: Sends SIGTERM & terminates old process
        CO->>CP: Forks and spawns fresh Command Process
        activate CP
        CP->>Sandbox: Scans 'src/features/*.js' & dynamically imports "hello.js"
        CP->>User: Sends hot-reload success notification
        deactivate CP
        User->>CP: Executes newly added "/hello" command successfully!
    else Manual Deployment / Other Channels / Verifications Failed
        AP->>User: Reports build checklist and files changed, hot-reload blocked
    end
```

---

## 1.1 Auto-Restart Policy

Feature modules under `src/features/` are loaded by the Command Process. After `/dev-feature` writes or changes a feature, the Agent Process must request a Command Process restart so the new module is imported.

Auto-restart is controlled by environment variables:

```env
DEV_AUTO_RESTART=true
DEV_AUTO_RESTART_CHANNEL_IDS=1148922537540071478
```

Rules:

- Auto-restart happens only after `npm run check`, `npm test`, and `npm run register` pass.
- Auto-restart happens only for admin-approved `/dev-feature` requests.
- If `DEV_AUTO_RESTART_CHANNEL_IDS` is empty, any channel can trigger auto-restart.
- If `DEV_AUTO_RESTART_CHANNEL_IDS` has values, only those channel IDs can trigger auto-restart.
- The restart is an internal hot reload of `src/commandProcess.js`, not a full `npm start` restart.

Expected successful flow:

```text
/dev-feature prompt: add /hello command
agent writes src/features/hello.js
agent writes test/hello.test.js
agent runs npm run check
agent runs npm test
agent runs npm run register
agent sends RESTART_COMMANDS to Coordinator
Coordinator kills and respawns Command Process
new /hello command works without manually running npm start
```

If a full process restart is still required, it means the change touched the Coordinator, Agent Process, package dependencies, or environment configuration. Command Process hot reload only applies to command modules and command-side runtime files.

---

## 2. File Dependency & Connection Diagram

This system diagram displays the layout of the project directories, detailing how files connect, inherit properties, communicate over the Process Inter-Process Communication (IPC) bridge, and break circular dependencies at runtime.

```mermaid
graph TD
    %% Styling Classes
    classDef orchestrator fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20;
    classDef process fill:#e1f5fe,stroke:#0288d1,stroke-width:2px,color:#01579b;
    classDef engine fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:#e65100;
    classDef storage fill:#efebe9,stroke:#4e342e,stroke-width:2px,color:#3e2723;
    classDef script fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#4a148c;
    classDef dynamic fill:#fce4ec,stroke:#c2185b,stroke-width:2px,color:#880e4f;
    classDef test fill:#fafafa,stroke:#616161,stroke-width:2px,color:#212121;

    subgraph Orchestration ["Orchestration & Configuration"]
        Index["src/index.js<br/>(Parent Coordinator)"]:::orchestrator
        Config["src/config.js<br/>(Global Configurations)"]:::orchestrator
    end

    subgraph Runtime ["Isolated Run-Time Processes (Forks)"]
        AgentProc["src/agentProcess.js<br/>(Agent Process Client)"]:::process
        CmdProc["src/commandProcess.js<br/>(Commands Process Client)"]:::process
    end

    subgraph AIEngine ["Cognitive AI & Sandbox Environment"]
        Agent["src/agent.js<br/>(Gemini API Runner)"]:::engine
        Memory["src/memory.js<br/>(Session Memory Persistence)"]:::storage
        Tools["src/tools.js<br/>(Standard Workspace Tools)"]:::storage
        DevTools["src/devTools.js<br/>(Development & Sandbox Tools)"]:::storage
    end

    subgraph DynamicCommands ["Modular Command & Help Dispatchers"]
        Commands["src/commands.js<br/>(Features Registry Loader)"]:::engine
        Help["src/help.js<br/>(Dynamic Help Resolver)"]:::engine
        
        subgraph FeaturesDir ["src/features/ (Plugin Modules)"]
            AgentHelp["src/features/agentHelp.js<br/>(Help Command Provider)"]:::dynamic
            Reset["src/features/reset.js<br/>(Codebase Resetter)"]:::dynamic
            Remove["src/features/remove.js<br/>(Feature Deleter)"]:::dynamic
        end
    end

    subgraph Quality ["Quality Assurance & Registration CLI"]
        RegScript["scripts/register-commands.js<br/>(Slash Registrator CLI)"]:::script
        DiagScript["scripts/diagnose-discord.js<br/>(API Diagnostics Helper)"]:::script
        TestRunner["test/bot.test.js<br/>(Unit Testing Suite)"]:::test
    end

    %% Parent-Child Fork & Monitoring Relationships
    Index -->|Forks & restarts| AgentProc
    Index -->|Forks & restarts| CmdProc

    %% Process IPC Bridge Connection
    AgentProc <-->|IPC: DELEGATE_TO_AGENT / COGNITIVE_PROMPT<br/>INTERACTION_UPDATE / RESTART_COMMANDS| Index
    CmdProc <-->|IPC: COGNITIVE_PROMPT / DELEGATE_TO_AGENT<br/>INTERACTION_UPDATE| Index

    %% Agent Process Dependency Connections
    AgentProc -->|Imports config| Config
    AgentProc -->|Triggers responder| Agent
    AgentProc -->|Resolves help queries| Help
    AgentProc -->|Runs session checks| DevTools

    %% Agent Engine Dependency Connections
    Agent -->|Maintains history| Memory
    Agent -->|Performs standard file I/O| Tools
    Agent -->|Performs terminal commands| DevTools

    %% Command Process Dependency Connections
    CmdProc -->|Imports config| Config
    CmdProc -->|Loads registered modules| Commands

    %% Slash Registry and Dynamic Modules Scanner
    Commands -->|Asynchronously scans and loads| FeaturesDir
    Help -->|Dynamic import to break ES loop| Commands
    AgentHelp -->|Executes formatted help requests| Help

    %% External Quality & Registration Scripts
    RegScript -->|Imports registry| Commands
    DiagScript -->|Validates tokens| Config
    TestRunner -->|Asserts formatting and search matching| Help
```

---

## 3. Safe Developer Sandbox Rules

The developer agent runs within a strictly sandboxed local environment. It enforces the following access controls to guarantee that core bot operations and credentials remain secure during dynamic iterations:

- **Allowed Directories** (The agent has full read/write permission):
  - `src/` (Specifically writing self-contained files under `src/features/` to scale capabilities)
  - `scripts/` (Scripts related to CLI utilities)
  - `test/` (Adding modular test suites under `test/` for new features)
  - `README.md`
  - `Workflow.md`
  - `package.json`

- **Blocked Paths** (Access is strictly denied immediately):
  - `.env` (Protects your active Discord token and Gemini API key from exposure)
  - `node_modules/` (Maintains standard local dependency locks)
  - `data/` (Protects conversation history and database sessions)
  - `agent_workspace/`
  - `package-lock.json`

- **Allowlisted Verification Commands**:
  - `npm run check` (Runs static syntax checks on index, scripts, and feature files)
  - `npm test` (Executes the local automated test runner)
  - `npm run register` (Synchronizes registered command payloads with the Discord REST API)
  - `npm audit` (Runs vulnerability assessments)
  - `docker compose build` (For deployment container layers)

---

## 4. Feature Implementation Rules

When developing a new feature for the bot, follow these module guidelines:

1. **Independent Self-Contained Files**:
   - Write your command as a single, modular file under `src/features/` (e.g. `src/features/myFeature.js`).
   - Do **NOT** manually edit `commands.js`, `commandProcess.js`, or `help.js` to register it. They use runtime automatic loaders and resolver pathways.

2. **Standard Structure**:
   - Every feature module must export a `feature` constant with the following properties:
     - `data`: A `SlashCommandBuilder` metadata payload.
     - `execute(interaction)`: Slash interaction handler.
     - `executePrefix(message, args)`: Optional message prefix handler.
     - `help`: A help documentation entry object.

### Example Template:
```javascript
import { SlashCommandBuilder } from 'discord.js';

export const feature = {
  data: new SlashCommandBuilder()
    .setName('hello')
    .setDescription('Say hello!'),

  async execute(interaction) {
    await interaction.reply('Hello!');
  },

  help: {
    name: '/hello',
    aliases: ['!hello'],
    usage: '/hello',
    description: 'A friendly greeting.',
    examples: ['/hello']
  }
};
```
