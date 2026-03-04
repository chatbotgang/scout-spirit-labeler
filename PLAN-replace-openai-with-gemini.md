# Plan: Replace OpenAI with Gemini — Approach Comparison

This document compares two approaches for replacing the OpenAI API call in `scout-spirit-labeler` with Google's Gemini ecosystem. Both approaches maintain the same end-user functionality: analyze a PR diff with AI, return a structured JSON analysis, and conditionally apply a "Scout Spirit" label and comment.

## Current Architecture Summary

- **Single TypeScript process** (`src/index.ts`) handles everything: fetch PR data → call OpenAI → parse response → apply label
- Uses raw `fetch()` to OpenAI Chat Completions API with `response_format: { type: "json_object" }`
- Composite GitHub Action (`action.yml`) with 4 steps: setup Node.js → install pnpm → install deps → run script
- Inputs: `github_token`, `openai_api_key`, `openai_base_url`, `model` (default: `gpt-5-mini`), `confidence_threshold`, `label_name`, `max_diff_size`, `add_comment`
- Outputs: `eligible`, `confidence`, `category`, `reasoning`

---

## Option A: `google-github-actions/run-gemini-cli` GitHub Action

**Repository:** [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli)

### What It Is

A composite GitHub Action that installs and runs Google's Gemini CLI — an autonomous AI agent designed for GitHub workflows. It supports MCP servers, tool use, multi-turn conversations, and TOML-based custom commands with shell interpolation (`!{...}`).

### Architecture Impact

The monolithic `src/index.ts` must be **split into 3 phases** because `run-gemini-cli` is a separate action step that must run between our custom scripts:

1. **Pre-process** (`src/pre-process.ts`): Fetch PR data via Octokit, write context to temp file
2. **Gemini CLI step**: Run `google-github-actions/run-gemini-cli@v0` with a TOML custom command
3. **Post-process** (`src/post-process.ts`): Parse Gemini's response, validate JSON, apply label/comment

### Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/shared.ts` | CREATE | Shared types, config, utilities extracted from index.ts |
| `src/pre-process.ts` | CREATE | Fetch PR data, bot detection, write context file |
| `src/post-process.ts` | CREATE | Parse Gemini response, validate, apply label/comment |
| `commands/scout-spirit-analyze.toml` | CREATE | TOML custom command with embedded 484-line analysis prompt |
| `action.yml` | MODIFY | New inputs, 8-step multi-phase composite action |
| `examples/workflow.yml` | MODIFY | Update inputs (`openai_api_key` → `gemini_api_key`) |
| `package.json` | MODIFY | Update keywords |
| `src/index.ts` | DELETE | Replaced by pre-process + post-process |
| `prompts/analysis-prompt.md` | DELETE | Content embedded in TOML |

### action.yml Structure (8 steps)

```yaml
steps:
  1. Setup Node.js 20
  2. Install pnpm
  3. Install dependencies
  4. Pre-process (fetch PR data, bot check)          # src/pre-process.ts
  5. Install TOML command to .gemini/commands/        # if: skip != 'true'
  6. Run Gemini CLI (run-gemini-cli@v0)               # if: skip != 'true', continue-on-error: true
  7. Post-process (parse response, apply label)       # if: skip != 'true', src/post-process.ts
  8. Summary
```

Output routing requires conditional expressions for the two paths (skip vs. analyze):
```yaml
eligible:
  value: ${{ steps.pre_process.outputs.skip == 'true' && steps.pre_process.outputs.eligible || steps.post_process.outputs.eligible }}
```

### JSON Output Handling

**No native structured output mode.** The Gemini CLI is designed as an interactive agent, not a JSON API. The `summary` output contains whatever text the model produces.

Requires:
1. Strong prompt engineering ("respond with ONLY a valid JSON object, no markdown fences...")
2. Robust multi-strategy JSON extraction in post-process:
   - Direct `JSON.parse(response.trim())`
   - Extract from markdown code fence `` ```json ... ``` ``
   - Regex to find outermost `{ ... }` block
   - Line-by-line search for JSON start

### Gemini CLI Settings

```json
{
  "model": { "maxSessionTurns": 1 },
  "tools": { "core": ["run_shell_command(cat)", "run_shell_command(echo)"] }
}
```

- `maxSessionTurns: 1` constrains the agent to a single prompt-response cycle
- Only `cat` and `echo` tools allowed (for TOML `!{cat $SCOUT_CONTEXT_FILE}` interpolation)
- No MCP servers (we pre-fetch all PR data ourselves)

### Pros

- Deep integration with Google's GitHub Actions ecosystem
- Supports future expansion to agentic workflows (multi-turn, MCP tools)
- No npm dependency added (CLI installed at runtime by the action)
- Follows the pattern recommended by Google for GitHub AI automation

### Cons

- **High complexity**: 4 new files, 2 deleted files, complete action.yml restructure
- **No guaranteed JSON output**: Needs regex fallback extraction, which can fail
- **CI overhead**: +30-60s per run for Gemini CLI installation
- **Pre-1.0 dependency**: `run-gemini-cli@v0` — API may change without notice
- **Lower determinism**: Even with `maxSessionTurns: 1`, the autonomous agent may behave unpredictably
- **Debugging difficulty**: Multi-step action with conditional paths is harder to troubleshoot

---

## Option B: `@google/genai` JS SDK (Direct API Call)

**Repository:** [googleapis/js-genai](https://github.com/googleapis/js-genai)
**Docs:** [Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)

### What It Is

The official Google Gen AI SDK for TypeScript/JavaScript. A direct API client for calling Gemini models, supporting structured JSON output via `responseJsonSchema`, system instructions, streaming, and function calling.

### Architecture Impact

**Minimal** — replace the `fetch()` call in `analyzeWithAI()` with the SDK's `generateContent()` method. The existing single-file architecture is preserved. No splitting, no new action steps.

### Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/index.ts` | MODIFY | Replace OpenAI fetch with `@google/genai` SDK call (~50 lines) |
| `action.yml` | MODIFY | Replace `openai_api_key`/`openai_base_url` inputs with `gemini_api_key` |
| `examples/workflow.yml` | MODIFY | Update inputs |
| `package.json` | MODIFY | Add `@google/genai` dependency, update keywords |

### Code Change Preview

The core `analyzeWithAI` function in `src/index.ts`:

```typescript
import { GoogleGenAI } from "@google/genai";

async function analyzeWithAI(
  diffData: DiffData,
  prData: PullRequestData,
  config: Config,
): Promise<Analysis> {
  const systemPrompt = loadAIPrompt();

  const userPrompt = `Analyze the following pull request and determine if it exhibits Scout Spirit:

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

  // Validate required fields (same as current code)
  if (typeof analysis.eligible !== "boolean") {
    throw new Error('AI response missing or invalid "eligible" field');
  }
  // ... same validation as current code

  return analysis;
}
```

### Config Changes in `src/index.ts`

```typescript
interface Config {
  model: string;
  confidenceThreshold: number;
  labelName: string;
  maxDiffSize: number;
  addComment: boolean;
  // openaiBaseUrl removed — not needed with SDK
}

function getConfig(): Config {
  return {
    model: process.env.INPUT_MODEL || "gemini-2.5-flash",
    // ... rest unchanged
  };
}
```

### action.yml Changes

```yaml
inputs:
  github_token:
    description: 'GitHub token for API access'
    required: true
  gemini_api_key:                              # was: openai_api_key
    description: 'Gemini API key'
    required: true
  # openai_base_url: REMOVED
  model:
    description: 'AI model to use for analysis'
    required: false
    default: 'gemini-2.5-flash'               # was: gpt-5-mini
  # confidence_threshold, label_name, max_diff_size, add_comment: UNCHANGED
```

Environment variables in the run step:
```yaml
env:
  GITHUB_TOKEN: ${{ inputs.github_token }}
  GEMINI_API_KEY: ${{ inputs.gemini_api_key }}  # was: OPENAI_API_KEY
  # OPENAI_BASE_URL: REMOVED
```

### JSON Output Handling

**Native structured output** via two config properties:
- `responseMimeType: "application/json"` — tells the API to return JSON
- `responseJsonSchema: { ... }` — defines the exact shape of the response

The API **guarantees** the response is valid JSON conforming to the schema. No regex extraction needed. A simple `JSON.parse(response.text)` is sufficient.

### Pros

- **Minimal code change**: ~50 lines modified, 0 new files, 0 deleted files
- **Native JSON schema enforcement**: Guaranteed valid structured output — no regex extraction needed
- **Same architecture**: Single `src/index.ts`, same 4-step action.yml, same execution flow
- **Full model configuration**: `systemInstruction`, temperature, topP, topK, maxOutputTokens
- **No CI overhead**: SDK call is as fast as the current OpenAI fetch
- **Stable dependency**: Official Google SDK, follows semver, actively maintained
- **Easy to understand**: The diff for this change is straightforward to review
- **Supports Vertex AI**: Can switch to `vertexai: true` for enterprise GCP usage

### Cons

- Adds `@google/genai` as an npm dependency
- Does not leverage the Gemini CLI ecosystem (no agent capabilities, no MCP)
- If future requirements need agentic behavior, would need further refactoring

---

## Head-to-Head Comparison

| Criterion | `run-gemini-cli` Action | `@google/genai` SDK |
|-----------|------------------------|---------------------|
| **Lines of code changed** | ~500+ (new files, restructure) | ~60 (modify existing) |
| **New files** | 4 | 0 |
| **Deleted files** | 2 | 0 |
| **Architecture change** | Major (3-phase split) | None (same structure) |
| **JSON output reliability** | Prompt-dependent, needs regex fallback | Schema-enforced, guaranteed |
| **System instructions** | Embedded in TOML prompt string | Native `systemInstruction` param |
| **CI overhead** | +30-60s (CLI installation) | None |
| **action.yml steps** | 8 (with conditionals) | 4 (unchanged) |
| **npm dependencies** | No change | +1 (`@google/genai`) |
| **External action dependency** | `run-gemini-cli@v0` (pre-1.0) | None |
| **Error handling complexity** | `continue-on-error` + output checking | Standard try/catch |
| **Future agentic capability** | Built-in (MCP, multi-turn) | Would need refactoring |
| **Review diff complexity** | Large, multi-file | Small, single-file |
| **Risk of breaking changes** | Higher (v0 action) | Lower (stable SDK) |

---

## Recommendation

**`@google/genai` JS SDK** is the recommended approach for this use case because:

1. The Scout Spirit Labeler is a **simple LLM call** (prompt in → structured JSON out). It does not need agentic capabilities, MCP servers, or multi-turn conversations.
2. Native **JSON schema enforcement** eliminates an entire class of parsing failures that the CLI approach must handle with regex fallbacks.
3. The change is a **minimal, reviewable diff** (~60 lines) versus a major architectural restructure (~500+ lines across 6+ files).
4. No external action dependency means **no risk of upstream breaking changes** from a pre-1.0 action.

The `run-gemini-cli` action would be a better fit for tasks like automated PR reviews with inline comments (where it can use GitHub MCP to read diffs and post review comments autonomously), but that's not what this action does.

---

## Sources

- [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli)
- [@google/genai SDK](https://github.com/googleapis/js-genai)
- [Gemini Structured Output Docs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini API Structured Outputs Blog](https://blog.google/technology/developers/gemini-api-structured-outputs/)
- [Gemini CLI GitHub Actions Blog](https://blog.google/technology/developers/introducing-gemini-cli-github-actions/)
- [Gemini CLI Tutorial: GitHub Actions](https://medium.com/google-cloud/gemini-cli-tutorial-series-part-12-gemini-cli-github-actions-efc059ada0c4)
