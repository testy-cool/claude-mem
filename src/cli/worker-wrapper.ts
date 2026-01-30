#!/usr/bin/env bun
/**
 * Worker Wrapper
 *
 * Thin wrapper around worker-service.cjs for Windows process management.
 * Handles restart signals and graceful shutdown.
 *
 * CRITICAL: Uses windowsHide: true to prevent console popups on Windows.
 */

import { spawn, execSync, ChildProcess, SpawnOptions } from 'child_process';
import * as path from 'path';

const isWindows = process.platform === 'win32';
const SCRIPT_DIR = __dirname;
const WORKER_SERVICE_PATH = path.join(SCRIPT_DIR, 'worker-service.cjs');

let innerProcess: ChildProcess | null = null;
let intentionalShutdown = false;

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [wrapper] ${message}`);
}

function spawnInner(): void {
  log(`Spawning inner worker: ${WORKER_SERVICE_PATH}`);

  const spawnOptions: SpawnOptions = {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, CLAUDE_MEM_MANAGED: 'true' },
    cwd: path.dirname(WORKER_SERVICE_PATH),
    windowsHide: true  // CRITICAL: Prevent console popup on Windows
  };

  innerProcess = spawn(process.execPath, [WORKER_SERVICE_PATH], spawnOptions);

  innerProcess.on('message', async (msg: { type: string }) => {
    if (msg.type === 'restart' || msg.type === 'shutdown') {
      log(`${msg.type} requested by inner`);
      intentionalShutdown = true;
      await killInner();
      log('Exiting wrapper');
      process.exit(0);
    }
  });

  innerProcess.on('exit', (code, signal) => {
    log(`Inner exited with code=${code}, signal=${signal}`);
    innerProcess = null;
    if (!intentionalShutdown) {
      log('Inner exited unexpectedly, wrapper exiting (hooks will restart if needed)');
      process.exit(code ?? 0);
    }
  });

  innerProcess.on('error', (err) => {
    log(`Inner error: ${err.message}`);
  });
}

async function killInner(): Promise<void> {
  if (!innerProcess || !innerProcess.pid) {
    log('No inner process to kill');
    return;
  }

  const pid = innerProcess.pid;
  log(`Killing inner process tree (pid=${pid})`);

  if (isWindows) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 10000, stdio: 'ignore' });
      log(`taskkill completed for pid=${pid}`);
    } catch (err) {
      log(`taskkill failed (process may be dead): ${err}`);
    }
  } else {
    innerProcess.kill('SIGTERM');

    const exitPromise = new Promise<void>((resolve) => {
      if (!innerProcess) {
        resolve();
        return;
      }
      innerProcess.on('exit', () => resolve());
    });

    const timeoutPromise = new Promise<void>((resolve) => setTimeout(() => resolve(), 5000));
    await Promise.race([exitPromise, timeoutPromise]);

    if (innerProcess && !innerProcess.killed) {
      log('Inner did not exit gracefully, force killing');
      innerProcess.kill('SIGKILL');
    }
  }

  await waitForProcessExit(pid, 5000);
  innerProcess = null;
  log('Inner process terminated');
}

async function waitForProcessExit(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
  log(`Timeout waiting for process ${pid} to exit`);
}

// Signal handlers
process.on('SIGTERM', async () => {
  log('Wrapper received SIGTERM');
  intentionalShutdown = true;
  await killInner();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('Wrapper received SIGINT');
  intentionalShutdown = true;
  await killInner();
  process.exit(0);
});

// Start
log('Wrapper starting');
spawnInner();
