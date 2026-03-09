import { GoogleGenAI } from "@google/genai";
import { Octokit } from "@octokit/rest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Config {
  model: string;
  confidenceThreshold: number;
  labelName: string;
  maxDiffSize: number;
  addComment: boolean;
}

interface FileInfo {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface DiffData {
  diffContent: string;
  fileCount: number;
  additions: number;
  deletions: number;
  files: FileInfo[];
}

interface PullRequestData {
  title: string;
  body: string | null;
}

interface Analysis {
  eligible: boolean;
  category: string | string[];
  confidence: number;
  reasoning: string;
  flags?: string[];
}

interface GitHubContext {
  event: {
    pull_request: {
      number: number;
      user: {
        type: string;
      };
    };
  };
  repository: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getConfig(): Config {
  return {
    model: process.env.INPUT_MODEL || "gemini-2.5-flash",
    confidenceThreshold: parseInt(
      process.env.INPUT_CONFIDENCE_THRESHOLD || "80",
      10,
    ),
    labelName: process.env.INPUT_LABEL_NAME || "Scout Spirit ⚜️",
    maxDiffSize: parseInt(process.env.INPUT_MAX_DIFF_SIZE || "50000", 10),
    addComment: process.env.INPUT_ADD_COMMENT !== "false",
  };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  config: Config,
): Promise<DiffData> {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  let totalAdditions = 0;
  let totalDeletions = 0;
  const fileInfos: FileInfo[] = [];
  let diffContent = "";

  for (const file of files as PullRequestFile[]) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    fileInfos.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    });

    diffContent += `\n--- ${file.filename} (${file.status}) [+${file.additions}/-${file.deletions}]\n`;

    if (file.patch) {
      diffContent += file.patch + "\n";
    }

    if (diffContent.length > config.maxDiffSize) {
      diffContent += "\n... [diff truncated due to size limit] ...\n";
      break;
    }
  }

  return {
    diffContent,
    fileCount: files.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    files: fileInfos,
  };
}

async function fetchPRMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestData> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return {
    title: pr.title,
    body: pr.body,
  };
}

// ---------------------------------------------------------------------------
// AI analysis
// ---------------------------------------------------------------------------

function loadAIPrompt(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(__dirname, "../prompts/analysis-prompt.md");
  return fs.readFileSync(promptPath, "utf-8");
}

async function analyzeWithAI(
  diffData: DiffData,
  prData: PullRequestData,
  config: Config,
): Promise<Analysis> {
  const systemPrompt = loadAIPrompt();

  const userPrompt = `Analyze the following pull request and determine if it exhibits Scout Spirit ⚜️:

## PR Title
${prData.title}

## PR Description
${prData.body || "(No description provided)"}

## File Changes Summary
- Total files: ${diffData.fileCount}
- Total additions: +${diffData.additions}
- Total deletions: -${diffData.deletions}

## Diff
${diffData.diffContent}

Provide your analysis in the specified JSON format.`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: config.model,
    contents: userPrompt,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          eligible: { type: "boolean" },
          category: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          reasoning: { type: "string" },
          flags: { type: "array", items: { type: "string" } },
        },
        required: ["eligible", "category", "confidence", "reasoning"],
      },
    },
  });

  const content = response.text;
  if (!content) {
    throw new Error("No content in AI response");
  }

  const analysis: Analysis = JSON.parse(content);

  // Validate required fields
  if (typeof analysis.eligible !== "boolean") {
    throw new Error('AI response missing or invalid "eligible" field');
  }
  if (!analysis.category) {
    throw new Error('AI response missing "category" field');
  }
  if (
    typeof analysis.confidence !== "number" ||
    analysis.confidence < 0 ||
    analysis.confidence > 100
  ) {
    throw new Error(
      'AI response missing or invalid "confidence" field (must be 0-100)',
    );
  }
  if (typeof analysis.reasoning !== "string") {
    throw new Error('AI response missing or invalid "reasoning" field');
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// Label & comment
// ---------------------------------------------------------------------------

function formatCategory(category: string | string[]): string {
  if (Array.isArray(category)) {
    return category.join(", ");
  }
  return category;
}

async function applyScoutSpiritLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  analysis: Analysis,
  config: Config,
): Promise<void> {
  // Apply the label
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: [config.labelName],
  });

  console.log(`Applied "${config.labelName}" label to PR #${prNumber}`);

  // Optionally add a comment
  if (config.addComment) {
    const flags =
      analysis.flags && analysis.flags.length > 0
        ? `\n\n**Notes:** ${analysis.flags.join(", ")}`
        : "";

    const commentBody = `## Scout Spirit ⚜️ Analysis

**Category:** ${formatCategory(analysis.category)}
**Confidence:** ${analysis.confidence}%

**Reasoning:** ${analysis.reasoning}

> *"Always leave the campground cleaner than you found it." — Robert C. Martin*

This PR has been labeled **\`${config.labelName}\`** because it embodies the Boy Scout Rule — making small, incremental improvements that leave the codebase better than before.${flags}

---
*Automated by [Scout Spirit Labeler](https://github.com/chatbotgang/scout-spirit-labeler). If this label was applied incorrectly, please remove it manually.*`;

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });

    console.log(`Added explanation comment to PR #${prNumber}`);
  }
}

// ---------------------------------------------------------------------------
// GitHub Actions output
// ---------------------------------------------------------------------------

function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Scout Spirit ⚜️ Labeler - Starting analysis...\n");

  // Validate environment
  const githubToken = process.env.GITHUB_TOKEN;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const githubContextJson = process.env.GITHUB_CONTEXT;

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  if (!githubContextJson) {
    throw new Error("GITHUB_CONTEXT is not set");
  }

  const config = getConfig();
  console.log("Configuration:");
  console.log(`  Model: ${config.model}`);
  console.log(`  Confidence threshold: ${config.confidenceThreshold}%`);
  console.log(`  Label: ${config.labelName}`);
  console.log(`  Max diff size: ${config.maxDiffSize} chars`);
  console.log(`  Add comment: ${config.addComment}\n`);

  // Parse GitHub context
  const context: GitHubContext = JSON.parse(githubContextJson);
  const [owner, repo] = context.repository.split("/");
  const prNumber = context.event.pull_request.number;

  console.log(`Analyzing PR #${prNumber} in ${owner}/${repo}\n`);

  // Skip bot-created PRs
  if (context.event.pull_request.user.type !== "User") {
    console.log("Skipping: PR created by a bot account");
    setOutput("eligible", "false");
    setOutput("confidence", "0");
    setOutput("category", "none");
    setOutput("reasoning", "PR created by a bot account");
    return;
  }

  const octokit = new Octokit({ auth: githubToken });

  // Step 1: Fetch PR diff and metadata in parallel
  console.log("Fetching PR diff and metadata...");
  const [diffData, prData] = await Promise.all([
    fetchPRDiff(octokit, owner, repo, prNumber, config),
    fetchPRMetadata(octokit, owner, repo, prNumber),
  ]);

  console.log(`PR: "${prData.title}"`);
  console.log(
    `Diff stats: ${diffData.fileCount} files, +${diffData.additions}/-${diffData.deletions} lines\n`,
  );

  // Step 2: Analyze with AI
  console.log("Analyzing with AI...");
  const analysis = await analyzeWithAI(diffData, prData, config);

  console.log("\nAnalysis results:");
  console.log(`  Eligible: ${analysis.eligible}`);
  console.log(`  Category: ${formatCategory(analysis.category)}`);
  console.log(`  Confidence: ${analysis.confidence}%`);
  console.log(`  Reasoning: ${analysis.reasoning}`);
  if (analysis.flags && analysis.flags.length > 0) {
    console.log(`  Flags: ${analysis.flags.join(", ")}`);
  }

  // Set outputs
  setOutput("eligible", String(analysis.eligible));
  setOutput("confidence", String(analysis.confidence));
  setOutput("category", formatCategory(analysis.category));
  setOutput("reasoning", analysis.reasoning);

  // Step 3: Apply label if eligible
  if (analysis.eligible && analysis.confidence >= config.confidenceThreshold) {
    console.log(
      `\nPR qualifies as Scout Spirit ⚜️ (confidence: ${analysis.confidence}% >= ${config.confidenceThreshold}%)`,
    );
    await applyScoutSpiritLabel(
      octokit,
      owner,
      repo,
      prNumber,
      analysis,
      config,
    );
  } else if (
    analysis.eligible &&
    analysis.confidence < config.confidenceThreshold
  ) {
    console.log(
      `\nPR shows Scout Spirit but confidence too low (${analysis.confidence}% < ${config.confidenceThreshold}%)`,
    );
  } else {
    console.log("\nPR does not exhibit Scout Spirit");
  }

  console.log("\nDone!");
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
