
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { HttpClient } from '@actions/http-client';

// Function to download the CLI tool
async function setupCli(url: string, dest: string): Promise<void> {
  core.info(`Downloading qoder-cli from ${url}...`);
  const httpClient = new HttpClient('qoder-action');
  const response = await httpClient.get(url);

  if (response.message.statusCode !== 200) {
    throw new Error(`Failed to download qoder-cli: ${response.message.statusCode} ${response.message.statusMessage}`);
  }

  const fileStream = fs.createWriteStream(dest);
  return new Promise((resolve, reject) => {
    fileStream.on('finish', () => {
      core.info(`qoder-cli downloaded successfully to ${dest}`);
      fs.chmodSync(dest, '755'); // Make it executable
      core.info('Set qoder-cli as executable.');
      resolve();
    });
    fileStream.on('error', reject);
    response.message.pipe(fileStream);
  });
}

async function run(): Promise<void> {
  try {
    // --- 1. Get Inputs ---
    const cliDownloadUrl = 'https://lingma-agents-public.oss-cn-hangzhou.aliyuncs.com/qoder-cli/qoder-cli-linux-amd64';
    const cliPath = path.join(process.cwd(), 'qoder-cli');
    const prompt = core.getInput('prompt');
    const promptPath = core.getInput('prompt_path');
    const qoderUserInfo = core.getInput('qoder_user_info', { required: true });
    const qoderMachineId = core.getInput('qoder_machine_id', { required: true });
    const logFilePath = './qoder.log';

    const env = {
      ...process.env,
      QODER_USER_INFO: qoderUserInfo,
      QODER_MACHINE_ID: qoderMachineId,
      QODER_MODEL: "auto",
    };

    // Validate and get the prompt content
    if (prompt && promptPath) {
      throw new Error('The `prompt` and `prompt_path` inputs are mutually exclusive. Please provide only one.');
    }

    let promptContent = '';
    if (prompt) {
      promptContent = prompt;
    } else if (promptPath) {
      if (!fs.existsSync(promptPath)) {
        throw new Error(`Prompt file not found at: ${promptPath}`);
      }
      promptContent = fs.readFileSync(promptPath, 'utf-8');
    } else {
      throw new Error('Either the `prompt` or `prompt_path` input must be provided.');
    }

    // Get the system prompt content

    // --- 2. Install Dependencies ---
    // await installDependencies();

    // --- 3. Download and Setup CLI ---
    await setupCli(cliDownloadUrl, cliPath);

    // --- 4. DEBUG: List MCP servers ---
    core.info('--- Running MCP List Debug Step ---');
    try {
      core.info('--- Debug: Printing current directory and contents ---');
      const pwdProcess = spawnSync('pwd', { encoding: 'utf-8' });
      core.info(`Current directory (pwd): ${pwdProcess.stdout}`);
      const lsProcess = spawnSync('ls', ['-la'], { encoding: 'utf-8' });
      core.info(`Directory contents (ls -la):\n${lsProcess.stdout}`);
      core.info('--- End of directory debug ---');

      core.info('--- Printing .mcp.json content ---');
      const catProcess = spawnSync('cat', ['.mcp.json'], { encoding: 'utf-8' });
      core.info(catProcess.stdout);
      core.info('--- End of .mcp.json content ---');

      const mcpListProcess = spawnSync(cliPath, ['mcp', 'list', '-w', process.cwd()], { encoding: 'utf-8', env: env });
      core.info(`MCP List STDOUT:\n${mcpListProcess.stdout}`);
      if (mcpListProcess.stderr) {
        core.warning(`MCP List STDERR:\n${mcpListProcess.stderr}`);
      }
    } catch (e) {
      if (e instanceof Error) {
        core.warning(`MCP List command failed: ${e.message}`);
      }
    }
    core.info('--- End of MCP List Debug Step ---');

    // --- 6. Prepare Log Stream ---
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    // --- 7. Prepare Arguments ---
    const args = [
      '-w', process.cwd(),
      '-p', promptContent,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions'
    ];

    // --- 8. Execute qoder-cli ---
    core.info(`Starting qoder-cli process with args: ${args.join(' ')}`);
    core.info('Setting environment variables for qoder-cli:');
    core.info(`- QODER_USER_INFO: ***`);
    core.info(`- QODER_MACHINE_ID: ${qoderMachineId}`);
    core.info(`- QODER_MODEL: auto`)

    const qoderProcess = spawn(cliPath, args, { env });

    let lastJsonLine = '';

    // --- 9. Process stdout stream ---
    qoderProcess.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(output); // Print the output to the action log
      logStream.write(output);
      const lines = output.split('\n').filter((line: string) => line.trim() !== '');
      for (const line of lines) {
        try {
          JSON.parse(line);
          lastJsonLine = line;
        } catch (e) { /* Ignore non-JSON lines */ }
      }
    });

    // --- 10. Process stderr stream ---
    qoderProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      core.warning(`qoder-cli stderr: ${errorOutput}`);
      logStream.write(`[STDERR] ${errorOutput}`);
    });

    // --- 11. Handle Process Completion ---
    qoderProcess.on('close', (code) => {
      logStream.end();
      core.info(`qoder-cli process exited with code ${code}`);

      if (code !== 0) {
        core.setFailed(`qoder-cli process failed. See qoder.log.`);
        return;
      }
      if (!lastJsonLine) {
        core.setFailed('No valid JSON output from qoder-cli.');
        return;
      }

      core.info(`Final JSON: ${lastJsonLine}`);

      // --- 12. Parse Final JSON and Set Outputs ---
      try {
        const result = JSON.parse(lastJsonLine);
        const resultType = result.subtype || 'unknown';
        const resultContent = result.message?.content?.[0]?.text || '';

        if (resultType === 'success') {
          core.info('qoder-cli reported success.');
        } else {
          core.warning(`qoder-cli did not report success. Result type: ${resultType}.`);
        }
      } catch (e) {
        if (e instanceof Error) {
          core.setFailed(`Failed to parse final JSON: ${e.message}`);
        }
      }
    });

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

run();