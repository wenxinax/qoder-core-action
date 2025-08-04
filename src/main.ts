import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { HttpClient } from '@actions/http-client';

// Function to install dependencies
async function installDependencies(): Promise<void> {
  core.info('Installing required dependencies...');
  
  return new Promise((resolve, reject) => {
    const installProcess = spawn('apt-get', ['update', '&&', 'apt-get', 'install', '-y', 'ripgrep', 'fzf'], {
      shell: true,
      stdio: 'inherit'
    });

    installProcess.on('close', (code) => {
      if (code === 0) {
        core.info('Dependencies installed successfully.');
        resolve();
      } else {
        core.warning(`Failed to install dependencies with code ${code}. Continuing anyway...`);
        resolve(); // Continue even if installation fails
      }
    });

    installProcess.on('error', (error) => {
      core.warning(`Error installing dependencies: ${error.message}. Continuing anyway...`);
      resolve(); // Continue even if installation fails
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
    const promptFilePath = core.getInput('prompt_file_path', { required: true });
    const systemPrompt = core.getInput('system_prompt');
    const apiKey = core.getInput('dashscope_api_key', { required: true });
    const logFilePath = './qoder.log';

    // --- 2. Install Dependencies ---
    await installDependencies();

    // --- 3. Download and Setup CLI ---
    await setupCli(cliDownloadUrl, cliPath);

    // --- 4. Prepare Log Stream ---
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    // --- 5. Prepare Arguments ---
    const args = [
      '--prompt-file', promptFilePath,
      '--output-format', 'stream-json'
    ];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // --- 6. Execute qoder-cli ---
    core.info(`Starting qoder-cli process with args: ${args.join(' ')}`);
    const qoderProcess = spawn(cliPath, args, {
      env: {
        ...process.env, // Inherit parent process env
        DASHSCOPE_API_KEY: apiKey
      }
    });

    let lastJsonLine = '';

    // --- 7. Process stdout stream ---
    qoderProcess.stdout.on('data', (data) => {
      const output = data.toString();
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

        if (resultType === 'success' && resultContent) {
          core.setOutput('result_type', resultType);
          core.setOutput('result_content', resultContent);
          core.info(`Successfully extracted result. Type: ${resultType}`);
        } else {
          core.setFailed(`Operation failed. Result type: ${resultType}.`);
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