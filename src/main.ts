
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { HttpClient } from '@actions/http-client';

// Function to create the .qoder-cli.json file if config is provided
function createCliConfig(configJson: string): void {
  if (!configJson) {
    core.info('No config provided, skipping .qoder-cli.json creation.');
    return;
  }

  core.info('Creating .qoder-cli.json from provided config...');
  try {
    // Validate if the input is a valid JSON
    JSON.parse(configJson);

    const configPath = path.join(process.cwd(), '.qoder-cli.json');
    fs.writeFileSync(configPath, configJson);
    core.info(`Successfully created ${configPath}`);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to create .qoder-cli.json: ${error.message}. Please ensure the provided config is a valid JSON string.`);
    }
    throw error;
  }
}

// Function to install dependencies
async function installDependencies(): Promise<void> {
  core.info('Installing required dependencies: ripgrep and fzf...');

  return new Promise<void>((resolve) => {
    const command = `
      set -e
      sudo apt-get update
      sudo apt-get install -y ripgrep fzf
    `;

    const installProcess = spawn('bash', ['-c', command], { stdio: 'inherit' });

    installProcess.on('close', (code) => {
      if (code === 0) {
        core.info('Dependencies installed successfully.');
      } else {
        core.warning(`Dependency installation failed with code ${code}. The action might not work as expected.`);
      }
      // Resolve anyway, as the CLI might still work without these dependencies or they might be pre-installed.
      resolve();
    });

    installProcess.on('error', (error) => {
      core.warning(`Error during dependency installation: ${error.message}. The action might not work as expected.`);
      resolve();
    });
  });
}

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
    const systemPrompt = core.getInput('system_prompt');
    const systemPromptFilePath = core.getInput('system_prompt_path');
    const apiKey = core.getInput('dashscope_api_key', { required: true });
    const configJson = core.getInput('config');
    const githubToken = core.getInput('github_token');
    const logFilePath = './qoder.log';

    // Validate and get the prompt content
    if (prompt && promptPath) {
      throw new Error('The `prompt` and `prompt_path` inputs are mutually exclusive. Please provide only one.');
    }
    if (systemPrompt && systemPromptFilePath) {
      throw new Error('The `system_prompt` and `system_prompt_path` inputs are mutually exclusive. Please provide only one.');
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
    let systemPromptContent = '';
    if (systemPrompt) {
      systemPromptContent = systemPrompt;
    } else if (systemPromptFilePath) {
      if (!fs.existsSync(systemPromptFilePath)) {
        throw new Error(`System prompt file not found at: ${systemPromptFilePath}`);
      }
      systemPromptContent = fs.readFileSync(systemPromptFilePath, 'utf-8');
    }

    // --- 2. Install Dependencies ---
    // await installDependencies();

    // --- 3. Download and Setup CLI ---
    await setupCli(cliDownloadUrl, cliPath);

    // --- 4. Create CLI Config if provided ---
    createCliConfig(configJson);

    // --- 5. Prepare Log Stream ---
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    // --- 6. Prepare Arguments ---
    const args = [
      '--prompt', promptContent,
      '--output-format', 'stream-json'
    ];
    if (systemPromptContent) {
      args.push('--system-prompt', systemPromptContent);
    }

    // --- 6. Execute qoder-cli ---
    core.info(`Starting qoder-cli process with args: ${args.join(' ')}`);
    const qoderProcess = spawn(cliPath, args, {
      env: {
        ...process.env, // Inherit parent process env
        DASHSCOPE_API_KEY: apiKey,
        ...(githubToken && { GITHUB_TOKEN: githubToken })
      }
    });

    let lastJsonLine = '';

    // --- 7. Process stdout stream ---
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

    // --- 8. Process stderr stream ---
    qoderProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      core.warning(`qoder-cli stderr: ${errorOutput}`);
      logStream.write(`[STDERR] ${errorOutput}`);
    });

    // --- 9. Handle Process Completion ---
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

      // --- 10. Parse Final JSON and Set Outputs ---
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
