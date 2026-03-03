# Scout Spirit Labeler ⚜️

> _"Always leave the campground cleaner than you found it."_ — Robert C. Martin

AI-powered GitHub Action that automatically recognizes and labels pull requests embodying the **Boy Scout Rule** — small, incremental improvements that leave the codebase better than before.

## Why?

Good engineering teams continuously improve their codebase. Developers who rename confusing variables, simplify complex conditionals, remove dead code, or optimize a slow query while they're working on a file are practicing **Scout Spirit**.

This action automatically detects and labels these PRs with **Scout Spirit ⚜️**, giving visibility and recognition to incremental improvement work.

## Quick Start

1. Add your OpenAI API key as a repository secret (`OPENAI_API_KEY`)

2. Create `.github/workflows/scout-spirit-labeler.yml`:

```yaml
name: Scout Spirit Labeler

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  analyze-pr:
    name: Analyze PR for Scout Spirit
    runs-on: ubuntu-latest
    if: |
      !contains(github.event.pull_request.labels.*.name, 'Scout Spirit ⚜️') &&
      github.event.pull_request.user.type == 'User'
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Scout Spirit Labeler
        uses: chatbotgang/scout-spirit-labeler@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

## Configuration

| Input                  | Required | Default                     | Description                               |
| ---------------------- | -------- | --------------------------- | ----------------------------------------- |
| `github_token`         | Yes      | —                           | GitHub token for API access               |
| `openai_api_key`       | Yes      | —                           | OpenAI API key (or compatible service)    |
| `openai_base_url`      | No       | `https://api.openai.com/v1` | Custom API endpoint (Azure OpenAI, etc.)  |
| `model`                | No       | `gpt-5-mini`                | AI model to use                           |
| `confidence_threshold` | No       | `80`                        | Minimum confidence to apply label (0-100) |
| `label_name`           | No       | `Scout Spirit ⚜️`           | Label name to apply                       |
| `max_diff_size`        | No       | `50000`                     | Maximum diff size in characters           |
| `add_comment`          | No       | `true`                      | Add explanatory comment to PR             |

## Scout Spirit Categories

The action detects 7 categories of incremental improvement:

| Category                     | Description                                                        | Example                                                                 |
| ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Code Refactoring**         | Renaming variables, extracting functions, simplifying conditionals | `if (data) { if (data.items) { ... } }` → `if (!data?.items) return []` |
| **Performance Improvements** | Memoization, algorithm optimization, lazy loading                  | Adding `useMemo` to expensive computation                               |
| **Test Enhancements**        | Improving existing tests — better assertions, less flakiness       | Adding edge-case assertions to existing test                            |
| **Build & Tooling**          | CI optimization, stricter linting, Docker image improvements       | `npm install` → `npm ci --prefer-offline`                               |
| **Code Cleanup**             | Removing unused imports, dead code, obsolete TODOs                 | Deleting commented-out legacy code                                      |
| **Type Safety**              | Replacing `any`, adding return types, tightening generics          | `(id: any): any` → `(id: string): User \| null`                         |
| **Quality-of-Life**          | Better error messages, named constants, improved logging           | Magic number `3` → `STATUS_COMPLETE`                                    |

## What is NOT Scout Spirit

- **New features** (`feat:` prefix)
- **Bug fixes** (`fix:` prefix)
- **Brand new test files** (adding coverage ≠ enhancing existing tests)
- **Adding new dependencies**
- **Database migrations**
- **Security or API contract changes**
- **Mixed PRs** (cleanup + feature in same PR)

## Outputs

| Output       | Description                                           |
| ------------ | ----------------------------------------------------- |
| `eligible`   | Whether the PR exhibits Scout Spirit (`true`/`false`) |
| `confidence` | AI confidence score (0-100)                           |
| `category`   | Detected category name or `none`                      |
| `reasoning`  | AI's explanation of the decision                      |

## Azure OpenAI / Custom Endpoints

To use Azure OpenAI or another compatible API:

```yaml
- uses: chatbotgang/scout-spirit-labeler@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    openai_api_key: ${{ secrets.AZURE_OPENAI_KEY }}
    openai_base_url: https://your-resource.openai.azure.com/openai/deployments/your-deployment
    model: your-deployment-name
```

## How It Works

```
PR Opened/Updated
       ↓
Fetch PR title, description, and diff via GitHub API
       ↓
Send to AI with Scout Spirit analysis prompt
       ↓
AI returns: eligible, category, confidence, reasoning
       ↓
If eligible AND confidence ≥ threshold
       ↓
Apply "Scout Spirit ⚜️" label + explanatory comment
```

## License

Apache-2.0
