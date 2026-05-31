import { fork } from 'node:child_process';
import path from 'node:path';

const projectRoot = process.cwd();
const agentScript = path.resolve(projectRoot, 'src/agentProcess.js');
const commandScript = path.resolve(projectRoot, 'src/commandProcess.js');

let agentChild = null;
let commandChild = null;

let isShuttingDown = false;

function startAgentProcess() {
  if (isShuttingDown) return;
  console.log('[Coordinator] Spawning Agent Process...');
  
  agentChild = fork(agentScript);
  
  agentChild.on('message', (message) => {
    console.log('[Coordinator] Received message from Agent:', message.type);
    
    if (message.type === 'INTERACTION_UPDATE') {
      if (commandChild && commandChild.connected) {
        commandChild.send(message);
      } else {
        console.warn('[Coordinator] Cannot forward INTERACTION_UPDATE: Command Process not connected');
      }
    } else if (message.type === 'RESTART_COMMANDS') {
      console.log('[Coordinator] Hot-reload triggered! Restarting Command Process...');
      restartCommandProcess();
    }
  });
  
  agentChild.on('exit', (code, signal) => {
    console.log(`[Coordinator] Agent Process exited with code ${code}, signal ${signal}`);
    agentChild = null;
    if (!isShuttingDown) {
      console.log('[Coordinator] Respawning Agent Process in 2 seconds...');
      setTimeout(startAgentProcess, 2000);
    }
  });
}

function startCommandProcess() {
  if (isShuttingDown) return;
  console.log('[Coordinator] Spawning Command Process...');
  
  commandChild = fork(commandScript);
  
  commandChild.on('message', (message) => {
    console.log('[Coordinator] Received message from Command:', message.type);
    
    if (message.type === 'DELEGATE_TO_AGENT' || message.type === 'COGNITIVE_PROMPT') {
      if (agentChild && agentChild.connected) {
        agentChild.send(message);
      } else {
        console.warn('[Coordinator] Cannot forward to Agent: Agent Process not connected');
      }
    }
  });
  
  commandChild.on('exit', (code, signal) => {
    console.log(`[Coordinator] Command Process exited with code ${code}, signal ${signal}`);
    commandChild = null;
    if (!isShuttingDown) {
      console.log('[Coordinator] Respawning Command Process in 2 seconds...');
      setTimeout(startCommandProcess, 2000);
    }
  });
}

function restartCommandProcess() {
  if (commandChild) {
    console.log('[Coordinator] Terminating current Command Process...');
    commandChild.kill('SIGTERM');
  } else {
    startCommandProcess();
  }
}

// Handle termination signals to cleanly shut down children
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Coordinator] Shutting down due to ${signal}...`);
  
  if (agentChild) {
    agentChild.kill('SIGINT');
  }
  if (commandChild) {
    commandChild.kill('SIGINT');
  }
  
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start both processes
startAgentProcess();
startCommandProcess();
